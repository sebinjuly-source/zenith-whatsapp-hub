/**
 * Daily check-ins: a staff member sends a photo report every day (e.g. Mallesh: the room checklist and the front
 * desk checklist). A photo counts when he writes the word (default "checklist") with it — in its caption or in a
 * message within 15 minutes after it — because he sends many other photos (food, orders, rooms) all day.
 * Messages to ANY hub number count. If fewer than the photos needed have come by the deadline, one reminder goes
 * to him from the chosen number WITHOUT approval (the owner set it up — it is the owner's own message, so the
 * number's sending hours and daily limits don't hold it), and the owner gets a Board card that closes by itself
 * when the photos arrive. Stored in config key 'checkins'. Checked every minute (once per person per day).
 */
import config from './config.js';
import { query } from './db.js';
import { localDate } from './util.js';
import { toJid } from './store.js';

const DEFAULTS = { keyword: 'checklist', minPhotos: 2, deadline: '21:00', enabled: true };
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'checkin';

export function normalizeCheckin(c = {}) {
  const phone = String(c.phone || '').replace(/\D/g, '');
  if (phone.length < 10) throw new Error(`Check-in "${c.name || '?'}": give the staff member's phone number`);
  if (!c.account) throw new Error(`Check-in "${c.name || phone}": choose the number the reminder goes from`);
  const deadline = String(c.deadline || DEFAULTS.deadline).trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(deadline)) throw new Error(`Check-in "${c.name || phone}": time must be HH:MM, e.g. 21:00`);
  const keyword = String(c.keyword ?? DEFAULTS.keyword).trim().toLowerCase();
  if (!keyword) throw new Error(`Check-in "${c.name || phone}": give the word he writes with the photo`);
  return {
    id: c.id || slug(c.name || phone),
    name: String(c.name || phone).trim().slice(0, 60),
    phone: toJid(phone).split('@')[0],
    what: String(c.what || 'today\'s checklists').trim().slice(0, 120),
    keyword,
    minPhotos: Math.max(1, Math.min(10, parseInt(c.minPhotos, 10) || DEFAULTS.minPhotos)),
    deadline,
    account: String(c.account),
    text: String(c.text || '').trim().slice(0, 1000)
      || `Hi ${String(c.name || '').trim() || 'there'}, please send the photos of ${String(c.what || 'today\'s checklists').trim()} now. Write "${keyword}" with the photos. Thank you.`,
    enabled: c.enabled !== false,
  };
}

export async function getCheckins() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'checkins'`).catch(() => []);
  return (r?.value?.items || []).map((c) => { try { return normalizeCheckin(c); } catch { return null; } }).filter(Boolean);
}

export async function setCheckins(items) {
  const list = (Array.isArray(items) ? items : []).map(normalizeCheckin);
  const ids = new Set();
  for (const c of list) {
    while (ids.has(c.id)) c.id += '-2';
    ids.add(c.id);
  }
  await query(
    `INSERT INTO config (key, value) VALUES ('checkins', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ items: list })],
  );
  return list;
}

/** Edit distance (small strings only). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * Does this text contain the word, allowing for how staff really type it (30 Oct: Mallesh writes "chechlist",
 * "check list")? Words and word pairs are compared with spaces removed; up to 2 letters may differ for words of
 * 7+ letters (1 for shorter ones).
 */
export function hasWord(text, keyword) {
  const kw = String(keyword || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!kw) return false;
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const allowed = kw.length >= 7 ? 2 : kw.length >= 4 ? 1 : 0;
  const cands = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  return cands.some((w) => w.includes(kw) || (Math.abs(w.length - kw.length) <= allowed && distance(w, kw) <= allowed));
}

/**
 * Photos with the word that came today (on any hub number): { count, last, marked }. The same photo sent to two
 * numbers counts once (same file fingerprint). "marked" = the AI looked at the photos and marked today received
 * (daily_checkins mark_received) — counts as done whatever the captions say.
 */
export async function photosToday(c, now = new Date()) {
  const day = today(now);
  const start = Math.floor(localDate(`${day} 00:00`).getTime() / 1000);
  const jid = `${c.phone}@s.whatsapp.net`;
  const rows = await query(
    `SELECT account_id, id, ts, type, body, media->>'fileSha256' AS sha FROM messages
     WHERE chat_jid = $1 AND NOT from_me AND ts >= $2 AND ts <= $3 ORDER BY ts`,
    [jid, start, Math.floor(now.getTime() / 1000)],
  );
  const photos = new Map();
  for (const p of rows) {
    if (!['image', 'document'].includes(p.type)) continue;
    // the word in its caption, or in a message of theirs on that number within 15 minutes after it
    const named = hasWord(p.body, c.keyword) || rows.some((t) => t.account_id === p.account_id && t.ts >= p.ts && t.ts <= Number(p.ts) + 900 && t.id !== p.id && hasWord(t.body, c.keyword));
    if (named) photos.set(p.sha || p.id, Number(p.ts));
  }
  const [m] = await query(`SELECT value FROM config WHERE key = 'checkin_marks'`).catch(() => []);
  const marked = m?.value?.[c.id]?.date === day ? m.value[c.id] : null;
  const last = photos.size ? Math.max(...photos.values()) : null;
  return { count: marked ? Math.max(photos.size, c.minPhotos) : photos.size, last, marked };
}

/** The AI looked at today's photos and saw the checklists (spelling or captions aside): count today as received. */
export async function markReceived(id, note = '', now = new Date()) {
  const c = (await getCheckins()).find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (!c) throw new Error(`No daily check-in "${id}"`);
  const [m] = await query(`SELECT value FROM config WHERE key = 'checkin_marks'`).catch(() => []);
  const marks = { ...(m?.value || {}), [c.id]: { date: today(now), note: String(note).slice(0, 300), at: now.toISOString() } };
  await query(
    `INSERT INTO config (key, value) VALUES ('checkin_marks', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(marks)],
  );
  await runCheckins(now); // closes the owner's card at once
  return c;
}

/** Today's state of every check-in (for the AI, the dashboard and the morning summary). */
export async function checkinStatus(now = new Date()) {
  const out = [];
  for (const c of await getCheckins()) {
    const got = await photosToday(c, now);
    const due = localDate(`${today(now)} ${c.deadline}`);
    const [sent] = await query(`SELECT id, status FROM outbox WHERE idem_key = $1 LIMIT 1`, [`checkin:${c.id}:${today(now)}`]);
    out.push({ ...c, photos: got.count, done: got.count >= c.minPhotos, dueAt: due.toISOString(), late: now >= due && got.count < c.minPhotos, reminder: sent || null });
  }
  return out;
}

/**
 * Every minute: after the deadline, anyone short of photos gets ONE reminder (idempotent per day, so several servers
 * or restarts can't send twice) and the owner a Board card; the card closes when the photos arrive.
 */
export async function runCheckins(now = new Date()) {
  const items = await getCheckins();
  if (!items.length) return 0;
  const day = today(now);
  const { enqueue } = await import('./outbox.js');
  const { upsertRefTask, closeRefTasks } = await import('./tasks.js');
  let sent = 0;
  for (const c of items) {
    const ref = `checkin:${c.id}`;
    const got = await photosToday(c, now);
    if (got.count >= c.minPhotos) {
      await closeRefTasks([ref], 'done', `${got.count} photo(s) with "${c.keyword}" came in`);
      continue;
    }
    if (!c.enabled || now < localDate(`${day} ${c.deadline}`)) continue;
    const idem = `checkin:${c.id}:${day}`;
    const [already] = await query(`SELECT 1 FROM outbox WHERE account_id = $1 AND idem_key = $2`, [c.account, idem]);
    if (already) continue;
    const row = await enqueue({ account: c.account, to: c.phone, payload: { text: c.text }, source: 'checkin', note: `daily check-in: ${c.name}`, idemKey: idem });
    if (!row.duplicate) sent++;
    await upsertRefTask(ref, {
      account: c.account, kind: 'todo', assignee: 'you', dueAt: now.toISOString(),
      title: `${c.name} hasn't sent ${c.what} (${got.count}/${c.minPhotos}) — reminder sent`,
      details: `By ${c.deadline} only ${got.count} of ${c.minPhotos} photo(s) with the word "${c.keyword}" came from +${c.phone}. A reminder went to him from "${c.account}" at ${now.toLocaleTimeString('en-IN', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' })}. This card closes by itself when the photos come.`,
    });
  }
  return sent;
}
