/**
 * Task board: what each number is doing / will do ("Message 25 chef candidates", "Follow up with the
 * 10 interested ones tomorrow"). Tasks that own outbox messages move between columns automatically
 * from the state of those messages; plain to-do tasks are moved by you or the AI.
 */
import { query } from './db.js';
import { toJid } from './store.js';

export const COLUMNS = ['upcoming', 'in_progress', 'waiting', 'done', 'cancelled'];

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
  await query(
    `UPDATE tasks SET status = $2, updated_at = now(),
       completed_at = CASE WHEN $2 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END
     WHERE id = $1 AND status <> $2`,
    [taskId, status],
  );
}

export async function createTask({ account, title, details, kind = 'todo', dueAt, createdBy = 'you', idemKey = null, role = null }) {
  if (!title?.trim()) throw new Error('A task needs a title');
  const [row] = await query(
    `INSERT INTO tasks (account_id, title, details, kind, status, due_at, created_by, idem_key, role)
     VALUES ($1,$2,$3,$4,'upcoming',$5,$6,$7,$8) RETURNING *`,
    [account, title.trim(), details || null, kind, dueAt || null, createdBy, idemKey ? String(idemKey) : null, role],
  );
  return row;
}

export async function updateTask(id, { title, details, status, dueAt }) {
  if (status && !COLUMNS.includes(status)) throw new Error(`Status must be one of ${COLUMNS.join(', ')}`);
  const [row] = await query(
    `UPDATE tasks SET title = COALESCE($2, title), details = COALESCE($3, details), status = COALESCE($4, status),
       due_at = CASE WHEN $5::text IS NULL THEN due_at WHEN $5 = '' THEN NULL ELSE $5::timestamptz END,
       completed_at = CASE WHEN COALESCE($4, status) IN ('done','cancelled') THEN COALESCE(completed_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, title ?? null, details ?? null, status ?? null, dueAt === undefined ? null : dueAt || ''],
  );
  if (!row) throw new Error('Task not found');
  return row;
}

/** Cancel a task and everything it hasn't sent yet. */
export async function cancelTask(id) {
  await query(`UPDATE outbox SET status = 'rejected' WHERE task_id = $1 AND status IN ('draft','queued')`, [id]);
  return updateTask(id, { status: 'cancelled' });
}

export async function listTasks({ account, past = false, limit = 200, role } = {}) {
  const p = [];
  const where = [];
  if (role) {
    p.push(role);
    where.push(`lower(t.role) = lower($${p.length})`);
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
       COALESCE(o.drafts, 0) AS drafts, COALESCE(o.pending, 0) AS pending, o.next_at, o.replied
     FROM tasks t
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
