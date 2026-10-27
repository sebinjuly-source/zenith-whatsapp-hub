/**
 * Saved media (PDFs, images, resumes…). Stored in Supabase Storage when configured,
 * otherwise in the media_files table. Nothing is saved unless a setting or a request asks for it.
 */
import mime from 'mime-types';
import config from './config.js';
import { query } from './db.js';

const useSupabase = () => !!(config.supabase.url && config.supabase.serviceKey);
// New-style keys (sb_secret_…) go in the apikey header only; legacy JWT keys also as a Bearer token.
const sbHeaders = (extra = {}) => {
  const k = config.supabase.serviceKey;
  return { apikey: k, ...(k.startsWith('eyJ') ? { Authorization: `Bearer ${k}` } : {}), ...extra };
};
let bucketReady = null;
/** Create the private media bucket on first use if it doesn't exist yet. */
function ensureBucket() {
  bucketReady ||= fetch(`${config.supabase.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: config.supabase.bucket, name: config.supabase.bucket, public: false }),
    signal: AbortSignal.timeout(20000),
  }).then(async (res) => {
    const body = await res.text();
    if (!res.ok && !/already exists|Duplicate/i.test(body)) {
      bucketReady = null;
      throw new Error(`Could not create storage bucket: ${res.status} ${body}`);
    }
  });
  return bucketReady;
}

export async function putMedia(path, buffer, mimetype) {
  if (useSupabase()) {
    await ensureBucket();
    const res = await fetch(`${config.supabase.url}/storage/v1/object/${config.supabase.bucket}/${encodeURI(path)}`, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'true' }),
      body: buffer,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Supabase storage upload failed: ${res.status} ${await res.text()}`);
    return `sb:${path}`;
  }
  await query(
    `INSERT INTO media_files (path, mimetype, data) VALUES ($1,$2,$3)
     ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, mimetype = EXCLUDED.mimetype`,
    [path, mimetype, buffer],
  );
  return `db:${path}`;
}

export async function getMedia(ref) {
  if (ref.startsWith('sb:')) {
    const path = ref.slice(3);
    const res = await fetch(`${config.supabase.url}/storage/v1/object/${config.supabase.bucket}/${encodeURI(path)}`, {
      headers: sbHeaders(),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Supabase storage download failed: ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimetype: res.headers.get('content-type') };
  }
  const rows = await query('SELECT mimetype, data FROM media_files WHERE path = $1', [ref.replace(/^db:/, '')]);
  if (!rows[0]) throw new Error('Saved media not found');
  return { buffer: Buffer.from(rows[0].data), mimetype: rows[0].mimetype };
}

export function mediaPath(accountId, chatJid, msgId, mimetype, fileName) {
  const ext = (fileName && fileName.includes('.') ? fileName.split('.').pop() : mime.extension(mimetype || '')) || 'bin';
  return `${accountId}/${chatJid.split('@')[0]}/${msgId}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
}

/**
 * Load an outgoing attachment given as { url } (http/https, incl. Google Drive share links) or { base64 }.
 * Returns { buffer, mimetype, fileName }.
 */
export async function loadOutgoing({ url, base64, mimetype, fileName }) {
  if (base64) {
    const buffer = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64');
    return { buffer, mimetype: mimetype || mime.lookup(fileName || '') || 'application/octet-stream', fileName };
  }
  if (!url) throw new Error('Attachment needs a url or base64');
  // a file handed to the hub (upload_file / POST /api/files): read it straight from the database
  const { tokenOf, getFile } = await import('./files.js');
  const tok = tokenOf(url);
  if (tok) {
    const f = await getFile(tok);
    if (!f) throw new Error('That hub file link has expired or does not exist — upload the file again');
    return { buffer: f.buffer, mimetype: mimetype || f.mimetype, fileName: fileName || f.fileName };
  }
  // Google Drive share links (…/file/d/ID/view, open?id=ID) → the direct file. Use export=view:
  // export=download sometimes stalls for a minute before redirecting.
  const drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
  const fetchUrl = drive ? `https://drive.google.com/uc?export=view&id=${drive[1]}` : url;
  const res = await fetch(fetchUrl, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Could not download attachment (${res.status})`);
  const ctype = (res.headers.get('content-type') || '').split(';')[0];
  // A Drive file that isn't shared "Anyone with the link" answers with Google's sign-in/preview page (HTML):
  // never send that page to someone as the "file".
  if (drive && ctype === 'text/html') throw new Error('The Google Drive file is not shared publicly — set sharing to "Anyone with the link" and try again');
  if (Number(res.headers.get('content-length')) > 100 * 1024 * 1024) throw new Error('The file is larger than 100 MB — WhatsApp won\'t accept it');
  const buffer = Buffer.from(await res.arrayBuffer());
  const disp = res.headers.get('content-disposition') || '';
  const dispName = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } }; // "100%.pdf" is not valid %-encoding
  let name = fileName || (dispName && decode(dispName)) || decode(new URL(url).pathname.split('/').pop() || '') || 'file';
  const type = mimetype || (ctype && ctype !== 'application/octet-stream' ? ctype : mime.lookup(name) || 'application/octet-stream');
  // Links like Drive's ".../uc" carry no extension — add one so the file opens on the phone.
  if (!/\.[a-z0-9]{2,5}$/i.test(name) && mime.extension(type)) name = `${name === 'uc' || name === 'view' ? 'file' : name}.${mime.extension(type)}`;
  return { buffer, mimetype: type, fileName: name };
}
