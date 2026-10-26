/**
 * Per-account settings: defaults, validation, and the helpers that apply them.
 * Every account stores its own copy in accounts.settings (JSONB); missing keys fall back to defaults.
 */
import config from './config.js';

export const MIN_DELAY_SEC = 5;

/**
 * New numbers (people this WhatsApp number has never chatted with) per rolling 24 hours: a hard ceiling that no
 * setting can exceed. Set on 19 Oct 2026 from real data: Seema's number was blocked by WhatsApp for 24 h after
 * messaging 48 new numbers in 24 h → absolute limit 48 − 3 = 45, default working limit 48 − 6 = 42.
 */
export const NEW_CHATS_HARD_MAX = 45;
export const NEW_CHATS_DEFAULT = 42;
// Meta Cloud API numbers aren't at risk of the linked-device block; Meta enforces its own tier (250 → 1,000 → …).
export const CLOUD_NEW_CHATS_MAX = 1000;

export const DEFAULT_SETTINGS = {
  // How messages written by AI agents or campaigns go out: 'approve' = saved as drafts for you to approve,
  // 'auto' = sent automatically (still through the delay/limit rules below).
  aiMode: 'approve',
  // Random gap between two automated sends from this number, in seconds (minimum 5).
  delayMinSec: 45,
  delayMaxSec: 120,
  // Show "typing…" for a few seconds before each automated message.
  typing: true,
  // Max automated messages (campaign + AI) per rolling 24 h to people who have never written to this number (cold
  // outreach). On a linked phone, messages to people who wrote to this number in the last WARM_DAYS (30) days don't
  // use it (they have warmDailyCap); someone who last wrote months ago is cold again (26 Oct: 76 messages to mostly
  // stale contacts in under 2 hours got the hotel number logged out);
  // on a Meta number everything outside the 24 h reply window counts (Meta's own limit counts them all).
  // Your own dashboard/API sends are not capped.
  dailyCap: 35,
  // Linked phones: automated messages per rolling 24 h to people who wrote to this number in the last 30 days
  // (interested candidates, interview follow-ups, guests talking to us now). Separate from dailyCap.
  warmDailyCap: 30,
  // Linked phones: automated messages (cold + warm, not replies) per rolling hour — spreads a batch over the day
  // instead of a burst (WhatsApp logs a number out for bursts to many people).
  hourlyCap: 10,
  // First messages to NEW numbers (never chatted before) in any rolling 24 h, from every source — including you,
  // scripts and the phone itself. Never above NEW_CHATS_HARD_MAX.
  newChatsPer24h: NEW_CHATS_DEFAULT,
  // Send at any time of day, every day. Turn off to use the window below (your timezone).
  anytime: true,
  sendStart: '10:00',
  sendEnd: '19:00',
  sendDays: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  // Follow-ups to people who never replied: not before this time, and at most this many a day.
  followupStart: '21:00',
  followupDailyMax: 5,
  // History & storage
  // What to import when the number is linked: 'full' (everything the phone has), 'recent' (the phone's
  // default — roughly the last few months), 'none' (only new messages from now on). Only used at link time.
  historyMode: 'full',
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
    anytime: s.anytime !== false,
    dailyCap: clampInt(s.dailyCap, 0, 1000, DEFAULT_SETTINGS.dailyCap),
    warmDailyCap: clampInt(s.warmDailyCap, 0, 200, DEFAULT_SETTINGS.warmDailyCap),
    hourlyCap: clampInt(s.hourlyCap, 1, 60, DEFAULT_SETTINGS.hourlyCap),
    // Stored up to Meta's own tiers; linked phones are still held to NEW_CHATS_HARD_MAX where it's applied (outbox).
    newChatsPer24h: clampInt(s.newChatsPer24h, 0, CLOUD_NEW_CHATS_MAX, NEW_CHATS_DEFAULT),
    sendStart: isTime(s.sendStart) ? s.sendStart : DEFAULT_SETTINGS.sendStart,
    sendEnd: isTime(s.sendEnd) ? s.sendEnd : DEFAULT_SETTINGS.sendEnd,
    sendDays: Array.isArray(s.sendDays)
      ? [...new Set(s.sendDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort()
      : DEFAULT_SETTINGS.sendDays,
    historyMode: ['full', 'recent', 'none'].includes(s.historyMode) ? s.historyMode : 'full',
    followupStart: isTime(s.followupStart) ? s.followupStart : DEFAULT_SETTINGS.followupStart,
    followupDailyMax: clampInt(s.followupDailyMax, 0, 100, DEFAULT_SETTINGS.followupDailyMax),
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

/** Is it at/after HH:MM today (your timezone)? */
export function afterTime(hhmm, now = new Date()) {
  return localNow(now).minutes >= toMin(hhmm);
}

export function insideSendingWindow(settings, now = new Date()) {
  if (settings.anytime) return true;
  const { day, minutes } = localNow(now);
  if (!settings.sendDays.includes(day)) return false;
  return minutes >= toMin(settings.sendStart) && minutes < toMin(settings.sendEnd);
}

/** The first moment at or after `t` inside the sending window (15-minute steps; `t` itself when sending any time). */
export function nextSendingTime(settings, t = new Date()) {
  let d = new Date(t);
  for (let i = 0; i < 8 * 96 && !insideSendingWindow(settings, d); i++) {
    d = new Date(Math.ceil((d.getTime() + 1) / 900e3) * 900e3);
  }
  return d;
}
