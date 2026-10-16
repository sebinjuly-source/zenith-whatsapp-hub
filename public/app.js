/* WhatsApp Hub dashboard — plain JS, no build step. All user/message text is inserted as text, never HTML. */
(() => {
  const root = document.getElementById('root');
  const state = { accounts: [], route: 'accounts', inbox: { account: null, chat: null, kind: 'all', q: '', waiting: false }, draftsCount: 0 };
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
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  async function api(path, opts = {}) {
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
  const statusText = { open: 'Connected', qr: 'Waiting for scan', connecting: 'Connecting…', stopped: 'Not linked', logged_out: 'Logged out', replaced: 'Running elsewhere', elsewhere: 'Running on another server' };
  const nice = (n) => (n == null ? '–' : Number(n).toLocaleString());
  const guard = (fn) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      toast(e.message);
    }
  };

  // ---------- shell ----------
  function shell(content, { flush = false } = {}) {
    const link = (r, label, extra) =>
      h('a', { href: '#' + r, class: state.route === r ? 'active' : '' }, label, extra || '');
    root.replaceChildren(
      h('div', { class: 'app' },
        h('nav', { class: 'nav', 'aria-label': 'Main' },
          h('div', { class: 'brand' }, 'WhatsApp Hub', h('small', {}, 'Zenith')),
          link('accounts', 'Numbers'),
          link('inbox', 'Inbox'),
          link('outbox', 'Drafts & outbox', state.draftsCount ? h('span', { class: 'badge' }, state.draftsCount) : null),
          link('settings', 'Settings'),
          link('connect', 'Connect AI & apps'),
          link('activity', 'Activity'),
          h('div', { class: 'spacer' }),
          h('a', { href: '#', onclick: guard(async (e) => { e.preventDefault(); await api('/logout', { method: 'POST' }); renderLogin(); }) }, 'Log out'),
        ),
        h('main', { class: flush ? 'flush' : '' }, content),
      ),
    );
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
  async function loadAccounts() {
    state.accounts = await api('/api/accounts');
    const drafts = await api('/api/outbox?status=draft&limit=200');
    state.draftsCount = drafts.length;
  }

  function syncView(a) {
    const s = a.sync || {};
    if (!s.chunks) return h('span', { class: 'muted' }, a.status === 'open' ? 'Waiting for history from the phone…' : 'Starts when linked');
    const done = s.state === 'done';
    const pct = done ? 100 : Math.max(3, Math.min(99, s.progress || 0));
    return h('div', {},
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' },
        `${done ? 'Full history synced' : `Syncing (${s.lastType || '…'})`} · ${nice(s.messages)} messages · ${nice(s.chats)} chats`),
    );
  }

  function accountCard(a) {
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
        h('dt', {}, 'History'), h('dd', {}, syncView(a)),
      ),
      h('div', { class: 'row' },
        a.status === 'open'
          ? h('button', { class: 'btn small', onclick: () => { state.inbox.account = a.id; location.hash = 'inbox'; } }, 'Open inbox')
          : h('button', { class: 'btn small primary', onclick: () => openLink(a) }, a.status === 'qr' ? 'Show QR' : 'Link number'),
        h('button', { class: 'btn small', onclick: () => { state.settingsFor = a.id; location.hash = 'settings'; } }, 'Settings'),
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
    await loadAccounts();
    const form = h('form', { class: 'card', onsubmit: guard(async (e) => {
      e.preventDefault();
      const f = e.target;
      const acc = await api('/api/accounts', { body: { id: f.id.value, label: f.label.value || f.id.value, purpose: f.purpose.value } });
      toast(`Added "${acc.label}". Now link it.`);
      await route();
      openLink({ ...acc, status: 'stopped' });
    }) },
      h('h2', {}, 'Add a number'),
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
    linkModal = { id: a.id, el: back, body };
    drawLink(a);
    if (a.status !== 'qr' && a.status !== 'open') startLink(a.id);
  }
  function closeLink() {
    linkModal?.el.remove();
    linkModal = null;
  }
  const startLink = guard(async (id, pairPhone) => {
    await api(`/api/accounts/${id}/link`, { body: pairPhone ? { pairPhone } : {} });
  });
  function drawLink(info) {
    if (!linkModal || info.id !== linkModal.id) return;
    const b = linkModal.body;
    if (info.status === 'open') {
      b.replaceChildren(
        h('p', {}, `Linked as +${info.phone}. Chat history is now downloading — keep the phone online with WhatsApp open until the Numbers page shows "Full history synced". This can take a while for big accounts.`),
      );
      return;
    }
    const steps = h('ol', { class: 'steps' },
      h('li', {}, 'On the phone open WhatsApp → Settings (or ⋮) → Linked devices → Link a device.'),
      h('li', {}, 'Scan this code. Keep the phone online until history finishes syncing.'),
    );
    const qr = info.qr ? h('img', { src: info.qr, alt: 'WhatsApp QR code' }) : h('span', { class: 'muted' }, info.status === 'stopped' ? 'QR expired.' : 'Generating QR…');
    const pairForm = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); startLink(info.id, e.target.phone.value); } },
      h('input', { type: 'text', name: 'phone', placeholder: 'Number with country code, e.g. 919876543210', class: 'grow', style: 'width:auto' }),
      h('button', { class: 'btn', type: 'submit' }, 'Get code'),
    );
    fill(b,
      steps,
      h('div', { class: 'qrbox' }, qr),
      info.status === 'stopped' ? h('button', { class: 'btn primary', onclick: () => startLink(info.id) }, 'New QR code') : null,
      info.pairingCode
        ? h('div', {}, h('p', {}, 'Or on the phone tap "Link with phone number instead" and enter:'), h('div', { class: 'code' }, info.pairingCode))
        : h('details', {}, h('summary', {}, 'Linking on the same phone? Use a pairing code instead'), h('p', { class: 'muted' }, 'Enter the number being linked; a code will appear here to type into WhatsApp.'), pairForm),
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
    const markSeg = () => [...segEl.children].forEach((b, i) => b.classList.toggle('on', ['all', 'direct', 'group'][i] === ib.kind));
    let qTimer;
    const side = h('aside', { class: 'side' },
      h('div', { class: 'tools' },
        h('select', { 'aria-label': 'Number', onchange: (e) => { ib.account = e.target.value; ib.chat = null; viewInbox(); } },
          accs.map((a) => h('option', { value: a.id, selected: a.id === ib.account }, `${a.label}${a.phone ? ' (+' + a.phone + ')' : ''}`))),
        h('input', { type: 'text', placeholder: 'Search name or number', value: ib.q, 'aria-label': 'Search chats', oninput: (e) => { ib.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(loadChats, 250); } }),
        segEl,
        h('label', { class: 'switch', style: 'margin:0' }, h('input', { type: 'checkbox', checked: ib.waiting, onchange: (e) => { ib.waiting = e.target.checked; loadChats(); } }), h('span', {}, 'Only chats waiting on my reply')),
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
      const chats = await api(`/api/accounts/${ib.account}/chats?${p}`);
      list.replaceChildren(
        ...(chats.length
          ? chats.map((c) =>
              h('div', { class: 'chatitem' + (c.jid === ib.chat ? ' on' : ''), role: 'listitem', tabindex: 0, onclick: () => openChat(c), onkeydown: (e) => e.key === 'Enter' && openChat(c) },
                h('div', { class: 'top' }, h('span', { class: 'name' }, c.is_group ? '👥 ' : '', c.name || c.jid), h('span', { class: 'time' }, fmtShort(c.last_ts))),
                h('div', { class: 'prev' }, c.last_from_me ? 'You: ' : '', c.last_preview || ''),
                c.tags?.length || c.is_blocked ? h('div', {}, c.is_blocked ? h('span', { class: 'tag' }, 'blocked') : null, (c.tags || []).map((t) => h('span', { class: 'tag' }, t))) : null,
              ))
          : [h('div', { class: 'empty' }, 'No chats yet. History appears here as it syncs.')]),
      );
    }

    async function openChat(c) {
      ib.chat = c.jid;
      wrap.classList.add('has-chat');
      [...list.children].forEach((el) => el.classList.remove('on'));
      const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
      let oldest = null;
      const olderBtn = h('button', { class: 'btn small', style: 'align-self:center', onclick: guard(() => loadMsgs(true)) }, 'Load earlier');
      const contactPanel = h('div', { class: 'contactpanel', hidden: true });
      const header = h('header', {},
        h('button', { class: 'btn small', onclick: () => { ib.chat = null; wrap.classList.remove('has-chat'); }, 'aria-label': 'Back to chats' }, '←'),
        h('div', { class: 'who' }, h('b', {}, c.name || c.jid), h('span', { class: 'muted mono' }, c.jid)),
        !c.is_group ? h('button', { class: 'btn small', onclick: () => { contactPanel.hidden = !contactPanel.hidden; if (!contactPanel.hidden) loadContact(); } }, 'Contact') : null,
        h('button', { class: 'btn small', title: 'Ask the phone for older messages', onclick: guard(async () => {
          const r = await api(`/api/accounts/${ib.account}/chats/${encodeURIComponent(c.jid)}/older`, { body: { count: 50 } });
          toast(r.note);
        }) }, 'Fetch older from phone'),
      );
      const fileIn = h('input', { type: 'file', hidden: true });
      const ta = h('textarea', { rows: 1, placeholder: 'Type a message', 'aria-label': 'Message' });
      const fileLabel = h('span', { class: 'muted' });
      fileIn.onchange = () => { fileLabel.textContent = fileIn.files[0]?.name || ''; };
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
          await api('/api/send', { body: { account: ib.account, to: c.jid, text: text || undefined, attachment, source: 'dashboard' } });
          ta.value = '';
          fileIn.value = '';
          fileLabel.textContent = '';
          setTimeout(() => loadMsgs(), 800);
        } finally {
          sendBtn.disabled = false;
        }
      }) },
        h('button', { type: 'button', class: 'btn', onclick: () => fileIn.click(), 'aria-label': 'Attach file' }, '📎'), fileIn,
        h('div', { class: 'grow' }, ta, fileLabel),
      );
      const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
      composer.append(sendBtn);
      thread.replaceChildren(header, h('div', { style: 'display:flex;flex-direction:column;min-height:0' }, contactPanel, msgs), composer);
      thread.style.gridTemplateRows = 'auto 1fr auto';

      async function loadContact() {
        const ct = (await api(`/api/accounts/${ib.account}/contacts/${encodeURIComponent(c.jid)}`)) || {};
        const tags = h('input', { type: 'text', value: (ct.tags || []).join(', '), placeholder: 'candidate, guest, lead-hot' });
        const status = h('input', { type: 'text', value: ct.lead_status || '', placeholder: 'new / contacted / interested / booked…' });
        const notes = h('textarea', { rows: 2, value: ct.notes || '' });
        fill(contactPanel,
          h('div', { class: 'muted' }, `Saved name: ${ct.name || '–'} · WhatsApp name: ${ct.notify || '–'} · ${nice(ct.message_count)} messages since ${fmt(ct.first_ts) || '–'}${ct.is_blocked ? ' · BLOCKED' : ''}`),
          ct.summary ? h('div', {}, h('b', {}, 'AI summary: '), ct.summary) : null,
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
            h('div', { class: 't' }, fmt(m.ts), m.edited ? ' · edited' : '', m.from_me && m.status >= 4 ? ' · read' : m.from_me && m.status === 3 ? ' · delivered' : ''),
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
      state.reloadThread = (chatJid) => chatJid === c.jid && loadMsgs();
      await loadMsgs();
    }

    await loadChats();
    state.reloadChats = loadChats;
  }

  // ---------- outbox ----------
  async function viewOutbox() {
    const tab = state.outboxTab || 'draft';
    const rows = await api(`/api/outbox?status=${tab === 'draft' ? 'draft' : tab}&limit=100`);
    const tabs = h('div', { class: 'seg', style: 'max-width:520px;margin-bottom:16px' },
      [['draft', 'Drafts'], ['queued', 'Queued'], ['sent', 'Sent'], ['failed,rejected', 'Failed / rejected']].map(([k, l]) =>
        h('button', { class: tab === k ? 'on' : '', onclick: () => { state.outboxTab = k; viewOutbox(); } }, l)));
    const items = rows.map((r) => {
      const ta = h('textarea', { rows: 3, value: r.payload.text || r.payload.attachment?.caption || '' });
      return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('b', { class: 'grow' }, r.to_name || '+' + r.to_jid.split('@')[0]),
          h('span', { class: 'tag' }, r.account_id), h('span', { class: 'tag' }, r.source), h('span', { class: 'muted' }, new Date(r.created_at).toLocaleString())),
        r.note ? h('p', { class: 'muted', style: 'margin:6px 0' }, 'Why: ', r.note) : null,
        r.payload.attachment ? h('p', { class: 'muted', style: 'margin:6px 0' }, '📎 ', r.payload.attachment.fileName || r.payload.attachment.url || 'file') : null,
        r.status === 'draft'
          ? h('div', {}, ta, h('div', { class: 'row', style: 'margin-top:8px' },
              h('button', { class: 'btn primary small', onclick: guard(async () => { await api(`/api/outbox/${r.id}/approve`, { body: { text: ta.value } }); toast('Approved — queued'); viewOutbox(); }) }, 'Approve & send'),
              h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/outbox/${r.id}/reject`, { method: 'POST' }); viewOutbox(); }) }, 'Reject')))
          : h('div', {}, h('p', { style: 'white-space:pre-wrap;margin:6px 0' }, r.payload.text || r.payload.attachment?.caption || ''),
              r.error ? h('p', { style: 'color:var(--bad);margin:0' }, r.error) : null,
              r.status === 'queued' ? h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/outbox/${r.id}/reject`, { method: 'POST' }); viewOutbox(); }) }, 'Cancel') : null,
              r.sent_at ? h('p', { class: 'muted', style: 'margin:0' }, 'Sent ', new Date(r.sent_at).toLocaleString()) : null),
      );
    });
    shell([
      h('h1', {}, 'Drafts & outbox'),
      h('p', { class: 'sub' }, 'Messages written by AI or campaigns wait here when a number is in approval mode. Edit, approve or reject.'),
      tabs,
      h('div', { class: 'cards', style: 'grid-template-columns:repeat(auto-fill,minmax(380px,1fr))' }, items.length ? items : [h('p', { class: 'muted' }, 'Nothing here.')]),
    ]);
  }

  // ---------- settings ----------
  async function viewSettings() {
    await loadAccounts();
    if (!state.accounts.length) return shell([h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Add a number first.')]);
    const id = state.settingsFor && state.accounts.find((a) => a.id === state.settingsFor) ? state.settingsFor : state.accounts[0].id;
    state.settingsFor = id;
    const a = state.accounts.find((x) => x.id === id);
    const s = a.settings;
    const f = (name, label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('em', {}, hint) : null);
    const sw = (name, label, hint) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', name, checked: s[name] }), h('span', {}, label, hint ? h('em', {}, hint) : null));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const form = h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const fd = e.target;
      const settings = {
        aiMode: fd.aiMode.value,
        delayMinSec: +fd.delayMinSec.value,
        delayMaxSec: +fd.delayMaxSec.value,
        typing: fd.typing.checked,
        dailyCap: +fd.dailyCap.value,
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
      };
      await api(`/api/accounts/${id}`, { method: 'PATCH', body: { label: fd.label.value, purpose: fd.purpose.value, enabled: fd.enabled.checked, settings } });
      toast('Settings saved');
      viewSettings();
    }) },
      h('div', { class: 'settings-grid' },
        h('div', { class: 'card' },
          h('h2', {}, 'Number'),
          f('label', 'Name', h('input', { type: 'text', name: 'label', value: a.label })),
          f('purpose', 'Purpose', h('input', { type: 'text', name: 'purpose', value: a.purpose }), 'AI agents read this to understand what the number is for.'),
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: a.enabled }), h('span', {}, 'Active', h('em', {}, 'Turn off to pause this number completely (stays linked).'))),
        ),
        h('div', { class: 'card' },
          h('h2', {}, 'AI & campaign sending'),
          h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'aiMode', value: 'approve', checked: s.aiMode !== 'auto' }), h('span', {}, 'Drafts for my approval', h('em', {}, 'AI and campaign messages wait in Drafts until you approve.'))),
          h('label', { class: 'switch' }, h('input', { type: 'radio', name: 'aiMode', value: 'auto', checked: s.aiMode === 'auto' }), h('span', {}, 'Send automatically', h('em', {}, 'Still follows the delay, daily limit and hours below.'))),
          h('div', { class: 'row' },
            f('delayMinSec', 'Random delay from (sec)', h('input', { type: 'number', name: 'delayMinSec', min: 5, value: s.delayMinSec })),
            f('delayMaxSec', 'to (sec)', h('input', { type: 'number', name: 'delayMaxSec', min: 5, value: s.delayMaxSec })),
          ),
          h('p', { class: 'muted', style: 'margin:-6px 0 12px;font-size:12px' }, 'Gap between two automated messages, picked at random in this range. Minimum 5 seconds.'),
          sw('typing', 'Show "typing…" before each message'),
          f('dailyCap', 'Daily limit (automated messages)', h('input', { type: 'number', name: 'dailyCap', min: 0, value: s.dailyCap }), 'Messages you send yourself or from Apps Script are not counted.'),
          h('div', { class: 'row' },
            f('sendStart', 'Send between', h('input', { type: 'time', name: 'sendStart', value: s.sendStart })),
            f('sendEnd', 'and', h('input', { type: 'time', name: 'sendEnd', value: s.sendEnd })),
          ),
          h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:550;margin-bottom:4px' }, 'On these days'),
            h('div', { class: 'daypick' }, days.map((d, i) => h('label', {}, h('input', { type: 'checkbox', name: 'day', value: i, checked: s.sendDays.includes(i) }), d)))),
        ),
        h('div', { class: 'card' },
          h('h2', {}, 'History & media'),
          sw('storeGroups', 'Store group chats', 'Needed to read lead groups.'),
          sw('autosaveDocuments', 'Auto-save PDFs & documents'),
          sw('autosaveImages', 'Auto-save images'),
          sw('autosaveKnownOnly', 'Only from people I have chatted with', 'Skips brochures and ads from businesses that message you out of the blue. Heavily-forwarded files are always skipped.'),
          f('autosaveMaxMb', 'Max file size to auto-save (MB)', h('input', { type: 'number', name: 'autosaveMaxMb', min: 1, max: 50, value: s.autosaveMaxMb })),
          h('p', { class: 'muted', style: 'font-size:12px' }, 'Anything not auto-saved can still be opened or kept later from the chat (or by AI, e.g. a resume).'),
        ),
        h('div', { class: 'card' },
          h('h2', {}, 'Replies & integrations'),
          f('optOutWords', 'Opt-out words', h('input', { type: 'text', name: 'optOutWords', value: s.optOutWords.join(', ') }), 'A reply containing one of these tags the contact "opted-out"; campaigns skip them.'),
          f('webhookUrl', 'Notify URL for new messages (optional)', h('input', { type: 'url', name: 'webhookUrl', value: s.webhookUrl, placeholder: 'https://script.google.com/macros/s/…/exec' }), 'Each incoming message is POSTed here as JSON.'),
        ),
      ),
      h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')),
    );
    shell([
      h('h1', {}, 'Settings'),
      h('p', { class: 'sub' }, 'Each number has its own rules.'),
      h('div', { class: 'row', style: 'margin-bottom:16px' }, h('select', { style: 'max-width:320px', 'aria-label': 'Number', onchange: (e) => { state.settingsFor = e.target.value; viewSettings(); } },
        state.accounts.map((x) => h('option', { value: x.id, selected: x.id === id }, x.label)))),
      form,
      h('div', { class: 'card', style: 'margin-top:24px;border-color:var(--bad-soft)' },
        h('h2', {}, 'Delete this number from the hub'),
        h('p', { class: 'muted' }, 'Unlinks it and deletes all stored chats, contacts and messages for it. Cannot be undone.'),
        h('button', { class: 'btn danger', onclick: guard(async () => {
          const typed = prompt(`Type "${id}" to delete ${a.label} and all its stored data`);
          if (typed !== id) return;
          await api(`/api/accounts/${id}?confirm=${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.settingsFor = null;
          location.hash = 'accounts';
        }) }, 'Delete number and data')),
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
      h('h2', {}, 'claude.ai / Claude Desktop'),
      h('p', { class: 'muted' }, 'Settings → Connectors → Add custom connector → URL:'),
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
    const rows = await api('/api/events?limit=200');
    shell([
      h('h1', {}, 'Activity'),
      h('p', { class: 'sub' }, 'Connections, history sync, opt-outs and send failures.'),
      h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Number'), h('th', {}, 'What'))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { style: 'white-space:nowrap' }, new Date(r.created_at).toLocaleString()), h('td', {}, r.account_id || '–'),
          h('td', { style: r.level === 'error' || r.level === 'warn' ? 'color:var(--bad)' : '' }, r.text)))),
      ),
    ]);
  }

  // ---------- routing & live updates ----------
  const views = { accounts: viewAccounts, inbox: viewInbox, outbox: viewOutbox, settings: viewSettings, connect: viewConnect, activity: viewActivity };
  async function route() {
    state.route = location.hash.slice(1) || 'accounts';
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
    let t;
    es.addEventListener('account', (e) => {
      const info = JSON.parse(e.data);
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
    window.onhashchange = route;
    live();
    route();
  }
  boot();
})();
