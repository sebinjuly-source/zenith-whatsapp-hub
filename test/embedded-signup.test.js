/**
 * Meta's sign-up pop-up (Tech Provider / Embedded Signup) against a fake Graph API: the code becomes the business's
 * own token, its WhatsApp account is subscribed, the number registered with a fresh PIN, every later Meta call for
 * that number uses its own token (never META_TOKEN), the token is stored sealed, and webhooks signed by the Tech
 * Provider app are accepted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-es-'));
const calls = [];
let registeredPin = null;
const g = express();
g.use(express.json());
g.use((req, res, next) => { calls.push({ method: req.method, path: req.path, query: req.query, body: req.body, auth: req.get('authorization') }); next(); });
const bizOnly = (req, res, next) => (req.get('authorization') === 'Bearer biz-token' ? next() : res.status(403).json({ error: { code: 200, message: 'wrong token' } }));
g.get('/v24.0/oauth/access_token', (req, res) => (req.query.code === 'good-code' && req.query.client_id === '5005' && req.query.client_secret === 'es-secret'
  ? res.json({ access_token: 'biz-token', token_type: 'bearer' }) : res.status(400).json({ error: { code: 100, message: 'bad code' } })));
g.get('/v24.0/777', bizOnly, (req, res) => res.json({ id: '777', display_phone_number: '+91 90000 00077', verified_name: 'Fish Stall', quality_rating: 'GREEN',
  status: registeredPin ? 'CONNECTED' : 'PENDING', platform_type: registeredPin ? 'CLOUD_API' : 'NOT_APPLICABLE', messaging_limit_tier: 'TIER_250' }));
g.post('/v24.0/777/register', bizOnly, (req, res) => { registeredPin = req.body.pin; res.json({ success: true }); });
g.post('/v24.0/888/subscribed_apps', bizOnly, (req, res) => res.json({ success: true }));
g.get('/v24.0/888/subscribed_apps', bizOnly, (req, res) => res.json({ data: [{ whatsapp_business_api_data: { id: '5005' } }] }));
g.get('/v24.0/888/message_templates', bizOnly, (req, res) => res.json({ data: [], paging: { cursors: {} } }));
g.get('/v24.0/5005/subscriptions', (req, res) => res.json({ data: [] }));
g.post('/v24.0/5005/subscriptions', (req, res) => res.json({ success: req.get('authorization') === 'Bearer 5005|es-secret' }));
g.post('/v24.0/777/messages', bizOnly, (req, res) => res.json({ messages: [{ id: 'wamid.ES1' }] }));
let gs;
await new Promise((r) => (gs = g.listen(0, r)));
const graphUrl = `http://127.0.0.1:${gs.address().port}`;

Object.assign(process.env, {
  LOCAL_DB_DIR: dir, DATABASE_URL: '', API_KEY: 'k', LOG_LEVEL: 'error', TIME_SCALE: '0.002', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
  META_TOKEN: 'main-token', META_GRAPH_URL: graphUrl, META_APP_SECRET: 'app-secret', META_VERIFY_TOKEN: 'verify-word', PUBLIC_URL: 'https://hub.example',
  META_ES_APP_ID: '5005', META_ES_CONFIG_ID: 'cfg1', META_ES_APP_SECRET: 'es-secret',
});
delete process.env.META_PHONE_NUMBER_ID;
delete process.env.META_WABA_ID;

const { initDb, query, closeDb } = await import('../src/db.js');
const { manager } = await import('../src/wa/manager.js');
const { buildApp } = await import('../src/api.js');
let base;
let server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(25); }
}
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  await initDb();
  await manager.init();
  const app = buildApp();
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const s of manager.sessions.values()) await s.stop().catch(() => {});
  server?.close();
  gs?.close();
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign-up config tells the page whether Meta sign-up is ready (no secret shown)', async () => {
  const r = await call('GET', '/api/meta/signup-config');
  assert.deepEqual(r.data, { ready: true, appId: '5005', configId: 'cfg1', graphVersion: 'v24.0', missing: [] });
});

test('a bad code connects nothing', async () => {
  const r = await call('POST', '/api/meta/signup', { code: 'nope', phoneNumberId: '777', wabaId: '888' });
  assert.equal(r.status >= 400, true);
  assert.equal(manager.list().length, 0);
});

test('sign-up: own token, subscribed, registered with a fresh PIN, stored sealed, used for every call', async () => {
  const r = await call('POST', '/api/meta/signup', { code: 'good-code', phoneNumberId: '777', wabaId: '888' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.label, 'Fish Stall');
  assert.ok(!JSON.stringify(r.data).includes('enc:'), 'the answer never carries the sealed token');
  const s = manager.get(r.data.id);
  await until(() => s.status === 'open');
  assert.match(registeredPin, /^\d{6}$/);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v24.0/888/subscribed_apps'));
  const numberCalls = calls.filter((c) => /\/v24\.0\/(777|888)/.test(c.path));
  assert.ok(numberCalls.length > 3 && numberCalls.every((c) => c.auth === 'Bearer biz-token'), 'never META_TOKEN for this number');
  const [row] = await query('SELECT cloud FROM accounts WHERE id = $1', [r.data.id]);
  assert.match(row.cloud.token, /^enc:/);
  assert.ok(!JSON.stringify(row.cloud).includes('biz-token') && !JSON.stringify(row.cloud).includes(registeredPin), 'token and PIN sealed');
  assert.equal(row.cloud.appId, '5005');
  // the same number can't be connected twice
  const again = await call('POST', '/api/meta/signup', { code: 'good-code', phoneNumberId: '777', wabaId: '888' });
  assert.equal(again.status >= 400, true);
});

test('webhooks signed by the Tech Provider app are accepted and replies use the business token', async () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '888', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000077', phone_number_id: '777' },
    contacts: [{ profile: { name: 'Asha' }, wa_id: '919876500077' }],
    messages: [{ from: '919876500077', id: 'wamid.ESIN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Fresh fish today?' } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'es-secret').update(body).digest('hex');
  const res = await fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  assert.equal(res.status, 200);
  const acc = manager.list()[0].id;
  await until(async () => (await query(`SELECT 1 FROM messages WHERE id = 'wamid.ESIN1'`)).length);
  const r = await call('POST', '/api/send', { account: acc, to: '9876500077', text: 'Yes, seer fish and prawns.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = await until(() => calls.find((c) => c.method === 'POST' && c.path === '/v24.0/777/messages' && !c.body.status));
  assert.equal(sent.auth, 'Bearer biz-token');
});
