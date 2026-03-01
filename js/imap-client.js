// js/imap-client.js — Elve Mail IMAP Engine v8
// Cache-first architecture:
//  - IndexedDB stores all headers + bodies persistently across sessions.
//  - fetchPage() serves from cache; only hits IMAP when not yet fetched.
//  - fetchBody() returns from IndexedDB instantly; marks \Seen on server async.
//  - Background sync walks all folders/pages once, skipping already-cached.
//  - forceRefresh=true bypasses cache for explicit user refresh.

'use strict';
const ImapEngine = (() => {
  let Imap, simpleParser;
  try { Imap = require('imap'); } catch(e) {}
  try { simpleParser = require('mailparser').simpleParser; } catch(e) {}

  const SERVERS = {
    gmail:   { host:'imap.gmail.com',        port:993 },
    yahoo:   { host:'imap.mail.yahoo.com',   port:993 },
    outlook: { host:'imap-mail.outlook.com', port:993 },
    hotmail: { host:'imap-mail.outlook.com', port:993 },
    live:    { host:'imap-mail.outlook.com', port:993 },
    icloud:  { host:'imap.mail.me.com',      port:993 },
    aol:     { host:'imap.aol.com',          port:993 },
  };

  const PAGE_SIZE = 50;
  const POLL_MS   = 60000;
  const DB_NAME   = 'elve_mail_v3';
  const DB_VER    = 1;

  // ── Four IMAP connections ─────────────────────────────────────────────────
  let listConn = null;
  let bodyConn = null;
  let opConn   = null;
  let pollConn = null;
  let cfg      = null;

  // ── In-memory caches (warm-loaded from IndexedDB on connect) ─────────────
  // headerCache: cacheKey → { messages[], total, totalPages, ts }
  // bodyCache:   bodyKey  → bodyData
  // allHeaders:  folder   → Map<uid, message>  (all pages merged, for search)
  const headerCache = new Map();
  const bodyCache   = new Map();
  const allHdrs     = new Map();

  // ── IndexedDB ─────────────────────────────────────────────────────────────
  let _db = null;
  async function _openDB() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('bodies'))  d.createObjectStore('bodies');
        if (!d.objectStoreNames.contains('headers')) d.createObjectStore('headers');
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  function _ak() { return (cfg?.email || 'default').replace(/[^a-z0-9@._-]/gi, '_'); }
  function _hkey(folder, page) { return `${_ak()}::${folder}::${page}`; }
  function _bkey(folder, uid)  { return `${_ak()}::${folder}::${uid}`;  }
  function _ahkey(folder)      { return `${_ak()}::${folder}`; }

  function _dbGet(store, key) {
    return new Promise(res => {
      try {
        const tx  = _db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = () => res(null);
      } catch(e) { res(null); }
    });
  }
  function _dbPut(store, key, val) {
    return new Promise(res => {
      try {
        const tx = _db.transaction(store, 'readwrite');
        tx.objectStore(store).put(val, key);
        tx.oncomplete = res; tx.onerror = res;
      } catch(e) { res(); }
    });
  }
  function _dbDel(store, key) {
    return new Promise(res => {
      try {
        const tx = _db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = res; tx.onerror = res;
      } catch(e) { res(); }
    });
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  async function connect(config) {
    cfg = config;
    await _openDB();
    if (!_alive(listConn)) { listConn = await _mkConn(config); }
    return listConn;
  }

  function _alive(c) { try { return c && c.state !== 'disconnected'; } catch(_) { return false; } }

  function _mkConn(config) {
    return new Promise((res, rej) => {
      if (!Imap) return rej(new Error('imap module not installed. Run: npm install'));
      const srv = _srv(config);
      const imap = new Imap({
        user: config.email, password: config.password,
        host: srv.host, port: srv.port, tls: true,
        tlsOptions: { rejectUnauthorized: false, servername: srv.host },
        connTimeout: 20000, authTimeout: 15000,
        keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true },
      });
      imap.once('ready', () => res(imap));
      imap.once('error', () => {});
      imap.connect();
    });
  }

  function _srv(config) {
    const domain = (config.email || '').split('@')[1]?.toLowerCase() || '';
    const key = config.provider !== 'imap'
      ? config.provider
      : Object.keys(SERVERS).find(k => domain.includes(k)) || null;
    return (key && SERVERS[key]) || { host: config.host || '', port: parseInt(config.port) || 993 };
  }

  async function _ensureList() { if (!_alive(listConn)) { listConn = await _mkConn(cfg); } }
  async function _ensureBody() { if (!_alive(bodyConn)) bodyConn = await _mkConn(cfg); }
  async function _ensureOp()   { if (!_alive(opConn))   opConn   = await _mkConn(cfg); }
  async function _ensurePoll() { if (!_alive(pollConn)) pollConn = await _mkConn(cfg); }

  function disconnect() {
    clearPoll();
    [listConn, bodyConn, opConn, pollConn].forEach(c => { if (c) try { c.end(); } catch(_) {} });
    listConn = bodyConn = opConn = pollConn = null;
  }

  // ── List folders ──────────────────────────────────────────────────────────
  async function listFolders() {
    await _ensureList();
    return new Promise((res, rej) => {
      listConn.getBoxes('', (err, boxes) => {
        if (err) return rej(err);
        const folders = [], seenSp = new Set();
        function walk(tree, prefix) {
          for (const [name, box] of Object.entries(tree || {})) {
            const delim = box.delimiter || '/';
            const path  = prefix ? prefix + delim + name : name;
            const sp    = _detectSpecial(path, box.attribs || []);
            if (sp !== 'folder') {
              if (seenSp.has(sp)) { if (box.children) walk(box.children, path); continue; }
              seenSp.add(sp);
            }
            folders.push({ path, name, special: sp });
            if (box.children) walk(box.children, path);
          }
        }
        walk(boxes, '');
        res(folders);
      });
    });
  }

  function _detectSpecial(path, attribs) {
    const p = path.toLowerCase(), a = attribs.map(x => (x||'').toLowerCase());
    if (p === 'inbox' || p.endsWith('/inbox'))                  return 'inbox';
    if (a.includes('\\sent')    || /\bsent\b/i.test(p))        return 'sent';
    if (a.includes('\\trash')   || /trash|deleted/i.test(p))   return 'trash';
    if (a.includes('\\drafts')  || /draft/i.test(p))           return 'drafts';
    if (a.includes('\\junk')    || /spam|junk|bulk/i.test(p))  return 'spam';
    if (a.includes('\\flagged') || /flagged|starred/i.test(p)) return 'flagged';
    if (a.includes('\\archive') || /archive/i.test(p))         return 'archive';
    return 'folder';
  }

  // ── fetchPage — CACHE-FIRST ───────────────────────────────────────────────
  // Serves from IndexedDB/memory; only hits IMAP if not yet cached.
  // forceRefresh=true: skip cache, fetch from IMAP, update cache.
  async function fetchPage(folder, page, onProgress, forceRefresh) {
    page = Math.max(1, page || 1);
    const hk = _hkey(folder, page);

    // 1. Memory cache
    if (!forceRefresh && headerCache.has(hk)) {
      return headerCache.get(hk);
    }

    // 2. IndexedDB cache
    if (!forceRefresh) {
      const stored = await _dbGet('headers', hk);
      if (stored && stored.messages && stored.messages.length) {
        headerCache.set(hk, stored);
        _mergeAllHdrs(folder, stored.messages);
        return stored;
      }
    }

    // 3. Fetch from IMAP
    await _ensureList();
    const box = await new Promise((res, rej) => {
      listConn.openBox(folder, true, (err, b) => err ? rej(err) : res(b));
    });

    const total = box.messages.total || 0;
    if (total === 0) {
      const empty = { messages: [], total: 0, page: 1, totalPages: 1, ts: Date.now() };
      headerCache.set(hk, empty);
      await _dbPut('headers', hk, empty);
      return empty;
    }

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const seqEnd     = total - (page - 1) * PAGE_SIZE;
    const seqStart   = Math.max(1, seqEnd - PAGE_SIZE + 1);
    if (seqEnd < 1) return { messages: [], total, page, totalPages, ts: Date.now() };

    onProgress && onProgress({ seqStart, seqEnd, total });
    const messages = await _fetchHeaders(`${seqStart}:${seqEnd}`, folder);
    messages.sort((a, b) => b.date - a.date);

    const result = { messages, total, page, totalPages, ts: Date.now() };
    headerCache.set(hk, result);
    _mergeAllHdrs(folder, messages);
    _dbPut('headers', hk, result).catch(() => {});

    return result;
  }

  function _mergeAllHdrs(folder, messages) {
    const key = _ahkey(folder);
    if (!allHdrs.has(key)) allHdrs.set(key, new Map());
    const map = allHdrs.get(key);
    for (const m of messages) { if (m.uid) map.set(m.uid, m); }
  }

  function getAllCachedHeaders(folder) {
    const key = _ahkey(folder);
    const map = allHdrs.get(key);
    if (!map || !map.size) return [];
    return [...map.values()].sort((a, b) => b.date - a.date);
  }

  // ── _fetchHeaders ─────────────────────────────────────────────────────────
  function _fetchHeaders(range, folder) {
    return new Promise((resolve, reject) => {
      const f = listConn.seq.fetch(range, {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE CONTENT-TYPE)'],
        markSeen: false, struct: true,
      });
      const msgs = [];
      f.on('message', (msg, seqno) => {
        const m = { seqno, uid: null, flags: [], folder };
        let hdr = '';
        msg.on('body', s => { let b = ''; s.on('data', c => b += c); s.once('end', () => hdr = b); });
        msg.once('attributes', a => { m.uid = a.uid; m.flags = a.flags || []; m.struct = a.struct; });
        msg.once('end', () => {
          const h       = _parseHdr(hdr);
          m.from        = _mime(h.from || '');
          m.to          = _mime(h.to || '');
          m.subject     = _mime(h.subject || '(no subject)');
          m.messageId   = h['message-id'] || '';
          m.date        = h.date ? new Date(h.date) : new Date(0);
          m.unread      = !m.flags.includes('\\Seen');
          m.id          = `${folder}::${m.uid || m.seqno}`;
          m.listUnsub   = h['list-unsubscribe'] || '';
          m.hasAttachment = _structHasAttachment(m.struct) ||
            /multipart\/(mixed|related)/i.test(h['content-type'] || '');
          delete m.struct;
          msgs.push(m);
        });
      });
      f.once('error', reject);
      f.once('end', () => resolve(msgs));
    });
  }

  function _structHasAttachment(s) {
    if (!s) return false;
    function walk(n) {
      if (!n) return false;
      if (Array.isArray(n)) return n.some(walk);
      if (n.disposition && /attachment/i.test(n.disposition.type)) return true;
      if (n.type && /^(application|audio|video)/i.test(n.type) && !/pgp-signature/i.test(n.type)) return true;
      return false;
    }
    return walk(s);
  }

  // ── prefetchBodies — background, skip already-cached ─────────────────────
  async function prefetchBodies(folder, uids, onProgress) {
    if (!uids?.length) return;

    // Determine which UIDs need fetching (not in memory or IndexedDB)
    const needed = [];
    for (const uid of uids) {
      const bk = _bkey(folder, uid);
      if (bodyCache.has(bk)) continue;
      const stored = await _dbGet('bodies', bk);
      if (stored) {
        // Warm memory cache from IndexedDB
        stored.attachments = (stored.attachments || []).map(a => ({
          ...a, content: a.content ? new Uint8Array(a.content) : null,
        }));
        bodyCache.set(bk, stored);
      } else {
        needed.push(uid);
      }
    }

    const alreadyDone = uids.length - needed.length;
    onProgress && onProgress({ done: alreadyDone, total: uids.length });

    if (!needed.length) return;

    await _ensureBody();
    await new Promise((res, rej) => {
      bodyConn.openBox(folder, false, e => e ? rej(e) : res());
    });

    const BATCH = 5;
    let done = alreadyDone;
    for (let i = 0; i < needed.length; i += BATCH) {
      const batch = needed.slice(i, i + BATCH);
      await _fetchBodiesBatch(folder, batch).catch(() => {});
      done += batch.length;
      onProgress && onProgress({ done, total: uids.length });
    }
  }

  function _fetchBodiesBatch(folder, uids) {
    return new Promise(resolve => {
      let pending = uids.length;
      if (!pending) return resolve();
      const f = bodyConn.fetch(uids, { bodies: [''], markSeen: false });
      f.on('message', msg => {
        let raw = '', uid = null;
        msg.on('body', s => s.on('data', c => raw += c));
        msg.once('attributes', a => { uid = a.uid; });
        msg.once('end', async () => {
          if (uid && raw) {
            const bk = _bkey(folder, uid);
            try {
              const p = await simpleParser(raw);
              const bd = {
                html: p.html || null, text: p.text || null,
                listUnsub: p.headers?.get('list-unsubscribe') || '',
                attachments: (p.attachments || []).map(a => ({
                  filename: a.filename || 'attachment',
                  contentType: a.contentType || 'application/octet-stream',
                  size: a.size || 0, content: a.content,
                })),
              };
              bodyCache.set(bk, bd);
              // Persist: convert Buffer/Uint8Array to plain array for IndexedDB
              const toStore = { ...bd, attachments: bd.attachments.map(a => ({
                ...a, content: a.content ? Array.from(a.content) : null,
              })) };
              _dbPut('bodies', bk, toStore).catch(() => {});
            } catch(e) {
              const bi = raw.indexOf('\r\n\r\n');
              const bd = { html: null, listUnsub: '', text: bi >= 0 ? raw.slice(bi+4) : raw, attachments: [] };
              bodyCache.set(bk, bd);
              _dbPut('bodies', bk, bd).catch(() => {});
            }
          }
          if (--pending <= 0) resolve();
        });
      });
      f.once('error', () => resolve());
      f.once('end', () => { if (pending <= 0) resolve(); });
    });
  }

  // ── fetchBody — instant from cache ────────────────────────────────────────
  async function fetchBody(folder, uid) {
    const bk = _bkey(folder, uid);

    // Memory
    if (bodyCache.has(bk)) {
      _markSeenAsync(folder, uid);
      return bodyCache.get(bk);
    }

    // IndexedDB
    const stored = await _dbGet('bodies', bk);
    if (stored) {
      stored.attachments = (stored.attachments || []).map(a => ({
        ...a, content: a.content ? new Uint8Array(a.content) : null,
      }));
      bodyCache.set(bk, stored);
      _markSeenAsync(folder, uid);
      return stored;
    }

    // IMAP fallback (uncached)
    await _ensureBody();
    await new Promise((res, rej) => { bodyConn.openBox(folder, false, e => e ? rej(e) : res()); });
    return new Promise((resolve, reject) => {
      const f = bodyConn.fetch([uid], { bodies: [''], markSeen: true });
      let raw = '';
      f.on('message', m => m.on('body', s => s.on('data', c => raw += c)));
      f.once('error', reject);
      f.once('end', async () => {
        if (!raw) return resolve({ html: null, text: '(empty)', attachments: [], listUnsub: '' });
        try {
          const p = await simpleParser(raw);
          const bd = {
            html: p.html || null, text: p.text || null,
            listUnsub: p.headers?.get('list-unsubscribe') || '',
            attachments: (p.attachments || []).map(a => ({
              filename: a.filename || 'attachment',
              contentType: a.contentType || 'application/octet-stream',
              size: a.size || 0, content: a.content,
            })),
          };
          bodyCache.set(bk, bd);
          _dbPut('bodies', bk, { ...bd, attachments: bd.attachments.map(a => ({ ...a, content: a.content ? Array.from(a.content) : null })) }).catch(() => {});
          resolve(bd);
        } catch(e) {
          const bi = raw.indexOf('\r\n\r\n');
          const bd = { html: null, text: bi >= 0 ? raw.slice(bi+4) : raw, attachments: [], listUnsub: '' };
          bodyCache.set(bk, bd);
          _dbPut('bodies', bk, bd).catch(() => {});
          resolve(bd);
        }
      });
    });
  }

  function _markSeenAsync(folder, uid) {
    if (!uid) return;
    _ensureOp().then(() => new Promise(res => {
      opConn.openBox(folder, false, err => {
        if (err) return res();
        opConn.addFlags([uid], ['\\Seen'], () => res());
      });
    })).catch(() => {});
  }

  // ── Trash / Spam / Archive ────────────────────────────────────────────────
  function _evict(folder, uids) {
    const ak = _ak();
    for (const uid of uids) {
      const bk = _bkey(folder, uid);
      bodyCache.delete(bk); _dbDel('bodies', bk).catch(() => {});
    }
    // Invalidate header pages for this folder
    for (const k of [...headerCache.keys()]) {
      if (k.startsWith(`${ak}::${folder}::`)) {
        headerCache.delete(k); _dbDel('headers', k).catch(() => {});
      }
    }
    const ahMap = allHdrs.get(_ahkey(folder));
    if (ahMap) for (const uid of uids) ahMap.delete(uid);
  }

  async function trashMessages(folder, uids) {
    if (!uids?.length) return;
    await _ensureOp();
    return new Promise((res, rej) => {
      opConn.openBox(folder, false, err => {
        if (err) return rej(err);
        opConn.copy(uids, _trashFolder(), () => {
          opConn.addFlags(uids, ['\\Deleted'], () => {
            opConn.expunge(() => { _evict(folder, uids); res(); });
          });
        });
      });
    });
  }

  async function markSpam(folder, uids) {
    await _ensureOp();
    return new Promise((res, rej) => {
      opConn.openBox(folder, false, err => {
        if (err) return rej(err);
        opConn.copy(uids, _spamFolder(), () => {
          opConn.addFlags(uids, ['\\Deleted'], () => opConn.expunge(() => { _evict(folder, uids); res(); }));
        });
      });
    });
  }

  async function archiveMessages(folder, uids) {
    if (!uids?.length) return;
    await _ensureOp();
    return new Promise((res, rej) => {
      opConn.openBox(folder, false, err => {
        if (err) return rej(err);
        opConn.copy(uids, _archiveFolder(), copyErr => {
          if (copyErr) { opConn.addFlags(uids, ['\\Seen'], () => res()); return; }
          opConn.addFlags(uids, ['\\Deleted'], () => {
            opConn.expunge(() => { _evict(folder, uids); res(); });
          });
        });
      });
    });
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  let pollTimer = null;
  function startPoll(folder, callback) {
    clearPoll();
    let lastTotal = -1;
    pollTimer = setInterval(async () => {
      try {
        await _ensurePoll();
        pollConn.status(folder, (err, info) => {
          if (err || !info) return;
          const n = typeof info.messages === 'number' ? info.messages : (info.messages?.total ?? 0);
          if (lastTotal >= 0 && n > lastTotal) callback({ newCount: n - lastTotal, total: n });
          lastTotal = n;
        });
      } catch(e) {}
    }, POLL_MS);
  }
  function clearPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function fetchNewest(folder, sinceUid) {
    await _ensureList();
    const box = await new Promise((res, rej) => {
      listConn.openBox(folder, true, (e, b) => e ? rej(e) : res(b));
    });
    const total = box.messages.total; if (!total) return [];
    const start = Math.max(1, total - 20 + 1);
    const msgs  = await _fetchHeaders(`${start}:${total}`, folder);
    if (msgs.length) _mergeAllHdrs(folder, msgs);
    return sinceUid ? msgs.filter(m => m.uid > sinceUid) : msgs;
  }

  // ── Search — local-first ──────────────────────────────────────────────────
  async function searchFolder(folder, query, isFlagSearch) {
    if (!isFlagSearch) {
      const cached = getAllCachedHeaders(folder);
      if (cached.length > 0) {
        const lq = query.toLowerCase();
        return cached.filter(m =>
          (m.subject || '').toLowerCase().includes(lq) ||
          (m.from    || '').toLowerCase().includes(lq)
        );
      }
    }
    // IMAP fallback
    await _ensureList();
    await new Promise((res, rej) => {
      listConn.openBox(folder, true, e => e ? rej(e) : res());
    });
    const criteria = isFlagSearch
      ? [query]
      : [['OR', ['OR', ['SUBJECT', query], ['FROM', query]], ['BODY', query]]];
    return new Promise((resolve, reject) => {
      listConn.search(criteria, async (err, uids) => {
        if (err) return reject(err);
        if (!uids.length) return resolve([]);
        const msgs = await _fetchHeaders(uids.slice(-100).join(','), folder).catch(() => []);
        msgs.sort((a, b) => b.date - a.date);
        resolve(msgs);
      });
    });
  }

  // ── Folder name helpers ───────────────────────────────────────────────────
  function _trashFolder() {
    return { gmail:'[Gmail]/Trash', yahoo:'Trash', outlook:'Deleted Items', hotmail:'Deleted Items', live:'Deleted Items' }[cfg?.provider] || 'Trash';
  }
  function _spamFolder() {
    return { gmail:'[Gmail]/Spam', yahoo:'Bulk Mail', outlook:'Junk Email', hotmail:'Junk Email', live:'Junk Email' }[cfg?.provider] || 'Junk';
  }
  function _archiveFolder() {
    return { gmail:'[Gmail]/All Mail', yahoo:'Archive', outlook:'Archive', hotmail:'Archive', live:'Archive', icloud:'Archive' }[cfg?.provider] || 'Archive';
  }

  // ── MIME decode ───────────────────────────────────────────────────────────
  function _parseHdr(raw) {
    const h = {};
    raw.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0,i).toLowerCase().trim()] = line.slice(i+1).trim();
    });
    return h;
  }

  function _mime(s) {
    if (!s) return '';
    try {
      return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*=\?[^?]+\?[BbQq]\?[^?]*\?=)*/g, full => {
        const words = [], re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g; let wm;
        while ((wm = re.exec(full)) !== null) words.push({ cs: wm[1], enc: wm[2].toUpperCase(), txt: wm[3] });
        return words.map(({ cs, enc, txt }) => {
          try {
            const charset = cs.toLowerCase();
            if (enc === 'B') {
              const buf = Buffer.from(txt, 'base64');
              if (charset === 'utf-8' || charset === 'utf8') return buf.toString('utf8');
              try { const iconv = require('iconv-lite'); if (iconv.encodingExists(charset)) return iconv.decode(buf, charset); } catch(_) {}
              return buf.toString('latin1');
            } else {
              const raw = txt.replace(/_/g,' ').replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
              if (charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii') {
                try { const iconv = require('iconv-lite'); if (iconv.encodingExists(charset)) return iconv.decode(Buffer.from(raw,'latin1'), charset); } catch(_) {}
              }
              return raw;
            }
          } catch(e) { return txt; }
        }).join('');
      });
    } catch(e) { return s; }
  }

  function extractAddr(from) {
    return ((from||'').match(/<([^>]+)>/) || (from||'').match(/([^\s<>]+@[^\s<>]+)/) || ['',''])[1]?.toLowerCase().trim() || '';
  }
  function extractName(from) {
    return (from||'').replace(/<[^>]+>$/,'').replace(/"/g,'').trim() || extractAddr(from);
  }

  function getBodyCache() { return bodyCache; }

  function clearAllCache() {
    bodyCache.clear(); headerCache.clear(); allHdrs.clear();
    _openDB().then(d => {
      ['bodies','headers'].forEach(s => { try { d.transaction(s,'readwrite').objectStore(s).clear(); } catch(_) {} });
    }).catch(() => {});
  }

  return {
    connect, disconnect,
    listFolders, fetchPage, prefetchBodies, fetchBody,
    trashMessages, markSpam, archiveMessages,
    startPoll, clearPoll, fetchNewest, searchFolder,
    getAllCachedHeaders,
    extractAddr, extractName, PAGE_SIZE, getBodyCache, clearAllCache,
  };
})();
