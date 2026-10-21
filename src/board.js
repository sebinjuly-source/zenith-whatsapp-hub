/**
 * Board cards the hub keeps in step by itself, so nothing waits unseen:
 *  - "Reply to X"  — a candidate on a list wrote and nobody has answered yet (closes when any reply goes out)
 *  - "Visit: X"    — a visit date is set (due at the visit; done when they're marked visited, gone if cleared)
 *  - "Reminder"    — a chat snoozed with "Remind me" (due on that date; closes when the chat is reopened/done)
 * Updated instantly on each event, and re-checked every 10 minutes (syncBoard) so a missed event can't hide anything.
 */
import { query } from './db.js';
import { upsertRefTask, closeRefTasks } from './tasks.js';
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
    account: accountId, kind: 'reply', role: m.role, dueAt: new Date(Number(last.ts) * 1000).toISOString(),
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

/** We sent something in these chats: their "Reply to …" cards are done. */
export async function noteSent(accountId, jids) {
  const refs = [...new Set(jids)].map((j) => `reply:${accountId}:${j}`);
  return closeRefTasks(refs, 'done');
}

/** Visit card for one person (called when a visit date or stage changes). */
export async function syncVisit(list, m) {
  const ref = `visit:${list.id}:${m.jid}`;
  if (m.stage === 'date_given' && m.visit_at) {
    return upsertRefTask(ref, {
      account: list.account_id, kind: 'visit', role: list.role, dueAt: new Date(m.visit_at).toISOString(),
      title: `Visit: ${m.name || phone(m.jid)} — ${when(m.visit_at)}`,
      details: `${list.name} · +${phone(m.jid)}${m.notes ? ` · ${m.notes}` : ''}. Afterwards set the stage (visited / trial / no_show).`,
    });
  }
  const done = ['visited', 'trial', 'selected', 'joined'].includes(m.stage);
  return closeRefTasks([ref], done ? 'done' : 'cancelled');
}

/** Chat reminder card (Remind me). */
export async function syncReminder(accountId, jid, { state, until, note } = {}) {
  const ref = `remind:${accountId}:${jid}`;
  if (state !== 'snoozed' || !until) return closeRefTasks([ref], 'done');
  const [c] = await query(
    `SELECT COALESCE(NULLIF(ch.name,''), ct.name, ct.notify, $2) AS name FROM (SELECT 1) x
     LEFT JOIN chats ch ON ch.account_id = $1 AND ch.jid = $3 LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $3`,
    [accountId, phone(jid), jid],
  );
  return upsertRefTask(ref, {
    account: accountId, kind: 'reminder', dueAt: new Date(until).toISOString(),
    title: `Reminder: ${c?.name || phone(jid)}${note ? ` — ${note}` : ''}`,
    details: `Chat +${phone(jid)} comes back to the inbox on ${when(until)}.`,
  });
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
      await closeRefTasks([`reply:${l.account_id}:${l.chat_jid}`], 'done');
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
  // chat reminders
  const snoozed = await query(`SELECT account_id, jid, snoozed_until, snooze_note FROM chats WHERE state = 'snoozed' AND snoozed_until IS NOT NULL`);
  for (const c of snoozed) await syncReminder(c.account_id, c.jid, { state: 'snoozed', until: c.snoozed_until, note: c.snooze_note });
  const openRem = await query(`SELECT t.ref FROM tasks t WHERE t.ref LIKE 'remind:%' AND t.status NOT IN ('done','cancelled')`);
  for (const t of openRem) {
    const [, acc, jid] = t.ref.split(':');
    const [c] = await query(`SELECT state FROM chats WHERE account_id = $1 AND jid = $2`, [acc, jid]);
    if (c?.state !== 'snoozed') await closeRefTasks([t.ref], 'done');
  }
  return { replyCards: opened, visits: visits.length, reminders: snoozed.length };
}
