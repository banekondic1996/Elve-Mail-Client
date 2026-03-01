// js/notifier.js — NW.js tray + native Notification API

'use strict';
const Notifier = (() => {
  let tray = null;
  let unreadCount = 0;

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
      nw.Window.get().on('close', function() { this.hide(); });
    } catch(e) { console.warn('[Notifier] Tray error:', e.message); }
  }

  function _show() {
    if (typeof nw === 'undefined') return;
    const win = nw.Window.get();
    win.show(); win.focus();
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

  function notifyBatch(count, accountEmail) {
    _sendNative('Elve Mail', `${count} new message${count > 1 ? 's' : ''} in ${accountEmail || 'your inbox'}`);
    unreadCount += count;
    if (tray) try { tray.tooltip = `Elve Mail — ${unreadCount} unread`; } catch(_) {}
  }

  function clearBadge() {
    unreadCount = 0;
    if (tray) try { tray.tooltip = 'Elve Mail'; } catch(_) {}
  }

  return { init, notifyBatch, clearBadge };
})();
