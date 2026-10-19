/**
 * Outgoing notifications:
 *  - postWebhook: POST an event to a URL, signed and retried (pattern from Chatwoot's webhook trigger).
 *  - alerts: tell the owner on WhatsApp when a number is logged out or stays disconnected.
 */
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { logEvent, query } from './db.js';

/** Phones that get connection alerts: hub setting (Settings page) plus ALERT_PHONE env. */
export async function alertPhones() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'alerts'`).catch(() => []);
  const fromDb = r?.value?.phones || [];
  const fromEnv = (process.env.ALERT_PHONE || '').split(',');
  return [...new Set([...fromDb, ...fromEnv].map((p) => String(p).replace(/\D/g, '')).filter((p) => p.length >= 10)
    .map((p) => (p.length === 10 ? '91' + p : p)))];
}

export async function setAlertPhones(phones) {
  const list = (Array.isArray(phones) ? phones : String(phones || '').split(',')).map((p) => String(p).trim()).filter(Boolean);
  await query(
    `INSERT INTO config (key, value) VALUES ('alerts', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ phones: list })],
  );
  return alertPhones();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signed + retried webhook. Headers let the receiver verify the sender:
 *   X-Hub-Timestamp: unix seconds
 *   X-Hub-Signature: sha256=HMAC_SHA256(API_KEY, `${timestamp}.${body}`)
 * Retries on network errors / 5xx / 429 after 5 s and 30 s.
 */
export async function postWebhook(url, payload, { attempts = 3 } = {}) {
  const body = JSON.stringify(payload);
  for (let i = 0; i < attempts; i++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = 'sha256=' + crypto.createHmac('sha256', config.apiKey).update(`${ts}.${body}`).digest('hex');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Timestamp': ts, 'X-Hub-Signature': signature },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res.status; // 4xx (not 429) won't improve with retries
      logger.warn({ url, status: res.status, attempt: i + 1 }, 'Webhook rejected; will retry');
    } catch (err) {
      logger.warn({ url, err: err.message, attempt: i + 1 }, 'Webhook failed; will retry');
    }
    if (i < attempts - 1) await sleep([5000, 30000][i] ?? 30000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Disconnect alerts
// ---------------------------------------------------------------------------
const ALERT_AFTER_MS = 15 * 60 * 1000; // disconnected this long → alert
const REALERT_MS = 6 * 60 * 60 * 1000; // don't repeat the same alert more often
const lastAlert = new Map(); // `${account}|${kind}` -> time
const downSince = new Map(); // account -> time it stopped being open

/**
 * Watch connection changes. `send(fromAccountId, phone, text)` sends a WhatsApp message.
 * Alerts go to ALERT_PHONE (comma-separated) from any other connected number.
 */
export function startAlerts(manager, send) {

  const alert = async (account, kind, text) => {
    const k = `${account.id}|${kind}`;
    if (Date.now() - (lastAlert.get(k) || 0) < REALERT_MS) return;
    const from = manager.list().find((a) => a.status === 'open' && a.id !== account.id);
    lastAlert.set(k, Date.now());
    await logEvent(account.id, 'warn', `Alert: ${text}`);
    if (!from) return logger.warn({ account: account.id }, 'No other connected number to send the alert from');
    const phones = await alertPhones();
    for (const p of phones) await send(from.id, p, `⚠️ WhatsApp Hub: ${text}`).catch((e) => logger.warn({ err: e.message }, 'alert send failed'));
  };

  manager.on('change', (info) => {
    if (!info?.id) return;
    const acc = manager.list().find((a) => a.id === info.id);
    if (!acc) return;
    if (info.status === 'open' || info.status === 'elsewhere') downSince.delete(info.id);
    else if (!downSince.has(info.id)) downSince.set(info.id, Date.now());
    if (info.status === 'logged_out') {
      alert(acc, 'logged_out', `"${acc.label}" (+${acc.phone || '?'}) was logged out of WhatsApp. Open the dashboard → Numbers → Link number to reconnect.`);
    }
  });

  setInterval(() => {
    for (const acc of manager.list()) {
      const since = downSince.get(acc.id);
      // only numbers that were linked before (have a phone) and aren't paused, logged out or being linked
      if (!since || !acc.phone || !acc.enabled || acc.status === 'logged_out' || acc.status === 'qr') continue;
      if (Date.now() - since > ALERT_AFTER_MS) {
        alert(acc, 'down', `"${acc.label}" (+${acc.phone || '?'}) has been disconnected for over 15 minutes (status: ${acc.status}). Check the phone has internet; the dashboard shows details.`);
      }
    }
  }, 60000).unref();
}
