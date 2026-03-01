// js/calendar.js — Elve Mail Calendar v2
// Adds: VALARM notification reminders, full event detail preservation,
// and a richer parseICS that captures attendees, organizer, status.
'use strict';
const Calendar = (() => {
  const KEY = 'elve_calendars';
  let calendars = []; // [{ name, url, color, events[] }]

  // Active notification timers
  const _notifTimers = new Map();

  function load() {
    try { const s=localStorage.getItem(KEY); if(s) calendars=JSON.parse(s,_reviver); } catch(e) {}
    _scheduleAllNotifications();
    return calendars;
  }

  // JSON reviver: restore Date objects
  function _reviver(key, val) {
    if ((key==='start'||key==='end') && typeof val==='string' && /^\d{4}-/.test(val)) return new Date(val);
    return val;
  }

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        calendars.map(c => ({
          name: c.name,
          url: c.url,
          color: c.color,
          events: c.events || []
        }))
      )
    );
  } catch (e) {}
}

  // ── Parse ICS text ────────────────────────────────────────────────────────
  function parseICS(icsText, calName, calColor) {
    const events = [];
    if (!icsText) return events;

    const vevents = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

    vevents.forEach(vevent => {
      try {
        // Helper: unfold lines then extract
        const unfolded = vevent.replace(/\r?\n[ \t]/g, '');
        const get = (prop) => {
          // Match PROP, PROP;param=val, etc.
          const m = unfolded.match(new RegExp(`^${prop}(?:[;:][^\r\n]*)\\s*:\\s*([^\r\n]+)`, 'mi'));
          return m ? m[1].replace(/\\n/g,'\n').replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\\\/g,'\\').trim() : '';
        };
        const getAll = (prop) => {
          const re = new RegExp(`^${prop}[^:\\r\\n]*:([^\\r\\n]+)`, 'gmi');
          const results = []; let m;
          while ((m=re.exec(unfolded))!==null) results.push(m[1].trim());
          return results;
        };

        const parseDate = (str) => {
          if (!str) return null;
          const val = str.includes(':') ? str.split(':').pop() : str;
          const clean = val.replace(/Z$/, '');
          if (clean.length === 8) {
            // DATE only — YYYYMMDD
            return new Date(clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T00:00:00');
          }
          if (clean.length >= 15) {
            // DATETIME — YYYYMMDDTHHmmss
            return new Date(clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T'+clean.slice(9,11)+':'+clean.slice(11,13)+':'+clean.slice(13,15));
          }
          return null;
        };

        const dtstart = unfolded.match(/^DTSTART[^:\r\n]*:([^\r\n]+)/mi)?.[1] || '';
        const dtend   = unfolded.match(/^DTEND[^:\r\n]*:([^\r\n]+)/mi)?.[1]   || '';
        const isAllDay = dtstart.includes(';VALUE=DATE') || (!dtstart.includes('T') && dtstart.replace(/.*:/,'').length===8);

        // Parse VALARM blocks for notifications
        const valarms = vevent.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g) || [];
        const reminders = valarms.map(va => {
          const triggerRaw = va.match(/TRIGGER[^:\r\n]*:([^\r\n]+)/i)?.[1] || '';
          return { trigger: _parseTrigger(triggerRaw) };
        }).filter(r => r.trigger !== null);

        const ev = {
          uid:         get('UID') || Math.random().toString(36).slice(2),
          summary:     get('SUMMARY') || '(No title)',
          description: get('DESCRIPTION'),
          location:    get('LOCATION'),
          organizer:   get('ORGANIZER').replace(/^.*CN=/i,'').replace(/;.*/,'') || '',
          attendees:   getAll('ATTENDEE').map(a=>a.replace(/^.*CN=/i,'').replace(/;.*/,'').replace(/^mailto:/i,'')),
          status:      get('STATUS'),
          start:       parseDate(dtstart),
          end:         parseDate(dtend),
          allDay:      isAllDay,
          calendar:    calName,
          color:       calColor || '#6c63ff',
          reminders,
          // Custom reminder added by user (minutes before)
          userReminder: null,
        };
        if (ev.start) events.push(ev);
      } catch(e) {}
    });

    return events.sort((a,b) => a.start - b.start);
  }

  // Parse TRIGGER duration like -PT1H, -P1D, PT30M, -P1DT2H
  function _parseTrigger(raw) {
    if (!raw) return null;
    const neg = raw.startsWith('-');
    const m = raw.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
    if (!m) return null;
    const days=parseInt(m[1]||0), hours=parseInt(m[2]||0), mins=parseInt(m[3]||0), secs=parseInt(m[4]||0);
    const totalMins = days*1440 + hours*60 + mins + Math.round(secs/60);
    return neg ? -totalMins : totalMins; // negative = before event
  }

  // ── Notification scheduling ───────────────────────────────────────────────
  function _scheduleAllNotifications() {
    _notifTimers.forEach(t=>clearTimeout(t));
    _notifTimers.clear();
    const now=Date.now();
    calendars.forEach(cal=>{
      (cal.events||[]).forEach(ev=>{
        if (!ev.start) return;
        // Collect all reminders: built-in VALARM + user custom
        const reminders=[...(ev.reminders||[])];
        if (ev.userReminder!=null) reminders.push({trigger:-ev.userReminder});
        reminders.forEach((rem,i)=>{
          if (rem.trigger==null) return;
          // trigger is minutes before (negative = before)
          const offsetMs = rem.trigger * 60000; // e.g. -60min = -60*60000
          const fireAt = ev.start.getTime() + offsetMs;
          if (fireAt<=now) return; // already passed
          const delay=fireAt-now;
          const key=`${ev.uid}_${i}`;
          const t=setTimeout(()=>_fireNotif(ev), delay);
          _notifTimers.set(key,t);
        });
      });
    });
  }

  function _fireNotif(ev) {
    try {
      if (!('Notification' in window)) return;
      const timeStr=ev.allDay?ev.start.toLocaleDateString():ev.start.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      new Notification('📅 ' + ev.summary, {
        body: timeStr + (ev.location?'\n📍 '+ev.location:''),
        tag: ev.uid,
      });
    } catch(e) {}
    // Also show in-app banner
    const banner=document.createElement('div');
    banner.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:700;z-index:10000;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.3)';
    banner.textContent='📅 Reminder: '+ev.summary;
    document.body.appendChild(banner);
    clearTimeout(banner._t); banner._t=setTimeout(()=>banner.remove(),8000);
    banner.onclick=()=>banner.remove();
  }

  // ── Fetch remote calendar ─────────────────────────────────────────────────
  async function fetchCalendar(url) {
    let icsUrl=url;
    if (url.includes('calendar.google.com')&&!url.includes('.ics')) {
      const m=url.match(/src=([^&]+)/);
      if (m) icsUrl=`https://calendar.google.com/calendar/ical/${decodeURIComponent(m[1])}/public/basic.ics`;
    }
    const resp=await fetch(icsUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — check calendar URL or sharing settings`);
    return await resp.text();
  }

  async function addCalendar(name, url, color) {
    if (url.startsWith('data:')||!url.startsWith('http')) throw new Error('Provide a public calendar URL');
    const icsText=await fetchCalendar(url);
    const events=parseICS(icsText, name, color);
    const idx=calendars.findIndex(c=>c.url===url);
    const cal={name, url, color:color||_randColor(), events};
    if (idx>=0) calendars[idx]=cal; else calendars.push(cal);
    save(); _scheduleAllNotifications(); return cal;
  }

  async function loadFromFile(icsText, name, color) {
    const cal={name:name||'Imported', url:'', color:color||_randColor(), events:parseICS(icsText, name, color)};
    calendars.push(cal); save(); _scheduleAllNotifications(); return cal;
  }

  async function refreshAll() {
    for (const cal of calendars) {
      if (!cal.url) continue;
      try { const t=await fetchCalendar(cal.url); cal.events=parseICS(t, cal.name, cal.color); } catch(e) {}
    }
    save(); _scheduleAllNotifications();
  }

  function removeCalendar(name) { calendars=calendars.filter(c=>c.name!==name); save(); _scheduleAllNotifications(); }

  // Set/clear a user-defined reminder (minutes before) on a specific event
  function setEventReminder(calName, uid, minutesBefore) {
    const cal=calendars.find(c=>c.name===calName); if (!cal) return;
    const ev=cal.events.find(e=>e.uid===uid); if (!ev) return;
    ev.userReminder=minutesBefore;
    save(); _scheduleAllNotifications();
  }

  // ── Getters ───────────────────────────────────────────────────────────────
  function getEventsForMonth(year,month) {
    const start=new Date(year,month,1), end=new Date(year,month+1,0,23,59,59);
    return calendars.flatMap(c=>c.events||[]).filter(e=>e.start>=start&&e.start<=end);
  }
  function getEventsForDay(date) {
    const d=new Date(date); d.setHours(0,0,0,0); const e=new Date(date); e.setHours(23,59,59,999);
    return calendars.flatMap(c=>c.events||[]).filter(ev=>ev.start>=d&&ev.start<=e);
  }

  function _randColor() {
    return ['#6c63ff','#10b981','#fb7185','#3b82f6','#f59e0b','#8b5cf6','#06b6d4'][Math.floor(Math.random()*7)];
  }

  return {
    load, save, addCalendar, loadFromFile, refreshAll, removeCalendar,
    parseICS, setEventReminder, getEventsForMonth, getEventsForDay,
    get calendars() { return calendars; },
  };
})();
