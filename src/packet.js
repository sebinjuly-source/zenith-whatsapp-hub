// One person's "work packet" (8 Nov 2026): what the AI always needs before acting on someone — list row with stage and
// dates, messages already waiting for them, the last messages of the chat — in a few lines. Used by list_tasks(pack),
// inbox_summary(with_messages) and the AI job queue, so a person costs 2–3 turns instead of 5–7.
import { query } from './db.js';
import * as store from './store.js';
import config from './config.js';

const trim = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const fmtTs = (ts) => new Date(Number(ts) * 1000).toLocaleString('en-IN', { timeZone: config.tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (t) => (t ? fmtTs(Math.floor(new Date(t).getTime() / 1000)) : '-');
const msgLine = (m, maxLen) => {
  const who = m.from_me ? 'me' : m.sender_name || (m.sender_jid || '').split('@')[0] || 'them';
  let body = m.deleted ? '[deleted]' : trim(m.body, maxLen) || `[${m.type}]`;
  if (m.type !== 'text' && m.type !== 'contact' && m.body) body = `[${m.type}] ${body}`;
  if (m.has_media) body += ` (media id:${m.id}${m.media_saved ? ', saved' : ''} — open_file to see/read it)`;
  const q = m.quoted_body ? ` ↪"${trim(m.quoted_body, 50)}"` : '';
  return `[${fmtTs(m.ts)}] ${who}: ${body}${q}`;
};

/** Lines describing one person on one number: LIST …, WAITING …, CHAT … (NEW marks messages after `sinceTs`). */
export async function personPacket(accountId, jid, { messages = 8, sinceTs = null, indent = '    ' } = {}) {
  const out = [];
  const mem = await query(
    `SELECT l.name AS list, l.role, m.stage, m.visit_at, m.followup_at, m.followup_note, m.outcome, m.notes
     FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $1 AND l.archived IS NULL ORDER BY (l.account_id = $2) DESC, l.id DESC LIMIT 2`, [jid, accountId]);
  for (const m of mem) out.push(`${indent}LIST ${m.list}${m.role ? ` (${m.role})` : ''}: ${m.stage || 'no stage'}${m.visit_at ? ` · visit ${fmtDate(m.visit_at)}` : ''}${m.followup_at ? ` · follow-up ${fmtDate(m.followup_at)}` : ''}${m.followup_note ? ` · "${trim(m.followup_note, 80)}"` : ''}${m.outcome ? ` · outcome: ${trim(m.outcome, 60)}` : ''}${m.notes ? ` · notes: ${trim(m.notes, 120)}` : ''}`);
  const waiting = await query(`SELECT id, account_id, status, scheduled_at, left(COALESCE(payload->>'text', payload->'waTemplate'->>'name', '[file]'), 140) AS text FROM outbox
    WHERE to_jid = $1 AND status IN ('draft','queued','sending') ORDER BY id DESC LIMIT 3`, [jid]);
  for (const o of waiting) out.push(`${indent}WAITING #${o.id} ${o.status} on ${o.account_id}${o.scheduled_at && new Date(o.scheduled_at) > new Date() ? ` for ${fmtDate(o.scheduled_at)}` : ''}: "${trim(o.text, 140)}" — change it with edit_messages, never a second draft`);
  const rows = await store.getMessages(accountId, jid, { limit: messages });
  if (!rows.length) out.push(`${indent}CHAT on ${accountId}: no messages yet`);
  else out.push(`${indent}CHAT on ${accountId} (last ${rows.length}):`, ...rows.map((m) => `${indent}  ${sinceTs && !m.from_me && Number(m.ts) > sinceTs ? 'NEW ' : ''}${msgLine(m, 220)}`));
  return out;
}

/** Every open Board card about this person (the owner's and the AI's), one line each with the latest note. */
export async function openCardLines(accountId, jid, { indent = '    ' } = {}) {
  const phone = jid.split('@')[0];
  const cards = await query(
    `SELECT t.id, t.title, t.status, t.assignee, t.priority, t.due_at, t.details,
       (SELECT l.text FROM task_log l WHERE l.task_id = t.id AND l.kind = 'note' ORDER BY l.id DESC LIMIT 1) AS last_note,
       (SELECT l.actor FROM task_log l WHERE l.task_id = t.id AND l.kind = 'note' ORDER BY l.id DESC LIMIT 1) AS note_by
     FROM tasks t WHERE t.status NOT IN ('done','cancelled')
       AND (t.ref LIKE '%:' || $1 OR t.title LIKE '%' || $2 || '%' OR t.details LIKE '%' || $2 || '%')
     ORDER BY t.priority DESC, t.due_at NULLS LAST LIMIT 8`, [jid, phone.slice(-10)]);
  return cards.map((c) => `${indent}CARD #${c.id} ${c.status === 'review' ? 'OWNER MARKED DONE — REVIEW' : c.status}${c.priority ? ' PRIORITY' : ''} for ${c.assignee === 'ai' ? 'AI' : 'owner'} | ${trim(c.title, 90)}${c.due_at ? ` | due ${fmtDate(c.due_at)}` : ''}${c.last_note ? ` | latest note (${c.note_by === 'you' ? 'OWNER' : c.note_by}): "${trim(c.last_note, 160)}"` : ''}`);
}
