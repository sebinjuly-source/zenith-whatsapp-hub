/**
 * Contact lists (e.g. "Chef candidates – Batch 5") with per-person status and automatic follow-ups.
 *
 * The status of each person is worked out from the real WhatsApp messages of the list's number,
 * not from bookkeeping — so it is right even for messages sent from the phone, an Excel macro, etc.:
 *   new        not messaged since the list's start date
 *   queued     a message is waiting (draft or queued) in the outbox
 *   sent       messaged, no reply yet
 *   replied    wrote back after our first message
 *   failed     our last send attempt failed (error kept)
 *   opted_out  tagged opted-out (said "stop", etc.)
 * "outcome" is separate and set by you or the AI: interested, not interested, trial booked, hired…
 */
import { query, insertMany, logEvent } from './db.js';
import { toJid } from './store.js';
import { manager } from './wa/manager.js';
import * as outbox from './outbox.js';
import { createTask, refreshTask, fillTemplate } from './tasks.js';
import { getTemplate } from './templates.js';

export const STATUSES = ['new', 'queued', 'sent', 'replied', 'failed', 'opted_out'];

/** Undo URL-encoding left in spreadsheet messages (e.g. "%0A" for line breaks from wa.me links). */
export function decodeMessage(text) {
  if (!text) return text;
  return String(text).replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

const DEFAULT_FOLLOWUP = { enabled: false, afterDays: 2, max: 1, text: '', template: '' };

export async function getList(ref, account) {
  const isId = /^\d+$/.test(String(ref));
  const [l] = await query(
    `SELECT * FROM lists WHERE ${isId ? 'id = $1' : 'lower(name) = lower($1)'} AND ($2::text IS NULL OR account_id = $2)
     ORDER BY id DESC LIMIT 1`,
    [isId ? Number(ref) : String(ref), account || null],
  );
  if (!l) throw new Error(`No list "${ref}"`);
  return l;
}

/**
 * Create or extend a list. members: [{ phone, name, message?, ...anything else → fields }].
 * Existing members (same phone) are updated, not duplicated. `since` = messages before this date don't count.
 */
export async function importList({ account, name, since, source, members, followup }) {
  const s = await manager.resolve(account);
  if (!name?.trim()) throw new Error('A list needs a name');
  const [list] = await query(
    `INSERT INTO lists (account_id, name, source, since, followup) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5)
     ON CONFLICT (account_id, name) DO UPDATE SET source = COALESCE(EXCLUDED.source, lists.source),
       since = COALESCE($4::timestamptz, lists.since), updated_at = now()
     RETURNING *`,
    [s.id, name.trim(), source || null, since || null, JSON.stringify({ ...DEFAULT_FOLLOWUP, ...(followup || {}) })],
  );
  const rows = [];
  const bad = [];
  const seen = new Set();
  for (const m of members || []) {
    const raw = m.phone ?? m.to ?? m.Phone ?? m['Phone Number'];
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length < 10) {
      bad.push({ row: m.name || raw, reason: 'invalid phone' });
      continue;
    }
    const jid = toJid(raw);
    if (seen.has(jid)) continue;
    seen.add(jid);
    const { phone, to, name: nm, message, row, ...fields } = m;
    rows.push([list.id, jid, jid.split('@')[0], nm || fields.Name || null, JSON.stringify(fields), decodeMessage(message) || null, row != null ? String(row) : null]);
  }
  if (rows.length) {
    await insertMany('list_members', ['list_id', 'jid', 'phone', 'name', 'fields', 'message', 'row_ref'], rows,
      `ON CONFLICT (list_id, jid) DO UPDATE SET name = COALESCE(EXCLUDED.name, list_members.name),
         fields = list_members.fields || EXCLUDED.fields, message = COALESCE(EXCLUDED.message, list_members.message),
         row_ref = COALESCE(EXCLUDED.row_ref, list_members.row_ref), updated_at = now()`);
  }
  await refreshList(list.id);
  return { list, imported: rows.length, skipped: bad };
}

/** Recompute every member's status from the WhatsApp messages and the outbox (one query). */
export async function refreshList(listId) {
  await query(
    `WITH l AS (SELECT id, account_id, extract(epoch FROM since)::bigint AS since FROM lists WHERE id = $1),
     m AS (
       SELECT lm.jid,
         (SELECT min(ts) FROM messages x, l WHERE x.account_id = l.account_id AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS first_sent,
         (SELECT max(ts) FROM messages x, l WHERE x.account_id = l.account_id AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS last_sent,
         (SELECT count(*) FROM messages x, l WHERE x.account_id = l.account_id AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS sent_count
       FROM list_members lm WHERE lm.list_id = $1
     ),
     r AS (
       SELECT m.jid, m.first_sent, m.last_sent, m.sent_count,
         (SELECT max(ts) FROM messages x, l WHERE x.account_id = l.account_id AND x.chat_jid = m.jid AND NOT x.from_me AND x.ts >= m.first_sent) AS last_reply,
         (SELECT count(*) FROM messages x, l WHERE x.account_id = l.account_id AND x.chat_jid = m.jid AND NOT x.from_me AND x.ts >= m.first_sent) AS replies,
         (SELECT count(*) FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status IN ('draft','queued','sending')) AS pending,
         (SELECT o.error FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status = 'failed' ORDER BY o.id DESC LIMIT 1) AS last_error,
         (SELECT o.created_at FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status = 'failed' ORDER BY o.id DESC LIMIT 1) AS failed_at,
         (SELECT count(*) FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.note = 'follow-up' AND o.status = 'sent') AS followups,
         EXISTS (SELECT 1 FROM contacts c, l WHERE c.account_id = l.account_id AND c.jid = m.jid AND 'opted-out' = ANY(c.tags)) AS opted_out
       FROM m
     )
     UPDATE list_members lm SET
       first_sent_at = to_timestamp(r.first_sent), last_sent_at = to_timestamp(r.last_sent),
       last_reply_at = to_timestamp(r.last_reply), replies = r.replies, followups_sent = r.followups,
       status = CASE
         WHEN r.opted_out THEN 'opted_out'
         WHEN r.replies > 0 THEN 'replied'
         WHEN r.pending > 0 THEN 'queued'
         WHEN r.first_sent IS NOT NULL AND (r.failed_at IS NULL OR to_timestamp(r.last_sent) > r.failed_at) THEN 'sent'
         WHEN r.last_error IS NOT NULL THEN 'failed'
         ELSE 'new' END,
       error = CASE WHEN r.first_sent IS NULL OR to_timestamp(r.last_sent) < r.failed_at THEN r.last_error END,
       updated_at = now()
     FROM r WHERE lm.list_id = $1 AND lm.jid = r.jid`,
    [listId],
  );
}

export async function listLists(account) {
  return query(
    `SELECT l.*, a.label AS account_label,
       count(m.*)::int AS total,
       count(*) FILTER (WHERE m.status = 'new')::int AS new,
       count(*) FILTER (WHERE m.status = 'queued')::int AS queued,
       count(*) FILTER (WHERE m.status = 'sent')::int AS sent,
       count(*) FILTER (WHERE m.status = 'replied')::int AS replied,
       count(*) FILTER (WHERE m.status = 'failed')::int AS failed,
       count(*) FILTER (WHERE m.status = 'opted_out')::int AS opted_out,
       count(*) FILTER (WHERE m.outcome IS NOT NULL)::int AS with_outcome
     FROM lists l JOIN accounts a ON a.id = l.account_id LEFT JOIN list_members m ON m.list_id = l.id
     WHERE ($1::text IS NULL OR l.account_id = $1)
     GROUP BY l.id, a.label ORDER BY l.id DESC`,
    [account || null],
  );
}

export async function listMembers(listId, { status, outcome, limit = 500 } = {}) {
  const p = [listId];
  const where = ['m.list_id = $1'];
  if (status) {
    p.push(String(status).split(','));
    where.push(`m.status = ANY($${p.length})`);
  }
  if (outcome) {
    p.push(outcome);
    where.push(`m.outcome = $${p.length}`);
  }
  p.push(Math.min(limit, 2000));
  return query(
    `SELECT m.*, (SELECT left(body, 200) FROM messages x, lists l WHERE l.id = m.list_id AND x.account_id = l.account_id
        AND x.chat_jid = m.jid AND NOT x.from_me ORDER BY ts DESC LIMIT 1) AS last_reply_text
     FROM list_members m WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN m.row_ref ~ '^[0-9]+$' THEN m.row_ref::int END NULLS LAST, m.added_at
     LIMIT $${p.length}`,
    p,
  );
}

export async function updateMember(listId, phoneOrJid, { outcome, notes }) {
  const jid = toJid(phoneOrJid);
  const [m] = await query(
    `UPDATE list_members SET outcome = CASE WHEN $3::text IS NULL THEN outcome WHEN $3 = '' THEN NULL ELSE $3 END,
       notes = COALESCE($4, notes), updated_at = now()
     WHERE list_id = $1 AND jid = $2 RETURNING *`,
    [listId, jid, outcome === undefined ? null : outcome, notes ?? null],
  );
  if (!m) throw new Error('Not on this list');
  return m;
}

export async function setFollowup(listId, settings) {
  const [l] = await query('SELECT followup FROM lists WHERE id = $1', [listId]);
  if (!l) throw new Error('List not found');
  const f = { ...DEFAULT_FOLLOWUP, ...(l.followup || {}), ...settings };
  f.afterDays = Math.max(0.01, Number(f.afterDays) || 2);
  f.max = Math.max(0, Math.min(5, parseInt(f.max, 10) || 0));
  f.enabled = !!f.enabled;
  if (f.enabled && !String(f.text || '').trim() && !f.template) throw new Error('Follow-ups need a message or a template');
  const [u] = await query('UPDATE lists SET followup = $2, updated_at = now() WHERE id = $1 RETURNING *', [listId, JSON.stringify(f)]);
  return u;
}

/**
 * Message the members with the given statuses (default: new + failed). Each gets their own prepared message
 * from the list (column "message") unless a text/template is given. One board task per call.
 */
export async function sendToList(listId, { statuses = ['new', 'failed'], text, template, onlyPhones, createdBy = 'you', source = 'campaign' } = {}) {
  const list = await getList(listId);
  await refreshList(list.id);
  const session = await manager.resolve(list.account_id);
  await outbox.assertCanSend(session);
  let members = await listMembers(list.id, { status: statuses.join(',') });
  if (onlyPhones?.length) {
    const want = new Set(onlyPhones.map((p) => toJid(p)));
    members = members.filter((m) => want.has(m.jid));
  }
  const tpl = template ? await getTemplate(list.account_id, template) : null;
  if (template && !tpl) throw new Error(`No template called "${template}"`);
  const plan = [];
  const skipped = [];
  for (const m of members) {
    const first = (m.name || '').trim().split(/\s+/)[0];
    const vars = { ...m.fields, name: m.name, first_name: first, phone: m.phone };
    const body = text ? fillTemplate(text, vars) : tpl ? fillTemplate(tpl.body, vars) : m.message;
    if (!body?.trim()) {
      skipped.push({ to: m.phone, reason: 'no message prepared for this person' });
      continue;
    }
    plan.push({ m, body, attachment: tpl?.attachment || undefined });
  }
  if (!plan.length) return { task: null, queued: 0, skipped };
  const task = await createTask({ account: list.account_id, title: `${list.name}: message ${plan.length}`, details: `Statuses: ${statuses.join(', ')}`, kind: 'bulk', createdBy });
  const approve = ['mcp', 'campaign'].includes(source) && session.settings.aiMode === 'approve';
  await insertMany('outbox', ['account_id', 'to_jid', 'payload', 'source', 'status', 'priority', 'note', 'task_id', 'list_id'],
    plan.map((x) => [list.account_id, x.m.jid, JSON.stringify({ text: x.body, attachment: x.attachment }), source, approve ? 'draft' : 'queued', 0, list.name, task.id, list.id]));
  await refreshTask(task.id);
  await refreshList(list.id);
  outbox.wakeAccount(list.account_id);
  return { task, queued: plan.length, skipped, mode: approve ? 'approve' : 'auto' };
}

/**
 * Follow-ups: for every list with follow-ups on, members who were messaged, haven't replied, were last
 * messaged at least afterDays ago and have had fewer than `max` follow-ups get one (quoting our last message).
 * Uses the number's approval mode, delay, daily cap and sending hours like any automated message.
 */
export async function runFollowups() {
  const lists = await query(`SELECT * FROM lists WHERE (followup->>'enabled')::boolean`);
  for (const list of lists) {
    // Only the server that currently holds this number schedules its follow-ups (never twice).
    const session = manager.sessions.get(list.account_id);
    if (session?.status !== 'open') continue;
    try {
      await refreshList(list.id);
      const f = list.followup;
      const due = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.status = 'sent' AND m.followups_sent < $2
           AND m.last_sent_at <= now() - ($3 || ' days')::interval
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.list_id = m.list_id AND o.to_jid = m.jid AND o.status IN ('draft','queued','sending'))`,
        [list.id, f.max, String(f.afterDays)],
      );
      if (!due.length) continue;
      const tpl = f.template ? await getTemplate(list.account_id, f.template) : null;
      const approve = session.settings.aiMode === 'approve';
      const task = await createTask({ account: list.account_id, title: `${list.name}: follow up ${due.length}`, details: `No reply after ${f.afterDays} day(s)`, kind: 'bulk', createdBy: 'rule' });
      const rows = [];
      for (const m of due) {
        const first = (m.name || '').trim().split(/\s+/)[0];
        const body = fillTemplate(tpl?.body || f.text, { ...m.fields, name: m.name, first_name: first, phone: m.phone });
        const [last] = await query(
          `SELECT id FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me ORDER BY ts DESC LIMIT 1`,
          [list.account_id, m.jid],
        );
        rows.push([list.account_id, m.jid, JSON.stringify({ text: body, attachment: tpl?.attachment || undefined, replyTo: last?.id }), 'campaign', approve ? 'draft' : 'queued', 0, 'follow-up', task.id, list.id]);
      }
      await insertMany('outbox', ['account_id', 'to_jid', 'payload', 'source', 'status', 'priority', 'note', 'task_id', 'list_id'], rows);
      await refreshTask(task.id);
      await refreshList(list.id);
      outbox.wakeAccount(list.account_id);
      await logEvent(list.account_id, 'info', `Follow-ups for "${list.name}": ${rows.length} ${approve ? 'drafted for approval' : 'queued'}`);
    } catch (err) {
      await logEvent(list.account_id, 'warn', `Follow-ups for "${list.name}" failed: ${err.message}`);
    }
  }
}

/** Plain rows for a spreadsheet: one per member, with the hub's status columns. */
export async function exportRows(listId) {
  await refreshList(listId);
  const rows = await listMembers(listId);
  const d = (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata' }).slice(0, 17) : '');
  return rows.map((m) => ({
    phone: m.phone, name: m.name, row: m.row_ref, status: m.status, outcome: m.outcome || '', notes: m.notes || '',
    first_sent: d(m.first_sent_at), last_sent: d(m.last_sent_at), last_reply: d(m.last_reply_at), replies: m.replies,
    followups: m.followups_sent, last_reply_text: m.last_reply_text || '', error: m.error || '',
  }));
}
