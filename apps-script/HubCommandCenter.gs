/**
 * WhatsApp Hub — Command Center for a Google Sheet (install: Extensions → Apps Script → paste → set HUB_URL and the
 * key in Project Settings → Script properties as HUB_KEY → Save → run setup() once and allow access).
 *
 * Four tabs, refreshed every 30 minutes and from the "WhatsApp Hub" menu:
 *   Leads  — every person on the lists of LEAD_CAMPAIGN (e.g. "Guest leads"): stage, source, value, outcome, won ₹,
 *            last reply. One row per person; the Ads routine / ROAS sheet reads amounts from here.
 *   Today  — the Board's cards due now (owner's and the AI's), most important first, plus how many drafts wait.
 *   Send   — type Phone | Message | Number (hub number id) rows, then menu → "Create drafts from Send": each row
 *            becomes a hub draft (the owner approves it in the dashboard or on the phone). Status is written back.
 *   Ask    — any AI tool by name with JSON arguments (B1 tool, B2 arguments) → menu → "Run the Ask tab": the answer
 *            lands in A4. E.g. person_context {"person":"9876543210"}, inbox_summary {"campaign":"all"}.
 * Everything goes through the hub's REST API (x-api-key). The key is never written in the sheet.
 */

const HUB_URL = 'https://zenith-whatsapp-hub.onrender.com';
const LEAD_CAMPAIGN = 'Guest leads';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('WhatsApp Hub')
    .addItem('Refresh Leads + Today', 'refreshAll')
    .addItem('Create drafts from Send', 'createDrafts')
    .addItem('Run the Ask tab', 'runAsk')
    .addToUi();
}

/** Run once: a 30-minute refresh and the four tabs. */
function setup() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'refreshAll').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshAll').timeBased().everyMinutes(30).create();
  tab_('Send', ['Phone', 'Message', 'Number', 'Status']);
  const ask = tab_('Ask', null);
  if (!ask.getRange('A1').getValue()) ask.getRange('A1:B2').setValues([['Tool', 'inbox_summary'], ['Arguments (JSON)', '{"campaign":"all"}']]);
  refreshAll();
}

function refreshAll() {
  refreshLeads();
  refreshToday();
}

// ---------------------------------------------------------------- Leads
function refreshLeads() {
  const lists = hub_('GET', '/api/lists?role=' + encodeURIComponent(LEAD_CAMPAIGN));
  const rows = [];
  lists.forEach((l) => {
    const stageLabel = {};
    (l.stages || []).forEach((s) => (stageLabel[s.key] = s.label));
    hub_('GET', '/api/lists/' + l.id + '/members').forEach((m) => rows.push(leadRow_(l, m, stageLabel)));
  });
  rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  write_('Leads', ['Added', 'Number', 'Phone', 'Name', 'Stage', 'Source', 'Won ₹', 'Value ₹', 'Outcome', 'Last reply', 'Their last message', 'Next follow-up', 'Notes'], rows);
}

/** One person → one row. Exported for the test twin. */
function leadRow_(list, m, stageLabel) {
  const notes = m.notes || '';
  const src = (m.fields && m.fields.source) || ((notes.match(/src:\s*([^|]+)/i) || [])[1] || '').trim();
  return [
    day_(m.added_at), list.account_label || list.account_id, m.phone, m.name || '',
    stageLabel[m.stage] || m.stage || '', src,
    /^won/i.test(m.outcome || '') ? money_(m.outcome) : '',
    money_((notes.match(/value\s*~?\s*₹?\s*([\d,.]+\s*(?:k|l|lakh)?)/i) || [])[1] || ''),
    m.outcome || '', day_(m.last_reply_at), m.last_reply_text || '', day_(m.followup_at), notes,
  ];
}

/** "₹1.5L", "50k", "₹50,000/month", "10,500" → 150000 / 50000 / 50000 / 10500 ('' when none). */
function money_(s) {
  const t = String(s || '').replace(/,/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(l|lakh|k)?\b/i);
  if (!m) return '';
  const n = parseFloat(m[1]) * ({ l: 100000, lakh: 100000, k: 1000 }[(m[2] || '').toLowerCase()] || 1);
  return Math.round(n);
}

// ---------------------------------------------------------------- Today
function refreshToday() {
  const due = hub_('GET', '/api/tasks?due_now=1');
  const rank = (t) => (t.owner_note_pending ? 0 : t.priority ? 1 : t.created_by === 'you' && t.kind === 'todo' ? 2 : 3);
  due.sort((a, b) => rank(a) - rank(b) || String(a.due_at || '').localeCompare(String(b.due_at || '')));
  const drafts = hub_('GET', '/api/outbox/count?status=draft').n;
  write_('Today', ['#', 'For', 'Priority', 'Card', 'Due', 'Number', 'Latest note'],
    due.map((t) => [t.id, t.assignee === 'ai' ? 'AI' : 'Owner', t.priority ? '⭐' : '', t.title, when_(t.due_at), t.account_id, t.last_note || '']),
    'Drafts waiting for approval: ' + drafts + ' · refreshed ' + when_(new Date().toISOString()));
}

// ---------------------------------------------------------------- Send
function createDrafts() {
  const sh = tab_('Send', ['Phone', 'Message', 'Number', 'Status']);
  const values = sh.getDataRange().getValues();
  let made = 0;
  for (let r = 1; r < values.length; r++) {
    const [phone, text, account, status] = values[r];
    if (!phone || !text || status) continue; // a row with a status was done before
    const res = hub_('POST', '/api/tools/send_message', {
      account: String(account || '').trim() || undefined, to: String(phone), text: String(text), campaign: 'all',
      note: 'From the Command Center sheet', idempotency_key: 'sheet-' + String(phone).replace(/\D/g, '') + '-' + Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(text)).slice(0, 4).join(''),
    }, true);
    sh.getRange(r + 1, 4).setValue((res.isError ? '⚠️ ' : '✅ ') + String(res.text || res.error || '').slice(0, 200));
    if (!res.isError) made++;
  }
  SpreadsheetApp.getActive().toast(made + ' draft(s) created — approve them in the hub', 'WhatsApp Hub');
}

// ---------------------------------------------------------------- Ask
function runAsk() {
  const sh = tab_('Ask', null);
  const tool = String(sh.getRange('B1').getValue()).trim();
  const args = String(sh.getRange('B2').getValue() || '{}');
  const res = hub_('POST', '/api/tools/' + encodeURIComponent(tool), JSON.parse(args), true);
  sh.getRange('A4').setValue(String(res.text || res.error || '')).setWrap(true);
}

// ---------------------------------------------------------------- helpers
function hub_(method, path, body, allowError) {
  const key = PropertiesService.getScriptProperties().getProperty('HUB_KEY');
  if (!key) throw new Error('Set the hub key: Project Settings → Script properties → HUB_KEY');
  const res = UrlFetchApp.fetch(HUB_URL + path, {
    method: method, contentType: 'application/json', headers: { 'x-api-key': key },
    payload: body ? JSON.stringify(body) : undefined, muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { error: text }; }
  if (code >= 300 && !allowError) throw new Error('Hub ' + code + ' on ' + path + ': ' + (data.error || text).slice(0, 300));
  return data;
}

function tab_(name, header) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (header && !sh.getRange(1, 1).getValue()) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  return sh;
}

/** Replace a tab's rows (header bold + frozen); an optional line under the table. */
function write_(name, header, rows, footer) {
  const sh = tab_(name, null);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  if (footer) sh.getRange(rows.length + 3, 1).setValue(footer);
}

function day_(iso) { return iso ? Utilities.formatDate(new Date(iso), 'Asia/Kolkata', 'yyyy-MM-dd') : ''; }
function when_(iso) { return iso ? Utilities.formatDate(new Date(iso), 'Asia/Kolkata', 'dd MMM HH:mm') : ''; }
