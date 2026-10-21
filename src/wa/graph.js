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
};

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
