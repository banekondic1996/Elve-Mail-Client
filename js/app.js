// js/app.js — Elve Mail v6
// Architecture: download ALL headers + bodies upfront for every folder.
// Opening a message is instant — no server round-trip on click.
'use strict';
const App = (() => {

  const S = {
    account: null, folders: [], unread: {},
    folder: 'INBOX', messages: [], allLoaded: [],
    page: 1, totalPages: 1, totalMsgs: 0,
    activeMsg: null, newestUid: null,
    stats: { fetched:0, deleted:0, dupes:0, scams:0 }, log: [],
    searchMode: false, inApp: false,
    calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
  };

  // ── Boot ──────────────────────────────────────────────────────────────
  function init() {
    Themes.load();
    Rules.load();
    Calendar.load();
    _loadPersisted();
    _wireOverlays();
    _wireApp();
    Notifier.init();
    Vault.hasVault() ? _showUnlock(false) : _showUnlock(true);
  }

  // ── Unlock ────────────────────────────────────────────────────────────
  function _showUnlock(createMode) {
    _showScreen('unlock-screen');
    if (createMode) {
      document.getElementById('unlock-new-wrap')?.classList.remove('hidden');
      const btn = document.getElementById('unlock-btn');
      if (btn) btn.textContent = 'Create Vault';
    }
    const go = async () => {
      const pw = document.getElementById('master-password-input')?.value || '';
      if (!pw) { UI.showErr('unlock-error', 'Enter a password'); return; }
      if (createMode) {
        const pc = document.getElementById('master-confirm-input')?.value || '';
        if (pw !== pc) { UI.showErr('unlock-error', 'Passwords do not match'); return; }
      }
      const r = await Vault.unlock(pw);
      if (!r.ok) { UI.showErr('unlock-error', '⚠ ' + r.error); return; }
      UI.hideErr('unlock-error');
      const accounts = r.accounts || [];
      if (!accounts.length) _showSetup(false); else await _connectAccount(accounts[accounts.length - 1]);
    };
    document.getElementById('unlock-btn').onclick = go;
    document.getElementById('master-password-input').onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  // ── Setup ─────────────────────────────────────────────────────────────
  function _showSetup(showClose) {
    _showScreen('setup-screen');
    const closeBtn = document.getElementById('setup-close-btn');
    if (closeBtn) {
      closeBtn.classList.toggle('hidden', !(showClose && S.inApp));
      if (showClose && S.inApp) closeBtn.onclick = () => _showScreen('app-screen');
    }
    document.querySelectorAll('.ptab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.pform').forEach(f => f.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('pf-' + tab.dataset.p)?.classList.add('active');
      };
    });
    document.getElementById('connect-btn').onclick = _doConnect;
    ['g-pass','y-pass','o-pass','i-pass'].forEach(id => {
      const el = document.getElementById(id); if (el) el.onkeydown = e => { if (e.key === 'Enter') _doConnect(); };
    });
  }

  async function _doConnect() {
    const p = document.querySelector('.ptab.active')?.dataset.p || 'gmail';
    const cfg = _readForm(p); if (!cfg) return;
    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    document.getElementById('cb-text').textContent = 'Connecting…';
    document.getElementById('cb-spin').classList.remove('hidden');
    UI.hideErr('setup-err');
    try {
      await ImapEngine.connect(cfg);
      await Vault.addAccount(cfg);
      await _connectAccount(cfg);
    } catch(err) {
      btn.disabled = false;
      document.getElementById('cb-text').textContent = 'Connect';
      document.getElementById('cb-spin').classList.add('hidden');
      let msg = err.message || 'Connection failed';
      if (/auth|LOGIN|password/i.test(msg)) msg = 'Authentication failed. Check email/password.';
      else if (/ENOTFOUND/i.test(msg)) msg = 'Server not found. Check internet.';
      else if (/timeout/i.test(msg)) msg = 'Connection timed out.';
      UI.showErr('setup-err', '⚠ ' + msg);
    }
  }

  function _readForm(p) {
    const m = {gmail:{e:'g-email',pw:'g-pass'},yahoo:{e:'y-email',pw:'y-pass'},outlook:{e:'o-email',pw:'o-pass'},imap:{e:'i-email',pw:'i-pass',h:'i-host',port:'i-port'}}[p];
    const email = document.getElementById(m.e)?.value.trim();
    const pass  = document.getElementById(m.pw)?.value;
    if (!email || !pass) { UI.showErr('setup-err', 'Enter email and password'); return null; }
    const cfg = { provider:p, email, password:pass };
    if (p === 'imap') { cfg.host = document.getElementById(m.h)?.value.trim(); cfg.port = document.getElementById(m.port)?.value; }
    return cfg;
  }

  // ── Connect account ───────────────────────────────────────────────────
  async function _connectAccount(account) {
    S.account = account; S.inApp = true;
    _showScreen('app-screen');
    _setTxt('account-email',    account.email);
    _setTxt('account-provider', account.provider.toUpperCase() + ' · IMAP');
    _setTxt('account-avatar',   account.email[0].toUpperCase());
    UI.setSync('syncing', 'Connecting…');
    try { await ImapEngine.connect(account); } catch(e) {}

    UI.setSync('syncing', 'Loading folders…');
    document.getElementById('folder-nav').innerHTML = '<div class="folders-loading">Loading…</div>';
    try { S.folders = await ImapEngine.listFolders(); }
    catch(e) { S.folders = [{path:'INBOX',name:'Inbox',special:'inbox'},{path:'Sent',name:'Sent',special:'sent'},{path:'Trash',name:'Trash',special:'trash'}]; }
    _renderNav();

    // Load inbox — this also kicks off background pre-download of all folders
    await _loadFolder('INBOX', 1);

    // Background: pre-download bodies for all other folders silently
    _prefetchAllFolders();

    // Poll for new mail
    ImapEngine.startPoll('INBOX', async ({ newCount }) => {
      _showNewMailBanner(newCount);
      Notifier.notifyBatch(newCount, account.email);
      if (S.folder === 'INBOX') {
        const newMsgs = await ImapEngine.fetchNewest('INBOX', S.newestUid).catch(() => []);
        if (newMsgs.length) _prependMessages(newMsgs);
      }
    });
  }

  // Pre-fetch bodies for all visible folders in background
  async function _prefetchAllFolders() {
    for (const f of S.folders) {
      try {
        // Fetch headers first (already done for current folder)
        if (f.path === S.folder) continue;
        const res = await ImapEngine.fetchPage(f.path, 1, null).catch(() => null);
        if (!res || !res.messages.length) continue;
        const uids = res.messages.map(m => m.uid).filter(Boolean).slice(0, 100);
        if (uids.length) {
          await ImapEngine.prefetchBodies(f.path, uids, null).catch(() => {});
        }
      } catch(e) {}
    }
  }

  // ── Wire buttons ──────────────────────────────────────────────────────
  function _wireApp() {
    _on('rules-btn',       _showRules);
    _on('stats-btn',       _showStats);
    _on('refresh-folder-btn', () => _loadFolder(S.folder, S.page, true));
    _on('bulk-delete-btn', _bulkDelete);
    _on('uncheck-all-btn', () => UI.exitSelectionMode());
    _on('add-account-btn', () => _showSetup(true));

    // Reader actions
    _on('reader-delete-btn',      _deleteActive);
    _on('reader-spam-btn',        _markActiveSpam);
    _on('reader-unsubscribe-btn', _unsubscribeActive);
    _on('ai-btn',                 _analyseActive);
    _on('ai-dismiss',             () => document.getElementById('ai-panel')?.classList.add('hidden'));

    // Scan
    _on('scan-done-btn', () => { UI.hideScan(); _loadFolder(S.folder, 1, true); });
    _on('ai-cfg-btn', () => {
      const prov = document.getElementById('ai-provider');
      const key  = document.getElementById('ai-api-key');
      const base = document.getElementById('ai-base-url');
      const mod  = document.getElementById('ai-model');
      if (prov) prov.value = AI.getProvider();
      if (key)  key.value  = AI.getApiKey();
      if (base) base.value = AI.getBaseUrl();
      if (mod)  mod.value  = AI.getModel();
      document.getElementById('ai-settings-overlay')?.classList.remove('hidden');
    });
    _on('ai-settings-save', _saveAISettings);

    // Filters
    _on('save-rules-btn', _saveRules);

    // Pagination
    _on('page-prev', () => { if (S.page > 1)              _loadFolder(S.folder, S.page - 1); });
    _on('page-next', () => { if (S.page < S.totalPages)   _loadFolder(S.folder, S.page + 1); });

    // Compose
    _on('compose-btn',       () => _openCompose());
    _on('compose-send-btn',  _sendCompose);
    _on('compose-attach-btn', () => document.getElementById('compose-file-input')?.click());
    _on('compose-discard-btn', () => { document.getElementById('compose-overlay')?.classList.add('hidden'); _clearComposeAttachments(); });
    document.getElementById('compose-file-input')?.addEventListener('change', _addComposeAttachment);
    _on('reader-reply-btn',  _replyToActive);

    // Block submenu
    _on('reader-block-btn', e => { e.stopPropagation(); document.getElementById('block-menu')?.classList.toggle('hidden'); });
    document.addEventListener('click', () => document.getElementById('block-menu')?.classList.add('hidden'));
    _on('block-by-addr',    () => _blockActive('email'));
    _on('block-by-subject', () => _blockActive('subject'));
    _on('block-by-domain',  () => _blockActive('domain'));

    // Theme
    _on('theme-btn', () => {
      Themes.buildPicker({
        grid:      document.getElementById('theme-grid'),
        bgOpts:    document.getElementById('bg-options'),
        swSlider:  document.getElementById('sidebar-width-slider'),
        swVal:     document.getElementById('sidebar-width-val'),
        tintInput: document.getElementById('custom-tint'),
        tintReset: document.getElementById('tint-reset-btn'),
      });
      document.getElementById('theme-overlay')?.classList.remove('hidden');
    });
    _on('bg-image-btn', () => document.getElementById('bg-image-file')?.click());
    document.getElementById('bg-image-file')?.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = ev => { Themes.setBgImage(ev.target.result); document.getElementById('bg-image-name').textContent = f.name; };
      reader.readAsDataURL(f);
    });
    _on('bg-image-clear-btn', () => { Themes.clearBgImage(); document.getElementById('bg-image-name').textContent = 'None'; document.getElementById('bg-image-file').value = ''; });

    // Calendar
    _on('calendar-btn', _showCalendar);
    _on('cal-add-btn', _addCalendar);
    _on('cal-file-btn', () => document.getElementById('cal-file-input')?.click());
    _on('cal-refresh-btn', async () => { await Calendar.refreshAll(); _renderCalView(); });
    document.getElementById('cal-file-input')?.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      await Calendar.loadFromFile(await f.text(), f.name.replace('.ics', ''));
      _renderCalView();
    });

    // Search
    let stimer;
    document.getElementById('search-box')?.addEventListener('input', e => {
      clearTimeout(stimer);
      const q = e.target.value.trim();
      if (!q) { S.searchMode = false; _renderList(); return; }
      stimer = setTimeout(() => _doSearch(q), 400);
    });

    // Tag inputs
    UI.initTag('tw-domain','ti-domain','domain');
    UI.initTag('tw-email','ti-email','email');
    UI.initTag('tw-name','ti-name','name');
    UI.initTag('tw-subject','ti-subject','subject');
    UI.initTag('tw-body','ti-body','body');
  }

  function _on(id, fn) { document.getElementById(id)?.addEventListener('click', fn); }

  // ── Load folder ───────────────────────────────────────────────────────
  async function _loadFolder(folder, page, forceRefresh) {
    page = Math.max(1, page || 1);
    S.folder = folder; S.page = page; S.searchMode = false;
    const sb = document.getElementById('search-box'); if (sb) sb.value = '';
    UI.exitSelectionMode();
    UI.setActiveFolder(folder);
    _setTxt('folder-name-label', _folderLabel(folder));
    document.getElementById('ai-panel')?.classList.add('hidden');
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');

    const container = document.getElementById('email-list-container');
    container.innerHTML = `<div class="list-state"><div class="state-spinner"></div><div class="state-text">Loading…</div></div>`;
    UI.setSync('syncing', `Loading ${_folderLabel(folder)}…`);

    try {
      if (folder === '__unread__') { await _loadUnread(); return; }

      const res = await ImapEngine.fetchPage(folder, page, ({ seqStart, seqEnd, total }) => {
        container.innerHTML = `<div class="list-state"><div class="state-spinner"></div><div class="state-text">Fetching ${seqStart}–${seqEnd} of ${total}…</div></div>`;
      });

      S.messages   = res.messages;
      S.page       = res.page;
      S.totalPages = res.totalPages;
      S.totalMsgs  = res.total;
      S.stats.fetched = res.total;
      if (S.messages.length) S.newestUid = Math.max(S.newestUid || 0, ...S.messages.map(m => m.uid || 0));

      const seen = new Set(S.allLoaded.map(m => m.id));
      S.messages.forEach(m => { if (!seen.has(m.id)) S.allLoaded.push(m); });

      const { kept, deleted } = _applyFilters(S.messages);
      S.messages = kept;

      _setTxt('msg-count', `${S.totalMsgs} · p${S.page}/${S.totalPages}`);
      _updatePager(S.page, S.totalPages);
      _renderList();
      S.unread[folder] = S.messages.filter(m => m.unread).length;
      _renderNav();
      UI.setSync('done', `${S.messages.length} shown`);

      // Pre-download bodies for this page in background (shows "downloading" indicator)
      const uids = S.messages.map(m => m.uid).filter(Boolean);
      if (uids.length) {
        _setTxt('sync-text', 'Downloading…');
        ImapEngine.prefetchBodies(folder, uids, ({ done, total }) => {
          document.getElementById('sync-dot')?.setAttribute('class', 'sync-dot syncing');
          _setTxt('sync-text', `Caching ${done}/${total}…`);
        }).then(() => {
          UI.setSync('done', `${S.messages.length} cached`);
        }).catch(() => UI.setSync('done', `${S.messages.length} shown`));
      }

      if (deleted.length) _batchDelete(folder, deleted).catch(() => {});

    } catch(err) {
      console.error('[App]', err);
      container.innerHTML = `<div class="list-state"><div class="state-text" style="color:var(--danger)">⚠ ${UI.esc(err.message)}</div><button class="toolbar-btn" id="retry-btn" style="margin-top:8px">Retry</button></div>`;
      document.getElementById('retry-btn')?.addEventListener('click', () => _loadFolder(folder, page, true));
      UI.setSync('error', err.message);
      if (/not auth|connect/i.test(err.message)) {
        UI.setSync('syncing', 'Reconnecting…');
        try { await ImapEngine.connect(S.account); await _loadFolder(folder, page, true); }
        catch(e2) { UI.setSync('error', 'Reconnect failed'); }
      }
    }
  }

  async function _loadUnread() {
    const container = document.getElementById('email-list-container');
    try {
      const inboxPath = S.folders.find(f => f.special === 'inbox')?.path || 'INBOX';
      const msgs = await ImapEngine.searchFolder(inboxPath, 'UNSEEN', true);
      S.messages = msgs; S.totalMsgs = msgs.length;
      _setTxt('msg-count', `${msgs.length} unread`);
      _updatePager(1, 1); _renderList();
      UI.setSync('done', `${msgs.length} unread`);
    } catch(e) {
      container.innerHTML = `<div class="list-state"><div class="state-text" style="color:var(--danger)">⚠ ${UI.esc(e.message)}</div></div>`;
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────
  function _applyFilters(messages) {
    const kept = [], deleted = [], seen = new Map();
    S.allLoaded.forEach(m => {
      if (m._kept === false) return;
      const k = _ns(m.subject); if (k && !seen.has(k)) seen.set(k, m.id);
    });
    for (const msg of messages) {
      const k = _ns(msg.subject);
      if (Rules.get().dupes?.enabled && k && seen.has(k) && seen.get(k) !== msg.id) {
        msg._deleteReason = 'duplicate'; msg._kept = false; deleted.push(msg); UI.removeRow(msg.id); continue;
      }
      if (k) seen.set(k, msg.id);
      const hits = Rules.check(msg);
      if (hits.length) { msg._deleteReason = `${hits[0].rule}:${hits[0].value}`; msg._kept = false; deleted.push(msg); UI.removeRow(msg.id); continue; }
      msg._kept = true; kept.push(msg);
    }
    return { kept, deleted };
  }
  function _ns(s) { return (s || '').toLowerCase().replace(/^(re|fwd?|fw|aw):\s*/gi, '').replace(/\s+/g, ' ').trim(); }

  // ── Batch delete ──────────────────────────────────────────────────────
  async function _batchDelete(folder, messages) {
    const byF = {};
    messages.forEach(m => { const f = m.folder || folder; if (!byF[f]) byF[f] = []; if (m.uid) byF[f].push(m.uid); });
    for (const [f, uids] of Object.entries(byF)) {
      if (!uids.length) continue;
      try {
        await ImapEngine.trashMessages(f, uids);
        S.stats.deleted += uids.length;
        messages.filter(m => (m.folder || folder) === f).forEach(m => {
          if (m._deleteReason === 'duplicate') S.stats.dupes++;
          if ((m._deleteReason || '').includes('scam')) S.stats.scams++;
          _log(m._deleteReason === 'duplicate' ? 'dup' : (m._deleteReason || '').includes('scam') ? 'scam' : 'deleted',
               `"${(m.subject || '').slice(0, 45)}" [${m._deleteReason}]`);
        });
        _savePersisted();
      } catch(e) { console.error('[App] delete', e.message); }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  function _renderList() {
    UI.renderEmailList(document.getElementById('email-list-container'), S.messages, S.activeMsg?.id, msg => _openMsg(msg));
  }

  // ── Open message — instant from cache ────────────────────────────────
  async function _openMsg(msg) {
    S.activeMsg = msg;
    UI.showReader(msg);
    Notifier.clearBadge();
    try {
      const body = await ImapEngine.fetchBody(msg.folder || S.folder, msg.uid);
      UI.setEmailBody(body, msg);
    } catch(e) {
      UI.setEmailBody({ html: null, text: 'Error: ' + e.message, attachments: [] }, msg);
    }
  }

  // ── Delete active ─────────────────────────────────────────────────────
  async function _deleteActive() {
    if (!S.activeMsg) return;
    const msg = S.activeMsg; S.activeMsg = null;
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    UI.removeRow(msg.id);
    S.messages  = S.messages.filter(m => m.id !== msg.id);
    S.allLoaded = S.allLoaded.filter(m => m.id !== msg.id);
    msg._deleteReason = 'manual';
    await _batchDelete(msg.folder || S.folder, [msg]);
  }

  // ── Mark as spam ──────────────────────────────────────────────────────
  async function _markActiveSpam() {
    if (!S.activeMsg) return;
    const msg = S.activeMsg; S.activeMsg = null;
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    UI.removeRow(msg.id);
    S.messages = S.messages.filter(m => m.id !== msg.id);
    try {
      await ImapEngine.markSpam(msg.folder || S.folder, [msg.uid]);
      _log('spam', `Marked spam: "${(msg.subject || '').slice(0, 45)}"`);
      UI.setSync('done', 'Marked as spam');
    } catch(e) { UI.setSync('error', 'Spam error: ' + e.message); }
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────
  async function _unsubscribeActive() {
    if (!S.activeMsg) return;
    const msg = S.activeMsg;

    // Check header on msg itself (fetched during header load)
    let unsub = msg.listUnsub || '';

    // Also check cached body for richer header
    const cached = ImapEngine.getBodyCache().get(`${msg.folder || S.folder}::${msg.uid}`);
    if (cached?.listUnsub) unsub = cached.listUnsub;

    // Parse URL or mailto from List-Unsubscribe header value
    // Format: <https://...>, <mailto:...>
    const urlMatch   = unsub.match(/<(https?:[^>]+)>/);
    const mailMatch  = unsub.match(/<mailto:([^>]+)>/);

    if (urlMatch) {
      if (typeof nw !== 'undefined') {
        nw.Shell.openExternal(urlMatch[1]);
        UI.setSync('done', 'Opened unsubscribe link');
      }
    } else if (mailMatch) {
      _openCompose(mailMatch[1], 'Unsubscribe', 'Please remove me from this mailing list.\n\nThank you.');
    } else {
      // Try to find unsubscribe link in the rendered body
      const iframe = document.getElementById('reader-iframe');
      try {
        const links = [...iframe.contentDocument.querySelectorAll('a[href]')];
        const unsubLink = links.find(a => /unsub/i.test(a.href) || /unsub/i.test(a.textContent));
        if (unsubLink) {
          if (typeof nw !== 'undefined') nw.Shell.openExternal(unsubLink.href);
          else window.open(unsubLink.href, '_blank');
          UI.setSync('done', 'Opened unsubscribe link');
          return;
        }
      } catch(e) {}
      UI.setSync('done', 'No unsubscribe link found in this email');
    }
  }

  // ── Block ─────────────────────────────────────────────────────────────
  function _blockActive(by) {
    if (!S.activeMsg) return;
    document.getElementById('block-menu')?.classList.add('hidden');
    const msg = S.activeMsg;
    const rules = Rules.get();
    if (by === 'email') {
      const addr = ImapEngine.extractAddr(msg.from || '');
      if (addr) { rules.email = rules.email || {enabled:true,list:[]}; if (!rules.email.list.includes(addr)) { rules.email.list.push(addr); rules.email.enabled = true; } }
    } else if (by === 'domain') {
      const domain = ImapEngine.extractAddr(msg.from || '').split('@')[1] || '';
      if (domain) { rules.domain = rules.domain || {enabled:true,list:[]}; if (!rules.domain.list.includes(domain)) { rules.domain.list.push(domain); rules.domain.enabled = true; } }
    } else if (by === 'subject') {
      const subj = _ns(msg.subject);
      if (subj) { rules.subject = rules.subject || {enabled:true,list:[]}; if (!rules.subject.list.includes(subj)) { rules.subject.list.push(subj); rules.subject.enabled = true; } }
    }
    Rules.save(rules);
    UI.setSync('done', `Blocked by ${by}`);
    _deleteActive();
  }

  // ── Bulk delete ───────────────────────────────────────────────────────
  async function _bulkDelete() {
    const ids = new Set(UI.getSelectedIds()); if (!ids.size) return;
    const msgs = S.messages.filter(m => ids.has(m.id));
    msgs.forEach(m => { m._deleteReason = 'manual'; UI.removeRow(m.id); });
    S.messages  = S.messages.filter(m => !ids.has(m.id));
    S.allLoaded = S.allLoaded.filter(m => !ids.has(m.id));
    UI.exitSelectionMode();
    await _batchDelete(S.folder, msgs);
  }

  // ── AI analysis ───────────────────────────────────────────────────────
  async function _analyseActive() {
    if (!S.activeMsg) return;
    const btn = document.getElementById('ai-btn');
    btn.textContent = '⏳ Analysing…'; btn.disabled = true;
    const body = ImapEngine.getBodyCache().get(`${S.activeMsg.folder || S.folder}::${S.activeMsg.uid}`);
    const msgForAI = { ...S.activeMsg, rawBody: body?.text || '' };
    const result = await AI.analyse(msgForAI);
    UI.showAIResult(result);
    btn.textContent = '⚡ AI Analysis'; btn.disabled = false;
    if (result.risk === 'HIGH' && Rules.get().aiscam?.enabled) setTimeout(_deleteActive, 2000);
  }

  function _saveAISettings() {
    const prov  = document.getElementById('ai-provider')?.value;
    const key   = document.getElementById('ai-api-key')?.value.trim();
    const base  = document.getElementById('ai-base-url')?.value.trim();
    const model = document.getElementById('ai-model')?.value.trim();
    if (prov)  AI.setProvider(prov);
    if (key)   AI.setApiKey(key);
    if (base)  AI.setBaseUrl(base);
    if (model) AI.setModel(model);
    _setTxt('ai-settings-status', '✓ Saved');
    setTimeout(() => _setTxt('ai-settings-status', ''), 2000);
  }

  // ── Compose / Reply ───────────────────────────────────────────────────
  const _composeAttachments = []; // { name, type, data (ArrayBuffer) }

  function _openCompose(to, subject, body) {
    const _v = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    _v('compose-to', to); _v('compose-subject', subject); _v('compose-body', body);
    _setTxt('compose-status', '');
    _clearComposeAttachments();
    document.getElementById('compose-overlay')?.classList.remove('hidden');
    setTimeout(() => (to ? document.getElementById('compose-body') : document.getElementById('compose-to'))?.focus(), 50);
  }

  function _clearComposeAttachments() {
    _composeAttachments.length = 0;
    _renderComposeAttachments();
    const fi = document.getElementById('compose-file-input'); if (fi) fi.value = '';
  }

  function _addComposeAttachment(e) {
    const files = [...(e.target.files || [])];
    files.forEach(f => {
      const reader = new FileReader();
      reader.onload = ev => {
        _composeAttachments.push({ name: f.name, type: f.type || 'application/octet-stream', data: ev.target.result });
        _renderComposeAttachments();
      };
      reader.readAsArrayBuffer(f);
    });
    e.target.value = ''; // allow same file again
  }

  function _renderComposeAttachments() {
    const wrap = document.getElementById('compose-attachments');
    if (!wrap) return;
    wrap.innerHTML = _composeAttachments.map((a, i) =>
      `<div class="compose-att-chip"><span>${UI.esc(a.name)}</span><button class="compose-att-x" data-i="${i}">×</button></div>`
    ).join('');
    wrap.querySelectorAll('.compose-att-x').forEach(btn =>
      btn.addEventListener('click', () => { _composeAttachments.splice(parseInt(btn.dataset.i), 1); _renderComposeAttachments(); })
    );
  }

  async function _sendCompose() {
    const to      = document.getElementById('compose-to')?.value.trim();
    const subject = document.getElementById('compose-subject')?.value.trim();
    const body    = document.getElementById('compose-body')?.value;
    const status  = document.getElementById('compose-status');
    if (!to || !subject) { if (status) status.textContent = 'Fill in To and Subject'; return; }
    if (!S.account) { if (status) status.textContent = 'Not connected'; return; }
    const btn = document.getElementById('compose-send-btn');
    btn.disabled = true; btn.textContent = 'Sending…'; if (status) status.textContent = '';
    try {
      await SmtpClient.send(S.account, { to, subject, text: body, attachments: _composeAttachments });
      if (status) status.textContent = '✓ Sent!';
      setTimeout(() => {
        document.getElementById('compose-overlay')?.classList.add('hidden');
        btn.disabled = false; btn.textContent = 'Send ↗';
        _clearComposeAttachments();
      }, 1500);
    } catch(e) { if (status) status.textContent = '⚠ ' + e.message; btn.disabled = false; btn.textContent = 'Send ↗'; }
  }

  function _replyToActive() {
    if (!S.activeMsg) return;
    const addr = ImapEngine.extractAddr(S.activeMsg.from || '');
    const subj = (S.activeMsg.subject || '').startsWith('Re:') ? S.activeMsg.subject : 'Re: ' + (S.activeMsg.subject || '');
    _openCompose(addr, subj);
  }

  // ── Search ────────────────────────────────────────────────────────────
  async function _doSearch(q) {
    S.searchMode = true;
    const container = document.getElementById('email-list-container');
    container.innerHTML = '<div class="list-state"><div class="state-spinner"></div><div class="state-text">Searching…</div></div>';
    try {
      const results = await ImapEngine.searchFolder(S.folder, q, false);
      S.messages = results;
      _setTxt('msg-count', results.length + ' results');
      _updatePager(1, 1); _renderList();
    } catch(e) {
      const lq = q.toLowerCase();
      S.messages = S.allLoaded.filter(m =>
        (m.subject || '').toLowerCase().includes(lq) || (m.from || '').toLowerCase().includes(lq));
      _setTxt('msg-count', S.messages.length + ' local results');
      _renderList();
    }
  }

  // ── New mail ──────────────────────────────────────────────────────────
  function _showNewMailBanner(count) {
    let b = document.getElementById('new-mail-banner');
    if (!b) {
      b = document.createElement('div'); b.id = 'new-mail-banner';
      Object.assign(b.style, { position:'fixed', top:'16px', left:'50%', transform:'translateX(-50%)', background:'var(--accent)', color:'#fff', padding:'9px 22px', borderRadius:'20px', fontSize:'13px', fontWeight:'700', boxShadow:'0 4px 20px var(--accent-glow)', zIndex:'9999', cursor:'pointer' });
      b.addEventListener('click', () => { b.remove(); _loadFolder('INBOX', 1, true); });
      document.getElementById('app-screen')?.appendChild(b);
    }
    b.textContent = `↓ ${count} new message${count > 1 ? 's' : ''} — click to load`;
    clearTimeout(b._t); b._t = setTimeout(() => b.remove(), 8000);
  }

  function _prependMessages(msgs) {
    const fresh = msgs.filter(m => !S.messages.find(x => x.id === m.id));
    if (!fresh.length) return;
    S.messages  = [...fresh, ...S.messages];
    S.allLoaded = [...fresh, ...S.allLoaded];
    S.newestUid = Math.max(S.newestUid || 0, ...fresh.map(m => m.uid || 0));
    S.unread['INBOX'] = (S.unread['INBOX'] || 0) + fresh.filter(m => m.unread).length;
    _renderNav(); _renderList();
    _setTxt('msg-count', `${S.messages.length} shown`);
  }

  // ── Pager ─────────────────────────────────────────────────────────────
  function _updatePager(page, totalPages) {
    const el = document.getElementById('pager'); if (!el) return;
    if (!totalPages || totalPages <= 1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    _setTxt('page-info', `Page ${page} of ${totalPages}`);
    document.getElementById('page-prev').disabled = page <= 1;
    document.getElementById('page-next').disabled = page >= totalPages;
  }

  // ── Rules overlay ─────────────────────────────────────────────────────
  function _showRules() {
    const r = Rules.get();
    ['domain','email','name','subject','body'].forEach(k => {
      const el = document.getElementById('r-' + k); if (el) el.checked = r[k]?.enabled || false;
      UI.setTags(k, r[k]?.list || []); UI.refreshTags('tw-' + k, 'ti-' + k, k);
    });
    document.getElementById('r-dupes').checked  = r.dupes?.enabled !== false;
    document.getElementById('r-aiscam').checked = r.aiscam?.enabled || false;
    document.getElementById('rules-overlay')?.classList.remove('hidden');
  }

  function _saveRules() {
    const r = { dupes:{enabled:document.getElementById('r-dupes').checked}, aiscam:{enabled:document.getElementById('r-aiscam').checked} };
    ['domain','email','name','subject','body'].forEach(k => { r[k] = { enabled:document.getElementById('r-'+k).checked, list:UI.getTags(k) }; });
    Rules.save(r);
    document.getElementById('rules-overlay')?.classList.add('hidden');
    UI.setSync('done', 'Filters saved');
    if (S.messages.length) { const {kept,deleted} = _applyFilters([...S.messages]); S.messages = kept; _renderList(); if (deleted.length) _batchDelete(S.folder, deleted); }
  }

  // ── Stats ─────────────────────────────────────────────────────────────
  function _showStats() {
    UI.updateStats(S.stats);
    const c = document.getElementById('log-container');
    if (c) { c.innerHTML = S.log.length ? '' : '<div class="log-empty">No activity yet</div>'; [...S.log].reverse().slice(0,150).forEach(e => UI.addLog(e)); }
    document.getElementById('stats-overlay')?.classList.remove('hidden');
  }

  // ── Calendar ──────────────────────────────────────────────────────────
  function _showCalendar() { _renderCalView(); document.getElementById('calendar-overlay')?.classList.remove('hidden'); }
  function _renderCalView() {
    const events = Calendar.getEventsForMonth(S.calYear, S.calMonth);
    const container = document.getElementById('cal-grid-container'); if (!container) return;
    UI.renderCalendar(container, S.calYear, S.calMonth, events);
    document.getElementById('cal-prev')?.addEventListener('click', () => { S.calMonth--; if (S.calMonth < 0) { S.calMonth = 11; S.calYear--; } _renderCalView(); });
    document.getElementById('cal-next')?.addEventListener('click', () => { S.calMonth++; if (S.calMonth > 11) { S.calMonth = 0; S.calYear++; } _renderCalView(); });
    container.querySelectorAll('.cal-cell[data-day]').forEach(cell => {
      cell.addEventListener('click', () => {
        const evs = Calendar.getEventsForDay(new Date(S.calYear, S.calMonth, parseInt(cell.dataset.day)));
        const detail = document.getElementById('cal-day-detail');
        if (!detail) return;
        detail.innerHTML = evs.length ? evs.map(e => `<div class="cal-detail-event" style="border-left:3px solid ${e.color}"><div class="cde-title">${UI.esc(e.summary)}</div><div class="cde-time">${e.allDay?'All day':e.start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}${e.location?' · '+UI.esc(e.location):''}${e.calendar?' · '+UI.esc(e.calendar):''}</div>${e.description?'<div class="cde-desc">'+UI.esc(e.description.slice(0,100))+'</div>':''}</div>`).join('') : '<div style="color:var(--text3);font-size:12px;padding:8px">No events</div>';
      });
    });
    const calList = document.getElementById('cal-list');
    if (calList) {
      calList.innerHTML = Calendar.calendars.map(c => `<div class="cal-list-item"><span class="cal-list-dot" style="background:${c.color}"></span><span class="cal-list-name">${UI.esc(c.name)}</span><button class="cal-list-remove" data-name="${UI.esc(c.name)}">×</button></div>`).join('') || '<div style="color:var(--text3);font-size:12px">No calendars</div>';
      calList.querySelectorAll('.cal-list-remove').forEach(btn => btn.addEventListener('click', () => { Calendar.removeCalendar(btn.dataset.name); _renderCalView(); }));
    }
  }
  async function _addCalendar() {
    const url  = document.getElementById('cal-url-input')?.value.trim();
    const name = document.getElementById('cal-name-input')?.value.trim() || 'Calendar';
    if (!url) { UI.setSync('error', 'Enter a calendar URL'); return; }
    UI.setSync('syncing', 'Loading calendar…');
    try { await Calendar.addCalendar(name, url); document.getElementById('cal-url-input').value = ''; _renderCalView(); UI.setSync('done', 'Calendar added'); }
    catch(e) { UI.setSync('error', 'Calendar error: ' + e.message); }
  }

  // ── Overlays ──────────────────────────────────────────────────────────
  function _wireOverlays() {
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.close)?.classList.add('hidden')));
    document.querySelectorAll('.overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target === ov) ov.classList.add('hidden'); }));
  }

  // ── Nav ───────────────────────────────────────────────────────────────
  function _renderNav() {
    UI.renderFolderNav(document.getElementById('folder-nav'), S.folders, S.unread, S.folder, folder => _loadFolder(folder, 1));
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function _showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); document.getElementById(id)?.classList.add('active'); }
  function _setTxt(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }
  function _folderLabel(path) {
    const m = {'__unread__':'Unread','INBOX':'Inbox','[Gmail]/Trash':'Trash','[Gmail]/Spam':'Spam','[Gmail]/Sent Mail':'Sent','[Gmail]/Drafts':'Drafts','[Gmail]/Starred':'Starred','[Gmail]/All Mail':'All Mail'};
    return m[path] || path.split(/[/\\]/).pop() || path;
  }
  function _log(type, msg) { S.log.push({ ts:Date.now(), type, msg }); if (S.log.length > 500) S.log.shift(); }
  function _savePersisted() { localStorage.setItem('elve_stats', JSON.stringify(S.stats)); localStorage.setItem('elve_log', JSON.stringify(S.log.slice(-200))); }
  function _loadPersisted() {
    try { const s = localStorage.getItem('elve_stats'); if (s) S.stats = {...S.stats, ...JSON.parse(s)}; } catch(e) {}
    try { const l = localStorage.getItem('elve_log');   if (l) S.log   = JSON.parse(l); } catch(e) {}
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
