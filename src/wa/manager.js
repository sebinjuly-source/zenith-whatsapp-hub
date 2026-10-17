/**
 * Keeps one Session per account (WhatsApp number) and exposes account management.
 */
import { EventEmitter } from 'events';
import { query, logEvent } from '../db.js';
import { Session } from './session.js';
import { hasAuthState, clearAuthState } from './auth-state.js';
import { normalizeSettings } from '../settings.js';

class Manager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async init() {
    await this.refresh();
    // Keep in step with other servers sharing the database (numbers added, linked or handed over elsewhere).
    setInterval(() => this.refresh().catch(() => {}), 30000).unref();
  }

  /**
   * Pick up accounts added or re-enabled from another machine sharing the same database
   * (e.g. a number linked on a PC for its first big history sync, then handed to the server).
   */
  async refresh() {
    const accounts = await query('SELECT * FROM accounts ORDER BY created_at');
    const ids = new Set(accounts.map((a) => a.id));
    for (const acc of accounts) {
      let s = this.sessions.get(acc.id);
      if (!s) s = this.attach(acc);
      else Object.assign(s.account, acc);
      if (acc.enabled && s.status === 'stopped' && !s.sock && !s.stopping && (await hasAuthState(acc.id))) {
        s.start().catch((err) => logEvent(acc.id, 'error', `Start failed: ${err.message}`));
      }
    }
    for (const [id, s] of this.sessions) {
      if (ids.has(id)) continue;
      await s.stop().catch(() => {}); // deleted from another server
      this.sessions.delete(id);
    }
  }

  attach(account) {
    const s = new Session(account);
    s.on('change', (info) => this.emit('change', info));
    s.on('incoming', (row) => this.emit('incoming', { account: account.id, ...row }));
    this.sessions.set(account.id, s);
    return s;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown account "${id}"`);
    return s;
  }

  async defaultId() {
    if (!this.sessions.size) await this.refresh();
    const rows = await query('SELECT id FROM accounts ORDER BY is_default DESC, created_at LIMIT 1');
    return rows[0]?.id || null;
  }

  /** Accept an account id, a phone number of a linked account, or nothing (= default account). */
  async resolve(idOrPhone) {
    if (!idOrPhone) {
      const id = await this.defaultId();
      if (!id) throw new Error('No accounts yet — add one in the dashboard');
      return this.get(id);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.sessions.has(idOrPhone)) return this.get(idOrPhone);
      const digits = String(idOrPhone).replace(/\D/g, '');
      for (const s of this.sessions.values()) if (digits && s.account.phone === digits) return s;
      if (attempt === 0) await this.refresh(); // maybe added on another server a moment ago
    }
    throw new Error(`Unknown account "${idOrPhone}"`);
  }

  async create({ id, label, purpose = '', settings = {} }) {
    const slug = String(id || label || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    if (!slug) throw new Error('Give the account a name, e.g. "hiring"');
    if (this.sessions.has(slug)) throw new Error(`Account "${slug}" already exists`);
    const first = this.sessions.size === 0;
    const rows = await query(
      `INSERT INTO accounts (id, label, purpose, is_default, settings) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [slug, label || slug, purpose, first, JSON.stringify(normalizeSettings(settings))],
    );
    this.attach(rows[0]);
    await logEvent(slug, 'info', `Account created${first ? ' (default)' : ''}`);
    return rows[0];
  }

  async update(id, { label, purpose, enabled, isDefault, settings }) {
    const s = this.get(id);
    if (isDefault) await query('UPDATE accounts SET is_default = (id = $1)', [id]);
    const merged = settings ? normalizeSettings({ ...s.account.settings, ...settings }) : null;
    const rows = await query(
      `UPDATE accounts SET label = COALESCE($2, label), purpose = COALESCE($3, purpose),
         enabled = COALESCE($4, enabled), settings = COALESCE($5, settings)
       WHERE id = $1 RETURNING *`,
      [id, label ?? null, purpose ?? null, enabled ?? null, merged ? JSON.stringify(merged) : null],
    );
    Object.assign(s.account, rows[0]);
    if (enabled === false && s.status !== 'stopped') await s.stop();
    if (enabled === true && s.status === 'stopped' && (await hasAuthState(id))) await s.start();
    this.emit('change', s.info());
    return rows[0];
  }

  async link(id, { pairPhone, history } = {}) {
    const s = this.get(id);
    if (s.status === 'open') throw new Error('Already connected');
    if (history) await this.update(id, { settings: { historyMode: history } });
    if (s.sock) await s.stop();
    await s.start({ pairPhone, linking: true });
    return s.info();
  }

  async unlink(id) {
    await this.get(id).logout();
    await logEvent(id, 'info', 'Unlinked from WhatsApp (stored chats kept)');
  }

  /** Delete the account and everything stored for it. */
  async remove(id) {
    const s = this.get(id);
    await s.logout().catch(() => {});
    await clearAuthState(id);
    for (const t of ['messages', 'chats', 'contacts', 'lid_map', 'outbox', 'events']) {
      await query(`DELETE FROM ${t} WHERE account_id = $1`, [id]);
    }
    await query('DELETE FROM accounts WHERE id = $1', [id]);
    this.sessions.delete(id);
    this.emit('change', { id, removed: true });
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      ...s.info(),
      label: s.account.label,
      purpose: s.account.purpose,
      isDefault: s.account.is_default,
      enabled: s.account.enabled,
      settings: normalizeSettings(s.account.settings),
      lastConnectedAt: s.account.last_connected_at,
    }));
  }
}

export const manager = new Manager();
