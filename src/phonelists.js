// Phone lists kept by the hub itself (8 Nov 2026).
//
// Why: the owner asked many times for his chats to be sorted into WhatsApp lists on the phone ("Waiting", "Needs you"),
// the way Perisclaw does it. That was left to the AI routine as a last step, and the routine never got there. Sorting
// chats is bookkeeping, not judgement — so the hub does it every 10 minutes from facts it already has:
//   "Waiting"   — the person spoke last, at least N minutes ago (default 20), within the last 3 days, and nothing of
//                 ours is drafted or queued for them. Out the moment we answer (or a draft waits for approval — that
//                 chat is in "Draft waiting" already).
//   "Needs you" — an owner card is open about this person (a call to make, a decision, a visit in the next 2 days,
//                 call notes needed). Out when the card is closed.
// Only linked numbers (Meta API numbers have no phone). The hub remembers what it added (phone_list_state) and removes
// only that, never a list the person holding the phone made by hand. Changes are capped per run so a first pass never
// floods WhatsApp. Settings: config 'phone_lists' { enabled, accounts (empty = every linked number), waitingAfterMin }.
import { query, logEvent } from './db.js';
import { PHONE_RE } from './util.js';
import * as store from './store.js';

const DEFAULTS = { enabled: true, accounts: [], waitingAfterMin: 20, waiting: 'Waiting', needsYou: 'Needs you' };
const MAX_OPS = 40; // label changes per number per run
const warned = new Map();

export async function getPhoneLists() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'phone_lists'`).catch(() => []);
  const v = r?.value || {};
  return {
    enabled: v.enabled !== false,
    accounts: Array.isArray(v.accounts) ? v.accounts.filter(Boolean) : [],
    waitingAfterMin: Number.isFinite(Number(v.waitingAfterMin)) ? Math.max(0, Number(v.waitingAfterMin)) : DEFAULTS.waitingAfterMin,
    waiting: typeof v.waiting === 'string' ? v.waiting.trim() : DEFAULTS.waiting,
    needsYou: typeof v.needsYou === 'string' ? v.needsYou.trim() : DEFAULTS.needsYou,
  };
}
export async function setPhoneLists(patch = {}) {
  const cur = await getPhoneLists();
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  await query(`INSERT INTO config (key, value) VALUES ('phone_lists', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
  return next;
}

async function ownPhones(manager) {
  const { alertPhones } = await import('./notify.js');
  return [...manager.list().map((a) => a.phone), ...(await alertPhones().catch(() => []))].filter(Boolean)
    .map((x) => String(x).replace(/\D/g, '')).flatMap((x) => (x.length === 10 ? [x, '91' + x] : [x]));
}

/** What each chat on this number should be in: Map jid → Set(label). */
export async function desiredLists(accountId, cfg, own) {
  const want = new Map();
  const add = (jid, label) => { if (!label) return; if (!want.has(jid)) want.set(jid, new Set()); want.get(jid).add(label); };
  const now = Math.floor(Date.now() / 1000);
  const waiting = await query(
    `WITH last AS (
       SELECT DISTINCT ON (chat_jid) chat_jid, from_me, ts FROM messages
       WHERE account_id = $1 AND ts > $2 AND chat_jid LIKE '%@s.whatsapp.net' AND type <> 'secretEncrypted'
       ORDER BY chat_jid, ts DESC)
     SELECT chat_jid FROM last
     WHERE NOT from_me AND ts <= $3 AND split_part(chat_jid, '@', 1) <> ALL($4::text[])
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.account_id = $1 AND o.to_jid = last.chat_jid AND o.status IN ('draft','queued','sending'))
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id = $1 AND c.jid = last.chat_jid AND c.is_blocked)`,
    [accountId, now - 3 * 86400, now - cfg.waitingAfterMin * 60, own]);
  for (const r of waiting) add(r.chat_jid, cfg.waiting);
  // the owner's open cards about people on this number: by card ref, or a phone number standing alone in the title
  const cards = await query(
    `SELECT ref, title, kind, due_at FROM tasks
     WHERE status NOT IN ('done','cancelled','review') AND COALESCE(assignee, 'you') = 'you'
       AND (account_id = $1 OR ref LIKE 'reply:' || $1 || ':%' OR ref LIKE 'remind:' || $1 || ':%')
       AND (kind <> 'visit' OR due_at < now() + interval '2 days')`, [accountId]);
  for (const c of cards) {
    const parts = String(c.ref || '').split(':');
    let jid = parts[2] && parts[2].includes('@') ? parts[2] : null;
    if (!jid) {
      const m = String(c.title || '').match(PHONE_RE);
      if (m) {
        const j = store.toJid(m[0]);
        const [has] = await query(`SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 LIMIT 1`, [accountId, j]);
        if (has) jid = j;
      }
    }
    if (jid && jid.endsWith('@s.whatsapp.net') && !own.includes(jid.split('@')[0])) add(jid, cfg.needsYou);
  }
  return want;
}

/** Bring one number's phone lists in step. Returns { added, removed, failed }. */
export async function syncPhoneListsFor(session, manager, cfg) {
  const out = { added: 0, removed: 0, failed: 0 };
  const own = await ownPhones(manager);
  const want = await desiredLists(session.id, cfg, own);
  const have = await query(`SELECT jid, label FROM phone_list_state WHERE account_id = $1`, [session.id]);
  const haveSet = new Set(have.map((h) => `${h.jid}\u0001${h.label}`));
  const wantSet = new Set([...want].flatMap(([jid, labels]) => [...labels].map((l) => `${jid}\u0001${l}`)));
  const ops = [];
  for (const k of wantSet) if (!haveSet.has(k)) ops.push(['label_chat', ...k.split('\u0001')]);
  for (const k of haveSet) if (!wantSet.has(k)) ops.push(['unlabel_chat', ...k.split('\u0001')]);
  for (const [action, jid, label] of ops.slice(0, MAX_OPS)) {
    try {
      await session.phoneAction(action, { jid, label });
      if (action === 'label_chat') {
        await query(`INSERT INTO phone_list_state (account_id, jid, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [session.id, jid, label]);
        out.added++;
      } else {
        await query(`DELETE FROM phone_list_state WHERE account_id = $1 AND jid = $2 AND label = $3`, [session.id, jid, label]);
        out.removed++;
      }
    } catch (err) {
      out.failed++;
      const key = `${session.id}:${action}`;
      if (Date.now() - (warned.get(key) || 0) > 6 * 3600e3) {
        warned.set(key, Date.now());
        await logEvent(session.id, 'warn', `Phone lists: could not ${action === 'label_chat' ? 'add a chat to' : 'take a chat out of'} "${label}" — ${err.message}`, 'system').catch(() => {});
      }
      if (/not connected/i.test(err.message)) break;
    }
  }
  if (out.added || out.removed) await logEvent(session.id, 'info', `Phone lists on ${session.id}: +${out.added} −${out.removed}${ops.length > MAX_OPS ? ` (${ops.length - MAX_OPS} more next time)` : ''}`, 'system').catch(() => {});
  return out;
}

/** Every 10 minutes, for each connected linked number held by this server. */
export async function syncPhoneLists(manager) {
  const cfg = await getPhoneLists();
  const totals = { added: 0, removed: 0, failed: 0 };
  if (!cfg.enabled) return totals;
  for (const s of manager.sessions.values()) {
    if (!s?.sock || s.status !== 'open' || typeof s.phoneAction !== 'function' || s.account?.provider === 'cloud') continue;
    if (cfg.accounts.length && !cfg.accounts.includes(s.id)) continue;
    const r = await syncPhoneListsFor(s, manager, cfg).catch((err) => { logEvent(s.id, 'warn', `Phone lists failed: ${err.message}`, 'system').catch(() => {}); return { added: 0, removed: 0, failed: 1 }; });
    totals.added += r.added; totals.removed += r.removed; totals.failed += r.failed;
  }
  return totals;
}
