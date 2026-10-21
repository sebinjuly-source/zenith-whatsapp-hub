/**
 * Meta-approved message templates — the only messages a Cloud API number may send to someone who hasn't written
 * in the last 24 hours (first contact, follow-ups). Synced from the WhatsApp Business account into wa_templates.
 *
 * Sending one: payload.waTemplate = { name, language?, params?: [...] | { name: value }, header?: text | { link, fileName } }.
 * params fill {{1}}, {{2}} … (or named {{guest_name}}) in the body, in order. Hub placeholders like {name} inside
 * params are filled per person before sending (bulk / lists).
 */
import { query } from '../db.js';
import { graph, graphBase, metaToken } from './graph.js';
import { loadOutgoing } from '../media.js';
import logger from '../logger.js';

const VAR = /\{\{\s*([\w.]+)\s*\}\}/g;

export async function syncTemplates(wabaId) {
  if (!wabaId) return [];
  const all = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const r = await graph(`${wabaId}/message_templates`, {
      params: { fields: 'id,name,language,status,category,components,parameter_format', limit: 100, after },
    });
    all.push(...(r.data || []));
    after = r.paging?.cursors?.after;
    if (!r.paging?.next || !after) break;
  }
  for (const t of all) {
    await query(
      `INSERT INTO wa_templates (waba_id, name, language, status, category, components, meta_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (waba_id, name, language) DO UPDATE SET status = EXCLUDED.status, category = EXCLUDED.category,
         components = EXCLUDED.components, meta_id = EXCLUDED.meta_id, updated_at = now()`,
      [wabaId, t.name, t.language, t.status, t.category, JSON.stringify(t.components || []), t.id],
    );
  }
  // Deleted in Meta → gone here too
  const keep = all.map((t) => `${t.name}|${t.language}`);
  await query(`DELETE FROM wa_templates WHERE waba_id = $1 AND NOT ((name || '|' || language) = ANY($2::text[]))`, [wabaId, keep]);
  logger.info({ wabaId, count: all.length }, 'Meta templates synced');
  return all;
}

/**
 * Submit a new template to Meta for review (usually minutes). body uses {{1}}, {{2}} …; examples = one sample value
 * per variable (Meta requires them). buttons: quick-reply texts (max 3). Returns Meta's { id, status, category }.
 */
/**
 * Meta's resumable upload: a file → "header handle" that a new template with an IMAGE/DOCUMENT header needs as its
 * example. (Sends later use a public link or media id instead.)
 */
async function headerHandle({ buffer, mimetype, fileName }) {
  const appId = process.env.META_APP_ID || (await graph('app', { params: { fields: 'id' } })).id;
  const s = await graph(`${appId}/uploads`, { method: 'POST', idempotent: true, params: { file_name: fileName || 'header.jpg', file_length: buffer.length, file_type: mimetype } });
  const res = await fetch(`${graphBase()}/${s.id}`, {
    method: 'POST', headers: { Authorization: `OAuth ${metaToken()}`, file_offset: '0', 'Content-Type': mimetype }, body: buffer, signal: AbortSignal.timeout(120000),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok || !r.h) throw new Error(`Meta didn't accept the header image: ${r.error?.message || res.status}`);
  return r.h;
}

export async function createTemplate(wabaId, { name, language = 'en', category = 'UTILITY', body, examples = [], header, headerImage, footer, buttons = [] }) {
  name = String(name || '').toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
  if (!name) throw new Error('Template name needed (lowercase letters, digits, _)');
  if (!body?.trim()) throw new Error('Template text needed');
  const vars = [...new Set([...body.matchAll(VAR)].map((m) => m[1]))];
  if (vars.some((v) => !/^\d+$/.test(v))) throw new Error('Use numbered fill-ins: {{1}}, {{2}} …');
  if (examples.length < vars.length) throw new Error(`Give an example value for each fill-in (${vars.map((v) => `{{${v}}}`).join(', ')})`);
  if (/^\s*\{\{|\}\}\s*[.!?]?\s*$/.test(body)) throw new Error('Meta rejects templates that start or end with a fill-in — add a word before/after it');
  const components = [];
  // headerImage: { url } (public link — also used for every send) or { base64, mimetype }
  let headerLink = null;
  if (headerImage) {
    const file = await loadOutgoing(headerImage);
    if (!/^image\/(jpe?g|png)$/.test(file.mimetype)) throw new Error('Header image must be JPEG or PNG');
    if (file.buffer.length > 5 * 1024 * 1024) throw new Error('Header image must be under 5 MB');
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [await headerHandle(file)] } });
    headerLink = headerImage.url || null;
  } else if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  components.push({ type: 'BODY', text: body, ...(vars.length ? { example: { body_text: [examples.slice(0, vars.length).map(String)] } } : {}) });
  if (footer) components.push({ type: 'FOOTER', text: footer });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.slice(0, 3).map((text) => ({ type: 'QUICK_REPLY', text: String(text).slice(0, 25) })) });
  const r = await graph(`${wabaId}/message_templates`, { method: 'POST', idempotent: true, json: { name, language, category: String(category).toUpperCase(), components } });
  await syncTemplates(wabaId).catch(() => {});
  if (headerLink) await query(`UPDATE wa_templates SET header_link = $4 WHERE waba_id = $1 AND name = $2 AND language = $3`, [wabaId, name, language, headerLink]);
  return { name, language, ...r };
}

export async function listWaTemplates(wabaId, { approvedOnly = false } = {}) {
  const rows = await query(
    `SELECT name, language, status, category, components, updated_at FROM wa_templates WHERE waba_id = $1
     ${approvedOnly ? `AND status = 'APPROVED'` : ''} ORDER BY name, language`,
    [wabaId],
  );
  return rows.map((t) => ({ ...t, ...describe(t) }));
}

/** Body text, header kind and the fill-ins a template needs. */
export function describe(t) {
  const comps = t.components || [];
  const body = comps.find((c) => c.type === 'BODY')?.text || '';
  const header = comps.find((c) => c.type === 'HEADER');
  const vars = [...new Set([...body.matchAll(VAR)].map((m) => m[1]))];
  return {
    body,
    headerFormat: header?.format || null, // TEXT | IMAGE | DOCUMENT | VIDEO | LOCATION
    headerText: header?.format === 'TEXT' ? header.text : null,
    vars, // ['1','2'] or ['guest_name', …]
    named: vars.some((v) => !/^\d+$/.test(v)),
    footer: comps.find((c) => c.type === 'FOOTER')?.text || null,
    buttons: comps.find((c) => c.type === 'BUTTONS')?.buttons || [],
  };
}

export async function findTemplate(wabaId, name, language) {
  const rows = await query(
    `SELECT * FROM wa_templates WHERE waba_id = $1 AND name = $2 ${language ? 'AND language = $3' : ''}
     ORDER BY (status = 'APPROVED') DESC, language LIMIT 1`,
    language ? [wabaId, name, language] : [wabaId, name],
  );
  return rows[0] || null;
}

/** Values for the template's fill-ins, in its order, from an array or a { name: value } object. */
function valuesFor(d, params) {
  if (Array.isArray(params)) return d.vars.map((v, i) => params[/^\d+$/.test(v) ? Number(v) - 1 : i]);
  return d.vars.map((v) => params?.[v]);
}

/**
 * Build the Graph API "template" object and the text the person will see (stored in the chat).
 * Throws a clear error when the template is unknown, not approved, or a fill-in is missing.
 */
export async function buildTemplateMessage(wabaId, waTemplate, { allowPending = false } = {}) {
  const t = await findTemplate(wabaId, waTemplate.name, waTemplate.language);
  if (!t) throw new Error(`No Meta template called "${waTemplate.name}"${waTemplate.language ? ` (${waTemplate.language})` : ''} — create it in WhatsApp Manager, or press "Sync templates"`);
  if (t.status !== 'APPROVED' && !(allowPending && t.status === 'PENDING')) {
    const e = new Error(`Meta template "${t.name}" is ${t.status.toLowerCase()}, not approved yet`);
    if (t.status === 'PENDING') e.code = 'TEMPLATE_PENDING';
    throw e;
  }
  const d = describe(t);
  const values = valuesFor(d, waTemplate.params || []);
  const missing = d.vars.filter((v, i) => values[i] == null || String(values[i]).trim() === '');
  if (missing.length) throw new Error(`Template "${t.name}" needs a value for ${missing.map((m) => `{{${m}}}`).join(', ')}`);
  const components = [];
  if (d.headerFormat === 'TEXT' && /\{\{/.test(d.headerText || '')) {
    if (!waTemplate.header) throw new Error(`Template "${t.name}" needs the header text`);
    components.push({ type: 'header', parameters: [{ type: 'text', text: String(waTemplate.header) }] });
  } else if (['IMAGE', 'DOCUMENT', 'VIDEO'].includes(d.headerFormat)) {
    const h = waTemplate.header || (t.header_link ? { link: t.header_link } : null); // default: the image it was created with
    const link = typeof h === 'string' ? h : h?.link || h?.url;
    const id = h?.id;
    if (!link && !id) throw new Error(`Template "${t.name}" needs a ${d.headerFormat.toLowerCase()} for its header`);
    const kind = d.headerFormat.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: { ...(id ? { id } : { link }), ...(kind === 'document' && h?.fileName ? { filename: h.fileName } : {}) } }] });
  }
  if (d.vars.length) {
    components.push({
      type: 'body',
      parameters: d.vars.map((v, i) => ({ type: 'text', text: String(values[i]).replace(/\s*\n\s*/g, ' ').slice(0, 1024), ...(d.named ? { parameter_name: v } : {}) })),
    });
  }
  d.buttons.forEach((b, i) => {
    if (b.type === 'URL' && /\{\{/.test(b.url || '')) {
      const v = waTemplate.buttons?.[i];
      if (!v) throw new Error(`Template "${t.name}" needs the link ending for button "${b.text}"`);
      components.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: String(v) }] });
    }
  });
  const fill = (s) => s.replace(VAR, (m, k) => {
    const i = d.vars.indexOf(k);
    return i >= 0 ? String(values[i]) : m;
  });
  const preview = [d.headerText ? fill(d.headerText).replace(VAR, () => String(waTemplate.header || '')) : null, fill(d.body), d.footer]
    .filter(Boolean).join('\n\n');
  return { template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) }, preview, row: t };
}
