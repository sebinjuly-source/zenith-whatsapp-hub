/**
 * Drafts on the phone (31 Oct): a reply the AI drafts on a linked number (e.g. Seema's) also reaches that phone, so the
 * person holding it can send it straight away — the owner can still approve or reject it in the hub.
 *  - ONE note in the number's own "Message yourself" chat lists every draft waiting, one short line each: who it is for
 *    and a short hub link (/d/<token>) that opens their chat with the reply already typed (2 Nov, owner: "no need to
 *    message everybody's draft and a super long link" — the full text and the long wa.me link made the note unreadable).
 *    The note is replaced whenever the list changes and is pinned (7 days). WhatsApp keeps unsent typing on each device
 *    only, so no linked device can put text into the phone's typing box itself; the link is the closest (one tap).
 *    Real tap buttons need the official API (Meta number) — a linked number's button messages don't show on phones.
 *  - Their chat is marked unread on the phone and put in the phone's "Draft waiting" list (a WhatsApp label; setting
 *    'label', '' = off) until the draft is handled. Every step that fails is said in Activity (once per 6 h).
 * Kept in step every minute (on the server holding the number):
 *  - sent from the phone (any message of ours in that chat after the draft that the hub did not send) → the hub draft
 *    is closed "answered on the phone";
 *  - approved or rejected in the hub → it leaves the note.
 * Which drafts: single messages the AI drafted (not bulk sends), due now (not scheduled), to someone who has written to
 * that number before — 2 Nov: "written in the last 24 h" left out Rajesh's reply drafted two days after his message.
 * Settings (config 'phone_drafts'): { enabled, accounts: [ids], campaigns: [names, empty = all], label }.
 */
import crypto from 'crypto';
import { query, logEvent } from './db.js';
import config from './config.js';

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
const linkOf = (token) => `${config.publicUrl || ''}/d/${token}`;

/** Does this draft go to the phone too? */
async function qualifies(row, s, cfg) {
  if (!cfg.enabled || !cfg.accounts.includes(row.account_id)) return false;
  if (s.isCloud || !selfJid(s) || row.status !== 'draft' || row.source !== 'mcp') return false;
  if (!row.payload?.text || String(row.to_jid).endsWith('@g.us') || row.to_jid === selfJid(s)) return false;
  if (new Date(row.scheduled_at || Date.now()) > new Date(Date.now() + 5 * 60000)) return false; // scheduled for later
  if (cfg.campaigns.length && !cfg.campaigns.includes(row.role || 'none')) return false;
  // someone who has written to this number (not a first message to a stranger)
  const [wrote] = await query(
    `SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me LIMIT 1`,
    [row.account_id, row.to_jid],
  );
  return !!wrote;
}

/** The short link /d/<token>: where it leads (their chat with the reply typed), or null once the draft is handled. */
export async function draftLinkTarget(token) {
  if (!/^[0-9a-f]{16}$/.test(String(token))) return null;
  const [r] = await query(
    `SELECT o.to_jid, o.payload FROM phone_drafts p JOIN outbox o ON o.id = p.outbox_id
     WHERE p.token = $1 AND p.closed_at IS NULL AND o.status = 'draft'`,
    [token],
  );
  if (!r) return null;
  return `https://wa.me/${phoneOf(r.to_jid)}?text=${encodeURIComponent(r.payload?.text || '')}`;
}

/** Put one draft on the phone (once). Quietly does nothing when this server doesn't hold the number. */
export async function offer(row, manager) {
  if (!row || row.status !== 'draft') return false;
  const s = manager.sessions.get(row.account_id);
  if (!s?.sock || s.status !== 'open') return false;
  const cfg = await getPhoneDrafts();
  if (!(await qualifies(row, s, cfg))) return false;
  const [claim] = await query(
    `INSERT INTO phone_drafts (outbox_id, account_id, to_jid, token) VALUES ($1,$2,$3,$4) ON CONFLICT (outbox_id) DO NOTHING RETURNING outbox_id`,
    [row.id, row.account_id, row.to_jid, crypto.randomBytes(8).toString('hex')],
  );
  if (!claim) return false; // another server or an earlier run did it
  if (!(await refreshNote(s))) {
    await query(`DELETE FROM phone_drafts WHERE outbox_id = $1`, [row.id]); // try again next minute
    return false;
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

/**
 * The one note listing every open draft of this number: sent again (old one deleted) only when the list changed.
 * Its id is kept on the open rows (note_id). Returns false when the note could not be sent.
 */
async function refreshNote(s) {
  const accountId = s.account.id;
  const open = await query(
    `SELECT p.outbox_id, p.to_jid, p.token, p.note_id, o.role,
       COALESCE(NULLIF(lm.name,''), NULLIF(ch.name,''), ct.name, ct.notify) AS name
     FROM phone_drafts p JOIN outbox o ON o.id = p.outbox_id
     LEFT JOIN LATERAL (SELECT m.name FROM list_members m JOIN lists l ON l.id = m.list_id
       WHERE m.jid = p.to_jid AND l.account_id = p.account_id ORDER BY m.updated_at DESC NULLS LAST LIMIT 1) lm ON TRUE
     LEFT JOIN chats ch ON ch.account_id = p.account_id AND ch.jid = p.to_jid
     LEFT JOIN contacts ct ON ct.account_id = p.account_id AND ct.jid = p.to_jid
     WHERE p.account_id = $1 AND p.closed_at IS NULL AND o.status = 'draft' ORDER BY p.outbox_id`,
    [accountId],
  );
  // notes still on the phone: of open drafts, and of handled ones whose note was not taken down yet
  const held = await query(`SELECT note_id, bool_or(closed_at IS NOT NULL) AS handled FROM phone_drafts
    WHERE account_id = $1 AND note_id IS NOT NULL GROUP BY note_id`, [accountId]);
  const ids = held.map((r) => r.note_id);
  // unchanged: every open draft is on the one current note, it lists no handled draft, and no other note is left
  if (open.length && ids.length === 1 && !held[0].handled && open.every((r) => r.note_id === ids[0])) return true;
  const self = selfJid(s);
  for (const id of ids) await removeNote(s, accountId, id);
  await query(`UPDATE phone_drafts SET note_id = NULL WHERE account_id = $1 AND closed_at IS NOT NULL AND note_id IS NOT NULL`, [accountId]);
  if (!open.length) return true;
  for (const r of open.filter((x) => !x.token)) { // drafts put on the phone before the short links
    r.token = crypto.randomBytes(8).toString('hex');
    await query(`UPDATE phone_drafts SET token = $2 WHERE outbox_id = $1`, [r.outbox_id, r.token]);
  }
  // the name on their list (what they call themselves) beats a WhatsApp profile name; the campaign tells the person
  // holding the phone at a glance whether it is a guest or a candidate
  const lines = open.map((r, i) => `${i + 1}. *${r.name || '+' + phoneOf(r.to_jid)}*${r.role ? ` · ${r.role}` : ''}\n👉 ${linkOf(r.token)}`);
  const text = `📝 *${open.length === 1 ? '1 reply' : `${open.length} replies`} waiting* — tap a link: their chat opens with the reply typed. Change it if you like, then send.\n\n`
    + `${lines.join('\n\n')}\n\nNot sending one? Ignore it — the owner sees it in the hub. — Zenith Hub`;
  let noteId;
  try {
    const sent = await s.send(self, { text });
    noteId = sent?.key?.id || null;
  } catch (err) {
    await logEvent(accountId, 'warn', `Could not put the drafts note on the phone: ${err.message}`).catch(() => {});
    return false;
  }
  await query(`UPDATE phone_drafts SET note_id = $2, pinned = false, pin_tries = 0 WHERE outbox_id = ANY($1::bigint[])`,
    [open.map((r) => r.outbox_id), noteId]);
  if (noteId) await pinNote(s, accountId, noteId);
  if (!pinnedChats.has(self)) {
    try {
      await s.phoneAction('pin_chat', { jid: self });
      pinnedChats.add(self);
    } catch (err) {
      await warnOnce(accountId, 'pin "Message yourself" to the top', err);
    }
  }
  return true;
}

/** Pin the note in "Message yourself" for 7 days (WhatsApp shows up to 3 pins at the top of a chat). */
async function pinNote(s, accountId, noteId) {
  try {
    await s.phoneAction('pin_message', { jid: selfJid(s), messageId: noteId, fromMe: true, days: 7 });
    await query(`UPDATE phone_drafts SET pinned = true, pin_tries = pin_tries + 1 WHERE account_id = $1 AND note_id = $2`, [accountId, noteId]);
    return true;
  } catch (err) {
    await query(`UPDATE phone_drafts SET pin_tries = pin_tries + 1 WHERE account_id = $1 AND note_id = $2`, [accountId, noteId]);
    await warnOnce(accountId, 'pin the drafts note', err);
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

async function removeNote(s, accountId, noteId) {
  const self = selfJid(s);
  if (noteId && s.sock) await s.sock.sendMessage(self, { delete: { remoteJid: self, fromMe: true, id: noteId } }).catch(() => {});
  if (noteId) await query(`UPDATE messages SET deleted = true WHERE account_id = $1 AND id = $2`, [accountId, noteId]).catch(() => {});
}

async function close(pd, outcome) {
  await query(`UPDATE phone_drafts SET closed_at = now(), outcome = $2 WHERE outbox_id = $1`, [pd.outbox_id, outcome]);
}

/** Every minute: offer new drafts, and keep the phone and the hub in step. Returns what changed. */
export async function syncPhoneDrafts(manager) {
  const cfg = await getPhoneDrafts();
  const out = { offered: 0, answered: 0, removed: 0, pinned: 0 };
  // drafts that should be on a phone held here (3 days: a draft for an older chat waits for the owner longer)
  if (cfg.enabled && cfg.accounts.length) {
    const rows = await query(
      `SELECT o.* FROM outbox o WHERE o.status = 'draft' AND o.source = 'mcp' AND o.account_id = ANY($1::text[])
         AND o.created_at > now() - interval '3 days' AND NOT EXISTS (SELECT 1 FROM phone_drafts p WHERE p.outbox_id = o.id)
       ORDER BY o.id LIMIT 30`,
      [cfg.accounts],
    );
    for (const r of rows) if (await offer(r, manager)) out.offered++;
  }
  const open = await query(
    `SELECT p.*, o.status FROM phone_drafts p JOIN outbox o ON o.id = p.outbox_id WHERE p.closed_at IS NULL`,
  );
  const touched = new Set();
  for (const pd of open) {
    const s = manager.sessions.get(pd.account_id);
    if (!s?.sock || s.status !== 'open') continue;
    if (pd.status !== 'draft') {
      // approved (sent / queued) or rejected in the hub → off the note
      await close(pd, `hub: ${pd.status}`);
      await unlabel(s, pd);
      touched.add(pd.account_id);
      out.removed++;
      continue;
    }
    // something of ours went to them after the draft that the hub did not send → answered on the phone
    const [mine] = await query(
      `SELECT m.id FROM messages m WHERE m.account_id = $1 AND m.chat_jid = $2 AND m.from_me AND m.ts >= extract(epoch FROM $3::timestamptz)::bigint
         AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.account_id = m.account_id AND x.message_id = m.id) LIMIT 1`,
      [pd.account_id, pd.to_jid, pd.created_at],
    );
    if (mine) {
      const [r] = await query(`UPDATE outbox SET status = 'rejected', error = 'Answered on the phone' WHERE id = $1 AND status = 'draft' RETURNING id`, [pd.outbox_id]);
      await close(pd, 'phone: answered');
      await unlabel(s, pd);
      touched.add(pd.account_id);
      if (r) await logEvent(pd.account_id, 'info', `Draft #${pd.outbox_id} to ${phoneOf(pd.to_jid)} — answered on the phone`);
      out.answered++;
      continue;
    }
    // still open: a pin that failed (phone offline, a hiccup) is tried again — 3 times, then the warning stands
    if (pd.note_id && !pd.pinned && pd.pin_tries < 3 && !touched.has(`pin:${pd.note_id}`)) {
      touched.add(`pin:${pd.note_id}`);
      if (await pinNote(s, pd.account_id, pd.note_id)) out.pinned++;
    }
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
  // a draft left the list → the note is sent again without it (or removed when nothing is left)
  for (const id of touched) {
    if (id.startsWith('pin:')) continue;
    const s = manager.sessions.get(id);
    if (s) await refreshNote(s).catch((err) => warnOnce(id, 'update the drafts note', err));
  }
  return out;
}
