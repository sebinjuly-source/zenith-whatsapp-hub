/**
 * A number on Meta's WhatsApp Cloud API (provider = 'cloud'). Behaves like a linked number for the rest of the hub —
 * same inbox, contacts, lists, rules, outbox and AI tools — but talks to Meta over HTTPS instead of a phone link:
 *  - sending: POST /{phone-number-id}/messages (text, files uploaded to Meta first, replies quote, templates)
 *  - receiving: Meta calls /meta/webhook → onWebhook() (messages, delivery statuses, errors)
 *  - setup on start: registers the number (META_PIN), subscribes the WhatsApp account and the app's webhook.
 * Rules Meta enforces and the hub checks first: free-form messages only within 24 h of the person's last message;
 * outside it only an approved template (payload.waTemplate).
 */
import { Session } from './session.js';
import { query, logEvent } from '../db.js';
import config from '../config.js';
import * as store from '../store.js';
import { graph, uploadCloudMedia, downloadCloudMedia, explainMetaError, metaToken } from './graph.js';
import { buildTemplateMessage, syncTemplates } from './cloud-templates.js';
import { refreshTask } from '../tasks.js';
import { postWebhook } from '../notify.js';

const WINDOW_SEC = 24 * 3600;
// Events the hub wants from Meta: messages + statuses, template approvals, quality and account alerts.
const WEBHOOK_FIELDS = ['messages', 'message_template_status_update', 'phone_number_quality_update', 'account_update'];
const STATUS = { sent: 2, delivered: 3, read: 4 }; // same scale as linked numbers (0 failed … 4 read)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jidOf = (waId) => `${String(waId).replace(/\D/g, '')}@s.whatsapp.net`;

export const cloudConfigured = () => !!metaToken();

/** Keep what Meta told us (14 days) so "why didn't X get it?" has an answer. Never throws. */
export async function logMetaEvent(accountId, kind, { wamid = null, peer = null, status = null, payload = {} } = {}) {
  try {
    await query(`INSERT INTO meta_events (account_id, kind, wamid, peer, status, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
      [accountId, kind, wamid, peer ? String(peer).replace(/@.*/, '') : null, status, JSON.stringify(payload)]);
    if (Math.random() < 0.01) await query(`DELETE FROM meta_events WHERE created_at < now() - interval '14 days'`);
  } catch {
    /* debugging aid only */
  }
}

/** Meta's "can this number send?" in plain words, from health_status (AVAILABLE / LIMITED / BLOCKED + reasons). */
export function describeMessagingHealth(hs) {
  if (!hs) return null;
  const names = { PHONE_NUMBER: 'Phone number', WABA: 'WhatsApp account', BUSINESS: 'Business portfolio', APP: 'App', MESSAGE_TEMPLATE: 'Template' };
  const rank = (e) => (e.can_send_message === 'BLOCKED' ? 0 : e.can_send_message === 'LIMITED' ? 1 : 2);
  const issues = (hs.entities || []).filter((e) => e.can_send_message && e.can_send_message !== 'AVAILABLE').sort((a, b) => rank(a) - rank(b))
    .map((e) => {
      const why = e.additional_info?.length ? e.additional_info.join(' ')
        : e.errors?.length ? [e.errors[0].error_description, e.errors[0].possible_solution].filter(Boolean).join(' — ') : 'see WhatsApp Manager';
      const payment = /payment/i.test(why) ? ' (templates to new people are blocked; replies within 24 h still work)' : '';
      return `${names[e.entity_type] || e.entity_type}: ${e.can_send_message.toLowerCase()} — ${why}${payment}`;
    });
  return { canSend: hs.can_send_message || 'UNKNOWN', issues };
}

export class CloudSession extends Session {
  get isCloud() {
    return true;
  }

  get phoneNumberId() {
    return this.account.cloud?.phoneNumberId || process.env.META_PHONE_NUMBER_ID || null;
  }

  get wabaId() {
    return this.account.cloud?.wabaId || process.env.META_WABA_ID || null;
  }

  info() {
    return { ...super.info(), provider: 'cloud', cloud: this.health || this.account.cloud?.health || null, error: this.status === 'open' ? null : this.lastError || null };
  }

  async canAutoStart() {
    return true;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async doStart() {
    this.stopping = false;
    clearTimeout(this.retryTimer);
    if (!metaToken() || !this.phoneNumberId) {
      this.lastError = !metaToken() ? 'META_TOKEN is not set in Render' : 'No phone number ID (META_PHONE_NUMBER_ID)';
      return this.setStatus('not_configured');
    }
    this.setStatus('connecting');
    try {
      await this.setup();
      this.lastError = null;
      this.retries = 0;
      clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => this.refreshHealth().catch(() => {}), 60 * 60 * 1000);
      this.healthTimer.unref?.();
    } catch (err) {
      this.lastError = err.message;
      await logEvent(this.id, 'error', `Meta Cloud API: ${err.message}`);
      this.setStatus('error');
      const delay = Math.min(30 * 60000, 60000 * 2 ** Math.min(this.retries++, 5));
      this.retryTimer = setTimeout(() => !this.stopping && this.start(), delay);
      this.retryTimer.unref?.();
    }
  }

  /** Make the number ready: registered on the Cloud API, the WhatsApp account and the app subscribed to our webhook. */
  async setup() {
    let h = await this.refreshHealth();
    if (h.platform_type !== 'CLOUD_API' || h.status === 'PENDING' || h.status === 'DISCONNECTED') {
      const pin = process.env.META_PIN;
      if (!pin) throw new Error('The number is not registered yet and META_PIN (6-digit two-step PIN) is not set in Render');
      await graph(`${this.phoneNumberId}/register`, { method: 'POST', json: { messaging_product: 'whatsapp', pin: String(pin) }, idempotent: true });
      await logEvent(this.id, 'info', `Registered +${(h.display_phone_number || '').replace(/\D/g, '')} on the Meta Cloud API`);
      await sleep(2000);
      h = await this.refreshHealth();
    }
    if (this.wabaId) {
      await graph(`${this.wabaId}/subscribed_apps`, { method: 'POST', idempotent: true });
      await syncTemplates(this.wabaId).catch((err) => logEvent(this.id, 'warn', `Template sync failed: ${err.message}`));
    }
    await this.ensureAppWebhook().catch((err) => logEvent(this.id, 'warn', `Webhook setup: ${err.message}`));
    const phone = String(h.display_phone_number || '').replace(/\D/g, '');
    await query('UPDATE accounts SET phone = $2, wa_name = COALESCE($3, wa_name), last_connected_at = now() WHERE id = $1', [this.id, phone || null, h.verified_name || null]);
    this.account.phone = phone || this.account.phone;
    this.account.wa_name = h.verified_name || this.account.wa_name;
    if (this.status !== 'open') await logEvent(this.id, 'info', `Meta Cloud API ready as +${phone} (${h.verified_name || 'name pending'}; quality ${h.quality_rating || '?'})`);
    this.setStatus('open');
  }

  /** Number health from Meta: quality, name approval, messaging tier. Saved so the dashboard can show it. */
  async refreshHealth() {
    const base = 'display_phone_number,verified_name,quality_rating,name_status,code_verification_status,status,platform_type,messaging_limit_tier,throughput';
    // health_status needs a newer permission set; fall back to the basic fields if Meta refuses it
    const h = await graph(this.phoneNumberId, { params: { fields: `${base},health_status` } })
      .catch(() => graph(this.phoneNumberId, { params: { fields: base } }));
    const prev = this.health;
    const mh = describeMessagingHealth(h.health_status);
    this.health = {
      displayPhone: h.display_phone_number, verifiedName: h.verified_name, quality: h.quality_rating, nameStatus: h.name_status,
      status: h.status, platform: h.platform_type, tier: h.messaging_limit_tier, throughput: h.throughput?.level,
      canSend: mh?.canSend || null, issues: mh?.issues || [], checkedAt: new Date().toISOString(),
    };
    await query(`UPDATE accounts SET cloud = jsonb_set(cloud, '{health}', $2::jsonb) WHERE id = $1`, [this.id, JSON.stringify(this.health)]);
    if (prev?.quality && prev.quality !== this.health.quality) {
      await logEvent(this.id, this.health.quality === 'RED' ? 'error' : 'warn', `Meta quality rating changed: ${prev.quality} → ${this.health.quality}`);
    }
    if (mh && prev?.canSend !== mh.canSend && (prev?.canSend || mh.canSend !== 'AVAILABLE')) {
      await logEvent(this.id, mh.canSend === 'AVAILABLE' ? 'info' : 'warn', `Meta says this number can send: ${mh.canSend}${mh.issues.length ? ' — ' + mh.issues.join('; ') : ''}`);
    }
    this.emit('change', this.info());
    return h;
  }

  /**
   * Full health check (the checks Kapso's observe-whatsapp runs, done directly against Meta): token and number
   * access, registration, messaging health (AVAILABLE/LIMITED/BLOCKED + why), name, quality, WABA and app webhook
   * subscriptions, last event received, templates, failures and billable messages. Each check: { name, ok, level, detail }.
   */
  async healthCheck() {
    const checks = [];
    const add = (name, ok, detail, level = ok ? 'ok' : 'bad') => checks.push({ name, ok, level, detail });
    let h = null;
    try {
      h = await this.refreshHealth();
      add('Token and number access', true, `Meta answers for +${String(h.display_phone_number || '').replace(/\D/g, '')}`);
    } catch (err) {
      add('Token and number access', false, err.message);
      return { status: 'unhealthy', checks, checkedAt: new Date().toISOString() };
    }
    const c = this.health;
    add('Registered on the Cloud API', c.platform === 'CLOUD_API' && c.status === 'CONNECTED', `${c.platform || '?'} / ${c.status || '?'}`);
    if (c.canSend) add('Can send messages (Meta)', c.canSend === 'AVAILABLE', c.canSend === 'AVAILABLE' ? 'Available' : `${c.canSend}: ${c.issues.join('; ')}`, c.canSend === 'BLOCKED' ? 'bad' : c.canSend === 'AVAILABLE' ? 'ok' : 'warn');
    add('Display name', c.nameStatus === 'APPROVED' || c.nameStatus === 'AVAILABLE_WITHOUT_REVIEW', `"${c.verifiedName}" — ${String(c.nameStatus || '?').toLowerCase().replace(/_/g, ' ')}`, 'warn');
    add('Quality rating', c.quality !== 'RED', c.quality || 'unknown', c.quality === 'RED' ? 'bad' : c.quality === 'YELLOW' ? 'warn' : 'ok');
    add('Daily limit (new people)', true, c.tier || 'unknown');
    if (this.wabaId) {
      const subs = await graph(`${this.wabaId}/subscribed_apps`).catch((e) => ({ error: e.message }));
      add('WhatsApp account sends events to the app', !subs.error && (subs.data || []).length > 0, subs.error || `${(subs.data || []).length} app(s) subscribed`);
    }
    const secret = process.env.META_APP_SECRET;
    if (secret && config.publicUrl) {
      try {
        const appId = process.env.META_APP_ID || (await graph('app', { params: { fields: 'id' } })).id;
        const subs = await graph(`${appId}/subscriptions`, { token: `${appId}|${secret}` });
        const wa = (subs.data || []).find((s) => s.object === 'whatsapp_business_account');
        const want = `${config.publicUrl}/meta/webhook`;
        add('App webhook points to the hub', !!wa?.active && wa.callback_url === want, wa ? `${wa.callback_url} (${wa.active ? 'active' : 'inactive'})` : 'not set');
      } catch (err) {
        add('App webhook points to the hub', false, err.message, 'warn');
      }
    } else add('App webhook points to the hub', false, 'META_APP_SECRET or PUBLIC_URL missing — cannot check', 'warn');
    const [last] = await query(`SELECT max(created_at) AS at FROM meta_events WHERE account_id = $1 AND kind IN ('in','status')`, [this.id]);
    add('Last event from Meta', !!last?.at, last?.at ? new Date(last.at).toISOString() : 'none in 14 days — send a message to the number to test', last?.at ? 'ok' : 'warn');
    const tpl = await query(`SELECT status, count(*)::int n FROM wa_templates WHERE waba_id = $1 GROUP BY status`, [this.wabaId]);
    const approved = tpl.find((t) => t.status === 'APPROVED')?.n || 0;
    add('Approved templates', approved > 0, tpl.map((t) => `${t.n} ${t.status.toLowerCase()}`).join(', ') || 'none', approved > 0 ? 'ok' : 'warn');
    const [fails] = await query(`SELECT count(*)::int n FROM meta_events WHERE account_id = $1 AND kind IN ('status','send_error') AND status IN ('failed') AND created_at > now() - interval '24 hours'`, [this.id]);
    add('Failed messages (24 h)', fails.n === 0, String(fails.n), fails.n ? 'warn' : 'ok');
    const billed = await query(
      `SELECT payload->'pricing'->>'category' AS category, count(DISTINCT wamid)::int n FROM meta_events
       WHERE account_id = $1 AND kind = 'status' AND (payload->'pricing'->>'billable')::boolean AND created_at > now() - interval '14 days' GROUP BY 1`,
      [this.id],
    );
    add('Billable messages (14 days)', true, billed.map((b) => `${b.n} ${String(b.category || '?').toLowerCase()}`).join(', ') || 'none');
    const bad = checks.some((x) => x.level === 'bad');
    const warn = checks.some((x) => x.level === 'warn');
    return { status: bad ? 'unhealthy' : warn ? 'degraded' : 'healthy', checks, checkedAt: new Date().toISOString() };
  }

  /** Everything known about one message (wamid) or one person (phone): our outbox rows + Meta's events, in order. */
  async timeline(wamidOrPhone) {
    const q = String(wamidOrPhone).trim();
    const isWamid = q.startsWith('wamid.');
    const peer = isWamid ? null : q.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1');
    const events = await query(
      `SELECT created_at, kind, wamid, peer, status, payload FROM meta_events
       WHERE account_id = $1 AND (${isWamid ? 'wamid = $2' : 'peer = $2'}) ORDER BY created_at, id LIMIT 200`,
      [this.id, isWamid ? q : peer],
    );
    const out = await query(
      `SELECT id, status, error, created_at, sent_at, message_id, payload->'waTemplate'->>'name' AS tpl, left(payload->>'text', 60) AS text
       FROM outbox WHERE account_id = $1 AND ${isWamid ? 'message_id = $2' : `to_jid = $2 || '@s.whatsapp.net'`} ORDER BY id LIMIT 50`,
      [this.id, isWamid ? q : peer],
    );
    return { outbox: out, events };
  }

  /** Point the app's WhatsApp webhook at this hub (needs META_APP_SECRET; done once, then only checked). */
  async ensureAppWebhook() {
    const secret = process.env.META_APP_SECRET;
    const verify = process.env.META_VERIFY_TOKEN;
    if (!secret || !verify || !config.publicUrl) return;
    const appId = process.env.META_APP_ID || (await graph('app', { params: { fields: 'id' } })).id;
    const appToken = `${appId}|${secret}`;
    const callback = `${config.publicUrl}/meta/webhook`;
    const subs = await graph(`${appId}/subscriptions`, { token: appToken });
    const wa = (subs.data || []).find((s) => s.object === 'whatsapp_business_account');
    const have = new Set((wa?.fields || []).map((f) => f.name || f));
    if (wa?.active && wa.callback_url === callback && WEBHOOK_FIELDS.every((f) => have.has(f))) return;
    await graph(`${appId}/subscriptions`, {
      method: 'POST', token: appToken, idempotent: true,
      params: { object: 'whatsapp_business_account', callback_url: callback, verify_token: verify, fields: WEBHOOK_FIELDS.join(',') },
    });
    await logEvent(this.id, 'info', `Meta webhook connected: ${callback} (${WEBHOOK_FIELDS.join(', ')})`);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.healthTimer);
    await Promise.race([this.work, sleep(15000)]);
    this.setStatus('stopped');
  }

  async logout() {
    await this.stop();
  }

  async forgetLogin() {}

  async afterOpen() {}

  async fetchOlder() {
    throw new Error('Meta Cloud API numbers can\'t load older history — only messages since the number joined the API are here');
  }

  async runBackfill() {
    throw new Error('Not available on Meta Cloud API numbers');
  }

  // ---------------------------------------------------------------------------
  // 24-hour window
  // ---------------------------------------------------------------------------
  /** When this person last wrote to us (unix s), or null. */
  async lastIncomingTs(jid) {
    const [r] = await query('SELECT max(ts)::bigint AS ts FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me', [this.id, jid]);
    return r?.ts ? Number(r.ts) : null;
  }

  /** { open, closesAt } — free-form messages are allowed until closesAt. */
  async windowFor(jid) {
    const last = await this.lastIncomingTs(jid);
    const closes = last ? last + WINDOW_SEC : null;
    return { open: !!closes && closes > Date.now() / 1000 + 60, closesAt: closes ? new Date(closes * 1000).toISOString() : null };
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  /**
   * content: what outbox.buildContent gives ({ text } | { image|video|audio|document: Buffer, mimetype, fileName, caption }
   * | { waTemplate }). Returns { key: { id }, message } like a linked number.
   */
  async send(jid, content, { typingMs = 0, quoted } = {}) {
    if (this.status !== 'open') throw new Error(`Number "${this.id}" (Meta Cloud API) is not ready: ${this.lastError || this.status}`);
    if (jid.endsWith('@g.us')) throw new Error('Meta Cloud API numbers can\'t send to groups');
    const to = jid.split('@')[0];
    const msg = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    let row;
    if (content.waTemplate) {
      const t = await buildTemplateMessage(this.wabaId, content.waTemplate);
      Object.assign(msg, { type: 'template', template: t.template });
      row = { type: 'text', body: t.preview };
    } else {
      const w = await this.windowFor(jid);
      if (!w.open) {
        const e = new Error(w.closesAt
          ? 'More than 24 hours since this person last wrote — WhatsApp only allows an approved template now'
          : 'This person has never written to this number — the first message must be an approved template');
        e.code = 'WINDOW_CLOSED';
        throw e;
      }
      if (typingMs > 0) await this.showTyping(jid, typingMs);
      let kind = ['image', 'video', 'audio', 'document'].find((k) => content[k]);
      if (kind) {
        // Meta's limits: images JPEG/PNG ≤ 5 MB, video/audio ≤ 16 MB, documents ≤ 100 MB. Anything else that can still
        // go goes as a document (e.g. a WEBP/HEIC photo or a big image), instead of failing at Meta.
        const size = content[kind].length;
        const mime = content.mimetype || '';
        if (kind === 'image' && (!/^image\/(jpe?g|png)$/.test(mime) || size > 5 * 1024 * 1024)) kind = 'document';
        if ((kind === 'video' || kind === 'audio') && size > 16 * 1024 * 1024) kind = 'document';
        if (kind === 'video' && !/^video\/(mp4|3gpp)$/.test(mime)) kind = 'document';
        if (size > 100 * 1024 * 1024) throw new Error('File is larger than 100 MB — WhatsApp won\'t accept it');
        if (kind === 'document' && !content.document) {
          content = { document: content.image || content.video || content.audio, mimetype: mime, caption: content.caption, fileName: content.fileName || `file.${mime.split('/')[1] || 'bin'}` };
        }
      }
      if (kind) {
        const id = await uploadCloudMedia(this.phoneNumberId, { buffer: content[kind], mimetype: content.mimetype, fileName: content.fileName });
        const media = { id };
        if (kind !== 'audio' && content.caption) media.caption = content.caption;
        if (kind === 'document') media.filename = content.fileName || 'file';
        Object.assign(msg, { type: kind, [kind]: media });
        row = { type: kind, body: content.caption || (kind === 'document' ? content.fileName : null), media: { kind: `${kind}Message`, mimetype: content.mimetype, fileName: content.fileName || null, cloudId: id } };
      } else {
        const body = String(content.text || '');
        if (!body.trim()) throw new Error('Empty message');
        const buttons = (content.buttons || []).map((b) => String(b).trim()).filter(Boolean).slice(0, 3);
        if (buttons.length) {
          // Tap-to-reply buttons (max 3, 20 characters each) — the tap comes back as their reply.
          Object.assign(msg, { type: 'interactive', interactive: { type: 'button', body: { text: body.slice(0, 1024) },
            action: { buttons: buttons.map((t, i) => ({ type: 'reply', reply: { id: `b${i + 1}`, title: t.slice(0, 20) } })) } } });
          row = { type: 'text', body: `${body}\n[${buttons.join(' | ')}]` };
        } else {
          Object.assign(msg, { type: 'text', text: { body: body.slice(0, 4096), preview_url: /https?:\/\//i.test(body) } });
          row = { type: 'text', body };
        }
      }
    }
    if (quoted?.key?.id) msg.context = { message_id: quoted.key.id };
    let r;
    try {
      r = await graph(`${this.phoneNumberId}/messages`, { method: 'POST', json: msg });
    } catch (err) {
      await logMetaEvent(this.id, 'send_error', { peer: to, status: 'failed', payload: { code: err.code, error: err.message, type: msg.type, template: msg.template?.name } });
      throw err;
    }
    const id = r.messages?.[0]?.id;
    await logMetaEvent(this.id, 'out', { wamid: id, peer: to, status: r.messages?.[0]?.message_status || 'accepted', payload: { type: msg.type, template: msg.template?.name } });
    if (!id) throw new Error('Meta accepted the request but returned no message id');
    // Meta may answer with the number in its canonical form (e.g. a different digit count): keep the chat we used.
    const quotedBody = quoted?.message?.conversation ? String(quoted.message.conversation).slice(0, 300) : null;
    await store.insertMessages(this.id, [{
      id, fromMe: true, ts: Math.floor(Date.now() / 1000), chatJid: jid, senderJid: null, senderName: 'me', type: row.type,
      body: row.body ?? null, quotedId: quoted?.key?.id || null, quotedBody, forwarded: false, media: row.media || null,
      vcards: null, status: 1, fromHistory: false,
    }]);
    return { key: { id, remoteJid: jid, fromMe: true }, message: msg };
  }

  /** "typing…" (also marks their last message read). Meta shows it up to 25 s, so it's capped. */
  async showTyping(jid, ms) {
    const [last] = await query('SELECT id FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me ORDER BY ts DESC LIMIT 1', [this.id, jid]);
    if (!last) return;
    await graph(`${this.phoneNumberId}/messages`, {
      method: 'POST', idempotent: true,
      json: { messaging_product: 'whatsapp', status: 'read', message_id: last.id, typing_indicator: { type: 'text' } },
    }).catch(() => {});
    await sleep(Math.min(ms, 20000) * config.timeScale);
  }

  async downloadMedia(row) {
    const id = row.media?.cloudId;
    if (!id) throw new Error('No Meta file id on this message');
    return (await downloadCloudMedia(id)).buffer;
  }

  // ---------------------------------------------------------------------------
  // Webhook (one "value" of entry[].changes[] with field = messages)
  // ---------------------------------------------------------------------------
  async onWebhook(value) {
    const names = new Map((value.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || null]));
    if (names.size) await store.upsertContacts(this.id, [...names].map(([w, n]) => ({ jid: jidOf(w), notify: n })));
    const incoming = [];
    for (const m of value.messages || []) {
      await logMetaEvent(this.id, 'in', { wamid: m.id, peer: m.from, status: m.type, payload: m });
      const r = await this.rowFromCloud(m, names);
      if (r) incoming.push(r);
    }
    if (incoming.length) {
      // Meta re-sends a webhook it thinks we missed: store and react to each message only once.
      const known = new Set((await query('SELECT id FROM messages WHERE account_id = $1 AND id = ANY($2::text[])', [this.id, incoming.map((r) => r.id)])).map((r) => r.id));
      const fresh = incoming.filter((r) => !known.has(r.id));
      await store.insertMessages(this.id, fresh);
      for (const r of fresh) {
        this.emit('incoming', r);
        this.afterIncoming(r).catch((err) => this.log.warn({ err: err.message }, 'post-incoming step failed'));
      }
    }
    for (const s of value.statuses || []) await this.onCloudStatus(s);
  }

  /** One Cloud API message → a stored row (or null for reactions etc., which are applied directly). */
  async rowFromCloud(m, names) {
    const chatJid = jidOf(m.from);
    const base = {
      id: m.id, fromMe: false, ts: Number(m.timestamp) || Math.floor(Date.now() / 1000), chatJid, senderJid: chatJid,
      senderName: names.get(String(m.from)) || null, quotedId: m.context?.id || null, quotedBody: null,
      forwarded: !!(m.context?.forwarded || m.context?.frequently_forwarded), forwardScore: m.context?.frequently_forwarded ? 5 : m.context?.forwarded ? 1 : 0,
      media: null, vcards: null, status: null, fromHistory: false, type: 'text', body: null,
    };
    if (base.quotedId) {
      const [q] = await query('SELECT body, type FROM messages WHERE account_id = $1 AND id = $2 LIMIT 1', [this.id, base.quotedId]);
      base.quotedBody = q ? (q.body || `[${q.type}]`).slice(0, 300) : null;
    }
    const t = m.type;
    if (t === 'reaction') {
      if (m.reaction?.message_id) await store.applyReaction(this.id, m.reaction.message_id, chatJid, m.reaction.emoji || '');
      return null;
    }
    if (t === 'text') return { ...base, body: m.text?.body || '' };
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(t)) {
      const f = m[t] || {};
      return {
        ...base,
        type: t === 'audio' && f.voice ? 'voice' : t,
        body: f.caption || f.filename || null,
        media: { kind: `${t}Message`, cloudId: f.id, mimetype: f.mime_type || null, fileName: f.filename || null, sha256: f.sha256 || null, size: null },
      };
    }
    if (t === 'button') return { ...base, body: m.button?.text || m.button?.payload || '' };
    if (t === 'interactive') {
      const i = m.interactive || {};
      return { ...base, body: i.button_reply?.title || i.list_reply?.title || i.nfm_reply?.body || '[form reply]' };
    }
    if (t === 'location') {
      const l = m.location || {};
      return { ...base, type: 'location', body: `Location: ${l.name ? l.name + ' ' : ''}${l.address ? l.address + ' ' : ''}(${l.latitude}, ${l.longitude})` };
    }
    if (t === 'contacts') {
      const vcards = (m.contacts || []).map((c) => ({ name: c.name?.formatted_name || '', phones: (c.phones || []).map((p) => p.wa_id || String(p.phone || '').replace(/\D/g, '')).filter(Boolean) }));
      return { ...base, type: 'contact', vcards, body: `Shared contact: ${vcards.map((v) => `${v.name} ${v.phones.join(', ')}`).join('; ')}` };
    }
    if (t === 'order') return { ...base, type: 'order', body: `Order: ${(m.order?.product_items || []).length} item(s)` };
    if (t === 'system') return { ...base, type: 'system', body: m.system?.body || 'System message' };
    // unsupported / unknown: keep a visible marker with Meta's reason
    return { ...base, type: t || 'unsupported', body: m.errors?.length ? `[${explainMetaError(m.errors[0])}]` : `[${t || 'unsupported'} message]` };
  }

  /**
   * Delivery status from Meta. It can arrive before the send has been recorded (Meta is quick, our database write
   * comes after its answer), so a status that finds nothing is tried again a little later.
   */
  async onCloudStatus(s, late = false) {
    if (!s?.id) return;
    if (!late) await logMetaEvent(this.id, 'status', { wamid: s.id, peer: s.recipient_id, status: s.status, payload: s });
    const retryLater = () => {
      if (late) return;
      const t = setTimeout(() => this.enqueue(() => this.onCloudStatus(s, true)), 15000 * Math.max(config.timeScale, 0.01));
      t.unref?.();
    };
    if (s.status === 'failed') {
      const reason = s.errors?.length ? explainMetaError(s.errors[0]) : 'Meta reported the message as not delivered';
      const msg = await query('UPDATE messages SET status = 0 WHERE account_id = $1 AND id = $2 RETURNING id', [this.id, s.id]);
      const rows = await query(
        `UPDATE outbox SET status = 'failed', error = $3 WHERE account_id = $1 AND message_id = $2 AND status = 'sent'
         RETURNING id, task_id, list_id, to_jid`,
        [this.id, s.id, reason],
      );
      if (!rows.length && !late) {
        const [o] = await query(`SELECT 1 FROM outbox WHERE account_id = $1 AND message_id = $2`, [this.id, s.id]);
        if (!o) return retryLater(); // the send isn't recorded yet
      }
      if (!msg.length && !rows.length) return;
      await logEvent(this.id, 'warn', `Message to ${s.recipient_id || rows[0]?.to_jid?.split('@')[0] || '?'} was not delivered: ${reason}`);
      if (rows[0]?.task_id) await refreshTask(rows[0].task_id).catch(() => {});
      if (rows[0]?.list_id) import('../lists.js').then((l) => l.refreshList(rows[0].list_id)).catch(() => {});
      const url = this.settings.webhookUrl;
      if (url) postWebhook(url, { event: 'message.failed', account: this.id, to: s.recipient_id, id: s.id, reason, ts: Number(s.timestamp) || Math.floor(Date.now() / 1000) });
      return;
    }
    const n = STATUS[s.status];
    if (!n) return;
    const hit = await query('UPDATE messages SET status = GREATEST(COALESCE(status, 0), $3) WHERE account_id = $1 AND id = $2 RETURNING id', [this.id, s.id, n]);
    if (!hit.length) retryLater();
  }
}
