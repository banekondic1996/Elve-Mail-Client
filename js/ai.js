// js/ai.js — AI scam detection
// Priority: 1) Chrome AI (window.ai / Gemini Nano) 2) Third-party API 3) Heuristic

'use strict';
const AI = (() => {
  const STORAGE_KEY = 'elve_ai_cfg';

  function getCfg() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; }
  }
  function saveCfg(c) { localStorage.setItem(STORAGE_KEY, JSON.stringify({...getCfg(),...c})); }

  // ── Analyse one message ────────────────────────────────────────────────

  async function analyse(msg) {
    const cfg = getCfg();

    // 1. Chrome AI (Gemini Nano) — available in NW.js with --enable-ai-api flag
    if (typeof window !== 'undefined' && window.ai?.languageModel) {
      try { return await _chromAI(msg); } catch(e) { console.warn('[AI] Chrome AI:', e.message); }
    }

    // 2. Anthropic Claude API
    if (cfg.provider === 'anthropic' && cfg.apiKey) {
      try { return await _anthropicAPI(msg, cfg.apiKey); } catch(e) { console.warn('[AI] Anthropic:', e.message); }
    }

    // 3. OpenAI-compatible API (OpenAI, Groq, local Ollama, etc.)
    if (cfg.provider === 'openai' && cfg.apiKey) {
      try { return await _openaiAPI(msg, cfg.apiKey, cfg.baseUrl, cfg.model); } catch(e) { console.warn('[AI] OpenAI:', e.message); }
    }

    // 4. Heuristic fallback (always works, no network)
    return _heuristic(msg);
  }

  // ── Chrome AI ─────────────────────────────────────────────────────────

  async function _chromAI(msg) {
    const caps = await window.ai.languageModel.capabilities();
    if (caps?.available === 'no') throw new Error('Model unavailable');
    if (caps?.available === 'after-download') return {
      risk:'UNAVAILABLE',
      summary:'Gemini Nano model is downloading. Check chrome://components. Try again in a few minutes.',
      indicators:[], engine:'Chrome AI (downloading)',
    };
    const session = await window.ai.languageModel.create({
      systemPrompt: 'You are a cybersecurity expert. Respond ONLY with valid JSON, no markdown.',
    });
    const raw = await session.prompt(_prompt(msg));
    session.destroy();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    return { ...JSON.parse(m[0]), engine:'Chrome AI (Gemini Nano)' };
  }

  // ── Anthropic API ─────────────────────────────────────────────────────

  async function _anthropicAPI(msg, apiKey) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens:300,
        system: 'You are a cybersecurity expert. Respond ONLY with valid JSON, no markdown.',
        messages: [{ role:'user', content: _prompt(msg) }],
      }),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const data = await r.json();
    const raw  = data.content?.[0]?.text||'';
    const m    = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    return { ...JSON.parse(m[0]), engine:'Claude AI (Anthropic)' };
  }

  // ── OpenAI-compatible API ─────────────────────────────────────────────

  async function _openaiAPI(msg, apiKey, baseUrl, model) {
    const url = (baseUrl||'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions';
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey },
      body: JSON.stringify({
        model: model||'gpt-4o-mini', max_tokens:300,
        messages:[
          { role:'system', content:'You are a cybersecurity expert. Respond ONLY with valid JSON, no markdown.' },
          { role:'user',   content: _prompt(msg) },
        ],
      }),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const data = await r.json();
    const raw  = data.choices?.[0]?.message?.content||'';
    const m    = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    return { ...JSON.parse(m[0]), engine:`${model||'gpt-4o-mini'} (OpenAI-compatible)` };
  }

  // ── Heuristic ─────────────────────────────────────────────────────────

  function _heuristic(msg) {
    const txt = [(msg.subject||''), (msg.from||''), (msg.rawBody||msg.body||'').slice(0,1500)].join(' ').toLowerCase();
    const HIGH = ['verify your account','confirm your identity','account suspended','you have won','prize','lottery','wire transfer','urgent action required','your password has been','dear customer','send money','gift card','paypal payment','bank account details','click here to claim','dear valued customer'];
    const MED  = ['unsubscribe','click here','free offer','act now','limited time','congratulations','dear user','account verification','update your info','social security','password reset','your account has been'];
    const h = HIGH.filter(s=>txt.includes(s));
    const m = MED.filter(s=>txt.includes(s));
    const risk = h.length>=2||(h.length>=1&&m.length>=2)?'HIGH':h.length>=1||m.length>=3?'MEDIUM':'LOW';
    return {
      risk,
      summary: risk==='LOW' ? 'No obvious scam signals detected.'
              : risk==='MEDIUM' ? 'Some suspicious patterns. Review before clicking links.'
              : 'Multiple high-risk scam signals detected — likely malicious.',
      indicators: [...h.slice(0,3),...m.slice(0,2)].map(s=>`"${s}" detected`),
      engine: 'Local heuristic',
    };
  }

  function _prompt(msg) {
    return `Analyse this email for scam/phishing:\nSubject: ${msg.subject}\nFrom: ${msg.from}\nBody: ${(msg.rawBody||msg.body||'').slice(0,600)}\n\nRespond ONLY: {"risk":"HIGH|MEDIUM|LOW","summary":"2 sentences","indicators":["flag1","flag2"]}`;
  }

  // ── Batch scan ────────────────────────────────────────────────────────

  async function* scanBatch(messages) {
    for (const msg of messages) {
      yield { msg, result: await analyse(msg) };
      await new Promise(r=>setTimeout(r,30));
    }
    yield { done:true };
  }

  // ── Config accessors ──────────────────────────────────────────────────

  function getProvider()  { return getCfg().provider || 'heuristic'; }
  function getApiKey()    { return getCfg().apiKey    || ''; }
  function getBaseUrl()   { return getCfg().baseUrl   || ''; }
  function getModel()     { return getCfg().model     || ''; }
  function setProvider(p) { saveCfg({ provider:p }); }
  function setApiKey(k)   { saveCfg({ apiKey:k }); }
  function setBaseUrl(u)  { saveCfg({ baseUrl:u }); }
  function setModel(m)    { saveCfg({ model:m }); }

  return { analyse, scanBatch, getProvider, getApiKey, getBaseUrl, getModel, setProvider, setApiKey, setBaseUrl, setModel };
})();
