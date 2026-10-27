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

/** Photos with the word that came today (on any hub number): { count, last }. */
export async function photosToday(c, now = new Date()) {
  const start = Math.floor(localDate(`${today(now)} 00:00`).getTime() / 1000);
  const jid = `${c.phone}@s.whatsapp.net`;
  const kw = `%${c.keyword.replace(/\s+/g, '')}%`; // spaces ignored: "check list" counts
  const [r] = await query(
    `SELECT count(DISTINCT p.id)::int AS n, max(p.ts) AS last FROM messages p
     WHERE p.chat_jid = $1 AND NOT p.from_me AND p.ts >= $2 AND p.type IN ('image','document')
       AND (replace(lower(coalesce(p.body,'')), ' ', '') LIKE $3
            OR EXISTS (SELECT 1 FROM messages t WHERE t.chat_jid = p.chat_jid AND t.account_id = p.account_id AND NOT t.from_me
                       AND replace(lower(coalesce(t.body,'')), ' ', '') LIKE $3 AND t.ts >= p.ts AND t.ts <= p.ts + 900))`,
    [jid, start, kw],
  );
  return { count: r?.n || 0, last: r?.last ? Number(r.last) : null };
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
