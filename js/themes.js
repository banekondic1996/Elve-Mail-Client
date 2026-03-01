// js/themes.js v5
// Background wallpaper: uses a fixed #bg-layer div BEHIND everything.
// Body background color is set to transparent when wallpaper is active,
// so the wallpaper shows through the semi-transparent panes.
// Blur applied via CSS filter on the bg-layer itself.

'use strict';
const Themes = (() => {
  const THEMES = [
    { id:'dark',     name:'Dark',      bg:'#07070f', acc:'#6c63ff' },
    { id:'midnight', name:'Midnight',  bg:'#050810', acc:'#3b82f6' },
    { id:'emerald',  name:'Emerald',   bg:'#030d09', acc:'#10b981' },
    { id:'rose',     name:'Rose',      bg:'#0f080a', acc:'#fb7185' },
    { id:'nord',     name:'Nord',      bg:'#1a1f2e', acc:'#81a1c1' },
    { id:'light',    name:'Light',     bg:'#f5f5f8', acc:'#6c63ff' },
    { id:'solar',    name:'Solarized', bg:'#002b36', acc:'#268bd2' },
    { id:'mocha',    name:'Mocha',     bg:'#1c1410', acc:'#d4956a' },
  ];
  const KEY   = 'elve_theme_v5';
  const BGKEY = 'elve_bg_image';

  let cur = { theme:'dark', bg:'none', sidebarW:220, tint:null, bgBlur:0, bgOpacity:0.88 };

  // ── #bg-layer — fixed div that holds the wallpaper ────────────────────────
  function _getBgLayer() {
    let el = document.getElementById('bg-layer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bg-layer';
      // Position fixed, fill viewport, sit BEHIND everything (z-index -1)
      el.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:-1',
        'pointer-events:none',
        'background-size:cover',
        'background-position:center',
        'background-repeat:no-repeat',
        'transition:background-image .3s, filter .3s',
      ].join(';');
      // Insert as FIRST child of body so it's truly behind everything
      document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  function load() {
    try { const s = localStorage.getItem(KEY); if (s) cur = {...cur, ...JSON.parse(s)}; } catch(e) {}
    _apply(cur);
  }

  function _apply(delta) {
    cur = {...cur, ...delta};
    const root = document.documentElement;
    const body = document.body;

    // 1. Theme class
    THEMES.forEach(t => body.classList.remove('theme-' + t.id));
    body.classList.add('theme-' + cur.theme);

    // 2. Pattern classes
    ['bg-noise','bg-mesh','bg-dots','bg-grid'].forEach(c => body.classList.remove(c));
    if (cur.bg && cur.bg !== 'none') body.classList.add('bg-' + cur.bg);

    // 3. Accent colour — always set inline on :root (beats class specificity)
    const th  = THEMES.find(t => t.id === cur.theme) || THEMES[0];
    const hex = cur.tint || th.acc;
    const [r, g, b] = _rgb(hex);
    root.style.setProperty('--accent',      hex);
    root.style.setProperty('--accent2',     _lighten(hex, 30));
    root.style.setProperty('--accent-bg',   `rgba(${r},${g},${b},0.1)`);
    root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.3)`);

    // 4. Sidebar width
    root.style.setProperty('--sidebar-w', (cur.sidebarW || 220) + 'px');

    // 5. Wallpaper — on #bg-layer (z-index:-1, behind everything)
    const img   = localStorage.getItem(BGKEY);
    const layer = _getBgLayer();

    if (img) {
      // Show wallpaper
      layer.style.backgroundImage = `url("${img}")`;
      // Apply blur via filter on the bg-layer
      const blur = cur.bgBlur > 0 ? `blur(${cur.bgBlur}px) brightness(0.65)` : 'brightness(0.75)';
      layer.style.filter = blur;

      // Make body background transparent so wallpaper shows through
      body.style.setProperty('background', 'transparent', 'important');

      // Pane opacity — make sidebar/list/reader semi-transparent
      const op = cur.bgOpacity !== undefined ? cur.bgOpacity : 0.88;
      root.style.setProperty('--pane-opacity', String(op));
    } else {
      // No wallpaper — solid theme background
      layer.style.backgroundImage = 'none';
      layer.style.filter = 'none';
      body.style.removeProperty('background');
      root.style.setProperty('--pane-opacity', '1');
    }

    // 6. Save to localStorage
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch(e) {}
  }

  // ── Colour helpers ────────────────────────────────────────────────────────
  function _rgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  function _lighten(hex, amt) {
    return '#' + _rgb(hex).map(v => Math.min(255, v + amt).toString(16).padStart(2,'0')).join('');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function setBgImage(dataUrl) {
    try { localStorage.setItem(BGKEY, dataUrl); } catch(e) {}
    _apply({});
  }
  function clearBgImage() {
    localStorage.removeItem(BGKEY);
    _apply({ bgBlur: 0, bgOpacity: 0.88 });
  }
  function setBgBlur(px)     { _apply({ bgBlur: Math.max(0, parseInt(px) || 0) }); }
  function setBgOpacity(v)   { _apply({ bgOpacity: Math.min(1, Math.max(0.1, parseFloat(v) || 0.88)) }); }

  // ── Picker builder ────────────────────────────────────────────────────────
  function buildPicker(opts) {
    const { grid, bgOpts, swSlider, swVal, tintInput, tintReset, blurSlider, blurVal, opacitySlider, opacityVal } = opts;

    if (grid) {
      grid.innerHTML = '';
      THEMES.forEach(t => {
        const sw = document.createElement('div');
        sw.className = 'theme-swatch' + (cur.theme === t.id ? ' active' : '');
        sw.innerHTML = `<div class="swatch-preview" style="background:linear-gradient(135deg,${t.bg} 40%,${t.acc});"></div><div class="swatch-name">${t.name}</div>`;
        sw.addEventListener('click', () => {
          grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
          sw.classList.add('active');
          _apply({ theme: t.id, tint: null });
          if (tintInput) tintInput.value = t.acc;
        });
        grid.appendChild(sw);
      });
    }

    if (bgOpts) {
      bgOpts.querySelectorAll('.bg-opt').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.bg === (cur.bg || 'none'));
        btn.onclick = () => {
          bgOpts.querySelectorAll('.bg-opt').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _apply({ bg: btn.dataset.bg });
        };
      });
    }

    if (swSlider) {
      swSlider.value = cur.sidebarW || 220;
      if (swVal) swVal.textContent = (cur.sidebarW || 220) + 'px';
      swSlider.oninput = () => {
        if (swVal) swVal.textContent = swSlider.value + 'px';
        _apply({ sidebarW: parseInt(swSlider.value) || 220 });
      };
    }

    if (tintInput) {
      const th = THEMES.find(t => t.id === cur.theme) || THEMES[0];
      tintInput.value = cur.tint || th.acc;
      tintInput.oninput = () => _apply({ tint: tintInput.value });
    }
    if (tintReset) {
      tintReset.onclick = () => {
        _apply({ tint: null });
        const th = THEMES.find(t => t.id === cur.theme) || THEMES[0];
        if (tintInput) tintInput.value = th.acc;
      };
    }

    if (blurSlider) {
      blurSlider.min = 0; blurSlider.max = 20; blurSlider.step = 1;
      blurSlider.value = cur.bgBlur !== undefined ? cur.bgBlur : 0;
      if (blurVal) blurVal.textContent = blurSlider.value + 'px';
      blurSlider.oninput = () => {
        if (blurVal) blurVal.textContent = blurSlider.value + 'px';
        setBgBlur(blurSlider.value);
      };
    }

    if (opacitySlider) {
      opacitySlider.min = 0.1; opacitySlider.max = 1; opacitySlider.step = 0.05;
      opacitySlider.value = cur.bgOpacity !== undefined ? cur.bgOpacity : 0.88;
      if (opacityVal) opacityVal.textContent = Math.round((cur.bgOpacity || 0.88) * 100) + '%';
      opacitySlider.oninput = () => {
        if (opacityVal) opacityVal.textContent = Math.round(opacitySlider.value * 100) + '%';
        setBgOpacity(opacitySlider.value);
      };
    }
  }

  return { load, buildPicker, setBgImage, clearBgImage, setBgBlur, setBgOpacity };
})();
