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
import { mountMetaWebhook } from './meta.js';
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
import { priceRows, getPricing, savePricing } from './pricing.js';

/** Total cost of a task's messages (bulk / list sends), for the reply right after creating them. */
async function taskCost(taskId) {
  if (!taskId) return null;
  const rows = await query(`SELECT account_id, payload FROM outbox WHERE task_id = $1 AND status IN ('draft','queued')`, [taskId]);
  const p = await priceRows(rows, manager);
  return { total: Math.round(p.total * 100) / 100, count: rows.length, perMessage: rows.length ? p.items[0].price : 0, currency: p.currency };
}
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
  // Raw body kept only for Meta's webhook signature check.
  app.use(express.json({ limit: '30mb', verify: (req, res, buf) => { if (req.url.startsWith('/meta/')) req.rawBody = buf; } }));
  app.use(cookieParser());

  // Always 200 (Render restarts on a failing health check); problems are reported in the body
  app.get('/health', async (req, res) => {
    const { lastSync } = await import('./board.js');
    const dbOk = await Promise.race([query('SELECT 1').then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]).catch(() => false);
    const stale = !lastSync.at || Date.now() - new Date(lastSync.at).getTime() > 25 * 60000;
    res.json({
      ok: true,
      db: dbKind(),
      dbOk,
      version: VERSION,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576), // Render free plan: 512 MB
      accounts: manager.list().map((a) => ({ id: a.id, status: a.status })),
      // the 10-minute Board re-check: when it last ran and how it went
      board: { ...lastSync, late: stale },
    });
  });

  app.post('/login', (req, res) => {
    if (req.body?.key !== config.apiKey) return res.status(401).json({ error: 'Wrong key' });
    res.cookie('hub_key', config.apiKey, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, secure: req.secure });
    res.json({ ok: true });
  });
  app.post('/logout', (req, res) => res.clearCookie('hub_key').json({ ok: true }));

  // Meta WhatsApp Cloud API webhook (its own checks: verify token + signature).
  mountMetaWebhook(app);
  // Public privacy policy (Meta needs it before the app can go Live).
  app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));

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
  // Every page loads this: the per-number checks run in parallel, and message/chat counts (they scan the big
  // tables) are cached for a minute — they don't need to be exact to the second.
  const statsCache = new Map();
  const cachedStats = async (id) => {
    const hit = statsCache.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    const v = await store.accountStats(id);
    statsCache.set(id, { v, at: Date.now() });
    return v;
  };
  api.get('/accounts', wrap(async (req, res) => {
    await manager.refresh();
    const list = manager.list();
    await Promise.all(list.map(async (a) => {
      [a.stats, a.backfill, a.newChats] = await Promise.all([cachedStats(a.id), outbox.backfillStatus(a.id), outbox.newChatsStatus(a.id, a.settings)]);
    }));
    res.json(list);
  }));
  // Cheap counter for the navigation badge (instead of downloading every draft)
  api.get('/outbox/count', wrap(async (req, res) => {
    const [r] = await query(`SELECT count(*)::int AS n FROM outbox WHERE status = ANY($1)`, [String(req.query.status || 'draft').split(',')]);
    res.json(r);
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

  // ---- Meta Cloud API
  // What is set up (never the secrets themselves) + each Cloud number's health
  api.get('/meta/status', wrap(async (req, res) => {
    const has = (k) => !!process.env[k];
    const numbers = manager.list().filter((a) => a.provider === 'cloud').map((a) => ({ id: a.id, label: a.label, status: a.status, cloud: a.cloud, error: manager.get(a.id).lastError || null }));
    const [last] = await query(`SELECT created_at, text FROM events WHERE text LIKE 'Meta webhook%' ORDER BY id DESC LIMIT 1`);
    res.json({
      env: { META_TOKEN: has('META_TOKEN'), META_APP_SECRET: has('META_APP_SECRET'), META_VERIFY_TOKEN: has('META_VERIFY_TOKEN'), META_PIN: has('META_PIN'), META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID || null, META_WABA_ID: process.env.META_WABA_ID || null },
      numbers, lastWebhookEvent: last || null, webhookUrl: config.publicUrl ? `${config.publicUrl}/meta/webhook` : null,
    });
  }));
  // Meta templates of a Cloud number (?sync=1 fetches fresh from Meta first)
  api.get('/accounts/:id/wa-templates', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s.isCloud) return res.json([]);
    const { syncTemplates, listWaTemplates } = await import('./wa/cloud-templates.js');
    if (req.query.sync === '1') await syncTemplates(s.wabaId);
    res.json(await listWaTemplates(s.wabaId, { approvedOnly: req.query.approved === '1' }));
  }));
  // Submit a new Meta template for review: { name, language?, category: UTILITY|MARKETING, body, examples, header?, footer?, buttons? }
  api.post('/accounts/:id/wa-templates', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s.isCloud) throw new Error('Meta templates are only for Meta Cloud API numbers');
    const { createTemplate } = await import('./wa/cloud-templates.js');
    const r = await createTemplate(s.wabaId, req.body || {});
    await act(req, s.id, `Submitted Meta template "${r.name}" (${r.category || req.body?.category}) for review — ${String(r.status || 'pending').toLowerCase()}`);
    res.json(r);
  }));
  // Full Meta health check of a Cloud number (access, can-send status and why, webhook, templates, failures, billable)
  api.get('/accounts/:id/meta-health', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s.isCloud) throw new Error('Health check is for Meta Cloud API numbers');
    res.json(await s.healthCheck());
  }));
  // What happened to one message (wamid) or one person (phone): outbox rows + Meta's events
  api.get('/accounts/:id/meta-timeline', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s.isCloud) throw new Error('Timeline is for Meta Cloud API numbers');
    res.json(await s.timeline(req.query.q || ''));
  }));
  // Can this chat get a free-form message right now? (Cloud numbers: 24 h after their last message)
  api.get('/accounts/:id/chats/:jid/window', wrap(async (req, res) => {
    const s = manager.get(req.params.id);
    res.json(s.isCloud ? { cloud: true, ...(await s.windowFor(req.params.jid)) } : { cloud: false, open: true });
  }));

  // ---- Chats, messages, contacts
  api.get('/accounts/:id/chats', wrap(async (req, res) => {
    const { q, kind, tag, limit, offset, waiting, state, role } = req.query;
    res.json(await store.listChats(req.params.id, {
      q, kind, tag, state, role, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0, waitingOnMe: waiting === '1',
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
  // Phone address book (linked numbers only): never fails the save — the result says what happened
  const savePhone = async (accountId, jid, name) => {
    const s = manager.get(accountId);
    if (!s || s.isCloud) return { ok: false, reason: 'Meta API numbers have no phone address book — saved in the hub only' };
    try {
      await s.saveContactToPhone(jid, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  };
  api.patch('/accounts/:id/contacts/:jid', wrap(async (req, res) => {
    const b = req.body || {};
    const c = await store.updateContact(req.params.id, req.params.jid, b);
    let phone = null;
    if (b.name && b.savePhone) phone = await savePhone(req.params.id, req.params.jid, b.name);
    const what = [b.addTags?.length && `+tags ${b.addTags.join(',')}`, b.removeTags?.length && `-tags ${b.removeTags.join(',')}`,
      b.leadStatus !== undefined && `status ${b.leadStatus || '(none)'}`, b.notes !== undefined && 'notes', b.name && `name "${b.name}"`].filter(Boolean).join(', ');
    if (what) await act(req, req.params.id, `Edited contact ${req.params.jid.split('@')[0]}: ${what}`);
    res.json(phone ? { ...c, phone_saved: phone } : c);
  }));
  // New contact: { phone, name, savePhone } — saved in the hub (and the phone), with an empty chat to message them
  api.post('/accounts/:id/contacts', wrap(async (req, res) => {
    const s = await manager.resolve(req.params.id);
    const { phone, name, savePhone: toPhone } = req.body || {};
    const c = await store.saveContact(s.id, phone, name);
    const phoneResult = toPhone ? await savePhone(s.id, c.jid, c.name) : null;
    await act(req, s.id, `Saved contact ${c.name} +${c.jid.split('@')[0]}${phoneResult?.ok ? ' (also on the phone)' : ''}`);
    res.json({ ...c, phone_saved: phoneResult });
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
    // ?archived=1 includes archived lists
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1) AND ($2 OR archived IS NULL)', [req.query.account || null, req.query.archived === '1'])) await lists.refreshList(l.id);
    res.json(await lists.listLists(req.query.account, req.query.role, { includeArchived: req.query.archived === '1' }));
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
    r.cost = await taskCost(r.task?.id);
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
  api.get('/roles', wrap(async (req, res) => res.json((await query(`SELECT DISTINCT role FROM lists WHERE role IS NOT NULL AND archived IS NULL ORDER BY role`)).map((r) => r.role))));
  // Campaigns (job roles) with what is open in each: drafts, open cards, lists — for the campaign picker
  api.get('/campaigns', wrap(async (req, res) => {
    const { roleOf } = await import('./campaign.js');
    res.json(await query(
      `SELECT r.role,
         (SELECT count(*)::int FROM lists l WHERE l.role = r.role AND l.archived IS NULL) AS lists,
         (SELECT count(*)::int FROM outbox o WHERE o.status = 'draft' AND COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')}) = r.role) AS drafts,
         (SELECT count(*)::int FROM tasks t WHERE t.status NOT IN ('done','cancelled') AND t.role = r.role) AS cards
       FROM (SELECT DISTINCT role FROM lists WHERE role IS NOT NULL AND archived IS NULL) r ORDER BY r.role`,
    ));
  }));
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
    const { account, to, wait: waitArg = true, template, vars, replyTo, waTemplate } = req.body || {};
    // scheduleAt (ISO): send later — shows on the Board until it goes out; the call returns at once
    const scheduledAt = req.body?.scheduleAt || undefined;
    if (scheduledAt && isNaN(new Date(scheduledAt))) throw new Error('Could not read scheduleAt');
    const wait = scheduledAt ? false : waitArg;
    let { text, attachment } = req.body || {};
    if (!to) throw new Error('Missing "to" (phone number or chat id)');
    if (waTemplate) {
      // Meta template (Cloud API numbers): { name, language?, params: [...] }
      const row = await outbox.enqueue({ account, to, payload: { waTemplate }, source: req.body?.source === 'dashboard' ? 'dashboard' : 'api', idemKey: req.body?.idempotencyKey || req.get('idempotency-key'), scheduledAt });
      if (req.body?.source === 'dashboard' && actorOf(req) === 'you') await act(req, row.account_id, `Sent Meta template "${waTemplate.name}" to ${row.to_jid.split('@')[0]}`);
      if (!wait) return res.json(row);
      const result = await outbox.waitFor(row.id);
      if (!result) return res.status(202).json({ ...row, note: 'Still queued' });
      return res.status(result.status === 'sent' ? 200 : 502).json(result);
    }
    if (template) {
      const s = await manager.resolve(account);
      const r = await outbox.renderTemplate(s.id, store.toJid(to), template, vars || {});
      text = text || r.payload.text;
      attachment = attachment || r.payload.attachment;
    }
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons.filter(Boolean).slice(0, 3) : undefined;
    const row = await outbox.enqueue({ account, to, payload: { text, attachment, ...(replyTo ? { replyTo } : {}), ...(buttons?.length ? { buttons } : {}) }, source: req.body?.source === 'dashboard' ? 'dashboard' : 'api', idemKey: req.body?.idempotencyKey || req.get('idempotency-key'), scheduledAt });
    if (row.duplicate && ['sent', 'failed', 'rejected'].includes(row.status)) return res.status(row.status === 'sent' ? 200 : 502).json(row);
    if (req.body?.source === 'dashboard' && actorOf(req) === 'you') await act(req, row.account_id, `Sent a message from the dashboard to ${row.to_jid.split('@')[0]}`);
    if (!wait) return res.json(row);
    const result = await outbox.waitFor(row.id);
    if (!result) return res.status(202).json({ ...row, note: 'Still queued (number not connected?)' });
    res.status(result.status === 'sent' ? 200 : 502).json(result);
  }));

  api.get('/outbox', wrap(async (req, res) => {
    const rows = await outbox.listOutbox({
      account: req.query.account, status: req.query.status, taskId: req.query.task, limit: parseInt(req.query.limit, 10) || 50, role: req.query.role,
    });
    // Each message's price (Meta numbers; linked phones are free), shown on the draft cards and summed in approvals
    const p = await priceRows(rows, manager);
    rows.forEach((r, i) => Object.assign(r, { price: p.items[i].price, price_category: p.items[i].category, price_note: p.items[i].note, window_closes_at: p.items[i].closesAt || null, currency: p.currency }));
    // Picture the person will get: a Meta template's header image, or an attached photo (shown on the draft card)
    const headers = new Map((await query(`SELECT name, header_link FROM wa_templates WHERE header_link IS NOT NULL`)).map((t) => [t.name, t.header_link]));
    for (const r of rows) {
      const a = r.payload?.attachment;
      const t = r.payload?.waTemplate;
      const isImg = (x) => /^image\//.test(x?.mimetype || '') || x?.as === 'image' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(x?.url || x?.fileName || '');
      if (t) r.preview_image = (typeof t.header === 'string' ? t.header : t.header?.link) || headers.get(t.name) || null;
      else if (a && isImg(a)) r.preview_image = a.url || (a.base64 && a.base64.length < 2_000_000 ? (a.base64.startsWith('data:') ? a.base64 : `data:${a.mimetype || 'image/jpeg'};base64,${a.base64}`) : null);
    }
    res.json(rows);
  }));
  // Cost before sending: { account, count, waTemplate? } → per message and total
  api.post('/outbox/estimate', wrap(async (req, res) => {
    const { account, count = 1, waTemplate, text } = req.body || {};
    const s = await manager.resolve(account);
    const n = Math.max(0, Math.min(10000, parseInt(count, 10) || 0));
    const p = await priceRows([{ account_id: s.id, payload: waTemplate ? { waTemplate } : { text: text || 'x' } }], manager);
    const item = p.items[0];
    res.json({ count: n, perMessage: item.price, total: item.price * n, category: item.category, note: item.note, currency: p.currency });
  }));
  api.get('/pricing', wrap(async (req, res) => res.json(await getPricing())));
  api.put('/pricing', wrap(async (req, res) => {
    const p = await savePricing(req.body || {});
    await act(req, null, `Meta prices set: marketing ${p.marketing}, utility ${p.utility}, authentication ${p.authentication} ${p.currency}`);
    res.json(p);
  }));

  // ---- Task board
  // ?kind=reply → only "Reply to …" cards (candidates waiting for an answer); also followup, visit, scheduled, reminder, bulk, todo
  // ?for=you|ai → the owner's or the AI's cards; ?due_now=1 → due within the next hour or overdue
  api.get('/tasks', wrap(async (req, res) => {
    const rows = await tasks.listTasks({ account: req.query.account, past: req.query.past === '1', role: req.query.role, assignee: req.query.for,
      dueBefore: req.query.due_now === '1' ? new Date(Date.now() + 3600000) : undefined });
    res.json(req.query.kind ? rows.filter((t) => t.kind === req.query.kind) : rows);
  }));
  // Re-check the board now (unanswered replies, visits, reminders) instead of waiting for the 10-minute check
  api.post('/board/sync', wrap(async (req, res) => {
    const { syncBoard } = await import('./board.js');
    res.json(await syncBoard());
  }));
  api.post('/tasks', wrap(async (req, res) => {
    const { account, title, details, dueAt, assignee, priority } = req.body || {};
    const s = await manager.resolve(account);
    const t = await tasks.createTask({ account: s.id, title, details, dueAt, createdBy: actorOf(req) === 'you' ? 'you' : 'ai', assignee, priority });
    await act(req, s.id, `Created task #${t.id} "${t.title}"`);
    res.json(t);
  }));
  // ---- Contact book (hub-wide, by group): GET ?q=&category=, groups, POST, PATCH, DELETE
  api.get('/directory', wrap(async (req, res) => {
    const d = await import('./directory.js');
    res.json(await d.search({ q: req.query.q || '', category: req.query.category || '', limit: Number(req.query.limit) || 300 }));
  }));
  api.get('/directory/groups', wrap(async (req, res) => {
    const d = await import('./directory.js');
    res.json({ groups: await d.groups(), suggested: d.SUGGESTED_GROUPS });
  }));
  api.post('/directory', wrap(async (req, res) => {
    const d = await import('./directory.js');
    const b = req.body || {};
    const row = await d.saveEntry({ ...b, createdBy: 'you' });
    if (b.account && b.name) await store.updateContact(b.account, row.jid, { name: b.name }).catch(() => {});
    await act(req, b.account || null, `Saved ${row.name || row.phone} in Contacts → ${row.category}`);
    res.json(row);
  }));
  api.patch('/directory/:id', wrap(async (req, res) => {
    const d = await import('./directory.js');
    res.json(await d.update(req.params.id, req.body || {}));
  }));
  api.delete('/directory/:id', wrap(async (req, res) => {
    const d = await import('./directory.js');
    res.json(await d.remove(req.params.id));
  }));
  // ---- Settings for all numbers (each number keeps the settings it changed itself)
  api.get('/settings/defaults', wrap(async (req, res) => {
    const d = await import('./defaults.js');
    const defaults = await d.getDefaults();
    res.json({ defaults, numbers: manager.list().map((a) => ({ id: a.id, label: a.label, own: d.ownKeys(a.settings, defaults) })) });
  }));
  api.put('/settings/defaults', wrap(async (req, res) => {
    const d = await import('./defaults.js');
    const r = await d.saveDefaults(req.body || {}, manager);
    const changed = r.numbers.filter((n) => n.changed.length);
    await act(req, null, `Changed settings for all numbers${changed.length ? ' — applied to ' + changed.map((n) => n.label).join(', ') : ''}`);
    res.json(r);
  }));
  api.post('/accounts/:id/settings/reset', wrap(async (req, res) => {
    const d = await import('./defaults.js');
    const acc = await d.resetToDefaults(req.params.id, manager);
    await act(req, acc.id, 'Settings reset to the defaults for all numbers');
    res.json(acc);
  }));
  // One-screen overview (same as the AI's hub_overview)
  api.post('/lists/:id/archive', wrap(async (req, res) => {
    const r = await lists.archiveList(req.params.id, req.body?.archived !== false, req.body?.reason);
    await act(req, r.list.account_id, `${r.list.archived ? 'Archived' : 'Unarchived'} list "${r.list.name}"`, r.list.role);
    res.json(r);
  }));
  api.delete('/lists/:id/members/:phone', wrap(async (req, res) => {
    const r = await lists.removeMembers(req.params.id, [req.params.phone]);
    if (!r.removed.length) return res.status(400).json({ error: r.kept[0]?.reason || 'Not removed' });
    await act(req, r.list.account_id, `Removed ${r.removed[0]} from list "${r.list.name}"`, r.list.role);
    res.json(r);
  }));
  // Meta error codes: meaning, what to do, whether the hub retries (for "what to do" lines on failed cards)
  api.get('/meta-errors', wrap(async (req, res) => {
    const { metaHelpTable } = await import('./wa/graph.js');
    res.json(metaHelpTable());
  }));
  // One note on several cards, e.g. "these people did not pick up — follow up on WhatsApp". aiTask: also a card for
  // the AI (due now) listing them; close: the selected cards are done (the AI card takes over).
  api.post('/tasks/bulk-note', wrap(async (req, res) => {
    const { ids = [], text = '', aiTask = true, close = false } = req.body || {};
    const r = await tasks.bulkNote(ids, text, { aiTask, close, actor: 'you' });
    await act(req, r.task?.account_id || null, `Note on ${r.noted} card(s)${r.task ? ` → task #${r.task.id} for the AI` : ''}: ${String(text).slice(0, 80)}`);
    res.json(r);
  }));
  // A card's history (what happened and why) and its notes
  api.get('/tasks/:id/log', wrap(async (req, res) => res.json(await tasks.taskLog(req.params.id))));
  api.post('/tasks/:id/notes', wrap(async (req, res) => {
    // dashboard and the owner's scripts write as the owner; the AI writes through MCP (add_task_note)
    const t = await tasks.addNote(req.params.id, req.body?.text, 'you');
    res.json({ ok: true, id: t.id });
  }));
  api.patch('/tasks/:id', wrap(async (req, res) => {
    const t = await tasks.updateTask(req.params.id, { ...(req.body || {}), actor: 'you' }); // the AI changes cards through MCP
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
    r.cost = await taskCost(r.task?.id);
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
    const r = await outbox.rejectMany(idsOf(req), { reason: req.body?.reason || '', actor: 'you' });
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
    const r = await outbox.reject(req.params.id, { reason: req.body?.reason || '', actor: 'you' });
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
    // ?download=1 saves the file on the device (phones ignore 'open in new tab' for many types)
    const ext = (mimetype || '').split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') || 'bin';
    const fname = (row.media.fileName || `${jid.split('@')[0]}-${new Date(Number(row.ts) * 1000).toISOString().slice(0, 10)}-${msgId.slice(-6)}.${ext}`).replace(/["\\]/g, '');
    // Headers must be plain ASCII (a Hindi or accented file name made Node throw): ASCII fallback + the real name in filename*
    const ascii = fname.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${ascii}"${ascii !== fname ? `; filename*=UTF-8''${encodeURIComponent(fname)}` : ''}`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  }));

  api.get('/events', wrap(async (req, res) => {
    const p = [Math.min(parseInt(req.query.limit, 10) || 100, 1000)];
    const conds = [];
    if (req.query.account) {
      p.push(req.query.account);
      conds.push(`account_id = $${p.length}`);
    }
    // ?problems=1 → only warnings and errors (the first place to look when "something is going wrong")
    if (req.query.problems === '1') conds.push(`level IN ('warn','error')`);
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
