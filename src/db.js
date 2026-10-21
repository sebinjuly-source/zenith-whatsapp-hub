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

-- Which server currently runs each number (so two servers never fight over one login).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

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

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  kind TEXT NOT NULL DEFAULT 'todo',
  status TEXT NOT NULL DEFAULT 'upcoming',
  due_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'you',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_board ON tasks (account_id, status);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS task_id BIGINT;
CREATE INDEX IF NOT EXISTS outbox_task ON outbox (task_id);
-- Same key = same request: a retried API call never sends twice.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS idem_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idem ON outbox (account_id, idem_key) WHERE idem_key IS NOT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idem_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem ON tasks (account_id, idem_key) WHERE idem_key IS NOT NULL;

-- Actions that need the live WhatsApp connection, run by whichever server holds the number.
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (account_id, status);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Saved message templates (account_id NULL = shared by all numbers)
CREATE TABLE IF NOT EXISTS templates (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  attachment JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Automatic rules for incoming messages
CREATE TABLE IF NOT EXISTS rules (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  conditions JSONB NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '{}',
  runs INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat state: open / snoozed (remind me on a date) / done. A new incoming message reopens the chat.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS snooze_note TEXT;

-- Contact lists (candidate batches etc.) with per-person status worked out from WhatsApp messages
CREATE TABLE IF NOT EXISTS lists (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT,
  since TIMESTAMPTZ NOT NULL DEFAULT now(),
  followup JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS list_members (
  list_id BIGINT NOT NULL,
  jid TEXT NOT NULL,
  phone TEXT,
  name TEXT,
  fields JSONB NOT NULL DEFAULT '{}',
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  outcome TEXT,
  notes TEXT,
  error TEXT,
  first_sent_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  replies INT NOT NULL DEFAULT 0,
  followups_sent INT NOT NULL DEFAULT 0,
  row_ref TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, jid)
);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS list_id BIGINT;
-- Funnel (like sales): stage set by you/AI + the date they said they'll come
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS visit_at TIMESTAMPTZ;
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS stage_at TIMESTAMPTZ;
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
ALTER TABLE list_members ADD COLUMN IF NOT EXISTS asked_date_at TIMESTAMPTZ;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS pipeline JSONB NOT NULL DEFAULT '{}';
-- Job role (Chef, Front office, Housekeeping…) keeps each kind of outreach separate: lists, tasks, log
ALTER TABLE lists ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS role TEXT;
-- Hub-wide settings, e.g. the playbook (your rules for the AI)
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS outbox_list ON outbox (list_id, to_jid);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- who did it: 'you' (dashboard/REST), 'ai' (MCP), 'system'
ALTER TABLE events ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'system';
ALTER TABLE events ADD COLUMN IF NOT EXISTS role TEXT;

-- Sent as a reply to someone who wrote in the last 24 h: goes out at once and isn't counted in the automated cap
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS is_reply BOOLEAN NOT NULL DEFAULT FALSE;

-- Meta WhatsApp Cloud API numbers (provider = 'cloud'): { phoneNumberId, wabaId } + last known number health
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cloud JSONB NOT NULL DEFAULT '{}';
-- What Meta told us, kept 14 days for debugging (idea from Kapso's observe-whatsapp): every status with pricing and
-- errors, incoming messages, template/quality/account events, and refused sends. One row per event.
CREATE TABLE IF NOT EXISTS meta_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  kind TEXT NOT NULL,
  wamid TEXT,
  peer TEXT,
  status TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_events_wamid ON meta_events (wamid);
CREATE INDEX IF NOT EXISTS meta_events_peer ON meta_events (account_id, peer, created_at DESC);

-- Message templates approved by Meta (synced from the WhatsApp Business account)
CREATE TABLE IF NOT EXISTS wa_templates (
  waba_id TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT,
  components JSONB NOT NULL DEFAULT '[]',
  meta_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (waba_id, name, language)
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
      // Supabase's pooler drops idle connections; retire ours first and keep live ones warm.
      idleTimeoutMillis: 20000,
      keepAlive: true,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (err) => logger.error({ err: err.message }, 'Postgres pool error'));
    // A connection killed while idle fails the next query at once ("Connection terminated unexpectedly") before
    // the statement runs. Retry those on a fresh connection instead of failing a send or the outbox loop.
    const transient = (err) => /Connection terminated|ECONNRESET|EPIPE|connection timeout|Client has encountered a connection error|terminating connection/i.test(err?.message || '')
      || ['57P01', '57P02', '57P03', '08006', '08003'].includes(err?.code);
    return {
      kind: 'postgres',
      async query(text, params = []) {
        for (let attempt = 0; ; attempt++) {
          try {
            return (await pool.query(text, params)).rows;
          } catch (err) {
            if (attempt >= 2 || !transient(err)) throw err;
            logger.warn({ err: err.message, attempt }, 'Database connection dropped — retrying');
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          }
        }
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

export async function logEvent(accountId, level, text, actor = 'system', role = null) {
  logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ accountId, actor, role }, text);
  try {
    await query('INSERT INTO events (account_id, level, text, actor, role) VALUES ($1,$2,$3,$4,$5)', [accountId, level, text, actor, role]);
    // keep the log small
    if (Math.random() < 0.02) {
      // system noise is kept 30 days; your and the AI's actions 1 year
      await query("DELETE FROM events WHERE (actor = 'system' AND created_at < now() - interval '30 days') OR created_at < now() - interval '365 days'");
    }
  } catch {
    /* logging must never break the caller */
  }
}
