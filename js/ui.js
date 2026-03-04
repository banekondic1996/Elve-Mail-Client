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

  let _folderCtxMenu = null;

  function renderFolderNav(navEl, folders, unreadCounts, activeFolder, onSelect, onFolderAction) {
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
        el.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          _showFolderCtx(e.clientX, e.clientY, f, onFolderAction);
        });
        navEl.appendChild(el);
      });
    }

    const add = document.createElement('div');
    add.className = 'folder-item';
    add.innerHTML = '<span class="folder-icon">＋</span><span class="folder-label">New Folder</span>';
    add.addEventListener('click',()=>onSelect('__create_folder__'));
    navEl.appendChild(add);
  }

  function _ensureFolderCtx() {
    if (_folderCtxMenu) return _folderCtxMenu;
    const menu = document.createElement('div');
    menu.id = '_folder-ctx';
    menu.className = 'folder-ctx-menu hidden';
    document.body.appendChild(menu);
    document.addEventListener('click', () => menu.classList.add('hidden'));
    window.addEventListener('blur', () => menu.classList.add('hidden'));
    window.addEventListener('resize', () => menu.classList.add('hidden'));
    _folderCtxMenu = menu;
    return menu;
  }

  function _showFolderCtx(x, y, folder, onFolderAction) {
    if (!onFolderAction || folder?.special !== 'folder') return;
    const menu = _ensureFolderCtx();
    menu.innerHTML = `
      <button data-act="rename">Rename Folder</button>
      <button data-act="move">Move as Subfolder…</button>
      <button data-act="delete" class="danger">Delete Folder</button>
    `;
    menu.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onFolderAction(btn.dataset.act, folder.path);
      });
    });
    menu.classList.remove('hidden');
    const maxX = window.innerWidth - 210;
    const maxY = window.innerHeight - 140;
    menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
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
            <span class="er-meta">${msg.hasAttachment?'<span class="att-icon" title="Has attachment">📎</span>':''}<span class="er-date">${dt}</span></span>
          </div>
          <div class="er-subject">${esc(msg.subject||'(no subject)')}</div>
        </div>`;

      const cb = row.querySelector('input[type=checkbox]');

      let holdTriggered = false;
      const cancelHold = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      };

      // Hold 500ms = selection mode
      row.addEventListener('mousedown', ev => {
        if (ev.button !== 0) return;
        holdTriggered = false;
        cancelHold();
        holdTimer = setTimeout(() => {
          holdTimer = null;
          holdTriggered = true;
          _enterSel();
          cb.checked = true;
          row.classList.add('selected');
          _updateSelBar();
        }, 500);
      });
      ['mouseup','mouseleave'].forEach(e => row.addEventListener(e, cancelHold));

      // Click
      row.addEventListener('click', e => {
        if (holdTriggered) {
          holdTriggered = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
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

  function _readerPalette() {
    const cs = getComputedStyle(document.body || document.documentElement);
    const v = name => (cs.getPropertyValue(name) || '').trim();
    return {
      bg:     v('--reader-bg') || '#ffffff',
      panel:  v('--surface2')  || '#f5f7fb',
      text:   v('--text')      || '#1a1a2e',
      text2:  v('--text2')     || '#5b647a',
      border: v('--border')    || '#d5dbe8',
      accent: v('--accent')    || '#6c63ff',
      accent2:v('--accent2')   || '#8a82ff',
      mailSize: v('--mail-font-size') || '14px',
    };
  }

  function setEmailBody(bodyData, msg) {
    _ctxMsg = msg || null;
    const iframe = document.getElementById('reader-iframe');
    if (!iframe) return;
    const pal = _readerPalette();

    const plainSplit = _splitPlainThreads(bodyData.text || '');

    if (bodyData.html) {
      _writeIframe(iframe, _wrapHtml(bodyData.html, plainSplit));
    } else if (bodyData.text?.trim()) {
      const split = plainSplit;
      const replyItems = split.replies || [];
      const replyNav = replyItems.length > 1
        ? `<aside class="reply-nav"><div class="reply-nav-title">Replies</div>${replyItems.map((seg,i)=>`<a href="#_reply_${i+1}" class="reply-nav-btn">${esc(_replyLabel(seg, i))}</a>`).join('')}</aside>`
        : '';
      const replyHtml = replyItems.map((seg,i)=>`<details class="reply-thread" id="_reply_${i+1}" ${i===0?'open':''}><summary>${esc(_replyLabel(seg, i))}</summary><pre>${esc(seg)}</pre></details>`).join('');
      _writeIframe(iframe, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;}
        body{margin:0;padding:24px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:${pal.mailSize};line-height:1.75;color:${pal.text};background:${pal.bg};word-break:break-word;}
        body.has-reply-nav{padding-right:200px;}
        pre{white-space:pre-wrap;font-family:inherit;color:${pal.text};}
        details.reply-thread{margin-top:14px;border:1px solid ${pal.border};border-radius:10px;background:${pal.panel};}
        details.reply-thread>summary{cursor:pointer;padding:8px 12px;color:${pal.text2};font-weight:600;list-style:none;}
        details.reply-thread>summary::-webkit-details-marker{display:none;}
        details.reply-thread pre{padding:0 12px 12px;margin:0;color:${pal.text2};}
        a{color:${pal.accent};}
        .reply-nav{position:fixed;top:16px;right:10px;width:178px;border:1px solid ${pal.border};background:${pal.panel};border-radius:10px;padding:8px;z-index:20;max-height:82vh;overflow:auto;box-shadow:0 6px 20px rgba(0,0,0,.18);}
        .reply-nav-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${pal.text2};margin-bottom:6px;}
        .reply-nav-btn{display:block;padding:6px 7px;font-size:11px;color:${pal.text};text-decoration:none;border-radius:7px;margin-bottom:4px;background:transparent;}
        .reply-nav-btn:hover{background:rgba(0,0,0,.06);}
      </style></head><body class="${replyItems.length>1?'has-reply-nav':''}"><pre>${esc(split.main)}</pre>${replyHtml}${replyNav}</body></html>`);
    } else {
      _writeIframe(iframe, '<div style="padding:32px;color:#888;font-family:system-ui;font-size:14px">(No message body)</div>');
    }

    // Render attachment bar below iframe
    _renderAttachments(bodyData.attachments || []);
  }

  function _renderAttachments(attachments) {
    const bar = document.getElementById('reader-attachments');
    if (!bar) return;
    if (!attachments || !attachments.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = attachments.map((a, i) => {
      const sz = !a.size ? '' : a.size > 1024*1024 ? (a.size/1024/1024).toFixed(1)+'MB' : a.size > 1024 ? Math.round(a.size/1024)+'KB' : a.size+'B';
      const isIcs = /calendar|ics|vcalendar/i.test(a.contentType) || /\.ics$/i.test(a.filename||'');
      const icon  = isIcs ? '📅' : /image/i.test(a.contentType) ? '🖼' : /pdf/i.test(a.contentType) ? '📄' : /zip|archive/i.test(a.contentType) ? '📦' : '📎';
      return `<button class="att-chip" data-i="${i}" title="${esc(a.filename)}">${icon} ${esc(a.filename||'attachment')}${sz?' <span class="att-size">'+sz+'</span>':''}${isIcs?'<span class="att-ics-badge">calendar</span>':''}</button>`;
    }).join('');

    bar.querySelectorAll('.att-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = attachments[parseInt(btn.dataset.i)];
        if (!a) return;

        const isIcs = /calendar|ics|vcalendar/i.test(a.contentType) || /\.ics$/i.test(a.filename||'');
        const isImage = _isImageAttachment(a);
        const isPdf = _isPdfAttachment(a);

        if (!a.content) {
          // Not yet downloaded
          btn.style.opacity = '0.5';
          setTimeout(() => { btn.style.opacity = ''; }, 2000);
          return;
        }

        if (isIcs) {
          // Show ICS-specific dialog: Save file OR Add to app calendar
          _showIcsDialog(a);
          return;
        }

        if (isImage) {
          _showImagePreview(a);
          return;
        }

        if (isPdf) {
          _showPdfPreview(a);
          return;
        }

        // Standard save-as for all other types
        _saveAttachment(a);
      });
    });
  }

  function _toU8(content) {
    if (!content) throw new Error('Attachment content missing');
    if (content instanceof Uint8Array) return content;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) return new Uint8Array(content);
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (Array.isArray(content)) return Uint8Array.from(content);
    if (content.buffer instanceof ArrayBuffer && typeof content.byteLength === 'number') {
      return new Uint8Array(content.buffer, content.byteOffset || 0, content.byteLength);
    }
    if (typeof content === 'string') {
      return typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(content)
        : Uint8Array.from(content.split('').map(ch => ch.charCodeAt(0) & 0xff));
    }
    throw new Error('Unsupported attachment format');
  }

  function _downloadBlob(filename, bytes, contentType) {
    const blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function _isImageAttachment(a) {
    return /image\//i.test(a.contentType || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.filename || '');
  }

  function _isPdfAttachment(a) {
    return /application\/pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || '');
  }

  function _saveAttachment(a) {
    try {
      const bytes = _toU8(a.content);
      const filename = a.filename || 'attachment';
      _downloadBlob(filename, bytes, a.contentType);
    } catch(e) {
      console.error('[Attachment] Save error:', e);
      alert('Could not save attachment:\n' + e.message);
    }
  }

  function _showImagePreview(a) {
    let bytes;
    try { bytes = _toU8(a.content); }
    catch(e) { alert('Could not open image preview:\n' + e.message); return; }

    const blob = new Blob([bytes], { type: a.contentType || 'image/*' });
    const url = URL.createObjectURL(blob);
    document.getElementById('_img-preview')?.remove();

    const dlg = document.createElement('div');
    dlg.id = '_img-preview';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;';
    dlg.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;max-width:96vw;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);gap:10px;">
          <span style="font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw;">🖼 ${esc(a.filename || 'image')}</span>
          <div style="display:flex;gap:6px;">
            <button id="_img-download" class="toolbar-btn">Download</button>
            <button id="_img-close" class="toolbar-btn">Close</button>
          </div>
        </div>
        <div style="padding:10px;display:flex;align-items:center;justify-content:center;max-width:96vw;max-height:84vh;overflow:auto;background:#000;">
          <img src="${url}" alt="${esc(a.filename || 'image')}" style="max-width:100%;max-height:82vh;object-fit:contain;">
        </div>
      </div>`;
    document.body.appendChild(dlg);

    const close = () => {
      URL.revokeObjectURL(url);
      dlg.remove();
    };
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    dlg.querySelector('#_img-close')?.addEventListener('click', close);
    dlg.querySelector('#_img-download')?.addEventListener('click', () => _downloadBlob(a.filename || 'image', bytes, a.contentType));
  }

  function _showPdfPreview(a) {
    let bytes;
    try { bytes = _toU8(a.content); }
    catch(e) { alert('Could not open PDF:\n' + e.message); return; }

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('_pdf-preview')?.remove();

    const dlg = document.createElement('div');
    dlg.id = '_pdf-preview';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;';
    dlg.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;max-width:98vw;max-height:96vh;width:960px;display:flex;flex-direction:column;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);gap:10px;">
          <span style="font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw;">📄 ${esc(a.filename || 'document.pdf')}</span>
          <div style="display:flex;gap:6px;">
            <button id="_pdf-download" class="toolbar-btn">Download</button>
            <button id="_pdf-open-ext" class="toolbar-btn">Open External</button>
            <button id="_pdf-close" class="toolbar-btn">Close</button>
          </div>
        </div>
        <div style="background:#111;flex:1;min-height:65vh;">
          <iframe src="${url}" style="width:100%;height:100vh;border:none;" title="${esc(a.filename || 'PDF Preview')}"></iframe>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    const close = () => {
      URL.revokeObjectURL(url);
      dlg.remove();
    };
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    dlg.querySelector('#_pdf-close')?.addEventListener('click', close);
    dlg.querySelector('#_pdf-download')?.addEventListener('click', () => _downloadBlob(a.filename || 'document.pdf', bytes, 'application/pdf'));
    dlg.querySelector('#_pdf-open-ext')?.addEventListener('click', () => {
      if (typeof nw !== 'undefined') nw.Shell.openExternal(url);
      else window.open(url, '_blank');
    });
  }

  function _showIcsDialog(a) {
    document.getElementById('_ics-dialog')?.remove();

    // Decode ICS text first to extract event details for preview
    let icsText = '';
    try {
      if (typeof a.content === 'string') {
        icsText = a.content;
      } else {
        const bytes = a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
        icsText = new TextDecoder('utf-8').decode(bytes);
      }
    } catch(e) {}

    // Parse event details for preview
    let events = [];
    try { events = Calendar.parseICS(icsText, '', '#6c63ff'); } catch(e) {}
    const ev = events[0]; // Show first event as preview

    const fmtDate = (d) => {
      if (!d) return '';
      return d.toLocaleString([], {weekday:'short', year:'numeric', month:'short', day:'numeric',
        hour: d.getHours()===0&&d.getMinutes()===0?undefined:'2-digit',
        minute: d.getHours()===0&&d.getMinutes()===0?undefined:'2-digit'});
    };

    const previewHtml = ev ? `
      <div style="background:var(--surface2);border-radius:12px;padding:14px 16px;margin-bottom:18px;border-left:4px solid var(--accent);">
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">${esc(ev.summary)}</div>
        <div style="font-size:12px;color:var(--text2);display:flex;flex-direction:column;gap:3px;">
          <div>📅 ${esc(fmtDate(ev.start))}${ev.end?' → '+esc(fmtDate(ev.end)):''}</div>
          ${ev.location?`<div>📍 ${esc(ev.location)}</div>`:''}
          ${ev.organizer?`<div>👤 ${esc(ev.organizer)}</div>`:''}
          ${ev.attendees&&ev.attendees.length?`<div>👥 ${ev.attendees.slice(0,3).map(a=>esc(a)).join(', ')}${ev.attendees.length>3?' +'+( ev.attendees.length-3)+' more':''}</div>`:''}
          ${ev.description?`<div style="margin-top:6px;color:var(--text3);font-size:11px;line-height:1.5">${esc(ev.description.slice(0,140))}${ev.description.length>140?'…':''}</div>`:''}
        </div>
      </div>
      ${events.length>1?`<div style="font-size:12px;color:var(--text3);margin-bottom:12px">+${events.length-1} more event${events.length>2?'s':''} in this file</div>`:''}
    ` : '';

    const dlg = document.createElement('div');
    dlg.id = '_ics-dialog';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;padding:20px;';
    dlg.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:18px;padding:24px 26px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto;">
        <div style="font-size:28px;margin-bottom:8px;">📅</div>
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">${esc(a.filename||'Calendar Invite')}</div>
        <div style="font-size:13px;color:var(--text3);margin-bottom:16px;">${events.length} event${events.length!==1?'s':''} found</div>
        ${previewHtml}
        <div style="margin-bottom:18px;">
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">Remind me</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${[['None','0'],['15 min','15'],['30 min','30'],['1 hour','60'],['2 hours','120'],['1 day','1440'],['Custom','custom']].map(([label,val])=>
              `<button class="ics-remind-btn" data-val="${val}" style="padding:5px 12px;border-radius:20px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;cursor:pointer;transition:all .15s">${esc(label)}</button>`
            ).join('')}
          </div>
          <div id="_ics-custom-wrap" style="display:none;margin-top:10px;display:flex;gap:8px;align-items:center">
            <input id="_ics-custom-min" type="number" min="1" max="99999" placeholder="Minutes" style="width:100px;padding:6px 10px;border-radius:8px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:13px;">
            <span style="font-size:13px;color:var(--text2)">minutes before</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="_ics-add" style="background:var(--accent);color:#fff;border:none;border-radius:10px;padding:11px 0;font-size:14px;font-weight:700;cursor:pointer;">📅 Add to Elve Calendar</button>
          <button id="_ics-save" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:10px;padding:11px 0;font-size:14px;cursor:pointer;">💾 Save File</button>
          <button id="_ics-cancel" style="background:none;border:none;color:var(--text3);font-size:13px;cursor:pointer;padding:6px;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    // Reminder button selection
    let selectedReminder = 0; // minutes, 0 = none
    const remindBtns = dlg.querySelectorAll('.ics-remind-btn');
    remindBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        remindBtns.forEach(b => { b.style.background='var(--surface2)'; b.style.color='var(--text)'; });
        btn.style.background='var(--accent)'; btn.style.color='#fff';
        const val = btn.dataset.val;
        const customWrap = document.getElementById('_ics-custom-wrap');
        if (val === 'custom') {
          customWrap.style.display='flex'; selectedReminder=0;
          document.getElementById('_ics-custom-min')?.focus();
        } else {
          customWrap.style.display='none'; selectedReminder=parseInt(val)||0;
        }
      });
    });
    document.getElementById('_ics-custom-min')?.addEventListener('input', e => {
      selectedReminder = parseInt(e.target.value)||0;
    });

    document.getElementById('_ics-cancel').onclick = () => dlg.remove();
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
    document.getElementById('_ics-save').onclick = () => { dlg.remove(); _saveAttachment(a); };

    document.getElementById('_ics-add').onclick = async () => {
      dlg.remove();
      try {
        const calName = (a.filename||'Imported').replace(/\.ics$/i,'');
        const cal = await Calendar.loadFromFile(icsText, calName);
        // Apply user-chosen reminder to all events in this calendar
        if (selectedReminder > 0) {
          (cal.events||[]).forEach(ev => { ev.userReminder = selectedReminder; });
          Calendar.save();
        }
        // Request notification permission
        if ('Notification' in window && Notification.permission==='default') {
          Notification.requestPermission().catch(()=>{});
        }
        // Toast
        const toast = document.createElement('div');
        const evCount = (cal.events||[]).length;
        toast.textContent = `✓ Added "${calName}" — ${evCount} event${evCount!==1?'s':''}${selectedReminder>0?' · Reminder: '+_fmtReminder(selectedReminder):''}`;
        toast.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;z-index:10001;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.3)';
        document.body.appendChild(toast);
        setTimeout(()=>toast.remove(), 4000);
      } catch(e) { alert('Failed to import calendar: ' + e.message); }
    };
  }

  function _fmtReminder(mins) {
    if (mins >= 1440) return Math.round(mins/1440)+'d before';
    if (mins >= 60) return Math.round(mins/60)+'h before';
    return mins+'min before';
  }

  function _wrapHtml(html, plainSplit) {
    const pal = _readerPalette();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    const replies = plainSplit?.replies || [];
    const threadSection = replies.length > 1 ? `
  <section class="_thread-fallback">
    <h3>Conversation Thread</h3>
    ${replies.map((seg, i) => `<details class="reply-thread" id="_txt_reply_${i+1}" ${i===0?'open':''}><summary>${esc(_replyLabel(seg, i))}</summary><div class="reply-thread-inner"><pre>${esc(seg)}</pre></div></details>`).join('')}
  </section>` : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;}
  body{background:${pal.bg}!important;color:${pal.text}!important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:${pal.mailSize};line-height:1.7;padding:16px;max-width:100%;overflow-x:hidden;word-break:break-word;}
  body.has-reply-nav{padding-right:200px;}
  img{max-width:100%!important;height:auto!important;}
  *{max-width:100%;box-sizing:border-box;}
  p,div,span,td,th,li,pre,strong,b,em{color:inherit;}
  a{color:${pal.accent}!important;cursor:pointer;}
  a[title]{position:relative;}
  blockquote,.gmail_quote,.yahoo_quoted,.protonmail_quote{display:block!important;margin:12px 0 12px 8px!important;padding-left:12px!important;border-left:2px solid ${pal.border}!important;color:${pal.text2}!important;}
  details.reply-thread{margin:12px 0;border:1px solid ${pal.border};border-radius:10px;background:${pal.panel};}
  details.reply-thread>summary{cursor:pointer;padding:8px 12px;color:${pal.text2};font-weight:600;list-style:none;}
  details.reply-thread>summary::-webkit-details-marker{display:none;}
  details.reply-thread .reply-thread-inner{padding:0 12px 12px;}
  .reply-nav{position:fixed;top:16px;right:10px;width:178px;border:1px solid ${pal.border};background:${pal.panel};border-radius:10px;padding:8px;z-index:22;max-height:82vh;overflow:auto;box-shadow:0 6px 20px rgba(0,0,0,.18);}
  .reply-nav-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${pal.text2};margin-bottom:6px;}
  .reply-nav-btn{display:block;width:100%;padding:6px 7px;font-size:11px;color:${pal.text};text-align:left;border:none;background:transparent;border-radius:7px;cursor:pointer;margin-bottom:4px;}
  .reply-nav-btn:hover{background:rgba(0,0,0,.06);}
  pre{white-space:pre-wrap!important;font-family:inherit!important;}
  #_ctx{position:fixed;background:#1e1e2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:9999;min-width:180px;padding:4px 0;font-family:system-ui;font-size:12px;}
  #_ctx button{display:block;width:100%;background:none;border:none;color:#c8c8e8;padding:8px 14px;text-align:left;cursor:pointer;}
  #_ctx button:hover{background:rgba(108,99,255,.2);color:#fff;}
  #_ctx hr{border:none;border-top:1px solid #2a2a3e;margin:3px 0;}
  #_tt{position:fixed;background:#111;color:#adf;font-size:11px;padding:4px 8px;border-radius:5px;z-index:9998;pointer-events:none;max-width:320px;word-break:break-all;white-space:pre-wrap;}
  ._thread-fallback{margin-top:20px;padding:12px;border:1px dashed ${pal.border};border-radius:12px;background:${pal.panel};}
  ._thread-fallback h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${pal.text2};margin:0 0 8px;}
</style>
</head><body>${clean}${threadSection}</body></html>`;
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
      _enhanceReplyThreads(doc);
      _enforceReadableColors(doc);
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
          if (href.startsWith('#')) {
            const target = doc.querySelector(href);
            if (target) {
              if (target.tagName === 'DETAILS') target.open = true;
              target.scrollIntoView({behavior:'smooth', block:'start'});
            }
            return;
          }
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

  function _enhanceReplyThreads(doc) {
    const sel = 'blockquote,.gmail_quote,.yahoo_quoted,.protonmail_quote';
    const quotes = [...doc.querySelectorAll(sel)];
    quotes.sort((a,b)=>_nodeDepth(b)-_nodeDepth(a));
    const wrapped = [];
    quotes.forEach(node => {
      if (!node || node.closest('details.reply-thread')) return;
      const txt = (node.textContent || '').trim();
      if (!txt || txt.length < 8) return;
      const split = _splitPlainThreads(txt);
      if ((split.replies || []).length > 1 && node.parentNode) {
        const frag = doc.createDocumentFragment();
        split.replies.forEach((seg, i) => {
          const d = doc.createElement('details');
          d.className = 'reply-thread';
          d.id = `_reply_${wrapped.length + 1}`;
          const s = doc.createElement('summary');
          s.textContent = _replyLabel(seg, wrapped.length);
          const body = doc.createElement('div');
          body.className = 'reply-thread-inner';
          const pre = doc.createElement('pre');
          pre.textContent = seg;
          body.appendChild(pre);
          d.appendChild(s);
          d.appendChild(body);
          if (wrapped.length === 0 && i === 0) d.open = true;
          wrapped.push({id:d.id,label:s.textContent});
          frag.appendChild(d);
        });
        node.parentNode.insertBefore(frag, node);
        node.remove();
        return;
      }
      const d = doc.createElement('details');
      d.className = 'reply-thread';
      d.id = `_reply_${wrapped.length + 1}`;
      const s = doc.createElement('summary');
      s.textContent = _replyLabel(txt, wrapped.length);
      const wrap = doc.createElement('div');
      wrap.className = 'reply-thread-inner';
      node.parentNode?.insertBefore(d, node);
      d.appendChild(s);
      d.appendChild(wrap);
      wrap.appendChild(node);
      if (wrapped.length === 0) d.open = true;
      wrapped.push({id:d.id,label:s.textContent});
    });
    if (wrapped.length > 1) _mountReplyNav(doc, wrapped);
  }

  function _nodeDepth(n) {
    let d = 0, cur = n;
    while (cur && cur.parentElement) { d++; cur = cur.parentElement; }
    return d;
  }

  function _mountReplyNav(doc, replies) {
    doc.getElementById('_reply_nav')?.remove();
    const nav = doc.createElement('aside');
    nav.id = '_reply_nav';
    nav.className = 'reply-nav';
    nav.innerHTML = `<div class="reply-nav-title">Replies</div>`;
    replies.forEach((r, i) => {
      const b = doc.createElement('button');
      b.className = 'reply-nav-btn';
      b.textContent = r.label || `Reply ${i + 1}`;
      b.addEventListener('click', () => {
        const target = doc.getElementById(r.id);
        if (!target) return;
        target.open = true;
        target.scrollIntoView({behavior:'smooth', block:'start'});
      });
      nav.appendChild(b);
    });
    doc.body.appendChild(nav);
    doc.body.classList.add('has-reply-nav');
  }

  function _extractThreadStamp(text) {
    const t = String(text || '').slice(0, 420);
    const rx = [
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\w{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[AP]M)?)?/i,
      /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s?[AP]M)?)?/,
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s?[AP]M)?)?/i,
    ];
    for (const re of rx) {
      const m = t.match(re);
      if (m) return m[0];
    }
    return '';
  }

  function _replyLabel(text, idx) {
    const stamp = _extractThreadStamp(text);
    return stamp ? `Reply ${idx + 1} · ${stamp}` : `Reply ${idx + 1}`;
  }

  function _splitPlainThreads(text) {
    const src = String(text || '');
    const markers = [
      /\nOn .{0,200}wrote:\n/gi,
      /\n>+\s*On .{0,200}wrote:\n/gi,
      /\n-{2,}\s*Original Message\s*-{2,}\n/gi,
      /\nFrom:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+\n/gi,
      /\nFrom:\s.+\nDate:\s.+\nSubject:\s.+\n/gi,
      /\n_{2,}\nFrom:\s.+\n/gi,
      /\nBegin forwarded message:\n/gi,
    ];
    const cuts = [];
    markers.forEach(re => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        if (m.index > 0) cuts.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    });
    const points = [...new Set(cuts)].sort((a,b)=>a-b);
    if (!points.length) return { main: src.trim(), replies: [] };
    const main = src.slice(0, points[0]).trim();
    const replies = points.map((start, i) => src.slice(start, points[i + 1] ?? src.length).trim()).filter(Boolean);
    return { main: main || src.trim(), replies };
  }

  function _parseRGBA(color) {
    if (!color) return null;
    const c = String(color).trim();
    if (/^#([0-9a-f]{6})$/i.test(c)) {
      const h = c.slice(1);
      return { rgb: [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)], a: 1 };
    }
    if (/^#([0-9a-f]{3})$/i.test(c)) {
      const h = c.slice(1);
      return { rgb: [parseInt(h[0] + h[0],16), parseInt(h[1] + h[1],16), parseInt(h[2] + h[2],16)], a: 1 };
    }
    if (/transparent/i.test(c)) return { rgb: null, a: 0 };
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
    if (!m) return null;
    return {
      rgb: [parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10)],
      a: m[4] == null ? 1 : Math.max(0, Math.min(1, parseFloat(m[4]) || 0)),
    };
  }

  function _luma(rgb) {
    if (!rgb) return 1;
    const [r,g,b] = rgb.map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  }

  function _contrast(a, b) {
    const l1 = _luma(a), l2 = _luma(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function _enforceReadableColors(doc) {
    const pal = _readerPalette();
    const body = doc?.body;
    if (!body) return;

    const bg = (_parseRGBA(doc.defaultView?.getComputedStyle(body).backgroundColor)?.rgb) ||
      (_parseRGBA(pal.bg)?.rgb) ||
      [10,10,16];
    if (_luma(bg) > 0.45) return; // mostly needed for dark themes

    const textRGB = (_parseRGBA(pal.text)?.rgb) || [226,226,240];
    const accRGB = (_parseRGBA(pal.accent)?.rgb) || [108,99,255];
    const nodes = body.querySelectorAll('*');

    nodes.forEach(el => {
      const tag = (el.tagName || '').toLowerCase();
      if (['img','svg','path','video','canvas'].includes(tag)) return;
      const cs = doc.defaultView?.getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return;
      const fg = _parseRGBA(cs.color)?.rgb;
      if (!fg) return;
      const effectiveBg = _effectiveBgRGB(el, bg, doc);
      if (_luma(effectiveBg) > 0.62) return; // keep original colors on light backgrounds
      if (_contrast(fg, effectiveBg) >= 4.3) return;
      const target = (tag === 'a' || el.closest('a')) ? accRGB : textRGB;
      el.style.setProperty('color', `rgb(${target[0]}, ${target[1]}, ${target[2]})`, 'important');
    });
  }

  function _effectiveBgRGB(el, fallback, doc) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const bg = _parseRGBA(doc.defaultView?.getComputedStyle(cur).backgroundColor);
      if (bg && bg.rgb && bg.a > 0.15) return bg.rgb;
      cur = cur.parentElement;
    }
    return fallback;
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
