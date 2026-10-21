/**
 * What a message costs on a Meta Cloud API number (linked phones are free). Meta charges per delivered template by
 * category; since 1 Oct 2026 utility templates are charged even inside the 24 h window, and normal (service)
 * replies are free for the first 1,000 per number per month. Rates are a hub setting the owner can correct from
 * Meta's rate card (https://business.whatsapp.com/products/platform-pricing#rates) — Meta's real charge also shows
 * per message in the status webhooks (pricing.category / billable), kept in meta_events.
 */
import { query } from './db.js';

export const DEFAULT_PRICING = {
  currency: 'INR',
  marketing: 0.8631,
  utility: 0.115,
  authentication: 0.115,
  service: 0,
  serviceFreePerMonth: 1000,
  source: 'Meta INR list rates as published Jan 2026 (marketing ₹0.8631); utility/authentication ₹0.115 — check Meta\'s rate card',
};

export async function getPricing() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'pricing'`);
  return { ...DEFAULT_PRICING, ...(r?.value || {}) };
}

export async function savePricing(p) {
  const cur = await getPricing();
  const next = { ...cur };
  for (const k of ['marketing', 'utility', 'authentication', 'service', 'serviceFreePerMonth']) {
    if (p[k] !== undefined && p[k] !== '') {
      const n = Number(p[k]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number ≥ 0`);
      next[k] = n;
    }
  }
  if (p.currency) next.currency = String(p.currency).toUpperCase().slice(0, 3);
  next.source = p.source || 'Set by the owner';
  next.updatedAt = new Date().toISOString();
  await query(`INSERT INTO config (key, value) VALUES ('pricing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
  return next;
}

export const money = (n, currency = 'INR') => `${currency === 'INR' ? '₹' : currency + ' '}${Number(n || 0).toFixed(2).replace(/\.00$/, '')}`;

/**
 * Price list for a set of outbox-like rows on any numbers: [{ account_id, payload }] → same order, each
 * { price, category, note }. Template category comes from the synced Meta templates.
 */
export async function priceRows(rows, manager) {
  const pricing = await getPricing();
  const cats = new Map((await query(`SELECT waba_id, name, language, category FROM wa_templates`)).map((t) => [`${t.waba_id}|${t.name}|${t.language}`, t.category]));
  const catByName = new Map((await query(`SELECT waba_id, name, category FROM wa_templates`)).map((t) => [`${t.waba_id}|${t.name}`, t.category]));
  const serviceUsed = new Map();
  const out = [];
  for (const r of rows) {
    const s = manager.sessions.get(r.account_id);
    if (!s?.isCloud) {
      out.push({ price: 0, category: 'free', note: 'Linked phone number — free' });
      continue;
    }
    const t = r.payload?.waTemplate;
    if (t?.name) {
      const cat = String(cats.get(`${s.wabaId}|${t.name}|${t.language}`) || catByName.get(`${s.wabaId}|${t.name}`) || 'MARKETING').toLowerCase();
      const price = pricing[cat] ?? pricing.marketing;
      out.push({ price, category: cat, note: `${cat[0].toUpperCase()}${cat.slice(1)} template — Meta charges every delivered one` });
      continue;
    }
    // Free text = service message (only allowed within 24 h of their last message): free up to the monthly allowance
    if (!serviceUsed.has(s.id)) {
      const [c] = await query(
        `SELECT count(*)::int n FROM outbox WHERE account_id = $1 AND status = 'sent' AND payload->'waTemplate' IS NULL
           AND sent_at >= date_trunc('month', now())`, [s.id]);
      serviceUsed.set(s.id, c.n);
    }
    const used = serviceUsed.get(s.id);
    serviceUsed.set(s.id, used + 1);
    const paid = used >= pricing.serviceFreePerMonth;
    out.push({ price: paid ? pricing.service : 0, category: 'service', note: paid ? `Reply beyond the ${pricing.serviceFreePerMonth} free this month` : `Reply within 24 h — free (${used}/${pricing.serviceFreePerMonth} free replies used this month)` });
  }
  return { items: out, total: out.reduce((a, b) => a + b.price, 0), currency: pricing.currency, pricing };
}
