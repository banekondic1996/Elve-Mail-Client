// js/app.js — Elve Mail v8
// Multi-account: S.accounts[] holds all loaded accounts, switchable from sidebar.
// Cache-first: folder switches render instantly from IndexedDB — no IMAP hit.
// Background sync fetches new mail; cached folders never re-fetched on switch.
'use strict';
const App = (() => {

  const S = {
    accounts: [],        // all loaded accounts
    accountIdx: 0,       // active account index
    account: null, folders: [], unread: {},
    folder: 'INBOX', messages: [], allLoaded: [],
    page: 1, totalPages: 1, totalMsgs: 0,
    activeMsg: null, newestUid: null,
    stats: { fetched:0, deleted:0, dupes:0, scams:0 }, log: [],
    searchMode: false, inApp: false,
    searchOpts: { field: 'all', match: 'contains' },
    calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
    synced: new Set(),
    aiScanned: new Set(),
    syncing: false,
    preloadPromise: null,
    inboxPath: 'INBOX',
    openMsgToken: 0,
    folderMeta: {},
  };

  // ── Boot ──────────────────────────────────────────────────────────────────
  function init() {
    Themes.load(); Rules.load(); Calendar.load(); _loadPersisted();
    _wireOverlays(); _wireApp(); Notifier.init();
    window.addEventListener('message', e => {
      if (!e.data) return;
      if (e.data.type === 'compose') _openCompose(e.data.to);
      if (e.data.type === 'blockKeyword') {
        const kw = (e.data.keyword||'').slice(0,60); if (!kw) return;
        const r = Rules.get(); r.body = r.body||{enabled:true,list:[]};
        if (!r.body.list.includes(kw)) { r.body.list.push(kw); Rules.save(r); }
      }
    });
    window.addEventListener('elve:theme-changed', () => {
      if (!S.activeMsg) return;
      const body = ImapEngine.getCachedBody?.(S.activeMsg.folder || S.folder, S.activeMsg.uid);
      if (body) UI.setEmailBody(body, S.activeMsg);
    });
    Vault.hasVault() ? _showUnlock(false) : _showUnlock(true);
  }

  // ── Unlock ────────────────────────────────────────────────────────────────
  function _showUnlock(createMode) {
    _showScreen('unlock-screen');
    if (createMode) {
      document.getElementById('unlock-new-wrap')?.classList.remove('hidden');
      const btn = document.getElementById('unlock-btn'); if (btn) btn.textContent = 'Create Vault';
    }
    const go = async () => {
      const pw = document.getElementById('master-password-input')?.value||'';
      if (!pw) { UI.showErr('unlock-error','Enter a password'); return; }
      if (createMode) {
        const pc = document.getElementById('master-confirm-input')?.value||'';
        if (pw !== pc) { UI.showErr('unlock-error','Passwords do not match'); return; }
      }
      const r = await Vault.unlock(pw);
      if (!r.ok) { UI.showErr('unlock-error','⚠ '+r.error); return; }
      UI.hideErr('unlock-error');
      const accounts = r.accounts||[];
      S.accounts = accounts;
      if (!accounts.length) _showSetup(false);
      else await _connectAccount(accounts[accounts.length-1], accounts.length-1);
    };
    document.getElementById('unlock-btn').onclick = go;
    document.getElementById('master-password-input').onkeydown = e => { if (e.key==='Enter') go(); };
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function _showSetup(showClose) {
    _showScreen('setup-screen');
    const cb = document.getElementById('setup-close-btn');
    if (cb) { cb.classList.toggle('hidden',!(showClose&&S.inApp)); if (showClose&&S.inApp) cb.onclick=()=>_showScreen('app-screen'); }
    const btn = document.getElementById('connect-btn');
    if (btn) { btn.disabled=false; btn.textContent='Connect'; }
    document.getElementById('cb-spin')?.classList.add('hidden');
    document.querySelectorAll('.ptab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.ptab').forEach(t=>t.classList.remove('active'));
        document.querySelectorAll('.pform').forEach(f=>f.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('pf-'+tab.dataset.p)?.classList.add('active');
      };
    });
    document.getElementById('connect-btn').onclick = _doConnect;
    ['g-pass','y-pass','o-pass','i-pass'].forEach(id => {
      const el=document.getElementById(id); if (el) el.onkeydown=e=>{if(e.key==='Enter')_doConnect();};
    });
  }

  async function _doConnect() {
    const p = document.querySelector('.ptab.active')?.dataset.p||'gmail';
    const cfg = _readForm(p); if (!cfg) return;
    const btn = document.getElementById('connect-btn');
    btn.disabled=true; document.getElementById('cb-text').textContent='Connecting…';
    document.getElementById('cb-spin').classList.remove('hidden'); UI.hideErr('setup-err');
    try {
      await ImapEngine.connect(cfg);
      const saved = await Vault.addAccount(cfg);
      S.accounts = saved || [...S.accounts.filter(a=>a.email!==cfg.email), cfg];
      const idx = S.accounts.findIndex(a=>a.email===cfg.email);
      await _connectAccount(cfg, idx>=0?idx:S.accounts.length-1);
    } catch(err) {
      btn.disabled=false; document.getElementById('cb-text').textContent='Connect';
      document.getElementById('cb-spin').classList.add('hidden');
      let msg = err.message||'Connection failed';
      if (/auth|LOGIN|password/i.test(msg)) msg='Authentication failed. Check email/password.';
      else if (/ENOTFOUND/i.test(msg)) msg='Server not found. Check internet.';
      else if (/timeout/i.test(msg)) msg='Connection timed out.';
      UI.showErr('setup-err','⚠ '+msg);
    }
  }

  function _readForm(p) {
    const m={gmail:{e:'g-email',pw:'g-pass'},yahoo:{e:'y-email',pw:'y-pass'},outlook:{e:'o-email',pw:'o-pass'},imap:{e:'i-email',pw:'i-pass',h:'i-host',port:'i-port'}}[p];
    const email=document.getElementById(m.e)?.value.trim();
    const pass=document.getElementById(m.pw)?.value;
    if (!email||!pass) { UI.showErr('setup-err','Enter email and password'); return null; }
    const cfg={provider:p,email,password:pass};
    if (p==='imap') { cfg.host=document.getElementById(m.h)?.value.trim(); cfg.port=document.getElementById(m.port)?.value; }
    return cfg;
  }

  function _inboxPath() {
    if (S.inboxPath) return S.inboxPath;
    const found = S.folders.find(f => f.special === 'inbox')?.path;
    return found || 'INBOX';
  }

  // ── Connect / switch account — resilient: never blocks UI on IMAP failure ──
  async function _connectAccount(account, idx) {
    ImapEngine.clearPoll();
    S.account    = account;
    S.accountIdx = idx ?? 0;
    S.inApp      = true;
    S.synced.clear(); S.syncing = false;
    S.preloadPromise = null;
    S.aiScanned.clear();
    S.folderMeta = {};
    S.folders=[]; S.messages=[]; S.allLoaded=[]; S.activeMsg=null;
    S.folder='INBOX'; S.page=1; S.unread={}; S.inboxPath='INBOX';

    // Always show app immediately — switcher stays usable even if IMAP fails
    _showScreen('app-screen');
    _renderAccountSwitcher();
    _setTxt('account-email',    account.email);
    _setTxt('account-provider', account.provider.toUpperCase()+' · IMAP');
    _setTxt('account-avatar',   account.email[0].toUpperCase());
    const _av=document.getElementById('account-avatar');
    if(_av) _av.style.background=_acctColor(account.email);

    document.getElementById('folder-nav').innerHTML='<div class="folders-loading">Connecting…</div>';
    document.getElementById('email-list-container').innerHTML='';
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');

    UI.setSync('syncing', 'Connecting…');
    let connected = false;
    try {
      await ImapEngine.connect(account);
      connected = true;
    } catch(connErr) {
      UI.setSync('error', 'Connection failed — showing cached mail');
      // Fall through: load cached folders/mail from IndexedDB
    }

    try { S.folders = await ImapEngine.listFolders(); }
    catch(e) { S.folders=[{path:'INBOX',name:'Inbox',special:'inbox'},{path:'Sent',name:'Sent',special:'sent'},{path:'Trash',name:'Trash',special:'trash'}]; }
    S.inboxPath = S.folders.find(f => f.special === 'inbox')?.path || 'INBOX';
    S.folder = S.inboxPath;
    _renderNav();

    // Always load inbox once from server; then stay cache-first.
    await _loadFolder(S.inboxPath, 1, true);

    if (connected) {
      const inboxPath = S.inboxPath;
      ImapEngine.startPoll(inboxPath, async ({newCount, forceCheck}) => {
        if ((newCount || 0) <= 0 && !forceCheck) return;
        const nm = await ImapEngine.fetchNewest(inboxPath, S.newestUid).catch(()=>[]);
        if (!nm.length) {
          if (newCount > 0) Notifier.notifyBatch(newCount, account.email);
          return;
        }
        S.newestUid = Math.max(S.newestUid || 0, ...nm.map(m => m.uid || 0));
        _learnContacts(nm);
        Notifier.notifyBatch(nm.length, account.email, nm);
        // Fetch into cache first (silent background), then slide in or show banner
        if (S.folder===inboxPath) _prependMessages(nm, inboxPath);
        else _showNewMailBanner(nm.length || newCount);
      });
      _bgSyncAll().catch(()=>{});
    }
  }

  // ── Account switcher ──────────────────────────────────────────────────────
  // Each account gets a deterministic accent color based on its email
  function _acctColor(email) {
    const palette=['#6c63ff','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];
    let h=0; for(let i=0;i<email.length;i++) h=(h*31+email.charCodeAt(i))&0xffff;
    return palette[h % palette.length];
  }

  function _renderAccountSwitcher() {
    const wrap = document.getElementById('accounts-list'); if (!wrap) return;
    wrap.innerHTML = '';
    S.accounts.forEach((acc, i) => {
      const isActive = i === S.accountIdx;
      const color = _acctColor(acc.email);
      const item = document.createElement('div');
      item.className = 'account-switch-item' + (isActive ? ' active' : '');
      item.innerHTML = `
        <div class="accsw-avatar" style="background:${color}">${acc.email[0].toUpperCase()}</div>
        <div class="accsw-info">
          <div class="accsw-email">${UI.esc(acc.email)}</div>
          <div class="accsw-prov">${acc.provider}</div>
        </div>
        ${isActive ? '<div class="accsw-check">✓</div>' : ''}
        <button class="accsw-remove" title="Remove account">✕</button>`;

      item.addEventListener('click', e => {
        if (e.target.closest('.accsw-remove')) return;
        document.getElementById('account-switcher-popup')?.classList.add('hidden');
        document.querySelector('.account-chip-wrap')?.classList.remove('popup-open');
        if (!isActive) _connectAccount(acc, i);
      });

      item.querySelector('.accsw-remove').addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Remove ${acc.email}?`)) return;
        S.accounts = S.accounts.filter((_,idx)=>idx!==i);
        try { await Vault.saveAccounts(S.accounts); } catch(_) {}
        document.getElementById('account-switcher-popup')?.classList.add('hidden');
        document.querySelector('.account-chip-wrap')?.classList.remove('popup-open');
        if (isActive) {
          if (S.accounts.length) await _connectAccount(S.accounts[0],0);
          else { S.inApp=false; _showSetup(false); }
        } else {
          if (i < S.accountIdx) S.accountIdx--;
          _renderAccountSwitcher();
        }
      });
      wrap.appendChild(item);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'account-switch-add';
    addBtn.innerHTML = '<span class="accsw-plus">＋</span> Add account';
    addBtn.addEventListener('click', () => {
      document.getElementById('account-switcher-popup')?.classList.add('hidden');
      document.querySelector('.account-chip-wrap')?.classList.remove('popup-open');
      _showSetup(true);
    });
    wrap.appendChild(addBtn);
  }

  // ── Background sync ───────────────────────────────────────────────────────
  async function _bgSyncAll() {
    if (S.preloadPromise) return S.preloadPromise;
    if (S.syncing) return;
    S.syncing=true;
    const order = (() => {
      const paths = S.folders.map(f => f.path).filter(Boolean);
      const first = S.inboxPath || _inboxPath();
      if (first && paths.includes(first)) return [first, ...paths.filter(p => p !== first)];
      return paths;
    })();
    S.preloadPromise = (async () => {
      for (const p of order) {
        if (!S.syncing) break;
        try { await _bgSyncFolder(p); } catch(_) {}
      }
    })();
    try {
      await S.preloadPromise;
      UI.setSync('done','All mail preloaded');
    } finally {
      S.preloadPromise = null;
      S.syncing = false;
    }
  }

  async function _bgSyncFolder(folder, untilPage) {
    if (!folder) return;
    const PS = ImapEngine.PAGE_SIZE;
    const meta = S.folderMeta[folder] || {};
    let cachedCount = ImapEngine.getAllCachedHeaders(folder).length;
    let cachedPages = cachedCount ? Math.ceil(cachedCount / PS) : 0;
    let totalPages = meta.totalPages || 0;
    let totalMsgs = meta.total || 0;

    // Ensure first page + totals exist.
    if (!totalPages || cachedPages === 0) {
      const first = await ImapEngine.fetchPage(folder,1,null,cachedPages===0).catch(()=>null);
      if (!first) { S.synced.delete(folder); return; }
      totalPages = first.totalPages || 1;
      totalMsgs = first.total || totalMsgs;
      S.folderMeta[folder] = { total: totalMsgs, totalPages, ts: Date.now() };
      cachedCount = ImapEngine.getAllCachedHeaders(folder).length;
      cachedPages = cachedCount ? Math.ceil(cachedCount / PS) : 0;
    }

    const target = Math.min(Math.max(untilPage || totalPages, 1), totalPages);
    let complete = true;
    for (let p = Math.max(1, cachedPages + 1); p <= target; p++) {
      let pageRes = null;
      for (let i=0; i<4 && !pageRes; i++) {
        pageRes = await ImapEngine.fetchPage(folder, p, null, false).catch(()=>null);
        if (!pageRes) await _sleep(90 + (i * 120));
      }
      if (!pageRes) { complete = false; break; }
      totalPages = pageRes.totalPages || totalPages;
      totalMsgs  = pageRes.total || totalMsgs;
      S.folderMeta[folder] = { total: totalMsgs, totalPages, ts: Date.now() };
      if (!pageRes.messages.length && p <= totalPages) { complete = false; break; }
      cachedCount = ImapEngine.getAllCachedHeaders(folder).length;
      cachedPages = cachedCount ? Math.ceil(cachedCount / PS) : 0;
      if (cachedPages >= target) break;
    }

    cachedCount = ImapEngine.getAllCachedHeaders(folder).length;
    cachedPages = cachedCount ? Math.ceil(cachedCount / PS) : 0;
    if (complete && totalPages > 0 && cachedPages >= totalPages) S.synced.add(folder);
    else S.synced.delete(folder);
  }

  function _sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

  // ── Wire buttons ──────────────────────────────────────────────────────────
  function _wireApp() {
    _on('rules-btn',_showRules); _on('move-rules-btn',_showMoveRules); _on('stats-btn',_showStats);
    _on('mr-add-btn',()=>_editMoveRule(null));
    _on('mr-save-btn',_saveMoveRule);
    _on('mr-cancel-btn',()=>document.getElementById('mr-edit-form')?.classList.add('hidden'));
    _on('refresh-folder-btn',()=>_loadFolder(S.folder,S.page,true));
    _on('bulk-delete-btn',_bulkDelete);
    _on('uncheck-all-btn',()=>UI.exitSelectionMode());

    // Account chip — event delegation so it works at any time
    document.addEventListener('click', e => {
      const wrap  = e.target.closest('.account-chip-wrap');
      const popup = document.getElementById('account-switcher-popup');
      if (wrap && popup && !e.target.closest('.accsw-remove') && !e.target.closest('.account-switch-item') && !e.target.closest('.account-switch-add')) {
        e.stopPropagation();
        const isOpen = !popup.classList.contains('hidden');
        popup.classList.toggle('hidden');
        wrap.classList.toggle('popup-open', !isOpen);
        if (!isOpen) { _renderAccountSwitcher(); }
        return;
      }
      // Close on outside click
      if (!e.target.closest('#account-switcher-popup') && !e.target.closest('.account-chip-wrap')) {
        popup?.classList.add('hidden');
        document.querySelector('.account-chip-wrap')?.classList.remove('popup-open');
      }
    });

    _on('reader-delete-btn',_deleteActive); _on('reader-archive-btn',_archiveActive);
    _on('reader-raw-btn',_showRawMail);
    _on('reader-spam-btn',_markActiveSpam); _on('reader-unsubscribe-btn',_unsubscribeActive);
    _on('ai-btn',_analyseActive); _on('ai-dismiss',()=>document.getElementById('ai-panel')?.classList.add('hidden'));
    _on('scan-done-btn',()=>{ UI.hideScan(); _loadFolder(S.folder,1,true); });
    _on('ai-cfg-btn',_openAISettings);
    _on('ai-settings-save',_saveAISettings); _on('save-rules-btn',_saveRules);
    _on('page-prev',()=>{ if(S.page>1) _loadFolder(S.folder,S.page-1); });
    _on('page-next',()=>{ if(S.page<S.totalPages) _loadFolder(S.folder,S.page+1); });

    // Compose
    _on('compose-btn',()=>_openCompose());
    _on('compose-send-btn',_sendCompose);
    _on('compose-attach-btn',()=>document.getElementById('compose-file-input')?.click());
    _on('compose-discard-btn',()=>{ document.getElementById('compose-overlay')?.classList.add('hidden'); _clearComposeAttachments(); });
    _on('compose-cc-toggle',()=>_toggleField('compose-cc-row'));
    _on('compose-bcc-toggle',()=>_toggleField('compose-bcc-row'));
    _on('compose-html-toggle',_toggleComposeHTML);
    ['bold','italic','underline','strikeThrough'].forEach(cmd=>_on('compose-fmt-'+cmd,()=>{document.getElementById('compose-richtext')?.focus();document.execCommand(cmd);}));
    _on('compose-fmt-link',()=>{ const url=prompt('URL:','https://'); if(!url) return; document.getElementById('compose-richtext')?.focus(); document.execCommand('createLink',false,url); });
    _on('compose-fmt-ul',()=>{document.getElementById('compose-richtext')?.focus();document.execCommand('insertUnorderedList');});
    _on('compose-fmt-ol',()=>{document.getElementById('compose-richtext')?.focus();document.execCommand('insertOrderedList');});
    document.getElementById('compose-file-input')?.addEventListener('change',_addComposeAttachment);
    _on('reader-reply-btn',_replyToActive);

    _on('reader-block-btn',e=>{ e.stopPropagation(); document.getElementById('block-menu')?.classList.toggle('hidden'); });
    document.addEventListener('click',()=>document.getElementById('block-menu')?.classList.add('hidden'));
    _on('block-by-addr',()=>_blockActive('email'));
    _on('block-by-subject',()=>_blockActive('subject'));
    _on('block-by-domain',()=>_blockActive('domain'));

    _on('theme-btn',()=>_openSettings(false));
    document.getElementById('notif-show-details')?.addEventListener('change', e => {
      Notifier.setShowDetails?.(!!e.target.checked);
    });
    _on('change-master-btn', _changeMasterPassword);
    _on('bg-image-btn',()=>document.getElementById('bg-image-file')?.click());
    document.getElementById('bg-image-file')?.addEventListener('change',e=>{
      const f=e.target.files[0]; if (!f) return;
      const r=new FileReader(); r.onload=ev=>{ Themes.setBgImage(ev.target.result); document.getElementById('bg-image-name').textContent=f.name; }; r.readAsDataURL(f);
    });
    _on('bg-image-clear-btn',()=>{ Themes.clearBgImage(); document.getElementById('bg-image-name').textContent='None'; document.getElementById('bg-image-file').value=''; });
    _on('settings-ai-save', _saveAISettings);

    _on('calendar-btn',_showCalendar); _on('cal-add-btn',_addCalendar);
    _on('cal-file-btn',()=>document.getElementById('cal-file-input')?.click());
    _on('cal-refresh-btn',async()=>{ await Calendar.refreshAll(); _renderCalView(); });
    document.getElementById('cal-file-input')?.addEventListener('change',async e=>{
      const f=e.target.files[0]; if (!f) return;
      await Calendar.loadFromFile(await f.text(), f.name.replace('.ics',''));
      _renderCalView();
    });

    let stimer;
    document.getElementById('search-box')?.addEventListener('input',e=>{
      clearTimeout(stimer); const q=e.target.value.trim();
      if (!q) { S.searchMode=false; _loadFolder(S.folder, S.page || 1); return; }
      stimer=setTimeout(()=>_doSearch(q,_searchOpts()),220);
    });
    ['search-field','search-match'].forEach(id=>{
      document.getElementById(id)?.addEventListener('change',()=>{
        S.searchOpts = _searchOpts();
        const q=document.getElementById('search-box')?.value.trim();
        if (q) _doSearch(q, S.searchOpts);
      });
    });
    const sf=document.getElementById('search-field'); if (sf) sf.value=S.searchOpts.field;
    const sm=document.getElementById('search-match'); if (sm) sm.value=S.searchOpts.match;
    UI.initTag('tw-domain','ti-domain','domain'); UI.initTag('tw-email','ti-email','email');
    UI.initTag('tw-name','ti-name','name'); UI.initTag('tw-subject','ti-subject','subject');
    UI.initTag('tw-body','ti-body','body');
  }

  function _on(id,fn) { document.getElementById(id)?.addEventListener('click',fn); }
  function _toggleField(rowId) {
    const row=document.getElementById(rowId); if (!row) return;
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) row.querySelector('input')?.focus();
  }

  function _searchOpts() {
    const field = document.getElementById('search-field')?.value || S.searchOpts.field || 'all';
    const match = document.getElementById('search-match')?.value || S.searchOpts.match || 'contains';
    return { field, match };
  }

  // ── Contacts cache for compose suggestions ───────────────────────────────
  let _contactBook = null;
  let _contactBookKey = '';

  function _contactsKey() {
    const email = (S.account?.email || 'default').toLowerCase();
    return `elve_contacts_${email}`;
  }

  function _loadContacts() {
    const key = _contactsKey();
    if (_contactBook && _contactBookKey === key) return _contactBook;
    _contactBookKey = key;
    _contactBook = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(raw)) {
        raw.forEach(c => {
          const email = String(c?.email || '').toLowerCase().trim();
          if (!email) return;
          _contactBook.set(email, {
            email,
            name: String(c?.name || '').trim(),
            lastSeen: Number(c?.lastSeen || 0),
            count: Number(c?.count || 0),
          });
        });
      }
    } catch(_) {}
    return _contactBook;
  }

  function _saveContacts(book) {
    if (!S.account || !book) return;
    const key = _contactsKey();
    const compact = [...book.values()]
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || (b.count || 0) - (a.count || 0))
      .slice(0, 500);
    try { localStorage.setItem(key, JSON.stringify(compact)); } catch(_) {}
  }

  function _extractContactTokens(headerValue) {
    const src = String(headerValue || '').replace(/\r?\n/g, ' ');
    const out = [];
    const seen = new Set();
    const re = /(?:"?([^"<>,]+?)"?\s*)?<\s*([^<>\s,;]+@[^<>\s,;]+)\s*>|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/ig;
    let m;
    while ((m = re.exec(src))) {
      const email = String(m[2] || m[3] || '').toLowerCase().trim();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      let name = String(m[1] || '').trim().replace(/^"|"$/g, '');
      if (!name || name.includes('@')) name = '';
      out.push({ email, name });
    }
    return out;
  }

  function _learnContacts(messages) {
    if (!S.account || !Array.isArray(messages) || !messages.length) return;
    const book = _loadContacts();
    let changed = false;
    messages.forEach(msg => {
      const ts = new Date(msg?.date || Date.now()).getTime() || Date.now();
      const tokens = [
        ..._extractContactTokens(msg?.from),
        ..._extractContactTokens(msg?.to),
      ];
      tokens.forEach(t => {
        const email = t.email;
        if (!email) return;
        const cur = book.get(email) || { email, name: '', lastSeen: 0, count: 0 };
        if (t.name && (!cur.name || cur.name.includes('@'))) cur.name = t.name;
        cur.lastSeen = Math.max(cur.lastSeen || 0, ts);
        cur.count = (cur.count || 0) + 1;
        book.set(email, cur);
        changed = true;
      });
    });
    if (!changed) return;
    _saveContacts(book);
    _refreshComposeSuggestions();
  }

  function _refreshComposeSuggestions() {
    const dl = document.getElementById('compose-to-suggestions');
    if (!dl) return;
    const book = _loadContacts();
    const top = [...book.values()]
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || (b.count || 0) - (a.count || 0))
      .slice(0, 120);
    dl.innerHTML = '';
    top.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.email;
      if (c.name && c.name.toLowerCase() !== c.email) opt.label = `${c.name} <${c.email}>`;
      dl.appendChild(opt);
    });
  }

  // ── Load folder — TRUE CACHE-FIRST ───────────────────────────────────────
  // If headers cached in memory/IndexedDB: render instantly, NO spinner.
  // Only shows spinner + hits IMAP when folder has never been fetched.
  async function _loadFolder(folder, page, forceRefresh) {
    page=Math.max(1,page||1);
    S.folder=folder; S.page=page; S.searchMode=false;
    const sb=document.getElementById('search-box'); if (sb) sb.value='';
    UI.exitSelectionMode(); UI.setActiveFolder(folder);
    _setTxt('folder-name-label',_folderLabel(folder));
    document.getElementById('ai-panel')?.classList.add('hidden');
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    const container=document.getElementById('email-list-container');

    try {
      if (folder==='__unread__') { await _loadUnread(page); return; }

      // Cache-first: if we have headers in memory/IndexedDB, render instantly.
      const cachedAll = ImapEngine.getAllCachedHeaders(folder);
      const hasCached = cachedAll.length>0 && !forceRefresh;

      if (hasCached) {
        // Slice the page we want and show immediately
        const ps=ImapEngine.PAGE_SIZE;
        let sourceAll = cachedAll;
        let cachePages = Math.max(1, Math.ceil(sourceAll.length/ps));
        const meta = S.folderMeta[folder];
        let knownTotal = Math.max(sourceAll.length, meta?.total || 0);
        const knownPages = Math.max(cachePages, meta?.totalPages || 0);
        // If user requested a page beyond what cache currently has, fetch that page from server.
        if (page > cachePages && knownPages > cachePages) {
          await _bgSyncFolder(folder, page);
          sourceAll = ImapEngine.getAllCachedHeaders(folder);
          cachePages = Math.max(1, Math.ceil(sourceAll.length/ps));
          const meta2 = S.folderMeta[folder];
          knownTotal = Math.max(sourceAll.length, meta2?.total || knownTotal);
        }

        if (page <= cachePages) {
          const pageStart=(page-1)*ps, pageEnd=pageStart+ps;
          const slice=sourceAll.slice(pageStart,pageEnd);
          const renderPages = Math.max(cachePages, S.folderMeta[folder]?.totalPages || knownPages);
          S.messages=slice; S.page=page; S.totalPages=renderPages; S.totalMsgs=knownTotal;
          if (S.messages.length) S.newestUid=Math.max(S.newestUid||0,...S.messages.map(m=>m.uid||0));
          _learnContacts(S.messages);
          const seen=new Set(S.allLoaded.map(m=>m.id));
          S.messages.forEach(m=>{ if(!seen.has(m.id)) S.allLoaded.push(m); });
          const {kept,deleted,moved}=_applyFilters([...S.messages]);
          S.messages=kept;
          _setTxt('msg-count',`${S.totalMsgs} · p${page}/${renderPages}`);
          _updatePager(page,renderPages); _renderList();
          S.unread[folder]=S.messages.filter(m=>m.unread).length; _renderNav();
          UI.setSync('done',`${S.messages.length} shown`);
          const uids=S.messages.map(m=>m.uid).filter(Boolean);
          if (uids.length) ImapEngine.prefetchBodies(folder,uids,null).catch(()=>{});
          if (deleted.length) _batchDelete(folder,deleted).catch(()=>{});
          if (moved.length)   _batchMove(folder,moved).catch(()=>{});
          _autoScanHighRisk(S.messages, folder).catch(()=>{});
          if (!S.synced.has(folder)) _bgSyncFolder(folder).catch(()=>{});
          return;
        }
      }

      // No cache: show spinner, fetch from IMAP
      container.innerHTML=`<div class="list-state"><div class="state-spinner"></div><div class="state-text">Loading…</div></div>`;
      UI.setSync('syncing',`Loading ${_folderLabel(folder)}…`);

      const res=await ImapEngine.fetchPage(folder,page,({seqStart,seqEnd,total})=>{
        container.innerHTML=`<div class="list-state"><div class="state-spinner"></div><div class="state-text">Fetching ${seqStart}–${seqEnd} of ${total}…</div></div>`;
      },forceRefresh);

      S.messages=res.messages; S.page=res.page; S.totalPages=res.totalPages; S.totalMsgs=res.total;
      S.folderMeta[folder] = { total: res.total, totalPages: res.totalPages, ts: Date.now() };
      S.stats.fetched=Math.max(S.stats.fetched,res.total);
      if (S.messages.length) S.newestUid=Math.max(S.newestUid||0,...S.messages.map(m=>m.uid||0));
      _learnContacts(S.messages);
      const seen=new Set(S.allLoaded.map(m=>m.id));
      S.messages.forEach(m=>{ if(!seen.has(m.id)) S.allLoaded.push(m); });
      const {kept,deleted,moved}=_applyFilters(S.messages); S.messages=kept;
      _setTxt('msg-count',`${S.totalMsgs} · p${S.page}/${S.totalPages}`);
      _updatePager(S.page,S.totalPages); _renderList();
      S.unread[folder]=S.messages.filter(m=>m.unread).length; _renderNav();

      const uids=S.messages.map(m=>m.uid).filter(Boolean);
      if (uids.length) {
        ImapEngine.prefetchBodies(folder,uids,({done,total})=>{
          if (done<total) { document.getElementById('sync-dot')?.setAttribute('class','sync-dot syncing'); _setTxt('sync-text',`Caching ${done}/${total}…`); }
        }).then(()=>{
          UI.setSync('done',`${S.messages.length} shown`);
          if (!S.synced.has(folder)) _bgSyncFolder(folder).catch(()=>{});
        }).catch(()=>UI.setSync('done',`${S.messages.length} shown`));
      } else { UI.setSync('done',`${S.messages.length} shown`); }
      if (deleted.length) _batchDelete(folder,deleted).catch(()=>{});
      if (moved.length)   _batchMove(folder,moved).catch(()=>{});
      _autoScanHighRisk(S.messages, folder).catch(()=>{});

    } catch(err) {
      console.error('[App]',err);
      container.innerHTML=`<div class="list-state"><div class="state-text" style="color:var(--danger)">⚠ ${UI.esc(err.message)}</div><button class="toolbar-btn" id="retry-btn" style="margin-top:8px">Retry</button></div>`;
      document.getElementById('retry-btn')?.addEventListener('click',()=>_loadFolder(folder,page,true));
      UI.setSync('error',err.message);
      if (/not auth|connect/i.test(err.message)) {
        UI.setSync('syncing','Reconnecting…');
        try { await ImapEngine.connect(S.account); await _loadFolder(folder,page,true); }
        catch(e2) { UI.setSync('error','Reconnect failed'); }
      }
    }
  }

  async function _loadUnread(page) {
    page = Math.max(1, page||1);
    const container = document.getElementById('email-list-container');
    const PS = ImapEngine.PAGE_SIZE;

    // Cache-first unread pagination from local INBOX cache when available.
    const inboxPath = S.folders.find(f => f.special === 'inbox')?.path || 'INBOX';
    const cached = ImapEngine.getAllCachedHeaders(inboxPath);
    if (cached.length > 0) {
      const allUnread = cached.filter(m => m.unread);
      const tp = Math.max(1, Math.ceil(allUnread.length / PS));
      const slice = allUnread.slice((page-1)*PS, page*PS);
      S.messages = slice; S.totalMsgs = allUnread.length;
      S.page = page; S.totalPages = tp;
      _learnContacts(S.messages);
      _setTxt('msg-count', `${allUnread.length} unread`);
      _updatePager(page, tp); _renderList();
      UI.setSync('done', `${allUnread.length} unread`);
      return;
    }

    // No cache yet — show spinner and ask IMAP
    container.innerHTML = `<div class="list-state"><div class="state-spinner"></div><div class="state-text">Loading unread…</div></div>`;
    try {
      const msgs = await ImapEngine.searchFolder(inboxPath, 'UNSEEN', true);
      const tp = Math.max(1, Math.ceil(msgs.length / PS));
      const slice = msgs.slice((page-1)*PS, page*PS);
      S.messages = slice; S.totalMsgs = msgs.length;
      S.page = page; S.totalPages = tp;
      _learnContacts(S.messages);
      _setTxt('msg-count', `${msgs.length} unread`); _updatePager(page, tp); _renderList();
      UI.setSync('done', `${msgs.length} unread`);
    } catch(e) {
      container.innerHTML = `<div class="list-state"><div class="state-text" style="color:var(--danger)">⚠ ${UI.esc(e.message)}</div></div>`;
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  function _applyFilters(messages) {
    const kept=[],deleted=[],moved=[],seen=new Map();
    S.allLoaded.forEach(m=>{
      if (m._kept === false) return;
      const k = _dupKey(m);
      if (k && !seen.has(k)) seen.set(k, m.id);
    });
    for (const msg of messages) {
      const k = _dupKey(msg);
      if (Rules.get().dupes?.enabled && k && seen.has(k) && seen.get(k)!==msg.id) {
        msg._deleteReason='duplicate'; msg._kept=false; deleted.push(msg); UI.removeRow(msg.id); continue;
      }
      if (k) seen.set(k, msg.id);
      const hits=Rules.check(msg);
      if (hits.length) { msg._deleteReason=`${hits[0].rule}:${hits[0].value}`;msg._kept=false;deleted.push(msg);UI.removeRow(msg.id);continue; }
      const mr=Rules.checkMove?.(msg);
      if (mr) { msg._moveTarget=mr.targetFolder;msg._kept=false;moved.push(msg);UI.removeRow(msg.id);continue; }
      msg._kept=true; kept.push(msg);
    }
    return {kept,deleted,moved};
  }
  function _ns(s) { return (s||'').toLowerCase().replace(/^(re|fwd?|fw|aw):\s*/gi,'').replace(/\s+/g,' ').trim(); }
  function _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }
  function _dupKey(msg) {
    const mid = (msg.messageId || '').toLowerCase().trim();
    if (mid) return 'mid:' + mid;
    const folder = msg.folder || S.folder;
    const cached = ImapEngine.getCachedBody?.(folder, msg.uid);
    const body = (cached?.text || cached?.html || msg.rawBody || '')
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const from = ImapEngine.extractAddr(msg.from || '');
    const sub = _ns(msg.subject);
    if (!from && !sub && !body) return '';
    return [from, sub, body ? _hash(body) : ''].join('|');
  }

  async function _autoScanHighRisk(messages, folder) {
    if (!Rules.get().aiscam?.enabled || !messages?.length) return;

    const batch = messages
      .filter(m => m.unread && !S.aiScanned.has(m.id))
      .slice(0, 8);
    if (!batch.length) return;

    batch.forEach(m => S.aiScanned.add(m.id));

    const flagged = [];
    for (const msg of batch) {
      try {
        const body = await ImapEngine.fetchBody(msg.folder || folder, msg.uid);
        const res = await AI.analyse({ ...msg, rawBody: body?.text || body?.html || '' });
        if (res.risk === 'HIGH') {
          msg._deleteReason = 'ai-high-risk';
          msg._kept = false;
          flagged.push(msg);
        }
      } catch(_) {}
    }

    if (!flagged.length) return;
    const ids = new Set(flagged.map(m => m.id));
    S.messages = S.messages.filter(m => !ids.has(m.id));
    S.allLoaded = S.allLoaded.filter(m => !ids.has(m.id));
    flagged.forEach(m => UI.removeRow(m.id));
    await _batchDelete(folder, flagged);
    UI.setSync('done', `AI auto-deleted ${flagged.length} high-risk email${flagged.length > 1 ? 's' : ''}`);
  }

  // ── Batch delete ──────────────────────────────────────────────────────────
  async function _batchDelete(folder,messages) {
    const byF={};
    messages.forEach(m=>{ const f=m.folder||folder; if(!byF[f]) byF[f]=[]; if(m.uid) byF[f].push(m.uid); });
    for (const [f,uids] of Object.entries(byF)) {
      if (!uids.length) continue;
      try {
        await ImapEngine.trashMessages(f,uids); S.stats.deleted+=uids.length;
        messages.filter(m=>(m.folder||folder)===f).forEach(m=>{
          if (m._deleteReason==='duplicate') S.stats.dupes++;
          if ((m._deleteReason||'').includes('scam') || (m._deleteReason||'').includes('ai-high-risk')) S.stats.scams++;
          _log(
            m._deleteReason==='duplicate'
              ? 'dup'
              : ((m._deleteReason||'').includes('scam') || (m._deleteReason||'').includes('ai-high-risk')) ? 'scam' : 'deleted',
               `"${(m.subject||'').slice(0,45)}" [${m._deleteReason}]`);
        });
        _savePersisted();
      } catch(e) { console.error('[App] delete',e.message); }
    }
  }

  async function _batchMove(folder, messages) {
    const byTarget = {};
    messages.forEach(m=>{
      const t=m._moveTarget, f=m.folder||folder;
      if(!t) return;
      if(!byTarget[t]) byTarget[t]={folder:f,uids:[]};
      if(m.uid) byTarget[t].uids.push(m.uid);
    });
    for (const [target,{folder:f,uids}] of Object.entries(byTarget)) {
      if(!uids.length) continue;
      try { await ImapEngine.moveToFolder(f,uids,target); _log('move',`${uids.length} msg → ${target}`); }
      catch(e) { console.error('[App] move',e.message); }
    }
  }

  function _renderList() { UI.renderEmailList(document.getElementById('email-list-container'),S.messages,S.activeMsg?.id,msg=>_openMsg(msg)); }

  async function _openMsg(msg) {
    const token = ++S.openMsgToken;
    S.activeMsg=msg; UI.showReader(msg); Notifier.clearBadge();
    try {
      const body=await ImapEngine.fetchBody(msg.folder||S.folder,msg.uid);
      if (token !== S.openMsgToken || !S.activeMsg || S.activeMsg.id !== msg.id) return;
      UI.setEmailBody(body,msg);
    } catch(e) {
      if (token !== S.openMsgToken || !S.activeMsg || S.activeMsg.id !== msg.id) return;
      UI.setEmailBody({html:null,text:'Error: '+e.message,attachments:[]},msg);
    }
  }

  async function _archiveActive() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg; S.activeMsg=null;
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    UI.removeRow(msg.id); S.messages=S.messages.filter(m=>m.id!==msg.id); S.allLoaded=S.allLoaded.filter(m=>m.id!==msg.id);
    try { await ImapEngine.archiveMessages(msg.folder||S.folder,[msg.uid]); _log('archive',`"${(msg.subject||'').slice(0,45)}"`); UI.setSync('done','Archived'); }
    catch(e) { UI.setSync('error','Archive error: '+e.message); }
  }

  async function _deleteActive() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg; S.activeMsg=null;
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    UI.removeRow(msg.id); S.messages=S.messages.filter(m=>m.id!==msg.id); S.allLoaded=S.allLoaded.filter(m=>m.id!==msg.id);
    msg._deleteReason='manual'; await _batchDelete(msg.folder||S.folder,[msg]);
  }

  async function _markActiveSpam() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg; S.activeMsg=null;
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');
    UI.removeRow(msg.id); S.messages=S.messages.filter(m=>m.id!==msg.id);
    S.allLoaded=S.allLoaded.filter(m=>m.id!==msg.id);
    try { await ImapEngine.markSpam(msg.folder||S.folder,[msg.uid]); _log('spam',`Marked spam: "${(msg.subject||'').slice(0,45)}"`); UI.setSync('done','Marked as spam'); }
    catch(e) { UI.setSync('error','Spam error: '+e.message); }
  }

  async function _unsubscribeActive() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg;
    let unsub=msg.listUnsub||'';
    let unsubPost=msg.listUnsubPost||'';
    const cached=ImapEngine.getCachedBody?.(msg.folder||S.folder,msg.uid);
    if (cached?.listUnsub) unsub=cached.listUnsub;
    if (cached?.listUnsubPost) unsubPost=cached.listUnsubPost;

    const links=[...unsub.matchAll(/<([^>]+)>/g)].map(m=>m[1].trim());
    const httpLink=links.find(v=>/^https?:/i.test(v));
    const mailtoLink=links.find(v=>/^mailto:/i.test(v));

    if (httpLink) {
      const ok = await _sendUnsubHttp(httpLink, unsubPost);
      if (ok) {
        UI.setSync('done','Unsubscribe request sent');
      } else if (typeof nw!=='undefined') {
        nw.Shell.openExternal(httpLink);
        UI.setSync('done','Opened unsubscribe link');
      } else {
        UI.setSync('error','Could not send unsubscribe request');
      }
      return;
    }

    if (mailtoLink) {
      const req = _parseMailto(mailtoLink);
      if (!req.to) { UI.setSync('error','No valid unsubscribe address'); return; }
      try {
        await SmtpClient.send(S.account, {
          to: req.to,
          subject: req.subject || 'Unsubscribe',
          text: req.body || 'Please unsubscribe me from this mailing list.',
        });
        UI.setSync('done',`Unsubscribe sent to ${req.to}`);
      } catch(_) {
        _openCompose(req.to, req.subject || 'Unsubscribe', req.body || 'Please remove me from this mailing list.\n\nThank you.');
        UI.setSync('done','Opened unsubscribe compose draft');
      }
      return;
    }

    UI.setSync('done','No unsubscribe link found');
  }

  function _parseMailto(mailtoUrl) {
    const _dec = v => { try { return decodeURIComponent(v || ''); } catch(_) { return v || ''; } };
    const raw = String(mailtoUrl || '').replace(/^mailto:/i, '');
    const [toPart, query=''] = raw.split('?');
    const params = new URLSearchParams(query);
    return {
      to: _dec(toPart).trim(),
      subject: _dec(params.get('subject') || 'Unsubscribe'),
      body: _dec(params.get('body') || 'Please unsubscribe me from this mailing list.'),
    };
  }

  async function _sendUnsubHttp(url, unsubPost) {
    const oneClick = /one-click/i.test(unsubPost || '');
    const method = oneClick ? 'POST' : 'GET';
    const body = oneClick ? 'List-Unsubscribe=One-Click' : null;

    // Browser fetch first (works in many providers with no-cors).
    try {
      const req = {
        method,
        mode: 'no-cors',
        keepalive: true,
      };
      if (oneClick) {
        req.body = body;
        req.headers = {'Content-Type':'application/x-www-form-urlencoded'};
      }
      await fetch(url, req);
      return true;
    } catch(_) {}

    // Node fallback for environments where renderer fetch is blocked.
    return new Promise(resolve => {
      try {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        const req = mod.request({
          method,
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          headers: oneClick ? {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(body.length),
          } : undefined,
        }, res => {
          res.on('data', ()=>{});
          res.on('end', () => resolve((res.statusCode || 500) < 500));
        });
        req.on('error', () => resolve(false));
        if (body) req.write(body);
        req.end();
      } catch(_) { resolve(false); }
    });
  }

  function _blockActive(by) {
    if (!S.activeMsg) return;
    document.getElementById('block-menu')?.classList.add('hidden');
    const msg=S.activeMsg, rules=Rules.get();
    if (by==='email') { const a=ImapEngine.extractAddr(msg.from||''); if(a){rules.email=rules.email||{enabled:true,list:[]};if(!rules.email.list.includes(a)){rules.email.list.push(a);rules.email.enabled=true;}} }
    else if (by==='domain') { const d=ImapEngine.extractAddr(msg.from||'').split('@')[1]||''; if(d){rules.domain=rules.domain||{enabled:true,list:[]};if(!rules.domain.list.includes(d)){rules.domain.list.push(d);rules.domain.enabled=true;}} }
    else if (by==='subject') { const s=_ns(msg.subject); if(s){rules.subject=rules.subject||{enabled:true,list:[]};if(!rules.subject.list.includes(s)){rules.subject.list.push(s);rules.subject.enabled=true;}} }
    Rules.save(rules); UI.setSync('done',`Blocked by ${by}`); _deleteActive();
  }

  async function _bulkDelete() {
    const ids=new Set(UI.getSelectedIds()); if (!ids.size) return;
    const msgs=S.messages.filter(m=>ids.has(m.id));
    msgs.forEach(m=>{ m._deleteReason='manual'; UI.removeRow(m.id); });
    S.messages=S.messages.filter(m=>!ids.has(m.id)); S.allLoaded=S.allLoaded.filter(m=>!ids.has(m.id));
    UI.exitSelectionMode(); await _batchDelete(S.folder,msgs);
  }

  async function _analyseActive() {
    if (!S.activeMsg) return;
    const btn=document.getElementById('ai-btn');
    if (btn) { btn.textContent='⏳ Analysing…'; btn.disabled=true; }
    try {
      const folder = S.activeMsg.folder || S.folder;
      let body = ImapEngine.getCachedBody?.(folder, S.activeMsg.uid);
      if (!body) {
        body = await ImapEngine.fetchBody(folder, S.activeMsg.uid).catch(() => null);
      }
      const result = await AI.analyse({ ...S.activeMsg, rawBody: body?.text || body?.html || '' });
      UI.showAIResult(result);
      if (result.risk==='HIGH'&&Rules.get().aiscam?.enabled) setTimeout(_deleteActive,2000);
    } catch(e) {
      UI.showAIResult({
        risk: 'ERROR',
        summary: e?.message || 'AI analysis failed.',
        indicators: ['Check AI provider settings and API key.'],
        engine: 'AI error',
      });
    } finally {
      if (btn) { btn.textContent='⚡ AI Analysis'; btn.disabled=false; }
    }
  }

  function _openSettings(focusAI) {
    Themes.buildPicker({
      grid:document.getElementById('theme-grid'), bgOpts:document.getElementById('bg-options'),
      swSlider:document.getElementById('sidebar-width-slider'), swVal:document.getElementById('sidebar-width-val'),
      tintInput:document.getElementById('custom-tint'), tintReset:document.getElementById('tint-reset-btn'),
      blurSlider:document.getElementById('bg-blur-slider'), blurVal:document.getElementById('bg-blur-val'),
      opacitySlider:document.getElementById('bg-opacity-slider'), opacityVal:document.getElementById('bg-opacity-val'),
      uiSlider:document.getElementById('ui-font-slider'), uiVal:document.getElementById('ui-font-val'),
      mailSlider:document.getElementById('mail-font-slider'), mailVal:document.getElementById('mail-font-val'),
    });
    const notifDetails=document.getElementById('notif-show-details');
    if (notifDetails) notifDetails.checked = Notifier.getShowDetails ? Notifier.getShowDetails() : true;

    const prov = document.getElementById('settings-ai-provider');
    const key  = document.getElementById('settings-ai-api-key');
    const base = document.getElementById('settings-ai-base-url');
    const mod  = document.getElementById('settings-ai-model');
    const baseRow = document.getElementById('settings-ai-baseurl-row');
    if (prov) prov.value = AI.getProvider();
    if (key)  key.value  = AI.getApiKey();
    if (base) base.value = AI.getBaseUrl();
    if (mod)  mod.value  = AI.getModel();
    const syncProviderUI = () => {
      const p = prov?.value || 'auto';
      if (baseRow) baseRow.classList.toggle('hidden', p !== 'openai' && p !== 'auto');
    };
    syncProviderUI();
    if (prov) prov.onchange = syncProviderUI;

    document.getElementById('theme-overlay')?.classList.remove('hidden');
    if (focusAI) {
      document.getElementById('settings-ai-section')?.scrollIntoView({ behavior:'smooth', block:'start' });
    }
  }

  function _openAISettings() {
    _openSettings(true);
  }

  function _saveAISettings() {
    const provEl =
      document.getElementById('settings-ai-provider') ||
      document.getElementById('ai-provider');
    const keyEl =
      document.getElementById('settings-ai-api-key') ||
      document.getElementById('ai-api-key');
    const baseEl =
      document.getElementById('settings-ai-base-url') ||
      document.getElementById('ai-base-url');
    const modelEl =
      document.getElementById('settings-ai-model') ||
      document.getElementById('ai-model');
    const prov = provEl?.value;
    const key = keyEl?.value.trim();
    const base = baseEl?.value.trim();
    const model = modelEl?.value.trim();
    if (prov != null) AI.setProvider(prov);
    AI.setApiKey(key || '');
    AI.setBaseUrl(base || '');
    AI.setModel(model || '');
    const st = document.getElementById('settings-ai-status') || document.getElementById('ai-settings-status');
    if (st) {
      st.textContent = '✓ Saved';
      setTimeout(() => { st.textContent = ''; }, 2000);
    }
  }

  // ── Compose — CC, BCC, From alias ────────────────────────────────────────
  const _composeAttachments=[];

  function _openCompose(to,subject,body,opts) {
    const _v=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v||''; };
    _v('compose-to',to); _v('compose-subject',subject); _v('compose-body',body);
    _v('compose-cc',opts?.cc||''); _v('compose-bcc',opts?.bcc||'');
    _setTxt('compose-status','');
    document.getElementById('compose-cc-row')?.classList.toggle('hidden',!opts?.cc);
    document.getElementById('compose-bcc-row')?.classList.toggle('hidden',!opts?.bcc);
    _composeIsHTML=false;
    const _htmlBtn=document.getElementById('compose-html-toggle');
    if(_htmlBtn){_htmlBtn.textContent='HTML';_htmlBtn.classList.remove('active');}
    document.getElementById('compose-rich-toolbar')?.classList.add('hidden');
    document.getElementById('compose-richtext')?.classList.add('hidden');
    document.getElementById('compose-body')?.classList.remove('hidden');
    _populateFromAliases();
    _refreshComposeSuggestions();
    _clearComposeAttachments();
    document.getElementById('compose-overlay')?.classList.remove('hidden');
    setTimeout(()=>(to?document.getElementById('compose-body'):document.getElementById('compose-to'))?.focus(),50);
  }

  function _populateFromAliases() {
    const sel=document.getElementById('compose-from'); if (!sel||!S.account) return;
    sel.innerHTML='';
    const primary=document.createElement('option'); primary.value=S.account.email; primary.textContent=S.account.email; sel.appendChild(primary);
    const key='elve_aliases_'+S.account.email;
    let aliases=[]; try { aliases=JSON.parse(localStorage.getItem(key)||'[]'); } catch(e) {}
    aliases.forEach(a=>{ const o=document.createElement('option'); o.value=a; o.textContent=a; sel.appendChild(o); });
    const mgr=document.createElement('option'); mgr.value='__manage__'; mgr.textContent='＋ Manage aliases…'; sel.appendChild(mgr);
    sel.onchange=()=>{ if(sel.value==='__manage__') { sel.value=S.account.email; _showAliasManager(); } };
  }

  function _showAliasManager() {
    document.getElementById('_alias-mgr')?.remove();
    const key='elve_aliases_'+S.account.email;
    let aliases=[]; try { aliases=JSON.parse(localStorage.getItem(key)||'[]'); } catch(e) {}
    const dlg=document.createElement('div'); dlg.id='_alias-mgr';
    dlg.style.cssText='position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
    dlg.innerHTML=`<div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:24px 28px;width:380px;max-width:94vw;box-shadow:0 20px 60px rgba(0,0,0,.5);">
      <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">Email Aliases</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:16px;">For ${UI.esc(S.account.email)}</div>
      <div id="_alias-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;max-height:200px;overflow-y:auto;"></div>
      <div style="display:flex;gap:8px;">
        <input id="_alias-new" type="email" placeholder="alias@yahoo.com" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:13px;">
        <button id="_alias-add-btn" style="padding:8px 14px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">Add</button>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <button id="_alias-close" style="padding:7px 18px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);cursor:pointer;font-size:13px;">Done</button>
      </div></div>`;
    document.body.appendChild(dlg);
    const renderList=()=>{
      const list=document.getElementById('_alias-list'); if (!list) return;
      list.innerHTML=aliases.length?aliases.map((a,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:8px;"><span style="flex:1;font-size:13px;color:var(--text)">${UI.esc(a)}</span><button data-i="${i}" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1;">×</button></div>`).join(''):'<div style="color:var(--text3);font-size:12px;padding:4px 0">No aliases yet</div>';
      list.querySelectorAll('[data-i]').forEach(btn=>btn.addEventListener('click',()=>{ aliases.splice(parseInt(btn.dataset.i),1); localStorage.setItem(key,JSON.stringify(aliases)); renderList(); _populateFromAliases(); }));
    };
    renderList();
    document.getElementById('_alias-add-btn').onclick=()=>{
      const v=document.getElementById('_alias-new')?.value.trim(); if(!v||!v.includes('@')) return;
      if(!aliases.includes(v)){aliases.push(v);localStorage.setItem(key,JSON.stringify(aliases));_populateFromAliases();}
      document.getElementById('_alias-new').value=''; renderList();
    };
    document.getElementById('_alias-new').onkeydown=e=>{if(e.key==='Enter')document.getElementById('_alias-add-btn').click();};
    document.getElementById('_alias-close').onclick=()=>dlg.remove();
    dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.remove();});
  }

  function _clearComposeAttachments() {
    _composeAttachments.length=0; _renderComposeAttachments();
    const fi=document.getElementById('compose-file-input'); if(fi) fi.value='';
  }
  function _addComposeAttachment(e) {
    [...(e.target.files||[])].forEach(f=>{ const r=new FileReader(); r.onload=ev=>{ _composeAttachments.push({name:f.name,type:f.type||'application/octet-stream',data:ev.target.result}); _renderComposeAttachments(); }; r.readAsArrayBuffer(f); });
    e.target.value='';
  }
  function _renderComposeAttachments() {
    const wrap=document.getElementById('compose-attachments'); if(!wrap) return;
    wrap.innerHTML=_composeAttachments.map((a,i)=>`<div class="compose-att-chip"><span>${UI.esc(a.name)}</span><button class="compose-att-x" data-i="${i}">×</button></div>`).join('');
    wrap.querySelectorAll('.compose-att-x').forEach(btn=>btn.addEventListener('click',()=>{ _composeAttachments.splice(parseInt(btn.dataset.i),1); _renderComposeAttachments(); }));
  }

  let _composeIsHTML = false;

  function _toggleComposeHTML() {
    _composeIsHTML = !_composeIsHTML;
    const btn=document.getElementById('compose-html-toggle');
    const plain=document.getElementById('compose-body');
    const rich=document.getElementById('compose-richtext');
    const toolbar=document.getElementById('compose-rich-toolbar');
    if (_composeIsHTML) {
      if(btn){btn.textContent='Plain';btn.classList.add('active');}
      toolbar?.classList.remove('hidden');
      rich?.classList.remove('hidden'); plain?.classList.add('hidden');
      if(rich&&plain) rich.innerHTML=plain.value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      rich?.focus();
    } else {
      if(btn){btn.textContent='HTML';btn.classList.remove('active');}
      toolbar?.classList.add('hidden');
      plain?.classList.remove('hidden'); rich?.classList.add('hidden');
      if(plain&&rich) plain.value=rich.innerText;
      plain?.focus();
    }
  }

  async function _sendCompose() {
    const to=document.getElementById('compose-to')?.value.trim();
    const cc=document.getElementById('compose-cc')?.value.trim()||'';
    const bcc=document.getElementById('compose-bcc')?.value.trim()||'';
    const from=document.getElementById('compose-from')?.value||S.account?.email;
    const subject=document.getElementById('compose-subject')?.value.trim();
    const rich=document.getElementById('compose-richtext');
    const body=_composeIsHTML&&rich ? rich.innerHTML : document.getElementById('compose-body')?.value;
    const isHtml=_composeIsHTML;
    const status=document.getElementById('compose-status');
    if (!to||!subject) { if(status) status.textContent='Fill in To and Subject'; return; }
    if (!S.account) { if(status) status.textContent='Not connected'; return; }
    const btn=document.getElementById('compose-send-btn');
    btn.disabled=true; btn.textContent='Sending…'; if(status) status.textContent='';
    try {
      await SmtpClient.send({...S.account,fromAlias:from},{to,cc,bcc,subject,
        text:isHtml?null:body, html:isHtml?body:null, attachments:_composeAttachments});
      _learnContacts([{
        from: from || S.account?.email || '',
        to: [to, cc, bcc].filter(Boolean).join(', '),
        date: Date.now(),
      }]);
      if(status) status.textContent='✓ Sent!';
      setTimeout(()=>{ document.getElementById('compose-overlay')?.classList.add('hidden'); btn.disabled=false; btn.textContent='Send ↗'; _clearComposeAttachments(); },1500);
    } catch(e) { if(status) status.textContent='⚠ '+e.message; btn.disabled=false; btn.textContent='Send ↗'; }
  }

  function _replyToActive() {
    if (!S.activeMsg) return;
    const addr=ImapEngine.extractAddr(S.activeMsg.from||'');
    const subj=(S.activeMsg.subject||'').startsWith('Re:')?S.activeMsg.subject:'Re: '+(S.activeMsg.subject||'');
    _openCompose(addr,subj);
  }

  function _escRe(s) { return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function _isExactMatch(text, q) {
    const hay = String(text || '').toLowerCase();
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return true;
    const re = new RegExp(`(^|\\W)${_escRe(needle)}(\\W|$)`, 'i');
    return re.test(hay);
  }
  function _searchTextFor(msg, field) {
    const folder = msg.folder || S.folder;
    const body = ImapEngine.getCachedBody?.(folder, msg.uid);
    const bodyTxt = (body?.text || body?.html || '').replace(/<[^>]+>/g, ' ').slice(0, 5000);
    const blobs = {
      subject: msg.subject || '',
      from: msg.from || '',
      body: bodyTxt,
      all: [msg.subject || '', msg.from || '', bodyTxt].join(' '),
    };
    return blobs[field] ?? blobs.all;
  }
  function _matchSearch(msg, q, opts) {
    const field = opts?.field || 'all';
    const mode = opts?.match || 'contains';
    const text = _searchTextFor(msg, field).toLowerCase();
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return true;
    return mode === 'exact' ? _isExactMatch(text, needle) : text.includes(needle);
  }
  function _unreadPool() {
    const inboxPath = S.folders.find(f => f.special === 'inbox')?.path || 'INBOX';
    const cached = ImapEngine.getAllCachedHeaders(inboxPath);
    if (cached.length) return cached.filter(m => m.unread);
    return (S.messages || []).filter(m => m.unread);
  }

  // ── Search ────────────────────────────────────────────────────────────────
  async function _doSearch(q, opts) {
    S.searchMode=true;
    const use = opts || _searchOpts();
    S.searchOpts = use;

    if (S.folder === '__unread__') {
      const localUnread = _unreadPool().filter(m => _matchSearch(m, q, use));
      S.messages = localUnread;
      _setTxt('msg-count', `${localUnread.length} unread results`);
      _updatePager(1,1);
      _renderList();
      return;
    }

    const local = ImapEngine.getAllCachedHeaders(S.folder).filter(m => _matchSearch(m, q, use));
    if (local.length>0) {
      S.messages=local;
      _setTxt('msg-count',`${local.length} local results`);
      _updatePager(1,1);
      _renderList();
      return;
    }

    const container=document.getElementById('email-list-container');
    container.innerHTML='<div class="list-state"><div class="state-spinner"></div><div class="state-text">Searching server…</div></div>';
    try {
      const results=await ImapEngine.searchFolder(S.folder,q,false,use);
      S.messages=results;
      _setTxt('msg-count',results.length+' results');
      _updatePager(1,1);
      _renderList();
    } catch(e) {
      S.messages=S.allLoaded.filter(m=>_matchSearch(m,q,use));
      _setTxt('msg-count',S.messages.length+' local results');
      _renderList();
    }
  }

  // ── New mail banner ───────────────────────────────────────────────────────
  function _showNewMailBanner(count) {
    let b=document.getElementById('new-mail-banner');
    if (!b) {
      b=document.createElement('div'); b.id='new-mail-banner';
      Object.assign(b.style,{position:'fixed',top:'16px',left:'50%',transform:'translateX(-50%)',background:'var(--accent)',color:'#fff',padding:'9px 22px',borderRadius:'20px',fontSize:'13px',fontWeight:'700',boxShadow:'0 4px 20px var(--accent-glow)',zIndex:'9999',cursor:'pointer'});
      b.addEventListener('click',()=>{ b.remove(); _loadFolder(_inboxPath(),1,true); });
      document.getElementById('app-screen')?.appendChild(b);
    }
    b.textContent=`↓ ${count} new message${count>1?'s':''} — click to load`;
    clearTimeout(b._t); b._t=setTimeout(()=>b.remove(),8000);
  }

  function _prependMessages(msgs, folderPath) {
    const inboxPath = folderPath || _inboxPath();
    const fresh = msgs.filter(m => !S.messages.find(x => x.id === m.id));
    if (!fresh.length) return;
    _learnContacts(fresh);
    S.messages  = [...fresh, ...S.messages];
    S.allLoaded = [...fresh, ...S.allLoaded];
    S.newestUid = Math.max(S.newestUid||0, ...fresh.map(m => m.uid||0));
    const meta = S.folderMeta[inboxPath] || { total: S.totalMsgs || S.messages.length, totalPages: S.totalPages || 1 };
    meta.total = Math.max(0, (meta.total || 0) + fresh.length);
    meta.totalPages = Math.max(1, Math.ceil(meta.total / ImapEngine.PAGE_SIZE));
    meta.ts = Date.now();
    S.folderMeta[inboxPath] = meta;
    S.totalMsgs = meta.total;
    S.totalPages = meta.totalPages;
    S.unread[inboxPath] = (S.unread[inboxPath]||0) + fresh.filter(m => m.unread).length;
    _renderNav();
    _setTxt('msg-count', `${S.totalMsgs} · p${S.page}/${S.totalPages}`);
    _updatePager(S.page, S.totalPages);

    // Insert new rows at top of list without re-rendering everything
    const container = document.getElementById('email-list-container');
    if (!container) { _renderList(); return; }

    // If list is currently showing something (not a spinner/empty state), prepend rows
    const firstRow = container.querySelector('.email-row');
    const frag = document.createDocumentFragment();
    fresh.forEach(msg => {
      // Re-use UI row builder by temporarily rendering just these messages
      const tmpDiv = document.createElement('div');
      UI.renderEmailList(tmpDiv, [msg], S.activeMsg?.id, m => _openMsg(m));
      const row = tmpDiv.querySelector('.email-row');
      if (row) {
        // Slide-in animation
        row.style.opacity = '0';
        row.style.transform = 'translateY(-12px)';
        row.style.transition = 'opacity .25s ease, transform .25s ease';
        frag.appendChild(row);
        requestAnimationFrame(() => {
          row.style.opacity = '1';
          row.style.transform = 'translateY(0)';
        });
      }
    });

    if (firstRow) {
      container.insertBefore(frag, firstRow);
    } else {
      container.appendChild(frag);
    }
  }

  function _updatePager(page,totalPages) {
    const el=document.getElementById('pager'); if(!el) return;
    if (!totalPages||totalPages<=1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); _setTxt('page-info',`Page ${page} of ${totalPages}`);
    document.getElementById('page-prev').disabled=page<=1;
    document.getElementById('page-next').disabled=page>=totalPages;
  }

  async function _showRawMail() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg;
    const folder = msg.folder || S.folder;
    const cached = ImapEngine.getCachedBody?.(folder, msg.uid);
    const dlg=document.createElement('div'); dlg.id='_raw-dlg';
    dlg.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px;';
    dlg.innerHTML=`<div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;width:760px;max-width:98vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
        <span style="font-weight:700;color:var(--text);font-size:14px">📋 Raw Message</span>
        <button id="_raw-close" style="background:none;border:none;font-size:20px;color:var(--text3);cursor:pointer;line-height:1;padding:0;">×</button>
      </div>
      <pre id="_raw-pre" style="flex:1;overflow:auto;margin:0;padding:18px 20px;font-family:'Fira Mono',Consolas,monospace;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-all;color:var(--text2);background:var(--surface2);">Loading…</pre>
    </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.remove();});
    document.getElementById('_raw-close').onclick=()=>dlg.remove();
    const pre=document.getElementById('_raw-pre');
    const hdr=['From: '+(msg.from||''),'To: '+(msg.to||''),'Subject: '+(msg.subject||''),'Date: '+(msg.date?new Date(msg.date).toUTCString():''),'Message-ID: '+(msg.messageId||''),'Folder: '+folder,'UID: '+(msg.uid||'')].join('\n');
    try {
      const raw = await ImapEngine.fetchRawSource(folder, msg.uid);
      const headerBlob = raw?.headers || '';
      const routeIps = _extractRouteIps(headerBlob);
      const ipBlock = routeIps.length
        ? routeIps.map((r, i) => `${i + 1}. [${r.source}] ${r.ip}`).join('\n')
        : '(No routing IP headers found in this message)';
      const bodyText = raw?.body || cached?.text || cached?.html || '(body unavailable)';
      pre.textContent =
        hdr +
        '\n\n--- Routing IP Details ---\n' + ipBlock +
        '\n\n--- Raw Headers ---\n' + (headerBlob || '(no raw headers available)') +
        '\n\n--- Body ---\n' + bodyText;
    } catch(e) {
      pre.textContent =
        hdr +
        '\n\n--- Routing IP Details ---\n(unavailable: could not fetch raw source)' +
        '\n\n--- Body ---\n' + (cached?.text || cached?.html || '(body not yet cached — open the message first to cache it)');
    }
  }

  function _extractRouteIps(rawHeaders) {
    const folded = (rawHeaders || '').replace(/\r\n[ \t]+/g, ' ');
    const lines = folded.split(/\r\n/).filter(line => /^(received|x-originating-ip|x-forwarded-for):/i.test(line));
    const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    const ipv6 = /\b(?:[a-f0-9]{1,4}:){3,7}[a-f0-9]{1,4}\b/ig;
    const out = [];
    const seen = new Set();

    lines.forEach(line => {
      const source = (line.split(':')[0] || 'header').toLowerCase();
      const vals = [...(line.match(ipv4) || []), ...(line.match(ipv6) || [])];
      vals.forEach(ip => {
        const v = ip.replace(/^\[|\]$/g, '');
        if (!v || seen.has(v.toLowerCase())) return;
        seen.add(v.toLowerCase());
        out.push({ source, ip: v });
      });
    });
    return out;
  }

  function _showMoveRules() {
    document.getElementById('move-rules-overlay')?.classList.remove('hidden');
    _renderMoveRulesList();
  }
  function _renderMoveRulesList() {
    const wrap=document.getElementById('mr-list'); if(!wrap) return;
    const rules=Rules.getMoveRules();
    if(!rules.length){ wrap.innerHTML='<div class="mr-empty">No move rules yet. Click "New Rule" to add one.</div>'; return; }
    wrap.innerHTML='';
    rules.forEach((rule,i)=>{
      const row=document.createElement('div'); row.className='mr-row';
      row.innerHTML=`<div class="mr-row-left">
        <input type="checkbox" class="mr-enabled rule-chk" ${rule.enabled?'checked':''}>
        <div class="mr-row-info">
          <div class="mr-row-name">${UI.esc(rule.name||'Unnamed')}</div>
          <div class="mr-row-meta">${UI.esc(rule.field||'subject')} contains "<em>${UI.esc((rule.keywords||[]).slice(0,3).join(', '))}</em>" → 📁 ${UI.esc(rule.targetFolder||'?')}</div>
        </div>
      </div>
      <div class="mr-row-btns">
        <button class="mr-btn mr-edit" data-i="${i}">Edit</button>
        <button class="mr-btn mr-del" data-i="${i}">🗑</button>
      </div>`;
      row.querySelector('.mr-enabled').onchange=e=>Rules.updateMoveRule(rule.id,{enabled:e.target.checked});
      row.querySelector('.mr-edit').onclick=()=>_editMoveRule(i);
      row.querySelector('.mr-del').onclick=()=>{ if(confirm('Delete rule "'+rule.name+'"?')){ Rules.deleteMoveRule(rule.id); _renderMoveRulesList(); }};
      wrap.appendChild(row);
    });
  }
  function _editMoveRule(idx) {
    const rule=idx!=null?Rules.getMoveRules()[idx]:null;
    document.getElementById('mr-id').value=rule?.id||'';
    document.getElementById('mr-name').value=rule?.name||'';
    document.getElementById('mr-field').value=rule?.field||'subject';
    document.getElementById('mr-keywords').value=(rule?.keywords||[]).join(', ');
    // Populate target folder dropdown from current account's folders
    const sel=document.getElementById('mr-target');
    sel.innerHTML=S.folders.filter(f=>f.special!=='inbox'||true).map(f=>`<option value="${UI.esc(f.path)}"${rule?.targetFolder===f.path?' selected':''}>${UI.esc(f.name||f.path)}</option>`).join('');
    if(rule?.targetFolder) sel.value=rule.targetFolder;
    document.getElementById('mr-edit-panel')?.classList.remove('hidden');
    document.getElementById('mr-name').focus();
  }
  function _saveMoveRule() {
    const id=document.getElementById('mr-id').value;
    const name=(document.getElementById('mr-name').value||'').trim()||'Rule';
    const field=document.getElementById('mr-field').value;
    const kws=document.getElementById('mr-keywords').value.split(',').map(k=>k.trim()).filter(Boolean);
    const target=document.getElementById('mr-target').value;
    if(!target){UI.setSync('error','Select a target folder');return;}
    if(!kws.length){UI.setSync('error','Enter at least one keyword');return;}
    const rule={id,name,enabled:true,field,keywords:kws,targetFolder:target};
    if(id) Rules.updateMoveRule(id,rule); else Rules.addMoveRule(rule);
    document.getElementById('mr-edit-panel')?.classList.add('hidden');
    _renderMoveRulesList();
    UI.setSync('done','Move rule saved');
  }

  async function _createFolder() {
    if (!S.account) return;
    const raw = prompt('New folder name\n(Use "/" to create nested folders)');
    if (!raw) return;
    let name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    if (!name.includes('/') && S.folder && !['INBOX','__unread__'].includes(S.folder)) {
      const nest = confirm(`Create inside "${_folderLabel(S.folder)}"?`);
      if (nest) name = `${S.folder}/${name}`;
    }
    try {
      const created = await ImapEngine.createFolder(name);
      delete S.folderMeta[created];
      S.synced.delete(created);
      S.folders = await ImapEngine.listFolders();
      _renderNav();
      UI.setSync('done', `Folder created: ${_folderLabel(created)}`);
    } catch(e) {
      UI.setSync('error', 'Create folder failed: ' + e.message);
    }
  }

  function _cleanFolderPath(v) {
    return String(v || '').trim().replace(/^\/+|\/+$/g, '');
  }

  async function _renameFolderAction(path) {
    const from = _cleanFolderPath(path);
    if (!from) return;
    const leaf = from.split('/').pop();
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const nextLeafRaw = prompt('Rename folder', leaf);
    if (nextLeafRaw == null) return;
    const nextLeaf = _cleanFolderPath(nextLeafRaw).split('/').pop();
    if (!nextLeaf) return;
    const to = parent ? `${parent}/${nextLeaf}` : nextLeaf;
    if (to === from) return;
    await ImapEngine.renameFolder(from, to);
    if (S.folderMeta[from]) {
      S.folderMeta[to] = S.folderMeta[from];
      delete S.folderMeta[from];
    }
    if (S.unread[from] != null) {
      S.unread[to] = S.unread[from];
      delete S.unread[from];
    }
    if (S.synced.has(from)) { S.synced.delete(from); S.synced.add(to); }
    S.folders = await ImapEngine.listFolders();
    _renderNav();
    if (S.folder === from || S.folder.startsWith(from + '/')) {
      const mapped = to + S.folder.slice(from.length);
      await _loadFolder(mapped, 1, true);
    }
    UI.setSync('done', `Folder renamed: ${_folderLabel(to)}`);
  }

  async function _deleteFolderAction(path) {
    const p = _cleanFolderPath(path);
    if (!p) return;
    if (!confirm(`Delete folder "${_folderLabel(p)}"?`)) return;
    await ImapEngine.deleteFolder(p);
    delete S.folderMeta[p];
    S.synced.delete(p);
    delete S.unread[p];
    S.folders = await ImapEngine.listFolders();
    _renderNav();
    if (S.folder === p || S.folder.startsWith(p + '/')) {
      await _loadFolder(_inboxPath(), 1, true);
    }
    UI.setSync('done', `Folder deleted: ${_folderLabel(p)}`);
  }

  async function _moveFolderAction(path) {
    const from = _cleanFolderPath(path);
    if (!from) return;
    const leaf = from.split('/').pop();
    const currentParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const validParents = S.folders
      .map(f => f.path)
      .filter(p => p !== from && !p.startsWith(from + '/'))
      .sort();
    const sample = validParents.slice(0, 15).join('\n');
    const raw = prompt(`Move "${leaf}" under folder path (blank = root)\n\nExamples:\n${sample || '(no other folders)'}`, currentParent);
    if (raw == null) return;
    const parent = _cleanFolderPath(raw);
    if (parent && !validParents.includes(parent)) {
      UI.setSync('error', 'Target parent folder does not exist');
      return;
    }
    const to = parent ? `${parent}/${leaf}` : leaf;
    if (to === from) return;
    await ImapEngine.renameFolder(from, to);
    if (S.folderMeta[from]) {
      S.folderMeta[to] = S.folderMeta[from];
      delete S.folderMeta[from];
    }
    if (S.unread[from] != null) {
      S.unread[to] = S.unread[from];
      delete S.unread[from];
    }
    if (S.synced.has(from)) { S.synced.delete(from); S.synced.add(to); }
    S.folders = await ImapEngine.listFolders();
    _renderNav();
    if (S.folder === from || S.folder.startsWith(from + '/')) {
      const mapped = to + S.folder.slice(from.length);
      await _loadFolder(mapped, 1, true);
    }
    UI.setSync('done', `Folder moved to: ${_folderLabel(to)}`);
  }

  async function _handleFolderAction(action, folderPath) {
    if (!S.account || !folderPath) return;
    try {
      if (action === 'rename') await _renameFolderAction(folderPath);
      else if (action === 'delete') await _deleteFolderAction(folderPath);
      else if (action === 'move') await _moveFolderAction(folderPath);
    } catch(e) {
      UI.setSync('error', `Folder action failed: ${e.message}`);
    }
  }

  async function _changeMasterPassword() {
    const currentRaw = prompt('Current master password');
    if (currentRaw == null) return;
    const current = currentRaw.trim();
    if (!current) {
      _setTxt('master-change-status', 'Enter current password');
      setTimeout(() => _setTxt('master-change-status', ''), 2600);
      return;
    }
    const check = await Vault.verifyPassword(current);
    if (!check?.ok) {
      _setTxt('master-change-status', check?.error || 'Wrong current password');
      setTimeout(() => _setTxt('master-change-status', ''), 3000);
      return;
    }

    const nextRaw = prompt('New master password');
    if (nextRaw == null) return;
    const next = nextRaw.trim();
    if (!next) {
      _setTxt('master-change-status', 'Enter new password');
      setTimeout(() => _setTxt('master-change-status', ''), 2600);
      return;
    }
    const confirmPw = (prompt('Confirm new master password') || '').trim();
    if (next !== confirmPw) {
      _setTxt('master-change-status', 'Passwords do not match');
      setTimeout(() => _setTxt('master-change-status', ''), 2600);
      return;
    }
    if (next.length < 6) {
      _setTxt('master-change-status', 'Use at least 6 characters');
      setTimeout(() => _setTxt('master-change-status', ''), 2600);
      return;
    }
    try {
      const r = await Vault.changePassword(current, next);
      if (r?.ok) {
        _setTxt('master-change-status', '✓ Master password changed');
      } else {
        _setTxt('master-change-status', r?.error || 'Failed to change password');
      }
    } catch(e) {
      _setTxt('master-change-status', 'Error: ' + e.message);
    }
    setTimeout(() => _setTxt('master-change-status', ''), 3000);
  }

  function _showRules() {
    const r=Rules.get();
    ['domain','email','name','subject','body'].forEach(k=>{ const el=document.getElementById('r-'+k); if(el) el.checked=r[k]?.enabled||false; UI.setTags(k,r[k]?.list||[]); UI.refreshTags('tw-'+k,'ti-'+k,k); });
    document.getElementById('r-dupes').checked=r.dupes?.enabled!==false;
    document.getElementById('r-aiscam').checked=r.aiscam?.enabled||false;
    document.getElementById('rules-overlay')?.classList.remove('hidden');
  }
  function _saveRules() {
    const r={dupes:{enabled:document.getElementById('r-dupes').checked},aiscam:{enabled:document.getElementById('r-aiscam').checked}};
    ['domain','email','name','subject','body'].forEach(k=>{ r[k]={enabled:document.getElementById('r-'+k).checked,list:UI.getTags(k)}; });
    Rules.save(r); document.getElementById('rules-overlay')?.classList.add('hidden'); UI.setSync('done','Filters saved');
    if (S.messages.length) { const {kept,deleted}=_applyFilters([...S.messages]); S.messages=kept; _renderList(); if(deleted.length) _batchDelete(S.folder,deleted); }
  }

  function _showStats() {
    UI.updateStats(S.stats);
    const c=document.getElementById('log-container');
    if(c){c.innerHTML=S.log.length?'':'<div class="log-empty">No activity yet</div>';[...S.log].reverse().slice(0,150).forEach(e=>UI.addLog(e));}
    document.getElementById('stats-overlay')?.classList.remove('hidden');
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  function _showCalendar() { _renderCalView(); document.getElementById('calendar-overlay')?.classList.remove('hidden'); }

  function _renderCalView() {
    const events=Calendar.getEventsForMonth(S.calYear,S.calMonth);
    const container=document.getElementById('cal-grid-container'); if (!container) return;
    UI.renderCalendar(container,S.calYear,S.calMonth,events);
    document.getElementById('cal-prev')?.addEventListener('click',()=>{ S.calMonth--; if(S.calMonth<0){S.calMonth=11;S.calYear--;} _renderCalView(); });
    document.getElementById('cal-next')?.addEventListener('click',()=>{ S.calMonth++; if(S.calMonth>11){S.calMonth=0;S.calYear++;} _renderCalView(); });
    container.querySelectorAll('.cal-cell[data-day]').forEach(cell=>{
      cell.addEventListener('click',()=>{
        const evs=Calendar.getEventsForDay(new Date(S.calYear,S.calMonth,parseInt(cell.dataset.day)));
        const detail=document.getElementById('cal-day-detail'); if (!detail) return;
        if (!evs.length) { detail.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px">No events</div>'; return; }
        detail.innerHTML=evs.map((ev,i)=>`
          <div class="cal-detail-event" data-ei="${i}" style="border-left:3px solid ${ev.color};cursor:pointer">
            <div class="cde-title">${UI.esc(ev.summary)}</div>
            <div class="cde-time">${ev.allDay?'All day':ev.start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}${ev.location?' · '+UI.esc(ev.location):''}${ev.calendar?' · <em>'+UI.esc(ev.calendar)+'</em>':''}</div>
            ${ev.description?`<div class="cde-desc">${UI.esc(ev.description.slice(0,100))}${ev.description.length>100?'…':''}</div>`:''}
            <div style="font-size:11px;color:var(--accent);margin-top:3px">Click to view full details →</div>
          </div>`).join('');
        detail.querySelectorAll('.cal-detail-event').forEach(el=>{
          el.addEventListener('click',()=>_openCalEventDlg(evs[parseInt(el.dataset.ei)]));
        });
      });
    });
    const calList=document.getElementById('cal-list');
    if (calList) {
      calList.innerHTML=Calendar.calendars.map(c=>`<div class="cal-list-item"><span class="cal-list-dot" style="background:${c.color}"></span><span class="cal-list-name">${UI.esc(c.name)}</span><button class="cal-list-remove" data-name="${UI.esc(c.name)}">×</button></div>`).join('')||'<div style="color:var(--text3);font-size:12px">No calendars</div>';
      calList.querySelectorAll('.cal-list-remove').forEach(btn=>btn.addEventListener('click',()=>{ Calendar.removeCalendar(btn.dataset.name); _renderCalView(); }));
    }
  }

  function _openCalEventDlg(ev) {
    document.getElementById('_cal-ev-dlg')?.remove();
    const fmt = (d, allDay) => {
      if (!d) return '';
      if (allDay) return d.toLocaleDateString([], {weekday:'long', year:'numeric', month:'long', day:'numeric'});
      return d.toLocaleString([], {weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'});
    };
    const fmtShort = (d, allDay) => {
      if (!d) return '';
      if (allDay) return d.toLocaleDateString([], {month:'short', day:'numeric'});
      return d.toLocaleString([], {hour:'2-digit', minute:'2-digit'});
    };

    const dlg = document.createElement('div'); dlg.id='_cal-ev-dlg';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px;';
    dlg.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:18px;width:600px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;">
        <!-- Header -->
        <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="width:14px;height:14px;border-radius:50%;background:${ev.color};margin-top:5px;flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:18px;font-weight:700;color:var(--text);line-height:1.3;word-break:break-word;">${UI.esc(ev.summary)}</div>
              <div style="font-size:13px;color:var(--text2);margin-top:6px;display:flex;flex-direction:column;gap:3px;">
                <div>📅 ${UI.esc(fmt(ev.start, ev.allDay))}${ev.end?' → '+UI.esc(fmtShort(ev.end, ev.allDay)):''}</div>
                ${ev.location ? `<div>📍 ${UI.esc(ev.location)}</div>` : ''}
                ${ev.organizer ? `<div>👤 Organizer: ${UI.esc(ev.organizer)}</div>` : ''}
                ${ev.attendees && ev.attendees.length ? `<div>👥 ${ev.attendees.slice(0,4).map(a=>UI.esc(a)).join(', ')}${ev.attendees.length>4?' +${ev.attendees.length-4} more':''}</div>` : ''}
                ${ev.calendar ? `<div style="color:var(--text3)">📁 ${UI.esc(ev.calendar)}</div>` : ''}
              </div>
            </div>
            <button id="_cal-ev-close" style="background:none;border:none;font-size:22px;color:var(--text3);cursor:pointer;flex-shrink:0;line-height:1;padding:0;margin-top:-2px;">×</button>
          </div>
        </div>
        <!-- Body: description rendered as styled HTML -->
        <div id="_cal-ev-body" style="flex:1;min-height:200px;overflow:hidden;position:relative;">
          <iframe id="_cal-ev-iframe" style="width:100%;height:100%;min-height:200px;border:none;position:absolute;inset:0;"></iframe>
        </div>
        <!-- Footer -->
        <div style="padding:12px 20px;border-top:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;justify-content:flex-end;">
          <button id="_cal-ev-done" style="padding:7px 18px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);cursor:pointer;font-size:13px;">Close</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    document.getElementById('_cal-ev-close').onclick = () => dlg.remove();
    document.getElementById('_cal-ev-done').onclick  = () => dlg.remove();
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });

    // Build description HTML — escape text FIRST then linkify
    const rawDesc = ev.description || '';
    const bodyHtml = rawDesc.trim()
      ? rawDesc
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n/g, '\n')  // keep newlines as-is for <pre> rendering
          .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1">$1</a>')
      : '';

    const iframeHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;height:100%;}
      body{padding:20px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.75;color:#1a1a2e;background:#fff;word-break:break-word;overflow-y:auto;box-sizing:border-box;}
      a{color:#6c63ff;text-decoration:underline;cursor:pointer;}
      a:hover{color:#8b84ff;}
      p{margin:0 0 10px;}
      .empty{color:#999;font-style:italic;padding-top:4px;}
    </style></head><body>${
      bodyHtml
        ? `<div style="white-space:pre-wrap;">${bodyHtml}</div>`
        : '<span class="empty">No description provided.</span>'
    }</body></html>`;

    // Write to iframe — use srcdoc to avoid sandbox issues
    const iframe = document.getElementById('_cal-ev-iframe');
    if (iframe) {
      try {
        // srcdoc approach works without sandbox restrictions for content display
        iframe.srcdoc = iframeHtml;
        // Wire links after load
        iframe.addEventListener('load', () => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc) return;
            doc.querySelectorAll('a[href]').forEach(a => {
              a.addEventListener('click', e => {
                e.preventDefault();
                const h = a.getAttribute('href');
                if (!h) return;
                if (typeof nw !== 'undefined') nw.Shell.openExternal(h);
                else window.open(h, '_blank');
              });
            });
          } catch(_) {}
        }, { once: true });
      } catch(_) {
        // Final fallback: write via contentDocument
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          doc.open(); doc.write(iframeHtml); doc.close();
        } catch(__) {}
      }
    }
  }

  async function _addCalendar() {
    const url=document.getElementById('cal-url-input')?.value.trim();
    const name=document.getElementById('cal-name-input')?.value.trim()||'Calendar';
    if (!url) { UI.setSync('error','Enter a calendar URL'); return; }
    UI.setSync('syncing','Loading calendar…');
    try { await Calendar.addCalendar(name,url); document.getElementById('cal-url-input').value=''; _renderCalView(); UI.setSync('done','Calendar added'); }
    catch(e) { UI.setSync('error','Calendar error: '+e.message); }
  }

  function _wireOverlays() {
    document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>document.getElementById(btn.dataset.close)?.classList.add('hidden')));
    document.querySelectorAll('.overlay').forEach(ov=>ov.addEventListener('click',e=>{ if(e.target===ov) ov.classList.add('hidden'); }));
  }
  function _renderNav() {
    UI.renderFolderNav(
      document.getElementById('folder-nav'),
      S.folders,
      S.unread,
      S.folder,
      folder => folder === '__create_folder__' ? _createFolder() : _loadFolder(folder,1),
      _handleFolderAction
    );
  }
  function _showScreen(id) { document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById(id)?.classList.add('active'); }
  function _setTxt(id,t) { const el=document.getElementById(id); if(el) el.textContent=t; }
  function _folderLabel(path) {
    const m={'__unread__':'Unread','INBOX':'Inbox','[Gmail]/Trash':'Trash','[Gmail]/Spam':'Spam','[Gmail]/Sent Mail':'Sent','[Gmail]/Drafts':'Drafts','[Gmail]/Starred':'Starred','[Gmail]/All Mail':'All Mail'};
    return m[path]||path.split(/[/\\]/).pop()||path;
  }
  function _log(type,msg) { S.log.push({ts:Date.now(),type,msg}); if(S.log.length>500) S.log.shift(); }
  function _savePersisted() { localStorage.setItem('elve_stats',JSON.stringify(S.stats)); localStorage.setItem('elve_log',JSON.stringify(S.log.slice(-200))); }
  function _loadPersisted() {
    try { const s=localStorage.getItem('elve_stats'); if(s) S.stats={...S.stats,...JSON.parse(s)}; } catch(e) {}
    try { const l=localStorage.getItem('elve_log');   if(l) S.log=JSON.parse(l); } catch(e) {}
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded',()=>App.init());
