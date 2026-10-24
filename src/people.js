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
  // a person is known by their saved contact, their chat name, or only by the name on a candidate list
  const rows = await query(
    `WITH who AS (
       SELECT account_id, jid FROM contacts WHERE ${byPhone ? 'jid = $1' : '(name ILIKE $1 OR notify ILIKE $1 OR saved_name ILIKE $1 OR phone ILIKE $1)'}
       UNION SELECT account_id, jid FROM chats WHERE ${byPhone ? 'jid = $1' : 'name ILIKE $1'}
       UNION SELECT l.account_id, m.jid FROM list_members m JOIN lists l ON l.id = m.list_id WHERE ${byPhone ? 'm.jid = $1' : 'm.name ILIKE $1'})
     SELECT a.id AS account_id, a.label AS account_label, w.jid, COALESCE(ct.phone, split_part(w.jid, '@', 1)) AS phone,
            COALESCE(ct.saved_name, ct.name, NULLIF(ch.name, ''), ct.notify, ct.verified_name,
                     (SELECT m.name FROM list_members m WHERE m.jid = w.jid AND COALESCE(m.name, '') <> '' LIMIT 1)) AS name,
            ct.tags, ct.lead_status, ct.notes, ct.summary,
            ct.is_blocked, ch.last_ts, ch.last_from_me, ch.last_preview, ch.state, ch.snoozed_until,
            (SELECT count(*) FROM messages m WHERE m.account_id = w.account_id AND m.chat_jid = w.jid)::int AS messages,
            (SELECT min(ts) FROM messages m WHERE m.account_id = w.account_id AND m.chat_jid = w.jid) AS first_ts
     FROM who w
     JOIN accounts a ON a.id = w.account_id
     LEFT JOIN contacts ct ON ct.account_id = w.account_id AND ct.jid = w.jid
     LEFT JOIN chats ch ON ch.account_id = w.account_id AND ch.jid = w.jid
     ORDER BY ch.last_ts DESC NULLS LAST
     LIMIT 40`,
    p,
  );
  return rows;
}
