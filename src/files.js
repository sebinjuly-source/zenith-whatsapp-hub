/**
 * Files the AI or a script hands to the hub to send (a PDF, a poster, a voucher) — no Drive or public link needed.
 * Stored in the database; each gets an unguessable link /f/<token>/<name> that the send queue (and Meta, which
 * fetches media by URL) can use, so the same file can go to many people. Kept 90 days.
 */
import crypto from 'crypto';
import mime from 'mime-types';
import config from './config.js';
import { query } from './db.js';

export const MAX_FILE_MB = 25;
const safeName = (n) => String(n || 'file').replace(/[\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'file';

/** Save a file (base64 — a data: URL is fine — or a Buffer). Returns { token, name, mimetype, size, url }. */
export async function saveFile({ base64, buffer, fileName, mimetype, by = 'ai' }) {
  const data = buffer || Buffer.from(String(base64 || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, ''), 'base64');
  if (!data.length) throw new Error('The file is empty — give its content as base64');
  if (data.length > MAX_FILE_MB * 1024 * 1024) throw new Error(`The file is larger than ${MAX_FILE_MB} MB`);
  const name = safeName(fileName);
  const type = mimetype || mime.lookup(name) || 'application/octet-stream';
  const token = crypto.randomBytes(16).toString('hex');
  await query(`INSERT INTO hub_files (token, name, mimetype, data, size, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [token, name, type, data, data.length, by]);
  await query(`DELETE FROM hub_files WHERE created_at < now() - interval '90 days'`).catch(() => {});
  return { token, name, mimetype: type, size: data.length, url: `${config.publicUrl || ''}/f/${token}/${encodeURIComponent(name)}` };
}

/** A hub file link (/f/<token>/…) → its token, else null. */
export const tokenOf = (url) => String(url || '').match(/\/f\/([0-9a-f]{32})(?:\/|$)/)?.[1] || null;

export async function getFile(token) {
  const [f] = await query(`SELECT name, mimetype, data FROM hub_files WHERE token = $1`, [token]);
  return f ? { fileName: f.name, mimetype: f.mimetype, buffer: Buffer.from(f.data) } : null;
}
