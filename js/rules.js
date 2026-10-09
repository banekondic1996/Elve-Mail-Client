// js/rules.js — Rules engine v4
// One list of "keyword filters" (the old separate "Filters" screen is gone):
//   { id, name, enabled, field, keywords[], match:'any'|'all', exceptions[], action:'delete'|'move', targetFolder }
// field: subject | from (address) | domain | name | body | any
// Block actions (block sender / domain / subject / keyword) append to system filters 'blk_*'.
'use strict';
const Rules = (() => {
  const KEY      = 'elve_rules_v2';          // legacy list rules + dupes/aiscam flags
  const MOVE_KEY = 'elve_move_rules_v1';     // keyword filters
  const MIG_KEY  = 'elve_rules_migrated_v3';
  const DEF = { dupes:{enabled:true}, aiscam:{enabled:false} };
  let rules     = JSON.parse(JSON.stringify(DEF));
  let moveRules = [];

  const BLOCK = {
    address: { id:'blk_address', name:'Blocked addresses', field:'from'    },
    domain:  { id:'blk_domain',  name:'Blocked domains',   field:'domain'  },
    subject: { id:'blk_subject', name:'Blocked subjects',  field:'subject' },
    body:    { id:'blk_body',    name:'Blocked keywords',  field:'any'     },
  };

  function load() {
    let legacy = null;
    try { const s=localStorage.getItem(KEY); if(s) { legacy=JSON.parse(s); rules={...DEF,...legacy}; } } catch(e){}
    try { const s=localStorage.getItem(MOVE_KEY); if(s) moveRules=JSON.parse(s); } catch(e){}
    _migrate(legacy);
    return rules;
  }

  // Old "Filters" lists (domain/email/name/subject/body) become delete filters, once.
  function _migrate(legacy) {
    let done = false;
    try { done = !!localStorage.getItem(MIG_KEY); } catch(e){}
    if (done) return;
    if (legacy) {
      const map = [['domain','domain','Blocked domains'],['email','from','Blocked addresses'],
                   ['name','name','Blocked sender names'],['subject','subject','Blocked subjects'],['body','any','Blocked keywords']];
      const sysId = { domain:'blk_domain', email:'blk_address', subject:'blk_subject', body:'blk_body' };
      let added = false;
      for (const [k, field, name] of map) {
        const list = (legacy[k]?.list || []).filter(Boolean);
        if (!list.length) continue;
        moveRules.push({ id: sysId[k] || ('mig_'+k), name, enabled: !!legacy[k].enabled, field,
          keywords: list, match:'any', exceptions:[], action:'delete', targetFolder:'' });
        added = true;
      }
      if (added) saveMoveRules(moveRules);
    }
    try { localStorage.setItem(MIG_KEY, '1'); } catch(e){}
  }

  function save(r) { rules={...rules,...r}; localStorage.setItem(KEY,JSON.stringify(rules)); return rules; }
  function get()   { return rules; }

  function getMoveRules()    { return moveRules; }
  function saveMoveRules(mr) { moveRules=mr; localStorage.setItem(MOVE_KEY,JSON.stringify(mr)); }
  function addMoveRule(rule) {
    rule.id=rule.id||Date.now().toString(36);
    moveRules.push(rule); saveMoveRules(moveRules); return rule;
  }
  function updateMoveRule(id,patch) {
    const i=moveRules.findIndex(r=>r.id===id); if(i<0)return;
    moveRules[i]={...moveRules[i],...patch}; saveMoveRules(moveRules);
  }
  function deleteMoveRule(id) { moveRules=moveRules.filter(r=>r.id!==id); saveMoveRules(moveRules); }

  // Add a value to the matching system "Blocked …" filter (created / re-enabled as needed).
  // type: 'address' | 'domain' | 'subject' | 'body'.  Returns true if something was added.
  function addBlock(type, value) {
    const def = BLOCK[type]; const v = String(value || '').trim().toLowerCase();
    if (!def || !v) return false;
    let r = moveRules.find(x => x.id === def.id);
    if (!r) {
      r = { id:def.id, name:def.name, enabled:true, field:def.field, keywords:[], match:'any', exceptions:[], action:'delete', targetFolder:'' };
      moveRules.push(r);
    }
    r.enabled = true; r.action = 'delete'; r.match = 'any';
    const had = r.keywords.some(k => String(k).toLowerCase() === v);
    if (!had) r.keywords.push(v);
    saveMoveRules(moveRules);
    return !had;
  }

  // Body text lookup (set by app.js): (msg) => cached body text or ''.
  // Headers are fetched before bodies, so body keywords only match once the body is cached.
  let bodyProvider = () => '';
  function setBodyProvider(fn) { bodyProvider = fn || (() => ''); }

  function _plain(s) { return String(s || '').replace(/<[^>]+>/g, ' ').toLowerCase(); }

  function _hay(msg) {
    const frm  = (msg.from || '').toLowerCase();
    const addr = ImapEngine.extractAddr(msg.from || '');
    const nm   = ImapEngine.extractName(msg.from || '').toLowerCase();
    const sub  = (msg.subject || '').toLowerCase();
    let bd = '';
    try { bd = _plain(bodyProvider(msg) || msg.rawBody || '').slice(0, 20000); } catch (e) {}
    // List-Unsubscribe header is a strong newsletter signal and is available at header time.
    const lu = (msg.listUnsub || '').toLowerCase();
    return { from:addr, dom:(addr.split('@')[1] || ''), subject:sub, body:bd, name:nm,
             any:[sub, frm, bd, lu ? 'unsubscribe ' + lu : ''].join('\n') };
  }

  function _hit(field, k, h) {
    if (field === 'from')   return h.from === k || (!k.includes('@') && h.from.includes(k));
    if (field === 'domain') return h.dom === k || h.dom.endsWith('.' + k) || (!k.includes('.') && h.dom.includes(k));
    return (h[field] ?? h.subject).includes(k);
  }

  // match 'any' (default): at least one keyword hits. match 'all': every keyword hits.
  // Exceptions (any one present anywhere in subject/sender/body) always keep the mail.
  function checkMove(msg, ruleList) {
    const h = _hay(msg);
    for (const rule of (ruleList || moveRules)) {
      if (!rule.enabled) continue;
      const action = rule.action === 'delete' ? 'delete' : 'move';
      if (action === 'move' && !rule.targetFolder) continue;
      const kws = (rule.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean); if (!kws.length) continue;
      const field = rule.field || 'subject';
      const ok = rule.match === 'all' ? kws.every(k => _hit(field, k, h)) : kws.some(k => _hit(field, k, h));
      if (!ok) continue;
      const ex = (rule.exceptions || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
      if (ex.length && ex.some(k => h.any.includes(k))) continue;
      return rule;
    }
    return null;
  }

  // True if any enabled filter needs the message body to be evaluated.
  function needsBody() {
    return moveRules.some(r => r.enabled && ((r.field === 'body' || r.field === 'any') || (r.exceptions || []).length));
  }
  function hasActiveFilters() { return moveRules.some(r => r.enabled); }

  function findDupes(messages) {
    if(!rules.dupes?.enabled) return [];
    const hash = s => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      return (h >>> 0).toString(36);
    };
    const dupKey = m => {
      const mid = (m.messageId || '').toLowerCase().trim();
      if (mid) return 'mid:' + mid;
      const from = ImapEngine.extractAddr(m.from || '');
      const sub = (m.subject || '').toLowerCase().replace(/^(re|fwd?|fw|aw):\s*/gi,'').trim();
      const body = (m.rawBody || '').toLowerCase().replace(/\s+/g,' ').trim().slice(0, 240);
      if (!from && !sub && !body) return '';
      return [from, sub, body ? hash(body) : ''].join('|');
    };
    const seen=new Map(),dupes=[];
    [...messages].sort((a,b)=>a.date-b.date).forEach(m=>{
      const k=dupKey(m);
      if(k&&seen.has(k)) dupes.push(seen.get(k)); if(k) seen.set(k,m);
    });
    return dupes;
  }

  return {load,save,get,findDupes,getMoveRules,saveMoveRules,addMoveRule,updateMoveRule,deleteMoveRule,
          checkMove,addBlock,setBodyProvider,needsBody,hasActiveFilters};
})();
