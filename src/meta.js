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
    res.sendStatus(200);
    const s = summarize(req.body);
    logger.info(s, 'Meta webhook event');
  });
}
