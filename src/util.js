import config from './config.js';

/** "2026-01-31", ISO datetime, or unix seconds → unix seconds */
export function toTs(v) {
  if (v == null || v === '') return undefined;
  if (/^\d{9,11}$/.test(String(v))) return parseInt(v, 10);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/**
 * A phone number standing on its own in free text: 10–13 digits in one block, or 5+5 with a space, optionally
 * "+<code> " first. ("Cand1 9733400001" must not become 19733400001, nor "Batch 6 9876543210" 69876543210.)
 */
export const PHONE_RE = /(?<![\w+])(?:\+\d{1,3} ?)?(?:\d{5} ?\d{5}|\d{10,13})(?!\w)/g;

/** Milliseconds the time zone is ahead of UTC at that moment (India: +5.5 h). */
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * A wall-clock time in the owner's time zone ("2026-10-25 10:00", "2026-10-25T10:00", "2026-10-25" = 10:00) → Date.
 * Strings that already carry a zone (Z, +05:30) are read as they are. Servers run in UTC, so never `new Date()` them raw.
 */
export function localDate(v, tz = config.tz) {
  let t = String(v ?? '').trim();
  if (!t) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) return new Date(t);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += ' 10:00';
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date(NaN);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}
