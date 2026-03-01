// js/rules.js — Filter/rules engine

'use strict';
const Rules = (() => {
  const KEY = 'elve_rules_v2';
  const DEF = { domain:{enabled:false,list:[]}, email:{enabled:false,list:[]}, name:{enabled:false,list:[]}, subject:{enabled:false,list:[]}, body:{enabled:false,list:[]}, dupes:{enabled:true}, aiscam:{enabled:false} };
  let rules = JSON.parse(JSON.stringify(DEF));

  function load() {
    try { const s = localStorage.getItem(KEY); if (s) rules = {...DEF,...JSON.parse(s)}; } catch(e){}
    return rules;
  }
  function save(r) { rules = {...rules,...r}; localStorage.setItem(KEY, JSON.stringify(rules)); return rules; }
  function get() { return rules; }

  function check(msg) {
    const sub = (msg.subject||'').toLowerCase();
    const frm = (msg.from||'').toLowerCase();
    const bd  = (msg.rawBody||'').toLowerCase().slice(0,2000);
    const addr= ImapEngine.extractAddr(msg.from||'');
    const nm  = ImapEngine.extractName(msg.from||'').toLowerCase();
    const hits = [];
    if (rules.domain?.enabled)  for (const d of rules.domain.list||[])  { if (addr.includes(d.toLowerCase())) { hits.push({rule:'domain',value:d}); break; } }
    if (rules.email?.enabled)   for (const e of rules.email.list||[])   { if (addr === e.toLowerCase() || addr.includes(e.toLowerCase())) { hits.push({rule:'email',value:e}); break; } }
    if (rules.name?.enabled)    for (const n of rules.name.list||[])    { if (nm.includes(n.toLowerCase())) { hits.push({rule:'name',value:n}); break; } }
    if (rules.subject?.enabled) for (const k of rules.subject.list||[]) { if (sub.includes(k.toLowerCase())) { hits.push({rule:'subject',value:k}); break; } }
    if (rules.body?.enabled)    for (const k of rules.body.list||[])    { if (bd.includes(k.toLowerCase())) { hits.push({rule:'body',value:k}); break; } }
    return hits;
  }

  function findDupes(messages) {
    if (!rules.dupes?.enabled) return [];
    const seen = new Map(), dupes = [];
    [...messages].sort((a,b) => a.date-b.date).forEach(m => {
      const k = (m.subject||'').toLowerCase().replace(/^(re|fwd?|fw|aw):\s*/gi,'').trim();
      if (k && seen.has(k)) dupes.push(seen.get(k));
      if (k) seen.set(k, m);
    });
    return dupes;
  }

  return { load, save, get, check, findDupes };
})();
