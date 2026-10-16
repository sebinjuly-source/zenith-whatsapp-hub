/**
 * Per-account settings: defaults, validation, and the helpers that apply them.
 * Every account stores its own copy in accounts.settings (JSONB); missing keys fall back to defaults.
 */
import config from './config.js';

export const MIN_DELAY_SEC = 5;

export const DEFAULT_SETTINGS = {
  // How messages written by AI agents or campaigns go out: 'approve' = saved as drafts for you to approve,
  // 'auto' = sent automatically (still through the delay/limit rules below).
  aiMode: 'approve',
  // Random gap between two automated sends from this number, in seconds (minimum 5).
  delayMinSec: 45,
  delayMaxSec: 120,
  // Show "typing…" for a few seconds before each automated message.
  typing: true,
  // Max automated messages (campaign + AI) per day. API/dashboard sends you make yourself are not capped.
  dailyCap: 30,
  // Automated messages only go out inside this window (your timezone).
  sendStart: '10:00',
  sendEnd: '19:00',
  sendDays: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  // History & storage
  storeGroups: true,
  autosaveImages: false,
  autosaveDocuments: false,
  // Only autosave media from people you have chatted with (skips businesses blasting brochures).
  autosaveKnownOnly: true,
  autosaveMaxMb: 5,
  // Replies that mean "stop messaging me" — the contact is tagged opted-out and skipped by campaigns.
  optOutWords: ['stop', 'unsubscribe', 'not interested', 'dont message', "don't message"],
  // Optional URL notified (POST JSON) on each new incoming message, e.g. an Apps Script web app.
  webhookUrl: '',
};

const clampInt = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
};
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const out = {
    aiMode: s.aiMode === 'auto' ? 'auto' : 'approve',
    delayMinSec: clampInt(s.delayMinSec, MIN_DELAY_SEC, 3600, DEFAULT_SETTINGS.delayMinSec),
    delayMaxSec: clampInt(s.delayMaxSec, MIN_DELAY_SEC, 7200, DEFAULT_SETTINGS.delayMaxSec),
    typing: !!s.typing,
    dailyCap: clampInt(s.dailyCap, 0, 1000, DEFAULT_SETTINGS.dailyCap),
    sendStart: isTime(s.sendStart) ? s.sendStart : DEFAULT_SETTINGS.sendStart,
    sendEnd: isTime(s.sendEnd) ? s.sendEnd : DEFAULT_SETTINGS.sendEnd,
    sendDays: Array.isArray(s.sendDays)
      ? [...new Set(s.sendDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort()
      : DEFAULT_SETTINGS.sendDays,
    storeGroups: !!s.storeGroups,
    autosaveImages: !!s.autosaveImages,
    autosaveDocuments: !!s.autosaveDocuments,
    autosaveKnownOnly: !!s.autosaveKnownOnly,
    autosaveMaxMb: clampInt(s.autosaveMaxMb, 1, 50, DEFAULT_SETTINGS.autosaveMaxMb),
    optOutWords: (Array.isArray(s.optOutWords) ? s.optOutWords : String(s.optOutWords || '').split(','))
      .map((w) => String(w).trim().toLowerCase())
      .filter(Boolean),
    webhookUrl: typeof s.webhookUrl === 'string' && /^https?:\/\//.test(s.webhookUrl) ? s.webhookUrl : '',
  };
  if (out.delayMaxSec < out.delayMinSec) out.delayMaxSec = out.delayMinSec;
  return out;
}

export function randomDelayMs(settings) {
  const min = Math.max(MIN_DELAY_SEC, settings.delayMinSec);
  const max = Math.max(min, settings.delayMaxSec);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

/** Current time in the configured timezone as { day: 0-6, minutes: since midnight, date: 'YYYY-MM-DD' }. */
export function localNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: days[parts.weekday],
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const toMin = (hhmm) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);

export function insideSendingWindow(settings, now = new Date()) {
  const { day, minutes } = localNow(now);
  if (!settings.sendDays.includes(day)) return false;
  return minutes >= toMin(settings.sendStart) && minutes < toMin(settings.sendEnd);
}
