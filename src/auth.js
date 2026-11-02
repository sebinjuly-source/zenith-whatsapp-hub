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

// ---- Read-only key (2 Nov): a second key that can look but never send or change — for scripts, sheets and routines
// that only read. Stored as a SHA-256 hash in config 'readonly_key'; created / revoked by the owner in the dashboard.
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
let roCache = { at: 0, hash: null };
async function readonlyHash() {
  if (Date.now() - roCache.at < 60000) return roCache.hash;
  const { query } = await import('./db.js');
  const [r] = await query(`SELECT value FROM config WHERE key = 'readonly_key'`).catch(() => []);
  roCache = { at: Date.now(), hash: r?.value?.hash || null };
  return roCache.hash;
}
/** 'full' (the main key), 'read' (the read-only key) or null. */
export async function keyRole(key) {
  if (keyOk(key)) return 'full';
  if (!key) return null;
  const h = await readonlyHash();
  if (!h) return null;
  const a = Buffer.from(sha(key));
  const b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'read' : null;
}
/** Make a new read-only key (the old one stops working); returns it once — only its hash is kept. */
export async function createReadonlyKey() {
  const { query } = await import('./db.js');
  const key = 'ro_' + crypto.randomBytes(24).toString('hex');
  await query(`INSERT INTO config (key, value) VALUES ('readonly_key', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ hash: sha(key), created_at: new Date().toISOString() })]);
  roCache = { at: 0, hash: null };
  return key;
}
export async function revokeReadonlyKey() {
  const { query } = await import('./db.js');
  await query(`DELETE FROM config WHERE key = 'readonly_key'`);
  roCache = { at: 0, hash: null };
}
export async function readonlyKeyInfo() {
  const { query } = await import('./db.js');
  const [r] = await query(`SELECT value FROM config WHERE key = 'readonly_key'`).catch(() => []);
  return { exists: !!r?.value?.hash, created_at: r?.value?.created_at || null };
}
/** The AI tools a read-only key may use (they only read). */
export const READ_TOOLS = new Set(['list_accounts', 'hub_overview', 'find_people', 'get_contact', 'find_contacts', 'list_outbox', 'inbox_summary',
  'owner_feedback', 'describe_data', 'inspect_data', 'list_templates', 'list_meta_templates', 'meta_health_check', 'message_timeline',
  'person_context', 'find_person', 'list_rules', 'list_lists', 'list_members', 'pipeline', 'known_candidates', 'get_playbook', 'get_settings',
  'list_campaigns', 'open_file', 'find_files', 'storage_status', 'list_tasks', 'task_history', 'get_messages', 'list_chats', 'search_messages',
  'recent_activity', 'list_shared_contacts']);
