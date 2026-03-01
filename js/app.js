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
    calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
    synced: new Set(),
    syncing: false,
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

  // ── Connect / switch account ──────────────────────────────────────────────
  async function _connectAccount(account, idx) {
    ImapEngine.clearPoll();
    S.account=account; S.accountIdx=idx??0; S.inApp=true;
    S.synced.clear(); S.syncing=false;
    S.folders=[]; S.messages=[]; S.allLoaded=[]; S.activeMsg=null;
    S.folder='INBOX'; S.page=1; S.unread={};

    _showScreen('app-screen');
    _renderAccountSwitcher();
    _setTxt('account-email',    account.email);
    _setTxt('account-provider', account.provider.toUpperCase()+' · IMAP');
    _setTxt('account-avatar',   account.email[0].toUpperCase());

    document.getElementById('folder-nav').innerHTML='<div class="folders-loading">Connecting…</div>';
    document.getElementById('email-list-container').innerHTML='';
    document.getElementById('reader-empty')?.classList.remove('hidden');
    document.getElementById('reader-view')?.classList.add('hidden');

    UI.setSync('syncing','Connecting…');
    try { await ImapEngine.connect(account); } catch(e) { UI.setSync('error','Connect failed: '+e.message); }

    UI.setSync('syncing','Loading folders…');
    try { S.folders=await ImapEngine.listFolders(); }
    catch(e) { S.folders=[{path:'INBOX',name:'Inbox',special:'inbox'},{path:'Sent',name:'Sent',special:'sent'},{path:'Trash',name:'Trash',special:'trash'}]; }
    _renderNav();

    await _loadFolder('INBOX',1);

    ImapEngine.startPoll('INBOX', async ({newCount}) => {
      _showNewMailBanner(newCount);
      Notifier.notifyBatch(newCount, account.email);
      if (S.folder==='INBOX') {
        const nm = await ImapEngine.fetchNewest('INBOX',S.newestUid).catch(()=>[]);
        if (nm.length) _prependMessages(nm);
      }
    });

    _bgSyncAll();
  }

  // ── Account switcher ──────────────────────────────────────────────────────
  function _renderAccountSwitcher() {
    const wrap = document.getElementById('accounts-list'); if (!wrap) return;
    wrap.innerHTML = '';
    S.accounts.forEach((acc,i) => {
      const chip = document.createElement('div');
      chip.className='account-switch-item'+(i===S.accountIdx?' active':'');
      chip.innerHTML=`
        <div class="accsw-avatar">${acc.email[0].toUpperCase()}</div>
        <div class="accsw-info">
          <div class="accsw-email">${UI.esc(acc.email)}</div>
          <div class="accsw-prov">${acc.provider.toUpperCase()}</div>
        </div>
        ${i===S.accountIdx?'<div class="accsw-check">✓</div>':''}`;
      chip.addEventListener('click', ()=>{
        if (i===S.accountIdx) return;
        document.getElementById('account-switcher-popup')?.classList.add('hidden');
        _connectAccount(S.accounts[i],i);
      });
      wrap.appendChild(chip);
    });
    // Add account button at bottom
    const addBtn = document.createElement('div');
    addBtn.className='account-switch-add';
    addBtn.innerHTML='<span>＋</span> Add account';
    addBtn.addEventListener('click', ()=>{
      document.getElementById('account-switcher-popup')?.classList.add('hidden');
      _showSetup(true);
    });
    wrap.appendChild(addBtn);
  }

  // ── Background sync ───────────────────────────────────────────────────────
  async function _bgSyncAll() {
    if (S.syncing) return; S.syncing=true;
    for (const f of S.folders) {
      if (!S.syncing) break;
      try { await _bgSyncFolder(f.path); } catch(e) {}
      await _sleep(50);
    }
    S.syncing=false; UI.setSync('done','All mail ready');
  }

  async function _bgSyncFolder(folder) {
    if (S.synced.has(folder)) return;
    const res = await ImapEngine.fetchPage(folder,1,null,false).catch(()=>null);
    if (!res) return;
    const uids1=res.messages.map(m=>m.uid).filter(Boolean);
    if (uids1.length) await ImapEngine.prefetchBodies(folder,uids1,null).catch(()=>{});
    for (let p=2;p<=res.totalPages;p++) {
      if (!S.syncing) return;
      const rp=await ImapEngine.fetchPage(folder,p,null,false).catch(()=>null);
      if (!rp||!rp.messages.length) break;
      const uids=rp.messages.map(m=>m.uid).filter(Boolean);
      if (uids.length) await ImapEngine.prefetchBodies(folder,uids,null).catch(()=>{});
      await _sleep(20);
    }
    S.synced.add(folder);
  }

  function _sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

  // ── Wire buttons ──────────────────────────────────────────────────────────
  function _wireApp() {
    _on('rules-btn',_showRules); _on('stats-btn',_showStats);
    _on('refresh-folder-btn',()=>_loadFolder(S.folder,S.page,true));
    _on('bulk-delete-btn',_bulkDelete);
    _on('uncheck-all-btn',()=>UI.exitSelectionMode());

    // Account chip opens popup
    _on('account-chip',()=>{
      const pop=document.getElementById('account-switcher-popup');
      if (pop) { _renderAccountSwitcher(); pop.classList.toggle('hidden'); }
    });
    document.addEventListener('click',e=>{
      if (!e.target.closest('#account-chip')&&!e.target.closest('#account-switcher-popup'))
        document.getElementById('account-switcher-popup')?.classList.add('hidden');
    });

    _on('reader-delete-btn',_deleteActive); _on('reader-archive-btn',_archiveActive);
    _on('reader-spam-btn',_markActiveSpam); _on('reader-unsubscribe-btn',_unsubscribeActive);
    _on('ai-btn',_analyseActive); _on('ai-dismiss',()=>document.getElementById('ai-panel')?.classList.add('hidden'));
    _on('scan-done-btn',()=>{ UI.hideScan(); _loadFolder(S.folder,1,true); });
    _on('ai-cfg-btn',()=>{
      ['ai-provider','ai-api-key','ai-base-url','ai-model'].forEach(id=>{
        const el=document.getElementById(id); if (!el) return;
        const v={provider:AI.getProvider,'ai-api-key':AI.getApiKey,'ai-base-url':AI.getBaseUrl,'ai-model':AI.getModel}[id];
        el.value = AI['get'+id.split('-').map((w,i)=>i?w[0].toUpperCase()+w.slice(1):w).join('')]?.() || '';
      });
      const prov=document.getElementById('ai-provider'); const key=document.getElementById('ai-api-key');
      const base=document.getElementById('ai-base-url'); const mod=document.getElementById('ai-model');
      if (prov) prov.value=AI.getProvider(); if (key) key.value=AI.getApiKey();
      if (base) base.value=AI.getBaseUrl(); if (mod) mod.value=AI.getModel();
      document.getElementById('ai-settings-overlay')?.classList.remove('hidden');
    });
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
    document.getElementById('compose-file-input')?.addEventListener('change',_addComposeAttachment);
    _on('reader-reply-btn',_replyToActive);

    _on('reader-block-btn',e=>{ e.stopPropagation(); document.getElementById('block-menu')?.classList.toggle('hidden'); });
    document.addEventListener('click',()=>document.getElementById('block-menu')?.classList.add('hidden'));
    _on('block-by-addr',()=>_blockActive('email'));
    _on('block-by-subject',()=>_blockActive('subject'));
    _on('block-by-domain',()=>_blockActive('domain'));

    _on('theme-btn',()=>{
      Themes.buildPicker({
        grid:document.getElementById('theme-grid'), bgOpts:document.getElementById('bg-options'),
        swSlider:document.getElementById('sidebar-width-slider'), swVal:document.getElementById('sidebar-width-val'),
        tintInput:document.getElementById('custom-tint'), tintReset:document.getElementById('tint-reset-btn'),
        blurSlider:document.getElementById('bg-blur-slider'), blurVal:document.getElementById('bg-blur-val'),
        opacitySlider:document.getElementById('bg-opacity-slider'), opacityVal:document.getElementById('bg-opacity-val'),
      });
      document.getElementById('theme-overlay')?.classList.remove('hidden');
    });
    _on('bg-image-btn',()=>document.getElementById('bg-image-file')?.click());
    document.getElementById('bg-image-file')?.addEventListener('change',e=>{
      const f=e.target.files[0]; if (!f) return;
      const r=new FileReader(); r.onload=ev=>{ Themes.setBgImage(ev.target.result); document.getElementById('bg-image-name').textContent=f.name; }; r.readAsDataURL(f);
    });
    _on('bg-image-clear-btn',()=>{ Themes.clearBgImage(); document.getElementById('bg-image-name').textContent='None'; document.getElementById('bg-image-file').value=''; });

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
      if (!q) { S.searchMode=false; _renderList(); return; }
      stimer=setTimeout(()=>_doSearch(q),300);
    });
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
      if (folder==='__unread__') { await _loadUnread(); return; }

      // If already cached in memory/IndexedDB: render instantly without IMAP
      const cachedAll = ImapEngine.getAllCachedHeaders(folder);
      const hasCached = cachedAll.length>0 && !forceRefresh;

      if (hasCached) {
        // Slice the page we want and show immediately
        const ps=ImapEngine.PAGE_SIZE;
        const pageStart=(page-1)*ps, pageEnd=pageStart+ps;
        const slice=cachedAll.slice(pageStart,pageEnd);
        const tp=Math.ceil(cachedAll.length/ps);
        S.messages=slice; S.page=page; S.totalPages=tp; S.totalMsgs=cachedAll.length;
        if (S.messages.length) S.newestUid=Math.max(S.newestUid||0,...S.messages.map(m=>m.uid||0));
        const seen=new Set(S.allLoaded.map(m=>m.id));
        S.messages.forEach(m=>{ if(!seen.has(m.id)) S.allLoaded.push(m); });
        const {kept,deleted}=_applyFilters([...S.messages]);
        S.messages=kept;
        _setTxt('msg-count',`${S.totalMsgs} · p${page}/${tp}`);
        _updatePager(page,tp); _renderList();
        S.unread[folder]=S.messages.filter(m=>m.unread).length; _renderNav();
        UI.setSync('done',`${S.messages.length} shown`);
        // Background-prefetch bodies (skips already-cached UIDs silently)
        const uids=S.messages.map(m=>m.uid).filter(Boolean);
        if (uids.length) ImapEngine.prefetchBodies(folder,uids,null).catch(()=>{});
        if (deleted.length) _batchDelete(folder,deleted).catch(()=>{});
        return; // done — no IMAP needed
      }

      // No cache: show spinner, fetch from IMAP
      container.innerHTML=`<div class="list-state"><div class="state-spinner"></div><div class="state-text">Loading…</div></div>`;
      UI.setSync('syncing',`Loading ${_folderLabel(folder)}…`);

      const res=await ImapEngine.fetchPage(folder,page,({seqStart,seqEnd,total})=>{
        container.innerHTML=`<div class="list-state"><div class="state-spinner"></div><div class="state-text">Fetching ${seqStart}–${seqEnd} of ${total}…</div></div>`;
      },forceRefresh);

      S.messages=res.messages; S.page=res.page; S.totalPages=res.totalPages; S.totalMsgs=res.total;
      S.stats.fetched=Math.max(S.stats.fetched,res.total);
      if (S.messages.length) S.newestUid=Math.max(S.newestUid||0,...S.messages.map(m=>m.uid||0));
      const seen=new Set(S.allLoaded.map(m=>m.id));
      S.messages.forEach(m=>{ if(!seen.has(m.id)) S.allLoaded.push(m); });
      const {kept,deleted}=_applyFilters(S.messages); S.messages=kept;
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

  async function _loadUnread() {
    const container=document.getElementById('email-list-container');
    container.innerHTML=`<div class="list-state"><div class="state-spinner"></div><div class="state-text">Loading unread…</div></div>`;
    try {
      const p=S.folders.find(f=>f.special==='inbox')?.path||'INBOX';
      const msgs=await ImapEngine.searchFolder(p,'UNSEEN',true);
      S.messages=msgs; S.totalMsgs=msgs.length;
      _setTxt('msg-count',`${msgs.length} unread`); _updatePager(1,1); _renderList();
      UI.setSync('done',`${msgs.length} unread`);
    } catch(e) { container.innerHTML=`<div class="list-state"><div class="state-text" style="color:var(--danger)">⚠ ${UI.esc(e.message)}</div></div>`; }
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  function _applyFilters(messages) {
    const kept=[],deleted=[],seen=new Map();
    S.allLoaded.forEach(m=>{ if(m._kept===false) return; const k=_ns(m.subject); if(k&&!seen.has(k)) seen.set(k,m.id); });
    for (const msg of messages) {
      const k=_ns(msg.subject);
      if (Rules.get().dupes?.enabled&&k&&seen.has(k)&&seen.get(k)!==msg.id) { msg._deleteReason='duplicate';msg._kept=false;deleted.push(msg);UI.removeRow(msg.id);continue; }
      if (k) seen.set(k,msg.id);
      const hits=Rules.check(msg);
      if (hits.length) { msg._deleteReason=`${hits[0].rule}:${hits[0].value}`;msg._kept=false;deleted.push(msg);UI.removeRow(msg.id);continue; }
      msg._kept=true; kept.push(msg);
    }
    return {kept,deleted};
  }
  function _ns(s) { return (s||'').toLowerCase().replace(/^(re|fwd?|fw|aw):\s*/gi,'').replace(/\s+/g,' ').trim(); }

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
          if ((m._deleteReason||'').includes('scam')) S.stats.scams++;
          _log(m._deleteReason==='duplicate'?'dup':(m._deleteReason||'').includes('scam')?'scam':'deleted',
               `"${(m.subject||'').slice(0,45)}" [${m._deleteReason}]`);
        });
        _savePersisted();
      } catch(e) { console.error('[App] delete',e.message); }
    }
  }

  function _renderList() { UI.renderEmailList(document.getElementById('email-list-container'),S.messages,S.activeMsg?.id,msg=>_openMsg(msg)); }

  async function _openMsg(msg) {
    S.activeMsg=msg; UI.showReader(msg); Notifier.clearBadge();
    try { const body=await ImapEngine.fetchBody(msg.folder||S.folder,msg.uid); UI.setEmailBody(body,msg); }
    catch(e) { UI.setEmailBody({html:null,text:'Error: '+e.message,attachments:[]},msg); }
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
    try { await ImapEngine.markSpam(msg.folder||S.folder,[msg.uid]); _log('spam',`Marked spam: "${(msg.subject||'').slice(0,45)}"`); UI.setSync('done','Marked as spam'); }
    catch(e) { UI.setSync('error','Spam error: '+e.message); }
  }

  async function _unsubscribeActive() {
    if (!S.activeMsg) return;
    const msg=S.activeMsg;
    let unsub=msg.listUnsub||'';
    const cached=ImapEngine.getBodyCache().get(`${msg.folder||S.folder}::${msg.uid}`);
    if (cached?.listUnsub) unsub=cached.listUnsub;
    const um=unsub.match(/<(https?:[^>]+)>/), mm=unsub.match(/<mailto:([^>]+)>/);
    if (um) { if (typeof nw!=='undefined') nw.Shell.openExternal(um[1]); UI.setSync('done','Opened unsubscribe link'); }
    else if (mm) { _openCompose(mm[1],'Unsubscribe','Please remove me from this mailing list.\n\nThank you.'); }
    else UI.setSync('done','No unsubscribe link found');
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
    const btn=document.getElementById('ai-btn'); btn.textContent='⏳ Analysing…'; btn.disabled=true;
    const body=ImapEngine.getBodyCache().get(`${S.activeMsg.folder||S.folder}::${S.activeMsg.uid}`);
    const result=await AI.analyse({...S.activeMsg,rawBody:body?.text||''});
    UI.showAIResult(result); btn.textContent='⚡ AI Analysis'; btn.disabled=false;
    if (result.risk==='HIGH'&&Rules.get().aiscam?.enabled) setTimeout(_deleteActive,2000);
  }

  function _saveAISettings() {
    const prov=document.getElementById('ai-provider')?.value; const key=document.getElementById('ai-api-key')?.value.trim();
    const base=document.getElementById('ai-base-url')?.value.trim(); const model=document.getElementById('ai-model')?.value.trim();
    if(prov)AI.setProvider(prov); if(key)AI.setApiKey(key); if(base)AI.setBaseUrl(base); if(model)AI.setModel(model);
    _setTxt('ai-settings-status','✓ Saved'); setTimeout(()=>_setTxt('ai-settings-status',''),2000);
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
    _populateFromAliases();
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

  async function _sendCompose() {
    const to=document.getElementById('compose-to')?.value.trim();
    const cc=document.getElementById('compose-cc')?.value.trim()||'';
    const bcc=document.getElementById('compose-bcc')?.value.trim()||'';
    const from=document.getElementById('compose-from')?.value||S.account?.email;
    const subject=document.getElementById('compose-subject')?.value.trim();
    const body=document.getElementById('compose-body')?.value;
    const status=document.getElementById('compose-status');
    if (!to||!subject) { if(status) status.textContent='Fill in To and Subject'; return; }
    if (!S.account) { if(status) status.textContent='Not connected'; return; }
    const btn=document.getElementById('compose-send-btn');
    btn.disabled=true; btn.textContent='Sending…'; if(status) status.textContent='';
    try {
      await SmtpClient.send({...S.account,fromAlias:from},{to,cc,bcc,subject,text:body,attachments:_composeAttachments});
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

  // ── Search ────────────────────────────────────────────────────────────────
  async function _doSearch(q) {
    S.searchMode=true;
    const lq=q.toLowerCase();
    const local=ImapEngine.getAllCachedHeaders(S.folder).filter(m=>
      (m.subject||'').toLowerCase().includes(lq)||(m.from||'').toLowerCase().includes(lq));
    if (local.length>0) { S.messages=local; _setTxt('msg-count',`${local.length} results`); _updatePager(1,1); _renderList(); return; }
    const container=document.getElementById('email-list-container');
    container.innerHTML='<div class="list-state"><div class="state-spinner"></div><div class="state-text">Searching server…</div></div>';
    try {
      const results=await ImapEngine.searchFolder(S.folder,q,false);
      S.messages=results; _setTxt('msg-count',results.length+' results'); _updatePager(1,1); _renderList();
    } catch(e) {
      S.messages=S.allLoaded.filter(m=>(m.subject||'').toLowerCase().includes(lq)||(m.from||'').toLowerCase().includes(lq));
      _setTxt('msg-count',S.messages.length+' local results'); _renderList();
    }
  }

  // ── New mail banner ───────────────────────────────────────────────────────
  function _showNewMailBanner(count) {
    let b=document.getElementById('new-mail-banner');
    if (!b) {
      b=document.createElement('div'); b.id='new-mail-banner';
      Object.assign(b.style,{position:'fixed',top:'16px',left:'50%',transform:'translateX(-50%)',background:'var(--accent)',color:'#fff',padding:'9px 22px',borderRadius:'20px',fontSize:'13px',fontWeight:'700',boxShadow:'0 4px 20px var(--accent-glow)',zIndex:'9999',cursor:'pointer'});
      b.addEventListener('click',()=>{ b.remove(); _loadFolder('INBOX',1,true); });
      document.getElementById('app-screen')?.appendChild(b);
    }
    b.textContent=`↓ ${count} new message${count>1?'s':''} — click to load`;
    clearTimeout(b._t); b._t=setTimeout(()=>b.remove(),8000);
  }

  function _prependMessages(msgs) {
    const fresh=msgs.filter(m=>!S.messages.find(x=>x.id===m.id)); if (!fresh.length) return;
    S.messages=[...fresh,...S.messages]; S.allLoaded=[...fresh,...S.allLoaded];
    S.newestUid=Math.max(S.newestUid||0,...fresh.map(m=>m.uid||0));
    S.unread['INBOX']=(S.unread['INBOX']||0)+fresh.filter(m=>m.unread).length;
    _renderNav(); _renderList(); _setTxt('msg-count',`${S.messages.length} shown`);
  }

  function _updatePager(page,totalPages) {
    const el=document.getElementById('pager'); if(!el) return;
    if (!totalPages||totalPages<=1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); _setTxt('page-info',`Page ${page} of ${totalPages}`);
    document.getElementById('page-prev').disabled=page<=1;
    document.getElementById('page-next').disabled=page>=totalPages;
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
    const startStr=ev.allDay
      ?ev.start.toLocaleDateString([],{weekday:'long',year:'numeric',month:'long',day:'numeric'})
      :ev.start.toLocaleString([],{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const endStr=ev.end?(ev.allDay?ev.end.toLocaleDateString([],{month:'short',day:'numeric'}):ev.end.toLocaleString([],{hour:'2-digit',minute:'2-digit'})):'';

    const dlg=document.createElement('div'); dlg.id='_cal-ev-dlg';
    dlg.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;';
    dlg.innerHTML=`
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:18px;width:580px;max-width:96vw;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;">
        <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="width:13px;height:13px;border-radius:50%;background:${ev.color};margin-top:5px;flex-shrink:0;"></div>
            <div style="flex:1;">
              <div style="font-size:18px;font-weight:700;color:var(--text);line-height:1.3">${UI.esc(ev.summary)}</div>
              <div style="font-size:13px;color:var(--text2);margin-top:5px">📅 ${UI.esc(startStr)}${endStr?' → '+UI.esc(endStr):''}</div>
              ${ev.location?`<div style="font-size:13px;color:var(--text2);margin-top:3px">📍 ${UI.esc(ev.location)}</div>`:''}
              ${ev.calendar?`<div style="font-size:12px;color:var(--text3);margin-top:2px">📁 ${UI.esc(ev.calendar)}</div>`:''}
            </div>
            <button id="_cal-close" style="background:none;border:none;font-size:22px;color:var(--text3);cursor:pointer;flex-shrink:0;line-height:1;padding:0">×</button>
          </div>
        </div>
        <iframe id="_cal-iframe" style="flex:1;border:none;min-height:280px;" sandbox="allow-same-origin"></iframe>
        <div style="padding:12px 20px;border-top:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;justify-content:flex-end;">
          <button id="_cal-done" style="padding:7px 18px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);cursor:pointer;font-size:13px;">Close</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    document.getElementById('_cal-close').onclick=()=>dlg.remove();
    document.getElementById('_cal-done').onclick=()=>dlg.remove();
    dlg.addEventListener('click',e=>{ if(e.target===dlg) dlg.remove(); });

    // Render description in iframe with clickable links
    const iframe=document.getElementById('_cal-iframe');
    const descHtml=ev.description
      ?ev.description.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/\n/g,'<br>').replace(/(https?:\/\/[^\s&<]+)/g,'<a href="$1">$1</a>')
      :'<p style="color:#888;font-size:14px;font-family:system-ui;padding:24px">No description provided.</p>';
    try {
      const doc=iframe.contentDocument||iframe.contentWindow?.document;
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:20px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.7;color:#1a1a2e;background:#fff;word-break:break-word;}
        a{color:#6c63ff;} br{display:block;margin:2px 0;}
      </style></head><body>${descHtml}</body></html>`);
      doc.close();
      setTimeout(()=>{
        try {
          doc.querySelectorAll('a[href]').forEach(a=>{
            a.addEventListener('click',e=>{ e.preventDefault(); const h=a.getAttribute('href'); if(h&&typeof nw!=='undefined') nw.Shell.openExternal(h); else if(h) window.open(h,'_blank'); });
          });
        } catch(_) {}
      },100);
    } catch(_) {}
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
  function _renderNav() { UI.renderFolderNav(document.getElementById('folder-nav'),S.folders,S.unread,S.folder,folder=>_loadFolder(folder,1)); }
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
