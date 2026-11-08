/**
 * A "desk": a home-screen page (PWA) for whoever holds ONE number — a doctor, a manager, a receptionist. Its key opens
 * only that number's drafts: read them with the last messages of the chat, edit, approve (send) or reject. Nothing
 * else of the hub is reachable with it, and it cannot see other numbers. A desk can also show one outside page next to
 * the drafts (e.g. a Google Apps Script web app the business uses), so the person has a single icon on their phone.
 *
 * Keys: random, shown once, only their SHA-256 is stored (config 'desks'). Made and revoked by the owner (REST
 * /api/desks, main key only). Wrong keys count towards the same guess limit as the main key.
 */
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, logEvent } from './db.js';
import { manager } from './wa/manager.js';
import * as outbox from './outbox.js';
import { getAvatar } from './avatars.js';
import { keyGuessBlocked } from './auth.js';
import config from './config.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const sha = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

async function readDesks() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'desks'`);
  return r?.value?.items || [];
}
async function writeDesks(items) {
  await query(`INSERT INTO config (key, value) VALUES ('desks', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ items })]);
}
/** The desks that exist (never their keys): [{ account, label, appName, appUrl, createdAt }] */
export async function listDesks() {
  return (await readDesks()).map(({ hash, ...d }) => d);
}
/** Make (or replace) the desk of one number. Returns the key and the link — shown once. */
export async function createDesk({ account, label, appName = '', appUrl = '' } = {}) {
  const session = await manager.resolve(account);
  if (appUrl && !/^https:\/\//.test(String(appUrl))) throw new Error('The extra page must be an https:// link');
  const key = crypto.randomBytes(24).toString('hex');
  const items = (await readDesks()).filter((d) => d.account !== session.id);
  items.push({ hash: sha(key), account: session.id, label: String(label || session.account.label || session.id).slice(0, 40), appName: String(appName || '').slice(0, 30), appUrl: String(appUrl || ''), createdAt: new Date().toISOString() });
  await writeDesks(items);
  return { account: session.id, key, link: `${config.publicUrl || ''}/desk?k=${key}` };
}
/** Change a desk's label or extra page without changing its key. */
export async function updateDesk(account, { label, appName, appUrl } = {}) {
  const id = (await manager.resolve(account)).id;
  const items = await readDesks();
  const d = items.find((x) => x.account === id);
  if (!d) throw new Error('This number has no desk yet');
  if (appUrl !== undefined && appUrl && !/^https:\/\//.test(String(appUrl))) throw new Error('The extra page must be an https:// link');
  if (label !== undefined) d.label = String(label).slice(0, 40);
  if (appName !== undefined) d.appName = String(appName).slice(0, 30);
  if (appUrl !== undefined) d.appUrl = String(appUrl);
  await writeDesks(items);
  const { hash, ...rest } = d;
  return rest;
}
export async function revokeDesk(account) {
  const id = (await manager.resolve(account)).id;
  const items = await readDesks();
  await writeDesks(items.filter((d) => d.account !== id));
  return { revoked: items.some((d) => d.account === id) };
}
async function deskOf(key) {
  if (!key || String(key).length < 32) return null;
  const h = sha(key);
  return (await readDesks()).find((d) => crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))) || null;
}

/** The drafts of this desk's number, oldest first, each with the last messages of its chat. */
async function deskDrafts(account) {
  const rows = (await outbox.listOutbox({ account, status: 'draft', limit: 200 })).reverse();
  const out = [];
  for (const r of rows) {
    const tail = await query(
      `SELECT from_me, ts, type, left(COALESCE(body, '[' || type || ']'), 300) AS body FROM messages
       WHERE account_id = $1 AND chat_jid = $2 AND type <> 'secretEncrypted' ORDER BY ts DESC LIMIT 4`,
      [account, r.to_jid],
    );
    out.push({
      id: Number(r.id), phone: r.to_jid.split('@')[0], name: r.to_name || '', campaign: r.campaign || '', note: r.note || '',
      text: r.payload?.text || r.payload?.attachment?.caption || '', template: r.payload?.waTemplate?.name || '',
      attachment: r.payload?.attachment ? (r.payload.attachment.fileName || r.payload.attachment.as || 'file') : '',
      createdAt: r.created_at, sendBy: r.expires_at, held: r.error && /^Held:/.test(r.error) ? r.error : '',
      chat: tail.reverse().map((m) => ({ me: m.from_me, at: new Date(Number(m.ts) * 1000).toISOString(), text: m.body })),
    });
  }
  return out;
}

export function mountDesk(app) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 400).json({ error: err.message }));
  // the page itself is public (it holds nothing); everything it shows comes from the key-guarded API below
  app.get('/desk', (req, res) => res.sendFile(path.join(publicDir, 'desk.html')));
  // per-desk manifest, so "Add to Home screen" opens straight into this desk with the person's own title
  app.get('/desk/manifest.webmanifest', wrap(async (req, res) => {
    const d = await deskOf(req.query.k);
    const name = d ? d.label : 'Desk';
    res.type('application/manifest+json').json({
      name, short_name: name.slice(0, 12), start_url: d ? `/desk?k=${req.query.k}` : '/desk', scope: '/desk', display: 'standalone',
      background_color: '#f4f8f7', theme_color: '#0f766e',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
    });
  }));
  const guard = async (req, res, next) => {
    if (keyGuessBlocked(req.ip)) return res.status(429).set('Retry-After', '900').json({ error: 'Too many wrong keys — try again in 15 minutes' });
    const key = req.get('x-desk-key') || '';
    const d = await deskOf(key).catch(() => null);
    if (!d) {
      keyGuessBlocked(req.ip, Boolean(key));
      return res.status(401).json({ error: 'This link is no longer valid — ask for a new one' });
    }
    req.desk = d;
    next();
  };
  const mine = async (req, ids) => {
    const list = ids.map(Number).filter(Boolean);
    if (!list.length) throw new Error('Choose at least one draft');
    const rows = await query(`SELECT id FROM outbox WHERE id = ANY($1::bigint[]) AND account_id = $2 AND status = 'draft'`, [list, req.desk.account]);
    if (rows.length !== list.length) throw Object.assign(new Error('That draft is not waiting on this number any more — refresh the page'), { status: 409 });
    return list;
  };
  app.get('/desk/api/me', guard, wrap(async (req, res) => {
    const s = manager.sessions.get(req.desk.account);
    res.json({ label: req.desk.label, number: s?.account?.phone || '', connected: s?.status === 'open' || s?.status === 'elsewhere', appName: req.desk.appName, appUrl: req.desk.appUrl });
  }));
  // the person's profile picture, only for someone with a message on this desk's number (the desk key sees nothing else)
  app.get('/desk/api/avatar/:phone', guard, wrap(async (req, res) => {
    const jid = `${String(req.params.phone).replace(/\D/g, '')}@s.whatsapp.net`;
    const ok = await query(`SELECT 1 FROM outbox WHERE account_id = $1 AND to_jid = $2 LIMIT 1`, [req.desk.account, jid]);
    if (!ok.length) return res.status(404).json({ error: 'No message to this person on this desk' });
    const a = await getAvatar(req.desk.account, jid);
    if (!a) return res.status(204).end();
    res.set('Content-Type', a.mimetype).set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').send(a.buffer);
  }));
  app.get('/desk/api/drafts', guard, wrap(async (req, res) => {
    const q = await outbox.queueStatus(req.desk.account).catch(() => null);
    res.json({ drafts: await deskDrafts(req.desk.account), queue: q ? { queued: q.queued, state: q.state, reason: q.reason, until: q.until } : null });
  }));
  app.post('/desk/api/drafts/:id/approve', guard, wrap(async (req, res) => {
    const [id] = await mine(req, [req.params.id]);
    const row = await outbox.approve(id, { text: req.body?.text });
    await logEvent(req.desk.account, 'info', `${req.desk.label} approved #${id} to ${row.to_jid.split('@')[0]} from the desk`, 'you');
    res.json({ ok: true, id, status: row.status });
  }));
  app.post('/desk/api/drafts/approve', guard, wrap(async (req, res) => {
    // only the drafts named (the ones on the screen), never "all"
    const ids = await mine(req, Array.isArray(req.body?.ids) ? req.body.ids : []);
    const r = await outbox.approveAll({ ids, account: req.desk.account });
    await logEvent(req.desk.account, 'info', `${req.desk.label} approved ${ids.length} drafts from the desk`, 'you');
    res.json({ ok: true, approved: r.approved ?? ids.length });
  }));
  app.post('/desk/api/drafts/:id/reject', guard, wrap(async (req, res) => {
    const [id] = await mine(req, [req.params.id]);
    await outbox.reject(id, { reason: String(req.body?.reason || '').slice(0, 300), actor: 'you' });
    await logEvent(req.desk.account, 'info', `${req.desk.label} rejected #${id} from the desk${req.body?.reason ? `: ${String(req.body.reason).slice(0, 120)}` : ''}`, 'you');
    res.json({ ok: true, id });
  }));
}
