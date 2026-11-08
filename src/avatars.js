// Profile pictures of the people we chat with (8 Nov 2026).
//
// Why: the owner approves drafts and reads the inbox faster when he sees who the person is, and the AI that writes the
// drafts addresses people properly ("Dear Mrs Savitha", a business by its name) instead of "Sir / Madam" when it can
// see the picture. WhatsApp gives a picture URL through a linked number (`profilePictureUrl`); the URL is short-lived
// and the lookup is slow, so the bytes are fetched once and kept in memory for a while. Meta Cloud API numbers cannot
// ask for pictures; a person's privacy setting may hide it — then there is simply none.
import { manager } from './wa/manager.js';

const TTL = 12 * 3600e3; // a picture is good for half a day
const NONE_TTL = 2 * 3600e3; // "no picture" is asked again after two hours
const MAX = 3000; // entries kept in memory
const cache = new Map(); // `${account}:${jid}` → { buffer, mimetype, at } | { none: true, at }

/** The picture as { buffer, mimetype } or null. Asks the chat's own number first, then any other connected linked number. */
export async function getAvatar(accountId, jid) {
  if (!jid || !/@s\.whatsapp\.net$/.test(jid)) return null; // groups, broadcasts, Meta user ids have none
  const key = `${accountId}:${jid}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < (c.none ? NONE_TTL : TTL)) return c.none ? null : c;
  const own = manager.sessions?.get(accountId);
  const sessions = [own, ...manager.list().map((a) => manager.sessions?.get(a.id))]
    .filter((s, i, arr) => s && arr.indexOf(s) === i && s.status === 'open' && typeof s.profilePicture === 'function');
  let out = null;
  for (const s of sessions) {
    const url = await s.profilePicture(jid).catch(() => null);
    if (!url) continue;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r?.ok) continue;
    const mimetype = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/^image\//.test(mimetype)) continue;
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) continue;
    out = { buffer, mimetype, at: Date.now() };
    break;
  }
  if (!out && !sessions.length) return null; // nobody to ask (numbers reconnecting after a deploy): don't remember "none"
  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out || { none: true, at: Date.now() });
  return out;
}

/** Forget a cached answer (tests, or when a person changes their picture). */
export function forgetAvatar(accountId, jid) { cache.delete(`${accountId}:${jid}`); }
