/**
 * The one secret that opens the hub (dashboard cookie, REST x-api-key / ?key=, MCP /mcp/<key>), checked the same way
 * everywhere: in constant time, and with a limit on wrong guesses per IP.
 */
import crypto from 'crypto';
import config from './config.js';

/** Constant-time key check (a plain === leaks how many leading characters were right). */
export function keyOk(key) {
  if (!key || !config.apiKey) return false;
  const a = Buffer.from(String(key));
  const b = Buffer.from(String(config.apiKey));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Wrong keys per IP: 10 per 15 minutes, then 429 until the window passes (guessing the key is the only way in).
const badKeys = new Map();
export function keyGuessBlocked(ip, failed = false) {
  const now = Date.now();
  const e = badKeys.get(ip);
  const cur = e && now - e.since < 15 * 60000 ? e : { n: 0, since: now };
  if (failed) cur.n++;
  badKeys.set(ip, cur);
  if (badKeys.size > 5000) badKeys.clear(); // never grows without bound
  return cur.n >= 10;
}

/** Tests: start counting from zero. */
export const resetKeyGuesses = () => badKeys.clear();
