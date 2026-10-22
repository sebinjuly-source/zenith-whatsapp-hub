/**
 * Small client for Meta's Graph API (WhatsApp Cloud API).
 * Env: META_TOKEN (system-user token), META_GRAPH_VERSION (default v24.0), META_GRAPH_URL (tests point it at a fake).
 * Retries only what is safe: reads, and sends Meta refused for rate reasons (those were never sent).
 */
import logger from '../logger.js';

export const graphBase = () => `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/+$/, '')}/${process.env.META_GRAPH_VERSION || 'v24.0'}`;
export const metaToken = () => process.env.META_TOKEN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Meta error codes → what it means for you (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const EXPLAIN = {
  0: 'Meta could not authenticate the hub — check META_TOKEN in Render',
  190: 'The access token (META_TOKEN) is invalid or expired — generate a new system-user token and paste it into Render',
  10: 'The token lacks permission — give the system user full control of the app and the WhatsApp account, then regenerate the token',
  200: 'The token lacks permission — give the system user full control of the app and the WhatsApp account, then regenerate the token',
  368: 'Meta has temporarily restricted this WhatsApp account for policy reasons — see WhatsApp Manager',
  4: 'Too many calls to Meta right now — retrying later',
  80007: 'Meta rate limit for this WhatsApp account — retrying later',
  130429: 'Sending faster than Meta allows for this number — retrying later',
  409: 'Another message to this person was still being processed by Meta — retrying',
  1026: 'This person\'s WhatsApp can\'t receive this kind of message',
  141000: 'Meta reported an account problem — contact Meta Business Support',
  131000: 'Meta had an unexpected problem — try again',
  131005: 'Permission denied by Meta for this action',
  131008: 'A required field was missing in the message',
  131009: 'A value in the message was not accepted by Meta',
  131016: 'WhatsApp is temporarily unavailable — try again later',
  131021: 'You can\'t message your own number',
  131026: 'Not delivered: the number is not on WhatsApp, or the person has an old WhatsApp version / hasn\'t accepted the latest terms',
  131031: 'This WhatsApp account is locked by Meta — see WhatsApp Manager',
  131042: 'Payment problem on the WhatsApp account — add or fix the payment method in WhatsApp Manager',
  131045: 'The number isn\'t fully registered with Meta yet',
  131047: 'More than 24 hours since this person last wrote — only an approved template can be sent',
  131049: 'Meta held back this marketing message to protect engagement (too many marketing messages to this person recently) — try another day',
  131050: 'This person has stopped marketing messages from you',
  131051: 'This kind of message is not supported',
  131052: 'Could not download the file this person sent',
  131053: 'Could not upload the file to Meta (type or size not allowed)',
  131056: 'Too many messages to this one person in a short time — wait a bit',
  131057: 'The WhatsApp account is in maintenance mode',
  131058: 'Meta\'s sample "hello_world" template only works from test numbers — use one of your own approved templates',
  132000: 'The template\'s fill-in values don\'t match the template (count of {{1}}, {{2}} …)',
  132001: 'This template doesn\'t exist in that language, or isn\'t approved yet',
  132005: 'The filled-in template text is too long',
  132007: 'The template breaks a WhatsApp policy',
  132012: 'A template fill-in value has the wrong format',
  132015: 'The template is paused by Meta (low quality)',
  132016: 'The template is disabled by Meta (low quality)',
  133000: 'Registration of the number didn\'t finish — the hub will retry',
  133005: 'The two-step PIN (META_PIN) doesn\'t match the PIN on this number',
  133006: 'The number must be verified (SMS code) in WhatsApp Manager before it can be registered',
  133010: 'The number isn\'t registered with the Cloud API yet',
  133016: 'Too many registration attempts — Meta allows more in 72 hours',
  1: 'Meta could not process the request (invalid request or a Meta server problem)',
  2: 'Meta is temporarily down or overloaded',
  3: 'The app lacks a capability or permission for this',
  33: 'This business phone number was deleted from Meta',
  130403: 'You have blocked this person on WhatsApp',
  130472: 'Meta held this marketing message back as part of its marketing-message experiment (a small random group of people gets no marketing messages)',
  130497: 'Your WhatsApp account may not message people in this country',
  131037: 'The number has no approved display name yet',
  131048: 'Meta has limited sending from this number because people blocked or reported its messages as spam',
  131063: 'Marketing templates are switched off for this account on the Cloud API',
  131064: 'Sending is limited because templates were put in the wrong category (marketing sent as utility)',
  132018: 'A value filled into the template is not valid',
  132068: 'The WhatsApp Flow in this message is blocked',
  132069: 'The WhatsApp Flow was sent too often this hour',
  133004: 'Meta\'s server is temporarily unavailable',
  133008: 'Too many wrong two-step PIN attempts — wait before trying again',
  133009: 'The two-step PIN was entered too quickly',
  133015: 'This number was deleted recently — wait 5 minutes',
  135000: 'Meta could not process the request parameters',
  2388019: 'The account already has the maximum 250 templates — delete unused ones',
};

/**
 * What to do about each Meta error, and whether the hub retries it by itself (retry = { afterMin, max }).
 * Retries only where Meta says a later attempt can work; "don't retry" codes fail at once with advice.
 */
export const META_HELP = {
  131049: { todo: 'Nothing to do — the hub tries again after 25 hours (Meta asks to wait at least 24 h). Meta caps how many marketing messages one person gets from all businesses; pauses between our messages don\'t help. A utility template, or a reply after they write to you, isn\'t capped.', retry: { afterMin: 25 * 60, max: 2 } },
  131026: { todo: 'Call them, or check the number. Most often the number isn\'t on WhatsApp; sometimes their app is very old or they haven\'t accepted WhatsApp\'s latest terms.' },
  131050: { todo: 'Don\'t send marketing to them again. They can still get replies and utility messages.' },
  131047: { todo: 'Send an approved template instead — free text only works within 24 h of their last message.' },
  131048: { todo: 'Check the number\'s quality in WhatsApp Manager and slow down cold outreach; make messages more relevant so fewer people block.' },
  131056: { todo: 'Nothing to do — the hub tries again in an hour.', retry: { afterMin: 60, max: 3 } },
  130429: { todo: 'Nothing to do — the hub tries again shortly.', retry: { afterMin: 15, max: 3 } },
  131000: { todo: 'Nothing to do — the hub tries again in 30 minutes. If it keeps failing, contact Meta support.', retry: { afterMin: 30, max: 3 } },
  131016: { todo: 'Nothing to do — the hub tries again in 30 minutes.', retry: { afterMin: 30, max: 3 } },
  131057: { todo: 'Nothing to do — the hub tries again in 30 minutes.', retry: { afterMin: 30, max: 3 } },
  133004: { todo: 'Nothing to do — the hub tries again in 30 minutes.', retry: { afterMin: 30, max: 3 } },
  2: { todo: 'Nothing to do — the hub tries again in 30 minutes.', retry: { afterMin: 30, max: 3 } },
  130472: { todo: 'Nothing to do for this person now; Meta keeps a small group out of marketing messages. A utility template or a reply when they write is not affected.' },
  131042: { todo: 'Fix the payment method in WhatsApp Manager → Payment settings, then send again.' },
  131031: { todo: 'Open WhatsApp Manager → Account quality / Business support to see why the account is locked.' },
  368: { todo: 'Open WhatsApp Manager → Account quality to see the policy problem and appeal if it is wrong.' },
  132000: { todo: 'Fill every box of the template ({{1}}, {{2}} …) and send again.' },
  132001: { todo: 'Check the template name and language, and that Meta has approved it (Sync templates).' },
  132007: { todo: 'Edit the template wording (no misleading or banned content) and submit it again.' },
  132012: { todo: 'Check each fill-in value matches what the template expects.' },
  132015: { todo: 'Meta paused the template for low quality (3 h, then 6 h; the third time it is disabled). Improve the wording or use another template.' },
  132016: { todo: 'Create a new template — this one is disabled for good.' },
  131051: { todo: 'Send text, an image, a document or a template instead.' },
  131053: { todo: 'Use a JPG/PNG image (≤5 MB), a PDF/document (≤100 MB) or an MP4 video (≤16 MB).' },
  190: { todo: 'Generate a new system-user token in Meta Business Settings and paste it into Render (META_TOKEN).' },
  0: { todo: 'Generate a new system-user token in Meta Business Settings and paste it into Render (META_TOKEN).' },
};

/** Meaning + what to do for a code (for the dashboard and AI). */
export function metaHelp(code) {
  const c = Number(code);
  return { code: c, meaning: EXPLAIN[c] || null, ...(META_HELP[c] || {}) };
}

/** All codes the hub knows, for the dashboard's "what does this error mean" lines. */
export function metaHelpTable() {
  const out = {};
  for (const c of new Set([...Object.keys(EXPLAIN), ...Object.keys(META_HELP)])) out[c] = metaHelp(c);
  return out;
}

export class GraphError extends Error {
  constructor(httpStatus, body) {
    const e = body?.error || {};
    const details = e.error_data?.details;
    const plain = EXPLAIN[e.code];
    super(plain ? `${plain} (Meta ${e.code}${details ? `: ${details}` : ''})` : `Meta error ${e.code ?? httpStatus}: ${details || e.message || 'unknown'}`);
    this.httpStatus = httpStatus;
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.metaMessage = e.message;
  }
}

/** Explain an error object as Meta sends it inside webhooks ({ code, title, message, error_data }). */
export function explainMetaError(err = {}) {
  const details = err.error_data?.details || err.message || err.title;
  const plain = EXPLAIN[err.code];
  return plain ? `${plain} (Meta ${err.code})` : `Meta error ${err.code ?? '?'}: ${details || 'unknown'}`;
}

// Refused for pace reasons — never sent, so safe to retry (409 = another message to this person still in flight).
const RATE_CODES = new Set([4, 80007, 130429, 409]);

/**
 * graph('123/messages', { method: 'POST', json }) — returns parsed JSON or throws GraphError.
 * form: FormData (uploads). token: override (e.g. app token "appId|secret"). params: query string object.
 * idempotent: false for sends (never re-sent after an unclear failure).
 */
export async function graph(path, { method = 'GET', json, form, token, params, idempotent = method === 'GET', timeoutMs = 60000 } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${graphBase()}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
  const auth = token ?? metaToken();
  if (!auth) throw new Error('META_TOKEN is not set in Render — the Cloud API number can\'t work without it');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${auth}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No answer at all: a read can be repeated; a send may have gone out, so it is not repeated.
      if (idempotent && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`Could not reach Meta: ${err.message}${idempotent ? '' : ' — it may still have been sent; check the chat before resending'}`);
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (res.ok && !body.error) return body;
    const err = new GraphError(res.status, body);
    const rate = RATE_CODES.has(err.code) || res.status === 429;
    if ((rate || (idempotent && res.status >= 500)) && attempt < 2) {
      logger.warn({ path, code: err.code, attempt }, 'Meta asked us to slow down — retrying');
      await sleep(rate ? 4000 * (attempt + 1) : 1000 * (attempt + 1));
      continue;
    }
    throw err;
  }
}

/** Download a media file Meta holds for us (incoming files). Returns { buffer, mimetype }. */
export async function downloadCloudMedia(mediaId) {
  const info = await graph(mediaId);
  if (!info.url) throw new Error('Meta gave no download link for this file (older than 30 days?)');
  const res = await fetch(info.url, { headers: { Authorization: `Bearer ${metaToken()}` }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Downloading the file from Meta failed (${res.status})`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mimetype: info.mime_type || res.headers.get('content-type') };
}

/** Upload a file to Meta for sending; returns its media id. */
export async function uploadCloudMedia(phoneNumberId, { buffer, mimetype, fileName }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimetype);
  form.append('file', new Blob([buffer], { type: mimetype }), fileName || 'file');
  const r = await graph(`${phoneNumberId}/media`, { method: 'POST', form, idempotent: true, timeoutMs: 120000 });
  return r.id;
}
