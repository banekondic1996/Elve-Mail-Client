// js/imap-client.js — Elve Mail IMAP Engine v7
// Downloads ALL headers + bodies upfront. fetchBody() is instant from cache.
// STATUS bug fixed: never call status() on selected mailbox — use separate pollConn.

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
  const POLL_MS   = 45000;

  // Four connections — each stays on its own task, never cross-called
  let listConn = null;  // header fetching (openBox read-only)
  let bodyConn = null;  // body fetching (openBox read-write for markSeen)
  let opConn   = null;  // delete / spam / flag operations
  let pollConn = null;  // STATUS calls only — never has a mailbox selected

  let cfg      = null;
  let listBox  = null;  // which folder listConn currently has open
  let listTotal = 0;    // message count from last openBox on listConn

  const bodyCache = new Map(); // "folder::uid" → bodyData

  // ─── Connect ─────────────────────────────────────────────────────────────
  async function connect(config) {
    cfg = config;
    if (!_alive(listConn)) { listConn = await _mkConn(config); listBox = null; }
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
      imap.once('error', () => {}); // suppress unhandled errors
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

  async function _ensureList() { if (!_alive(listConn)) { listConn = await _mkConn(cfg); listBox = null; } }
  async function _ensureBody() { if (!_alive(bodyConn)) bodyConn = await _mkConn(cfg); }
  async function _ensureOp()   { if (!_alive(opConn))   opConn   = await _mkConn(cfg); }
  async function _ensurePoll() { if (!_alive(pollConn)) pollConn = await _mkConn(cfg); }

  function disconnect() {
    clearPoll();
    [listConn, bodyConn, opConn, pollConn].forEach(c => { if (c) try { c.end(); } catch(_) {} });
    listConn = bodyConn = opConn = pollConn = null;
  }

  // ─── List folders ─────────────────────────────────────────────────────────
  async function listFolders() {
    await _ensureList();
    return new Promise((res, rej) => {
      listConn.getBoxes('', (err, boxes) => {
        if (err) return rej(err);
        const folders = [];
        const seenSp  = new Set();
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
    const p = path.toLowerCase();
    const a = attribs.map(x => (x || '').toLowerCase());
    if (p === 'inbox' || p.endsWith('/inbox'))                  return 'inbox';
    if (a.includes('\\sent')    || /\bsent\b/i.test(p))        return 'sent';
    if (a.includes('\\trash')   || /trash|deleted/i.test(p))   return 'trash';
    if (a.includes('\\drafts')  || /draft/i.test(p))           return 'drafts';
    if (a.includes('\\junk')    || /spam|junk|bulk/i.test(p))  return 'spam';
    if (a.includes('\\flagged') || /flagged|starred/i.test(p)) return 'flagged';
    if (a.includes('\\archive') || /archive/i.test(p))         return 'archive';
    return 'folder';
  }

  // ─── Fetch page ───────────────────────────────────────────────────────────
  // ALWAYS uses openBox — never STATUS on the currently-selected mailbox.
  // The message count is stored from the openBox response.
  async function fetchPage(folder, page, onProgress) {
    page = Math.max(1, page || 1);
    await _ensureList();

    // openBox gives us the definitive message count with no IMAP errors
    const box = await new Promise((res, rej) => {
      listConn.openBox(folder, true, (err, b) => {
        if (err) return rej(err);
        listBox   = folder;
        listTotal = b.messages.total || 0;
        res(b);
      });
    });

    const total = box.messages.total || 0;
    if (total === 0) return { messages: [], total: 0, page: 1, totalPages: 1, hasMore: false };

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const seqEnd     = total - (page - 1) * PAGE_SIZE;
    const seqStart   = Math.max(1, seqEnd - PAGE_SIZE + 1);
    if (seqEnd < 1) return { messages: [], total, page, totalPages, hasMore: false };

    onProgress && onProgress({ phase:'fetching', seqStart, seqEnd, total });
    const messages = await _fetchHeaders(`${seqStart}:${seqEnd}`, folder);
    messages.sort((a, b) => b.date - a.date);
    return { messages, total, page, totalPages, hasMore: page < totalPages };
  }

  function _fetchHeaders(range, folder) {
    return new Promise((resolve, reject) => {
      // listConn already has folder open from fetchPage
      const f = listConn.seq.fetch(range, {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE)'],
        markSeen: false,
      });
      const msgs = [];
      f.on('message', (msg, seqno) => {
        const m = { seqno, uid: null, flags: [], folder };
        let hdr = '';
        msg.on('body', s => { let b = ''; s.on('data', c => b += c); s.once('end', () => hdr = b); });
        msg.once('attributes', a => { m.uid = a.uid; m.flags = a.flags || []; });
        msg.once('end', () => {
          const h     = _parseHdr(hdr);
          m.from      = _mime(h.from || '');
          m.to        = _mime(h.to || '');
          m.subject   = _mime(h.subject || '(no subject)');
          m.messageId = h['message-id'] || '';
          m.date      = h.date ? new Date(h.date) : new Date(0);
          m.unread    = !m.flags.includes('\\Seen');
          m.id        = `${folder}::${m.uid || m.seqno}`;
          m.listUnsub = h['list-unsubscribe'] || '';
          msgs.push(m);
        });
      });
      f.once('error', reject);
      f.once('end', () => resolve(msgs));
    });
  }

  // ─── Pre-download bodies for a page (background) ─────────────────────────
  async function prefetchBodies(folder, uids, onProgress) {
    if (!uids || !uids.length) return;
    await _ensureBody();

    // Open folder on bodyConn
    await new Promise((res, rej) => {
      bodyConn.openBox(folder, false, e => e ? rej(e) : res());
    });

    const needed = uids.filter(uid => !bodyCache.has(`${folder}::${uid}`));
    if (!needed.length) { onProgress && onProgress({ done: uids.length, total: uids.length }); return; }

    const BATCH = 5;
    let done = uids.length - needed.length;
    for (let i = 0; i < needed.length; i += BATCH) {
      const batch = needed.slice(i, i + BATCH);
      await _fetchBodiesBatch(folder, batch).catch(() => {});
      done += batch.length;
      onProgress && onProgress({ done, total: uids.length });
    }
  }

  function _fetchBodiesBatch(folder, uids) {
    return new Promise((resolve) => {
      let pending = uids.length;
      if (!pending) return resolve();
      const f = bodyConn.fetch(uids, { bodies: [''], markSeen: false });
      f.on('message', msg => {
        let raw = '', uid = null;
        msg.on('body', s => s.on('data', c => raw += c));
        msg.once('attributes', a => { uid = a.uid; });
        msg.once('end', async () => {
          if (uid && raw) {
            try {
              const p = await simpleParser(raw);
              bodyCache.set(`${folder}::${uid}`, {
                html: p.html || null,
                text: p.text || null,
                listUnsub: p.headers?.get('list-unsubscribe') || '',
                attachments: (p.attachments || []).map(a => ({
                  filename:    a.filename || 'attachment',
                  contentType: a.contentType || 'application/octet-stream',
                  size:        a.size || 0,
                  content:     a.content,
                })),
              });
            } catch(e) {
              const bi = raw.indexOf('\r\n\r\n');
              bodyCache.set(`${folder}::${uid}`, {
                html: null, listUnsub: '',
                text: bi >= 0 ? raw.slice(bi + 4) : raw,
                attachments: [],
              });
            }
          }
          if (--pending <= 0) resolve();
        });
      });
      f.once('error', () => resolve());
      f.once('end', () => { if (pending <= 0) resolve(); });
    });
  }

  // ─── fetchBody — instant from cache, fallback to server ──────────────────
  async function fetchBody(folder, uid) {
    const key = `${folder}::${uid}`;
    if (bodyCache.has(key)) return bodyCache.get(key);

    // Not cached yet — fetch now
    await _ensureBody();
    await new Promise((res, rej) => {
      bodyConn.openBox(folder, false, e => e ? rej(e) : res());
    });
    return new Promise((resolve, reject) => {
      const f = bodyConn.fetch([uid], { bodies: [''], markSeen: true });
      let raw = '';
      f.on('message', m => m.on('body', s => s.on('data', c => raw += c)));
      f.once('error', reject);
      f.once('end', async () => {
        if (!raw) return resolve({ html: null, text: '(empty)', attachments: [], listUnsub: '' });
        try {
          const p = await simpleParser(raw);
          const result = {
            html: p.html || null, text: p.text || null,
            listUnsub: p.headers?.get('list-unsubscribe') || '',
            attachments: (p.attachments || []).map(a => ({
              filename: a.filename || 'attachment',
              contentType: a.contentType || 'application/octet-stream',
              size: a.size || 0, content: a.content,
            })),
          };
          bodyCache.set(key, result);
          resolve(result);
        } catch(e) {
          const bi = raw.indexOf('\r\n\r\n');
          const r = { html: null, text: bi >= 0 ? raw.slice(bi+4) : raw, attachments: [], listUnsub: '' };
          bodyCache.set(key, r);
          resolve(r);
        }
      });
    });
  }

  // ─── Trash / Spam ─────────────────────────────────────────────────────────
  async function trashMessages(folder, uids) {
    if (!uids?.length) return;
    await _ensureOp();
    return new Promise((res, rej) => {
      opConn.openBox(folder, false, err => {
        if (err) return rej(err);
        opConn.copy(uids, _trashFolder(), () => {
          opConn.addFlags(uids, ['\\Deleted'], () => {
            opConn.expunge(() => { uids.forEach(uid => bodyCache.delete(`${folder}::${uid}`)); res(); });
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
          opConn.addFlags(uids, ['\\Deleted'], () => opConn.expunge(() => res()));
        });
      });
    });
  }

  // ─── Poll — dedicated pollConn, never selects a mailbox ──────────────────
  let pollTimer = null;
  function startPoll(folder, callback) {
    clearPoll();
    let lastTotal = -1;
    pollTimer = setInterval(async () => {
      try {
        await _ensurePoll();
        // pollConn never calls openBox, so STATUS is always safe
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
      listConn.openBox(folder, true, (e, b) => { listBox = folder; e ? rej(e) : res(b); });
    });
    const total = box.messages.total; if (!total) return [];
    const start = Math.max(1, total - 20 + 1);
    const msgs  = await _fetchHeaders(`${start}:${total}`, folder);
    return sinceUid ? msgs.filter(m => m.uid > sinceUid) : msgs;
  }

  // ─── Search ───────────────────────────────────────────────────────────────
  async function searchFolder(folder, query, isFlagSearch) {
    await _ensureList();
    await new Promise((res, rej) => {
      listConn.openBox(folder, true, (e) => { listBox = folder; e ? rej(e) : res(); });
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

  function _trashFolder() {
    const m = { gmail:'[Gmail]/Trash', yahoo:'Trash', outlook:'Deleted Items', hotmail:'Deleted Items', live:'Deleted Items' };
    return m[cfg?.provider] || 'Trash';
  }
  function _spamFolder() {
    const m = { gmail:'[Gmail]/Spam', yahoo:'Bulk Mail', outlook:'Junk Email', hotmail:'Junk Email', live:'Junk Email' };
    return m[cfg?.provider] || 'Junk';
  }

  function _parseHdr(raw) {
    const h = {};
    raw.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim();
    });
    return h;
  }

  function _mime(s) {
    if (!s) return '';
    try {
      return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
        if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8');
        return txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      });
    } catch(e) { return s; }
  }

  function extractAddr(from) {
    return ((from || '').match(/<([^>]+)>/) || (from || '').match(/([^\s<>]+@[^\s<>]+)/) || ['',''])[1]?.toLowerCase().trim() || '';
  }
  function extractName(from) {
    return (from || '').replace(/<[^>]+>$/, '').replace(/"/g, '').trim() || extractAddr(from);
  }

  function getBodyCache() { return bodyCache; }

  return {
    connect, disconnect,
    listFolders, fetchPage, prefetchBodies, fetchBody,
    trashMessages, markSpam,
    startPoll, clearPoll, fetchNewest, searchFolder,
    extractAddr, extractName, PAGE_SIZE, getBodyCache,
  };
})();
