/**
 * Baileys auth state stored in Postgres (table wa_auth) instead of files,
 * so a WhatsApp login survives Render restarts/wipes and can move between machines.
 */
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { query, insertMany } from '../db.js';

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);

export async function useDbAuthState(accountId) {
  const rows = await query('SELECT value FROM wa_auth WHERE account_id = $1 AND key = $2', [accountId, 'creds']);
  const creds = rows[0] ? dec(rows[0].value) : initAuthCreds();

  const keys = {
    async get(type, ids) {
      if (!ids.length) return {};
      const wanted = ids.map((id) => `${type}:${id}`);
      const found = await query('SELECT key, value FROM wa_auth WHERE account_id = $1 AND key = ANY($2)', [
        accountId,
        wanted,
      ]);
      const byKey = new Map(found.map((r) => [r.key, r.value]));
      const data = {};
      for (const id of ids) {
        const raw = byKey.get(`${type}:${id}`);
        let value = raw ? dec(raw) : undefined;
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      }
      return data;
    },
    async set(data) {
      const upserts = [];
      const deletes = [];
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const key = `${type}:${id}`;
          if (value) upserts.push([accountId, key, enc(value)]);
          else deletes.push(key);
        }
      }
      if (upserts.length) {
        await insertMany('wa_auth', ['account_id', 'key', 'value'], upserts,
          'ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value');
      }
      if (deletes.length) {
        await query('DELETE FROM wa_auth WHERE account_id = $1 AND key = ANY($2)', [accountId, deletes]);
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () =>
      query(
        `INSERT INTO wa_auth (account_id, key, value) VALUES ($1, 'creds', $2)
         ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [accountId, enc(creds)],
      ),
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
