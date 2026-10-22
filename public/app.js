/* WhatsApp Hub dashboard — plain JS, no build step. All user/message text is inserted as text, never HTML. */
(() => {
  const root = document.getElementById('root');
  const state = { accounts: [], route: 'accounts', inbox: { account: null, chat: null, kind: 'all', q: '', waiting: false }, draftsCount: 0 };
  // Choices that survive a refresh on this device (number picked in the inbox, board filters, tabs).
  const SAVE_KEY = 'hub-ui-v1';
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    Object.assign(state.inbox, saved.inbox || {});
    for (const k of ['board', 'outboxTab', 'outboxAccount', 'listId', 'listRole', 'settingsFor']) if (saved[k] !== undefined) state[k] = saved[k];
  } catch {}
  function persist() {
    try {
      const ib = state.inbox;
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        inbox: { account: ib.account, kind: ib.kind, state: ib.state, waiting: ib.waiting },
        board: state.board, outboxTab: state.outboxTab, outboxAccount: state.outboxAccount, listId: state.listId, listRole: state.listRole, settingsFor: state.settingsFor,
      }));
    } catch {}
  }
  let linkModal = null; // { id, el } while the QR / pairing dialog is open

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only used with static strings
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  async function api(path, opts = {}) {
    if (opts.body || (opts.method && opts.method !== 'GET')) state.accountsAt = 0; // a change → next page reloads the numbers
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      renderLogin();
      throw new Error('Please log in');
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || data || res.statusText);
    return data;
  }
  function toast(msg) {
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }
  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString([], { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const fmtShort = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : '2-digit' });
  };
  const statusText = { open: 'Connected', qr: 'Waiting for scan', connecting: 'Connecting…', stopped: 'Not linked', logged_out: 'Logged out', replaced: 'Running elsewhere', elsewhere: 'Running on another server', not_configured: 'Not set up', error: 'Meta problem' };
  const isCloud = (id) => state.accounts.find((a) => a.id === id)?.provider === 'cloud';
  const money = (n, cur = 'INR') => `${cur === 'INR' ? '₹' : cur + ' '}${Number(n || 0).toFixed(2).replace(/\.00$/, '')}`;
  /** "Estimated Meta cost: 100 × ₹0.86 = ₹86.31" for count messages of this template (empty for free sends). */
  async function costLine(accountId, count, waTemplate) {
    if (!isCloud(accountId) || !count) return '';
    const e = await api('/api/outbox/estimate', { body: { account: accountId, count, waTemplate } }).catch(() => null);
    if (!e) return '';
    return e.total > 0 ? `Estimated Meta cost: ${count} × ${money(e.perMessage, e.currency)} = ${money(e.total, e.currency)} (${e.category})` : `Cost: free (${e.note})`;
  }

  /**
   * Picker for a Meta-approved template (Meta Cloud API numbers): template + one box per {{1}}, {{2}} …
   * Boxes may use {first_name}, {name} or list columns — filled per person. el.value() → { name, language, params, header } | null.
   */
  function waTemplateField(accountId, current, { label = 'Meta template', hint, onChange } = {}) {
    const sel = h('select', { 'aria-label': label }, h('option', { value: '' }, 'Loading Meta templates…'));
    const boxes = h('div', {});
    let list = [];
    const draw = () => {
      const t = list.find((x) => `${x.name}|${x.language}` === sel.value);
      fill(boxes, !t ? null : [
        h('div', { class: 'muted', style: 'white-space:pre-wrap;font-size:13px;margin:6px 0;padding:8px;background:var(--soft, #f5f5f5);border-radius:8px' }, t.body),
        ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(t.headerFormat) || /\{\{/.test(t.headerText || '')
          ? h('label', { class: 'field' }, h('span', {}, t.headerFormat === 'TEXT' ? 'Header text' : `Header ${t.headerFormat.toLowerCase()} (public link)`), h('input', { type: 'text', 'data-header': '1', value: current?.header || '' })) : null,
        t.vars.map((v, i) => h('label', { class: 'field' }, h('span', {}, `{{${v}}}`),
          h('input', { type: 'text', 'data-var': v, required: true, value: (Array.isArray(current?.params) ? current.params[i] : current?.params?.[v]) || (i === 0 ? '{first_name}' : '') }))),
      ]);
    };
    sel.onchange = () => { draw(); onChange?.(); };
    api(`/api/accounts/${encodeURIComponent(accountId)}/wa-templates?approved=1`).then((rows) => {
      list = rows;
      fill(sel, h('option', { value: '' }, rows.length ? '— choose an approved template —' : 'No approved templates yet (WhatsApp Manager → Message templates)'),
        rows.map((t) => h('option', { value: `${t.name}|${t.language}`, selected: current?.name === t.name }, `${t.name} (${t.language}, ${t.category.toLowerCase()})`)));
      draw();
    }).catch((e) => fill(sel, h('option', { value: '' }, e.message)));
    const el = h('div', { class: 'field' }, h('span', {}, label), sel, hint ? h('em', {}, hint) : null, boxes);
    el.value = () => {
      if (!sel.value) return null;
      const [name, language] = sel.value.split('|');
      const t = list.find((x) => x.name === name && x.language === language);
      const vals = [...boxes.querySelectorAll('input[data-var]')].map((i) => [i.dataset.var, i.value.trim()]);
      const header = boxes.querySelector('input[data-header]')?.value.trim() || undefined;
      return { name, language, params: t?.named ? Object.fromEntries(vals) : vals.map(([, v]) => v), ...(header ? { header } : {}) };
    };
    return el;
  }

  /** Dialog: choose a Meta template and its fill-ins. Resolves to the waTemplate, or null if cancelled. */
  function askTemplate(accountId, title, hint, count = 0) {
    return new Promise((resolve) => {
      const costEl = h('p', { style: 'font-weight:600;margin:8px 0 0' });
      const field = waTemplateField(accountId, null, { hint, onChange: async () => {
        const v = field.value();
        costEl.textContent = v && count ? await costLine(accountId, count, v) : '';
      } });
      const done = (v) => { back.remove(); resolve(v); };
      const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && done(null) },
        h('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onsubmit: (e) => {
          e.preventDefault();
          const v = field.value();
          if (!v) return toast('Choose a template');
          done(v);
        } },
          h('h2', {}, title), field, costEl,
          h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' },
            h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
            h('button', { class: 'btn primary', type: 'submit' }, 'Continue'))));
      document.body.append(back);
    });
  }
  const nice = (n) => (n == null ? '–' : Number(n).toLocaleString());
  const guard = (fn) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      toast(e.message);
    }
  };

  // ---------- shell ----------
  // Top bar: ☰ (opens the side pane with every page), the name, and the three pages used all day.
  const MENU = [
    ['board', '🗂️', 'Board'],
    ['inbox', '💬', 'Inbox'],
    ['outbox', '✉️', 'Drafts'],
    null,
    ['lists', '📋', 'Lists'],
    ['accounts', '📱', 'Numbers'],
    ['templates', '📝', 'Templates'],
    ['rules', '⚡', 'Rules'],
    null,
    ['settings', '⚙️', 'Settings'],
    ['connect', '🔌', 'Connect AI & apps'],
    ['activity', '🕘', 'Activity'],
  ];
  function shell(content, { flush = false } = {}) {
    persist();
    const tab = (r, ico, label, extra) =>
      h('a', { href: '#' + r, class: 'tab' + (state.route === r ? ' active' : ''), title: label }, h('span', { class: 'ico' }, ico), h('span', { class: 'tab-label' }, label), extra || '');
    const close = () => { app.classList.remove('drawer-open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.firstChild.textContent = '☰'; };
    const open = () => { app.classList.add('drawer-open'); menuBtn.setAttribute('aria-expanded', 'true'); menuBtn.firstChild.textContent = '✕'; drawer.querySelector('a.active, a')?.focus(); };
    const menuBtn = h('button', { class: 'menu-btn', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'drawer', 'aria-expanded': 'false', title: 'Menu',
      onclick: () => (app.classList.contains('drawer-open') ? close() : open()) }, h('span', {}, '☰'));
    const drawer = h('aside', { class: 'drawer', id: 'drawer', 'aria-label': 'Menu' },
      h('nav', { class: 'drawer-nav' },
        MENU.map((m) => (m
          ? h('a', { href: '#' + m[0], class: state.route === m[0] ? 'active' : '', onclick: close },
              h('span', { class: 'ico' }, m[1]), h('span', { class: 'grow' }, m[2]),
              m[0] === 'outbox' && state.draftsCount ? h('span', { class: 'badge' }, state.draftsCount) : null)
          : h('hr')))),
      h('div', { class: 'drawer-foot' },
        h('a', { href: '#', onclick: guard(async (e) => { e.preventDefault(); close(); await api('/logout', { method: 'POST' }); renderLogin(); }) }, h('span', { class: 'ico' }, '↩️'), 'Log out'),
        h('div', { class: 'muted', style: 'font-size:12px;padding:6px 12px' }, 'Zenith WhatsApp Hub')));
    const scrim = h('div', { class: 'scrim', onclick: close, 'aria-hidden': 'true' });
    const app = h('div', { class: 'app' },
      h('header', { class: 'topbar' },
        menuBtn,
        h('div', { class: 'brand', title: 'Zenith WhatsApp Hub' }, 'WhatsApp Hub'),
        h('nav', { class: 'tabs', 'aria-label': 'Main' },
          tab('board', '🗂️', 'Board'),
          tab('inbox', '💬', 'Inbox'),
          tab('outbox', '✉️', 'Drafts', state.draftsCount ? h('span', { class: 'badge' }, state.draftsCount) : null))),
      h('main', { class: flush ? 'flush' : '' }, content),
      scrim, drawer);
    document.onkeydown = (e) => { if (e.key === 'Escape' && app.classList.contains('drawer-open')) { close(); menuBtn.focus(); } };
    root.replaceChildren(app);
  }

  function renderLogin() {
    root.replaceChildren(
      h('div', { class: 'login' },
        h('form', { class: 'card', onsubmit: guard(async (e) => {
          e.preventDefault();
          await api('/login', { body: { key: e.target.key.value } });
          boot();
        }) },
          h('h1', {}, 'WhatsApp Hub'),
          h('p', { class: 'sub' }, 'Enter your API key to open the dashboard on this device.'),
          h('label', { class: 'field' }, h('span', {}, 'API key'), h('input', { type: 'password', name: 'key', autocomplete: 'current-password', required: true })),
          h('button', { class: 'btn primary', type: 'submit' }, 'Open dashboard'),
        ),
      ),
    );
  }

  // ---------- accounts ----------
  // Every page needs the numbers; reuse them for 15 s between page switches (live updates keep statuses fresh).
  async function loadAccounts(force = false) {
    if (!force && state.accounts.length && Date.now() - (state.accountsAt || 0) < 15000) return;
    const [accounts, drafts] = await Promise.all([api('/api/accounts'), api('/api/outbox/count?status=draft').catch(() => ({ n: 0 }))]);
    state.accounts = accounts;
    state.draftsCount = drafts.n;
    state.accountsAt = Date.now();
  }

  const MODE_LABEL = { full: 'Full history', recent: 'Recent history', none: 'New messages only' };
  function syncView(a) {
    const s = a.sync || {};
    const mode = a.settings?.historyMode || 'full';
    const chosen = h('div', { class: 'muted', style: 'font-size:12px' }, `Chosen when linking: ${MODE_LABEL[mode]}`);
    if (mode === 'none') return chosen;
    if (!s.chunks) return h('div', {}, h('span', { class: 'muted' }, a.status === 'open' ? 'Waiting for history from the phone…' : 'Starts when linked'), chosen);
    const last = mode === 'full' ? 'FULL' : 'RECENT';
    const done = s.state === 'done' || s.phases?.[last] === 'complete';
    const pct = done ? 100 : Math.max(3, Math.min(99, s.progress || 0));
    return h('div', {},
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' },
        `${done ? `${MODE_LABEL[mode]} imported` : `Importing (${s.lastType || '…'})`} · ${nice(s.messages)} messages · ${nice(s.chats)} chats${s.backfilled ? ` · +${nice(s.backfilled)} older (deep history)` : ''}`),
      chosen,
    );
  }

  const QUALITY = { GREEN: '🟢 High', YELLOW: '🟡 Medium', RED: '🔴 Low — sends may be limited', UNKNOWN: 'Not rated yet' };
  const TIER = { TIER_250: '250 new people / 24 h', TIER_1K: '1,000 / 24 h', TIER_2K: '2,000 / 24 h', TIER_10K: '10,000 / 24 h', TIER_100K: '100,000 / 24 h', TIER_UNLIMITED: 'Unlimited' };
  function cloudCard(a) {
    const st = a.stats || {};
    const c = a.cloud || {};
    return h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', {}, a.label, h('span', { class: 'tag', style: 'margin-left:6px' }, 'Meta API'), a.isDefault ? h('span', { class: 'tag', style: 'margin-left:6px' }, 'default') : null),
          h('div', { class: 'meta' }, a.purpose || 'No purpose set')),
        h('span', { class: `pill ${a.status}` }, statusText[a.status] || a.status),
      ),
      a.error && a.status !== 'open' ? h('p', { style: 'color:var(--bad);margin:6px 0' }, a.error) : null,
      c.canSend && c.canSend !== 'AVAILABLE' ? h('p', { style: `color:${c.canSend === 'BLOCKED' ? 'var(--bad)' : 'var(--ink)'};background:var(--warn-soft, #fff4d6);padding:6px 8px;border-radius:8px;margin:6px 0` },
        h('b', {}, `Meta: ${c.canSend === 'BLOCKED' ? 'sending blocked' : 'sending limited'}. `), (c.issues || []).join(' · ')) : null,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Number'), h('dd', {}, a.phone ? '+' + a.phone : c.displayPhone || '–'),
        h('dt', {}, 'Name customers see'), h('dd', {}, c.verifiedName || '–', c.nameStatus && c.nameStatus !== 'APPROVED' ? h('span', { class: 'muted' }, ` (${String(c.nameStatus).toLowerCase().replace(/_/g, ' ')})`) : ''),
        h('dt', {}, 'Quality (Meta)'), h('dd', { style: c.quality === 'RED' ? 'color:var(--bad);font-weight:600' : '' }, QUALITY[c.quality] || c.quality || '–'),
        h('dt', {}, 'Meta limit'), h('dd', {}, TIER[c.tier] || c.tier || '–'),
        h('dt', {}, 'Account id'), h('dd', { class: 'mono' }, a.id),
        h('dt', {}, 'Stored'), h('dd', {}, `${nice(st.chats)} chats · ${nice(st.contacts)} contacts · ${nice(st.messages)} messages`),
        h('dt', {}, 'AI sending'), h('dd', {}, a.settings.aiMode === 'auto' ? 'Automatic' : 'Drafts for approval'),
        a.newChats ? h('dt', {}, 'New numbers (24 h)') : null,
        a.newChats ? h('dd', {}, `${a.newChats.count} of ${a.newChats.limit} (hub limit)`) : null,
        h('dt', {}, 'Rule'), h('dd', { class: 'muted' }, 'Free messages only within 24 h of the person\'s last message; first messages and follow-ups use Meta-approved templates.'),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { state.inbox.account = a.id; location.hash = 'inbox'; } }, 'Open inbox'),
        h('button', { class: 'btn small', onclick: () => { location.hash = 'templates'; } }, 'Meta templates'),
        h('button', { class: 'btn small primary', title: 'Every check at once: access, can-send status, webhook, templates, failures, billable messages', onclick: guard(async (e) => {
          e.target.disabled = true;
          try {
            const r = await api(`/api/accounts/${a.id}/meta-health`);
            const icon = { ok: '✅', warn: '⚠️', bad: '❌' };
            const back = h('div', { class: 'modal-back', onclick: (ev) => ev.target === back && back.remove() },
              h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Meta health check' },
                h('h2', {}, `Health check: ${r.status}`),
                h('div', {}, r.checks.map((x) => h('div', { style: 'padding:6px 0;border-top:1px solid var(--line)' }, `${icon[x.level]} `, h('b', {}, x.name), h('div', { class: 'muted', style: 'font-size:13px;margin-left:24px' }, x.detail)))),
                h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { class: 'btn', onclick: () => back.remove() }, 'Close'))));
            document.body.append(back);
          } finally {
            e.target.disabled = false;
          }
        }) }, 'Health check'),
        h('button', { class: 'btn small', title: 'Check the number with Meta again (registration, webhook, quality)', onclick: guard(async () => { await api(`/api/accounts/${a.id}/link`, { body: {} }); toast('Checked with Meta'); route(); }) }, 'Re-check with Meta'),
        h('button', { class: 'btn small', onclick: () => { state.settingsFor = a.id; location.hash = 'settings'; } }, 'Settings'),
        !a.isDefault ? h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }); route(); }) }, 'Make default') : null,
      ),
    );
  }

  function accountCard(a) {
    if (a.provider === 'cloud') return cloudCard(a);
    const st = a.stats || {};
    return h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', {}, a.label, a.isDefault ? h('span', { class: 'tag', style: 'margin-left:6px' }, 'default') : null),
          h('div', { class: 'meta' }, a.purpose || 'No purpose set')),
        h('span', { class: `pill ${a.status}` }, statusText[a.status] || a.status),
      ),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Number'), h('dd', {}, a.phone ? '+' + a.phone : '–'),
        h('dt', {}, 'Account id'), h('dd', { class: 'mono' }, a.id),
        h('dt', {}, 'Stored'), h('dd', {}, `${nice(st.chats)} chats (${nice(st.groups)} groups) · ${nice(st.contacts)} contacts · ${nice(st.messages)} messages`),
        h('dt', {}, 'Oldest message'), h('dd', {}, st.oldest_ts ? fmt(st.oldest_ts) : '–'),
        h('dt', {}, 'AI sending'), h('dd', {}, a.settings.aiMode === 'auto' ? 'Automatic' : 'Drafts for approval'),
        a.newChats ? h('dt', {}, 'New numbers (24 h)') : null,
        a.newChats ? h('dd', { style: a.newChats.count >= a.newChats.limit ? 'color:var(--bad);font-weight:600' : '' },
          `${a.newChats.count} of ${a.newChats.limit}`, a.newChats.nextFreeAt ? ` — limit reached, next slot ${new Date(a.newChats.nextFreeAt).toLocaleString()}` : '') : null,
        a.reachout?.isActive ? h('dt', {}, 'WhatsApp block') : null,
        a.reachout?.isActive ? h('dd', { style: 'color:var(--bad);font-weight:600' }, 'No messages to new numbers until ' + (a.reachout.timeEnforcementEnds ? new Date(a.reachout.timeEnforcementEnds).toLocaleString() : 'WhatsApp lifts it')) : null,
        h('dt', {}, 'History'), h('dd', {}, syncView(a)),
        a.backfill ? h('dt', {}, 'Deep history') : null,
        a.backfill ? h('dd', {}, `${a.backfill.status}${a.backfill.result ? ' — ' + a.backfill.result : ''}`) : null,
      ),
      h('div', { class: 'row' },
        a.status === 'open'
          ? h('button', { class: 'btn small', onclick: () => { state.inbox.account = a.id; location.hash = 'inbox'; } }, 'Open inbox')
          : h('button', { class: 'btn small primary', onclick: () => openLink(a) }, a.status === 'qr' ? 'Show QR' : 'Link number'),
        h('button', { class: 'btn small', onclick: () => { state.settingsFor = a.id; location.hash = 'settings'; } }, 'Settings'),
        a.status === 'open' || a.status === 'elsewhere'
          ? (a.backfill && ['pending', 'running'].includes(a.backfill.status)
              ? h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/jobs/${a.backfill.id}/cancel`, { method: 'POST' }); route(); }) }, 'Stop deep history')
              : h('button', { class: 'btn small', title: 'Pull older messages chat by chat from the phone', onclick: guard(async () => {
                  const since = prompt('Pull older messages back to which date? (YYYY-MM-DD, or leave empty for everything the phone has)', '');
                  if (since === null) return;
                  const groups = confirm('Include group chats too? (OK = yes, Cancel = people only)');
                  await api(`/api/accounts/${a.id}/backfill`, { body: { since: since || undefined, groups } });
                  toast('Deep history started — keep the phone online. Progress shows on this card.');
                  route();
                }) }, 'Deep history'))
          : null,
        !a.isDefault ? h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }); route(); }) }, 'Make default') : null,
        a.status === 'open' || a.status === 'connecting' || a.status === 'replaced'
          ? h('button', { class: 'btn small danger', onclick: guard(async () => {
              if (!confirm(`Unlink ${a.label} from WhatsApp? Stored chats are kept. You will need to scan a QR again.`)) return;
              await api(`/api/accounts/${a.id}/unlink`, { method: 'POST' });
              route();
            }) }, 'Unlink')
          : null,
      ),
    );
  }

  async function viewAccounts() {
    await loadAccounts(true); // the Numbers page always shows fresh connection and history state
    const form = h('form', { class: 'card', onsubmit: guard(async (e) => {
      e.preventDefault();
      const f = e.target;
      const cloud = f.kind.value === 'cloud';
      const acc = await api('/api/accounts', { body: { id: f.id.value, label: f.label.value || f.id.value, purpose: f.purpose.value,
        ...(cloud ? { provider: 'cloud', cloud: { phoneNumberId: f.pnid.value.trim() || undefined, wabaId: f.waba.value.trim() || undefined } } : {}) } });
      toast(cloud ? `Added "${acc.label}" — checking it with Meta…` : `Added "${acc.label}". Now link it.`);
      await route();
      if (!cloud) openLink({ ...acc, status: 'stopped' });
      else setTimeout(route, 4000);
    }) },
      h('h2', {}, 'Add a number'),
      h('p', { style: 'margin:0 0 6px' }, h('b', {}, 'Type of number')),
      h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'kind', value: 'phone', checked: true, onchange: (e) => { e.target.form.querySelector('.cloudonly').hidden = true; } }),
        h('span', {}, 'Linked phone', h('em', {}, 'A normal WhatsApp / WhatsApp Business app number, linked by QR or code.'))),
      h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'kind', value: 'cloud', onchange: (e) => { e.target.form.querySelector('.cloudonly').hidden = false; } }),
        h('span', {}, 'Meta Cloud API number', h('em', {}, 'Official API number from Meta (WhatsApp Manager). Nothing to scan; the keys are in Render.'))),
      h('div', { class: 'cloudonly', hidden: true },
        h('label', { class: 'field' }, h('span', {}, 'Phone number ID (optional)'), h('input', { type: 'text', name: 'pnid', inputmode: 'numeric', placeholder: 'Empty = META_PHONE_NUMBER_ID from Render' })),
        h('label', { class: 'field' }, h('span', {}, 'WhatsApp Business account ID (optional)'), h('input', { type: 'text', name: 'waba', inputmode: 'numeric', placeholder: 'Empty = META_WABA_ID from Render' }))),
      h('label', { class: 'field' }, h('span', {}, 'Short id'), h('input', { type: 'text', name: 'id', required: true, placeholder: 'hiring', pattern: '[A-Za-z0-9 _-]{2,32}' }), h('em', {}, 'Used by AI and Apps Script to pick this number, e.g. "hiring" or "guests".')),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'label', placeholder: 'Hiring (Airtel SIM)' })),
      h('label', { class: 'field' }, h('span', {}, 'Purpose'), h('input', { type: 'text', name: 'purpose', placeholder: 'Contacting job candidates' })),
      h('button', { class: 'btn primary', type: 'submit' }, 'Add number'),
    );
    shell([
      h('h1', {}, 'Numbers'),
      h('p', { class: 'sub' }, 'Every WhatsApp number linked to the hub, its connection, and how much chat history has been pulled in.'),
      h('div', { class: 'cards' }, state.accounts.map(accountCard), form),
    ]);
  }

  function openLink(a) {
    closeLink();
    const body = h('div', {});
    const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && closeLink() },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Link ${a.label}` },
        h('h2', {}, `Link "${a.label}"`),
        body,
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { class: 'btn', onclick: closeLink }, 'Close')),
      ),
    );
    document.body.append(back);
    // Poll as a fallback to live updates, so the QR on screen is never a stale one.
    const poll = setInterval(async () => {
      try {
        const list = await api('/api/accounts');
        const cur = list.find((x) => x.id === a.id);
        if (cur) drawLink(cur);
      } catch {}
    }, 4000);
    linkModal = { id: a.id, el: back, body, poll, started: a.status === 'qr' };
    if (a.status === 'qr' || a.status === 'open') drawLink(a);
    else drawChoice(a);
  }
  function closeLink() {
    if (linkModal) clearInterval(linkModal.poll);
    linkModal?.el.remove();
    linkModal = null;
  }
  const startLink = guard(async (id, opts = {}) => {
    if (linkModal) {
      linkModal.started = true;
      linkModal.lastQr = null;
      linkModal.wantsCode = !!opts.pairPhone;
      fill(linkModal.body, h('div', { class: 'qrbox' }, h('span', { class: 'muted' }, opts.pairPhone ? 'Getting your code…' : 'Generating QR…')));
    }
    await api(`/api/accounts/${id}/link`, { body: opts });
  });
  function drawChoice(a) {
    const opt = (v, title, hint) => h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'history', value: v, checked: (a.settings?.historyMode || 'full') === v }), h('span', {}, title, h('em', {}, hint)));
    // On a phone you can't scan your own screen, so the phone-number code is the default there.
    const onPhone = window.matchMedia('(max-width: 760px)').matches;
    const phoneField = h('label', { class: 'field', style: `margin:4px 0 0 28px;${onPhone ? '' : 'display:none'}` },
      h('span', {}, 'WhatsApp number being linked'), h('input', { type: 'tel', name: 'phone', placeholder: '98765 43210 or +91 98765 43210', value: a.phone || '' }));
    const how = (v, title, hint) => h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'how', value: v, checked: (v === 'code') === onPhone,
      onchange: () => { phoneField.style.display = v === 'code' ? '' : 'none'; } }), h('span', {}, title, h('em', {}, hint)));
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const history = e.target.history.value;
      if (e.target.how.value === 'code') {
        let phone = e.target.phone.value.replace(/\D/g, '');
        if (phone.length === 10) phone = '91' + phone;
        if (phone.length < 11) return toast('Type the number being linked, with country code (e.g. 919876543210)');
        startLink(a.id, { history, pairPhone: phone });
      } else startLink(a.id, { history });
    } },
      h('p', { style: 'margin-top:0' }, h('b', {}, '1. How do you want to link?')),
      how('qr', 'Scan a QR code', 'This page is open on a computer or another phone; scan it with the phone being linked.'),
      how('code', 'Link with phone number (enter a code)', 'This page is on the same phone you are linking, or scanning fails. You type an 8-letter code into WhatsApp.'),
      phoneField,
      h('p', { style: 'margin:14px 0 6px' }, h('b', {}, '2. What should be imported from this phone?')),
      opt('full', 'Full chat history', 'Everything the phone has — needed to find old leads. Best done on the PC; keep the phone online until it finishes.'),
      opt('recent', 'Recent history only', 'Roughly the last few months, as WhatsApp Web normally gets.'),
      opt('none', 'No history — new messages only', 'For a brand-new number, or numbers that only send.'),
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:8px' }, 'Continue'),
    );
    fill(linkModal.body, form);
  }
  function drawLink(info) {
    if (!linkModal || info.id !== linkModal.id || !linkModal.started) return;
    const b = linkModal.body;
    if (info.status === 'open') {
      clearInterval(linkModal.poll);
      fill(b, h('p', {}, `Linked as +${info.phone}. If you chose to import history it is downloading now — keep the phone online with WhatsApp open until the Numbers page shows it has finished.`));
      return;
    }
    if (info.status === 'qr' && info.qr === linkModal.lastQr && !info.pairingCode) return; // nothing new to draw
    linkModal.lastQr = info.qr;
    const wantsCode = linkModal.wantsCode;
    const steps = h('ol', { class: 'steps' },
      h('li', {}, 'On the phone: WhatsApp → Settings (or ⋮) → Linked devices → Link a device.'),
      wantsCode
        ? h('li', {}, 'Below the camera, tap "Link with phone number instead", then type this code (it may ask for your phone lock first):')
        : h('li', {}, 'Scan this code. It refreshes by itself; always scan the one showing now.'),
    );
    const code = info.pairingCode ? info.pairingCode.replace(/^(.{4})(.{4})$/, '$1-$2') : null;
    const qr = info.qr ? h('img', { src: info.qr, alt: 'WhatsApp QR code' }) : h('span', { class: 'muted' }, info.status === 'stopped' ? 'QR expired.' : 'Generating QR…');
    fill(b,
      steps,
      wantsCode
        ? h('div', { class: 'code', style: 'font-size:32px;letter-spacing:4px;text-align:center;padding:16px;user-select:all' }, code || (info.status === 'stopped' ? 'Code expired.' : 'Getting your code…'))
        : h('div', { class: 'qrbox' }, qr),
      wantsCode && code ? h('p', { class: 'muted', style: 'font-size:12px' }, 'The code is valid for a few minutes. If WhatsApp says it is wrong, press Start again for a new one.') : null,
      h('button', { class: info.status === 'stopped' || info.status === 'logged_out' ? 'btn primary' : 'btn small', style: 'margin-top:8px', onclick: () => drawChoice(state.accounts.find((x) => x.id === info.id) || info) }, info.status === 'stopped' || info.status === 'logged_out' ? 'Start again' : 'Start again / use the other method'),
      info.qrAt ? h('p', { class: 'muted', style: 'font-size:12px;margin:0' }, `Code shown at ${new Date(info.qrAt).toLocaleTimeString()}`) : null,
    );
  }

  // ---------- inbox ----------
  async function viewInbox() {
    await loadAccounts();
    const accs = state.accounts;
    if (!accs.length) return shell([h('h1', {}, 'Inbox'), h('p', { class: 'sub' }, 'Add and link a number first.')]);
    const ib = state.inbox;
    if (!ib.account || !accs.find((a) => a.id === ib.account)) ib.account = (accs.find((a) => a.isDefault) || accs[0]).id;

    const list = h('div', { class: 'chatlist', role: 'list' });
    const thread = h('section', { class: 'thread' }, h('div', { class: 'empty' }, 'Pick a chat'));
    const wrap = h('div', { class: 'inbox' + (ib.chat ? ' has-chat' : '') });
    const seg = (k, label) => h('button', { type: 'button', class: ib.kind === k ? 'on' : '', onclick: () => { ib.kind = k; loadChats(); markSeg(); } }, label);
    const segEl = h('div', { class: 'seg' }, seg('all', 'All'), seg('direct', 'People'), seg('group', 'Groups'));
    ib.state = ib.state || 'open';
    const stSeg = (k, label) => h('button', { type: 'button', class: ib.state === k ? 'on' : '', onclick: (e) => { ib.state = k; [...e.target.parentNode.children].forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); loadChats(); } }, label);
    const stateEl = h('div', { class: 'seg' }, stSeg('open', 'Open'), stSeg('snoozed', 'Reminders'), stSeg('done', 'Done'), stSeg('', 'Everything'));
    const markSeg = () => [...segEl.children].forEach((b, i) => b.classList.toggle('on', ['all', 'direct', 'group'][i] === ib.kind));
    let qTimer;
    const side = h('aside', { class: 'side' },
      h('div', { class: 'tools' },
        h('select', { 'aria-label': 'Number', onchange: (e) => { ib.account = e.target.value; ib.chat = null; viewInbox(); } },
          accs.map((a) => h('option', { value: a.id, selected: a.id === ib.account }, `${a.label}${a.phone ? ' (+' + a.phone + ')' : ''}`))),
        h('input', { type: 'text', placeholder: '🔍 Search name or number', value: ib.q, 'aria-label': 'Search chats', oninput: (e) => { ib.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(loadChats, 250); } }),
        stateEl,
        h('details', { class: 'fold' }, h('summary', {}, 'More filters', ib.kind !== 'all' || ib.waiting ? ' •' : ''),
          h('div', { style: 'display:grid;gap:8px;margin-top:8px' },
            segEl,
            h('label', { class: 'switch', style: 'margin:0' }, h('input', { type: 'checkbox', checked: ib.waiting, onchange: (e) => { ib.waiting = e.target.checked; persist(); loadChats(); } }), h('span', {}, 'Only chats waiting on my reply')))),
      ),
      list,
    );
    wrap.append(side, thread);
    shell(wrap, { flush: true });

    async function loadChats() {
      const p = new URLSearchParams({ limit: 100 });
      if (ib.q) p.set('q', ib.q);
      if (ib.kind !== 'all') p.set('kind', ib.kind);
      if (ib.waiting) p.set('waiting', '1');
      if (ib.state) p.set('state', ib.state);
      const chats = await api(`/api/accounts/${ib.account}/chats?${p}`);
      list.replaceChildren(
        ...(chats.length
          ? chats.map((c) =>
              h('div', { class: 'chatitem' + (c.jid === ib.chat ? ' on' : ''), role: 'listitem', tabindex: 0, onclick: () => openChat(c), onkeydown: (e) => e.key === 'Enter' && openChat(c) },
                h('div', { class: 'top' }, h('span', { class: 'name' }, c.is_group ? '👥 ' : '', c.name || c.jid), h('span', { class: 'time' }, fmtShort(c.last_ts))),
                h('div', { class: 'prev' }, c.last_from_me ? 'You: ' : '', c.last_preview || ''),
                c.due ? h('div', {}, h('span', { class: 'tag', style: 'background:var(--warn-soft);color:var(--ink)' }, '⏰ Reminder due', c.snooze_note ? ': ' + c.snooze_note : '')) : null,
                c.state === 'snoozed' && !c.due ? h('div', {}, h('span', { class: 'tag' }, '⏰ ' + new Date(c.snoozed_until).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), c.snooze_note ? ' · ' + c.snooze_note : '')) : null,
                c.tags?.length || c.is_blocked ? h('div', {}, c.is_blocked ? h('span', { class: 'tag' }, 'blocked') : null, (c.tags || []).map((t) => h('span', { class: 'tag' }, t))) : null,
              ))
          : [h('div', { class: 'empty' }, 'No chats yet. History appears here as it syncs.')]),
      );
      // Arrived from a Board card: open that conversation straight away
      if (ib.open) {
        const c = chats.find((x) => x.jid === ib.open);
        ib.open = null;
        if (c) openChat(c);
      }
    }

    async function openChat(c) {
      ib.chat = c.jid;
      wrap.classList.add('has-chat');
      [...list.children].forEach((el) => el.classList.remove('on'));
      const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
      let oldest = null;
      const olderBtn = h('button', { class: 'btn small', style: 'align-self:center', onclick: guard(() => loadMsgs(true)) }, 'Load earlier');
      const contactPanel = h('div', { class: 'contactpanel', hidden: true });
      // Chat actions: "Done" stays visible; the rest sit behind ⋯ so the header is one line on a phone
      const actions = h('div', { class: 'menu-panel chat-actions', hidden: true });
      const actionsBtn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'More chat actions', title: 'More', onclick: (e) => { e.stopPropagation(); actions.hidden = !actions.hidden; } }, '⋯');
      const header = h('header', {},
        h('button', { class: 'btn small back', onclick: () => { ib.chat = null; wrap.classList.remove('has-chat'); }, 'aria-label': 'Back to chats', title: 'Back to chats' }, '←'),
        h('div', { class: 'who' }, h('b', {}, c.name || c.jid), h('span', { class: 'muted mono jid' }, c.jid.split('@')[0])),
        c.state !== 'done'
          ? h('button', { class: 'btn small', title: 'Done — it comes back if they write again', onclick: guard(async () => {
              await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/state`, { method: 'PATCH', body: { state: 'done' } });
              toast('Marked done — it comes back if they write again'); ib.chat = null; viewInbox();
            }) }, '✓ Done')
          : null,
        h('div', { class: 'menu' }, actionsBtn, actions),
      );
      fill(actions,
        !c.is_group ? h('button', { class: 'btn small', onclick: () => { actions.hidden = true; contactPanel.hidden = !contactPanel.hidden; if (!contactPanel.hidden) loadContact(); } }, '👤 Contact') : null,
        c.state === 'open' || !c.state || c.due
          ? h('button', { class: 'btn small', title: 'Hide this chat until a date, then show it as a reminder', onclick: guard(async () => {
              const when = prompt('Remind me on (YYYY-MM-DD, optionally HH:MM) or in how many days (e.g. 3):', '1');
              if (!when) return;
              const until = /^\d+$/.test(when.trim()) ? new Date(Date.now() + Number(when) * 86400000) : new Date(when.replace(' ', 'T'));
              if (isNaN(until)) return toast('Could not read that date');
              const note = prompt('What to do then? (optional)', '') || undefined;
              await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/state`, { method: 'PATCH', body: { state: 'snoozed', until: until.toISOString(), note } });
              toast('Reminder set'); ib.chat = null; viewInbox();
            }) }, '⏰ Remind me')
          : null,
        c.state && c.state !== 'open' && !c.due
          ? h('button', { class: 'btn small', onclick: guard(async () => {
              await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/state`, { method: 'PATCH', body: { state: 'open' } });
              toast('Reopened'); viewInbox();
            }) }, '↺ Reopen')
          : null,
        isCloud(ib.account) ? null : h('button', { class: 'btn small', title: 'Ask the phone for older messages', onclick: guard(async () => {
          const r = await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/older`, { body: { count: 50 } });
          toast(r.note);
        }) }, '⤓ Older messages from phone'),
      );
      document.addEventListener('click', (e) => { if (!actions.hidden && !actions.contains(e.target)) actions.hidden = true; });
      const fileIn = h('input', { type: 'file', hidden: true });
      const ta = h('textarea', { rows: 1, placeholder: 'Type a message', 'aria-label': 'Message' });
      const fileLabel = h('span', { class: 'muted' });
      let replyTo = null;
      const replyBar = h('div', { class: 'muted', style: 'font-size:12px;display:none' });
      const setReply = (m) => {
        replyTo = m ? m.id : null;
        replyBar.style.display = m ? 'block' : 'none';
        fill(replyBar, m ? ['↪ Replying to: ', (m.body || '[' + m.type + ']').slice(0, 80), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); setReply(null); } }, 'cancel')] : []);
        if (m) ta.focus();
      };
      const tplSel = h('select', { 'aria-label': 'Insert a saved template', title: 'Insert a saved template', class: 'icon-select', onchange: guard(async (e) => {
        const t = (state.templates || []).find((x) => String(x.id) === e.target.value);
        e.target.value = '';
        if (!t) return;
        const ct = (await api(`/api/accounts/${ib.account}/contacts/${encodeURIComponent(c.jid)}`)) || {};
        const name = (ct.name || ct.notify || '').trim();
        ta.value = t.body.replace(/\{name\}/g, name || 'there').replace(/\{first_name\}/g, name.split(/\s+/)[0] || 'there').replace(/\{phone\}/g, c.jid.split('@')[0]);
        if (t.attachment?.url) toast('This template has a file — send it from the Board or via the AI, or attach it here');
        ta.focus();
      }) }, h('option', { value: '' }, '📝'));
      api(`/api/templates?account=${encodeURIComponent(ib.account)}`).then((ts) => {
        state.templates = ts;
        tplSel.append(...ts.map((t) => h('option', { value: t.id }, t.name)));
      }).catch(() => {});
      fileIn.onchange = () => { fileLabel.textContent = fileIn.files[0]?.name || ''; };
      const laterIn = h('input', { type: 'datetime-local', 'aria-label': 'Send at', title: 'Send at this time (leave empty to send now)', style: 'display:none;margin-top:4px;max-width:240px' });
      const composer = h('form', { class: 'composer', onsubmit: guard(async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        const file = fileIn.files[0];
        if (!text && !file) return;
        let attachment;
        if (file) {
          const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
          attachment = { base64: b64, fileName: file.name, mimetype: file.type || undefined };
        }
        sendBtn.disabled = true;
        try {
          const scheduleAt = laterIn.value ? new Date(laterIn.value).toISOString() : undefined;
          await api('/api/send', { body: { account: ib.account, to: c.jid, text: text || undefined, attachment, replyTo: replyTo || undefined, source: 'dashboard', scheduleAt } });
          if (scheduleAt) toast(`Scheduled for ${new Date(scheduleAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} — it's on the Board`);
          laterIn.value = '';
          laterIn.style.display = 'none';
          ta.value = '';
          setReply(null);
          fileIn.value = '';
          fileLabel.textContent = '';
          setTimeout(() => loadMsgs(), 800);
        } finally {
          sendBtn.disabled = false;
        }
      }) },
        h('button', { type: 'button', class: 'btn icon', onclick: () => fileIn.click(), 'aria-label': 'Attach file', title: 'Attach a file' }, '📎'), fileIn,
        h('button', { type: 'button', class: 'btn icon', title: 'Send later', 'aria-label': 'Send later', onclick: () => {
          const on = laterIn.style.display === 'none';
          laterIn.style.display = on ? '' : 'none';
          if (on) laterIn.focus(); else laterIn.value = '';
        } }, '⏰'),
        tplSel,
        h('div', { class: 'grow' }, replyBar, ta, laterIn, fileLabel),
      );
      const sendBtn = h('button', { class: 'btn primary send', type: 'submit', 'aria-label': 'Send', title: 'Send' }, '➤', h('span', { class: 'tab-label' }, ' Send'));
      composer.append(sendBtn);
      // Meta Cloud API number: free text only within 24 h of their last message, otherwise an approved template.
      const cloudBar = h('div', { style: 'display:none;padding:6px 12px;font-size:13px;border-top:1px solid var(--line)' });
      const checkWindow = async () => {
        if (!isCloud(ib.account) || c.is_group) return;
        const w = await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/window`).catch(() => null);
        if (!w) return;
        cloudBar.style.display = 'block';
        const tplPanel = h('div', { hidden: true, style: 'margin-top:6px' });
        const openTpl = h('button', { type: 'button', class: 'btn small', onclick: () => {
          tplPanel.hidden = !tplPanel.hidden;
          if (!tplPanel.hidden && !tplPanel.firstChild) {
            const field = waTemplateField(ib.account, null, { label: 'Send a Meta template', hint: '{first_name} / {name} are filled from this contact.' });
            tplPanel.append(field, h('button', { class: 'btn small primary', type: 'button', onclick: guard(async (e) => {
              const waTemplate = field.value();
              if (!waTemplate) return toast('Choose a template first');
              e.target.disabled = true;
              try {
                const ct = (await api(`/api/accounts/${ib.account}/contacts/${encodeURIComponent(c.jid)}`).catch(() => null)) || {};
                const name = (ct.name || ct.notify || '').trim();
                const sub = (v) => String(v).replace(/\{name\}/g, name || 'there').replace(/\{first_name\}/g, name.split(/\s+/)[0] || 'there');
                waTemplate.params = Array.isArray(waTemplate.params) ? waTemplate.params.map(sub) : Object.fromEntries(Object.entries(waTemplate.params).map(([k, v]) => [k, sub(v)]));
                await api('/api/send', { body: { account: ib.account, to: c.jid, waTemplate, source: 'dashboard' } });
                toast('Template sent');
                tplPanel.hidden = true;
                setTimeout(() => { loadMsgs(); checkWindow(); }, 800);
              } finally {
                e.target.disabled = false;
              }
            }) }, 'Send template'));
          }
        } }, 'Meta template…');
        fill(cloudBar,
          w.open
            ? h('span', {}, '🟢 Reply window open until ', new Date(w.closesAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), ' — free messages allowed. ')
            : h('span', { style: 'color:var(--bad)' }, w.closesAt ? '⛔ Reply window closed (24 h since their last message). ' : '⛔ They haven\'t written to this number yet. ', 'Only a Meta-approved template can be sent. '),
          openTpl, tplPanel);
        ta.placeholder = w.open ? 'Type a message' : 'Free text is blocked until they write again — use "Meta template…"';
      };
      thread.replaceChildren(header, h('div', { style: 'display:flex;flex-direction:column;min-height:0' }, contactPanel, msgs), h('div', {}, cloudBar, composer));
      thread.style.gridTemplateRows = 'auto minmax(0, 1fr) auto';
      checkWindow();

      async function loadContact() {
        const ct = (await api(`/api/accounts/${ib.account}/contacts/${encodeURIComponent(c.jid)}`)) || {};
        const tags = h('input', { type: 'text', value: (ct.tags || []).join(', '), placeholder: 'candidate, guest, lead-hot' });
        const status = h('input', { type: 'text', value: ct.lead_status || '', placeholder: 'new / contacted / interested / booked…' });
        const notes = h('textarea', { rows: 2, value: ct.notes || '' });
        const people = await api(`/api/people?q=${encodeURIComponent(c.jid.split('@')[0])}`).catch(() => []);
        const others = people.filter((p) => p.account_id !== ib.account);
        const otherNumbers = others.length
          ? h('div', {}, h('b', {}, 'Also on: '), others.map((p) => h('span', { class: 'tag' }, `${p.account_label}: ${p.messages} msgs, last ${fmt(p.last_ts) || '–'}${(p.tags || []).length ? ' · ' + p.tags.join(',') : ''}`)))
          : null;
        fill(contactPanel,
          h('div', { class: 'muted' }, `Saved name: ${ct.name || '–'} · WhatsApp name: ${ct.notify || '–'} · ${nice(ct.message_count)} messages since ${fmt(ct.first_ts) || '–'}${ct.is_blocked ? ' · BLOCKED' : ''}`),
          ct.summary ? h('div', {}, h('b', {}, 'AI summary: '), ct.summary) : null,
          otherNumbers,
          h('div', { class: 'row' }, h('label', { class: 'grow' }, 'Tags', tags), h('label', { class: 'grow' }, 'Status', status)),
          h('label', {}, 'Notes', notes),
          h('div', {}, h('button', { class: 'btn small primary', onclick: guard(async () => {
            const want = tags.value.split(',').map((t) => t.trim()).filter(Boolean);
            const had = ct.tags || [];
            await api(`/api/accounts/${ib.account}/contacts/${encodeURIComponent(c.jid)}`, { method: 'PATCH', body: {
              addTags: want.filter((t) => !had.includes(t)), removeTags: had.filter((t) => !want.includes(t)), leadStatus: status.value, notes: notes.value,
            } });
            toast('Saved');
          }) }, 'Save contact')),
        );
      }

      async function loadMsgs(earlier = false) {
        const p = new URLSearchParams({ limit: 60 });
        if (earlier && oldest) p.set('before', oldest);
        const rows = await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/messages?${p}`);
        if (rows.length) oldest = rows[0].ts;
        const nodes = [];
        let lastDay = '';
        for (const m of rows) {
          const day = new Date(m.ts * 1000).toDateString();
          if (day !== lastDay) {
            nodes.push(h('div', { class: 'daysep' }, new Date(m.ts * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })));
            lastDay = day;
          }
          const mediaLink = m.has_media
            ? h('div', {}, h('a', { href: `/api/media/${ib.account}/${encodeURIComponent(c.jid)}/${m.id}`, target: '_blank', rel: 'noopener' }, `Open ${m.type}${m.file_name ? ': ' + m.file_name : ''}`),
                m.media_saved ? h('span', { class: 'muted' }, ' · saved') : h('a', { href: '#', style: 'margin-left:8px', onclick: guard(async (e) => {
                  e.preventDefault();
                  await api(`/api/media/${ib.account}/${encodeURIComponent(c.jid)}/${m.id}?save=1`);
                  e.target.replaceWith(h('span', { class: 'muted' }, ' · saved'));
                }) }, 'Keep a copy'))
            : null;
          const vcards = (m.vcards || []).map((v) => h('div', { class: 'tag' }, `👤 ${v.name}${v.org ? ' · ' + v.org : ''} ${v.phones.map((p) => '+' + p).join(', ')}`));
          nodes.push(h('div', { class: 'msg' + (m.from_me ? ' me' : '') + (m.deleted ? ' deleted' : '') },
            c.is_group && !m.from_me ? h('div', { class: 's' }, m.sender_name || (m.sender_jid || '').split('@')[0]) : null,
            m.quoted_body ? h('div', { class: 'q' }, m.quoted_body) : null,
            m.deleted ? 'This message was deleted' : m.type === 'contact' ? null : m.body || (m.has_media ? null : `[${m.type}]`),
            vcards, mediaLink,
            h('div', { class: 't' }, fmt(m.ts), m.edited ? ' · edited' : '',
              m.from_me && m.status === 0 ? h('span', { style: 'color:var(--bad)' }, ' · not delivered') : m.from_me && m.status >= 4 ? ' · read' : m.from_me && m.status === 3 ? ' · delivered' : '',
              m.deleted ? '' : h('a', { href: '#', style: 'margin-left:8px', title: 'Reply to this message', onclick: (e) => { e.preventDefault(); setReply(m); } }, '↪ reply')),
          ));
        }
        if (earlier) {
          const prevHeight = msgs.scrollHeight;
          olderBtn.remove();
          msgs.prepend(...nodes);
          if (rows.length === 60) msgs.prepend(olderBtn);
          msgs.scrollTop = msgs.scrollHeight - prevHeight;
        } else {
          msgs.replaceChildren(...(rows.length === 60 ? [olderBtn] : []), ...(nodes.length ? nodes : [h('div', { class: 'empty' }, 'No messages stored yet')]));
          msgs.scrollTop = msgs.scrollHeight;
        }
      }
      state.reloadThread = (chatJid) => chatJid === c.jid && (loadMsgs(), checkWindow());
      await loadMsgs();
    }

    await loadChats();
    state.reloadChats = loadChats;
  }

  // ---------- task board ----------
  // Two lists you can read at a glance — "Do now" (overdue, due today, or waiting on someone) and "Future" (by day) —
  // plus running bulk sends and finished cards, collapsed. Each card shows its title line; details, history & notes
  // and the move/flag controls open on demand.
  async function viewBoard() {
    await loadAccounts();
    const accs = state.accounts;
    if (!accs.length) return shell([h('h1', {}, 'Board'), h('p', { class: 'sub' }, 'Add and link a number first.')]);
    const b = (state.board ||= { account: '', past: false, who: '' });
    if (b.account && !accs.find((a) => a.id === b.account)) b.account = '';
    const formAccount = b.account || (accs.find((a) => a.isDefault) || accs[0]).id;
    const q = (extra) => `/api/tasks?${new URLSearchParams({ ...(b.account ? { account: b.account } : {}), ...(b.role ? { role: b.role } : {}), ...extra })}`;
    const [active, past, roles, tplList] = await Promise.all([
      api(q({})),
      b.past ? api(q({ past: '1' })) : Promise.resolve([]),
      api('/api/roles').catch(() => []),
      api(`/api/templates?account=${encodeURIComponent(formAccount)}`).catch(() => []),
    ]);
    const labelOf = (id) => accs.find((a) => a.id === id)?.label || id;
    const whoOf = (t) => t.assignee || 'you';
    const mine = (t) => !b.who || whoOf(t) === b.who;
    const fmtWhen = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const KIND = { reply: ['💬', 'Reply needed'], visit: ['🎯', 'Interview'], followup: ['🔁', 'Follow-up'], scheduled: ['🕒', 'Scheduled message'], reminder: ['⏰', 'Reminder'], bulk: ['📤', 'Bulk send'], todo: ['📌', 'To-do'] };
    const icon = (pair) => h('span', { class: 'ico', title: pair[1], 'aria-label': pair[1] }, pair[0]);
    const whoIcon = (t) => icon(whoOf(t) === 'ai' ? ['🤖', 'The AI / hub does this'] : ['👤', 'You do this']);
    // Cards the hub made for a chat (reply, follow-up, interview, reminder) open that chat directly
    const chatOf = (t) => {
      const [refKind, refA, refB] = String(t.ref || '').split(':');
      if (!refB || !['reply', 'remind', 'visit', 'followup'].includes(refKind)) return null;
      return { kind: refKind, account: ['visit', 'followup'].includes(refKind) ? t.account_id : refA, jid: refB };
    };
    const goChat = (ch) => {
      Object.assign(state.inbox, { account: ch.account, q: ch.jid.split('@')[0], chat: null, state: ch.kind === 'remind' ? 'snoozed' : 'open', waiting: false, kind: 'all', open: ch.jid });
      location.hash = 'inbox';
    };
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const due = (t) => t.due_at || (t.kind === 'bulk' && t.next_at) || null;
    const isNow = (t) => (t.kind === 'bulk' ? t.status === 'waiting' || (!t.pending && !t.next_at) : !due(t) || new Date(due(t)) <= endOfToday);
    const running = active.filter((t) => mine(t) && t.kind === 'bulk' && t.status === 'in_progress');
    const now = active.filter((t) => mine(t) && !running.includes(t) && isNow(t))
      .sort((x, y) => (y.priority - x.priority) || ((due(x) ? new Date(due(x)) : 0) - (due(y) ? new Date(due(y)) : 0)));
    const future = active.filter((t) => mine(t) && !running.includes(t) && !isNow(t)).sort((x, y) => new Date(due(x)) - new Date(due(y)));

    // one card: title line + one action; everything else under "More"
    const card = (t) => {
      const ch = chatOf(t);
      // a reply card is dated when they wrote — that's 'waiting since', not overdue
      const overdue = due(t) && t.kind !== 'reply' && t.kind !== 'bulk' && new Date(due(t)) < new Date() && !['done', 'cancelled'].includes(t.status);
      const pct = t.total ? Math.round((100 * (t.sent + t.failed)) / t.total) : null;
      const primary = ch
        ? h('button', { class: 'btn small primary', onclick: () => goChat(ch) }, ch.kind === 'reply' ? '💬 Reply' : '💬 Open chat')
        : t.drafts
          ? h('button', { class: 'btn small primary', onclick: guard(async () => {
              if (!confirm(`Approve and start sending ${t.drafts} messages?`)) return;
              await api(`/api/tasks/${t.id}/approve`, { method: 'POST' });
              toast('Approved — sending');
              viewBoard();
            }) }, `✅ Approve ${t.drafts}`)
          : t.total ? h('button', { class: 'btn small', onclick: () => { state.outboxTask = t.id; state.outboxTab = 'all'; location.hash = 'outbox'; } }, '✉️ Messages') : null;
      const closed = ['done', 'cancelled'].includes(t.status);
      const doneBtn = closed ? null : h('button', { class: 'btn small', title: 'Mark done', onclick: guard(async () => {
        await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
        viewBoard();
      }) }, '✓');
      // More: details, latest note, history & notes, flag, move
      const logBox = h('div', { style: 'font-size:12px;margin-top:6px' });
      const noteIn = h('textarea', { rows: 2, placeholder: 'Add a note (e.g. call notes: what was discussed)', style: 'margin-top:6px' });
      const loadLog = async () => {
        const rows = await api(`/api/tasks/${t.id}/log`).catch(() => []);
        logBox.replaceChildren(...(rows.length ? rows.map((r) => h('div', { style: `padding:3px 0;border-bottom:1px solid var(--line);${r.kind === 'note' ? 'font-weight:600' : ''}` },
          h('span', { class: 'muted' }, new Date(r.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), ' · ', { you: '👤 You', ai: '🤖 AI', hub: '⚙️ Hub', rule: '⚙️ Rule' }[r.actor] || r.actor, ' · '),
          r.kind === 'note' ? '📝 ' : '', r.text)) : [h('span', { class: 'muted' }, 'No history yet.')]));
      };
      const move = h('select', { 'aria-label': 'Move task', class: 'small-select', onchange: guard(async (e) => {
        const v = e.target.value;
        if (v === 'cancelled') {
          if (!confirm('Cancel this task and its unsent messages?')) return (e.target.value = '');
          await api(`/api/tasks/${t.id}/cancel`, { method: 'POST' });
        } else await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: v } });
        viewBoard();
      }) }, h('option', { value: '' }, 'Move…'),
        ['upcoming', 'in_progress', 'waiting', 'done', 'cancelled'].filter((s) => s !== t.status).map((s) => h('option', { value: s }, s.replace('_', ' '))));
      const more = h('details', { class: 'more', ontoggle: (e) => { if (e.target.open) loadLog(); } },
        h('summary', {}, t.notes ? `More · 📝 ${t.notes}` : 'More'),
        t.details ? h('p', { class: 'muted', style: 'margin:6px 0;white-space:pre-wrap' }, t.details) : null,
        closed ? null : h('div', { class: 'row', style: 'margin:6px 0' },
          h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { priority: !t.priority } }); viewBoard(); }) }, t.priority ? '☆ Remove priority' : '⭐ Make priority'),
          move),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'History & notes'),
        logBox,
        noteIn,
        h('button', { class: 'btn small', style: 'margin-top:4px', onclick: guard(async () => {
          if (!noteIn.value.trim()) return;
          await api(`/api/tasks/${t.id}/notes`, { body: { text: noteIn.value } });
          noteIn.value = '';
          toast('Note saved');
          loadLog();
        }) }, 'Save note'));
      return h('div', { class: 'taskcard' + (t.priority ? ' prio' : '') + (overdue ? ' overdue' : '') },
        h('div', { class: 'tc-head' },
          t.priority ? icon(['⭐', 'Priority — must do']) : null,
          icon(KIND[t.kind] || KIND.todo),
          h('b', { class: 'grow tc-title' }, t.title),
          whoIcon(t)),
        h('div', { class: 'tc-meta muted' },
          due(t) ? h('span', { style: overdue ? 'color:var(--bad);font-weight:600' : '' }, t.kind === 'reply' ? 'Wrote ' : overdue ? 'Overdue · ' : '', fmtWhen(due(t))) : null,
          !b.account ? h('span', {}, ' · ', labelOf(t.account_id)) : null,
          t.total ? h('span', {}, ` · ${t.sent}/${t.total} sent${t.drafts ? `, ${t.drafts} to approve` : ''}${t.failed ? `, ${t.failed} failed` : ''}${t.replied ? `, ${t.replied} replied` : ''}`) : null),
        t.last_note ? h('div', { class: 'tc-note' }, '📝 ', t.last_note) : null,
        t.total && t.status === 'in_progress' ? h('div', { class: 'progress', style: 'margin:6px 0' }, h('i', { style: `width:${pct}%` })) : null,
        h('div', { class: 'row tc-actions' }, primary, doneBtn, more),
      );
    };
    // Future: one fold per day, the next two open
    const dayKey = (d) => new Date(d).toLocaleDateString('en-CA');
    const tomorrow = dayKey(Date.now() + 86400000);
    const days = [];
    for (const t of future) {
      const k = dayKey(due(t));
      let g = days.find((x) => x.k === k);
      if (!g) days.push((g = { k, items: [] }));
      g.items.push(t);
    }
    const dayLabel = (k) => (k === tomorrow ? 'Tomorrow' : new Date(k + 'T12:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }));
    const futureEl = days.length
      ? days.map((g, i) => h('details', { class: 'day', open: i < 2 },
          h('summary', {}, h('b', {}, dayLabel(g.k)), h('span', { class: 'muted' }, ` · ${g.items.length}`),
            g.items.some((t) => t.priority) ? h('span', { class: 'ico', title: 'Has a must-do' }, ' ⭐') : null,
            h('span', { class: 'muted day-peek' }, ' — ', g.items.slice(0, 3).map((t) => `${fmtTime(due(t))} ${t.title.replace(/^(Interview|Follow up|Scheduled): /, '').replace(/ — .*$/, '')}`).join(' · '))),
          h('div', { class: 'cardlist' }, g.items.map(card))))
      : [h('p', { class: 'muted' }, 'Nothing planned yet.')];
    const section = (titleIcon, title, items, body, { open = true, hint } = {}) =>
      h('details', { class: 'section', open },
        h('summary', {}, h('span', { class: 'sec-title' }, titleIcon, ' ', title), h('span', { class: 'count' }, items), hint ? h('span', { class: 'muted sec-hint' }, hint) : null),
        body);
    // filters: compact selects
    const sel = (label, value, options, onPick) => h('select', { class: 'small-select', 'aria-label': label, title: label, onchange: (e) => onPick(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: (value || '') === v }, l)));
    const filters = h('div', { class: 'row filters' },
      sel('Number', b.account, [['', '📱 All numbers'], ...accs.map((a) => [a.id, a.label])], (v) => { b.account = v; viewBoard(); }),
      sel('Who does it', b.who, [['', '👥 Everyone'], ['you', '👤 Mine'], ['ai', '🤖 AI']], (v) => { b.who = v; viewBoard(); }),
      roles.length ? sel('Job role', b.role, [['', '🧑‍🍳 All roles'], ...roles.map((r) => [r, r])], (v) => { b.role = v; viewBoard(); }) : null,
      h('button', { class: 'btn small', onclick: () => { b.past = !b.past; viewBoard(); } }, b.past ? 'Hide done' : '✓ Show done'));

    const newTask = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const f = e.target;
      await api('/api/tasks', { body: { account: formAccount, title: f.title.value, details: f.details.value || undefined, dueAt: f.due.value ? new Date(f.due.value).toISOString() : undefined,
        assignee: f.who.value, priority: f.priority.checked } });
      viewBoard();
    }) },
      h('label', { class: 'field' }, h('span', {}, 'Title'), h('input', { type: 'text', name: 'title', required: true, placeholder: 'Take interview of Ravi' })),
      h('label', { class: 'field' }, h('span', {}, 'Details'), h('textarea', { name: 'details', rows: 2, placeholder: 'Who, what, any instructions for the AI' })),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', {}, 'Due'), h('input', { type: 'datetime-local', name: 'due' })),
        h('label', { class: 'field grow' }, h('span', {}, 'Who does it'), h('select', { name: 'who' }, h('option', { value: 'you' }, '👤 Me'), h('option', { value: 'ai' }, '🤖 The AI')))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'priority' }), h('span', {}, '⭐ Priority', h('em', {}, 'A must-do: shown first and marked red.'))),
      h('button', { class: 'btn primary', type: 'submit' }, 'Add to board'));
    const bulkCost = h('p', { style: 'font-weight:600;margin:4px 0' });
    const peopleCount = () => (bulkForm?.list?.value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
    const updateBulkCost = async () => { const v = bulkWa?.value(); bulkCost.textContent = v ? await costLine(formAccount, peopleCount(), v) : ''; };
    let bulkForm = null;
    const bulkWa = isCloud(formAccount) ? waTemplateField(formAccount, null, { label: 'Meta template (required for a Meta API number)', hint: 'Boxes may use {first_name}, {name} or any column you add after the name.', onChange: updateBulkCost }) : null;
    const bulkTpl = h('select', { name: 'tpl' }, h('option', { value: '' }, '— none: write the message below —'), tplList.map((t) => h('option', { value: t.id }, t.name)));
    const bulk = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const f = e.target;
      const recipients = f.list.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [to, ...rest] = l.split(/[,\t;]/);
        return { to: to.trim(), name: rest.join(' ').trim() || undefined };
      });
      const waTemplate = bulkWa?.value() || undefined;
      if (bulkWa && !waTemplate) return toast('Meta API number: choose an approved Meta template');
      if (!bulkWa && !f.text?.value.trim() && !f.tpl?.value) return toast('Write a message or pick a template');
      const r = await api('/api/bulk', { body: { account: formAccount, title: f.title.value, text: f.text?.value || undefined, template: f.tpl?.value || undefined, waTemplate, recipients,
        scheduledAt: f.when.value ? new Date(f.when.value).toISOString() : undefined } });
      alert(r.task
        ? `${r.queued} messages ${r.mode === 'approve' ? 'saved for approval (Do now → Approve)' : 'queued'}.` + (r.cost?.total ? `\nEstimated Meta cost: ${money(r.cost.total, r.cost.currency)} (${r.cost.count} × ${money(r.cost.perMessage, r.cost.currency)})` : '') + (r.skipped.length ? `\n\nSkipped ${r.skipped.length}:\n` + r.skipped.map((x) => `${x.to} — ${x.reason}`).join('\n') : '')
        : 'Nothing queued.\n' + r.skipped.map((x) => `${x.to} — ${x.reason}`).join('\n'));
      viewBoard();
    }) },
      h('p', { class: 'muted', style: 'margin-top:0' }, `From ${labelOf(formAccount)} (pick a number in the filter above to send from another).`),
      h('label', { class: 'field' }, h('span', {}, 'Task title'), h('input', { type: 'text', name: 'title', required: true, placeholder: 'Chef candidates – WorkIndia' })),
      bulkWa || [
        h('label', { class: 'field' }, h('span', {}, 'Use a saved template (optional)'), bulkTpl),
        h('label', { class: 'field' }, h('span', {}, 'Message'), h('textarea', { name: 'text', rows: 4, placeholder: 'Hi {name}, we have an opening for a Chef at Zenith Suites, Bengaluru. Interested?' }),
          h('em', {}, '{name} is replaced by each person\'s name ("there" if missing).')),
      ],
      h('label', { class: 'field' }, h('span', {}, 'People — one per line: number, name'), h('textarea', { name: 'list', rows: 5, required: true, placeholder: '9876543210, Ravi Kumar\n919812345678, Anita', oninput: () => { clearTimeout(bulk._t); bulk._t = setTimeout(updateBulkCost, 400); } }),
        h('em', {}, 'Skips duplicates, opted-out contacts and anyone messaged in the last 30 days. Uses this number\'s delay, daily limit and hours.')),
      h('label', { class: 'field' }, h('span', {}, 'Start at (optional)'), h('input', { type: 'datetime-local', name: 'when' })),
      bulkWa ? bulkCost : null,
      h('button', { class: 'btn primary', type: 'submit' }, 'Create bulk send'));
    bulkForm = bulk;
    const priorityNow = now.filter((t) => t.priority).length;
    // replies come in bulk: one fold so they never bury the must-dos
    const nowReplies = now.filter((t) => t.kind === 'reply' && !t.priority);
    const nowMain = now.filter((t) => !nowReplies.includes(t));
    shell([
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h1', { class: 'grow', style: 'margin:0' }, 'Board'), filters),
      section('🔥', 'Do now', now.length, h('div', {},
        nowMain.length ? h('div', { class: 'cardlist' }, nowMain.map(card)) : !nowReplies.length ? h('p', { class: 'muted' }, 'All clear — nothing due now.') : null,
        nowReplies.length ? h('details', { class: 'day', open: nowReplies.length <= 3 }, h('summary', {}, h('b', {}, `💬 ${nowReplies.length} candidate${nowReplies.length > 1 ? 's' : ''} waiting for a reply`), h('span', { class: 'muted' }, ' — the AI drafts these; open to see them')),
          h('div', { class: 'cardlist' }, nowReplies.map(card))) : null),
        { hint: priorityNow ? `${priorityNow} must-do` : 'overdue, due today, or waiting on someone' }),
      section('📅', 'Future', future.length, h('div', {}, futureEl), { hint: 'by day' }),
      running.length ? section('⏳', 'Sending now', running.length, h('div', { class: 'cardlist' }, running.map(card)), { open: false }) : null,
      b.past ? section('✅', 'Done & cancelled', past.length, h('div', { class: 'cardlist' }, past.map(card)), { open: false }) : null,
      h('details', { class: 'section' }, h('summary', {}, h('span', { class: 'sec-title' }, '➕ New to-do')), newTask),
      h('details', { class: 'section' }, h('summary', {}, h('span', { class: 'sec-title' }, '📤 Bulk send')), bulk),
    ]);
  }

  // ---------- role chips (Chef / Front office / Housekeeping …) ----------
  async function roleChips(current, onPick) {
    const roles = await api('/api/roles').catch(() => []);
    if (!roles.length) return null;
    return h('div', { class: 'funnel', style: 'margin-bottom:10px' }, [['', 'All roles'], ...roles.map((r) => [r, r])].map(([k, l]) =>
      h('button', { class: 'tag' + ((current || '') === k ? ' on' : ''), onclick: () => onPick(k) }, l)));
  }

  // ---------- lists ----------
  const STATUS_LABEL = { new: 'Not messaged', queued: 'Queued', sent: 'Sent · no reply', replied: 'Replied', failed: 'Failed', opted_out: 'Opted out' };
  async function viewLists() {
    await loadAccounts();
    const all = await api(`/api/lists${state.listRole ? '?role=' + encodeURIComponent(state.listRole) : ''}`);
    const rolePick = await roleChips(state.listRole, (r) => { state.listRole = r; state.listId = null; viewLists(); });
    const sel = (state.listId && all.find((l) => l.id === state.listId)) || all[0];
    state.listId = sel?.id;
    const fmtD = (t) => (t ? new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
    const picker = h('div', { class: 'cards', style: 'grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));margin-bottom:16px' },
      all.map((l) => h('div', { class: 'card', style: `cursor:pointer;${l.id === sel?.id ? 'border-color:var(--accent)' : ''}`, onclick: () => { state.listId = l.id; state.listFilter = ''; viewLists(); } },
        h('b', {}, l.name), h('div', { class: 'muted', style: 'font-size:12px' }, l.role || 'No role', ' · ', l.account_label, ' · ', l.total, ' people'),
        h('div', { style: 'margin-top:6px' }, ['new', 'sent', 'replied', 'failed'].map((k) => h('span', { class: 'tag' }, `${STATUS_LABEL[k]}: ${l[k]}`)),
          l.followup?.enabled ? h('span', { class: 'tag' }, `follow-up after ${l.followup.afterDays}d`) : null))));
    const importForm = h('details', { class: 'card', style: 'margin-top:16px' }, h('summary', {}, 'Import a list (paste rows)'),
      h('form', { onsubmit: guard(async (e) => {
        e.preventDefault();
        const f = e.target;
        const members = f.rows.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [phone, name, ...msg] = l.split('\t').length > 1 ? l.split('\t') : l.split(',');
          return { phone: phone.trim(), name: (name || '').trim() || undefined, message: msg.join(',').trim() || undefined };
        });
        const r = await api('/api/lists/import', { body: { account: f.account.value, name: f.name.value, role: f.role.value || undefined, since: f.since.value || undefined, members } });
        toast(`Imported ${r.imported}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`);
        state.listId = r.list.id;
        viewLists();
      }) },
        h('label', { class: 'field' }, h('span', {}, 'List name'), h('input', { type: 'text', name: 'name', required: true, placeholder: 'Chef candidates – Batch 6' })),
        h('label', { class: 'field' }, h('span', {}, 'Job role'), h('input', { type: 'text', name: 'role', placeholder: 'Chef, Front office, Housekeeping… (guessed from the name if empty)' }), h('em', {}, 'Each role keeps its own lists, tasks and log. People already on an earlier list of the same role are skipped.')),
        h('label', { class: 'field' }, h('span', {}, 'Number'), h('select', { name: 'account' }, state.accounts.map((a) => h('option', { value: a.id }, a.label)))),
        h('label', { class: 'field' }, h('span', {}, 'Count messages from (optional)'), h('input', { type: 'date', name: 'since' }), h('em', {}, 'Messages to these people before this date are ignored when deciding who was already messaged. Empty = from today.')),
        h('label', { class: 'field' }, h('span', {}, 'People — one per line: phone, name, personal message (optional). Tab-separated also works (paste from a sheet).'), h('textarea', { name: 'rows', rows: 6, required: true })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Import')));
    if (!sel) return shell([h('h1', {}, 'Lists'), h('p', { class: 'sub' }, 'Candidate batches and other contact lists, with who was messaged, who replied and automatic follow-ups.'), importForm]);

    const filter = state.listFilter || '';
    const members = await api(`/api/lists/${sel.id}/members${filter ? '?status=' + filter : ''}`);
    const help = await metaHelpTable();
    const f = sel.followup || {};
    const tabs = h('div', { class: 'seg', style: 'max-width:720px;margin:10px 0' },
      [['', `All ${sel.total}`], ['new', `Not messaged ${sel.new}`], ['sent', `No reply ${sel.sent}`], ['replied', `Replied ${sel.replied}`], ['failed', `Failed ${sel.failed}`], ['queued', `Queued ${sel.queued}`]].map(([k, l]) =>
        h('button', { class: filter === k ? 'on' : '', onclick: () => { state.listFilter = k; viewLists(); } }, l)));
    const cloudList = isCloud(sel.account_id);
    const sendBtn = h('button', { class: 'btn primary', disabled: !(sel.new + sel.failed), onclick: guard(async () => {
      let waTemplate;
      if (cloudList) {
        waTemplate = await askTemplate(sel.account_id, `Message ${sel.new + sel.failed} people from a Meta API number`, 'First messages must be a Meta-approved template. Boxes may use {first_name}, {name} or list columns.', sel.new + sel.failed);
        if (!waTemplate) return;
      } else if (!confirm(`Message the ${sel.new + sel.failed} people not messaged yet or failed, each with their own prepared message?`)) return;
      const r = await api(`/api/lists/${sel.id}/send`, { body: { statuses: ['new', 'failed'], waTemplate } });
      alert(`${r.queued} messages ${r.mode === 'approve' ? 'saved for approval on the Board (Waiting for approval)' : 'queued'}.` + (r.cost?.total ? `\nEstimated Meta cost: ${money(r.cost.total, r.cost.currency)} (${r.cost.count} × ${money(r.cost.perMessage, r.cost.currency)})` : '') + (r.skipped.length ? `\nSkipped: ${r.skipped.map((x) => x.to + ' – ' + x.reason).join(', ')}` : ''));
      viewLists();
    }) }, `Message not-messaged + failed (${sel.new + sel.failed})`);
    const fuWa = cloudList ? waTemplateField(sel.account_id, f.waTemplate, { label: 'Meta template for follow-ups', hint: 'Meta API number: people who never replied can only get an approved template.' }) : null;
    const fuForm = h('form', { class: 'card', onsubmit: guard(async (e) => {
      e.preventDefault();
      const x = e.target;
      await api(`/api/lists/${sel.id}/followup`, { method: 'PATCH', body: { enabled: x.enabled.checked, quietDaysOnly: x.quiet.checked, autoSend: x.autoSend.checked, afterDays: Number(x.afterDays.value), max: Number(x.max.value), text: x.text.value,
        ...(fuWa ? { waTemplate: fuWa.value() } : {}) } });
      toast('Follow-up settings saved');
      viewLists();
    }) },
      h('h2', {}, 'Automatic follow-ups'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: !!f.enabled }), h('span', {}, 'On', h('em', {}, 'People messaged but silent get this, quoting your last message. Uses the number\'s approval mode, delay and daily limit.'))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'quiet', checked: f.quietDaysOnly !== false }), h('span', {}, 'Only on days with no new outreach', h('em', {}, 'New candidates get the limited daily messages first; follow-ups wait for a day this number messages no new people.'))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'autoSend', checked: !!f.autoSend }), h('span', {}, 'Send without approval', h('em', {}, 'Timing and the daily maximum come from the number\'s Settings (default: after 21:00, max 5 a day).'))),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', {}, 'After (days without reply)'), h('input', { type: 'number', name: 'afterDays', min: 0.5, step: 0.5, value: f.afterDays ?? 2 })),
        h('label', { class: 'field grow' }, h('span', {}, 'At most (follow-ups per person)'), h('input', { type: 'number', name: 'max', min: 0, max: 5, value: f.max ?? 1 }))),
      h('label', { class: 'field' }, h('span', {}, cloudList ? 'Follow-up message (used only if they wrote in the last 24 h)' : 'Follow-up message'), h('textarea', { name: 'text', rows: 3, value: f.text || '', placeholder: 'Namaste {first_name} ji, kya aap abhi bhi interested hain? Reply karein ya call karein. - Zenith Suites HR' })),
      fuWa,
      h('button', { class: 'btn primary', type: 'submit' }, 'Save follow-ups'));
    // ---- funnel strip + upcoming visits
    const STAGE_LABEL = { interested: 'Interested', date_given: 'Date given', visited: 'Visited', trial: 'Trial', selected: 'Selected', joined: 'Joined', no_show: 'No-show', not_interested: 'Not interested', rejected: 'Rejected' };
    const stageCount = {};
    for (const m of members) if (m.stage) stageCount[m.stage] = (stageCount[m.stage] || 0) + 1;
    const funnel = h('div', { class: 'funnel' }, Object.keys(STAGE_LABEL).filter((k) => stageCount[k]).map((k) =>
      h('button', { class: 'tag' + (state.stageFilter === k ? ' on' : ''), onclick: () => { state.stageFilter = state.stageFilter === k ? '' : k; viewLists(); } }, `${STAGE_LABEL[k]} ${stageCount[k]}`)));
    const visits = members.filter((m) => m.stage === 'date_given' && m.visit_at).sort((a, b) => new Date(a.visit_at) - new Date(b.visit_at));
    const shown = state.stageFilter ? members.filter((m) => m.stage === state.stageFilter) : members;
    const toLocalInput = (t) => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    const save = guard(async (m, body) => { await api(`/api/lists/${sel.id}/members/${m.phone}`, { method: 'PATCH', body }); toast('Saved'); viewLists(); });
    const people = h('div', { class: 'people' }, shown.length ? shown.map((m) => {
      const closed = ['rejected', 'not_interested', 'joined'].includes(m.stage);
      return h('div', { class: 'person' + (closed ? ' closed' : '') },
        h('div', { class: 'p-head' },
          h('div', { class: 'grow' }, h('b', {}, m.row_ref ? `${m.row_ref}. ` : '', m.name || '–'), h('a', { class: 'mono muted', href: `#inbox`, onclick: () => { state.inbox.account = sel.account_id; state.inbox.q = m.phone; }, style: 'margin-left:6px;font-size:12px' }, '+' + m.phone)),
          h('span', { class: 'tag', style: m.status === 'replied' ? 'background:var(--accent-soft)' : m.status === 'failed' ? 'background:var(--bad-soft)' : '' }, STATUS_LABEL[m.status] || m.status),
          m.status === 'new' && !m.last_sent_at ? h('button', { class: 'btn small', title: 'Remove from this list (only people never messaged — e.g. typed by mistake)', 'aria-label': 'Remove from list', onclick: guard(async () => {
            if (!confirm(`Remove ${m.name || m.phone} from ${sel.name}? They were never messaged from it.`)) return;
            await api(`/api/lists/${sel.id}/members/${m.phone}`, { method: 'DELETE' });
            toast('Removed');
            viewLists();
          }) }, '🗑') : null),
        h('div', { class: 'p-meta muted' }, `Sent ${fmtD(m.last_sent_at)}`, m.followups_sent ? ` · ${m.followups_sent} follow-up(s)` : ''),
        m.error && m.status === 'failed' ? errorBox(m.error, help) : null,
        m.last_reply_at ? h('div', { class: 'p-reply' }, h('span', { class: 'muted' }, fmtD(m.last_reply_at) + ': '), m.last_reply_text || '') : null,
        h('div', { class: 'p-edit' },
          h('select', { 'aria-label': 'Stage', onchange: (e) => save(m, { stage: e.target.value }) },
            h('option', { value: '' }, 'Stage…'), Object.entries(STAGE_LABEL).map(([k, l]) => h('option', { value: k, selected: m.stage === k }, l))),
          h('input', { type: 'datetime-local', 'aria-label': 'Interview date', title: 'Interview: when they will come', value: toLocalInput(m.visit_at), onchange: (e) => save(m, { visitAt: e.target.value ? new Date(e.target.value).toISOString() : '' }) }),
          h('input', { type: 'datetime-local', 'aria-label': 'Follow up on', title: 'Follow up on (the AI messages them then; shows on the Board)', value: toLocalInput(m.followup_at), onchange: (e) => save(m, { followupAt: e.target.value ? new Date(e.target.value).toISOString() : '' }) }),
          h('input', { type: 'text', 'aria-label': 'Outcome', placeholder: 'Reason / outcome', value: m.outcome || '', onchange: (e) => save(m, { outcome: e.target.value }) })),
        m.followup_at ? h('div', { class: 'muted', style: 'font-size:12px' }, '🔁 Follow up ', fmtD(m.followup_at), m.followup_note ? ` — ${m.followup_note}` : '') : null,
        m.notes ? h('div', { class: 'muted', style: 'font-size:12px' }, m.notes) : null);
    }) : h('p', { class: 'muted' }, 'Nobody here.'));
    const p = { remindHoursBefore: 18, askDateAfterHours: 4, enabled: true, ...(sel.pipeline || {}) };
    const askWa = cloudList ? waTemplateField(sel.account_id, p.askDateWaTemplate, { label: 'Meta template: ask for a date' }) : null;
    const remWa = cloudList ? waTemplateField(sel.account_id, p.reminderWaTemplate, { label: 'Meta template: visit reminder', hint: '{visit_date} fills in their date.' }) : null;
    const pipeForm = h('form', { class: 'card', onsubmit: guard(async (e) => {
      e.preventDefault();
      const x = e.target;
      await api(`/api/lists/${sel.id}/pipeline`, { method: 'PATCH', body: { enabled: x.enabled.checked, autoSend: x.autoSend.checked, remindHoursBefore: Number(x.hours.value), askDateAfterHours: Number(x.askAfter.value), askDateText: x.askText.value || undefined, reminderText: x.remText.value || undefined,
        ...(askWa ? { askDateWaTemplate: askWa.value(), reminderWaTemplate: remWa.value() } : {}) } });
      toast('Pipeline settings saved');
      viewLists();
    }) },
      h('h2', {}, 'Pipeline automation'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: p.enabled !== false }), h('span', {}, 'On', h('em', {}, 'Interested without a date → ask for one. Date given → reminder before the visit + a Board task for you. Date passed → "Did they come?" task.'))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'autoSend', checked: !!p.autoSend }), h('span', {}, 'Send these without approval')),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', {}, 'Remind (hours before visit)'), h('input', { type: 'number', name: 'hours', min: 1, value: p.remindHoursBefore })),
        h('label', { class: 'field grow' }, h('span', {}, 'Ask for a date after (hours)'), h('input', { type: 'number', name: 'askAfter', min: 1, value: p.askDateAfterHours }))),
      h('label', { class: 'field' }, h('span', {}, 'Ask-for-date message'), h('textarea', { name: 'askText', rows: 2, value: p.askDateText || '', placeholder: 'Default: Namaste {first_name} ji, aap kis din aa sakte hain? …' })),
      h('label', { class: 'field' }, h('span', {}, 'Visit reminder ({visit_date} = their date)'), h('textarea', { name: 'remText', rows: 2, value: p.reminderText || '', placeholder: 'Default: Namaste {first_name} ji, yaad dila rahe hain: aap {visit_date} ko …' })),
      askWa ? h('p', { class: 'muted', style: 'font-size:12px' }, 'Meta API number: the texts above go only if the person wrote in the last 24 h. Otherwise these templates are used — without one, a Board task asks you to call them.') : null,
      askWa, remWa,
      h('button', { class: 'btn primary', type: 'submit' }, 'Save pipeline'));
    shell([
      h('h1', {}, 'Lists'),
      h('p', { class: 'sub' }, 'Status comes from the real WhatsApp messages of the list\'s number. Stage and visit date are the funnel — set them here or ask the AI.'),
      rolePick,
      picker,
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, sel.name), sendBtn,
        h('button', { class: 'btn small', title: 'Archive: this list never sends again and is hidden (e.g. imported only to check duplicates)', onclick: guard(async () => {
          const reason = prompt(`Archive ${sel.name}? It will never send again and its unsent messages are cancelled. Reason (optional):`, '');
          if (reason === null) return;
          await api(`/api/lists/${sel.id}/archive`, { body: { archived: true, reason } });
          toast('List archived');
          state.listId = null;
          viewLists();
        }) }, '🗄 Archive')),
      visits.length ? h('div', { class: 'card', style: 'margin:12px 0' }, h('b', {}, '📅 Visits'), visits.map((m) => h('div', { style: 'font-size:13px;margin-top:4px' }, `${new Date(m.visit_at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} — ${m.name || m.phone}`, new Date(m.visit_at) < new Date() ? h('span', { style: 'color:var(--bad)' }, ' · passed, update stage') : ''))) : null,
      Object.keys(stageCount).length ? funnel : null,
      tabs,
      people,
      h('details', { class: 'section', style: 'margin-top:16px' }, h('summary', {}, h('span', { class: 'sec-title' }, '⚙️ Automation for this list'), h('span', { class: 'muted sec-hint' }, `pipeline ${p.enabled !== false ? 'on' : 'off'} · follow-ups ${f.enabled ? 'on' : 'off'}`)),
        h('div', { class: 'settings-grid' }, pipeForm, fuForm)),
      importForm,
    ]);
  }

  // ---------- templates ----------
  async function viewTemplates() {
    await loadAccounts();
    const rows = await api('/api/templates');
    const label = (id) => (id ? state.accounts.find((a) => a.id === id)?.label || id : 'All numbers');
    const form = (t = {}) => h('form', { class: 'card', onsubmit: guard(async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { account: f.account.value || null, name: f.name.value, body: f.body.value,
        attachment: f.url.value.trim() ? { url: f.url.value.trim(), fileName: f.fileName.value.trim() || undefined } : null };
      await api(t.id ? `/api/templates/${t.id}` : '/api/templates', { method: t.id ? 'PATCH' : 'POST', body });
      toast('Template saved');
      viewTemplates();
    }) },
      h('h2', {}, t.id ? `Edit "${t.name}"` : 'New template'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name', required: true, value: t.name || '', placeholder: 'Chef job invite' })),
      h('label', { class: 'field' }, h('span', {}, 'For'), h('select', { name: 'account' }, h('option', { value: '' }, 'All numbers'), state.accounts.map((a) => h('option', { value: a.id, selected: a.id === t.account_id }, a.label)))),
      h('label', { class: 'field' }, h('span', {}, 'Message'), h('textarea', { name: 'body', rows: 5, value: t.body || '', placeholder: 'Hi {first_name}, we have a {role} opening at Zenith Suites, Bengaluru. Interested?' }),
        h('em', {}, '{name}, {first_name} and {phone} are filled from the contact. Any other {field} (e.g. {role}, {date}) is filled from the bulk-send list or by the AI.')),
      h('label', { class: 'field' }, h('span', {}, 'File link (optional)'), h('input', { type: 'url', name: 'url', value: t.attachment?.url || '', placeholder: 'Google Drive or any public link to a PDF/image' })),
      h('label', { class: 'field' }, h('span', {}, 'File name shown (optional)'), h('input', { type: 'text', name: 'fileName', value: t.attachment?.fileName || '', placeholder: 'Zenith Suites brochure.pdf' })),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save template'),
        t.id ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (!confirm(`Delete "${t.name}"?`)) return; await api(`/api/templates/${t.id}`, { method: 'DELETE' }); viewTemplates(); }) }, 'Delete') : null),
    );
    const editor = h('div', {}, form());
    // Meta-approved templates of each Meta API number (created in WhatsApp Manager, read-only here)
    const cloudAccs = state.accounts.filter((a) => a.provider === 'cloud');
    const metaCards = await Promise.all(cloudAccs.map(async (a) => {
      const box = h('div', {});
      const load = async (sync) => {
        const ts = await api(`/api/accounts/${a.id}/wa-templates${sync ? '?sync=1' : ''}`);
        const badge = (s) => h('span', { class: 'tag', style: s === 'APPROVED' ? 'background:var(--accent-soft)' : s === 'REJECTED' ? 'background:var(--bad-soft)' : '' }, s.toLowerCase());
        fill(box, ts.length ? ts.map((t) => h('div', { style: 'border-top:1px solid var(--line);padding:8px 0' },
          h('div', { class: 'row' }, h('b', { class: 'grow mono' }, t.name), h('span', { class: 'tag' }, t.language), h('span', { class: 'tag' }, t.category.toLowerCase()), badge(t.status)),
          h('div', { class: 'muted', style: 'white-space:pre-wrap;font-size:13px' }, t.headerText ? t.headerText + '\n' : '', t.body, t.footer ? '\n— ' + t.footer : ''),
          t.vars.length ? h('div', { class: 'muted', style: 'font-size:12px' }, 'Fill-ins: ', t.vars.map((v) => `{{${v}}}`).join(' ')) : null))
          : h('p', { class: 'muted' }, 'No templates yet.'));
      };
      await load(false).catch((e) => fill(box, h('p', { class: 'muted' }, e.message)));
      return h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `Meta templates — ${a.label}`),
          h('button', { class: 'btn small', onclick: guard(async () => { await load(true); toast('Synced with Meta'); }) }, 'Sync from Meta'),
          h('a', { class: 'btn small', href: 'https://business.facebook.com/wa/manage/message-templates/', target: '_blank', rel: 'noopener' }, 'Create in WhatsApp Manager')),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'A Meta API number can message someone who hasn\'t written in 24 hours only with one of these approved templates. Meta usually reviews new ones within minutes; this list updates by itself.'),
        box,
        h('details', { style: 'margin-top:10px' }, h('summary', {}, 'Submit a new template to Meta'),
          h('form', { onsubmit: guard(async (e) => {
            e.preventDefault();
            const f = e.target;
            const r = await api(`/api/accounts/${a.id}/wa-templates`, { body: {
              name: f.tname.value, category: f.category.value, language: f.lang.value || 'en', body: f.tbody.value,
              examples: f.examples.value.split('|').map((x) => x.trim()).filter(Boolean), footer: f.footer.value || undefined,
              buttons: f.buttons.value.split('|').map((x) => x.trim()).filter(Boolean),
            } });
            toast(`Submitted "${r.name}" — ${String(r.status || 'pending').toLowerCase()}`);
            await load(true);
          }) },
            h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { name: 'tname', required: true, placeholder: 'chef_job_invite', pattern: '[a-z0-9_]+' })),
            h('div', { class: 'row' },
              h('label', { class: 'field grow' }, h('span', {}, 'Category'), h('select', { name: 'category' }, h('option', { value: 'UTILITY' }, 'Utility (about something they asked for / applied to)'), h('option', { value: 'MARKETING' }, 'Marketing (promotional)'))),
              h('label', { class: 'field' }, h('span', {}, 'Language'), h('input', { name: 'lang', value: 'en', style: 'width:80px' }))),
            h('label', { class: 'field' }, h('span', {}, 'Text'), h('textarea', { name: 'tbody', rows: 4, required: true, placeholder: 'Namaste {{1}} ji, Zenith Suites ko {{2}} chahiye. Interested hain to reply karein. – Zenith Suites HR' }),
              h('em', {}, '{{1}}, {{2}} … are filled per person. Not at the very start or end.')),
            h('label', { class: 'field' }, h('span', {}, 'Example values, separated by |'), h('input', { name: 'examples', placeholder: 'Ravi | Chef' })),
            h('label', { class: 'field' }, h('span', {}, 'Footer (optional)'), h('input', { name: 'footer', placeholder: 'Zenith Suites, Bengaluru' })),
            h('label', { class: 'field' }, h('span', {}, 'Quick-reply buttons (optional, |-separated, max 3)'), h('input', { name: 'buttons', placeholder: 'Haan, interested | Nahi' })),
            h('button', { class: 'btn primary', type: 'submit' }, 'Submit for review'))));
    }));
    shell([
      h('h1', {}, 'Templates'),
      h('p', { class: 'sub' }, 'Saved messages you, bulk sends and the AI can reuse. Pick one in the inbox ("Template…") or in a bulk send.'),
      metaCards.length ? h('div', { class: 'settings-grid', style: 'margin-bottom:16px' }, metaCards) : null,
      h('div', { class: 'settings-grid' },
        h('div', { class: 'card' }, h('h2', {}, `Saved (${rows.length})`),
          rows.length ? rows.map((t) => h('div', { style: 'border-top:1px solid var(--line);padding:8px 0' },
            h('div', { class: 'row' }, h('b', { class: 'grow' }, t.name), h('span', { class: 'tag' }, label(t.account_id)), t.attachment?.url ? h('span', { class: 'tag' }, '📎 file') : null,
              h('button', { class: 'btn small', onclick: () => fill(editor, form(t)) }, 'Edit')),
            h('div', { class: 'muted', style: 'white-space:pre-wrap;font-size:13px' }, t.body.slice(0, 220)))) : h('p', { class: 'muted' }, 'None yet.')),
        editor),
    ]);
  }

  // ---------- rules ----------
  async function viewRules() {
    await loadAccounts();
    const rows = await api('/api/rules');
    const tpls = await api('/api/templates');
    const label = (id) => state.accounts.find((a) => a.id === id)?.label || id;
    const describe = (r) => {
      const c = r.conditions || {}, a = r.actions || {};
      const when = [c.chat === 'any' ? 'any chat' : c.chat === 'group' ? 'a group' : 'a person', c.sender === 'new' ? '(someone new)' : c.sender === 'known' ? '(someone you know)' : '',
        c.types?.length ? `sends ${c.types.join('/')}` : 'sends anything', c.words?.length ? `containing "${c.words.join('" or "')}"` : ''].filter(Boolean).join(' ');
      const then = [a.addTags && `tag ${a.addTags.join(', ')}`, a.leadStatus && `status → ${a.leadStatus}`, a.saveMedia && 'save the file', a.createTask && `add task "${a.createTask}"`,
        a.replyTemplate && `auto-reply "${a.replyTemplate}"`, a.snoozeDays && `remind me in ${a.snoozeDays} days`].filter(Boolean).join(', ');
      return `When ${when} → ${then}`;
    };
    const form = (r = {}) => {
      const c = r.conditions || {}, a = r.actions || {};
      return h('form', { class: 'card', onsubmit: guard(async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = {
          account: f.account.value, name: f.name.value, enabled: f.enabled.checked,
          conditions: { chat: f.chat.value, sender: f.sender.value, types: [...f.querySelectorAll('input[name=type]:checked')].map((i) => i.value), words: f.words.value },
          actions: { addTags: f.addTags.value, leadStatus: f.leadStatus.value, saveMedia: f.saveMedia.checked, createTask: f.createTask.value, replyTemplate: f.replyTemplate.value, snoozeDays: f.snoozeDays.value },
        };
        await api(r.id ? `/api/rules/${r.id}` : '/api/rules', { method: r.id ? 'PATCH' : 'POST', body });
        toast('Rule saved');
        viewRules();
      }) },
        h('h2', {}, r.id ? `Edit "${r.name}"` : 'New rule'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name', required: true, value: r.name || '', placeholder: 'Resumes from candidates' })),
        h('label', { class: 'field' }, h('span', {}, 'Number'), h('select', { name: 'account' }, state.accounts.map((x) => h('option', { value: x.id, selected: x.id === r.account_id }, x.label)))),
        h('h2', { style: 'margin-top:8px' }, 'When'),
        h('div', { class: 'row' },
          h('label', { class: 'field grow' }, h('span', {}, 'Chat'), h('select', { name: 'chat' }, [['direct', 'A person'], ['group', 'A group'], ['any', 'Any chat']].map(([v, l]) => h('option', { value: v, selected: (c.chat || 'direct') === v }, l)))),
          h('label', { class: 'field grow' }, h('span', {}, 'Sender'), h('select', { name: 'sender' }, [['any', 'Anyone'], ['new', 'Someone new'], ['known', 'Someone I know']].map(([v, l]) => h('option', { value: v, selected: (c.sender || 'any') === v }, l))))),
        h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:550;margin-bottom:4px' }, 'Sends (none ticked = anything)'),
          h('div', { class: 'daypick' }, ['text', 'document', 'image', 'video', 'voice', 'contact', 'location'].map((t) => h('label', {}, h('input', { type: 'checkbox', name: 'type', value: t, checked: (c.types || []).includes(t) }), t)))),
        h('label', { class: 'field' }, h('span', {}, 'Containing any of these words (optional, comma separated)'), h('input', { type: 'text', name: 'words', value: (c.words || []).join(', '), placeholder: 'booking, room, rate' })),
        h('h2', { style: 'margin-top:8px' }, 'Then'),
        h('label', { class: 'field' }, h('span', {}, 'Add tags'), h('input', { type: 'text', name: 'addTags', value: (a.addTags || []).join(', '), placeholder: 'candidate' })),
        h('label', { class: 'field' }, h('span', {}, 'Set status'), h('input', { type: 'text', name: 'leadStatus', value: a.leadStatus || '', placeholder: 'new' })),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'saveMedia', checked: !!a.saveMedia }), h('span', {}, 'Save the file they sent')),
        h('label', { class: 'field' }, h('span', {}, 'Add a task to the board'), h('input', { type: 'text', name: 'createTask', value: a.createTask || '', placeholder: 'Review resume from {name}' })),
        h('label', { class: 'field' }, h('span', {}, 'Auto-reply with template (once per person per day)'), h('select', { name: 'replyTemplate' }, h('option', { value: '' }, '— no auto-reply —'), tpls.map((t) => h('option', { value: t.name, selected: t.name === a.replyTemplate }, t.name)))),
        h('label', { class: 'field' }, h('span', {}, 'Remind me about the chat after (days, optional)'), h('input', { type: 'number', name: 'snoozeDays', min: 0, value: a.snoozeDays || '' })),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: r.enabled !== false }), h('span', {}, 'Rule is on')),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save rule'),
          r.id ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (!confirm(`Delete rule "${r.name}"?`)) return; await api(`/api/rules/${r.id}`, { method: 'DELETE' }); viewRules(); }) }, 'Delete') : null),
      );
    };
    const editor = h('div', {}, form());
    shell([
      h('h1', {}, 'Rules'),
      h('p', { class: 'sub' }, 'Automatic actions when messages arrive, per number. Auto-replies use your delay settings and go out without approval (you set them up).'),
      h('div', { class: 'settings-grid' },
        h('div', { class: 'card' }, h('h2', {}, `Rules (${rows.length})`),
          rows.length ? rows.map((r) => h('div', { style: 'border-top:1px solid var(--line);padding:8px 0' },
            h('div', { class: 'row' }, h('b', { class: 'grow' }, r.name), h('span', { class: 'tag' }, label(r.account_id)), h('span', { class: 'tag' }, r.enabled ? 'on' : 'off'),
              h('button', { class: 'btn small', onclick: () => fill(editor, form(r)) }, 'Edit')),
            h('div', { class: 'muted', style: 'font-size:13px' }, describe(r), ` · ran ${r.runs}×`))) : h('p', { class: 'muted' }, 'No rules yet.')),
        editor),
    ]);
  }

  // ---------- outbox ----------
  // Meta error codes → meaning + what to do (loaded once)
  async function metaHelpTable() {
    if (!state.metaHelp) state.metaHelp = await api('/api/meta-errors').catch(() => ({}));
    return state.metaHelp;
  }
  const errorBox = (err, help) => {
    if (!err) return null;
    const code = String(err).match(/\(Meta (\d+)/)?.[1];
    const todo = code && help?.[code]?.todo;
    const retrying = /retrying automatically/.test(err);
    return h('div', { style: `margin:6px 0;padding:6px 8px;border-radius:8px;background:${retrying ? 'var(--accent-soft)' : 'var(--bad-soft)'}` },
      h('div', { style: `color:${retrying ? 'inherit' : 'var(--bad)'};font-size:13px` }, retrying ? '🔁 ' : '⚠️ ', err),
      todo ? h('div', { style: 'font-size:12px;margin-top:3px' }, h('b', {}, 'What to do: '), todo) : null);
  };
  async function viewOutbox() {
    const tab = state.outboxTab || 'draft';
    if (!state.accounts.length) await loadAccounts();
    const help = await metaHelpTable();
    const acc = state.outboxAccount || '';
    const rows = await api(`/api/outbox?limit=200${tab === 'all' ? '' : `&status=${tab}`}${state.outboxTask ? `&task=${state.outboxTask}` : ''}${acc ? `&account=${encodeURIComponent(acc)}` : ''}`);
    const labelOf = (id) => state.accounts.find((a) => a.id === id)?.label || id;
    const numberPick = h('div', { class: 'seg', style: 'max-width:640px;margin-bottom:10px' },
      [['', 'All numbers'], ...state.accounts.map((a) => [a.id, `${a.label}${a.phone ? ' · +' + a.phone : ''}`])].map(([k, l]) =>
        h('button', { class: acc === k ? 'on' : '', onclick: () => { state.outboxAccount = k; viewOutbox(); } }, l)));
    const tabs = h('div', { class: 'seg', style: 'max-width:520px;margin-bottom:16px' },
      [['draft', 'Drafts'], ['queued', 'Queued'], ['sent', 'Sent'], ['failed,rejected', 'Failed / rejected'], ['all', 'All']].map(([k, l]) =>
        h('button', { class: tab === k ? 'on' : '', onclick: () => { state.outboxTab = k; viewOutbox(); } }, l)));
    // Selection: tick messages (or "Select all"), then move them to another number, approve or reject them.
    const movable = (r) => r.status === 'draft' || r.status === 'queued';
    const sel = new Set();
    const boxes = [];
    const selInfo = h('b', {}, '0 selected');
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
    const refreshSel = () => {
      selInfo.textContent = `${sel.size} selected`;
      allBox.checked = sel.size > 0 && sel.size === boxes.length;
      allBox.indeterminate = sel.size > 0 && sel.size < boxes.length;
    };
    allBox.onchange = () => {
      for (const [cb, id] of boxes) { cb.checked = allBox.checked; if (allBox.checked) sel.add(id); else sel.delete(id); }
      refreshSel();
    };
    const accountOptions = (current) => state.accounts.map((a) => h('option', { value: a.id, selected: a.id === current },
      `${a.label}${a.phone ? ' · +' + a.phone : ''}${a.status === 'open' ? '' : a.status === 'qr' ? ' (not linked yet)' : ' (not connected)'}`));
    const limitOf = (id) => {
      const a = state.accounts.find((x) => x.id === id);
      return Math.min(a?.settings?.dailyCap ?? 35, a?.settings?.newChatsPer24h ?? 42) || 1;
    };
    const costText = (list) => {
      const total = list.reduce((a, r) => a + (r.price || 0), 0);
      return total > 0 ? `\n\nMeta cost: ${money(total, list[0]?.currency)} for these ${list.length} (${list.filter((r) => r.price).length} paid).` : '\n\nCost: free.';
    };
    const paceText = (list) => {
      const per = {};
      for (const r of list) per[r.account_id] = (per[r.account_id] || 0) + 1;
      return Object.entries(per).map(([id, n]) => `${labelOf(id)}: ${n} messages, at most ${limitOf(id)} a day → about ${Math.ceil(n / limitOf(id))} day${n > limitOf(id) ? 's' : ''}`).join('\n');
    };
    const moveTo = async (ids, to) => {
      const r = await api('/api/outbox/move', { body: { ids, account: to } });
      toast(r.moved ? `Moved ${r.moved} to ${r.toLabel}${r.approved ? ` — ${r.approved} go out from there by themselves` : ''}${r.drafts ? ` — ${r.drafts} drafts still need your approval` : ''}${r.kept ? ` — ${r.kept} stayed: a Meta API number can only send them a template` : ''}` : 'Nothing to move: they are already on that number');
      viewOutbox();
    };
    const items = rows.map((r) => {
      const ta = h('textarea', { rows: 3, value: r.payload.text || r.payload.attachment?.caption || '', readonly: !!r.payload.waTemplate,
        title: r.payload.waTemplate ? 'Meta template wording is fixed by Meta' : undefined });
      let cb = null;
      if (movable(r)) {
        cb = h('input', { type: 'checkbox', 'aria-label': `Select ${r.to_name || r.to_jid.split('@')[0]}`, onchange: (e) => { if (e.target.checked) sel.add(r.id); else sel.delete(r.id); refreshSel(); } });
        boxes.push([cb, r.id]);
      }
      const from = movable(r) && state.accounts.length > 1
        ? h('select', { class: 'tag', title: 'Number that sends this message', style: 'width:auto;padding:2px 6px', onchange: guard(async (e) => {
            if (!confirm(`Send this message from "${labelOf(e.target.value)}" instead?${r.status === 'queued' ? ' It is already approved and will go out from there by itself.' : ' It stays a draft until you approve it.'}`)) { e.target.value = r.account_id; return; }
            await moveTo([r.id], e.target.value);
          }) }, accountOptions(r.account_id))
        : h('span', { class: 'tag', title: 'Sent from this number' }, 'From: ' + labelOf(r.account_id));
      return h('div', { class: 'card' },
        h('div', { class: 'row', style: 'align-items:center' },
          cb,
          h('b', { class: 'grow' }, r.to_name || '+' + r.to_jid.split('@')[0]),
          from, h('span', { class: 'tag' }, { mcp: 'AI', campaign: 'bulk', api: 'script', dashboard: 'you' }[r.source] || r.source), h('span', { class: 'muted' }, new Date(r.created_at).toLocaleString()),
          h('span', { class: 'muted', style: 'font-size:12px;white-space:nowrap', title: r.price_note || '' }, r.price ? money(r.price, r.currency) : (r.price_category === 'free' ? 'free' : money(0, r.currency)))),
        r.note ? h('p', { class: 'muted', style: 'margin:6px 0' }, 'Why: ', r.note) : null,
        r.payload.waTemplate ? h('p', { style: 'margin:6px 0' }, h('span', { class: 'tag' }, `Meta template: ${r.payload.waTemplate.name}`)) : null,
        r.preview_image ? h('a', { href: r.preview_image.startsWith('data:') ? undefined : r.preview_image, target: '_blank', rel: 'noopener', title: 'Image the person will receive' },
          h('img', { src: r.preview_image, alt: 'Image in this message', loading: 'lazy', style: 'display:block;max-width:100%;max-height:220px;border-radius:8px;margin:6px 0;object-fit:contain;background:#111' })) : null,
        r.payload.attachment ? h('p', { class: 'muted', style: 'margin:6px 0' }, '📎 ', r.payload.attachment.fileName || r.payload.attachment.url || 'file') : null,
        r.status === 'draft'
          ? h('div', {}, ta, h('div', { class: 'row', style: 'margin-top:8px' },
              h('button', { class: 'btn primary small', onclick: guard(async () => { await api(`/api/outbox/${r.id}/approve`, { body: r.payload.waTemplate ? {} : { text: ta.value } }); toast('Approved — queued'); viewOutbox(); }) }, 'Approve & send'),
              h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/outbox/${r.id}/reject`, { method: 'POST' }); viewOutbox(); }) }, 'Reject')))
          : h('div', {}, h('p', { style: 'white-space:pre-wrap;margin:6px 0' }, r.payload.text || r.payload.attachment?.caption || ''),
              errorBox(r.error, help),
              r.status === 'queued' ? h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/outbox/${r.id}/reject`, { method: 'POST' }); viewOutbox(); }) }, 'Cancel') : null,
              r.sent_at ? h('p', { class: 'muted', style: 'margin:0' }, 'Sent ', new Date(r.sent_at).toLocaleString()) : null),
      );
    });
    const picked = () => rows.filter((r) => sel.has(r.id));
    const moveSel = h('select', { style: 'width:auto' }, h('option', { value: '' }, 'Send from…'), accountOptions(''));
    const bar = boxes.length ? h('div', { class: 'card', style: 'max-width:820px;margin-bottom:16px' },
      h('div', { class: 'row', style: 'align-items:center;flex-wrap:wrap;gap:8px' },
        h('label', { class: 'row', style: 'align-items:center;gap:6px;margin:0' }, allBox, h('span', {}, `Select all ${boxes.length}${rows.length >= 200 ? ' shown' : ''}`)),
        selInfo,
        h('span', { class: 'grow' }),
        state.accounts.length > 1 ? moveSel : null,
        state.accounts.length > 1 ? h('button', { class: 'btn small', onclick: guard(async () => {
          if (!sel.size) return toast('Tick the messages first');
          if (!moveSel.value) return toast('Choose the number that should send them');
          const toMove = picked().filter((r) => r.account_id !== moveSel.value);
          if (!toMove.length) return toast(`They are already on ${labelOf(moveSel.value)}`);
          const nApproved = toMove.filter((r) => r.status === 'queued').length;
          if (!confirm(`Move ${toMove.length} messages to "${labelOf(moveSel.value)}"?${sel.size > toMove.length ? ` (${sel.size - toMove.length} ticked are already there.)` : ''}

${nApproved ? `${nApproved} already approved: they go out from ${labelOf(moveSel.value)} by themselves, within its limits.
` : ''}${toMove.length - nApproved ? `${toMove.length - nApproved} drafts: they still need your approval.` : ''}`)) return;
          await moveTo(toMove.map((r) => r.id), moveSel.value);
        }) }, 'Move selected') : null,
        rows.some((r) => r.status === 'draft') ? h('button', { class: 'btn small primary', onclick: guard(async () => {
          const list = picked().filter((r) => r.status === 'draft');
          if (!list.length) {
            return toast(sel.size ? 'Those are already approved: queued messages go out by themselves, one by one. Only drafts need approving.' : 'Tick the drafts you want to approve first');
          }
          if (!confirm(`Approve and send ${list.length} selected drafts as they are?\n\n${paceText(list)}${costText(list)}\n\nThey go out one by one with the random gap, the daily limit and the new-number limit.`)) return;
          const r = await api('/api/outbox/approve-selected', { body: { ids: list.map((x) => x.id) } });
          toast(`Approved ${r.approved} — queued`);
          viewOutbox();
        }) }, 'Approve selected') : null,
        h('button', { class: 'btn small danger', onclick: guard(async () => {
          if (!sel.size) return toast('Tick the messages first');
          if (!confirm(`${tab === 'queued' ? 'Cancel' : 'Reject'} ${sel.size} selected messages? They will not be sent.`)) return;
          const r = await api('/api/outbox/reject-selected', { body: { ids: [...sel] } });
          toast(`${tab === 'queued' ? 'Cancelled' : 'Rejected'} ${r.rejected}`);
          viewOutbox();
        }) }, tab === 'queued' ? 'Cancel selected' : 'Reject selected')),
      h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' }, tab === 'queued'
        ? 'Queued messages are already approved and go out by themselves, one at a time. Tick some (or Select all, then untick a few) to move them to another number or cancel them.'
        : 'Tick messages (or Select all, then untick a few). Move selected changes which number sends them, e.g. when a number is blocked.')) : null;
    const drafts = rows.filter((r) => r.status === 'draft');
    const approveAllBar = drafts.length > 1 ? h('div', { class: 'card row', style: 'max-width:820px;margin-bottom:16px;align-items:center' },
      h('span', { class: 'grow' }, `${drafts.length}${rows.length >= 200 ? '+' : ''} drafts${acc ? ' from ' + labelOf(acc) : ''}${state.outboxTask ? ` in task #${state.outboxTask}` : ''}`),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!confirm(`Approve and send all ${drafts.length} drafts as they are?\n\n${paceText(drafts)}${costText(drafts)}\n\nThey go out one by one with the random gap, the daily limit and the new-number limit. Text you edited below but did not approve is not used.`)) return;
        const r = await api('/api/outbox/approve-all', { body: { account: acc || undefined, task: state.outboxTask || undefined } });
        toast(`Approved ${r.approved} — queued`);
        viewOutbox();
      }) }, `Approve all ${drafts.length}${rows.length >= 200 ? '+' : ''}`)) : null;
    const statuses = await api(`/api/outbox/status${acc ? '?account=' + encodeURIComponent(acc) : ''}`).catch(() => []);
    const when = (t) => (t ? new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    const statusCards = statuses.filter((q) => q.queued || q.drafts).map((q) => h('div', { class: 'card', style: `max-width:820px;margin-bottom:10px;border-left:4px solid ${q.state === 'held' ? 'var(--bad)' : 'var(--accent)'}` },
      h('div', { class: 'row', style: 'align-items:center;flex-wrap:wrap;gap:6px' },
        h('b', { class: 'grow' }, q.label),
        q.drafts ? h('span', { class: 'tag' }, `${q.drafts} drafts to approve`) : null,
        q.queued ? h('span', { class: 'tag' }, `${q.queued} approved, waiting to send`) : null),
      q.queued ? h('p', { style: 'margin:6px 0 0' },
        q.state === 'held' ? h('b', { style: 'color:var(--bad)' }, 'On hold: ') : h('b', {}, 'Sending: '),
        q.state === 'held' ? q.reason : (q.reason ? `${q.reason} (next about ${when(q.until)}). ` : 'next message any moment. '),
        q.state === 'held' && q.until ? ` — continues about ${when(q.until)}.` : '') : null,
      q.queued ? h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px' },
        `One every ${q.gapSec[0]}–${q.gapSec[1]} s · automated ${q.automated24h}/${q.dailyCap} and new numbers ${q.newChats.count}/${q.newChats.limit} in the last 24 h · at most ${q.perDay} a day → about ${q.days} day${q.days === 1 ? '' : 's'} for these ${q.queued}.`) : null));
    shell([
      h('h1', {}, 'Drafts & outbox'),
      state.outboxTask ? h('p', {}, `Showing messages of task #${state.outboxTask} · `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.outboxTask = null; viewOutbox(); } }, 'show all')) : null,
      h('p', { class: 'sub' }, 'Messages written by AI or campaigns wait here when a number is in approval mode. Edit, approve, reject, or move them to another number.'),
      numberPick,
      statusCards,
      tabs,
      approveAllBar,
      bar,
      h('div', { class: 'cards', style: 'grid-template-columns:repeat(auto-fill,minmax(min(380px,100%),1fr))' }, items.length ? items : [h('p', { class: 'muted' }, 'Nothing here.')]),
    ]);
  }

  // ---------- settings ----------
  // "All numbers" = the defaults every number follows, except settings a number has changed itself (marked "own").
  const SETTING_LABEL = { aiMode: 'Approval', delayMinSec: 'Delay from', delayMaxSec: 'Delay to', typing: 'Typing', anytime: 'Any time', dailyCap: 'Automated per 24 h',
    newChatsPer24h: 'New numbers per 24 h', sendStart: 'Send from', sendEnd: 'Send until', sendDays: 'Days', followupStart: 'Follow-ups from', followupDailyMax: 'Follow-ups per day',
    storeGroups: 'Store groups', autosaveImages: 'Save images', autosaveDocuments: 'Save documents', autosaveKnownOnly: 'Only known people', autosaveMaxMb: 'Max file size',
    optOutWords: 'Opt-out words', webhookUrl: 'Notify URL' };
  async function viewSettings() {
    await loadAccounts();
    const [pb, al, pr, dflt] = await Promise.all([
      api('/api/playbook').catch(() => ({ text: '' })),
      api('/api/alerts').catch(() => ({ phones: [] })),
      api('/api/pricing').catch(() => null),
      api('/api/settings/defaults').catch(() => null),
    ]);
    if (!state.accounts.length) return shell([h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Add a number first.')]);
    const allMode = state.settingsFor === '*' && dflt;
    const id = allMode ? '*' : state.settingsFor && state.accounts.find((a) => a.id === state.settingsFor) ? state.settingsFor : state.accounts[0].id;
    state.settingsFor = id;
    const a = allMode ? null : state.accounts.find((x) => x.id === id);
    const s = allMode ? dflt.defaults : a.settings;
    const own = allMode ? [] : dflt?.numbers.find((n) => n.id === id)?.own || [];
    const ownTag = (name) => (own.includes(name) ? h('span', { class: 'tag own', title: 'This number has its own value — the all-numbers setting does not change it' }, 'own') : null);
    const f = (name, label, input, hint) => h('label', { class: 'field' }, h('span', {}, label, ' ', ownTag(name)), input, hint ? h('em', {}, hint) : null);
    const sw = (name, label, hint) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', name, checked: s[name] }), h('span', {}, label, ' ', ownTag(name), hint ? h('em', {}, hint) : null));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const cloud = !allMode && a.provider === 'cloud';
    const collect = (fd) => ({
      aiMode: fd.aiMode.value,
      delayMinSec: +fd.delayMinSec.value,
      delayMaxSec: +fd.delayMaxSec.value,
      typing: fd.typing.checked,
      anytime: fd.anytime.checked,
      dailyCap: +fd.dailyCap.value,
      newChatsPer24h: +fd.newChatsPer24h.value,
      followupStart: fd.followupStart.value,
      followupDailyMax: +fd.followupDailyMax.value,
      sendStart: fd.sendStart.value,
      sendEnd: fd.sendEnd.value,
      sendDays: [...fd.querySelectorAll('input[name=day]:checked')].map((i) => +i.value),
      storeGroups: fd.storeGroups.checked,
      autosaveImages: fd.autosaveImages.checked,
      autosaveDocuments: fd.autosaveDocuments.checked,
      autosaveKnownOnly: fd.autosaveKnownOnly.checked,
      autosaveMaxMb: +fd.autosaveMaxMb.value,
      optOutWords: fd.optOutWords.value,
      webhookUrl: fd.webhookUrl.value.trim(),
    });
    const form = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const fd = e.target;
      if (allMode) {
        const r = await api('/api/settings/defaults', { method: 'PUT', body: collect(fd) });
        const changed = r.numbers.filter((n) => n.changed.length).map((n) => n.label);
        const kept = r.numbers.filter((n) => n.own.length).map((n) => n.label);
        toast(`Saved for all numbers${changed.length ? ' — updated ' + changed.join(', ') : ''}${kept.length ? '. Own values kept on ' + kept.join(', ') : ''}`);
      } else {
        await api(`/api/accounts/${id}`, { method: 'PATCH', body: { label: fd.label.value, purpose: fd.purpose.value, enabled: fd.enabled.checked, settings: collect(fd) } });
        toast('Settings saved');
      }
      viewSettings();
    }) },
      h('div', { class: 'settings-grid' },
        allMode ? null : h('div', { class: 'card' },
          h('h2', {}, '📱 Number'),
          f('label', 'Name', h('input', { type: 'text', name: 'label', value: a.label })),
          f('purpose', 'Purpose', h('input', { type: 'text', name: 'purpose', value: a.purpose }), 'AI agents read this to understand what the number is for.'),
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: a.enabled }), h('span', {}, 'Active', h('em', {}, 'Turn off to pause this number completely (stays linked).'))),
          own.length
            ? h('div', {}, h('p', { class: 'muted', style: 'font-size:12px;margin:4px 0' }, `Own values: ${own.map((k) => SETTING_LABEL[k] || k).join(', ')}. Everything else follows "All numbers".`),
                h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
                  if (!confirm(`Use the all-numbers settings for everything on ${a.label}? Its own values (${own.map((k) => SETTING_LABEL[k] || k).join(', ')}) are replaced.`)) return;
                  await api(`/api/accounts/${id}/settings/reset`, { method: 'POST' });
                  toast('Now follows the all-numbers settings');
                  viewSettings();
                }) }, '↺ Use all-numbers settings'))
            : h('p', { class: 'muted', style: 'font-size:12px' }, 'Follows the all-numbers settings for everything.'),
        ),
        h('div', { class: 'card' },
          h('h2', {}, '📤 Sending'),
          h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'aiMode', value: 'approve', checked: s.aiMode !== 'auto' }), h('span', {}, 'Drafts for my approval ', ownTag('aiMode'), h('em', {}, 'AI and campaign messages wait in Drafts until you approve.'))),
          h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'aiMode', value: 'auto', checked: s.aiMode === 'auto' }), h('span', {}, 'Send automatically', h('em', {}, 'Still follows the delay, daily limit and hours below.'))),
          cloud
            ? f('newChatsPer24h', 'New numbers per 24 hours', h('input', { type: 'number', name: 'newChatsPer24h', min: 0, max: 1000, value: s.newChatsPer24h }), 'Meta number: Meta allows 250 new people a day now (more after verification).')
            : f('newChatsPer24h', 'New numbers per 24 hours (safety limit)', h('input', { type: 'number', name: 'newChatsPer24h', min: 0, max: 45, value: s.newChatsPer24h }), 'Hard maximum 45 for linked phones (a number was blocked by WhatsApp after 48 in one day).'),
          f('dailyCap', 'Automated messages per 24 hours', h('input', { type: 'number', name: 'dailyCap', min: 0, value: s.dailyCap }), '0 pauses all automated sending. Your own sends are not counted.'),
          sw('anytime', 'Send at any time', 'Day and night, every day. Turn off to use the hours below.'),
          h('details', { class: 'fold' }, h('summary', {}, 'Delay, hours, days, follow-ups'),
            h('div', { class: 'row', style: 'margin-top:8px' },
              f('delayMinSec', 'Random delay from (sec)', h('input', { type: 'number', name: 'delayMinSec', min: 5, value: s.delayMinSec })),
              f('delayMaxSec', 'to (sec)', h('input', { type: 'number', name: 'delayMaxSec', min: 5, value: s.delayMaxSec }))),
            sw('typing', 'Show "typing…" before each message'),
            h('div', { class: 'row' },
              f('sendStart', 'Send between', h('input', { type: 'time', name: 'sendStart', value: s.sendStart })),
              f('sendEnd', 'and', h('input', { type: 'time', name: 'sendEnd', value: s.sendEnd }))),
            h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:550;margin-bottom:4px' }, 'On these days ', ownTag('sendDays')),
              h('div', { class: 'daypick' }, days.map((d, i) => h('label', {}, h('input', { type: 'checkbox', name: 'day', value: i, checked: s.sendDays.includes(i) }), d)))),
            h('div', { class: 'row' },
              f('followupStart', 'Follow-ups not before', h('input', { type: 'time', name: 'followupStart', value: s.followupStart })),
              f('followupDailyMax', 'Follow-ups per day (max)', h('input', { type: 'number', name: 'followupDailyMax', min: 0, value: s.followupDailyMax }))),
            h('p', { class: 'muted', style: 'font-size:12px' }, 'Follow-ups to people who never replied go out only on days with no first messages to new people, after this time.')),
        ),
        h('details', { class: 'card fold' }, h('summary', {}, h('b', {}, '🗂 History & media')),
          sw('storeGroups', 'Store group chats', 'Needed to read lead groups.'),
          sw('autosaveDocuments', 'Auto-save PDFs & documents'),
          sw('autosaveImages', 'Auto-save images'),
          sw('autosaveKnownOnly', 'Only from people I have chatted with', 'Skips brochures and ads from businesses that message you out of the blue.'),
          f('autosaveMaxMb', 'Max file size to auto-save (MB)', h('input', { type: 'number', name: 'autosaveMaxMb', min: 1, max: 50, value: s.autosaveMaxMb }))),
        h('details', { class: 'card fold' }, h('summary', {}, h('b', {}, '🔗 Replies & integrations')),
          f('optOutWords', 'Opt-out words', h('input', { type: 'text', name: 'optOutWords', value: s.optOutWords.join(', ') }), 'A reply containing one of these tags the contact "opted-out"; campaigns skip them.'),
          f('webhookUrl', 'Notify URL for new messages (optional)', h('input', { type: 'url', name: 'webhookUrl', value: s.webhookUrl, placeholder: 'https://script.google.com/macros/s/…/exec' }), 'Each incoming message is POSTed here as JSON.')),
      ),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'submit' }, allMode ? 'Save for all numbers' : `Save for ${a.label}`)),
    );
    const followers = allMode && dflt
      ? h('div', { class: 'card', style: 'margin-bottom:12px' },
          dflt.numbers.map((n) => h('div', { style: 'font-size:13px;margin:2px 0' }, h('b', {}, n.label), ': ',
            n.own.length ? h('span', { class: 'muted' }, `follows these, except its own ${n.own.map((k) => SETTING_LABEL[k] || k).join(', ')}`) : h('span', { class: 'muted' }, 'follows all of these'))))
      : null;
    const fold = (title, body) => h('details', { class: 'section' }, h('summary', {}, h('span', { class: 'sec-title' }, title)), body);
    const alertForm = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const r = await api('/api/alerts', { method: 'PUT', body: { phones: e.target.phones.value } });
      toast(r.phones.length ? 'Alerts go to ' + r.phones.map((p) => '+' + p).join(', ') : 'Alerts off');
    }) },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'A WhatsApp (from another connected number) when a number is logged out or offline for 15+ minutes. Use a personal number that is not one of the hub numbers.'),
      h('div', { class: 'row' }, h('input', { type: 'text', name: 'phones', class: 'grow', style: 'width:auto', value: al.phones.join(', '), placeholder: '9198…, comma separated' }), h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    const priceForm = !pr || !state.accounts.some((x) => x.provider === 'cloud') ? null : h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const x = e.target;
      await api('/api/pricing', { method: 'PUT', body: { marketing: x.marketing.value, utility: x.utility.value, authentication: x.authentication.value, service: x.service.value, serviceFreePerMonth: x.free.value } });
      toast('Prices saved — drafts and estimates use them now');
    }) },
      h('p', { class: 'muted', style: 'margin-top:0' }, `Per delivered message, ${pr.currency}. Used for costs on drafts and before sending from a Meta number. Check `,
        h('a', { href: 'https://business.whatsapp.com/products/platform-pricing#rates', target: '_blank', rel: 'noopener' }, 'Meta\'s rate card'), '.'),
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        ...[['marketing', 'Marketing template'], ['utility', 'Utility template'], ['authentication', 'Authentication template'], ['service', 'Reply after the free allowance']].map(([k, l]) =>
          h('label', { class: 'field', style: 'min-width:150px' }, h('span', {}, l), h('input', { type: 'number', name: k, step: '0.0001', min: 0, value: pr[k] }))),
        h('label', { class: 'field', style: 'min-width:150px' }, h('span', {}, 'Free replies per number / month'), h('input', { type: 'number', name: 'free', min: 0, value: pr.serviceFreePerMonth }))),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save prices'));
    const playbookForm = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      await api('/api/playbook', { method: 'PUT', body: { text: e.target.text.value } });
      toast('Playbook saved — every AI using the hub now follows it');
    }) },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Sent to every AI that connects to the hub (Claude Code, regular Claude, others). Write your rules in plain words.'),
      h('textarea', { name: 'text', rows: 16, value: pb.text || '' }),
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save playbook')));
    shell([
      h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h1', { class: 'grow', style: 'margin:0' }, '⚙️ Settings'),
        h('select', { style: 'max-width:300px', 'aria-label': 'Settings for', onchange: (e) => { state.settingsFor = e.target.value; viewSettings(); } },
          dflt ? h('option', { value: '*', selected: allMode }, '⭐ All numbers (defaults)') : null,
          state.accounts.map((x) => h('option', { value: x.id, selected: x.id === id }, `📱 ${x.label}`)))),
      h('p', { class: 'sub' }, allMode ? 'These apply to every number, except a setting a number has changed itself (marked "own" on that number).' : `Settings for ${a.label}. Values marked "own" differ from the all-numbers settings.`),
      followers,
      form,
      h('div', { style: 'margin-top:20px' },
        fold('🔔 Connection alerts', alertForm),
        priceForm ? fold('💰 Meta message prices', priceForm) : null,
        fold('📘 Playbook (your rules for the AI)', playbookForm),
        allMode ? null : fold('🗑 Delete this number', h('div', {},
          h('p', { class: 'muted' }, 'Unlinks it and deletes all stored chats, contacts and messages for it. Cannot be undone.'),
          h('button', { class: 'btn danger', onclick: guard(async () => {
            const typed = prompt(`Type "${id}" to delete ${a.label} and all its stored data`);
            if (typed !== id) return;
            await api(`/api/accounts/${id}?confirm=${encodeURIComponent(id)}`, { method: 'DELETE' });
            state.settingsFor = null;
            location.hash = 'accounts';
          }) }, 'Delete number and data')))),
    ]);
  }

  // ---------- connect ----------
  async function viewConnect() {
    await loadAccounts();
    const base = location.origin;
    const code = (t) => h('pre', { class: 'mono card', style: 'white-space:pre-wrap;margin:8px 0 16px' }, t);
    shell([
      h('h1', {}, 'Connect AI & apps'),
      h('p', { class: 'sub' }, 'Replace YOUR_API_KEY with the key you log in with. Account ids: ' + (state.accounts.map((a) => a.id).join(', ') || 'none yet') + '.'),
      h('h2', {}, 'Claude Code (MCP)'),
      code(`claude mcp add --transport http --scope user whatsapp ${base}/mcp/YOUR_API_KEY`),
      h('h2', {}, 'Install this dashboard as an app'),
      h('p', { class: 'muted' }, 'PC (Chrome/Edge): click the install icon at the right end of the address bar, or menu ⋮ → Cast, save and share → Install page as app. Phone: Chrome menu ⋮ → Add to Home screen (iPhone Safari: Share → Add to Home Screen). It opens in its own window with its own icon.'),
      h('h2', {}, 'claude.ai / Claude Desktop / Claude mobile'),
      h('p', { class: 'muted' }, 'claude.ai → Settings → Connectors → Add custom connector → name "WhatsApp Hub", URL below. It then works in Claude on the web, desktop and phone. The hub sends its playbook (your rules) to Claude automatically.'),
      code(`${base}/mcp/YOUR_API_KEY`),
      h('h2', {}, 'Google Apps Script — send a message'),
      code(`function sendWhatsApp(account, phone, text, fileUrl) {
  var res = UrlFetchApp.fetch('${base}/api/send?key=YOUR_API_KEY', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ account: account, to: phone, text: text,
      attachment: fileUrl ? { url: fileUrl } : undefined })
  });
  return res.getResponseCode() === 200;
}`),
      h('h2', {}, 'Old dental-bot format (drop-in)'),
      h('p', { class: 'muted' }, 'Same body as the current whatsapp-form-bot ({phone, message, imageUrl}); add "account" to pick a number:'),
      code(`${base}/webhook?key=YOUR_API_KEY`),
      h('h2', {}, 'Keep the free Render server awake'),
      h('p', { class: 'muted' }, 'Apps Script → Triggers → time-driven, every 10 minutes:'),
      code(`function keepAwake() { UrlFetchApp.fetch('${base}/health', { muteHttpExceptions: true }); }`),
    ]);
  }

  // ---------- activity ----------
  async function viewActivity() {
    const rows = await api(`/api/events?limit=200${state.actRole ? '&role=' + encodeURIComponent(state.actRole) : ''}`);
    const actRoles = await roleChips(state.actRole, (r) => { state.actRole = r; viewActivity(); });
    shell([
      h('h1', {}, 'Activity'),
      actRoles,
      h('p', { class: 'sub' }, 'What you (dashboard), the AI (MCP), scripts (API key, e.g. Apps Script) and the system did: linking (and the history option chosen), settings changes, approvals, tasks, opt-outs, failures. The AI reads this too.'),
      h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Number'), h('th', {}, 'What'))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { style: 'white-space:nowrap' }, new Date(r.created_at).toLocaleString()),
          h('td', {}, { you: 'You', ai: 'AI', script: 'Script' }[r.actor] || 'System'), h('td', {}, r.account_id || '–'),
          h('td', { style: r.level === 'error' || r.level === 'warn' ? 'color:var(--bad)' : '' }, r.text)))),
      ),
    ]);
  }

  // ---------- routing & live updates ----------
  const views = { lists: viewLists, templates: viewTemplates, rules: viewRules, board: viewBoard, accounts: viewAccounts, inbox: viewInbox, outbox: viewOutbox, settings: viewSettings, connect: viewConnect, activity: viewActivity };
  async function route() {
    state.route = location.hash.slice(1) || 'board';
    state.reloadChats = state.reloadThread = null;
    try {
      await (views[state.route] || viewAccounts)();
    } catch (e) {
      if (e.message !== 'Please log in') toast(e.message);
    }
  }
  let es;
  function live() {
    es?.close();
    es = new EventSource('/api/stream');
    // After a deploy the stream reconnects to the new server: reload once so this tab runs the new dashboard.
    es.onopen = async () => {
      try {
        const h = await (await fetch('/health')).json();
        if (window.HUB_VERSION && h.version && h.version !== window.HUB_VERSION) location.reload();
      } catch {}
    };
    let t;
    es.addEventListener('account', (e) => {
      const info = JSON.parse(e.data);
      const known = state.accounts.find((a) => a.id === info.id);
      if (known) Object.assign(known, info); // keep the cached list current without reloading it
      drawLink(info);
      if (state.route === 'accounts') {
        clearTimeout(t);
        t = setTimeout(route, 600);
      }
    });
    es.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (state.route === 'inbox' && m.account === state.inbox.account) {
        state.reloadChats?.();
        state.reloadThread?.(m.chat);
      }
    });
  }
  async function boot() {
    try {
      await api('/api/accounts');
    } catch {
      return;
    }
    window.onhashchange = () => { if (linkModal) closeLink(); route(); }; // a link window never stays open over another page
    live();
    route();
  }
  boot();
})();
