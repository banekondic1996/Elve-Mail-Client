// js/themes.js v4
// Background image uses a dedicated #bg-layer div so CSS body{background:var(--bg)} doesn't override it.
// Accent tint sets inline CSS vars on :root which beat theme-class specificity.

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
  const KEY   = 'elve_theme_v4';
  const BGKEY = 'elve_bg_image';

  let cur = { theme:'dark', bg:'none', sidebarW:220, tint:null };

  // The bg-layer sits behind everything and holds the wallpaper image
  function _getBgLayer() {
    let el = document.getElementById('bg-layer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bg-layer';
      el.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;transition:background-image .3s;';
      document.body.prepend(el);
    }
    return el;
  }

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

    // 3. Accent — always set as inline style on :root (beats class specificity)
    const th = THEMES.find(t => t.id === cur.theme) || THEMES[0];
    const hex = cur.tint || th.acc;
    const [r, g, b] = _rgb(hex);
    root.style.setProperty('--accent',      hex);
    root.style.setProperty('--accent2',     _lighten(hex, 30));
    root.style.setProperty('--accent-bg',   `rgba(${r},${g},${b},0.1)`);
    root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.3)`);

    // 4. Wallpaper image — goes on #bg-layer, NOT body (body has background:var(--bg) from CSS)
    const img = localStorage.getItem(BGKEY);
    const layer = _getBgLayer();
    layer.style.backgroundImage = img ? `url("${img}")` : 'none';

    // 5. Layout vars
    root.style.setProperty('--sidebar-w', (cur.sidebarW || 220) + 'px');

    // 6. Save
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch(e) {}
  }

  function _rgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  function _lighten(hex, amt) {
    return '#' + _rgb(hex).map(v => Math.min(255, v + amt).toString(16).padStart(2,'0')).join('');
  }

  function setBgImage(dataUrl) {
    try { localStorage.setItem(BGKEY, dataUrl); } catch(e) {}
    _apply({});
  }
  function clearBgImage() {
    localStorage.removeItem(BGKEY);
    _apply({});
  }

  function buildPicker(opts) {
    const { grid, bgOpts, swSlider, swVal, tintInput, tintReset } = opts;

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
  }

  return { load, buildPicker, setBgImage, clearBgImage };
})();
