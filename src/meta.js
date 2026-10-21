/**
 * Meta WhatsApp Cloud API webhook: <server>/meta/webhook (guide step 4.9).
 *  - GET: Meta's one-time check. Answers hub.challenge when hub.verify_token matches META_VERIFY_TOKEN.
 *  - POST: incoming messages and delivery statuses. Checked with X-Hub-Signature-256 when META_APP_SECRET
 *    is set, answered 200 at once (Meta retries anything slower or non-200), and logged for now.
 *    Storing them in the inbox comes with the rest of guide step 4.8.
 * Env vars are read per request, so pasting them into Render needs only a restart.
 */
import crypto from 'crypto';
import logger from './logger.js';
import { logEvent } from './db.js';
import { manager } from './wa/manager.js';
import { logMetaEvent } from './wa/cloud.js';

function signatureOk(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const got = req.get('x-hub-signature-256') || '';
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Short summary of a webhook body: how many messages and statuses, for which phone number id. */
export function summarize(body) {
  const out = { messages: 0, statuses: 0, phoneNumberIds: new Set(), fields: new Set() };
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      out.fields.add(ch.field);
      const v = ch.value || {};
      if (v.metadata?.phone_number_id) out.phoneNumberIds.add(v.metadata.phone_number_id);
      out.messages += (v.messages || []).length;
      out.statuses += (v.statuses || []).length;
    }
  }
  return { ...out, phoneNumberIds: [...out.phoneNumberIds], fields: [...out.fields] };
}

export function mountMetaWebhook(app) {
  app.get('/meta/webhook', (req, res) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
      logger.info('Meta webhook verified');
      logEvent(null, 'info', 'Meta webhook connected (Verify and save succeeded)', 'system').catch(() => {});
      return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    logger.warn({ hasToken: !!token }, 'Meta webhook verification refused');
    res.sendStatus(403);
  });

  app.post('/meta/webhook', (req, res) => {
    if (!signatureOk(req)) {
      logger.warn('Meta webhook: bad signature');
      return res.sendStatus(401);
    }
    // Store first, then answer: if storing fails (database hiccup, server just starting) Meta gets a 500 and
    // delivers again later — duplicates are ignored. Storing takes well under Meta's time limit.
    logger.debug(summarize(req.body), 'Meta webhook event');
    const work = dispatch(req.body);
    const slow = new Promise((r) => setTimeout(() => r('slow'), 8000));
    Promise.race([work, slow])
      .then((r) => res.sendStatus(200) && r === 'slow' && logger.warn('Meta webhook took over 8 s — answered, still finishing'))
      .catch((err) => {
        logger.error({ err: err?.stack || err }, 'Meta webhook handling failed — Meta will retry');
        res.sendStatus(500);
      });
  });
}

const unknownNoted = new Set();

/** Hand each change to the Cloud number it belongs to (by phone number id). */
export async function dispatch(body) {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        const pid = v.metadata?.phone_number_id;
        const s = findCloudSession(pid);
        if (!s && !manager.sessions.size) throw new Error('Hub still starting'); // 500 → Meta delivers again shortly
        if (!s) {
          if (!unknownNoted.has(pid)) {
            unknownNoted.add(pid);
            await logEvent(null, 'warn', `Meta sent messages for phone number id ${pid}, which isn't added in the hub (Numbers → Add → Meta Cloud API)`);
          }
          continue;
        }
        // In order with this number's other work, but errors reach us (so Meta is told to retry).
        const run = s.work.then(() => s.onWebhook(v));
        s.work = run.catch(() => {});
        await run;
      } else if (ch.field === 'message_template_status_update') {
        const s = findCloudSession(null, entry.id);
        await logMetaEvent(s?.id || null, 'template', { status: v.event, payload: v });
        await logEvent(s?.id || null, v.event === 'APPROVED' ? 'info' : 'warn', `Meta template "${v.message_template_name}" (${v.message_template_language}): ${String(v.event).toLowerCase()}${v.reason && v.reason !== 'NONE' ? ` — ${v.reason}` : ''}`);
        if (s) await import('./wa/cloud-templates.js').then((t) => t.syncTemplates(s.wabaId)).catch(() => {});
      } else if (ch.field === 'phone_number_quality_update' || ch.field === 'account_update' || ch.field === 'phone_number_name_update') {
        const s = findCloudSession(null, entry.id);
        await logMetaEvent(s?.id || null, 'account', { status: ch.field, payload: v });
        await logEvent(s?.id || null, 'warn', `Meta ${ch.field.replace(/_/g, ' ')}: ${JSON.stringify(v).slice(0, 300)}`);
        if (s) await s.refreshHealth().catch(() => {});
      }
    }
  }
}

function findCloudSession(phoneNumberId, wabaId) {
  for (const s of manager.sessions.values()) {
    if (!s.isCloud) continue;
    if (phoneNumberId && s.phoneNumberId === String(phoneNumberId)) return s;
    if (!phoneNumberId && wabaId && s.wabaId === String(wabaId)) return s;
  }
  return null;
}
