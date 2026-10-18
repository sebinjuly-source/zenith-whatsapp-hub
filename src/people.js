/**
 * One person across all your numbers: the same phone number may chat with the Hotel number and the
 * hiring number. This joins what each number knows about them, without mixing the stored data.
 */
import { query } from './db.js';
import { toJid } from './store.js';

export async function findPerson(phoneOrName) {
  const s = String(phoneOrName || '').trim();
  if (!s) throw new Error('Give a phone number or a name');
  const byPhone = /^[+\d\s()-]{8,}$/.test(s);
  const p = byPhone ? [toJid(s)] : [`%${s}%`];
  const rows = await query(
    `SELECT a.id AS account_id, a.label AS account_label, ct.jid, ct.phone,
            COALESCE(ct.name, ct.notify, ct.verified_name) AS name, ct.tags, ct.lead_status, ct.notes, ct.summary,
            ct.is_blocked, ch.last_ts, ch.last_from_me, ch.last_preview, ch.state, ch.snoozed_until,
            (SELECT count(*) FROM messages m WHERE m.account_id = ct.account_id AND m.chat_jid = ct.jid)::int AS messages,
            (SELECT min(ts) FROM messages m WHERE m.account_id = ct.account_id AND m.chat_jid = ct.jid) AS first_ts
     FROM contacts ct
     JOIN accounts a ON a.id = ct.account_id
     LEFT JOIN chats ch ON ch.account_id = ct.account_id AND ch.jid = ct.jid
     WHERE ${byPhone ? 'ct.jid = $1' : '(ct.name ILIKE $1 OR ct.notify ILIKE $1 OR ct.phone ILIKE $1)'}
     ORDER BY ch.last_ts DESC NULLS LAST
     LIMIT 40`,
    p,
  );
  return rows;
}
