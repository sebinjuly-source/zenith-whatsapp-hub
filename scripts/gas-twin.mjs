// Run an Apps Script (.gs) from apps-script/ in Node against a real hub, with an in-memory spreadsheet — to test the
// script itself before pasting it into a Sheet. Usage:
//   node scripts/gas-twin.mjs apps-script/HubCommandCenter.gs refreshAll [runAsk|createDrafts ...] [--send "phone|text|account"]
// The key comes from .env (API_KEY); HUB_URL in the script is used as is.
import 'dotenv/config';
import fs from 'fs';
import vm from 'vm';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const [file, ...rest] = process.argv.slice(2);
const sends = [];
const fns = [];
for (let i = 0; i < rest.length; i++) (rest[i] === '--send' ? sends.push(rest[++i]) : fns.push(rest[i]));

// ---- a tiny spreadsheet
const sheets = new Map();
const grid = (name) => (sheets.get(name) || sheets.set(name, []).get(name));
function sheetObj(name) {
  const g = grid(name);
  const cell = (r, c) => ((g[r - 1] ||= [])[c - 1] ?? '');
  const range = (r, c, nr = 1, nc = 1) => ({
    getValue: () => cell(r, c),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValue(v) { (g[r - 1] ||= [])[c - 1] = v; return this; },
    setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => ((g[r - 1 + i] ||= [])[c - 1 + j] = v))); return this; },
    setFontWeight() { return this; }, setWrap() { return this; },
    clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (g[r - 1 + i]) g[r - 1 + i][c - 1 + j] = ''; return this; },
  });
  const a1 = (s) => {
    const [a, b] = s.split(':');
    const p = (x) => [parseInt(x.slice(1), 10), x.charCodeAt(0) - 64];
    const [r1, c1] = p(a);
    const [r2, c2] = b ? p(b) : [r1, c1];
    return range(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
  };
  return {
    getRange: (r, c, nr, nc) => (typeof r === 'string' ? a1(r) : range(r, c, nr, nc)),
    getDataRange: () => range(1, 1, g.length || 1, Math.max(1, ...g.map((x) => x?.length || 0))),
    clearContents() { g.length = 0; }, setFrozenRows() {}, setRowHeights() {},
    getLastRow: () => g.length, getMaxRows: () => Math.max(1000, g.length), insertRowsAfter() {},
  };
}
const ctx = {
  console,
  SpreadsheetApp: {
    getActive: () => ({ getSheetByName: (n) => (sheets.has(n) ? sheetObj(n) : null), insertSheet: (n) => (grid(n), sheetObj(n)), toast: (m) => console.log('[toast]', m) }),
    getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }),
  },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'HUB_KEY' ? process.env.API_KEY : null) }) },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
      const mm = String(new Date(d.toLocaleString('en-US', { timeZone: tz })).getMonth() + 1).padStart(2, '0');
      return fmt.replace('yyyy', p.year).replace('MMM', p.month).replace('MM', mm).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
    },
    computeDigest: (_a, s) => [...crypto.createHash('md5').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { MD5: 'MD5' },
  },
  // Apps Script's fetch is synchronous: curl does the same here
  UrlFetchApp: {
    fetch(url, o = {}) {
      const args = ['-s', '-m', '60', '-o', '-', '-w', '\n%{http_code}', '-X', (o.method || 'get').toUpperCase(), '-H', `content-type: ${o.contentType || 'application/json'}`];
      for (const [k, v] of Object.entries(o.headers || {})) args.push('-H', `${k}: ${v}`);
      if (o.payload) args.push('--data-binary', o.payload);
      const out = execFileSync('curl', [...args, url], { encoding: 'utf8', maxBuffer: 50e6 });
      const i = out.lastIndexOf('\n');
      return { getResponseCode: () => parseInt(out.slice(i + 1), 10), getContentText: () => out.slice(0, i) };
    },
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
if (sends.length) {
  const s = sheetObj('Send');
  s.getRange(1, 1, 1, 4).setValues([['Phone', 'Message', 'Number', 'Status']]);
  sends.forEach((x, i) => s.getRange(i + 2, 1, 1, 3).setValues([x.split('|')]));
}
for (const f of fns) {
  const t = Date.now();
  ctx[f]();
  console.log(`== ${f} (${Date.now() - t} ms)`);
}
for (const [name, g] of sheets) {
  console.log(`\n### ${name} (${Math.max(0, g.length - 1)} rows)`);
  for (const row of g.slice(0, 14)) if (row) console.log(row.map((v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 38)).join(' | '));
}
