/**
 * Seal small secrets (a connected business's Meta token, its two-step PIN) before they go into the database,
 * so a database export or a read-only SQL query never shows them in plain text.
 * AES-256-GCM; key = SHA-256 of SECRET_KEY (or API_KEY when SECRET_KEY is not set).
 * Changing that key makes stored secrets unreadable: the numbers then need connecting again.
 */
import crypto from 'crypto';

const key = () => crypto.createHash('sha256').update(String(process.env.SECRET_KEY || process.env.API_KEY || 'hub')).digest();

export function seal(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function unseal(value) {
  if (!value) return null;
  if (!String(value).startsWith('enc:')) return String(value);
  try {
    const raw = Buffer.from(String(value).slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
