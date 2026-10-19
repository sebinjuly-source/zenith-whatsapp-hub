/**
 * REST API + dashboard login. Everything except /health needs the API key:
 *   header "x-api-key: <key>", or "?key=<key>" (handy for Apps Script), or the dashboard login cookie.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
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
import * as templates from './templates.js';
import * as rules from './rules.js';
import { findPerson } from './people.js';
import * as lists from './lists.js';
import { getPlaybook, savePlaybook } from './playbook.js';
import * as notify from './notify.js';
import { logEvent } from './db.js';
import { normalizeSettings } from './settings.js';
import { describeSettingsChange, HISTORY_MODES } from './describe.js';

/**
 * Record an action so the AI can see who chose what. Dashboard (login cookie) = "you";
 * anything using the API key (Apps Script, scripts) = "script". MCP logs its own actions as "ai".
 */
const actorOf = (req) => (req.get('x-api-key') || req.query.key ? 'script' : 'you');
const act = (req, accountId, text, role = null) => logEvent(accountId, 'info', text, actorOf(req), role);

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Changes on every deploy (Render sets RENDER_GIT_COMMIT); open dashboards reload when it changes.
export const VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 10);
const indexHtml = () =>
  fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${VERSION}"`)
    .replace('src="app.js"', `src="app.js?v=${VERSION}"`)
    .replace('<script ', `<script>window.HUB_VERSION = '${VERSION}';</script>\n  <script `);

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
    res.json({
      ok: true,
      db: dbKind(),
      version: VERSION,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576), // Render free plan: 512 MB
      accounts: manager.list().map((a) => ({ id: a.id, status: a.status })),
    }),
  );

  app.post('/login', (req, res) => {
    if (req.body?.key !== config.apiKey) return res.status(401).json({ error: 'Wrong key' });
    res.cookie('hub_key', config.apiKey, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, secure: req.secure });
    res.json({ ok: true });
  });
  app.post('/logout', (req, res) => res.clearCookie('hub_key').json({ ok: true }));

  // MCP for AI agents: <server>/mcp/<API_KEY>
  mountMcp(app);

  app.use(express.static(publicDir, { index: false }));

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
    const row = await outbox.enqueue({ account, to: phone, payload: { text: message, attachment }, source: 'api', idemKey: req.body?.idempotencyKey || req.get('idempotency-key') });
    if (row.duplicate && row.status === 'sent') return res.status(200).send('Success');
    const result = row.status === 'sent' || row.status === 'failed' ? row : await outbox.waitFor(row.id);
    if (result?.status === 'sent') return res.status(200).send('Success');
    res.status(500).send(result?.error || 'Timed out waiting to send');
  }));

  const api = express.Router();
  api.use((req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));

  // ---- Accounts
  api.get('/accounts', wrap(async (req, res) => {
    await manager.refresh();
    const list = manager.list();
    for (const a of list) {
      a.stats = await store.accountStats(a.id);
      a.backfill = await outbox.backfillStatus(a.id);
      a.newChats = await outbox.newChatsStatus(a.id, a.settings);
    }
    res.json(list);
  }));
  api.post('/accounts', wrap(async (req, res) => {
    const acc = await manager.create(req.body || {});
    await act(req, acc.id, `Added number "${acc.label}"${acc.purpose ? ` (purpose: ${acc.purpose})` : ''}`);
    res.json(acc);
  }));
  api.patch('/accounts/:id', wrap(async (req, res) => {
    const before = normalizeSettings(manager.get(req.params.id).account.settings);
    const prev = { ...manager.get(req.params.id).account };
    const acc = await manager.update(req.params.id, req.body || {});
    const changes = [describeSettingsChange(before, normalizeSettings(acc.settings))];
    if (req.body?.label && req.body.label !== prev.label) changes.push(`Name: ${prev.label} → ${acc.label}`);
    if (req.body?.purpose !== undefined && req.body.purpose !== prev.purpose) changes.push(`Purpose: ${req.body.purpose}`);
    if (req.body?.enabled !== undefined && req.body.enabled !== prev.enabled) changes.push(req.body.enabled ? 'Number resumed' : 'Number paused');
    if (req.body?.isDefault) changes.push('Made default number');
    const text = changes.filter(Boolean).join('; ');
    if (text) await act(req, acc.id, `Changed settings — ${text}`);
    res.json(acc);
  }));
  api.delete('/accounts/:id', wrap(async (req, res) => {
    if (req.query.confirm !== req.params.id) throw new Error('Add ?confirm=<account id> to delete an account and all its data');
    await manager.remove(req.params.id);
    await act(req, null, `Deleted number "${req.params.id}" and its stored data`);
    res.json({ ok: true });
  }));
  api.post('/accounts/:id/link', wrap(async (req, res) => {
    const info = await manager.link(req.params.id, req.body || {});
    const mode = normalizeSettings(manager.get(req.params.id).account.settings).historyMode;
    await act(req, req.params.id, `Started linking the number — history chosen: ${HISTORY_MODES[mode]}${req.body?.pairPhone ? ' (pairing code)' : ' (QR)'}`);
    res.json(info);
  }));
  api.post('/accounts/:id/unlink', wrap(async (req, res) => {
    await manager.unlink(req.params.id);
    await act(req, req.params.id, 'Unlinked the number from WhatsApp');
    res.json({ ok: true });
  }));

  // Clean stop: finishes writing, releases every number so another server can take over, then exits.
  api.post('/shutdown', wrap(async (req, res) => {
    res.json({ ok: true, note: 'Stopping — numbers are released for another server.' });
    setTimeout(() => req.app.locals.shutdown?.('api'), 200);
  }));

  // ---- Chats, messages, contacts
  api.get('/accounts/:id/chats', wrap(async (req, res) => {
    const { q, kind, tag, limit, offset, waiting, state } = req.query;
    res.json(await store.listChats(req.params.id, {
      q, kind, tag, state, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0, waitingOnMe: waiting === '1',
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
  // Deep history: pull older messages chat by chat from the phone. Body: { since?: 'YYYY-MM-DD', groups?: bool }
  api.post('/accounts/:id/backfill', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    const r = await outbox.requestJob(s, 'backfill', { sinceTs: toTs(req.body?.since) || 0, includeGroups: !!req.body?.groups });
    await act(req, s.id, `Started deep history import (back to ${req.body?.since || 'the beginning'}, ${req.body?.groups ? 'people + groups' : 'people only'})`);
    res.json({ ok: true, jobId: r.jobId });
  }));
  api.post('/jobs/:id/cancel', wrap(async (req, res) => {
    const [j] = await query(`UPDATE jobs SET status = 'cancelled', done_at = now() WHERE id = $1 AND status IN ('pending','running') RETURNING account_id, kind`, [req.params.id]);
    if (j) await act(req, j.account_id, `Stopped ${j.kind === 'backfill' ? 'deep history import' : j.kind} (job #${req.params.id})`);
    res.json({ ok: true });
  }));
  api.get('/accounts/:id/contacts/:jid', wrap(async (req, res) => res.json(await store.getContact(req.params.id, req.params.jid))));
  api.patch('/accounts/:id/contacts/:jid', wrap(async (req, res) => {
    const b = req.body || {};
    const c = await store.updateContact(req.params.id, req.params.jid, b);
    const what = [b.addTags?.length && `+tags ${b.addTags.join(',')}`, b.removeTags?.length && `-tags ${b.removeTags.join(',')}`,
      b.leadStatus !== undefined && `status ${b.leadStatus || '(none)'}`, b.notes !== undefined && 'notes'].filter(Boolean).join(', ');
    if (what) await act(req, req.params.id, `Edited contact ${req.params.jid.split('@')[0]}: ${what}`);
    res.json(c);
  }));

  api.get('/search', wrap(async (req, res) => {
    const { account, q, chat, fromMe, since, until, type, limit } = req.query;
    res.json(await store.searchMessages(account || null, q, {
      chatJid: chat, fromMe: fromMe === undefined ? undefined : fromMe === 'true',
      sinceTs: toTs(since), untilTs: toTs(until), type, limit: parseInt(limit, 10) || 50,
    }));
  }));

  // ---- Templates (saved messages with {fields})
  api.get('/templates', wrap(async (req, res) => res.json(await templates.listTemplates(req.query.account))));
  api.post('/templates', wrap(async (req, res) => {
    const t = await templates.saveTemplate(req.body || {});
    await act(req, t.account_id, `Saved template "${t.name}"`);
    res.json(t);
  }));
  api.patch('/templates/:id', wrap(async (req, res) => {
    const t = await templates.saveTemplate({ ...(req.body || {}), id: req.params.id });
    await act(req, t.account_id, `Edited template "${t.name}"`);
    res.json(t);
  }));
  api.delete('/templates/:id', wrap(async (req, res) => {
    const t = await templates.deleteTemplate(req.params.id);
    await act(req, t.account_id, `Deleted template "${t.name}"`);
    res.json({ ok: true });
  }));

  // ---- Rules
  api.get('/rules', wrap(async (req, res) => res.json(await rules.listRules(req.query.account))));
  api.post('/rules', wrap(async (req, res) => {
    const r = await rules.saveRule(req.body || {});
    await act(req, r.account_id, `Saved rule "${r.name}"`);
    res.json(r);
  }));
  api.patch('/rules/:id', wrap(async (req, res) => {
    const r = await rules.saveRule({ ...(req.body || {}), id: req.params.id });
    await act(req, r.account_id, `Edited rule "${r.name}"${r.enabled ? '' : ' (off)'}`);
    res.json(r);
  }));
  api.delete('/rules/:id', wrap(async (req, res) => {
    const r = await rules.deleteRule(req.params.id);
    await act(req, r.account_id, `Deleted rule "${r.name}"`);
    res.json({ ok: true });
  }));

  // ---- Contact lists (candidate batches) + follow-ups
  api.get('/lists', wrap(async (req, res) => {
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1)', [req.query.account || null])) await lists.refreshList(l.id);
    res.json(await lists.listLists(req.query.account, req.query.role));
  }));
  // Create/extend a list: { account, name, since?, source?, members: [{ phone, name, message?, ...fields }], followup? }
  api.post('/lists/import', wrap(async (req, res) => {
    const r = await lists.importList(req.body || {});
    await act(req, r.list.account_id, `Imported ${r.imported} people into list "${r.list.name}"${r.skipped.length ? ` (${r.skipped.length} skipped)` : ''}`, r.list.role);
    res.json(r);
  }));
  api.get('/lists/:id/members', wrap(async (req, res) => {
    const l = await lists.getList(req.params.id);
    await lists.refreshList(l.id);
    res.json(await lists.listMembers(l.id, { status: req.query.status, outcome: req.query.outcome }));
  }));
  api.patch('/lists/:id/members/:phone', wrap(async (req, res) => {
    const l = await lists.getList(req.params.id);
    const m = await lists.updateMember(l.id, req.params.phone, req.body || {});
    await act(req, l.account_id, `${m.name || m.phone}${req.body?.stage !== undefined ? ' → ' + (m.stage || 'no stage') : ''}${m.visit_at && req.body?.visitAt ? ' (visit ' + new Date(m.visit_at).toLocaleString('en-GB', { timeZone: config.tz }) + ')' : ''}${req.body?.outcome !== undefined ? ' – ' + (req.body.outcome || 'no outcome') : ''}${req.body?.notes ? ' (note)' : ''} — ${l.name}`, l.role);
    res.json(m);
  }));
  api.patch('/lists/:id/followup', wrap(async (req, res) => {
    const l = await lists.getList(req.params.id);
    const u = await lists.setFollowup(l.id, req.body || {});
    const f = u.followup;
    await act(req, l.account_id, `Follow-ups for "${l.name}": ${f.enabled ? `on — after ${f.afterDays} day(s), up to ${f.max}` : 'off'}`, l.role);
    res.json(u);
  }));
  api.post('/lists/:id/send', wrap(async (req, res) => {
    const l = await lists.getList(req.params.id);
    const r = await lists.sendToList(l.id, { ...(req.body || {}), createdBy: 'you' });
    await act(req, l.account_id, `List "${l.name}": sending to ${r.queued} (${(req.body?.statuses || ['new', 'failed']).join(', ')})`, l.role);
    res.json(r);
  }));
  api.patch('/lists/:id/pipeline', wrap(async (req, res) => {
    const l = await lists.getList(req.params.id);
    const u = await lists.setPipeline(l.id, req.body || {});
    await act(req, l.account_id, `Pipeline settings for "${l.name}" updated`, l.role);
    res.json(u);
  }));
  api.get('/pipeline', wrap(async (req, res) => res.json(await lists.pipelineSummary(req.query.account, req.query.role))));
  api.get('/roles', wrap(async (req, res) => res.json((await query(`SELECT DISTINCT role FROM lists WHERE role IS NOT NULL ORDER BY role`)).map((r) => r.role))));
  // Everyone already contacted for a role (all batches) — to de-duplicate a new batch before unlocking
  api.get('/known', wrap(async (req, res) => res.json(await lists.knownPeople(req.query.role, req.query.account))));
  api.get('/alerts', wrap(async (req, res) => res.json({ phones: await notify.alertPhones() })));
  api.put('/alerts', wrap(async (req, res) => {
    const phones = await notify.setAlertPhones(req.body?.phones);
    await act(req, null, `Alert phone(s) set: ${phones.map((p) => '+' + p).join(', ') || 'none'}`);
    res.json({ phones });
  }));
  api.get('/playbook', wrap(async (req, res) => res.json(await getPlaybook())));
  api.put('/playbook', wrap(async (req, res) => {
    const p = await savePlaybook(req.body?.text);
    await act(req, null, 'Updated the playbook');
    res.json(p);
  }));
  // Rows with status columns, e.g. for the Google Sheets script to write back
  api.get('/lists/:id/export', wrap(async (req, res) => res.json(await lists.exportRows((await lists.getList(req.params.id)).id))));

  // ---- One person across all numbers
  api.get('/people', wrap(async (req, res) => res.json(await findPerson(req.query.q))));

  // ---- Chat state: open / snoozed (remind me on a date) / done
  api.patch('/accounts/:id/chats/:jid/state', wrap(async (req, res) => {
    const { state, until, note } = req.body || {};
    const r = await store.setChatState(req.params.id, req.params.jid, state, { until, note });
    await act(req, req.params.id, `Chat ${req.params.jid.split('@')[0]} → ${state === 'snoozed' ? `remind on ${new Date(until).toLocaleString('en-GB', { timeZone: config.tz })}${note ? ' (' + note + ')' : ''}` : state}`);
    res.json(r);
  }));

  // ---- Sending
  api.post('/send', wrap(async (req, res) => {
    const { account, to, wait = true, template, vars, replyTo } = req.body || {};
    let { text, attachment } = req.body || {};
    if (!to) throw new Error('Missing "to" (phone number or chat id)');
    if (template) {
      const s = await manager.resolve(account);
      const r = await outbox.renderTemplate(s.id, store.toJid(to), template, vars || {});
      text = text || r.payload.text;
      attachment = attachment || r.payload.attachment;
    }
    const row = await outbox.enqueue({ account, to, payload: { text, attachment, ...(replyTo ? { replyTo } : {}) }, source: req.body?.source === 'dashboard' ? 'dashboard' : 'api', idemKey: req.body?.idempotencyKey || req.get('idempotency-key') });
    if (row.duplicate && ['sent', 'failed', 'rejected'].includes(row.status)) return res.status(row.status === 'sent' ? 200 : 502).json(row);
    if (req.body?.source === 'dashboard' && actorOf(req) === 'you') await act(req, row.account_id, `Sent a message from the dashboard to ${row.to_jid.split('@')[0]}`);
    if (!wait) return res.json(row);
    const result = await outbox.waitFor(row.id);
    if (!result) return res.status(202).json({ ...row, note: 'Still queued (number not connected?)' });
    res.status(result.status === 'sent' ? 200 : 502).json(result);
  }));

  api.get('/outbox', wrap(async (req, res) => res.json(await outbox.listOutbox({
    account: req.query.account, status: req.query.status, taskId: req.query.task, limit: parseInt(req.query.limit, 10) || 50,
  }))));

  // ---- Task board
  api.get('/tasks', wrap(async (req, res) => res.json(await tasks.listTasks({ account: req.query.account, past: req.query.past === '1', role: req.query.role }))));
  api.post('/tasks', wrap(async (req, res) => {
    const { account, title, details, dueAt } = req.body || {};
    const s = await manager.resolve(account);
    const t = await tasks.createTask({ account: s.id, title, details, dueAt, createdBy: 'you' });
    await act(req, s.id, `Created task #${t.id} "${t.title}"`);
    res.json(t);
  }));
  api.patch('/tasks/:id', wrap(async (req, res) => {
    const t = await tasks.updateTask(req.params.id, req.body || {});
    await act(req, t.account_id, `Updated task #${t.id} "${t.title}"${req.body?.status ? ` → ${t.status}` : ''}`);
    res.json(t);
  }));
  api.post('/tasks/:id/approve', wrap(async (req, res) => {
    const r = await outbox.approveTask(req.params.id);
    const [t] = await query('SELECT account_id, title FROM tasks WHERE id = $1', [req.params.id]);
    await act(req, t?.account_id, `Approved ${r.approved} messages of task #${req.params.id} "${t?.title}"`);
    res.json(r);
  }));
  api.post('/tasks/:id/cancel', wrap(async (req, res) => {
    const t = await tasks.cancelTask(req.params.id);
    await act(req, t.account_id, `Cancelled task #${t.id} "${t.title}"`);
    res.json(t);
  }));
  // Bulk send: { account, title, text (use {name}), recipients: [{ to, name, ... }], attachment?, scheduledAt?, skipIfContactedDays? }
  api.post('/bulk', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await outbox.bulkSend({ ...b, source: b.automated === false ? 'api' : 'campaign', createdBy: 'you', idemKey: b.idempotencyKey || req.get('idempotency-key') });
    if (r.task) await act(req, r.task.account_id || b.account, `Created bulk send "${b.title}": ${r.queued} recipients, ${r.skipped.length} skipped`);
    res.json(r);
  }));
  // Per number: what is waiting, why, and until when (?account= for one number)
  api.get('/outbox/status', wrap(async (req, res) => {
    await manager.refresh();
    const ids = req.query.account ? [(await manager.resolve(req.query.account)).id] : manager.list().map((a) => a.id);
    res.json(await Promise.all(ids.map((id) => outbox.queueStatus(id))));
  }));
  // Approve all drafts: { account?, task? } — omitted = every number
  api.post('/outbox/approve-all', wrap(async (req, res) => {
    const b = req.body || {};
    const account = b.account ? (await manager.resolve(b.account)).id : null;
    const r = await outbox.approveAll({ account, taskId: b.task || null });
    for (const [a, n] of Object.entries(r.perAccount)) await act(req, a, `Approved all ${n} drafts${b.task ? ` of task #${b.task}` : ''}`);
    res.json(r);
  }));
  // Selected messages: { ids: [..] } → approve / reject; { ids, account } → move to another number (as drafts)
  const idsOf = (req) => {
    const ids = (req.body?.ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('Select at least one message');
    return ids;
  };
  api.post('/outbox/approve-selected', wrap(async (req, res) => {
    const r = await outbox.approveAll({ ids: idsOf(req) });
    for (const [acc, n] of Object.entries(r.perAccount)) await act(req, acc, `Approved ${n} selected drafts`);
    res.json(r);
  }));
  api.post('/outbox/reject-selected', wrap(async (req, res) => {
    const r = await outbox.rejectMany(idsOf(req));
    for (const [acc, n] of Object.entries(r.perAccount)) await act(req, acc, `Rejected ${n} selected messages`);
    res.json(r);
  }));
  api.post('/outbox/move', wrap(async (req, res) => {
    const ids = idsOf(req);
    if (!req.body?.account) throw new Error('Choose the number that should send them');
    const r = await outbox.moveToAccount(ids, req.body.account);
    for (const [acc, n] of Object.entries(r.from)) {
      await act(req, acc, `Moved ${n} unsent messages to "${r.toLabel}"`);
      await act(req, r.to, `Received ${n} messages from "${acc}" (${r.approved} already approved, ${r.drafts} drafts)`);
    }
    res.json(r);
  }));
  api.post('/outbox/:id/approve', wrap(async (req, res) => {
    const r = await outbox.approve(req.params.id, req.body || {});
    await act(req, r.account_id, `Approved draft #${r.id} to ${r.to_jid.split('@')[0]}${req.body?.text ? ' (edited)' : ''}`);
    res.json(r);
  }));
  api.post('/outbox/:id/reject', wrap(async (req, res) => {
    const r = await outbox.reject(req.params.id);
    await act(req, r.account_id, `Rejected ${r.status === 'rejected' ? 'draft' : 'message'} #${r.id} to ${r.to_jid.split('@')[0]}`);
    res.json(r);
  }));

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
    const conds = [];
    if (req.query.account) {
      p.push(req.query.account);
      conds.push(`account_id = $${p.length}`);
    }
    if (req.query.actor) {
      p.push(req.query.actor.split(','));
      conds.push(`actor = ANY($${p.length})`);
    }
    if (req.query.role) {
      p.push(req.query.role);
      conds.push(`lower(role) = lower($${p.length})`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
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
  app.get('/', (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml()));
  return app;
}
