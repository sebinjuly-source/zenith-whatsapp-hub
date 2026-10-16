/**
 * One WhatsApp number = one Session. Connects with Baileys, pulls the FULL chat history on first link,
 * keeps the database in sync with live messages, and sends messages.
 */
import { EventEmitter } from 'events';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
  downloadMediaMessage,
  toNumber,
  proto,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import logger from '../logger.js';
import config from '../config.js';
import { query, logEvent } from '../db.js';
import { useDbAuthState, clearAuthState, hasAuthState } from './auth-state.js';
import { parseMessage, mediaMessageFromRow } from './parse.js';
import * as store from '../store.js';
import { putMedia, mediaPath } from '../media.js';
import { normalizeSettings } from '../settings.js';

const SYNC_TYPE = proto.HistorySync.HistorySyncType;
const LEASE_SEC = 90;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Reject if a WhatsApp call doesn't finish in time, so nothing waits forever. */
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
let cachedVersion = null;

export class Session extends EventEmitter {
  constructor(account) {
    super();
    this.id = account.id;
    this.account = account;
    this.status = 'stopped'; // stopped | connecting | qr | open | logged_out | replaced | elsewhere
    this.qr = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.pairPhone = null;
    this.sock = null;
    this.retries = 0;
    this.stopping = false;
    this.work = Promise.resolve();
    this.sentCache = new Map(); // id -> proto message (for retries)
    this.groupCache = new Map();
    this.sync = { ...(account.sync || {}) };
    this.log = logger.child({ account: this.id });
  }

  get settings() {
    return normalizeSettings(this.account.settings);
  }

  get myJid() {
    return this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
  }

  info() {
    return {
      id: this.id,
      status: this.status,
      qr: this.status === 'qr' ? this.qrDataUrl : null,
      qrAt: this.status === 'qr' ? this.qrAt : null,
      pairingCode: this.status === 'qr' ? this.pairingCode : null,
      phone: this.account.phone,
      waName: this.account.wa_name,
      sync: this.sync,
    };
  }

  setStatus(status) {
    this.status = status;
    this.emit('change', this.info());
  }

  /** Gather small events for 300 ms and write them in one go (one DB round trip instead of hundreds). */
  collect(kind, items, handler) {
    this.batches ||= {};
    const b = (this.batches[kind] ||= { items: [], scheduled: false });
    b.items.push(...(items || []));
    if (b.scheduled) return;
    b.scheduled = true;
    setTimeout(() => {
      b.scheduled = false;
      const list = b.items.splice(0);
      if (list.length) this.enqueue(() => handler(list));
    }, 300);
  }

  /** Run DB work for this account one job at a time, in arrival order. */
  enqueue(fn) {
    this.work = this.work.then(fn).catch((err) => this.log.error({ err: err?.stack || err }, 'ingest error'));
    return this.work;
  }

  /** Claim this number for this server. Fails while another server holds a fresh lease. */
  async acquireLease() {
    const rows = await query(
      `UPDATE accounts SET lease_owner = $2, lease_until = now() + ($3 || ' seconds')::interval
       WHERE id = $1 AND (lease_owner IS NULL OR lease_owner = $2 OR lease_until < now()) RETURNING id`,
      [this.id, config.instanceId, String(LEASE_SEC)],
    );
    return rows.length > 0;
  }

  async releaseLease() {
    clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    await query('UPDATE accounts SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2', [
      this.id, config.instanceId,
    ]).catch(() => {});
  }

  async start({ pairPhone, linking = false } = {}) {
    this.stopping = false;
    clearTimeout(this.leaseRetry);
    if (!(await this.acquireLease())) {
      // Another server runs this number (e.g. the PC doing a first sync, or the old copy during a deploy).
      this.setStatus('elsewhere');
      this.leaseRetry = setTimeout(async () => {
        if (this.stopping) return;
        // Take over only a completed login — never start showing QR codes on our own.
        if (!linking && !(await hasAuthState(this.id))) return this.setStatus('stopped');
        this.start({ pairPhone, linking });
      }, 30000);
      return;
    }
    if (!this.leaseTimer) {
      this.leaseTimer = setInterval(async () => {
        if (!(await this.acquireLease().catch(() => true))) {
          await logEvent(this.id, 'warn', 'Another server took over this number — standing by.');
          await this.yieldToOther();
        }
      }, 30000);
    }
    this.pairPhone = pairPhone ? String(pairPhone).replace(/\D/g, '') : null;
    this.pairingCode = null;
    if (!cachedVersion) {
      try {
        cachedVersion = (await fetchLatestBaileysVersion()).version;
      } catch {
        cachedVersion = undefined; // use the version bundled with Baileys
      }
    }
    // Load the keys once per session; reconnects reuse the in-memory copy (it's the most current).
    if (!this.auth) this.auth = await useDbAuthState(this.id);
    const { state, saveCreds } = this.auth;
    await store.warmLidCache(this.id);
    this.setStatus('connecting');

    const sock = makeWASocket({
      version: cachedVersion,
      auth: { creds: state.creds, keys: state.keys },
      logger: this.log.child({ lib: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
      // A "Desktop" companion with requireFullSync asks the phone for the FULL history, not just recent chats.
      // (macOS/Windows Desktop currently get rejected with 428 at connect; Ubuntu Desktop is accepted.)
      browser: Browsers.ubuntu('Desktop'),
      syncFullHistory: this.settings.historyMode === 'full',
      // Always accept history notifications: they also carry the lid↔phone mappings Baileys needs.
      // With historyMode 'none' the old messages are simply not stored (see onHistory).
      shouldSyncHistoryMessage: () => true,
      qrTimeout: 45000, // keep each QR on screen long enough to open the scanner
      markOnlineOnConnect: false, // keep notifications on your phone
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.sentCache.get(key.id),
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    // Ignore late events from an old socket (e.g. its "closed" event arriving after a re-link).
    sock.ev.on('connection.update', (u) => {
      if (sock !== this.sock) return;
      this.onConnection(u).catch((e) => this.log.error({ err: e?.stack || e }, 'connection handler failed'));
    });
    sock.ev.on('messaging-history.set', (h) => this.enqueue(() => this.onHistory(h)));
    sock.ev.on('messaging-history.status', (s) => this.enqueue(() => this.onHistoryStatus(s)));
    sock.ev.on('messages.upsert', ({ messages, type }) =>
      this.enqueue(() => this.ingest(messages, { live: type === 'notify' })),
    );
    sock.ev.on('messages.update', (updates) => this.enqueue(() => this.onMessagesUpdate(updates)));
    // These can arrive as thousands of tiny events right after linking — collect them into batches.
    sock.ev.on('contacts.upsert', (c) => this.collect('contacts', c, (l) => this.saveContacts(l)));
    sock.ev.on('contacts.update', (c) => this.collect('contacts', c, (l) => this.saveContacts(l)));
    sock.ev.on('chats.upsert', (c) => this.collect('chats', c, (l) => this.saveChats(l)));
    sock.ev.on('chats.update', (c) => this.collect('chats', c, (l) => this.saveChats(l)));
    sock.ev.on('groups.upsert', (g) => this.enqueue(() => this.saveGroups(g)));
    sock.ev.on('groups.update', (g) => this.enqueue(() => this.saveGroups(g)));
    sock.ev.on('lid-mapping.update', (m) => this.collect('lids', [m], (l) => store.saveLidMappings(this.id, l)));
    sock.ev.on('blocklist.set', ({ blocklist }) => this.enqueue(() => store.resetBlocklist(this.id, blocklist)));
    sock.ev.on('blocklist.update', ({ blocklist, type }) =>
      this.enqueue(() => store.setBlocked(this.id, blocklist, type === 'add')),
    );
  }

  async onConnection({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.qr = qr;
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
      this.qrAt = Date.now();
      if (this.pairPhone && !this.pairingCode) {
        try {
          this.pairingCode = await this.sock.requestPairingCode(this.pairPhone);
          await logEvent(this.id, 'info', `Pairing code generated for ${this.pairPhone}`);
        } catch (err) {
          await logEvent(this.id, 'warn', `Pairing code failed: ${err.message} — scan the QR instead`);
        }
      }
      this.setStatus('qr');
    }
    if (connection === 'open') {
      this.retries = 0;
      this.qr = this.qrDataUrl = this.pairingCode = null;
      const phone = store.phoneOf(this.myJid);
      const waName = this.sock.user?.name || this.sock.user?.notify || null;
      await query('UPDATE accounts SET phone = $2, wa_name = COALESCE($3, wa_name), last_connected_at = now() WHERE id = $1', [
        this.id, phone, waName,
      ]);
      this.account.phone = phone;
      this.account.wa_name = waName || this.account.wa_name;
      this.setStatus('open');
      await logEvent(this.id, 'info', `Connected as +${phone}`);
      this.afterOpen().catch((err) => this.log.warn({ err: err.message }, 'post-connect sync failed'));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasWaitingForScan = this.status === 'qr';
      this.sock = null;
      if (this.stopping) return this.setStatus('stopped');
      if (wasWaitingForScan && code === DisconnectReason.timedOut) {
        // Nobody scanned in time — stop instead of generating QR codes forever.
        await logEvent(this.id, 'info', 'QR code expired. Click "Link" to get a new one.');
        return this.setStatus('stopped');
      }
      if (code === DisconnectReason.loggedOut) {
        await this.forgetLogin();
        await logEvent(this.id, 'warn', 'Logged out from the phone (Linked devices). Link again to reconnect.');
        return this.setStatus('logged_out');
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Another server/PC is running this same login. Back off so the two don't fight.
        await logEvent(this.id, 'warn', 'Session opened elsewhere (another server running this number?). Retrying in 5 min.');
        this.setStatus('replaced');
        return setTimeout(() => !this.stopping && this.start(), 5 * 60 * 1000);
      }
      const restart = code === DisconnectReason.restartRequired;
      const delay = restart ? 500 : Math.min(120000, 2000 * 2 ** Math.min(this.retries++, 6));
      if (!restart) await logEvent(this.id, 'warn', `Disconnected (${code || lastDisconnect?.error?.message}). Reconnecting in ${Math.round(delay / 1000)}s`);
      this.setStatus('connecting');
      setTimeout(() => !this.stopping && this.start(), delay);
    }
  }

  async afterOpen() {
    const groups = await this.sock.groupFetchAllParticipating().catch(() => ({}));
    await this.enqueue(() => this.saveGroups(Object.values(groups)));
    const blocked = await this.sock.fetchBlocklist().catch(() => null);
    if (blocked) await this.enqueue(() => store.resetBlocklist(this.id, blocked.filter(Boolean)));
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.leaseRetry);
    try {
      this.sock?.end(undefined);
    } catch {}
    this.sock = null;
    // Finish writing what already arrived (bounded, so a long import can't block shutdown).
    await Promise.race([this.work, sleep(15000)]);
    await this.auth?.flush();
    this.auth = null; // reload from the DB next time (another server may have used it meanwhile)
    await this.releaseLease();
    this.setStatus('stopped');
  }

  /** Another server holds the lease: disconnect here, keep keys saved, and keep checking (start() retries). */
  async yieldToOther() {
    clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    const sock = this.sock;
    this.sock = null; // so its close event is ignored
    try {
      sock?.end(undefined);
    } catch {}
    await this.auth?.flush();
    this.auth = null;
    await this.start(); // finds the lease taken → status "elsewhere" and retries every 30 s
  }

  async forgetLogin() {
    this.auth?.discard();
    this.auth = null;
    await clearAuthState(this.id);
  }

  /** Unlink this device from the phone and forget the login. Stored chats are kept. */
  async logout() {
    this.stopping = true;
    try {
      await this.sock?.logout();
    } catch {}
    this.sock = null;
    await this.forgetLogin();
    await this.releaseLease();
    this.setStatus('logged_out');
  }

  // -------------------------------------------------------------------------
  // History sync
  // -------------------------------------------------------------------------
  async onHistory({ chats, contacts, messages, lidPnMappings, syncType, progress }) {
    if (lidPnMappings?.length) await store.saveLidMappings(this.id, lidPnMappings);
    await this.saveContacts(contacts || []);
    const keepHistory = this.settings.historyMode !== 'none';
    if (keepHistory) await this.saveChats(chats || []);
    const stored = keepHistory ? await this.ingest(messages || [], { history: true }) : 0;
    const s = this.sync;
    s.state = 'syncing';
    s.chunks = (s.chunks || 0) + 1;
    s.messages = (s.messages || 0) + stored;
    s.chats = (s.chats || 0) + (chats?.length || 0);
    s.contacts = (s.contacts || 0) + (contacts?.length || 0);
    s.lastType = Object.keys(SYNC_TYPE).find((k) => SYNC_TYPE[k] === syncType) || String(syncType);
    if (progress != null) s.progress = progress;
    s.startedAt = s.startedAt || new Date().toISOString();
    s.updatedAt = new Date().toISOString();
    await this.saveSync();
    this.emit('change', this.info());
  }

  async onHistoryStatus({ syncType, status }) {
    const name = Object.keys(SYNC_TYPE).find((k) => SYNC_TYPE[k] === syncType) || String(syncType);
    this.sync.phases = { ...(this.sync.phases || {}), [name]: status };
    if (status === 'complete' && (name === 'FULL' || name === 'ON_DEMAND' || name === 'RECENT')) {
      this.sync.state = name === 'FULL' ? 'done' : this.sync.state;
    }
    this.sync.updatedAt = new Date().toISOString();
    await this.saveSync();
    await logEvent(this.id, 'info', `History sync ${name}: ${status}`);
    this.emit('change', this.info());
  }

  async saveSync() {
    await query('UPDATE accounts SET sync = $2 WHERE id = $1', [this.id, JSON.stringify(this.sync)]);
  }

  /** Ask the phone for older messages in one chat (arrive later as an ON_DEMAND history chunk). */
  async fetchOlder(chatJid, count = 50) {
    if (!this.sock) throw new Error('Not connected');
    const rows = await query(
      'SELECT id, from_me, ts FROM messages WHERE account_id = $1 AND chat_jid = $2 ORDER BY ts ASC LIMIT 1',
      [this.id, chatJid],
    );
    if (!rows[0]) throw new Error('No messages stored for this chat yet');
    const { id, from_me: fromMe, ts } = rows[0];
    return this.sock.fetchMessageHistory(Math.min(count, 50), { remoteJid: chatJid, id, fromMe }, ts);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  async ingest(messages, { history = false, live = false } = {}) {
    const rows = [];
    const seenContacts = [];
    const settings = this.settings;
    // Learn all lid↔phone pairs in this batch in one go, so the per-message lookups below hit the cache.
    const pairs = [];
    for (const msg of messages) {
      const k = msg.key || {};
      for (const [a, b] of [[k.remoteJid, k.remoteJidAlt], [k.participant, k.participantAlt]]) {
        if (a && b) pairs.push(a.endsWith('@lid') ? { lid: a, pn: b } : { lid: b, pn: a });
      }
    }
    await store.saveLidMappings(this.id, pairs.filter((p) => p.lid.endsWith('@lid') && p.pn.endsWith('@s.whatsapp.net')));
    for (const msg of messages) {
      try {
        const remote = msg.key?.remoteJid;
        if (!remote || isJidStatusBroadcast(remote) || isJidNewsletter(remote) || isJidBroadcast(remote)) continue;
        const isGroup = !!isJidGroup(remote);
        if (isGroup && !settings.storeGroups) continue;
        const parsed = parseMessage(msg);
        if (parsed.kind === 'skip') continue;
        const chatJid = isGroup ? remote : await store.canonicalJid(this.id, remote, msg.key.remoteJidAlt);
        if (parsed.kind === 'edit') {
          await store.applyEdit(this.id, parsed.targetId, parsed.body);
          continue;
        }
        if (parsed.kind === 'revoke') {
          await store.applyRevoke(this.id, parsed.targetId);
          continue;
        }
        const fromMe = !!msg.key.fromMe;
        const senderJid = fromMe
          ? this.myJid
          : isGroup
            ? await store.canonicalJid(this.id, msg.key.participant, msg.key.participantAlt)
            : chatJid;
        if (parsed.kind === 'reaction') {
          if (parsed.targetId) await store.applyReaction(this.id, parsed.targetId, fromMe ? 'me' : senderJid, parsed.emoji);
          continue;
        }
        const r = parsed.row;
        if (!fromMe && r.pushName && senderJid) seenContacts.push({ jid: senderJid, notify: r.pushName });
        rows.push({
          ...r,
          chatJid,
          senderJid,
          senderName: fromMe ? 'me' : r.pushName,
          fromHistory: history,
          status: r.status ?? (fromMe ? 2 : null),
        });
      } catch (err) {
        this.log.warn({ err: err.message, id: msg.key?.id }, 'could not parse message');
      }
    }
    if (seenContacts.length) await store.upsertContacts(this.id, seenContacts);
    await store.insertMessages(this.id, rows);
    if (live) {
      for (const r of rows) {
        if (r.fromMe) continue;
        this.emit('incoming', r);
        this.afterIncoming(r).catch((err) => this.log.warn({ err: err.message }, 'post-incoming step failed'));
      }
    }
    return rows.length;
  }

  async afterIncoming(r) {
    const settings = this.settings;
    // Opt-out replies ("stop", "not interested" …) tag the contact so campaigns skip them.
    if (r.body && !isJidGroup(r.chatJid)) {
      const text = r.body.trim().toLowerCase();
      if (settings.optOutWords.some((w) => text === w || (text.length < 60 && text.includes(w)))) {
        await store.updateContact(this.id, r.chatJid, { addTags: ['opted-out'] });
        await logEvent(this.id, 'info', `${r.chatJid.split('@')[0]} opted out ("${r.body.slice(0, 40)}")`);
      }
    }
    // Autosave media according to this account's settings.
    if (r.media) {
      const isImage = r.media.kind === 'imageMessage';
      const isDoc = r.media.kind === 'documentMessage';
      const wanted = (isImage && settings.autosaveImages) || (isDoc && settings.autosaveDocuments);
      const sizeOk = !r.media.size || r.media.size <= settings.autosaveMaxMb * 1024 * 1024;
      const notSpam = (r.forwardScore || 0) < 4;
      if (wanted && sizeOk && notSpam) {
        const known = !settings.autosaveKnownOnly || (await store.hasChattedWith(this.id, r.chatJid));
        if (known) await this.saveMedia(r.chatJid, r.id);
      }
    }
    // Notify an external webhook (e.g. Apps Script) if configured.
    if (settings.webhookUrl) {
      fetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'message', account: this.id, chat: r.chatJid, from: r.senderJid, name: r.senderName,
          type: r.type, text: r.body, ts: r.ts, id: r.id,
        }),
      }).catch(() => {});
    }
  }

  async onMessagesUpdate(updates) {
    for (const { key, update } of updates) {
      if (!key?.id) continue;
      if (typeof update?.status === 'number') await store.updateStatus(this.id, key.id, update.status);
      if (update?.message) {
        const parsed = parseMessage({ key, message: update.message });
        if (parsed.kind === 'edit') await store.applyEdit(this.id, parsed.targetId, parsed.body);
        if (parsed.kind === 'revoke') await store.applyRevoke(this.id, parsed.targetId);
      }
    }
  }

  async saveContacts(list) {
    const out = [];
    const ids = (c) => ({
      pn: c.phoneNumber || (c.id.endsWith('@s.whatsapp.net') ? c.id : null),
      lid: c.lid || (c.id.endsWith('@lid') ? c.id : null),
    });
    await store.saveLidMappings(this.id, (list || []).filter((c) => c?.id).map(ids).filter((m) => m.lid && m.pn));
    for (const c of list || []) {
      if (!c?.id) continue;
      const { pn, lid } = ids(c);
      const jid = pn ? jidNormalizedUser(pn) : await store.canonicalJid(this.id, c.id);
      if (!jid) continue;
      out.push({ jid, lid: lid ? jidNormalizedUser(lid) : null, name: c.name, notify: c.notify, verifiedName: c.verifiedName });
    }
    await store.upsertContacts(this.id, out);
  }

  async saveChats(list) {
    const out = [];
    await store.saveLidMappings(this.id, (list || []).filter((c) => c?.lidJid && c?.pnJid).map((c) => ({ lid: c.lidJid, pn: c.pnJid })));
    for (const c of list || []) {
      if (!c?.id || isJidStatusBroadcast(c.id) || isJidNewsletter(c.id) || isJidBroadcast(c.id)) continue;
      const isGroup = !!isJidGroup(c.id);
      if (isGroup && !this.settings.storeGroups) continue;
      const jid = isGroup ? c.id : await store.canonicalJid(this.id, c.id, c.pnJid);
      const ts = c.conversationTimestamp || c.lastMessageRecvTimestamp;
      out.push({
        jid,
        name: c.name || c.displayName || c.subject || null,
        isGroup,
        unread: c.unreadCount ?? undefined,
        archived: c.archived ?? undefined,
        lastTs: ts ? toNumber(ts) : null,
      });
    }
    await store.upsertChats(this.id, out);
  }

  async saveGroups(groups) {
    const out = [];
    for (const g of groups || []) {
      if (!g?.id) continue;
      if (g.participants) this.groupCache.set(g.id, g);
      out.push({ jid: g.id, name: g.subject || null, isGroup: true, participants: g.participants?.length ?? g.size ?? null });
    }
    if (this.settings.storeGroups) await store.upsertChats(this.id, out);
  }

  // -------------------------------------------------------------------------
  // Media & sending
  // -------------------------------------------------------------------------
  /** Download a message's media from WhatsApp and keep a copy. Returns the stored reference. */
  async saveMedia(chatJid, msgId) {
    const rows = await query('SELECT * FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [
      this.id, chatJid, msgId,
    ]);
    const row = rows[0];
    if (!row?.media) throw new Error('This message has no media');
    if (row.media_saved) return row.media_saved;
    const buffer = await this.downloadMedia(row);
    const ref = await putMedia(mediaPath(this.id, chatJid, msgId, row.media.mimetype, row.media.fileName), buffer, row.media.mimetype);
    await query('UPDATE messages SET media_saved = $4 WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [
      this.id, chatJid, msgId, ref,
    ]);
    return ref;
  }

  async downloadMedia(row) {
    const waMsg = mediaMessageFromRow(row);
    const ctx = this.sock ? { logger: this.log, reuploadRequest: this.sock.updateMediaMessage } : undefined;
    return downloadMediaMessage(waMsg, 'buffer', {}, ctx);
  }

  /**
   * Send one message. content is a Baileys content object ({ text } | { document, mimetype, fileName, caption } | …).
   * typingMs > 0 shows "typing…" first.
   */
  async send(jid, content, { typingMs = 0 } = {}) {
    if (!this.sock || this.status !== 'open') throw new Error(`Number "${this.id}" is not connected`);
    if (!isJidGroup(jid)) {
      const [check] = await withTimeout(this.sock.onWhatsApp(jid), 30000, 'Number check').catch(() => [null]);
      if (check && !check.exists) throw new Error(`${jid.split('@')[0]} is not on WhatsApp`);
    }
    if (typingMs > 0) {
      await this.sock.presenceSubscribe(jid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await sleep(typingMs);
      await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
    const sent = await withTimeout(this.sock.sendMessage(jid, content), 120000, 'Sending (it may still go out — check the chat before resending)');
    if (sent?.key?.id) {
      this.sentCache.set(sent.key.id, sent.message);
      if (this.sentCache.size > 500) this.sentCache.delete(this.sentCache.keys().next().value);
      // Record it now: WhatsApp's own "you sent this" event can be held back for a while during a sync.
      this.enqueue(() => this.ingest([sent])); // not awaited: a big history chunk in the queue must not delay sending
    }
    return sent;
  }
}
