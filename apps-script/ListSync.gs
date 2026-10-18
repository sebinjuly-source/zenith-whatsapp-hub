/**
 * WhatsApp Hub ↔ Google Sheet sync (install once per sheet: Extensions → Apps Script → paste → Save → run setup()).
 *
 * The hub is the master record. This script:
 *   - pushes the sheet's rows (phone, name, personal message, any other columns) into a hub list
 *   - pulls each person's status back into extra columns: Hub status, Last sent, Last reply, Reply, Follow-ups, Outcome
 * After setup() it runs by itself every 15 minutes. The "WhatsApp Hub" menu does it on demand.
 */

// ---- Settings: adjust to the sheet ----
const HUB_URL = 'https://zenith-whatsapp-hub.onrender.com';
const API_KEY = 'PASTE_API_KEY_HERE';
const ACCOUNT = 'hiring';                 // hub number id
const LIST_NAME = '';                     // empty = use the spreadsheet's name
const SHEET_NAME = '';                    // empty = first sheet
const HEADER_ROW = 1;                     // row with the column titles
const PHONE_COLUMN = 'Phone Number';      // column titles in the header row
const NAME_COLUMN = 'Name';
const MESSAGE_COLUMN = 'WhatsApp Message (personalized)'; // optional; '' if none
// ----------------------------------------

const STATUS_COLUMNS = ['Hub status', 'Last sent', 'Last reply', 'Reply', 'Follow-ups', 'Outcome'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('WhatsApp Hub')
    .addItem('Sync now (push rows + pull status)', 'syncNow')
    .addItem('Message everyone not messaged yet', 'sendToNew')
    .addToUi();
}

function setup() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'syncNow').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(15).create();
  syncNow();
}

function syncNow() {
  pushRows_();
  pullStatus_();
}

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function listName_() {
  return LIST_NAME || SpreadsheetApp.getActive().getName();
}

function hub_(method, path, body) {
  const res = UrlFetchApp.fetch(HUB_URL + path, {
    method: method,
    contentType: 'application/json',
    headers: { 'x-api-key': API_KEY },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  if (res.getResponseCode() >= 300) throw new Error('Hub ' + res.getResponseCode() + ': ' + text);
  return JSON.parse(text);
}

function headers_(sh) {
  return sh.getRange(HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function pushRows_() {
  const sh = sheet_();
  const head = headers_(sh);
  const col = (t) => head.indexOf(t);
  const p = col(PHONE_COLUMN), n = col(NAME_COLUMN), m = MESSAGE_COLUMN ? col(MESSAGE_COLUMN) : -1;
  if (p < 0) throw new Error('No column "' + PHONE_COLUMN + '" in row ' + HEADER_ROW);
  const last = sh.getLastRow();
  if (last <= HEADER_ROW) return;
  const values = sh.getRange(HEADER_ROW + 1, 1, last - HEADER_ROW, head.length).getValues();
  const members = [];
  values.forEach((r, i) => {
    if (!String(r[p]).trim()) return;
    const extra = {};
    head.forEach((h, j) => {
      if (h && j !== p && j !== n && j !== m && STATUS_COLUMNS.indexOf(h) < 0 && r[j] !== '') extra[h] = String(r[j]);
    });
    members.push(Object.assign(extra, { phone: String(r[p]), name: n >= 0 ? String(r[n]) : undefined, message: m >= 0 ? String(r[m] || '') || undefined : undefined, row: HEADER_ROW + 1 + i }));
  });
  if (members.length) hub_('post', '/api/lists/import', { account: ACCOUNT, name: listName_(), source: 'google-sheet', members: members });
}

function pullStatus_() {
  const sh = sheet_();
  const lists = hub_('get', '/api/lists?account=' + encodeURIComponent(ACCOUNT));
  const list = lists.filter((l) => l.name.toLowerCase() === listName_().toLowerCase())[0];
  if (!list) return;
  const rows = hub_('get', '/api/lists/' + list.id + '/export');
  let head = headers_(sh);
  STATUS_COLUMNS.forEach((t) => {
    if (head.indexOf(t) < 0) {
      sh.getRange(HEADER_ROW, head.length + 1).setValue(t);
      head.push(t);
    }
  });
  const p = head.indexOf(PHONE_COLUMN);
  const last = sh.getLastRow();
  if (last <= HEADER_ROW) return;
  const phones = sh.getRange(HEADER_ROW + 1, p + 1, last - HEADER_ROW, 1).getValues().map((r) => String(r[0]).replace(/\D/g, '').slice(-10));
  const byPhone = {};
  rows.forEach((r) => (byPhone[String(r.phone).slice(-10)] = r));
  const first = head.indexOf(STATUS_COLUMNS[0]) + 1;
  const out = phones.map((ph) => {
    const r = byPhone[ph];
    return r ? [r.status, r.last_sent, r.last_reply, r.last_reply_text, r.followups, r.outcome] : ['', '', '', '', '', ''];
  });
  sh.getRange(HEADER_ROW + 1, first, out.length, STATUS_COLUMNS.length).setValues(out);
}

function sendToNew() {
  pushRows_();
  const list = hub_('get', '/api/lists?account=' + encodeURIComponent(ACCOUNT)).filter((l) => l.name.toLowerCase() === listName_().toLowerCase())[0];
  if (!list) throw new Error('List not found in the hub');
  const r = hub_('post', '/api/lists/' + list.id + '/send', { statuses: ['new', 'failed'] });
  SpreadsheetApp.getUi().alert(r.queued + ' messages ' + (r.mode === 'approve' ? 'saved for approval in the hub (Board → Waiting for approval).' : 'queued.'));
  pullStatus_();
}
