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
import { afterTime } from './settings.js';

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

const DEFAULT_FOLLOWUP = { enabled: false, afterDays: 2, max: 1, text: '', template: '', quietDaysOnly: true };

/** Funnel stages (set by you or the AI). Closed ones are never messaged again from the list. */
export const STAGES = ['interested', 'date_given', 'visited', 'trial', 'selected', 'joined', 'no_show', 'not_interested', 'rejected'];
export const CLOSED_STAGES = ['joined', 'not_interested', 'rejected'];
const DEFAULT_PIPELINE = {
  enabled: true,
  autoSend: false, // false = reminders/questions wait for approval like other AI messages
  remindHoursBefore: 18,
  askDateAfterHours: 4,
  askDateText: 'Namaste {first_name} ji, aap kis din aa sakte hain? Date aur time bata dijiye. - Zenith Suites HR',
  reminderText: 'Namaste {first_name} ji, yaad dila rahe hain: aap {visit_date} ko Zenith Suites (Amrutha Halli) aa rahe hain. Koi problem ho to call karein: 9353315601. - Zenith Suites HR',
};

/** Outcomes that close a person: never messaged again from the list (no sends, no follow-ups). */
export const CLOSED_OUTCOME = /^\s*(rejected|not[\s-]?interested|hired|joined|do[\s-]?not[\s-]?contact)/i;
const CLOSED_SQL = `COALESCE(m.stage, '') NOT IN ('joined','not_interested','rejected') AND COALESCE(m.outcome, '') !~* '^\\s*(rejected|not[\\s-]?interested|hired|joined|do[\\s-]?not[\\s-]?contact)'`;

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

export async function updateMember(listId, phoneOrJid, { outcome, notes, stage, visitAt }) {
  const jid = toJid(phoneOrJid);
  if (stage !== undefined && stage !== null && stage !== '' && !STAGES.includes(stage)) {
    throw new Error(`Stage must be one of: ${STAGES.join(', ')}`);
  }
  let visit = visitAt === undefined ? undefined : visitAt ? new Date(visitAt) : null;
  if (visit && isNaN(visit)) throw new Error('Could not read the visit date');
  if (visit && stage === undefined) stage = 'date_given'; // giving a date moves them to "date given"
  const [m] = await query(
    `UPDATE list_members SET
       outcome = CASE WHEN $3::text IS NULL THEN outcome WHEN $3 = '' THEN NULL ELSE $3 END,
       notes = COALESCE($4, notes),
       stage = CASE WHEN $5::text IS NULL THEN stage WHEN $5 = '' THEN NULL ELSE $5 END,
       stage_at = CASE WHEN $5::text IS NULL THEN stage_at ELSE now() END,
       visit_at = CASE WHEN $6::text = 'keep' THEN visit_at WHEN $6 = 'clear' THEN NULL ELSE $7::timestamptz END,
       reminded_at = CASE WHEN $6::text = 'keep' THEN reminded_at ELSE NULL END,
       checked_at = CASE WHEN $6::text = 'keep' THEN checked_at ELSE NULL END,
       updated_at = now()
     WHERE list_id = $1 AND jid = $2 RETURNING *`,
    [listId, jid, outcome === undefined ? null : outcome, notes ?? null, stage === undefined ? null : stage,
      visit === undefined ? 'keep' : visit === null ? 'clear' : 'set', visit ? visit.toISOString() : null],
  );
  if (!m) throw new Error('Not on this list');
  return m;
}

export async function setPipeline(listId, settings) {
  const [l] = await query('SELECT pipeline FROM lists WHERE id = $1', [listId]);
  if (!l) throw new Error('List not found');
  const p = { ...DEFAULT_PIPELINE, ...(l.pipeline || {}), ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) };
  p.remindHoursBefore = Math.max(1, Number(p.remindHoursBefore) || 18);
  p.askDateAfterHours = Math.max(1, Number(p.askDateAfterHours) || 4);
  p.enabled = p.enabled !== false;
  p.autoSend = !!p.autoSend;
  const [u] = await query('UPDATE lists SET pipeline = $2, updated_at = now() WHERE id = $1 RETURNING *', [listId, JSON.stringify(p)]);
  return u;
}

const fmtVisit = (t) => new Date(t).toLocaleString('en-IN', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Warm-lead automation (runs with follow-ups every 10 min, on the server holding the number):
 *  - stage "interested", no date, quiet for askDateAfterHours → ask for a date (once)
 *  - stage "date_given" → reminder message remindHoursBefore the visit (once) + a board task for you
 *  - visit time passed by 3 h and stage still "date_given" → board task "Did X come?" (once)
 * These come before bulk sends and follow-ups (priority 5).
 */
export async function runPipeline() {
  const lists = await query(`SELECT * FROM lists`);
  for (const list of lists) {
    const session = manager.sessions.get(list.account_id);
    if (session?.status !== 'open') continue;
    const p = { ...DEFAULT_PIPELINE, ...(list.pipeline || {}) };
    if (!p.enabled) continue;
    try {
      const approve = !p.autoSend && session.settings.aiMode === 'approve';
      const send = async (m, text, note) => {
        const first = (m.name || '').trim().split(/\s+/)[0];
        const body = fillTemplate(text, { ...m.fields, name: m.name, first_name: first, phone: m.phone, visit_date: m.visit_at ? fmtVisit(m.visit_at) : '' });
        await query(
          `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, list_id) VALUES ($1,$2,$3,'campaign',$4,5,$5,$6)`,
          [list.account_id, m.jid, JSON.stringify({ text: body }), approve ? 'draft' : 'queued', note, list.id],
        );
      };
      const pending = (note) => `NOT EXISTS (SELECT 1 FROM outbox o WHERE o.list_id = m.list_id AND o.to_jid = m.jid AND o.note = '${note}' AND o.status IN ('draft','queued','sending'))`;
      // 1. interested but no date yet → ask for one
      const ask = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'interested' AND m.visit_at IS NULL AND m.asked_date_at IS NULL
           AND COALESCE(m.last_reply_at, m.stage_at, m.updated_at) <= now() - ($2 || ' hours')::interval AND ${pending('ask-date')}`,
        [list.id, String(p.askDateAfterHours)],
      );
      for (const m of ask) {
        await send(m, p.askDateText, 'ask-date');
        await query('UPDATE list_members SET asked_date_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
      }
      // 2. date given → reminder before the visit + task for you
      const remind = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'date_given' AND m.visit_at IS NOT NULL AND m.reminded_at IS NULL
           AND m.visit_at > now() AND m.visit_at <= now() + ($2 || ' hours')::interval`,
        [list.id, String(p.remindHoursBefore)],
      );
      for (const m of remind) {
        await send(m, p.reminderText, 'visit-reminder');
        await createTask({ account: list.account_id, title: `Visit: ${m.name || m.phone} — ${fmtVisit(m.visit_at)}`, details: `${list.name}. Reminder sent to +${m.phone}. Update the stage after the visit.`, dueAt: m.visit_at, createdBy: 'rule' });
        await query('UPDATE list_members SET reminded_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
      }
      // 3. visit time passed, stage not updated → ask you
      const check = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'date_given' AND m.visit_at <= now() - interval '3 hours' AND m.checked_at IS NULL`,
        [list.id],
      );
      for (const m of check) {
        await createTask({ account: list.account_id, title: `Did ${m.name || m.phone} come? (${fmtVisit(m.visit_at)})`, details: `${list.name}: set the stage to visited / trial / no_show.`, createdBy: 'rule' });
        await query('UPDATE list_members SET checked_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
      }
      if (ask.length + remind.length) outbox.wakeAccount(list.account_id);
      if (ask.length + remind.length + check.length) {
        await logEvent(list.account_id, 'info', `Pipeline "${list.name}": ${ask.length} asked for a date, ${remind.length} visit reminders, ${check.length} visit checks`);
      }
    } catch (err) {
      await logEvent(list.account_id, 'warn', `Pipeline "${list.name}" failed: ${err.message}`);
    }
  }
}

/** Funnel overview: people per stage and upcoming visits. */
export async function pipelineSummary(account) {
  const counts = await query(
    `SELECT l.id, l.name, COALESCE(m.stage, CASE WHEN m.status = 'replied' THEN 'replied (no stage)' WHEN m.status IN ('sent','queued') THEN 'contacted' ELSE 'not contacted' END) AS stage, count(*)::int AS n
     FROM lists l JOIN list_members m ON m.list_id = l.id WHERE ($1::text IS NULL OR l.account_id = $1)
     GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC`,
    [account || null],
  );
  const visits = await query(
    `SELECT l.name AS list, m.* FROM lists l JOIN list_members m ON m.list_id = l.id
     WHERE ($1::text IS NULL OR l.account_id = $1) AND m.stage = 'date_given' AND m.visit_at IS NOT NULL
     ORDER BY m.visit_at LIMIT 50`,
    [account || null],
  );
  return { counts, visits };
}

export async function setFollowup(listId, settings) {
  const [l] = await query('SELECT followup FROM lists WHERE id = $1', [listId]);
  if (!l) throw new Error('List not found');
  const f = { ...DEFAULT_FOLLOWUP, ...(l.followup || {}), ...settings };
  f.afterDays = Math.max(0.01, Number(f.afterDays) || 2);
  f.max = Math.max(0, Math.min(5, parseInt(f.max, 10) || 0));
  f.enabled = !!f.enabled;
  f.quietDaysOnly = f.quietDaysOnly !== false;
  f.autoSend = !!f.autoSend;
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
    if (CLOSED_STAGES.includes(m.stage) || CLOSED_OUTCOME.test(m.outcome || '')) {
      skipped.push({ to: m.phone, reason: `closed: ${m.stage || m.outcome}` });
      continue;
    }
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
      // New candidates first: no follow-ups on a day this number messages (or is about to message) new people,
      // not before the number's follow-up time (default 21:00), and at most followupDailyMax a day.
      if (f.quietDaysOnly !== false && (await outbox.newOutreachToday(list.account_id))) continue;
      const st = session.settings;
      if (!afterTime(st.followupStart)) continue;
      const already = (await query(
        `SELECT count(*)::int AS n FROM outbox WHERE account_id = $1 AND note = 'follow-up' AND status IN ('draft','queued','sending','sent')
           AND created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
        [list.account_id, process.env.TZ_NAME || 'Asia/Kolkata'],
      ))[0].n;
      const room = st.followupDailyMax - already;
      if (room <= 0) continue;
      const due = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.status = 'sent' AND m.followups_sent < $2
           AND m.last_sent_at <= now() - ($3 || ' days')::interval
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.list_id = m.list_id AND o.to_jid = m.jid AND o.status IN ('draft','queued','sending'))
           AND ${CLOSED_SQL}
         ORDER BY CASE WHEN m.row_ref ~ '^[0-9]+$' THEN m.row_ref::int END NULLS LAST, m.last_sent_at
         LIMIT $4`,
        [list.id, f.max, String(f.afterDays), room],
      );
      if (!due.length) continue;
      const tpl = f.template ? await getTemplate(list.account_id, f.template) : null;
      const approve = !f.autoSend && session.settings.aiMode === 'approve';
      const task = await createTask({ account: list.account_id, title: `${list.name}: follow up ${due.length}`, details: `No reply after ${f.afterDays} day(s)`, kind: 'bulk', createdBy: 'rule' });
      const rows = [];
      for (const m of due) {
        const first = (m.name || '').trim().split(/\s+/)[0];
        const body = fillTemplate(tpl?.body || f.text, { ...m.fields, name: m.name, first_name: first, phone: m.phone });
        const [last] = await query(
          `SELECT id FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me ORDER BY ts DESC LIMIT 1`,
          [list.account_id, m.jid],
        );
        rows.push([list.account_id, m.jid, JSON.stringify({ text: body, attachment: tpl?.attachment || undefined, replyTo: last?.id }), 'campaign', approve ? 'draft' : 'queued', -1, 'follow-up', task.id, list.id]);
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
