/**
 * Task board: what each number is doing / will do ("Message 25 chef candidates", "Follow up with the
 * 10 interested ones tomorrow"). Tasks that own outbox messages move between columns automatically
 * from the state of those messages; plain to-do tasks are moved by you or the AI.
 */
import { query } from './db.js';
import { roleOf, roleFilter } from './campaign.js';
import { toJid } from './store.js';
import config from './config.js';
import { PHONE_RE } from './util.js';

export const COLUMNS = ['upcoming', 'in_progress', 'waiting', 'done', 'cancelled'];

const LABEL = { upcoming: 'Upcoming', in_progress: 'In progress', waiting: 'Waiting for approval', done: 'Done', cancelled: 'Cancelled' };

/** One line in a card's history. Never throws: history must not break the action it records. */
export async function logTask(taskId, text, { actor = 'hub', kind = 'event' } = {}) {
  if (!taskId || !text) return;
  await query('INSERT INTO task_log (task_id, actor, kind, text) VALUES ($1,$2,$3,$4)', [taskId, actor, kind, String(text).slice(0, 2000)]).catch(() => {});
}

/** A note on a card (call notes, what was agreed) — from the owner ('you') or the AI. */
export async function addNote(taskId, text, actor = 'you') {
  if (!String(text || '').trim()) throw new Error('Write the note first');
  const [t] = await query('UPDATE tasks SET updated_at = now() WHERE id = $1 RETURNING id, title', [taskId]);
  if (!t) throw new Error('Task not found');
  await logTask(t.id, String(text).trim(), { actor, kind: 'note' });
  return t;
}

/** One note on several cards; optionally a card for the AI (due now) that lists them, and close the originals. */
export async function bulkNote(ids, text, { aiTask = true, close = false, actor = 'you' } = {}) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) throw new Error('Select at least one card');
  if (!String(text || '').trim()) throw new Error('Write the note first');
  const cards = await query('SELECT * FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id', [list]);
  for (const c of cards) await logTask(c.id, String(text).trim(), { actor, kind: 'note' });
  let task = null;
  if (aiTask) {
    const lines = cards.map((c) => {
      const [k, a, j] = String(c.ref || '').split(':');
      const chat = ['reply', 'remind'].includes(k) ? ` | chat ${j} on ${a}` : ['followup', 'visit'].includes(k) ? ` | chat ${j} on ${c.account_id}` : '';
      return `- #${c.id} ${c.title}${chat}${c.details ? ` — ${String(c.details).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    });
    const counts = {};
    for (const c of cards) counts[c.account_id] = (counts[c.account_id] || 0) + 1;
    const account = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
    task = await createTask({
      account, kind: 'todo', assignee: 'ai', dueAt: new Date().toISOString(), createdBy: actor,
      title: `Owner: ${String(text).trim().replace(/\s+/g, ' ').slice(0, 70)} (${cards.length} people)`,
      details: `${String(text).trim()}\n\nCards:\n${lines.join('\n')}\n\nDraft what the note asks on each person's own number, note each card, then mark this card done.`,
    });
  }
  if (close) for (const c of cards) if (!['done', 'cancelled'].includes(c.status)) await updateTask(c.id, { status: 'done', actor });
  // the AI card carries the note from here, so these cards are not flagged as "owner note to act on"
  if (task) for (const c of cards) await logTask(c.id, `Handed to the AI as task #${task.id}`, { actor: 'ai' });
  return { noted: cards.length, task };
}

export async function taskLog(taskId) {
  return query('SELECT at, actor, kind, text FROM task_log WHERE task_id = $1 ORDER BY id', [taskId]);
}

/** Recompute an auto task's column from its messages. */
export async function refreshTask(taskId) {
  if (!taskId) return;
  const [t] = await query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  if (!t || t.status === 'cancelled') return;
  const [c] = await query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'draft')::int AS drafts,
       count(*) FILTER (WHERE status IN ('queued','sending') AND scheduled_at <= now() + interval '1 minute')::int AS active,
       count(*) FILTER (WHERE status = 'queued' AND scheduled_at > now() + interval '1 minute')::int AS later
     FROM outbox WHERE task_id = $1`,
    [taskId],
  );
  if (!c.total) return;
  const status = c.drafts ? 'waiting' : c.active ? 'in_progress' : c.later ? 'upcoming' : 'done';
  const moved = await query(
    `UPDATE tasks SET status = $2, updated_at = now(),
       completed_at = CASE WHEN $2 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END
     WHERE id = $1 AND status <> $2 RETURNING id`,
    [taskId, status],
  );
  if (moved.length) await logTask(taskId, `${LABEL[status]} (from its messages: ${c.total} total, ${c.drafts} to approve)`);
}

export const ASSIGNEES = ['you', 'ai'];
const who = (a) => {
  if (a == null || a === '') return null;
  const v = String(a).toLowerCase() === 'owner' ? 'you' : String(a).toLowerCase();
  if (!ASSIGNEES.includes(v)) throw new Error('assignee must be "you" (the owner) or "ai"');
  return v;
};

/**
 * The campaign of a card that names a person: the role of the latest list with any phone number in the text
 * (so "Call Jagdish 9217687968" lands in the Chef campaign without anyone choosing it).
 */
export async function guessRole(accountId, text) {
  // phone numbers standing on their own in the text; local numbers get the country code
  const phones = [...new Set(String(text || '').match(PHONE_RE) || [])].map((p) => toJid(p.replace(/\D/g, '')).split('@')[0]);
  for (const d of phones) {
    const [r] = await query(`SELECT ${roleOf('$1', '$2')} AS role`, [accountId, `${d}@s.whatsapp.net`]);
    if (r?.role) return r.role;
  }
  return null;
}

export async function createTask({ account, title, details, kind = 'todo', dueAt, createdBy = 'you', idemKey = null, role = null, assignee, priority = false }) {
  if (!title?.trim()) throw new Error('A task needs a title');
  if (!role) role = await guessRole(account, `${title} ${details || ''}`).catch(() => null);
  const [row] = await query(
    `INSERT INTO tasks (account_id, title, details, kind, status, due_at, created_by, idem_key, role, assignee, priority)
     VALUES ($1,$2,$3,$4,'upcoming',$5,$6,$7,$8,$9,$10) RETURNING *`,
    [account, title.trim(), details || null, kind, dueAt || null, createdBy, idemKey ? String(idemKey) : null, role, who(assignee) || (kind === 'bulk' ? 'ai' : 'you'), !!priority],
  );
  await logTask(row.id, 'Created', { actor: createdBy });
  return row;
}

/**
 * Cards the hub keeps in step by itself (one open card per ref): create it, or update the open one in place.
 * Reopens nothing that was done — a new event makes a new card.
 */
export async function upsertRefTask(ref, { account, title, details, kind = 'todo', dueAt = null, role = null, createdBy = 'rule', assignee = 'you', priority = false }) {
  const [open] = await query(`SELECT id, due_at FROM tasks WHERE ref = $1 AND status NOT IN ('done','cancelled') ORDER BY id DESC LIMIT 1`, [ref]);
  if (open) {
    const was = open.due_at ? new Date(open.due_at).getTime() : null;
    const now = dueAt ? new Date(dueAt).getTime() : null;
    if (was !== now) await logTask(open.id, `Due ${now ? new Date(now).toLocaleString('en-IN', { timeZone: config.tz, dateStyle: 'medium', timeStyle: 'short' }) : 'cleared'}`);
    const [row] = await query(
      `UPDATE tasks SET title = $2, details = $3, due_at = $4, account_id = $5, role = COALESCE($6, role), assignee = $7, priority = priority OR $8, updated_at = now() -- a priority the owner set stays
       WHERE id = $1 RETURNING *`,
      [open.id, title, details || null, dueAt, account, role, assignee, !!priority],
    );
    return row;
  }
  const [row] = await query(
    `INSERT INTO tasks (account_id, title, details, kind, status, due_at, created_by, role, ref, assignee, priority)
     VALUES ($1,$2,$3,$4,'upcoming',$5,$6,$7,$8,$9,$10) RETURNING *`,
    [account, title, details || null, kind, dueAt, createdBy, role, ref, assignee, !!priority],
  );
  await logTask(row.id, 'Created by the hub');
  return row;
}

/** Close the open card(s) for these refs (status done or cancelled). */
export async function closeRefTasks(refs, status = 'done', reason = '') {
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return 0;
  const rows = await query(
    `UPDATE tasks SET status = $2, completed_at = now(), updated_at = now()
     WHERE ref = ANY($1::text[]) AND status NOT IN ('done','cancelled') RETURNING id`,
    [list, status],
  );
  for (const r of rows) await logTask(r.id, `${LABEL[status]} by the hub${reason ? ` — ${reason}` : ''}`);
  return rows.length;
}

export async function updateTask(id, { title, details, status, dueAt, assignee, priority, actor = 'you', role }) {
  if (role !== undefined) await query('UPDATE tasks SET role = $2 WHERE id = $1', [id, role || null]);
  if (status && !COLUMNS.includes(status)) throw new Error(`Status must be one of ${COLUMNS.join(', ')}`);
  const [before] = await query('SELECT status, due_at, priority, assignee FROM tasks WHERE id = $1', [id]);
  const [row] = await query(
    `UPDATE tasks SET title = COALESCE($2, title), details = COALESCE($3, details), status = COALESCE($4, status),
       due_at = CASE WHEN $5::text IS NULL THEN due_at WHEN $5 = '' THEN NULL ELSE $5::timestamptz END,
       completed_at = CASE WHEN COALESCE($4, status) IN ('done','cancelled') THEN COALESCE(completed_at, now()) ELSE NULL END,
       assignee = COALESCE($6, assignee), priority = COALESCE($7, priority),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, title ?? null, details ?? null, status ?? null, dueAt === undefined ? null : dueAt || '', who(assignee), priority == null ? null : !!priority],
  );
  if (!row) throw new Error('Task not found');
  const changes = [
    before && row.status !== before.status && `Moved to ${LABEL[row.status]}`,
    before && row.priority !== before.priority && (row.priority ? 'Marked priority' : 'Priority removed'),
    before && (row.assignee || 'you') !== (before.assignee || 'you') && `Now for ${row.assignee === 'ai' ? 'the AI' : 'the owner'}`,
    before && String(row.due_at || '') !== String(before.due_at || '') && (row.due_at ? `Due ${new Date(row.due_at).toLocaleString('en-IN', { timeZone: config.tz, dateStyle: 'medium', timeStyle: 'short' })}` : 'Due date removed'),
    title && 'Title edited',
    details && 'Details edited',
  ].filter(Boolean);
  if (changes.length) await logTask(row.id, changes.join(' · '), { actor });
  return row;
}

/** Cancel a task and everything it hasn't sent yet. */
export async function cancelTask(id, actor = 'you') {
  await query(`UPDATE outbox SET status = 'rejected' WHERE task_id = $1 AND status IN ('draft','queued')`, [id]);
  return updateTask(id, { status: 'cancelled', actor });
}

export async function listTasks({ account, past = false, limit = 200, role, assignee, dueBefore } = {}) {
  const p = [];
  const where = [];
  if (assignee) {
    p.push(who(assignee));
    where.push(`COALESCE(t.assignee, 'you') = $${p.length}`);
  }
  if (dueBefore) {
    p.push(new Date(dueBefore).toISOString());
    // an undated to-do is due now (else an AI card made without a date would never come up); bulk sends aren't to-dos
    where.push(`(t.due_at <= $${p.length}::timestamptz OR (t.due_at IS NULL AND t.kind <> 'bulk'))`);
  }
  if (role) {
    p.push(role);
    where.push(roleFilter(`COALESCE(t.role, CASE WHEN t.ref LIKE 'reply:%' OR t.ref LIKE 'remind:%' THEN ${roleOf('t.account_id', "split_part(t.ref, ':', 3)")} END)`, p.length));
  }
  if (account) {
    p.push(account);
    where.push(`t.account_id = $${p.length}`);
  }
  where.push(past ? `t.status IN ('done','cancelled')` : `t.status NOT IN ('done','cancelled')`);
  p.push(Math.min(limit, 500));
  return query(
    `SELECT t.*,
       COALESCE(o.total, 0) AS total, COALESCE(o.sent, 0) AS sent, COALESCE(o.failed, 0) AS failed,
       COALESCE(o.drafts, 0) AS drafts, COALESCE(o.pending, 0) AS pending, o.next_at, o.replied,
       n.notes, n.last_note,
       -- the owner wrote a note and the AI has not acted on the card since
       (SELECT l.actor FROM task_log l WHERE l.task_id = t.id AND (l.kind = 'note' OR l.actor = 'ai') ORDER BY l.id DESC LIMIT 1) = 'you' AS owner_note_pending
     FROM tasks t
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS notes, (array_agg(l.text ORDER BY l.id DESC))[1] AS last_note
       FROM task_log l WHERE l.task_id = t.id AND l.kind = 'note') n ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS total,
         count(*) FILTER (WHERE x.status = 'sent')::int AS sent,
         count(*) FILTER (WHERE x.status = 'failed')::int AS failed,
         count(*) FILTER (WHERE x.status = 'draft')::int AS drafts,
         count(*) FILTER (WHERE x.status IN ('queued','sending'))::int AS pending,
         min(x.scheduled_at) FILTER (WHERE x.status = 'queued') AS next_at,
         -- how many recipients wrote back after our message
         count(DISTINCT x.to_jid) FILTER (WHERE x.status = 'sent' AND EXISTS (
           SELECT 1 FROM messages m WHERE m.account_id = x.account_id AND m.chat_jid = x.to_jid
             AND NOT m.from_me AND m.ts >= extract(epoch FROM x.sent_at)))::int AS replied
       FROM outbox x WHERE x.task_id = t.id) o ON TRUE
     WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN t.status IN ('done','cancelled') THEN t.completed_at END DESC NULLS LAST,
              t.due_at NULLS LAST, t.id DESC
     LIMIT $${p.length}`,
    p,
  );
}

/**
 * Personalise "{name}"-style placeholders. vars come from the recipient row (name, plus any extra fields).
 * {name} falls back to "there" so "Hi {name}" never reads "Hi ". {field|fallback} uses the fallback when the field
 * is empty, e.g. {salary|Rs.21,000-26,000}.
 */
export function fillTemplate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)(?:\|([^{}]*))?\}/g, (m, key, fallback) => {
    const v = vars[key] ?? vars[key.toLowerCase()];
    if (v != null && String(v).trim()) return String(v).trim();
    if (fallback !== undefined) return fallback.trim();
    return key.toLowerCase() === 'name' ? 'there' : '';
  });
}

/**
 * Turn a list of recipients into checked, de-duplicated outbox entries.
 * Skips: invalid numbers, duplicates in the list, contacts tagged opted-out,
 * and (unless allowRepeat) anyone this number already messaged in the last `skipIfContactedDays` days.
 */
export async function planRecipients(accountId, recipients, { skipIfContactedDays = 30, allowRepeat = false } = {}) {
  const seen = new Set();
  const ok = [];
  const skipped = [];
  for (const r of recipients || []) {
    const raw = typeof r === 'string' ? r : r?.to || r?.phone;
    let jid;
    try {
      jid = raw ? toJid(raw) : null;
    } catch {
      jid = null;
    }
    const digits = jid?.split('@')[0] || '';
    if (!jid || (jid.endsWith('@s.whatsapp.net') && (digits.length < 10 || digits.length > 15))) {
      skipped.push({ to: raw, reason: 'invalid number' });
      continue;
    }
    if (seen.has(jid)) {
      skipped.push({ to: raw, reason: 'duplicate in list' });
      continue;
    }
    seen.add(jid);
    ok.push({ jid, vars: typeof r === 'object' ? r : {} });
  }
  if (!ok.length) return { ok, skipped };
  const jids = ok.map((o) => o.jid);
  const optedOut = new Set(
    (await query(`SELECT jid FROM contacts WHERE account_id = $1 AND jid = ANY($2) AND 'opted-out' = ANY(tags)`, [accountId, jids])).map((r) => r.jid),
  );
  const recent = allowRepeat
    ? new Set()
    : new Set(
        (await query(
          `SELECT DISTINCT chat_jid FROM messages WHERE account_id = $1 AND chat_jid = ANY($2) AND from_me
             AND ts >= extract(epoch FROM now())::bigint - $3::bigint * 86400`,
          [accountId, jids, skipIfContactedDays],
        )).map((r) => r.chat_jid),
      );
  const kept = [];
  for (const o of ok) {
    if (optedOut.has(o.jid)) skipped.push({ to: o.jid.split('@')[0], reason: 'opted out' });
    else if (recent.has(o.jid)) skipped.push({ to: o.jid.split('@')[0], reason: `already messaged in the last ${skipIfContactedDays} days` });
    else kept.push(o);
  }
  return { ok: kept, skipped };
}
