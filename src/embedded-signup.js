/**
 * Meta's sign-up pop-up (Embedded Signup) for a Tech Provider app: a business clicks "Connect with Facebook" on the
 * Numbers page, picks or creates its WhatsApp account and number inside Meta's own window, and the hub gets a short
 * code. Here the code becomes that business's own token; the hub subscribes the Tech Provider app to its WhatsApp
 * account, registers the number with a fresh two-step PIN, and adds it as a Meta Cloud API number. The business pays
 * Meta directly (its own payment method in WhatsApp Manager).
 *
 * Render env (Tech Provider app, separate from META_APP_ID): META_ES_APP_ID, META_ES_CONFIG_ID (Facebook Login for
 * Business → Configurations), META_ES_APP_SECRET. The token and PIN are sealed (src/secretbox.js) before storing.
 * Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup
 */
import crypto from 'crypto';
import { graph, graphBase } from './wa/graph.js';
import { manager } from './wa/manager.js';
import { seal } from './secretbox.js';
import { logEvent } from './db.js';

export function signupConfig() {
  const appId = process.env.META_ES_APP_ID || '';
  const configId = process.env.META_ES_CONFIG_ID || '';
  const missing = [!appId && 'META_ES_APP_ID', !configId && 'META_ES_CONFIG_ID', !process.env.META_ES_APP_SECRET && 'META_ES_APP_SECRET'].filter(Boolean);
  return { ready: !missing.length, appId, configId, graphVersion: graphBase().split('/').pop(), missing };
}

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** The whole hand-over after Meta's window closed with FINISH. Returns the new account. */
export async function completeSignup({ code, phoneNumberId, wabaId, id, label, purpose = '' }) {
  const cfg = signupConfig();
  if (!cfg.ready) throw new Error(`Meta sign-up is not set up yet: add ${cfg.missing.join(', ')} in Render`);
  const pnid = digits(phoneNumberId);
  const waba = digits(wabaId);
  if (!code) throw new Error('Meta did not return a sign-up code — close the window and try again');
  if (!pnid || !waba) throw new Error('Meta did not say which number and WhatsApp account were chosen — finish every step in Meta\'s window');
  const secret = process.env.META_ES_APP_SECRET;
  // 1. Code → the business's own token (valid for this WhatsApp account only)
  const t = await graph('oauth/access_token', { token: `${cfg.appId}|${secret}`, params: { client_id: cfg.appId, client_secret: secret, code } });
  const token = t.access_token;
  if (!token) throw new Error('Meta gave no token for this sign-up — try connecting again');
  // 2. Check the token really reaches the number, and read its name for the label
  const num = await graph(pnid, { token, params: { fields: 'display_phone_number,verified_name' } });
  // 3. Our app gets this WhatsApp account's messages and statuses
  await graph(`${waba}/subscribed_apps`, { method: 'POST', token, idempotent: true });
  // 4. Add it; CloudSession.setup() registers the number with this PIN and syncs templates
  const pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const name = label || num.verified_name || `+${digits(num.display_phone_number)}`;
  const acc = await manager.create(
    { id: id || name, label: name, purpose, provider: 'cloud', cloud: { phoneNumberId: pnid, wabaId: waba } },
    { cloudSecrets: { token: seal(token), pin: seal(pin), appId: cfg.appId, via: 'embedded-signup' } },
  );
  await logEvent(acc.id, 'info', `Connected through Meta sign-up: +${digits(num.display_phone_number)} (${num.verified_name || 'name pending'})`);
  return acc;
}

export function mountEmbeddedSignup(api, { wrap, act }) {
  api.get('/meta/signup-config', (req, res) => {
    const { ready, appId, configId, graphVersion, missing } = signupConfig();
    res.json({ ready, appId, configId, graphVersion, missing });
  });
  api.post('/meta/signup', wrap(async (req, res) => {
    const acc = await completeSignup(req.body || {});
    await act(req, acc.id, `Connected a Meta number through the sign-up pop-up: "${acc.label}"`);
    res.json({ id: acc.id, label: acc.label, purpose: acc.purpose, provider: 'cloud' }); // never the sealed token
  }));
}
