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
import { postWebhook } from '../notify.js';
import { refreshTask } from '../tasks.js';

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

  get isCloud() {
    return false;
  }

  /** May the manager start this number by itself? Linked numbers: only with a saved login (never show QR codes unasked). */
  async canAutoStart() {
    return hasAuthState(this.id);
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
      reachout: this.reachout || null, // WhatsApp's own block on messaging new numbers, if any
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

  /** Connect (or wait for the lease). Overlapping calls (refresh timer, retries, the dashboard) run only once. */
  async start(opts = {}) {
    if (this.starting) return this.starting;
    this.starting = this.doStart(opts).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async doStart({ pairPhone, linking = false } = {}) {
    if (this.sock && !linking) return; // already connected/connecting
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
    // WhatsApp voice/video calls (as a linked device sees them): stored in the chat as a "call" line with the outcome
    sock.ev.on('call', (calls) => this.enqueue(() => this.onCalls(calls)));
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

  async onConnection({ connection, lastDisconnect, qr, reachoutTimeLock }) {
    if (reachoutTimeLock) await this.setReachout(reachoutTimeLock);
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
      this.linkedNow = true; // a QR/pairing code was shown in this session, so the next 'open' is a fresh link
      this.setStatus('qr');
    }
    if (connection === 'open') {
      this.retries = 0;
      this.qrRounds = 0;
      this.qr = this.qrDataUrl = this.pairingCode = null;
      const phone = store.phoneOf(this.myJid);
      const waName = this.sock.user?.name || this.sock.user?.notify || null;
      await query('UPDATE accounts SET phone = $2, wa_name = COALESCE($3, wa_name), last_connected_at = now() WHERE id = $1', [
        this.id, phone, waName,
      ]);
      this.account.phone = phone;
      this.account.wa_name = waName || this.account.wa_name;
      this.setStatus('open');
      if (this.linkedNow) {
        // First connection after a QR scan / pairing code
        const mode = { full: 'Full chat history', recent: 'Recent history only', none: 'No history (new messages only)' }[this.settings.historyMode];
        await logEvent(this.id, 'info', `Linked successfully as +${phone} — history: ${mode}`, 'you');
        this.linkedNow = false;
      } else await logEvent(this.id, 'info', `Connected as +${phone}`);
      this.afterOpen().catch((err) => this.log.warn({ err: err.message }, 'post-connect sync failed'));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasWaitingForScan = this.status === 'qr';
      this.sock = null;
      if (this.stopping) return this.setStatus('stopped');
      if (wasWaitingForScan && (code === DisconnectReason.timedOut || code === DisconnectReason.connectionClosed)) {
        // WhatsApp ends an unscanned pairing session after ~3.5 min. Start a fresh one (new codes) a few
        // times, then stop instead of generating QR codes forever.
        this.qrRounds = (this.qrRounds || 0) + 1;
        if (this.qrRounds >= 3) {
          this.qrRounds = 0;
          await logEvent(this.id, 'info', 'QR codes expired without a scan. Click "Link number" to try again.');
          return this.setStatus('stopped');
        }
        this.setStatus('connecting');
        return setTimeout(() => !this.stopping && this.start({ pairPhone: this.pairPhone, linking: true }), 500);
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

  /** Ask WhatsApp whether this number is currently blocked from starting new chats (checked on connect + hourly). */
  async checkReachout() {
    if (!this.sock?.fetchAccountReachoutTimelock) return;
    try {
      await this.setReachout(await this.sock.fetchAccountReachoutTimelock());
    } catch (err) {
      this.log.debug({ err: err.message }, 'reach-out check failed');
    }
  }

  async setReachout(r) {
    const until = r?.timeEnforcementEnds ? new Date(r.timeEnforcementEnds).toISOString() : null;
    const next = { isActive: !!r?.isActive, timeEnforcementEnds: until, checkedAt: new Date().toISOString() };
    const was = this.reachout?.isActive;
    this.reachout = next;
    if (next.isActive && !was) {
      const when = until ? new Date(until).toLocaleString('en-IN', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata' }) : 'unknown';
      await logEvent(this.id, 'warn', `WhatsApp says this number may not message new people until ${when}. Messages to new numbers wait; existing chats continue.`);
    } else if (!next.isActive && was) await logEvent(this.id, 'info', 'WhatsApp lifted the block on messaging new people.');
    this.emit('change', this.info());
  }

  async afterOpen() {
    await this.checkReachout();
    clearInterval(this.reachoutTimer);
    this.reachoutTimer = setInterval(() => this.status === 'open' && this.checkReachout(), 60 * 60 * 1000);
    this.reachoutTimer.unref?.();
    const groups = await this.sock.groupFetchAllParticipating().catch(() => ({}));
    await this.enqueue(() => this.saveGroups(Object.values(groups)));
    const blocked = await this.sock.fetchBlocklist().catch(() => null);
    if (blocked) await this.enqueue(() => store.resetBlocklist(this.id, blocked.filter(Boolean)));
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.leaseRetry);
    clearInterval(this.reachoutTimer);
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
    if (syncType === SYNC_TYPE.ON_DEMAND) {
      // Answer to "fetch older messages" / deep backfill — not part of the initial import.
      s.backfilled = (s.backfilled || 0) + stored;
      await this.saveSync();
      return;
    }
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
    const mode = this.settings.historyMode;
    // Finished = the last phase the chosen mode asks for (Full → FULL, Recent → RECENT, None → bootstrap).
    const last = mode === 'full' ? 'FULL' : mode === 'recent' ? 'RECENT' : 'INITIAL_BOOTSTRAP';
    if (status === 'complete' && name === last) this.sync.state = 'done';
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
      'SELECT id, from_me, ts, sender_jid FROM messages WHERE account_id = $1 AND chat_jid = $2 ORDER BY ts ASC LIMIT 1',
      [this.id, chatJid],
    );
    if (!rows[0]) throw new Error('No messages stored for this chat yet');
    const { id, from_me: fromMe, ts, sender_jid: sender } = rows[0];
    const key = { remoteJid: chatJid, id, fromMe };
    if (isJidGroup(chatJid) && !fromMe && sender) key.participant = sender;
    return this.sock.fetchMessageHistory(Math.min(count, 50), key, ts);
  }

  /** Ask for older messages of one chat and wait (up to waitMs) for them. Returns how many older ones arrived. */
  async fetchOlderAndWait(chatJid, waitMs = 20000) {
    const [before] = await query('SELECT min(ts) AS ts FROM messages WHERE account_id = $1 AND chat_jid = $2', [this.id, chatJid]);
    if (!before?.ts) return 0;
    let on;
    const arrived = new Promise((resolve) => {
      const t = setTimeout(resolve, waitMs);
      on = (chats) => {
        if (chats.has(chatJid)) {
          clearTimeout(t);
          resolve();
        }
      };
      this.on('history-rows', on);
    });
    try {
      await this.fetchOlder(chatJid, 50);
      await arrived;
    } finally {
      this.off('history-rows', on);
    }
    await this.work; // make sure the chunk is fully written
    const [after] = await query(
      'SELECT count(*)::int AS n FROM messages WHERE account_id = $1 AND chat_jid = $2 AND ts < $3',
      [this.id, chatJid, before.ts],
    );
    return after.n;
  }

  /**
   * Deep history backfill: walk through chats (most recent first) and pull older messages from the phone,
   * 50 at a time, until a chat has nothing older or reaches sinceTs. Progress is saved in the job row so
   * it continues after a restart. Paced like a person scrolling up in WhatsApp Web.
   */
  async runBackfill(job) {
    const p = job.payload || {};
    const progress = { index: 0, done: 0, added: 0, ...(p.progress || {}) };
    const sinceTs = p.sinceTs || 0;
    const chats = await query(
      `SELECT jid FROM chats WHERE account_id = $1 ${p.includeGroups ? '' : 'AND NOT is_group'} AND last_ts IS NOT NULL
       ORDER BY last_ts DESC`,
      [this.id],
    );
    progress.total = chats.length;
    const save = (status = 'running', result) =>
      query(
        `UPDATE jobs SET payload = $2, status = $3, result = $4, updated_at = now(),
           done_at = CASE WHEN $3 = 'running' OR $3 = 'pending' THEN NULL ELSE now() END
         WHERE id = $1`,
        [job.id, JSON.stringify({ ...p, progress }), status,
          result ?? `${progress.done}/${progress.total} chats, +${progress.added} older messages`],
      );
    await save();
    await logEvent(this.id, 'info', `Deep history backfill ${progress.index ? 'resumed' : 'started'} (${chats.length} chats)`);
    for (; progress.index < chats.length; progress.index++) {
      if (this.status !== 'open' || this.stopping) return save('pending'); // continues when connected again
      if (progress.index % 5 === 0) {
        const [j] = await query('SELECT status FROM jobs WHERE id = $1', [job.id]);
        if (j?.status === 'cancelled') return;
      }
      const jid = chats[progress.index].jid;
      for (let round = 0; round < 60; round++) {
        const [o] = await query('SELECT min(ts) AS ts FROM messages WHERE account_id = $1 AND chat_jid = $2', [this.id, jid]);
        if (!o?.ts || o.ts <= sinceTs) break;
        let got = 0;
        try {
          got = await this.fetchOlderAndWait(jid);
        } catch (err) {
          this.log.warn({ jid, err: err.message }, 'backfill request failed');
        }
        if (!got) break;
        progress.added += got;
        await sleep((2500 + Math.random() * 2500) * config.timeScale);
      }
      progress.done = progress.index + 1; // not ++: a chat cut off by a restart is redone, not double-counted
      if (progress.index % 5 === 0) await save();
      await sleep((1500 + Math.random() * 1500) * config.timeScale);
    }
    await save('done');
    await logEvent(this.id, 'info', `Deep history backfill finished: ${progress.added} older messages from ${progress.total} chats`);
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
    if (history && rows.length) this.emit('history-rows', new Set(rows.map((r) => r.chatJid)));
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
    // Messages from contacts you blocked are stored, but trigger nothing (no opt-out, autosave or webhook).
    if (!isJidGroup(r.chatJid)) {
      const [c] = await query('SELECT is_blocked FROM contacts WHERE account_id = $1 AND jid = $2', [this.id, r.chatJid]);
      if (c?.is_blocked) return;
    }
    // A message from them brings a snoozed / done chat back to the open list.
    await store.reopenOnIncoming(this.id, r.chatJid);
    // A candidate on a list wrote: "Reply to …" on the board until someone answers (so no reply goes unseen).
    const board = await import('../board.js');
    await board.noteIncoming(this.id, r).catch((err) => this.log.warn({ err: err.message }, 'board card failed'));
    await board.syncReminder(this.id, r.chatJid, { state: 'open' }).catch(() => {});
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
    // Your automatic rules (tag, save file, add task, auto-reply, remind me later)
    await this.applyRules(r).catch((err) => this.log.warn({ err: err.message }, 'rules failed'));
    // Notify an external webhook (e.g. Apps Script) if configured.
    if (settings.webhookUrl) {
      postWebhook(settings.webhookUrl, {
        event: 'message', account: this.id, chat: r.chatJid, from: r.senderJid, name: r.senderName,
        type: r.type, text: r.body, ts: r.ts, id: r.id,
      });
    }
  }

  async applyRules(r) {
    const isGroup = !!isJidGroup(r.chatJid);
    const [mine] = await query('SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me LIMIT 1', [this.id, r.chatJid]);
    const { runRules } = await import('../rules.js');
    const { createTask } = await import('../tasks.js');
    const outbox = await import('../outbox.js');
    const fields = await import('../templates.js').then((t) => t.contactFields(this.id, r.chatJid));
    const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => fields[k] || (k === 'name' ? r.chatJid.split('@')[0] : ''));
    await runRules(this.id, r, { isGroup, isNew: !mine }, {
      updateContact: (u) => store.updateContact(this.id, isGroup ? r.senderJid : r.chatJid, u),
      saveMedia: () => this.saveMedia(r.chatJid, r.id),
      createTask: (title) => createTask({ account: this.id, title: fill(title), details: `From ${fields.name || ''} +${r.chatJid.split('@')[0]}: ${(r.body || '[' + r.type + ']').slice(0, 200)}`, createdBy: 'rule', assignee: 'you', priority: true }),
      sendTemplate: async (tpl, note) => {
        const { payload } = await outbox.renderTemplate(this.id, r.chatJid, tpl);
        // One auto-reply per person per rule per day, even when they send several messages at once (the key makes
        // the second, simultaneous attempt a no-op instead of a duplicate).
        const day = new Date().toLocaleDateString('en-CA', { timeZone: config.tz });
        await outbox.enqueue({ account: this.id, to: r.chatJid, payload: { ...payload, replyTo: r.id }, source: 'rule', note, idemKey: `${note}:${r.chatJid}:${day}` });
      },
      snooze: (days) => store.setChatState(this.id, r.chatJid, 'snoozed', { until: new Date(Date.now() + days * 86400000).toISOString(), note: 'by rule' }),
    });
  }

  /** WhatsApp reported a message as failed (status ERROR). Show it instead of leaving it "sent". */
  async onDeliveryFailed(key) {
    await query('UPDATE messages SET status = 0 WHERE account_id = $1 AND id = $2', [this.id, key.id]);
    const rows = await query(
      `UPDATE outbox SET status = 'failed', error = 'WhatsApp reported this message as not delivered'
       WHERE account_id = $1 AND message_id = $2 AND status = 'sent' RETURNING id, task_id, to_jid`,
      [this.id, key.id],
    );
    const to = (rows[0]?.to_jid || key.remoteJid || '').split('@')[0];
    await logEvent(this.id, 'warn', `Message to ${to} was not delivered (WhatsApp reported an error)`);
    if (rows[0]?.task_id) await refreshTask(rows[0].task_id);
    const url = this.settings.webhookUrl;
    if (url) postWebhook(url, { event: 'message.failed', account: this.id, to, id: key.id, ts: Math.floor(Date.now() / 1000) });
  }

  /**
   * Call events: offer/ringing → accept (answered, possibly on the phone) → terminate; or timeout/reject (missed).
   * When a call ends, one line goes into the chat: "📞 Voice call — answered, 3:12" or "📞 Missed voice call".
   * So anyone drafting a reply can see a real conversation happened (and ask the owner what was said).
   */
  async onCalls(calls) {
    this.calls ||= new Map();
    for (const c of calls || []) {
      if (!c?.id) continue;
      this.log.info({ call: c.id, status: c.status, from: c.from, chat: c.chatId, video: c.isVideo }, 'call event');
      const cur = this.calls.get(c.id) || { start: c.date ? new Date(c.date) : new Date(), from: c.from, chat: c.chatId || c.from, video: !!c.isVideo, group: !!c.isGroup };
      if (c.status === 'accept' && !cur.accepted) cur.accepted = c.date ? new Date(c.date) : new Date();
      this.calls.set(c.id, cur);
      if (!['terminate', 'timeout', 'reject'].includes(c.status)) continue;
      this.calls.delete(c.id);
      if (cur.group) continue;
      const end = c.date ? new Date(c.date) : new Date();
      const secs = cur.accepted ? Math.max(0, Math.round((end - cur.accepted) / 1000)) : 0;
      const kind = cur.video ? 'video' : 'voice';
      const answered = !!cur.accepted && secs > 0;
      const body = answered
        ? `📞 ${kind[0].toUpperCase()}${kind.slice(1)} call — answered, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        : `📞 ${c.status === 'reject' ? 'Declined' : 'Missed'} ${kind} call`;
      const chatJid = await store.canonicalJid(this.id, cur.chat);
      if (!chatJid) continue;
      const fromMe = !!(this.myJid && cur.from && jidNormalizedUser(cur.from) === this.myJid);
      const row = {
        id: `call-${c.id}`, fromMe, ts: Math.floor(cur.start.getTime() / 1000), chatJid, senderJid: fromMe ? this.myJid : chatJid,
        senderName: fromMe ? 'me' : null, type: 'call', body, quotedId: null, quotedBody: null, forwarded: false,
        media: null, vcards: null, status: null, fromHistory: false,
      };
      await store.insertMessages(this.id, [row]);
      if (!fromMe) {
        const board = await import('../board.js');
        await board.noteIncoming(this.id, row).catch(() => {});
      }
    }
  }

  async onMessagesUpdate(updates) {
    for (const { key, update } of updates) {
      if (!key?.id) continue;
      if (update?.status === 0) await this.onDeliveryFailed(key);
      else if (typeof update?.status === 'number') await store.updateStatus(this.id, key.id, update.status);
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
  /** Save a name in the phone's own contacts (synced from this linked device). Throws if WhatsApp refuses. */
  async saveContactToPhone(jid, name) {
    if (!this.sock || this.status !== 'open') throw new Error('The number is not connected right now');
    if (typeof this.sock.addOrEditContact !== 'function') throw new Error('This WhatsApp version cannot save contacts from a linked device');
    const full = String(name).trim();
    await this.sock.addOrEditContact(jid, { fullName: full, firstName: full.split(/\s+/)[0], saveOnPrimaryAddressbook: true });
  }

  async send(jid, content, { typingMs = 0, quoted } = {}) {
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
    const sent = await withTimeout(this.sock.sendMessage(jid, content, quoted ? { quoted } : undefined), 120000, 'Sending (it may still go out — check the chat before resending)');
    if (sent?.key?.id) {
      this.sentCache.set(sent.key.id, sent.message);
      if (this.sentCache.size > 500) this.sentCache.delete(this.sentCache.keys().next().value);
      // Record it now: WhatsApp's own "you sent this" event can be held back for a while during a sync.
      this.enqueue(() => this.ingest([sent])); // not awaited: a big history chunk in the queue must not delay sending
    }
    return sent;
  }
}
