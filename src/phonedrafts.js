/**
 * Drafts on the phone (31 Oct): an immediate reply the AI drafts on a linked number (e.g. Seema's) also reaches that
 * phone, so the person holding it can send it straight away — the owner can still approve or reject it in the hub.
 *  - A note goes to the number's own "Message yourself" chat (pinned): who it is for, the text, and a wa.me link that
 *    opens their chat with the text already typed. WhatsApp keeps unsent typing on each device only, so no linked
 *    device can put text into the phone's typing box itself; the link is the closest (one tap).
 *  - Their chat is marked unread on the phone so it stands out.
 * Kept in step every minute (on the server holding the number):
 *  - sent from the phone (any message of ours in that chat after the note that the hub did not send) → the hub draft
 *    is closed "answered on the phone" and the note removed;
 *  - the note deleted on the phone → the draft is rejected ("dropped on the phone");
 *  - approved or rejected in the hub → the note is removed from the phone.
 * Only replies to someone who wrote to that number in the last 24 h, due now (not scheduled), single messages the AI
 * drafted (not bulk sends). Settings (config 'phone_drafts'): { enabled, accounts: [ids], campaigns: [names, empty = all] }.
 */
import { query, logEvent } from './db.js';

const DEFAULTS = { enabled: true, accounts: [], campaigns: [] };
const pinned = new Set(); // self-chats pinned by this server

export async function getPhoneDrafts() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'phone_drafts'`).catch(() => []);
  const v = r?.value || {};
  return {
    enabled: v.enabled !== undefined ? v.enabled !== false : DEFAULTS.enabled,
    accounts: Array.isArray(v.accounts) ? v.accounts.map(String) : DEFAULTS.accounts,
    campaigns: Array.isArray(v.campaigns) ? v.campaigns.map(String).filter(Boolean) : DEFAULTS.campaigns,
  };
}

export async function setPhoneDrafts({ enabled, accounts, campaigns } = {}) {
  const cur = await getPhoneDrafts();
  const next = {
    enabled: enabled === undefined ? cur.enabled : !!enabled,
    accounts: Array.isArray(accounts) ? [...new Set(accounts.map(String).filter(Boolean))] : cur.accounts,
    campaigns: Array.isArray(campaigns) ? [...new Set(campaigns.map(String).filter(Boolean))] : cur.campaigns,
  };
  await query(
    `INSERT INTO config (key, value) VALUES ('phone_drafts', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

const selfJid = (s) => (s.account?.phone ? `${s.account.phone}@s.whatsapp.net` : null);
const phoneOf = (jid) => String(jid).split('@')[0];

/** Does this draft go to the phone too? */
async function qualifies(row, s, cfg) {
  if (!cfg.enabled || !cfg.accounts.includes(row.account_id)) return false;
  if (s.isCloud || !selfJid(s) || row.status !== 'draft' || row.source !== 'mcp') return false;
  if (!row.payload?.text || String(row.to_jid).endsWith('@g.us') || row.to_jid === selfJid(s)) return false;
  if (new Date(row.scheduled_at || Date.now()) > new Date(Date.now() + 5 * 60000)) return false; // scheduled for later
  if (cfg.campaigns.length && !cfg.campaigns.includes(row.role || 'none')) return false;
  const [recent] = await query(
    `SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me AND ts > extract(epoch FROM now())::bigint - 86400 LIMIT 1`,
    [row.account_id, row.to_jid],
  );
  return !!recent;
}

/** Put one draft on the phone (once). Quietly does nothing when this server doesn't hold the number. */
export async function offer(row, manager) {
  if (!row || row.status !== 'draft') return false;
  const s = manager.sessions.get(row.account_id);
  if (!s?.sock || s.status !== 'open') return false;
  const cfg = await getPhoneDrafts();
  if (!(await qualifies(row, s, cfg))) return false;
  const [claim] = await query(
    `INSERT INTO phone_drafts (outbox_id, account_id, to_jid) VALUES ($1,$2,$3) ON CONFLICT (outbox_id) DO NOTHING RETURNING outbox_id`,
    [row.id, row.account_id, row.to_jid],
  );
  if (!claim) return false; // another server or an earlier run did it
  const [who] = await query(
    `SELECT COALESCE(NULLIF(ch.name,''), ct.name, ct.notify) AS name FROM (SELECT 1) x
     LEFT JOIN chats ch ON ch.account_id = $1 AND ch.jid = $2 LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $2`,
    [row.account_id, row.to_jid],
  );
  const phone = phoneOf(row.to_jid);
  const text = row.payload.text;
  const note = `📝 *Draft reply* for ${who?.name || '+' + phone} (+${phone})\n\n${text}\n\n`
    + `👉 Tap to open the chat with this already typed: https://wa.me/${phone}?text=${encodeURIComponent(text)}\n`
    + `${row.payload.attachment ? '📎 It has a file too — send that one from the hub (Drafts).\n' : ''}`
    + 'Send it, change it, or ignore it. Delete this note (for everyone) to drop the draft. — Zenith Hub';
  try {
    const self = selfJid(s);
    const sent = await s.send(self, { text: note });
    await query(`UPDATE phone_drafts SET note_id = $2 WHERE outbox_id = $1`, [row.id, sent?.key?.id || null]);
    if (!pinned.has(self)) {
      pinned.add(self);
      await s.sock.chatModify({ pin: true }, self).catch(() => {});
    }
    const [last] = await query(`SELECT id, from_me, ts FROM messages WHERE account_id = $1 AND chat_jid = $2 ORDER BY ts DESC LIMIT 1`, [row.account_id, row.to_jid]);
    if (last) {
      await s.sock.chatModify({ markRead: false, lastMessages: [{ key: { remoteJid: row.to_jid, id: last.id, fromMe: last.from_me }, messageTimestamp: Number(last.ts) }] }, row.to_jid).catch(() => {});
    }
    return true;
  } catch (err) {
    await query(`DELETE FROM phone_drafts WHERE outbox_id = $1`, [row.id]); // try again next minute
    await logEvent(row.account_id, 'warn', `Could not put draft #${row.id} on the phone: ${err.message}`);
    return false;
  }
}

async function removeNote(s, pd) {
  const self = selfJid(s);
  if (pd.note_id && s.sock) await s.sock.sendMessage(self, { delete: { remoteJid: self, fromMe: true, id: pd.note_id } }).catch(() => {});
  if (pd.note_id) await query(`UPDATE messages SET deleted = true WHERE account_id = $1 AND id = $2`, [pd.account_id, pd.note_id]).catch(() => {});
}

async function close(pd, outcome) {
  await query(`UPDATE phone_drafts SET closed_at = now(), outcome = $2 WHERE outbox_id = $1`, [pd.outbox_id, outcome]);
}

/** Every minute: offer new drafts, and keep the phone and the hub in step. Returns what changed. */
export async function syncPhoneDrafts(manager) {
  const cfg = await getPhoneDrafts();
  const out = { offered: 0, answered: 0, dropped: 0, removed: 0 };
  // drafts that should be on a phone held here
  if (cfg.enabled && cfg.accounts.length) {
    const rows = await query(
      `SELECT o.* FROM outbox o WHERE o.status = 'draft' AND o.source = 'mcp' AND o.account_id = ANY($1::text[])
         AND o.created_at > now() - interval '6 hours' AND NOT EXISTS (SELECT 1 FROM phone_drafts p WHERE p.outbox_id = o.id)
       ORDER BY o.id LIMIT 30`,
      [cfg.accounts],
    );
    for (const r of rows) if (await offer(r, manager)) out.offered++;
  }
  const open = await query(
    `SELECT p.*, o.status, o.message_id AS sent_id, n.deleted AS note_deleted
     FROM phone_drafts p JOIN outbox o ON o.id = p.outbox_id
     LEFT JOIN messages n ON n.account_id = p.account_id AND n.id = p.note_id
     WHERE p.closed_at IS NULL`,
  );
  for (const pd of open) {
    const s = manager.sessions.get(pd.account_id);
    if (!s?.sock || s.status !== 'open') continue;
    if (pd.status !== 'draft') {
      // approved (sent / queued) or rejected in the hub → take the note off the phone
      await removeNote(s, pd);
      await close(pd, `hub: ${pd.status}`);
      out.removed++;
      continue;
    }
    if (pd.note_deleted) {
      const [r] = await query(`UPDATE outbox SET status = 'rejected', error = 'Rejected: dropped on the phone (note deleted)' WHERE id = $1 AND status = 'draft' RETURNING id`, [pd.outbox_id]);
      await close(pd, 'phone: dropped');
      if (r) await logEvent(pd.account_id, 'info', `Draft #${pd.outbox_id} to ${phoneOf(pd.to_jid)} dropped on the phone`);
      out.dropped++;
      continue;
    }
    // something of ours went to them after the note that the hub did not send → answered on the phone
    const [mine] = await query(
      `SELECT m.id FROM messages m WHERE m.account_id = $1 AND m.chat_jid = $2 AND m.from_me AND m.ts >= extract(epoch FROM $3::timestamptz)::bigint
         AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.account_id = m.account_id AND x.message_id = m.id) LIMIT 1`,
      [pd.account_id, pd.to_jid, pd.created_at],
    );
    if (mine) {
      const [r] = await query(`UPDATE outbox SET status = 'rejected', error = 'Answered on the phone' WHERE id = $1 AND status = 'draft' RETURNING id`, [pd.outbox_id]);
      await removeNote(s, pd);
      await close(pd, 'phone: answered');
      if (r) await logEvent(pd.account_id, 'info', `Draft #${pd.outbox_id} to ${phoneOf(pd.to_jid)} — answered on the phone`);
      out.answered++;
    }
  }
  return out;
}
