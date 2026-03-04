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
  const POLL_MS   = 15000;
  const DB_NAME   = 'elve_mail_v3';
  const DB_VER    = 1;

  // ── Four IMAP connections ─────────────────────────────────────────────────
  let listConn = null;
  let bodyConn = null;
  let opConn   = null;
  let pollConn = null;
  let adminConn = null;
  let cfg      = null;
  let _listQueue = Promise.resolve();

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
    // If switching accounts, close old connections and wipe memory caches so the
    // new account never sees stale headers/bodies from the previous one.
    if (cfg && cfg.email !== config.email) {
      [listConn,bodyConn,opConn,pollConn,adminConn].forEach(c=>{try{c?.end();}catch(_){}});
      listConn=bodyConn=opConn=pollConn=adminConn=null;
      _listQueue = Promise.resolve();
      headerCache.clear(); bodyCache.clear(); allHdrs.clear();
    }
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
  async function _ensureAdmin(){ if (!_alive(adminConn)) adminConn = await _mkConn(cfg); }

  function _withListLock(fn) {
    const run = _listQueue.then(fn, fn);
    _listQueue = run.catch(() => {});
    return run;
  }

  function disconnect() {
    clearPoll();
    [listConn, bodyConn, opConn, pollConn, adminConn].forEach(c => { if (c) try { c.end(); } catch(_) {} });
    listConn = bodyConn = opConn = pollConn = adminConn = null;
    _listQueue = Promise.resolve();
  }

  // ── List folders ──────────────────────────────────────────────────────────
  async function listFolders() {
    await _ensureAdmin();
      return new Promise((res, rej) => {
        adminConn.getBoxes('', (err, boxes) => {
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

  function _isBadSequenceError(err) {
    const m = String(err?.message || err || '').toLowerCase();
    return m.includes('bad sequence') || m.includes('invalid messageset') || m.includes('invalid sequence');
  }

  // ── fetchPage — CACHE-FIRST ───────────────────────────────────────────────
  // Serves from IndexedDB/memory; only hits IMAP if not yet cached.
  // forceRefresh=true: skip cache, fetch from IMAP, update cache.
  async function fetchPage(folder, page, onProgress, forceRefresh) {
    return _withListLock(async () => {
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

      let total = box.messages.total || 0;
      if (total === 0) {
        const empty = { messages: [], total: 0, page: 1, totalPages: 1, ts: Date.now() };
        headerCache.set(hk, empty);
        await _dbPut('headers', hk, empty);
        return empty;
      }

      let totalPages = Math.ceil(total / PAGE_SIZE);
      let seqEnd     = total - (page - 1) * PAGE_SIZE;
      let seqStart   = Math.max(1, seqEnd - PAGE_SIZE + 1);
      if (seqEnd < 1) return { messages: [], total, page, totalPages, ts: Date.now() };

      onProgress && onProgress({ seqStart, seqEnd, total });
      let messages;
      try {
        messages = await _fetchHeaders(`${seqStart}:${seqEnd}`, folder);
      } catch (err) {
        if (!_isBadSequenceError(err)) throw err;
        // Mailbox changed mid-fetch (expunge/new mail). Re-open and recompute once.
        const box2 = await new Promise((res, rej) => {
          listConn.openBox(folder, true, (e, b) => e ? rej(e) : res(b));
        });
        total = box2.messages.total || 0;
        if (total === 0) {
          const empty = { messages: [], total: 0, page: 1, totalPages: 1, ts: Date.now() };
          headerCache.set(hk, empty);
          await _dbPut('headers', hk, empty);
          return empty;
        }
        totalPages = Math.ceil(total / PAGE_SIZE);
        seqEnd   = total - (page - 1) * PAGE_SIZE;
        seqStart = Math.max(1, seqEnd - PAGE_SIZE + 1);
        if (seqEnd < 1) return { messages: [], total, page, totalPages, ts: Date.now() };
        onProgress && onProgress({ seqStart, seqEnd, total });
        messages = await _fetchHeaders(`${seqStart}:${seqEnd}`, folder);
      }
      messages.sort((a, b) => b.date - a.date);

      const result = { messages, total, page, totalPages, ts: Date.now() };
      headerCache.set(hk, result);
      _mergeAllHdrs(folder, messages);
      _dbPut('headers', hk, result).catch(() => {});

      return result;
    });
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
  function _fetchHeaders(range, folder, useUid) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const done = fn => arg => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn(arg);
      };
      const fetcher = useUid ? listConn.fetch.bind(listConn) : listConn.seq.fetch.bind(listConn);
      const f = fetcher(range, {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST CONTENT-TYPE)'],
        markSeen: false, struct: true,
      });
      const timer = setTimeout(done(reject), 30000, new Error('IMAP fetch timed out'));
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
          m.listUnsubPost = h['list-unsubscribe-post'] || '';
          m.hasAttachment = _structHasAttachment(m.struct) ||
            /multipart\/(mixed|related)/i.test(h['content-type'] || '');
          delete m.struct;
          msgs.push(m);
        });
      });
      f.once('error', done(reject));
      f.once('end', done(() => resolve(msgs)));
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
                listUnsubPost: p.headers?.get('list-unsubscribe-post') || '',
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
              const bd = { html: null, listUnsub: '', listUnsubPost: '', text: bi >= 0 ? raw.slice(bi+4) : raw, attachments: [] };
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
            listUnsubPost: p.headers?.get('list-unsubscribe-post') || '',
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
          const bd = { html: null, text: bi >= 0 ? raw.slice(bi+4) : raw, attachments: [], listUnsub: '', listUnsubPost: '' };
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

  async function _resolveSpecialFolder(special, fallbackPath) {
    try {
      const folders = await listFolders();
      const bySpecial = folders.find(f => f.special === special);
      if (bySpecial?.path) return bySpecial.path;
      const want = (fallbackPath || '').toLowerCase();
      const byPath = folders.find(f => (f.path || '').toLowerCase() === want);
      if (byPath?.path) return byPath.path;
    } catch(_) {}
    return fallbackPath;
  }

  async function _moveWithFallback(fromFolder, uids, targetFolder) {
    if (!uids?.length) return;
    await _ensureOp();
    return new Promise((res, rej) => {
      opConn.openBox(fromFolder, false, err => {
        if (err) return rej(err);

        const done = () => { _evict(fromFolder, uids); res(); };
        const fail = e => rej(e || new Error('Move failed'));

        const copyDelete = () => {
          opConn.copy(uids, targetFolder, copyErr => {
            if (copyErr) return fail(copyErr);
            opConn.addFlags(uids, ['\\Deleted'], flagErr => {
              if (flagErr) return fail(flagErr);
              opConn.expunge(expErr => {
                if (expErr) return fail(expErr);
                done();
              });
            });
          });
        };

        if (typeof opConn.move === 'function') {
          opConn.move(uids, targetFolder, moveErr => {
            if (!moveErr) return done();
            copyDelete();
          });
        } else {
          copyDelete();
        }
      });
    });
  }

  async function trashMessages(folder, uids) {
    if (!uids?.length) return;
    const target = await _resolveSpecialFolder('trash', _trashFolder());
    return _moveWithFallback(folder, uids, target);
  }

  async function markSpam(folder, uids) {
    if (!uids?.length) return;
    const target = await _resolveSpecialFolder('spam', _spamFolder());
    return _moveWithFallback(folder, uids, target);
  }

  async function moveToFolder(fromFolder, uids, targetFolder) {
    if (!uids?.length || !targetFolder) return;
    return _moveWithFallback(fromFolder, uids, targetFolder);
  }

  async function archiveMessages(folder, uids) {
    if (!uids?.length) return;
    const target = await _resolveSpecialFolder('archive', _archiveFolder());
    try {
      await _moveWithFallback(folder, uids, target);
    } catch(e) {
      // If archive is unavailable on this provider, at least mark as read.
      await _ensureOp();
      await new Promise(resolve => {
        opConn.openBox(folder, false, err => {
          if (err) return resolve();
          opConn.addFlags(uids, ['\\Seen'], () => resolve());
        });
      });
    }
  }

  async function fetchRawSource(folder, uid) {
    if (!uid) return { raw: '', headers: '', body: '' };
    await _ensureBody();
    await new Promise((res, rej) => { bodyConn.openBox(folder, true, e => e ? rej(e) : res()); });
    return new Promise((resolve, reject) => {
      const f = bodyConn.fetch([uid], { bodies: [''], markSeen: false });
      let raw = '';
      f.on('message', m => m.on('body', s => s.on('data', c => raw += c)));
      f.once('error', reject);
      f.once('end', () => {
        const bi = raw.indexOf('\r\n\r\n');
        resolve({
          raw,
          headers: bi >= 0 ? raw.slice(0, bi) : raw,
          body: bi >= 0 ? raw.slice(bi + 4) : '',
        });
      });
    });
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  let pollTimer = null;
  function startPoll(folder, callback) {
    clearPoll();
    let lastTotal = -1;
    let softCheckTicks = 0;
    const emit = payload => {
      try { Promise.resolve(callback(payload)).catch(() => {}); } catch(_) {}
    };
    pollTimer = setInterval(async () => {
      try {
        await _ensurePoll();
        pollConn.status(folder, (err, info) => {
          if (err || !info) {
            softCheckTicks = 0;
            emit({ newCount: 0, total: lastTotal, forceCheck: true });
            return;
          }
          const n = typeof info.messages === 'number' ? info.messages : (info.messages?.total ?? 0);
          if (lastTotal >= 0 && n > lastTotal) {
            softCheckTicks = 0;
            emit({ newCount: n - lastTotal, total: n });
          } else {
            softCheckTicks++;
            // Status can be stale on some servers: run a periodic UID-based check.
            if (softCheckTicks >= 4) {
              softCheckTicks = 0;
              emit({ newCount: 0, total: n, forceCheck: true });
            }
          }
          lastTotal = n;
        });
      } catch(e) {
        softCheckTicks = 0;
        emit({ newCount: 0, total: lastTotal, forceCheck: true });
      }
    }, POLL_MS);
  }
  function clearPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function fetchNewest(folder, sinceUid) {
    await _ensurePoll();
    let box = await new Promise((res, rej) => {
      pollConn.openBox(folder, true, (e, b) => e ? rej(e) : res(b));
    });
    let total = box.messages.total;
    if (!total) return [];

    let start = Math.max(1, total - 20 + 1);
    let msgs;
    try {
      msgs = await _fetchHeadersViaConn(pollConn, `${start}:${total}`, folder, false);
    } catch (err) {
      if (!_isBadSequenceError(err)) throw err;
      box = await new Promise((res, rej) => {
        pollConn.openBox(folder, true, (e, b) => e ? rej(e) : res(b));
      });
      total = box.messages.total;
      if (!total) return [];
      start = Math.max(1, total - 20 + 1);
      msgs = await _fetchHeadersViaConn(pollConn, `${start}:${total}`, folder, false);
    }
    if (msgs.length) _mergeAllHdrs(folder, msgs);
    return sinceUid ? msgs.filter(m => m.uid > sinceUid) : msgs;
  }

  // ── Search — local-first ──────────────────────────────────────────────────
  function _escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function _searchMatch(text, query, mode) {
    const hay = String(text || '').toLowerCase();
    const q = String(query || '').toLowerCase().trim();
    if (!q) return true;
    if (mode === 'exact') {
      const re = new RegExp(`(^|\\W)${_escapeRe(q)}(\\W|$)`, 'i');
      return re.test(hay);
    }
    return hay.includes(q);
  }
  function _searchMsgLocal(msg, query, opts) {
    const field = opts?.field || 'all';
    const mode = opts?.match || 'contains';
    const folder = msg.folder || '';
    const uid = msg.uid;
    const cached = uid ? bodyCache.get(_bkey(folder, uid)) : null;
    const body = ((cached?.text || cached?.html || '').replace(/<[^>]+>/g, ' ')).slice(0, 4000);
    const blobs = {
      subject: msg.subject || '',
      from: msg.from || '',
      body,
      all: [msg.subject || '', msg.from || '', body].join(' '),
    };
    return _searchMatch(blobs[field] ?? blobs.all, query, mode);
  }

  async function searchFolder(folder, query, isFlagSearch, opts) {
    if (!isFlagSearch) {
      const cached = getAllCachedHeaders(folder);
      if (cached.length > 0) {
        return cached.filter(m => _searchMsgLocal(m, query, opts));
      }
    }
    // IMAP fallback
    return _withListLock(async () => {
      await _ensureList();
      await new Promise((res, rej) => {
        listConn.openBox(folder, true, e => e ? rej(e) : res());
      });
      const criteria = (() => {
        if (isFlagSearch) return [query];
        const field = opts?.field || 'all';
        if (field === 'subject') return [['SUBJECT', query]];
        if (field === 'from') return [['FROM', query]];
        if (field === 'body') return [['BODY', query]];
        return [['OR', ['OR', ['SUBJECT', query], ['FROM', query]], ['BODY', query]]];
      })();
      return new Promise((resolve, reject) => {
        listConn.search(criteria, async (err, uids) => {
          if (err) return reject(err);
          if (!uids.length) return resolve([]);
          const uidSet = uids.slice(-100);
          const msgs = await _fetchHeaders(uidSet, folder, true).catch(() => []);
          msgs.sort((a, b) => b.date - a.date);
          resolve(isFlagSearch ? msgs : msgs.filter(m => _searchMsgLocal(m, query, opts)));
        });
      });
    });
  }

  function _fetchHeadersViaConn(conn, range, folder, useUid) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const done = fn => arg => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn(arg);
      };
      const fetcher = useUid ? conn.fetch.bind(conn) : conn.seq.fetch.bind(conn);
      const f = fetcher(range, {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST CONTENT-TYPE)'],
        markSeen: false, struct: true,
      });
      const timer = setTimeout(done(reject), 30000, new Error('IMAP fetch timed out'));
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
          m.listUnsubPost = h['list-unsubscribe-post'] || '';
          m.hasAttachment = _structHasAttachment(m.struct) ||
            /multipart\/(mixed|related)/i.test(h['content-type'] || '');
          delete m.struct;
          msgs.push(m);
        });
      });
      f.once('error', done(reject));
      f.once('end', done(() => resolve(msgs)));
    });
  }

  async function createFolder(path) {
    const p = (path || '').trim().replace(/^\/+|\/+$/g, '');
    if (!p) throw new Error('Folder name is required');
    await _ensureAdmin();
    return new Promise((resolve, reject) => {
      adminConn.addBox(p, err => {
        if (!err) return resolve(p);
        if (/exists/i.test(err.message || '')) return resolve(p);
        reject(err);
      });
    });
  }

  function _clearAccountCacheMemory() {
    headerCache.clear();
    bodyCache.clear();
    allHdrs.clear();
  }

  async function renameFolder(fromPath, toPath) {
    const from = (fromPath || '').trim().replace(/^\/+|\/+$/g, '');
    const to = (toPath || '').trim().replace(/^\/+|\/+$/g, '');
    if (!from || !to) throw new Error('Both source and target folder are required');
    if (from.toLowerCase() === 'inbox') throw new Error('Cannot rename INBOX');
    if (from === to) return to;
    await _ensureAdmin();
    return new Promise((resolve, reject) => {
      adminConn.renameBox(from, to, err => {
        if (err) return reject(err);
        _clearAccountCacheMemory();
        resolve(to);
      });
    });
  }

  async function deleteFolder(path) {
    const p = (path || '').trim().replace(/^\/+|\/+$/g, '');
    if (!p) throw new Error('Folder name is required');
    if (p.toLowerCase() === 'inbox') throw new Error('Cannot delete INBOX');
    await _ensureAdmin();
    return new Promise((resolve, reject) => {
      adminConn.delBox(p, err => {
        if (err) return reject(err);
        _clearAccountCacheMemory();
        resolve(true);
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

  // ── MIME decode — pure-JS so Serbian/Cyrillic works in NW.js renderer ─────
  function _parseHdr(raw) {
    const h = {};
    raw.replace(/\r\n[ \t]+/g,' ').split('\r\n').forEach(line=>{
      const i=line.indexOf(':');
      if(i>0) h[line.slice(0,i).toLowerCase().trim()]=line.slice(i+1).trim();
    });
    return h;
  }

  // Decode bytes→string using TextDecoder (handles utf-8, iso-8859-*, windows-125*, etc.)
  function _decodeBytes(bytes, charset) {
    const cs=(charset||'utf-8').toLowerCase().replace(/windows-/,'cp');
    const map={'iso-8859-1':'windows-1252','iso-8859-2':'windows-1250','latin1':'windows-1252',
               'cp1250':'windows-1250','cp1251':'windows-1251','cp1252':'windows-1252',
               'utf8':'utf-8'};
    const label=map[cs]||cs;
    try {
      const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      return new TextDecoder(label,{fatal:false}).decode(u8);
    } catch(e) {
      try {
        const iconv=require('iconv-lite');
        if(iconv.encodingExists(charset)){
          const buf=typeof Buffer!=='undefined'?Buffer.from(bytes):Buffer.alloc(0);
          return iconv.decode(buf,charset);
        }
      } catch(_) {}
      // last resort: latin1
      const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      return [...u8].map(b=>String.fromCharCode(b)).join('');
    }
  }

  function _b64ToBytes(str) {
    try {
      if(typeof Buffer!=='undefined') return Buffer.from(str,'base64');
      const b=atob(str.replace(/\s/g,'')); const u=new Uint8Array(b.length);
      for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u;
    } catch(e){ return new Uint8Array(0); }
  }

  function _mime(s) {
    if (!s) return '';
    try {
      return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*=\?[^?]+\?[BbQq]\?[^?]*\?=)*/g, full => {
        const words=[],re=/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g; let wm;
        while((wm=re.exec(full))!==null) words.push({cs:wm[1],enc:wm[2].toUpperCase(),txt:wm[3]});
        return words.map(({cs,enc,txt})=>{
          try {
            if(enc==='B') {
              return _decodeBytes(_b64ToBytes(txt), cs);
            } else {
              // Quoted-Printable
              const decoded=txt.replace(/_/g,' ').replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
              const csl=cs.toLowerCase();
              if(csl==='utf-8'||csl==='utf8'||csl==='us-ascii') return decoded;
              const bytes=new Uint8Array(decoded.length);
              for(let i=0;i<decoded.length;i++) bytes[i]=decoded.charCodeAt(i)&0xff;
              return _decodeBytes(bytes, cs);
            }
          } catch(e){ return txt; }
        }).join('');
      });
    } catch(e){ return s; }
  }

  function extractAddr(from) {
    return ((from||'').match(/<([^>]+)>/) || (from||'').match(/([^\s<>]+@[^\s<>]+)/) || ['',''])[1]?.toLowerCase().trim() || '';
  }
  function extractName(from) {
    return (from||'').replace(/<[^>]+>$/,'').replace(/"/g,'').trim() || extractAddr(from);
  }

  function getBodyCache() { return bodyCache; }
  function getCachedBody(folder, uid) {
    const bk = _bkey(folder, uid);
    return bodyCache.get(bk) || null;
  }

  function clearAllCache() {
    bodyCache.clear(); headerCache.clear(); allHdrs.clear();
    _openDB().then(d => {
      ['bodies','headers'].forEach(s => { try { d.transaction(s,'readwrite').objectStore(s).clear(); } catch(_) {} });
    }).catch(() => {});
  }

  return {
    connect, disconnect,
    listFolders, fetchPage, prefetchBodies, fetchBody,
    trashMessages, markSpam, archiveMessages, moveToFolder,
    startPoll, clearPoll, fetchNewest, searchFolder, createFolder, renameFolder, deleteFolder,
    fetchRawSource, getAllCachedHeaders,
    extractAddr, extractName, PAGE_SIZE, getBodyCache, clearAllCache,
    getCachedBody,
  };
})();
