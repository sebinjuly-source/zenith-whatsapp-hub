/**
 * Baileys auth state (login + Signal encryption keys) for one number.
 *
 * Keys live in memory, like the file-based store the old form bot uses, so sending/receiving never
 * waits on the network. Every change is also written to Postgres (table wa_auth) in the background
 * within ~0.3 s, so the login survives restarts and can move between the PC and Render.
 */
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { query, insertMany } from '../db.js';
import logger from '../logger.js';

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);
const FLUSH_MS = 300;

export async function useDbAuthState(accountId) {
  const rows = await query('SELECT key, value FROM wa_auth WHERE account_id = $1', [accountId]);
  const mem = new Map(rows.map((r) => [r.key, r.value])); // key -> encoded JSON (decoded on read)
  const creds = mem.has('creds') ? dec(mem.get('creds')) : initAuthCreds();

  const dirty = new Map(); // key -> encoded value, or null = delete
  let timer = null;
  let flushing = Promise.resolve();

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    flushing = flushing.then(async () => {
      if (!dirty.size) return;
      const batch = new Map(dirty);
      dirty.clear();
      const upserts = [];
      const deletes = [];
      for (const [key, value] of batch) {
        if (value === null) deletes.push(key);
        else upserts.push([accountId, key, value]);
      }
      try {
        if (upserts.length) {
          await insertMany('wa_auth', ['account_id', 'key', 'value'], upserts,
            'ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value');
        }
        if (deletes.length) await query('DELETE FROM wa_auth WHERE account_id = $1 AND key = ANY($2)', [accountId, deletes]);
      } catch (err) {
        // Put them back (unless changed again meanwhile) and retry shortly.
        for (const [k, v] of batch) if (!dirty.has(k)) dirty.set(k, v);
        logger.warn({ accountId, err: err.message }, 'Saving WhatsApp keys failed; will retry');
        schedule(5000);
      }
    });
    return flushing;
  };
  const schedule = (ms = FLUSH_MS) => {
    if (!timer) timer = setTimeout(flush, ms);
  };
  const put = (key, value) => {
    if (value === null) mem.delete(key);
    else mem.set(key, value);
    dirty.set(key, value);
    schedule();
  };

  const keys = {
    get(type, ids) {
      const data = {};
      for (const id of ids) {
        const raw = mem.get(`${type}:${id}`);
        let value = raw ? dec(raw) : undefined;
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        data[id] = value;
      }
      return data;
    },
    set(data) {
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          put(`${type}:${id}`, value ? enc(value) : null);
        }
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => put('creds', enc(creds)),
    /** Write everything pending now (call before stopping). */
    flush,
    /** Forget pending writes (after logout, so deleted keys don't come back). */
    discard: () => {
      clearTimeout(timer);
      timer = null;
      dirty.clear();
    },
  };
}

export async function clearAuthState(accountId) {
  await query('DELETE FROM wa_auth WHERE account_id = $1', [accountId]);
}

/** True only for a login that was actually completed (QR scanned), not a QR that was shown and abandoned. */
export async function hasAuthState(accountId) {
  const rows = await query("SELECT value FROM wa_auth WHERE account_id = $1 AND key = 'creds'", [accountId]);
  return rows[0] ? !!dec(rows[0].value).me : false;
}
