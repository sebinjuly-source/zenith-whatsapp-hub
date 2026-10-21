/**
 * Board cards the hub keeps in step by itself, so nothing waits unseen:
 *  - "Reply to X"     — AI: a candidate on a list wrote and nobody has answered yet (closes when any reply goes out)
 *  - "Interview: X"   — YOU, priority: a visit date is set (due at the visit; done when marked visited, gone if cleared)
 *  - "Follow up: X"   — AI: they said when they'll be free; due the day before (closes when we message them then)
 *  - "Scheduled: X"   — AI: a single message waiting to go out later (closes when it is sent or cancelled)
 *  - "Reminder"       — YOU: a chat snoozed with "Remind me" (due on that date; closes when the chat is reopened/done)
 * Updated instantly on each event, and re-checked every 10 minutes (syncBoard) so a missed event can't hide anything.
 */
import { query } from './db.js';
import { upsertRefTask, closeRefTasks, logTask } from './tasks.js';
import config from './config.js';

const CLOSED_STAGES = ['joined', 'not_interested', 'rejected'];
const CLOSED_OUTCOME = /^\s*(rejected|not[\s-]?interested|hired|joined|do[\s-]?not[\s-]?contact)/i;
const isClosed = (m) => CLOSED_STAGES.includes(m.stage) || CLOSED_OUTCOME.test(m.outcome || '');
const when = (t) => new Date(t).toLocaleString('en-IN', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const phone = (jid) => String(jid).split('@')[0];

/** The list a person belongs to (prefer one of this number's lists). */
async function memberOf(accountId, jid) {
  const [m] = await query(
    `SELECT m.name, m.stage, m.outcome, l.id AS list_id, l.name AS list_name, l.role
     FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $2
     ORDER BY (l.account_id = $1) DESC, l.id DESC LIMIT 1`,
    [accountId, jid],
  );
  return m || null;
}

async function replyCard(accountId, jid, m, last) {
  const ref = `reply:${accountId}:${jid}`;
  // You closed the card after their last message (e.g. it was just "ok"): leave it closed.
  const [closed] = await query(
    `SELECT 1 FROM tasks WHERE ref = $1 AND status IN ('done','cancelled') AND completed_at >= to_timestamp($2) LIMIT 1`,
    [ref, Number(last.ts)],
  );
  if (closed) return null;
  const preview = (last.body || `[${last.type}]`).replace(/\s+/g, ' ').slice(0, 80);
  return upsertRefTask(ref, {
    account: accountId, kind: 'reply', role: m.role, assignee: 'ai', dueAt: new Date(Number(last.ts) * 1000).toISOString(),
    title: `Reply to ${m.name || phone(jid)}: "${preview}"`,
    details: `${m.list_name} · +${phone(jid)} wrote ${when(Number(last.ts) * 1000)} and is waiting for an answer. Open the chat, or ask the AI to draft a reply.`,
  });
}

/** A message came in: if it's a candidate on a list (not closed), put "Reply to …" on the board. */
export async function noteIncoming(accountId, r) {
  if (!r?.chatJid || r.fromMe || r.chatJid.endsWith('@g.us')) return;
  const m = await memberOf(accountId, r.chatJid);
  if (!m || isClosed(m)) return;
  await replyCard(accountId, r.chatJid, m, r);
}

/** We sent something in these chats: their "Reply to …" cards are done, and so is a follow-up that has come due. */
export async function noteSent(accountId, jids) {
  const uniq = [...new Set(jids)];
  const refs = uniq.map((j) => `reply:${accountId}:${j}`);
  const n = await closeRefTasks(refs, 'done', 'a reply went out');
  if (!uniq.length) return n;
  // A follow-up counts as done when we message them from 12 h before it is due (an earlier chat doesn't close it)
  const due = await query(
    `SELECT t.id, t.ref FROM tasks t WHERE t.kind = 'followup' AND t.status NOT IN ('done','cancelled') AND t.due_at <= now() + interval '12 hours'
       AND split_part(t.ref, ':', 3) = ANY($1::text[])
       -- only a message sent from 12 h before it was due counts (not an older one seen again by the re-check)
       AND EXISTS (SELECT 1 FROM messages x WHERE x.chat_jid = split_part(t.ref, ':', 3) AND x.from_me
                   AND x.ts >= extract(epoch FROM t.due_at - interval '12 hours'))`,
    [uniq],
  );
  if (due.length) {
    await closeRefTasks(due.map((t) => t.ref), 'done', 'follow-up message went out');
    for (const t of due) {
      const [, listId, jid] = t.ref.split(':');
      await query(`UPDATE list_members SET followup_at = NULL WHERE list_id = $1 AND jid = $2 AND followup_at <= now() + interval '12 hours'`, [listId, jid]);
    }
  }
  return n + due.length;
}

/** Follow-up card for one person: due at followup_at, for the AI to message them (gone if cleared or they're closed). */
export async function syncFollowup(list, m) {
  const ref = `followup:${list.id}:${m.jid}`;
  if (m.followup_at && !isClosed(m) && !(m.stage === 'date_given' && m.visit_at && new Date(m.visit_at) > new Date())) {
    return upsertRefTask(ref, {
      account: list.account_id, kind: 'followup', role: list.role, assignee: 'ai', dueAt: new Date(m.followup_at).toISOString(),
      title: `Follow up: ${m.name || phone(m.jid)} — ${when(m.followup_at)}`,
      details: `${m.followup_note || 'Said they will be free around then.'} · ${list.name} · +${phone(m.jid)}. Message them to fix the day and time for the interview.`,
    });
  }
  return closeRefTasks([ref], 'cancelled', isClosed(m) ? `stage ${m.stage || m.outcome}` : m.stage === 'date_given' && m.visit_at ? 'interview date set instead' : 'follow-up date cleared');
}

/** Single messages waiting to go out more than 15 minutes from now get a card, so nothing scheduled is invisible. */
export async function syncScheduled() {
  const rows = await query(
    `SELECT o.id, o.account_id, o.to_jid, o.status, o.scheduled_at, o.note, o.payload,
       COALESCE(NULLIF(ch.name,''), ct.name, ct.notify) AS name
     FROM outbox o
     LEFT JOIN chats ch ON ch.account_id = o.account_id AND ch.jid = o.to_jid
     LEFT JOIN contacts ct ON ct.account_id = o.account_id AND ct.jid = o.to_jid
     WHERE o.task_id IS NULL AND o.status IN ('queued','draft') AND o.scheduled_at > now() + interval '15 minutes'`,
  );
  for (const o of rows) {
    const text = (o.payload?.text || (o.payload?.waTemplate ? `Meta template "${o.payload.waTemplate.name}"` : '[file]')).replace(/s+/g, ' ').slice(0, 120);
    await upsertRefTask(`sched:${o.id}`, {
      account: o.account_id, kind: 'scheduled', assignee: o.status === 'draft' ? 'you' : 'ai', dueAt: new Date(o.scheduled_at).toISOString(),
      title: `Scheduled: message to ${o.name || phone(o.to_jid)} — ${when(o.scheduled_at)}`,
      details: `${o.status === 'draft' ? 'Approve it in Drafts, then it goes out at that time. ' : 'Goes out by itself. '}"${text}"${o.note ? ` · ${o.note}` : ''}`,
    });
  }
  const open = await query(`SELECT t.ref FROM tasks t WHERE t.ref LIKE 'sched:%' AND t.status NOT IN ('done','cancelled')`);
  for (const t of open) {
    const [o] = await query(`SELECT status, scheduled_at FROM outbox WHERE id = $1`, [Number(t.ref.split(':')[1])]);
    if (!o || ['sent', 'failed', 'rejected'].includes(o.status)) await closeRefTasks([t.ref], o?.status === 'sent' ? 'done' : 'cancelled', o ? `message ${o.status}` : 'message removed');
  }
  return rows.length;
}

/** Visit card for one person (called when a visit date or stage changes). */
export async function syncVisit(list, m) {
  const ref = `visit:${list.id}:${m.jid}`;
  if (m.stage === 'date_given' && m.visit_at) {
    return upsertRefTask(ref, {
      account: list.account_id, kind: 'visit', role: list.role, assignee: 'you', priority: true, dueAt: new Date(m.visit_at).toISOString(),
      title: `Interview: ${m.name || phone(m.jid)} — ${when(m.visit_at)}`,
      details: `${list.name} · +${phone(m.jid)}${m.notes ? ` · ${m.notes}` : ''}. Take the interview / cooking test, then set the stage (visited / trial / no_show).`,
    });
  }
  const done = ['visited', 'trial', 'selected', 'joined'].includes(m.stage);
  return closeRefTasks([ref], done ? 'done' : 'cancelled', done ? `stage ${m.stage}` : m?.stage ? `stage ${m.stage}, no visit date` : 'visit date cleared');
}

/** Chat reminder card (Remind me). */
export async function syncReminder(accountId, jid, { state, until, note } = {}) {
  const ref = `remind:${accountId}:${jid}`;
  if (state !== 'snoozed' || !until) return closeRefTasks([ref], 'done', `chat ${state || 'reopened'}`);
  const [c] = await query(
    `SELECT COALESCE(NULLIF(ch.name,''), ct.name, ct.notify, $2) AS name FROM (SELECT 1) x
     LEFT JOIN chats ch ON ch.account_id = $1 AND ch.jid = $3 LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $3`,
    [accountId, phone(jid), jid],
  );
  return upsertRefTask(ref, {
    account: accountId, kind: 'reminder', assignee: 'you', dueAt: new Date(until).toISOString(),
    title: `Reminder: ${c?.name || phone(jid)}${note ? ` — ${note}` : ''}`,
    details: `Chat +${phone(jid)} comes back to the inbox on ${when(until)}.`,
  });
}

/** How the last full re-check went (shown on /health, so a stopped check can't go unnoticed). */
export const lastSync = { at: null, ok: null, error: null, result: null };

export const FORGOTTEN_DAYS = 3;
/**
 * Safety net: someone marked "interested" with no interview date, no follow-up date, no open card and no message
 * either way for FORGOTTEN_DAYS days gets a follow-up card due now — an interested candidate is never forgotten.
 * At most 20 per run so a backlog can't flood the Board.
 */
export async function catchForgotten() {
  const rows = await query(
    `SELECT m.list_id, m.jid, m.name, l.account_id, l.name AS list_name, l.role,
       (SELECT max(x.ts) FROM messages x WHERE x.chat_jid = m.jid) AS last_ts
     FROM list_members m JOIN lists l ON l.id = m.list_id
     WHERE m.stage = 'interested' AND m.followup_at IS NULL AND m.visit_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.status NOT IN ('done','cancelled')
                       AND t.ref IN ('reply:' || l.account_id || ':' || m.jid, 'followup:' || m.list_id || ':' || m.jid))
       AND COALESCE((SELECT max(x.ts) FROM messages x WHERE x.chat_jid = m.jid), 0) < extract(epoch FROM now())::bigint - $1::bigint * 86400
       AND COALESCE(m.stage_at, now() - interval '30 days') < now() - ($1 || ' days')::interval
     LIMIT 20`,
    [FORGOTTEN_DAYS],
  );
  for (const r of rows) {
    const days = r.last_ts ? Math.floor((Date.now() / 1000 - Number(r.last_ts)) / 86400) : null;
    const note = `Interested but no interview date and no message for ${days ?? FORGOTTEN_DAYS}+ days — ask for the day and time`;
    const [m] = await query(
      `UPDATE list_members SET followup_at = now(), followup_note = $3, updated_at = now() WHERE list_id = $1 AND jid = $2 RETURNING *`,
      [r.list_id, r.jid, note],
    );
    const t = await syncFollowup({ id: r.list_id, account_id: r.account_id, name: r.list_name, role: r.role }, m);
    await logTask(t?.id, 'Added by the safety net: interested candidate with nothing planned');
  }
  return rows.length;
}

/**
 * Full re-check (every 10 minutes and at start): every list candidate whose chat ends with their message (last
 * 7 days, not closed) has a "Reply to" card; answered ones are closed; every set visit date has a card; reminders too.
 */
export async function syncBoard() {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const last = await query(
    `SELECT DISTINCT ON (x.account_id, x.chat_jid) x.account_id, x.chat_jid, x.from_me, x.ts, x.body, x.type
     FROM messages x
     WHERE x.ts > $1 AND x.chat_jid NOT LIKE '%@g.us'
       AND EXISTS (SELECT 1 FROM list_members m WHERE m.jid = x.chat_jid)
     ORDER BY x.account_id, x.chat_jid, x.ts DESC`,
    [since],
  );
  let opened = 0;
  const answered = new Map();
  for (const l of last) {
    if (l.from_me) {
      if (!answered.has(l.account_id)) answered.set(l.account_id, []);
      answered.get(l.account_id).push(l.chat_jid);
      continue;
    }
    const m = await memberOf(l.account_id, l.chat_jid);
    if (!m) continue;
    if (isClosed(m)) {
      await closeRefTasks([`reply:${l.account_id}:${l.chat_jid}`], 'done', `candidate closed (${m.stage || m.outcome})`);
      continue;
    }
    await replyCard(l.account_id, l.chat_jid, m, l);
    opened++;
  }
  for (const [acc, jids] of answered) await noteSent(acc, jids);
  // visits: every date set; cards whose person moved on are closed
  const visits = await query(
    `SELECT m.*, l.account_id, l.name AS list_name, l.role FROM list_members m JOIN lists l ON l.id = m.list_id
     WHERE m.stage = 'date_given' AND m.visit_at > now() - interval '2 days'`,
  );
  for (const v of visits) await syncVisit({ id: v.list_id, account_id: v.account_id, name: v.list_name, role: v.role }, v);
  const openVisits = await query(`SELECT ref FROM tasks WHERE ref LIKE 'visit:%' AND status NOT IN ('done','cancelled')`);
  for (const t of openVisits) {
    const [, listId, jid] = t.ref.split(':');
    const [m] = await query(`SELECT m.*, l.account_id, l.name AS list_name, l.role FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.list_id = $1 AND m.jid = $2`, [listId, jid]);
    if (!m || m.stage !== 'date_given' || !m.visit_at) await syncVisit({ id: Number(listId), account_id: m?.account_id }, m || { jid, stage: null });
  }
  // follow-ups: every date set; cards whose person moved on (or got a visit date) are closed
  const fus = await query(
    `SELECT m.*, l.account_id, l.name AS list_name, l.role FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.followup_at IS NOT NULL`,
  );
  for (const v of fus) await syncFollowup({ id: v.list_id, account_id: v.account_id, name: v.list_name, role: v.role }, v);
  const openFu = await query(`SELECT ref FROM tasks WHERE ref LIKE 'followup:%' AND status NOT IN ('done','cancelled')`);
  for (const t of openFu) {
    const [, listId, jid] = t.ref.split(':');
    const [m] = await query(`SELECT followup_at FROM list_members WHERE list_id = $1 AND jid = $2`, [listId, jid]);
    if (!m?.followup_at) await closeRefTasks([t.ref], 'cancelled', 'follow-up date cleared');
  }
  const scheduled = await syncScheduled();
  const forgotten = await catchForgotten();
  // chat reminders
  const snoozed = await query(`SELECT account_id, jid, snoozed_until, snooze_note FROM chats WHERE state = 'snoozed' AND snoozed_until IS NOT NULL`);
  for (const c of snoozed) await syncReminder(c.account_id, c.jid, { state: 'snoozed', until: c.snoozed_until, note: c.snooze_note });
  const openRem = await query(`SELECT t.ref FROM tasks t WHERE t.ref LIKE 'remind:%' AND t.status NOT IN ('done','cancelled')`);
  for (const t of openRem) {
    const [, acc, jid] = t.ref.split(':');
    const [c] = await query(`SELECT state FROM chats WHERE account_id = $1 AND jid = $2`, [acc, jid]);
    if (c?.state !== 'snoozed') await closeRefTasks([t.ref], 'done', 'chat reopened');
  }
  const result = { replyCards: opened, visits: visits.length, followups: fus.length, scheduled, forgotten, reminders: snoozed.length };
  Object.assign(lastSync, { at: new Date().toISOString(), ok: true, error: null, result });
  return result;
}
