/**
 * Morning WhatsApp to the owner: today's interviews, their to-dos, what waits for them, problems — so the day
 * starts without opening the hub. Sent once a day at `time` from `account` to the alert phone(s).
 * Settings in config key "digest": { enabled, time: 'HH:MM', account }. Once a day is guaranteed by an atomic
 * claim of the date in the database, so two servers (during a deploy) or restarts can never send it twice.
 */
import { query } from './db.js';
import config from './config.js';
import { afterTime, localNow } from './settings.js';
import { alertPhones } from './notify.js';

export const DEFAULT_DIGEST = { enabled: true, time: '06:00', account: 'guests' };

export async function getDigest() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'digest'`);
  return { ...DEFAULT_DIGEST, ...(r?.value || {}) };
}

export async function saveDigest(input = {}) {
  const cur = await getDigest();
  const next = { ...cur };
  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (input.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time))) throw new Error('Time must be HH:MM');
    next.time = String(input.time);
  }
  if (input.account) next.account = String(input.account);
  await query(`INSERT INTO config (key, value) VALUES ('digest', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
  return next;
}

// interview cards: made from a list date (kind visit), or written by hand as "Interview: …"
const INTERVIEW = "(kind = 'visit' OR title ILIKE 'Interview%')";
const hm = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' });
const short = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

/** The message text (also used for "Send a test now"). */
export async function buildDigest(now = new Date()) {
  const today = localNow(now).date;
  const endOfDay = `(date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1`;
  const visits = await query(
    `SELECT title, due_at FROM tasks WHERE ${INTERVIEW} AND status NOT IN ('done','cancelled') AND due_at < ${endOfDay}
       AND due_at >= now() - interval '12 hours' ORDER BY due_at`, [config.tz]);
  const todos = await query(
    `SELECT title, due_at, priority FROM tasks WHERE COALESCE(assignee, 'you') = 'you' AND NOT ${INTERVIEW} AND status NOT IN ('done','cancelled')
       AND (due_at IS NULL OR due_at < ${endOfDay}) ORDER BY priority DESC, due_at NULLS LAST LIMIT 30`, [config.tz]);
  const [w] = await query(
    `SELECT (SELECT count(*) FROM tasks WHERE kind = 'reply' AND status NOT IN ('done','cancelled'))::int AS replies,
            (SELECT count(*) FROM outbox WHERE status = 'draft')::int AS drafts,
            (SELECT count(*) FROM tasks WHERE kind = 'followup' AND status NOT IN ('done','cancelled') AND due_at < ${endOfDay})::int AS followups,
            (SELECT count(*) FROM outbox WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
            (SELECT count(*) FROM events WHERE level = 'error' AND created_at > now() - interval '24 hours')::int AS errors,
            (SELECT count(*) FROM accounts WHERE enabled)::int AS numbers`, [config.tz],
  );
  const day = new Date(now).toLocaleDateString('en-IN', { timeZone: config.tz, weekday: 'long', day: 'numeric', month: 'short' });
  const lines = [`☀️ Good morning — ${day}`];
  lines.push('', visits.length ? `🎯 Interviews today (${visits.length}):` : '🎯 No interviews today.');
  for (const v of visits.slice(0, 8)) lines.push(`• ${hm(v.due_at)} ${short(v.title.replace(/^Interview:\s*/, '').replace(/\s+—\s+\w{3},.*$/, ''), 60)}`);
  if (todos.length) {
    lines.push('', `✅ Your to-dos (${todos.length}${todos.length === 30 ? '+' : ''}):`);
    for (const t of todos.slice(0, 8)) lines.push(`• ${t.priority ? '⭐ ' : ''}${short(t.title, 70)}${t.due_at && new Date(t.due_at) < new Date(now) - 86400e3 ? ' (overdue)' : ''}`);
    if (todos.length > 8) lines.push(`• …and ${todos.length - 8} more on the Board`);
  }
  lines.push('', `💬 ${w.replies} candidate${w.replies === 1 ? '' : 's'} waiting for a reply (the AI drafts them) · ✉️ ${w.drafts} draft${w.drafts === 1 ? '' : 's'} to approve${w.followups ? ` · 🔁 ${w.followups} follow-up${w.followups === 1 ? '' : 's'} due` : ''}`);
  if (w.failed || w.errors) lines.push(`⚠️ Last 24 h: ${w.failed} failed send${w.failed === 1 ? '' : 's'}${w.errors ? `, ${w.errors} error${w.errors === 1 ? '' : 's'}` : ''} — Activity → Only problems`);
  if (config.publicUrl) lines.push('', `Board: ${config.publicUrl}/#board`);
  return { text: lines.join('\n'), date: today };
}

/**
 * Called every minute. Sends today's summary once, after the set time, from the server that holds the sending
 * number. send(account, phone, text) queues a WhatsApp message.
 */
export async function runDigest(manager, send, { now = new Date(), force = false } = {}) {
  const d = await getDigest();
  if (!force && (!d.enabled || !afterTime(d.time, now))) return null;
  // only within 6 hours of the set time: after a long outage, no "good morning" in the afternoon (and none on install)
  const [hh, mm] = d.time.split(':').map(Number);
  if (!force && localNow(now).minutes > hh * 60 + mm + 360) return null;
  const session = manager.sessions.get(d.account);
  if (!session || session.status !== 'open') return null; // another server holds it, or it is offline: try next minute
  const phones = await alertPhones();
  if (!phones.length) return null;
  const { text, date } = await buildDigest(now);
  if (!force) {
    // claim today atomically: only one run anywhere gets the row back
    await query(`INSERT INTO config (key, value) VALUES ('digest', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(d)]);
    const claimed = await query(
      `UPDATE config SET value = jsonb_set(value, '{lastDate}', to_jsonb($1::text)), updated_at = now()
       WHERE key = 'digest' AND COALESCE(value->>'lastDate', '') <> $1 RETURNING key`, [date]);
    if (!claimed.length) return null;
  }
  for (const p of phones) await send(d.account, p, text);
  return { text, to: phones, account: d.account };
}
