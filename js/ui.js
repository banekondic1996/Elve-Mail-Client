// js/ui.js — Elve Mail UI v5
// Fixes: unread dot overlap, dark theme text in reader, hold-to-select, folder display

'use strict';
const UI = (() => {
  const tagStates  = {};
  let selMode      = false;
  let holdTimer    = null;

  // ── Tag inputs ──────────────────────────────────────────────────────────
  function initTag(wrapId, inputId, key) {
    tagStates[key] = tagStates[key] || [];
    const wrap = document.getElementById(wrapId), inp = document.getElementById(inputId);
    if (!wrap||!inp) return;
    wrap.addEventListener('click', () => inp.focus());
    inp.addEventListener('keydown', e => {
      if (e.key==='Enter'||e.key===',') {
        e.preventDefault();
        const v = inp.value.trim().replace(/,+$/,'');
        if (v && !tagStates[key].includes(v)) { tagStates[key].push(v); _rtags(wrap,inp,key); }
        inp.value='';
      } else if (e.key==='Backspace' && !inp.value && tagStates[key].length) {
        tagStates[key].pop(); _rtags(wrap,inp,key);
      }
    });
  }
  function _rtags(wrap,inp,key) {
    wrap.querySelectorAll('.etag').forEach(t=>t.remove());
    tagStates[key].forEach((v,i) => {
      const t=document.createElement('span'); t.className='etag';
      t.innerHTML=`${esc(v)}<span class="etag-x" data-i="${i}">×</span>`;
      t.querySelector('.etag-x').addEventListener('click',e=>{ e.stopPropagation(); tagStates[key].splice(i,1); _rtags(wrap,inp,key); });
      wrap.insertBefore(t,inp);
    });
  }
  function setTags(key,vals) { tagStates[key]=[...(vals||[])]; }
  function getTags(key) { return [...(tagStates[key]||[])]; }
  function refreshTags(wrapId,inputId,key) {
    const w=document.getElementById(wrapId),i=document.getElementById(inputId);
    if(w&&i)_rtags(w,i,key);
  }

  // ── Folder nav ──────────────────────────────────────────────────────────
  const F_ICONS = { inbox:'📥', sent:'📤', trash:'🗑', drafts:'📝', spam:'🚫', flagged:'⭐', archive:'📦', folder:'📁' };
  const SP_ORDER = ['inbox','sent','drafts','spam','trash','archive','flagged'];

  function renderFolderNav(navEl, folders, unreadCounts, activeFolder, onSelect) {
    navEl.innerHTML='';

    // Unread virtual folder (IMAP SEARCH UNSEEN)
    const uc = unreadCounts['__unread__']||0;
    const uEl = _mkFolder({path:'__unread__',name:'Unread',special:'folder'},uc,activeFolder==='__unread__','🔵');
    uEl.addEventListener('click',()=>onSelect('__unread__'));
    navEl.appendChild(uEl);

    // Specials sorted by SP_ORDER
    const specials = folders.filter(f=>f.special!=='folder')
      .sort((a,b)=>SP_ORDER.indexOf(a.special)-SP_ORDER.indexOf(b.special));

    if (specials.length) {
      navEl.appendChild(_glabel('Mailboxes'));
      specials.forEach(f => {
        // Rename "Bulk Mail" → "Spam" in display
        const displayName = f.special==='spam' ? 'Spam' : f.name;
        const el = _mkFolder({...f,name:displayName}, unreadCounts[f.path]||0, activeFolder===f.path);
        el.addEventListener('click',()=>onSelect(f.path));
        navEl.appendChild(el);
      });
    }

    // Personal folders
    const custom = folders.filter(f=>f.special==='folder');
    if (custom.length) {
      navEl.appendChild(_glabel('Folders'));
      custom.forEach(f => {
        const el = _mkFolder(f, unreadCounts[f.path]||0, activeFolder===f.path);
        el.addEventListener('click',()=>onSelect(f.path));
        navEl.appendChild(el);
      });
    }
  }

  function _glabel(txt) {
    const d=document.createElement('div'); d.className='folder-group-label'; d.textContent=txt; return d;
  }
  function _mkFolder(f, unread, active, iconOverride) {
    const el=document.createElement('div');
    el.className='folder-item'+(active?' active':'');
    el.dataset.folder=f.path;
    const icon = iconOverride || F_ICONS[f.special]||'📁';
    el.innerHTML=`<span class="folder-icon">${icon}</span><span class="folder-label">${esc(f.name)}</span>${unread?`<span class="folder-unread">${unread}</span>`:''}`;
    return el;
  }
  function setActiveFolder(path) {
    document.querySelectorAll('.folder-item').forEach(el=>el.classList.toggle('active',el.dataset.folder===path));
  }

  // ── Email list — hold to select ─────────────────────────────────────────
  function renderEmailList(container, messages, activeId, onSelect) {
    container.innerHTML='';
    if (!messages.length) {
      container.innerHTML='<div class="list-empty-state"><div class="empty-glyph">📭</div><div>No messages</div></div>';
      return;
    }
    const frag=document.createDocumentFragment();
    messages.forEach(msg => {
      const row=document.createElement('div');
      row.className='email-row'+(msg.unread?' unread':'')+(msg._scam?' flagged-scam':'')+(msg.id===activeId?' active':'');
      row.dataset.id=msg.id;
      const name=ImapEngine.extractName(msg.from||'');
      const dt=_fmtDate(msg.date);

      row.innerHTML=`
        <div class="er-unread-stripe" aria-hidden="true"></div>
        <div class="er-check hidden"><input type="checkbox" data-id="${esc(msg.id)}" aria-label="Select"></div>
        <div class="er-body">
          <div class="er-top">
            <span class="er-from">${esc(name)}${msg._scam?'<span class="scam-flag">⚠</span>':''}</span>
            <span class="er-date">${dt}</span>
          </div>
          <div class="er-subject">${esc(msg.subject||'(no subject)')}</div>
        </div>`;

      const cb = row.querySelector('input[type=checkbox]');

      // Hold 500ms = selection mode
      row.addEventListener('mousedown', () => {
        holdTimer = setTimeout(() => {
          holdTimer=null;
          _enterSel();
          cb.checked=true; row.classList.add('selected');
          _updateSelBar();
        }, 500);
      });
      ['mouseup','mouseleave'].forEach(e=>row.addEventListener(e,()=>clearTimeout(holdTimer)));

      // Click
      row.addEventListener('click', e => {
        if (selMode) {
          cb.checked=!cb.checked;
          row.classList.toggle('selected',cb.checked);
          _updateSelBar(); return;
        }
        document.querySelectorAll('.email-row.active').forEach(r=>r.classList.remove('active'));
        row.classList.add('active');
        if (msg.unread) { msg.unread=false; row.classList.remove('unread'); }
        onSelect(msg);
      });
      cb.addEventListener('change',()=>{ row.classList.toggle('selected',cb.checked); _updateSelBar(); });
      cb.addEventListener('click',e=>e.stopPropagation());

      frag.appendChild(row);
    });
    container.appendChild(frag);
    if (selMode) _showCbs(true);
  }

  function _enterSel() {
    if (selMode) return;
    selMode=true; _showCbs(true);
    document.getElementById('selection-toolbar')?.classList.remove('hidden');
    document.getElementById('normal-toolbar')?.classList.add('hidden');
  }
  function exitSelectionMode() {
    selMode=false; _showCbs(false);
    document.querySelectorAll('.email-row').forEach(r=>{ r.classList.remove('selected'); const cb=r.querySelector('input'); if(cb)cb.checked=false; });
    document.getElementById('selection-toolbar')?.classList.add('hidden');
    document.getElementById('normal-toolbar')?.classList.remove('hidden');
    _updateSelBar();
  }
  function _showCbs(show) {
    document.querySelectorAll('.er-check').forEach(el=>el.classList.toggle('hidden',!show));
  }
  function _updateSelBar() {
    const n=document.querySelectorAll('.email-row input[type=checkbox]:checked').length;
    const el=document.getElementById('sel-count'); if(el) el.textContent=n+' selected';
    if (selMode && n===0) exitSelectionMode();
  }
  function getSelectedIds() {
    return [...document.querySelectorAll('.email-row input[type=checkbox]:checked')].map(c=>c.dataset.id);
  }
  function isSelMode() { return selMode; }

  function removeRow(id) {
    const row=document.querySelector(`.email-row[data-id="${CSS.escape(id)}"]`);
    if (row) { row.style.transition='opacity .22s,transform .22s'; row.style.opacity='0'; row.style.transform='translateX(-14px)'; setTimeout(()=>row.remove(),230); }
  }
  function markScam(id) { document.querySelector(`.email-row[data-id="${CSS.escape(id)}"]`)?.classList.add('flagged-scam'); }

  // ── Reader ──────────────────────────────────────────────────────────────
  function showReader(msg) {
    document.getElementById('reader-empty')?.classList.add('hidden');
    document.getElementById('reader-view')?.classList.remove('hidden');
    _set('reader-subject', msg.subject||'(no subject)');
    _set('reader-from', msg.from||'');
    _set('reader-to', msg.to?'To: '+msg.to:'');
    _set('reader-date', msg.date?new Date(msg.date).toLocaleString():'');
    const nm=ImapEngine.extractName(msg.from||'');
    _set('reader-avatar', (nm[0]||'?').toUpperCase());
    document.getElementById('ai-panel')?.classList.add('hidden');
    const iframe=document.getElementById('reader-iframe');
    if (iframe) _writeIframe(iframe,'<div style="padding:32px;color:#666;font-family:system-ui">Loading…</div>');
  }

  // Current msg reference for context menu block-by-keyword
  let _ctxMsg = null;

  function setEmailBody(bodyData, msg) {
    _ctxMsg = msg || null;
    const iframe = document.getElementById('reader-iframe');
    if (!iframe) return;

    if (bodyData.html) {
      _writeIframe(iframe, _wrapHtml(bodyData.html));
    } else if (bodyData.text?.trim()) {
      _writeIframe(iframe, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;}
        body{margin:0;padding:24px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.75;color:#1a1a2e;background:#fff;word-break:break-word;}
        pre{white-space:pre-wrap;font-family:inherit;} a{color:#6c63ff;}
      </style></head><body><pre>${esc(bodyData.text)}</pre></body></html>`);
    } else {
      _writeIframe(iframe, '<div style="padding:32px;color:#888;font-family:system-ui;font-size:14px">(No message body)</div>');
    }

    // Render attachment bar below iframe
    _renderAttachments(bodyData.attachments || []);
  }

  function _renderAttachments(attachments) {
    const bar = document.getElementById('reader-attachments');
    if (!bar) return;
    if (!attachments.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = attachments.map((a, i) => {
      const size = a.size > 1024*1024 ? (a.size/1024/1024).toFixed(1)+'MB' : a.size > 1024 ? Math.round(a.size/1024)+'KB' : a.size+'B';
      const icon = /image/i.test(a.contentType) ? '🖼' : /pdf/i.test(a.contentType) ? '📄' : /zip|archive/i.test(a.contentType) ? '📦' : /calendar|ics/i.test(a.contentType) ? '📅' : '📎';
      return `<button class="att-chip" data-i="${i}" title="Download ${esc(a.filename)}">${icon} ${esc(a.filename)} <span class="att-size">${size}</span></button>`;
    }).join('');
    bar.querySelectorAll('.att-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = attachments[parseInt(btn.dataset.i)];
        if (!a || !a.content) return;
        try {
          // NW.js: save via file dialog
          if (typeof nw !== 'undefined') {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.nwsaveas = a.filename; inp.accept = a.contentType;
            inp.addEventListener('change', () => {
              if (!inp.value) return;
              require('fs').writeFile(inp.value, Buffer.from(a.content), () => {});
            });
            inp.click();
          } else {
            // Browser fallback
            const blob = new Blob([a.content], { type: a.contentType });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = a.filename; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          }
        } catch(e) {}
      });
    });
  }

  function _wrapHtml(html) {
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;}
  body{background:#fff!important;color:#1a1a1a!important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.7;padding:16px;max-width:100%;overflow-x:hidden;}
  img{max-width:100%!important;height:auto!important;}
  *{max-width:100%;box-sizing:border-box;}
  a{color:#6c63ff!important;cursor:pointer;}
  a[title]{position:relative;}
  [bgcolor="#000000"],[bgcolor="#111111"],[bgcolor="#0d0d0d"]{background:#fff!important;}
  #_ctx{position:fixed;background:#1e1e2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:9999;min-width:180px;padding:4px 0;font-family:system-ui;font-size:12px;}
  #_ctx button{display:block;width:100%;background:none;border:none;color:#c8c8e8;padding:8px 14px;text-align:left;cursor:pointer;}
  #_ctx button:hover{background:rgba(108,99,255,.2);color:#fff;}
  #_ctx hr{border:none;border-top:1px solid #2a2a3e;margin:3px 0;}
  #_tt{position:fixed;background:#111;color:#adf;font-size:11px;padding:4px 8px;border-radius:5px;z-index:9998;pointer-events:none;max-width:320px;word-break:break-all;white-space:pre-wrap;}
</style>
</head><body>${clean}</body></html>`;
  }

  function _writeIframe(iframe, html) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      doc.open(); doc.write(html); doc.close();
      setTimeout(() => _wireIframeInteractions(doc), 200);
    } catch(e) {}
  }

  // Wire all iframe interactions: link open, tooltips, context menu
  function _wireIframeInteractions(doc) {
    try {
      // Remove any old context menu
      doc.getElementById('_ctx')?.remove();
      doc.getElementById('_tt')?.remove();

      // Create shared tooltip
      const tt = doc.createElement('div'); tt.id = '_tt'; tt.style.display = 'none'; doc.body.appendChild(tt);

      // Create shared context menu
      const ctx = doc.createElement('div'); ctx.id = '_ctx'; ctx.style.display = 'none'; doc.body.appendChild(ctx);
      const hideCtx = () => { ctx.style.display = 'none'; };
      doc.addEventListener('click', hideCtx);
      doc.addEventListener('scroll', hideCtx);

      // Wire every link
      doc.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const isExternal = href.startsWith('http') || href.startsWith('mailto:');

        // Show real URL in title attribute + tooltip on hover
        if (isExternal && !href.startsWith('mailto:')) {
          a.addEventListener('mouseenter', e => {
            tt.textContent = href;
            tt.style.display = 'block';
            tt.style.left = Math.min(e.clientX + 10, doc.documentElement.clientWidth - 340) + 'px';
            tt.style.top  = (e.clientY + 16) + 'px';
          });
          a.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
          a.addEventListener('mousemove', e => {
            tt.style.left = Math.min(e.clientX + 10, doc.documentElement.clientWidth - 340) + 'px';
            tt.style.top  = (e.clientY + 16) + 'px';
          });
        }

        // Click: open in system browser
        a.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          if (!href || href === '#') return;
          if (typeof nw !== 'undefined') nw.Shell.openExternal(href);
          else window.open(href, '_blank');
        });

        // Right-click: context menu on links
        a.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          _showLinkCtxMenu(ctx, e, href, doc);
        });
      });

      // Right-click on non-link body text
      doc.body.addEventListener('contextmenu', e => {
        if (e.target.closest('a')) return; // handled above
        e.preventDefault();
        _showTextCtxMenu(ctx, e, doc);
      });
    } catch(err) {}
  }

  function _showLinkCtxMenu(ctx, e, href, doc) {
    const items = [];
    if (href.startsWith('http')) {
      items.push(['🌐 Open link', () => { if (typeof nw !== 'undefined') nw.Shell.openExternal(href); else window.open(href,'_blank'); }]);
      items.push(['📋 Copy link', () => _copyToClipboard(href)]);
      // WhoIs: open whois lookup for the domain
      try {
        const domain = new URL(href).hostname;
        items.push(['🔍 WhoIs ' + domain, () => {
          const url = `https://www.whois.com/whois/${domain}`;
          if (typeof nw !== 'undefined') nw.Shell.openExternal(url);
          else window.open(url, '_blank');
        }]);
      } catch(_) {}
    } else if (href.startsWith('mailto:')) {
      items.push(['✉ Send email to ' + href.replace('mailto:',''), () => {
        // Trigger compose in parent
        window.parent?.postMessage({ type:'compose', to: href.replace('mailto:','') }, '*');
      }]);
      items.push(['📋 Copy address', () => _copyToClipboard(href.replace('mailto:',''))]);
    }
    _buildCtxMenu(ctx, e, items);
  }

  function _showTextCtxMenu(ctx, e, doc) {
    const sel = doc.getSelection()?.toString().trim() || '';
    const items = [];
    if (sel) {
      items.push(['📋 Copy "' + sel.slice(0,30) + (sel.length>30?'…':'') + '"', () => _copyToClipboard(sel)]);
      items.push(['🚫 Block keyword "' + sel.slice(0,20) + (sel.length>20?'…':'') + '"', () => {
        window.parent?.postMessage({ type:'blockKeyword', keyword: sel.slice(0,60) }, '*');
      }]);
    } else {
      items.push(['📋 Copy all text', () => {
        const allText = doc.body.innerText || '';
        _copyToClipboard(allText);
      }]);
    }
    if (!items.length) return;
    _buildCtxMenu(ctx, e, items);
  }

  function _buildCtxMenu(ctx, e, items) {
    ctx.innerHTML = '';
    items.forEach((item, i) => {
      if (item === 'hr') { const hr = document.createElement('hr'); ctx.appendChild(hr); return; }
      const btn = document.createElement('button');
      btn.textContent = item[0];
      btn.addEventListener('click', () => { ctx.style.display = 'none'; item[1](); });
      ctx.appendChild(btn);
    });
    ctx.style.display = 'block';
    const x = Math.min(e.clientX, (ctx.ownerDocument.documentElement.clientWidth || 800) - 200);
    const y = Math.min(e.clientY, (ctx.ownerDocument.documentElement.clientHeight || 600) - items.length * 36 - 10);
    ctx.style.left = x + 'px'; ctx.style.top = y + 'px';
  }

  function _copyToClipboard(text) {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch(_) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  }

  // Listen for postMessage from iframe (compose, blockKeyword)
  window.addEventListener('message', e => {
    if (!e.data) return;
    if (e.data.type === 'compose') document.dispatchEvent(new CustomEvent('elve:compose', { detail: { to: e.data.to } }));
    if (e.data.type === 'blockKeyword') document.dispatchEvent(new CustomEvent('elve:blockKeyword', { detail: { keyword: e.data.keyword, msg: _ctxMsg } }));
  });

  function showAIResult(result) {
    const panel=document.getElementById('ai-panel'), badge=document.getElementById('ai-badge'),
          summary=document.getElementById('ai-summary'), flags=document.getElementById('ai-flags'),
          footer=document.getElementById('ai-panel-footer');
    if (!panel) return;
    const risk=result.risk||'UNKNOWN';
    badge.className='ai-badge risk-'+risk;
    badge.textContent=risk==='UNAVAILABLE'?'⚙ SETUP':risk==='ERROR'?'⚠ ERROR':risk+' RISK';
    summary.textContent=result.summary||'';
    flags.innerHTML=(result.indicators||[]).map(i=>`<li>${esc(i)}</li>`).join('');
    if (footer) footer.textContent=result.engine?`Engine: ${result.engine}`:'Local analysis';
    panel.classList.remove('hidden');
  }

  // ── Calendar view ───────────────────────────────────────────────────────
  function renderCalendar(containerEl, year, month, events) {
    const now   = new Date();
    const first = new Date(year, month, 1);
    const days  = new Date(year, month+1, 0).getDate();
    const start = first.getDay(); // 0=Sun

    const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Group events by day
    const byDay={};
    events.forEach(e=>{
      const k=e.start.getDate();
      if(!byDay[k])byDay[k]=[];
      byDay[k].push(e);
    });

    let html=`<div class="cal-header">
      <button class="cal-nav" id="cal-prev">‹</button>
      <span class="cal-title">${MONTHS[month]} ${year}</span>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-grid">
      ${DAYS.map(d=>`<div class="cal-dow">${d}</div>`).join('')}`;

    for (let i=0;i<start;i++) html+=`<div class="cal-cell cal-empty"></div>`;
    for (let d=1;d<=days;d++) {
      const isToday = d===now.getDate()&&month===now.getMonth()&&year===now.getFullYear();
      const evs = byDay[d]||[];
      html+=`<div class="cal-cell${isToday?' cal-today':''}" data-day="${d}">
        <div class="cal-day-num">${d}</div>
        ${evs.slice(0,3).map(e=>`<div class="cal-event" style="background:${e.color}" title="${esc(e.summary)}">${esc(e.summary.slice(0,18))}</div>`).join('')}
        ${evs.length>3?`<div class="cal-more">+${evs.length-3} more</div>`:''}
      </div>`;
    }
    html+=`</div>`;
    containerEl.innerHTML=html;
  }

  // ── Sync indicator ───────────────────────────────────────────────────────
  function setSync(state, text) {
    const dot=document.getElementById('sync-dot'), span=document.getElementById('sync-text');
    if (dot) dot.className='sync-dot '+state;
    if (span) span.textContent=text||'';
  }

  // ── Scan overlay ─────────────────────────────────────────────────────────
  function showScan()  { document.getElementById('scan-overlay')?.classList.remove('hidden'); document.getElementById('scan-fill').style.width='0%'; document.getElementById('scan-log').innerHTML=''; document.getElementById('scan-done-btn')?.classList.add('hidden'); }
  function hideScan()  { document.getElementById('scan-overlay')?.classList.add('hidden'); }
  function scanProg(p,txt) { document.getElementById('scan-fill').style.width=p+'%'; document.getElementById('scan-status').textContent=txt||''; }
  function scanLog(txt,cls) { const el=document.getElementById('scan-log'); if(!el)return; el.innerHTML+=`<div class="${cls||''}">${esc(txt)}</div>`; el.scrollTop=el.scrollHeight; }
  function scanDone() { scanProg(100,'Complete'); document.getElementById('scan-done-btn')?.classList.remove('hidden'); }

  // ── Stats ────────────────────────────────────────────────────────────────
  function updateStats(s) { ['fetched','deleted','dupes','scams'].forEach(k=>{ const el=document.getElementById('st-'+k); if(el)el.textContent=s[k]||0; }); }
  function addLog(entry) {
    const c=document.getElementById('log-container'); if(!c)return;
    c.querySelector('.log-empty')?.remove();
    const row=document.createElement('div'); row.className='log-row';
    const d=new Date(entry.ts);
    row.innerHTML=`<span class="log-time">${d.toLocaleDateString()} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span><span class="log-type ${entry.type}">${entry.type.toUpperCase()}</span><span class="log-msg">${esc(entry.msg)}</span>`;
    c.prepend(row);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _set(id,txt) { const el=document.getElementById(id); if(el)el.textContent=txt; }
  function _fmtDate(d) {
    if(!d)return''; const dt=new Date(d),now=new Date(),diff=now-dt;
    if(diff<86400000&&dt.getDate()===now.getDate()) return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(diff<604800000) return dt.toLocaleDateString([],{weekday:'short'});
    return dt.toLocaleDateString([],{month:'short',day:'numeric'});
  }
  function showErr(id,msg){ const el=document.getElementById(id); if(el){el.textContent=msg;el.classList.remove('hidden');} }
  function hideErr(id){ document.getElementById(id)?.classList.add('hidden'); }

  return {
    initTag,setTags,getTags,refreshTags,
    renderFolderNav,setActiveFolder,
    renderEmailList,removeRow,markScam,
    exitSelectionMode,getSelectedIds,isSelMode,
    showReader,setEmailBody,showAIResult,
    renderCalendar,
    setSync,showScan,hideScan,scanProg,scanLog,scanDone,
    updateStats,addLog,showErr,hideErr,esc,
  };
})();
