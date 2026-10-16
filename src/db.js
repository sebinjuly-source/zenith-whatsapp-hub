/**
 * Postgres access. Uses DATABASE_URL (Supabase, Oracle, any Postgres) when set,
 * otherwise an embedded Postgres (PGlite) stored in ./data for local runs.
 * Both speak the same SQL, so the rest of the code doesn't care which one it gets.
 */
import fs from 'fs';
import config from './config.js';
import logger from './logger.js';

let driver = null; // { query(text, params) -> rows, tx(fn), close() }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'baileys',
  phone TEXT,
  wa_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}',
  sync JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_connected_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wa_auth (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE IF NOT EXISTS lid_map (
  account_id TEXT NOT NULL,
  lid TEXT NOT NULL,
  pn TEXT NOT NULL,
  PRIMARY KEY (account_id, lid)
);

CREATE TABLE IF NOT EXISTS contacts (
  account_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  phone TEXT,
  lid TEXT,
  name TEXT,
  notify TEXT,
  verified_name TEXT,
  is_business BOOLEAN NOT NULL DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  tags TEXT[] NOT NULL DEFAULT '{}',
  lead_status TEXT,
  notes TEXT,
  summary TEXT,
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX IF NOT EXISTS contacts_phone ON contacts (account_id, phone);

CREATE TABLE IF NOT EXISTS chats (
  account_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  name TEXT,
  is_group BOOLEAN NOT NULL DEFAULT FALSE,
  participants INT,
  unread INT NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  last_ts BIGINT,
  last_preview TEXT,
  last_from_me BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX IF NOT EXISTS chats_recent ON chats (account_id, last_ts DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS messages (
  account_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me BOOLEAN NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  quoted_id TEXT,
  quoted_body TEXT,
  forwarded BOOLEAN NOT NULL DEFAULT FALSE,
  media JSONB,
  media_saved TEXT,
  vcards JSONB,
  reactions JSONB,
  status SMALLINT,
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  from_history BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (account_id, chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (account_id, chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (account_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_id ON messages (account_id, id);
CREATE INDEX IF NOT EXISTS messages_fts ON messages USING GIN (to_tsvector('simple', coalesce(body, '')));

CREATE TABLE IF NOT EXISTS media_files (
  path TEXT PRIMARY KEY,
  mimetype TEXT,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  to_jid TEXT NOT NULL,
  payload JSONB NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  campaign_id BIGINT,
  note TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  message_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_queue ON outbox (account_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function makePgDriver() {
  return import('pg').then(({ default: pg }) => {
    // BIGINT columns come back as strings by default; our BIGINTs (unix seconds, ids) fit in a JS number.
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', (err) => logger.error({ err: err.message }, 'Postgres pool error'));
    return {
      kind: 'postgres',
      async query(text, params = []) {
        return (await pool.query(text, params)).rows;
      },
      async exec(text) {
        await pool.query(text);
      },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(async (t, p = []) => (await client.query(t, p)).rows);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  });
}

async function makePgliteDriver() {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(config.localDbDir, { recursive: true });
  const pg = new PGlite(config.localDbDir);
  await pg.waitReady;
  // PGlite runs one statement at a time; serialise callers so transactions don't interleave.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    kind: 'pglite',
    query: (text, params = []) => serial(async () => (await pg.query(text, params)).rows),
    exec: (text) => serial(() => pg.exec(text)),
    tx: (fn) => serial(() => pg.transaction((t) => fn(async (q, p = []) => (await t.query(q, p)).rows))),
    close: () => pg.close(),
  };
}

export async function initDb() {
  driver = config.databaseUrl ? await makePgDriver() : await makePgliteDriver();
  await driver.exec(SCHEMA);
  logger.info({ db: driver.kind }, 'Database ready');
  return driver;
}

export const query = (text, params) => driver.query(text, params);
export const tx = (fn) => driver.tx(fn);
export const dbKind = () => driver?.kind;
export const closeDb = () => driver?.close();

/**
 * Multi-row INSERT helper. rows: array of arrays matching columns.
 * suffix: e.g. 'ON CONFLICT (...) DO UPDATE SET ...'
 */
export async function insertMany(table, columns, rows, suffix = '', chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map((row) => {
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    await query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')} ${suffix}`, params);
  }
}

export async function logEvent(accountId, level, text) {
  logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ accountId }, text);
  try {
    await query('INSERT INTO events (account_id, level, text) VALUES ($1,$2,$3)', [accountId, level, text]);
    // keep the log small
    if (Math.random() < 0.02) {
      await query("DELETE FROM events WHERE created_at < now() - interval '30 days'");
    }
  } catch {
    /* logging must never break the caller */
  }
}
