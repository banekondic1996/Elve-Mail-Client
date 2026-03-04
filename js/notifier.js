// js/notifier.js — NW.js tray + native Notification API

'use strict';
const Notifier = (() => {
  const KEY = 'elve_notifier_v1';
  const DEF = { showDetails: true };
  let tray = null;
  let unreadCount = 0;

  function _cfg() {
    try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; }
    catch(_) { return { ...DEF }; }
  }
  function _saveCfg(v) {
    try { localStorage.setItem(KEY, JSON.stringify({ ..._cfg(), ...v })); } catch(_) {}
  }
  const win = nw.Window.get();
  function init() {
    if (typeof nw === 'undefined') return;
    try {
      tray = new nw.Tray({ icon: 'assets/icon32.png', tooltip: 'Elve Mail' });

      const menu = new nw.Menu();
      menu.append(new nw.MenuItem({ label: 'Open Elve Mail', click: _show }));
      menu.append(new nw.MenuItem({ type: 'separator' }));
      menu.append(new nw.MenuItem({ label: 'Quit Elve Mail', click: _quit }));
      tray.menu = menu;  // right-click shows menu on Windows/Linux; macOS shows on click

      tray.on('click', _show);

      // Override window close → hide to tray
      
      win.on('close', function() { _hide(); });
    } catch(e) { console.warn('[Notifier] Tray error:', e.message); }
  }

  function _show() {
    if (typeof nw === 'undefined') return;
    win.show(); win.focus();
  }

  function _hide() {
    if (typeof nw === 'undefined') return;
    win.hide();
  }

  function _quit() {
    if (typeof nw === 'undefined') return;
    // Remove tray before quitting so icon disappears immediately
    if (tray) { try { tray.remove(); tray = null; } catch(_) {} }
    // Remove the close→hide override, then close
    nw.Window.get().removeAllListeners('close');
    nw.App.quit();
  }

  function _sendNative(title, body) {
    try {
      if (typeof Notification === 'undefined') return;
      const send = () => new Notification(title, { body, icon: 'assets/icon128.png' });
      if (Notification.permission === 'granted') {
        send();
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') send(); });
      }
    } catch(e) {}
  }

  function notifyBatch(count, accountEmail, messages) {
    const c = Math.max(1, parseInt(count, 10) || 1);
    const cfg = _cfg();
    let body = `${c} new message${c > 1 ? 's' : ''} in ${accountEmail || 'your inbox'}`;
    if (cfg.showDetails && Array.isArray(messages) && messages.length) {
      if (messages.length === 1) {
        const m = messages[0];
        body = `From: ${_short(m.from || 'Unknown')}\n${_short(m.subject || '(no subject)')}`;
      } else {
        const first = messages[0];
        body = `${messages.length} new messages\nLatest: ${_short(first.from || 'Unknown')} — ${_short(first.subject || '(no subject)')}`;
      }
    }
    _sendNative('Elve Mail', body);
    unreadCount += c;
    if (tray) try { tray.tooltip = `Elve Mail — ${unreadCount} unread`; } catch(_) {}
  }

  function _short(v) {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    return s.length > 90 ? s.slice(0, 87) + '...' : s;
  }

  function clearBadge() {
    unreadCount = 0;
    if (tray) try { tray.tooltip = 'Elve Mail'; } catch(_) {}
  }

  function getShowDetails() { return !!_cfg().showDetails; }
  function setShowDetails(v) { _saveCfg({ showDetails: !!v }); }

  return { init, notifyBatch, clearBadge, getShowDetails, setShowDetails };
})();
