/**
 * REST API + dashboard login. Everything except /health needs the API key:
 *   header "x-api-key: <key>", or "?key=<key>" (handy for Apps Script), or the dashboard login cookie.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { query, dbKind } from './db.js';
import { manager } from './wa/manager.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { getMedia } from './media.js';
import { mountMcp } from './mcp.js';
import { toTs } from './util.js';
import * as tasks from './tasks.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(err.status || 400).json({ error: err.message }));

function authed(req) {
  const key = req.get('x-api-key') || req.query.key || req.cookies?.hub_key;
  return key && key === config.apiKey;
}

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use(cookieParser());

  app.get('/health', (req, res) =>
    res.json({ ok: true, db: dbKind(), accounts: manager.list().map((a) => ({ id: a.id, status: a.status })) }),
  );

  app.post('/login', (req, res) => {
    if (req.body?.key !== config.apiKey) return res.status(401).json({ error: 'Wrong key' });
    res.cookie('hub_key', config.apiKey, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, secure: req.secure });
    res.json({ ok: true });
  });
  app.post('/logout', (req, res) => res.clearCookie('hub_key').json({ ok: true }));

  // MCP for AI agents: <server>/mcp/<API_KEY>
  mountMcp(app);

  app.use(express.static(publicDir));

  // ---- Legacy endpoint: same body as the old whatsapp-form-bot, so Apps Script only needs a URL change.
  app.post('/webhook', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).send('Unauthorized');
    const { phone, message, imageUrl, documentUrl, fileName, account } = req.body || {};
    if (!phone || (!message && !imageUrl && !documentUrl)) return res.status(400).send('Missing phone or message');
    const attachment = imageUrl
      ? { url: imageUrl, as: 'image', caption: message }
      : documentUrl
        ? { url: documentUrl, fileName, caption: message }
        : undefined;
    const row = await outbox.enqueue({ account, to: phone, payload: { text: message, attachment }, source: 'api' });
    const result = await outbox.waitFor(row.id);
    if (result?.status === 'sent') return res.status(200).send('Success');
    res.status(500).send(result?.error || 'Timed out waiting to send');
  }));

  const api = express.Router();
  api.use((req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));

  // ---- Accounts
  api.get('/accounts', wrap(async (req, res) => {
    await manager.refresh();
    const list = manager.list();
    for (const a of list) a.stats = await store.accountStats(a.id);
    res.json(list);
  }));
  api.post('/accounts', wrap(async (req, res) => res.json(await manager.create(req.body || {}))));
  api.patch('/accounts/:id', wrap(async (req, res) => res.json(await manager.update(req.params.id, req.body || {}))));
  api.delete('/accounts/:id', wrap(async (req, res) => {
    if (req.query.confirm !== req.params.id) throw new Error('Add ?confirm=<account id> to delete an account and all its data');
    await manager.remove(req.params.id);
    res.json({ ok: true });
  }));
  api.post('/accounts/:id/link', wrap(async (req, res) => res.json(await manager.link(req.params.id, req.body || {}))));
  api.post('/accounts/:id/unlink', wrap(async (req, res) => {
    await manager.unlink(req.params.id);
    res.json({ ok: true });
  }));

  // Clean stop: finishes writing, releases every number so another server can take over, then exits.
  api.post('/shutdown', wrap(async (req, res) => {
    res.json({ ok: true, note: 'Stopping — numbers are released for another server.' });
    setTimeout(() => req.app.locals.shutdown?.('api'), 200);
  }));

  // ---- Chats, messages, contacts
  api.get('/accounts/:id/chats', wrap(async (req, res) => {
    const { q, kind, tag, limit, offset, waiting } = req.query;
    res.json(await store.listChats(req.params.id, {
      q, kind, tag, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0, waitingOnMe: waiting === '1',
    }));
  }));
  api.get('/accounts/:id/chats/:jid/messages', wrap(async (req, res) => {
    res.json(await store.getMessages(req.params.id, req.params.jid, {
      limit: parseInt(req.query.limit, 10) || 50, beforeTs: toTs(req.query.before), afterTs: toTs(req.query.after),
    }));
  }));
  api.post('/accounts/:id/chats/:jid/older', wrap(async (req, res) => {
    const r = await outbox.requestJob(manager.get(req.params.id), 'fetch_older', { chat: req.params.jid, count: req.body?.count || 50 });
    res.json({ ok: true, note: r.ran ? 'Asked the phone — older messages arrive within a minute if it is online.' : 'Queued for the server connected to this number — older messages arrive in a minute or two.' });
  }));
  api.get('/accounts/:id/contacts/:jid', wrap(async (req, res) => res.json(await store.getContact(req.params.id, req.params.jid))));
  api.patch('/accounts/:id/contacts/:jid', wrap(async (req, res) => res.json(await store.updateContact(req.params.id, req.params.jid, req.body || {}))));

  api.get('/search', wrap(async (req, res) => {
    const { account, q, chat, fromMe, since, until, type, limit } = req.query;
    res.json(await store.searchMessages(account || null, q, {
      chatJid: chat, fromMe: fromMe === undefined ? undefined : fromMe === 'true',
      sinceTs: toTs(since), untilTs: toTs(until), type, limit: parseInt(limit, 10) || 50,
    }));
  }));

  // ---- Sending
  api.post('/send', wrap(async (req, res) => {
    const { account, to, text, attachment, wait = true } = req.body || {};
    if (!to) throw new Error('Missing "to" (phone number or chat id)');
    const row = await outbox.enqueue({ account, to, payload: { text, attachment }, source: req.body?.source === 'dashboard' ? 'dashboard' : 'api' });
    if (!wait) return res.json(row);
    const result = await outbox.waitFor(row.id);
    if (!result) return res.status(202).json({ ...row, note: 'Still queued (number not connected?)' });
    res.status(result.status === 'sent' ? 200 : 502).json(result);
  }));

  api.get('/outbox', wrap(async (req, res) => res.json(await outbox.listOutbox({
    account: req.query.account, status: req.query.status, taskId: req.query.task, limit: parseInt(req.query.limit, 10) || 50,
  }))));

  // ---- Task board
  api.get('/tasks', wrap(async (req, res) => res.json(await tasks.listTasks({ account: req.query.account, past: req.query.past === '1' }))));
  api.post('/tasks', wrap(async (req, res) => {
    const { account, title, details, dueAt } = req.body || {};
    const s = await manager.resolve(account);
    res.json(await tasks.createTask({ account: s.id, title, details, dueAt, createdBy: 'you' }));
  }));
  api.patch('/tasks/:id', wrap(async (req, res) => res.json(await tasks.updateTask(req.params.id, req.body || {}))));
  api.post('/tasks/:id/approve', wrap(async (req, res) => res.json(await outbox.approveTask(req.params.id))));
  api.post('/tasks/:id/cancel', wrap(async (req, res) => res.json(await tasks.cancelTask(req.params.id))));
  // Bulk send: { account, title, text (use {name}), recipients: [{ to, name, ... }], attachment?, scheduledAt?, skipIfContactedDays? }
  api.post('/bulk', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await outbox.bulkSend({ ...b, source: b.automated === false ? 'api' : 'campaign', createdBy: 'you' }));
  }));
  api.post('/outbox/:id/approve', wrap(async (req, res) => res.json(await outbox.approve(req.params.id, req.body || {}))));
  api.post('/outbox/:id/reject', wrap(async (req, res) => res.json(await outbox.reject(req.params.id))));

  // ---- Media: serves the saved copy, or downloads from WhatsApp on demand (?save=1 keeps a copy)
  api.get('/media/:id/:jid/:msgId', wrap(async (req, res) => {
    const { id, jid, msgId } = req.params;
    const rows = await query('SELECT * FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [id, jid, msgId]);
    const row = rows[0];
    if (!row?.media) return res.status(404).json({ error: 'No media on this message' });
    const session = manager.get(id);
    let ref = row.media_saved;
    if (!ref && req.query.save === '1') ref = await session.saveMedia(jid, msgId);
    const { buffer, mimetype } = ref ? await getMedia(ref) : { buffer: await session.downloadMedia(row), mimetype: row.media.mimetype };
    res.setHeader('Content-Type', mimetype || 'application/octet-stream');
    if (row.media.fileName) res.setHeader('Content-Disposition', `inline; filename="${row.media.fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  }));

  api.get('/events', wrap(async (req, res) => {
    const p = [parseInt(req.query.limit, 10) || 100];
    let where = '';
    if (req.query.account) {
      p.push(req.query.account);
      where = 'WHERE account_id = $2';
    }
    res.json(await query(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT $1`, p));
  }));

  // Live updates for the dashboard (Server-Sent Events)
  api.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const onChange = (info) => send('account', info);
    const onIncoming = (m) => send('message', { account: m.account, chat: m.chatJid, preview: (m.body || `[${m.type}]`).slice(0, 80) });
    manager.on('change', onChange);
    manager.on('incoming', onIncoming);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      manager.off('change', onChange);
      manager.off('incoming', onIncoming);
    });
  });

  app.use('/api', api);
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  return app;
}
