/**
 * Briefings on WhatsApp to the owner, so the day starts and ends without opening the hub (6 Nov: written the way
 * Perisclaw briefs — "Morning, Sir." + one line on the day, then numbered items: who, their number, what to do).
 *  - morning (`time`, 06:00): interviews today, the owner's live to-dos, what waits for them; items left alone for
 *    3+ days come last, in one short line each ("like ordering tea" — still there, not leading).
 *  - evening (`eveningTime`, 20:00; "" = off): done today, then tomorrow.
 * Settings in config key "digest": { enabled, time: 'HH:MM', eveningTime: 'HH:MM' | '', account }. Each is sent once a
 * day — an atomic claim of the date in the database, so two servers (during a deploy) or restarts never send it twice.
 */
import { query } from './db.js';
import config from './config.js';
import { afterTime, localNow } from './settings.js';
import { alertPhones } from './notify.js';

export const DEFAULT_DIGEST = { enabled: true, time: '06:00', eveningTime: '20:00', account: 'guests' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getDigest() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'digest'`);
  return { ...DEFAULT_DIGEST, ...(r?.value || {}) };
}

export async function saveDigest(input = {}) {
  const cur = await getDigest();
  const next = { ...cur };
  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (input.time !== undefined) {
    if (!HHMM.test(String(input.time))) throw new Error('Time must be HH:MM');
    next.time = String(input.time);
  }
  if (input.eveningTime !== undefined) {
    if (input.eveningTime !== '' && !HHMM.test(String(input.eveningTime))) throw new Error('Evening time must be HH:MM (or empty = off)');
    next.eveningTime = String(input.eveningTime);
  }
  if (input.account) next.account = String(input.account);
  await query(`INSERT INTO config (key, value) VALUES ('digest', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
  return next;
}

// interview cards: made from a list date (kind visit), or written by hand as "Interview: …"
const INTERVIEW = "(kind = 'visit' OR title ILIKE 'Interview%')";
const STALE = "(due_at < now() - interval '3 days' AND updated_at < now() - interval '3 days')";
const hm = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' });
const short = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const endOfDay = (days = 1) => `(date_trunc('day', now() AT TIME ZONE $1) + interval '${days} day') AT TIME ZONE $1`;
/** The person's number on a card: the chat it was made for, else the first number in its text — "(+91…)" so a tap calls or chats. */
const numberOf = (t) => {
  const jid = String(t.ref || '').split(':')[2] || '';
  if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0];
  return `${t.title} ${t.details || ''}`.match(/(?<![\w+])\+?(\d{10,13})(?!\w)/)?.[1] || null;
};
const who = (t, title) => {
  const n = numberOf(t);
  return n && !title.includes(n) ? `${title} (+${n.length === 10 ? '91' + n : n})` : title;
};
/** One briefing item: the card's title, its number, and the next step the AI wrote on it. */
const item = (t, n = 90) => who(t, short(t.title.replace(/\s+—\s+\w{3},.*$/, ''), n)) + (t.next_step ? ` → ${short(t.next_step, 90)}` : '');

async function waiting() {
  const [w] = await query(
    `SELECT (SELECT count(*) FROM tasks WHERE kind = 'reply' AND status NOT IN ('done','cancelled'))::int AS replies,
            (SELECT count(*) FROM outbox WHERE status = 'draft')::int AS drafts,
            (SELECT count(*) FROM outbox WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
            (SELECT count(*) FROM events WHERE level = 'error' AND created_at > now() - interval '24 hours')::int AS errors`,
  );
  return w;
}

/** The morning text (also used for "Send a test now"). */
export async function buildDigest(now = new Date()) {
  const today = localNow(now).date;
  const visits = await query(
    `SELECT title, details, ref, next_step, due_at FROM tasks WHERE ${INTERVIEW} AND status NOT IN ('done','cancelled') AND due_at < ${endOfDay()}
       AND due_at >= now() - interval '12 hours' ORDER BY due_at`, [config.tz]);
  const todos = await query(
    `SELECT title, details, ref, next_step, due_at, priority, ${STALE} AS stale FROM tasks
     WHERE COALESCE(assignee, 'you') = 'you' AND NOT ${INTERVIEW} AND status NOT IN ('done','cancelled')
       AND (due_at IS NULL OR due_at < ${endOfDay()})
     ORDER BY ${STALE}, priority DESC, due_at NULLS LAST LIMIT 40`, [config.tz]);
  const live = todos.filter((t) => !t.stale);
  const old = todos.filter((t) => t.stale);
  const w = await waiting();
  const day = new Date(now).toLocaleDateString('en-IN', { timeZone: config.tz, weekday: 'long', day: 'numeric', month: 'short' });
  const head = [visits.length && plural(visits.length, 'interview'), live.length && `${plural(live.length, 'thing')} for you`,
    w.drafts && `${plural(w.drafts, 'draft')} to approve`].filter(Boolean);
  const lines = [`Morning, Sir. ${day}${head.length ? `: ${head.join(', ')}.` : ' — a clear day so far.'}`];
  let n = 0;
  if (visits.length) {
    lines.push('', '*Interviews today*');
    for (const v of visits.slice(0, 8)) lines.push(`${++n}. ${hm(v.due_at)} — ${item({ ...v, title: v.title.replace(/^Interview:\s*/, '') }, 60)}`);
  }
  if (live.length) {
    lines.push('', '*For you*');
    for (const t of live.slice(0, 8)) lines.push(`${++n}. ${t.priority ? '⭐ ' : ''}${item(t)}`);
    if (live.length > 8) lines.push(`…and ${live.length - 8} more on the Board.`);
  }
  if (w.drafts || w.replies) {
    lines.push('', '*Waiting on you*');
    if (w.drafts) lines.push(`${++n}. Approve ${plural(w.drafts, 'draft')} — they go out only after your tap.${config.publicUrl ? ` ${config.publicUrl}/#drafts` : ''}`);
    if (w.replies) lines.push(`${++n}. ${plural(w.replies, 'person', 'people')} waiting for a reply — the AI drafts them.`);
  }
  if (old.length) lines.push('', `*Left for a while* (untouched 3+ days): ${old.slice(0, 6).map((t) => short(t.title, 40)).join(' · ')}${old.length > 6 ? ` · +${old.length - 6} more` : ''}`);
  if (w.failed || w.errors) lines.push('', `⚠️ Last 24 h: ${plural(w.failed, 'failed send')}${w.errors ? `, ${plural(w.errors, 'error')}` : ''} — Activity → Only problems`);
  if (config.publicUrl) lines.push('', `Board: ${config.publicUrl}/#board`);
  return { text: lines.join('\n'), date: today };
}

/** The evening text: what got done today, then tomorrow. */
export async function buildEvening(now = new Date()) {
  const today = localNow(now).date;
  const startOfDay = `date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`;
  const done = await query(
    `SELECT title, details, ref, next_step FROM tasks WHERE status = 'done' AND completed_at >= ${startOfDay}
       AND kind NOT IN ('reply', 'scheduled', 'bulk') ORDER BY completed_at DESC LIMIT 30`, [config.tz]);
  const [sent] = await query(
    `SELECT count(*)::int AS n FROM outbox WHERE status = 'sent' AND sent_at >= ${startOfDay}`, [config.tz]);
  const tomorrow = await query(
    `SELECT title, details, ref, next_step, due_at, priority FROM tasks WHERE status NOT IN ('done','cancelled') AND COALESCE(assignee, 'you') = 'you'
       AND due_at >= ${endOfDay()} AND due_at < ${endOfDay(2)} ORDER BY priority DESC, due_at LIMIT 20`, [config.tz]);
  const w = await waiting();
  const lines = [`Evening, Sir. ${done.length ? `${plural(done.length, 'item')} closed today` : 'A quiet day on the Board'}, ${plural(sent.n, 'message')} sent.`];
  let n = 0;
  if (done.length) {
    lines.push('', '*Done today*');
    for (const t of done.slice(0, 8)) lines.push(`${++n}. ${who(t, short(t.title, 80))}`);
    if (done.length > 8) lines.push(`…and ${done.length - 8} more.`);
  }
  if (tomorrow.length) {
    lines.push('', '*Tomorrow*');
    for (const t of tomorrow.slice(0, 8)) lines.push(`${++n}. ${t.priority ? '⭐ ' : ''}${hm(t.due_at)} — ${item(t)}`);
  }
  if (w.drafts) lines.push('', `${plural(w.drafts, 'draft')} still waiting for your approval.${config.publicUrl ? ` ${config.publicUrl}/#drafts` : ''}`);
  return { text: lines.join('\n'), date: today };
}

/** Claim today's briefing atomically: only one run anywhere gets true back. */
async function claim(d, field, date) {
  await query(`INSERT INTO config (key, value) VALUES ('digest', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(d)]);
  const got = await query(
    `UPDATE config SET value = jsonb_set(value, $2::text[], to_jsonb($1::text)), updated_at = now()
     WHERE key = 'digest' AND COALESCE(value->>$3, '') <> $1 RETURNING key`, [date, `{${field}}`, field]);
  return got.length > 0;
}

/**
 * Called every minute. Sends today's morning briefing once, after the set time, and the evening one after
 * eveningTime, from the server that holds the sending number. send(account, phone, text) queues a WhatsApp message.
 * force = the morning one now (dashboard "Send a test now"); evening: true = the evening one now.
 */
export async function runDigest(manager, send, { now = new Date(), force = false, evening = false } = {}) {
  const d = await getDigest();
  const slot = evening ? d.eveningTime : d.time;
  if (!force && (!d.enabled || !slot || !afterTime(slot, now))) return null;
  // only within 6 hours of the set time: after a long outage, no "good morning" in the afternoon (and none on install)
  const [hh, mm] = slot.split(':').map(Number);
  if (!force && localNow(now).minutes > hh * 60 + mm + 360) return null;
  const session = manager.sessions.get(d.account);
  if (!session || session.status !== 'open') return null; // another server holds it, or it is offline: try next minute
  const phones = await alertPhones();
  if (!phones.length) return null;
  const { text, date } = evening ? await buildEvening(now) : await buildDigest(now);
  if (!force && !(await claim(d, evening ? 'lastEvening' : 'lastDate', date))) return null;
  for (const p of phones) await send(d.account, p, text);
  return { text, to: phones, account: d.account };
}
