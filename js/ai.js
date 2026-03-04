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
    const provider = (cfg.provider || 'auto').toLowerCase();

    if (provider === 'chrome') {
      return _tryChromeOnly(msg);
    }

    if (provider === 'anthropic') {
      if (!cfg.apiKey) {
        return {
          risk:'UNAVAILABLE',
          summary:'Anthropic provider selected but API key is missing.',
          indicators:['Open AI Settings and add your Anthropic API key.'],
          engine:'Anthropic API',
        };
      }
      try {
        return await _anthropicAPI(msg, cfg.apiKey, cfg.model);
      } catch(e) {
        return {
          risk:'ERROR',
          summary:'Anthropic API request failed.',
          indicators:[String(e?.message || 'Unknown API error').slice(0, 160)],
          engine:'Anthropic API',
        };
      }
    }

    if (provider === 'openai') {
      if (!cfg.apiKey) {
        return {
          risk:'UNAVAILABLE',
          summary:'OpenAI-compatible provider selected but API key is missing.',
          indicators:['Open AI Settings and add API key (and Base URL if needed).'],
          engine:'OpenAI-compatible API',
        };
      }
      try {
        return await _openaiAPI(msg, cfg.apiKey, cfg.baseUrl, cfg.model);
      } catch(e) {
        return {
          risk:'ERROR',
          summary:'OpenAI-compatible API request failed.',
          indicators:[String(e?.message || 'Unknown API error').slice(0, 160)],
          engine:'OpenAI-compatible API',
        };
      }
    }

    if (provider === 'heuristic') {
      return _heuristic(msg);
    }

    // Auto mode: Chrome AI -> API (if configured) -> heuristic
    const chromeResult = await _tryChrome(msg);
    if (chromeResult) return chromeResult;

    if (cfg.apiKey) {
      const wantsAnthropic = /^claude/i.test((cfg.model || '').trim());
      if (wantsAnthropic) {
        try { return await _anthropicAPI(msg, cfg.apiKey, cfg.model); } catch(_) {}
      }
      try { return await _openaiAPI(msg, cfg.apiKey, cfg.baseUrl, cfg.model); } catch(_) {}
      if (!wantsAnthropic) {
        try { return await _anthropicAPI(msg, cfg.apiKey, cfg.model); } catch(_) {}
      }
    }

    return _heuristic(msg, 'Chrome AI/API unavailable');
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

  async function _tryChrome(msg) {
    if (typeof window === 'undefined' || !window.ai?.languageModel) return null;
    try {
      return await _chromAI(msg);
    } catch(_) {
      return null;
    }
  }

  async function _tryChromeOnly(msg) {
    if (typeof window === 'undefined' || !window.ai?.languageModel) {
      return {
        risk:'UNAVAILABLE',
        summary:'Chrome AI API is not available in this NW.js runtime.',
        indicators:['Enable --enable-ai-api and install Gemini Nano in chrome://components.'],
        engine:'Chrome AI',
      };
    }
    try {
      return await _chromAI(msg);
    } catch(e) {
      return {
        risk:'ERROR',
        summary:'Chrome AI failed to analyse this message.',
        indicators:[String(e?.message || 'Unknown Chrome AI error').slice(0, 160)],
        engine:'Chrome AI',
      };
    }
  }

  // ── Anthropic API ─────────────────────────────────────────────────────

  async function _anthropicAPI(msg, apiKey, model) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-3-5-haiku-latest', max_tokens:300,
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

  function _heuristic(msg, reason) {
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
      engine: reason ? `Local heuristic (${reason})` : 'Local heuristic',
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

  function getProvider()  { return getCfg().provider || 'auto'; }
  function getApiKey()    { return getCfg().apiKey    || ''; }
  function getBaseUrl()   { return getCfg().baseUrl   || ''; }
  function getModel()     { return getCfg().model     || ''; }
  function setProvider(p) { saveCfg({ provider:p }); }
  function setApiKey(k)   { saveCfg({ apiKey:k }); }
  function setBaseUrl(u)  { saveCfg({ baseUrl:u }); }
  function setModel(m)    { saveCfg({ model:m }); }

  return { analyse, scanBatch, getProvider, getApiKey, getBaseUrl, getModel, setProvider, setApiKey, setBaseUrl, setModel };
})();
