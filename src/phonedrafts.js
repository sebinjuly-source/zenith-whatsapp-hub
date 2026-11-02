/**
 * Drafts on the phone (31 Oct): an immediate reply the AI drafts on a linked number (e.g. Seema's) also reaches that
 * phone, so the person holding it can send it straight away — the owner can still approve or reject it in the hub.
 *  - A note goes to the number's own "Message yourself" chat, and the NOTE ITSELF is pinned there (7 days; 2 Nov — pinning
 *    only the chat showed nothing): who it is for, the text, and a wa.me link that
 *    opens their chat with the text already typed. WhatsApp keeps unsent typing on each device only, so no linked
 *    device can put text into the phone's typing box itself; the link is the closest (one tap).
 *  - Their chat is marked unread on the phone and put in the phone's "Draft waiting" list (a WhatsApp label; setting
 *    'label', '' = off) until the draft is handled, so the person can filter to it. Every step that fails is said
 *    in Activity (once per 6 h) — it was silent before 2 Nov.
 * Kept in step every minute (on the server holding the number):
 *  - sent from the phone (any message of ours in that chat after the note that the hub did not send) → the hub draft
 *    is closed "answered on the phone" and the note removed;
 *  - the note deleted on the phone → the draft is rejected ("dropped on the phone");
 *  - approved or rejected in the hub → the note is removed from the phone.
 * Only replies to someone who wrote to that number in the last 24 h, due now (not scheduled), single messages the AI
 * drafted (not bulk sends). Settings (config 'phone_drafts'): { enabled, accounts: [ids], campaigns: [names, empty = all] }.
 */
import { query, logEvent } from './db.js';

const DEFAULTS = { enabled: true, accounts: [], campaigns: [], label: 'Draft waiting' };
const pinnedChats = new Set(); // self-chats this server pinned to the top (only on success, so a failure is retried)
const warned = new Map(); // account:what → last warning time (one warning per 6 h, not one a minute)

/** A phone step that failed: say so in Activity (once per 6 h per number and step) instead of failing silently. */
async function warnOnce(accountId, what, err) {
  const k = `${accountId}:${what}`;
  if (Date.now() - (warned.get(k) || 0) < 6 * 3600e3) return;
  warned.set(k, Date.now());
  await logEvent(accountId, 'warn', `Drafts on the phone: could not ${what} — ${err?.message || err}`).catch(() => {});
}

export async function getPhoneDrafts() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'phone_drafts'`).catch(() => []);
  const v = r?.value || {};
  return {
    enabled: v.enabled !== undefined ? v.enabled !== false : DEFAULTS.enabled,
    accounts: Array.isArray(v.accounts) ? v.accounts.map(String) : DEFAULTS.accounts,
    campaigns: Array.isArray(v.campaigns) ? v.campaigns.map(String).filter(Boolean) : DEFAULTS.campaigns,
    label: typeof v.label === 'string' ? v.label.trim() : DEFAULTS.label, // '' = don't put chats in a list
  };
}

export async function setPhoneDrafts({ enabled, accounts, campaigns, label } = {}) {
  const cur = await getPhoneDrafts();
  const next = {
    enabled: enabled === undefined ? cur.enabled : !!enabled,
    accounts: Array.isArray(accounts) ? [...new Set(accounts.map(String).filter(Boolean))] : cur.accounts,
    campaigns: Array.isArray(campaigns) ? [...new Set(campaigns.map(String).filter(Boolean))] : cur.campaigns,
    label: typeof label === 'string' ? label.trim() : cur.label,
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
  // the name on their list (what they call themselves) beats a WhatsApp profile name like "Trader 📈☝️"; the campaign
  // tells the person holding the phone at a glance whether it is a guest or a candidate
  const [who] = await query(
    `SELECT COALESCE(NULLIF(lm.name,''), NULLIF(ch.name,''), ct.name, ct.notify) AS name, lm.role FROM (SELECT 1) x
     LEFT JOIN LATERAL (SELECT m.name, l.role FROM list_members m JOIN lists l ON l.id = m.list_id
       WHERE m.jid = $2 AND l.account_id = $1 ORDER BY m.updated_at DESC NULLS LAST LIMIT 1) lm ON TRUE
     LEFT JOIN chats ch ON ch.account_id = $1 AND ch.jid = $2 LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $2`,
    [row.account_id, row.to_jid],
  );
  const phone = phoneOf(row.to_jid);
  const text = row.payload.text;
  const note = `📝 *Draft reply* for ${who?.name || '+' + phone} (+${phone})${who?.role ? ` · ${who.role}` : ''}\n\n${text}\n\n`
    + `👉 Tap to open the chat with this already typed: https://wa.me/${phone}?text=${encodeURIComponent(text)}\n`
    + `${row.payload.attachment ? '📎 It has a file too — send that one from the hub (Drafts).\n' : ''}`
    + 'Send it, change it, or ignore it. Delete this note (for everyone) to drop the draft. — Zenith Hub';
  const self = selfJid(s);
  let noteId;
  try {
    const sent = await s.send(self, { text: note });
    noteId = sent?.key?.id || null;
    await query(`UPDATE phone_drafts SET note_id = $2 WHERE outbox_id = $1`, [row.id, noteId]);
  } catch (err) {
    await query(`DELETE FROM phone_drafts WHERE outbox_id = $1`, [row.id]); // try again next minute
    await logEvent(row.account_id, 'warn', `Could not put draft #${row.id} on the phone: ${err.message}`);
    return false;
  }
  // The note is delivered; the rest makes it stand out. Each step reports its own failure (31 Oct–2 Nov these were
  // silent, and only the chat — not the note — was pinned, so the owner saw a plain message with a link).
  if (noteId) await pinNote(s, { outbox_id: row.id, account_id: row.account_id, note_id: noteId, pin_tries: 0 });
  if (!pinnedChats.has(self)) {
    try {
      await s.phoneAction('pin_chat', { jid: self });
      pinnedChats.add(self);
    } catch (err) {
      await warnOnce(row.account_id, 'pin "Message yourself" to the top', err);
    }
  }
  if (cfg.label) {
    try {
      await s.phoneAction('label_chat', { jid: row.to_jid, label: cfg.label });
      await query(`UPDATE phone_drafts SET labeled = true WHERE outbox_id = $1`, [row.id]);
    } catch (err) {
      await warnOnce(row.account_id, `put the chat in the "${cfg.label}" list`, err);
    }
  }
  try {
    await s.phoneAction('mark_unread', { jid: row.to_jid });
  } catch (err) {
    await warnOnce(row.account_id, 'mark their chat unread', err);
  }
  return true;
}

/** Pin the note in "Message yourself" for 7 days (WhatsApp shows up to 3 pins at the top of a chat). */
async function pinNote(s, pd) {
  try {
    await s.phoneAction('pin_message', { jid: selfJid(s), messageId: pd.note_id, fromMe: true, days: 7 });
    await query(`UPDATE phone_drafts SET pinned = true, pin_tries = pin_tries + 1 WHERE outbox_id = $1`, [pd.outbox_id]);
    return true;
  } catch (err) {
    await query(`UPDATE phone_drafts SET pin_tries = pin_tries + 1 WHERE outbox_id = $1`, [pd.outbox_id]);
    await warnOnce(pd.account_id, 'pin the draft note', err);
    return false;
  }
}

/** Take the chat out of the "Draft waiting" list once no draft for it is open on the phone any more. */
async function unlabel(s, pd) {
  if (!pd.labeled) return;
  const cfg = await getPhoneDrafts();
  const [other] = await query(
    `SELECT 1 FROM phone_drafts WHERE account_id = $1 AND to_jid = $2 AND closed_at IS NULL AND outbox_id <> $3 LIMIT 1`,
    [pd.account_id, pd.to_jid, pd.outbox_id],
  );
  if (other || !cfg.label) return;
  await s.phoneAction('unlabel_chat', { jid: pd.to_jid, label: cfg.label }).catch((err) => warnOnce(pd.account_id, `take the chat out of the "${cfg.label}" list`, err));
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
  const out = { offered: 0, answered: 0, dropped: 0, removed: 0, pinned: 0 };
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
      await unlabel(s, pd);
      out.removed++;
      continue;
    }
    if (pd.note_deleted) {
      const [r] = await query(`UPDATE outbox SET status = 'rejected', error = 'Rejected: dropped on the phone (note deleted)' WHERE id = $1 AND status = 'draft' RETURNING id`, [pd.outbox_id]);
      await close(pd, 'phone: dropped');
      await unlabel(s, pd);
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
      await unlabel(s, pd);
      if (r) await logEvent(pd.account_id, 'info', `Draft #${pd.outbox_id} to ${phoneOf(pd.to_jid)} — answered on the phone`);
      out.answered++;
      continue;
    }
    // still open: a pin that failed (phone offline, a hiccup) is tried again — 3 times, then the warning stands
    if (pd.note_id && !pd.pinned && pd.pin_tries < 3 && (await pinNote(s, pd))) out.pinned++;
    // and a chat not yet in the list (older drafts, or the step failed) — at most once per 6 h while it keeps failing
    const lbl = cfg.label;
    if (lbl && !pd.labeled && Date.now() - (warned.get(`${pd.account_id}:put the chat in the "${lbl}" list`) || 0) > 6 * 3600e3) {
      try {
        await s.phoneAction('label_chat', { jid: pd.to_jid, label: lbl });
        await query(`UPDATE phone_drafts SET labeled = true WHERE outbox_id = $1`, [pd.outbox_id]);
      } catch (err) {
        await warnOnce(pd.account_id, `put the chat in the "${lbl}" list`, err);
      }
    }
  }
  return out;
}
