// js/rules.js — Filter/rules engine v3
// delete-rules: match → auto-delete (unchanged)
// move-rules:   named filters that move matched mail to a chosen folder
'use strict';
const Rules = (() => {
  const KEY      = 'elve_rules_v2';
  const MOVE_KEY = 'elve_move_rules_v1';
  const DEF = {
    domain:{enabled:false,list:[]}, email:{enabled:false,list:[]},
    name:{enabled:false,list:[]}, subject:{enabled:false,list:[]},
    body:{enabled:false,list:[]}, dupes:{enabled:true}, aiscam:{enabled:false},
  };
  let rules     = JSON.parse(JSON.stringify(DEF));
  let moveRules = [];   // [{ id, name, enabled, field, keywords[], targetFolder }]

  function load() {
    try { const s=localStorage.getItem(KEY);      if(s) rules    ={...DEF,...JSON.parse(s)}; } catch(e){}
    try { const s=localStorage.getItem(MOVE_KEY); if(s) moveRules=JSON.parse(s); } catch(e){}
    return rules;
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

  function check(msg) {
    const sub=(msg.subject||'').toLowerCase(), frm=(msg.from||'').toLowerCase();
    const bd=(msg.rawBody||'').toLowerCase().slice(0,2000);
    const addr=ImapEngine.extractAddr(msg.from||''), nm=ImapEngine.extractName(msg.from||'').toLowerCase();
    const hits=[];
    if(rules.domain?.enabled)  for(const d of rules.domain.list||[])  {if(addr.includes(d.toLowerCase())){hits.push({rule:'domain',value:d});break;}}
    if(rules.email?.enabled)   for(const e of rules.email.list||[])   {if(addr===e.toLowerCase()||addr.includes(e.toLowerCase())){hits.push({rule:'email',value:e});break;}}
    if(rules.name?.enabled)    for(const n of rules.name.list||[])    {if(nm.includes(n.toLowerCase())){hits.push({rule:'name',value:n});break;}}
    if(rules.subject?.enabled) for(const k of rules.subject.list||[]) {if(sub.includes(k.toLowerCase())){hits.push({rule:'subject',value:k});break;}}
    if(rules.body?.enabled)    for(const k of rules.body.list||[])    {if(bd.includes(k.toLowerCase())){hits.push({rule:'body',value:k});break;}}
    return hits;
  }

  // Returns first matching move rule, or null
  function checkMove(msg) {
    const sub=(msg.subject||'').toLowerCase(), frm=(msg.from||'').toLowerCase();
    const addr=ImapEngine.extractAddr(msg.from||''), nm=ImapEngine.extractName(msg.from||'').toLowerCase();
    const bd=(msg.rawBody||'').toLowerCase().slice(0,2000);
    for(const rule of moveRules) {
      if(!rule.enabled||!rule.targetFolder) continue;
      const kws=(rule.keywords||[]).map(k=>k.toLowerCase()); if(!kws.length) continue;
      const h={from:frm,domain:addr,subject:sub,body:bd,name:nm}[rule.field||'subject']||sub;
      if(kws.some(k=>h.includes(k))) return rule;
    }
    return null;
  }

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

  return {load,save,get,check,findDupes,getMoveRules,saveMoveRules,addMoveRule,updateMoveRule,deleteMoveRule,checkMove};
})();
