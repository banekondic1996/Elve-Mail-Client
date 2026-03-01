// js/calendar.js — ICS calendar viewer (Google Calendar + any .ics)

'use strict';
const Calendar = (() => {
  let ICAL;
  try { ICAL = require('ical.js'); } catch(e) {
    // Fallback: try to require from node_modules
    try { ICAL = require('./node_modules/ical.js/build/ical.js'); } catch(e2) {}
  }

  const KEY = 'elve_calendars';
  let calendars = []; // [{ name, url, color, events[] }]

  function load() {
    try { const s=localStorage.getItem(KEY); if(s) calendars=JSON.parse(s); } catch(e) {}
    return calendars;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(calendars.map(c=>({name:c.name,url:c.url,color:c.color})))); } catch(e){} }

  // ── Parse ICS text ────────────────────────────────────────────────────

  function parseICS(icsText, calName, calColor) {
    const events = [];
    if (!icsText) return events;

    // Simple regex parser (works without ical.js)
    const vevents = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

    vevents.forEach(vevent => {
      try {
        const get = (prop) => {
          const m = vevent.match(new RegExp(`${prop}[^:]*:([^\\r\\n]+)`, 'i'));
          return m ? m[1].replace(/\\n/g,'\n').replace(/\\,/g,',').trim() : '';
        };
        const parseDate = (str) => {
          if (!str) return null;
          // Handle TZID=... prefix
          const val = str.split(':').pop();
          if (val.length === 8) return new Date(val.slice(0,4)+'-'+val.slice(4,6)+'-'+val.slice(6,8));
          if (val.length >= 15) return new Date(val.slice(0,4)+'-'+val.slice(4,6)+'-'+val.slice(6,8)+'T'+val.slice(9,11)+':'+val.slice(11,13)+':'+val.slice(13,15));
          return null;
        };

        const dtstart = vevent.match(/DTSTART[^:\r\n]*:([^\r\n]+)/i)?.[1] || '';
        const dtend   = vevent.match(/DTEND[^:\r\n]*:([^\r\n]+)/i)?.[1]   || '';

        const ev = {
          uid:         get('UID'),
          summary:     get('SUMMARY') || '(No title)',
          description: get('DESCRIPTION'),
          location:    get('LOCATION'),
          start:       parseDate(dtstart),
          end:         parseDate(dtend),
          allDay:      dtstart.length === 8,
          calendar:    calName,
          color:       calColor || '#6c63ff',
        };
        if (ev.start) events.push(ev);
      } catch(e) {}
    });

    return events.sort((a,b) => a.start - b.start);
  }

  // ── Fetch calendar from URL ───────────────────────────────────────────

  async function fetchCalendar(url) {
    // For Google Calendar: convert HTML share URL to ICS URL
    let icsUrl = url;
    if (url.includes('calendar.google.com') && !url.includes('.ics')) {
      // Convert gcal share URL to ICS
      icsUrl = url.replace('/calendar/embed?', '/calendar/ical/').replace('&', '/basic.ics?');
      if (!icsUrl.includes('.ics')) {
        const m = url.match(/src=([^&]+)/);
        if (m) icsUrl = `https://calendar.google.com/calendar/ical/${decodeURIComponent(m[1])}/public/basic.ics`;
      }
    }

    const resp = await fetch(icsUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — check calendar URL or sharing settings`);
    return await resp.text();
  }

  // ── Add or refresh calendar ───────────────────────────────────────────

  async function addCalendar(name, url, color) {
    let icsText;
    if (url.startsWith('data:') || !url.startsWith('http')) {
      throw new Error('Provide a public calendar URL (e.g. Google Calendar > Share > Get shareable link)');
    }
    icsText = await fetchCalendar(url);
    const events = parseICS(icsText, name, color);
    const idx = calendars.findIndex(c=>c.url===url);
    const cal = { name, url, color:color||_randColor(), events };
    if (idx>=0) calendars[idx]=cal; else calendars.push(cal);
    save();
    return cal;
  }

  async function loadFromFile(icsText, name, color) {
    const cal = { name:name||'Imported', url:'', color:color||_randColor(), events: parseICS(icsText, name, color) };
    calendars.push(cal);
    save();
    return cal;
  }

  async function refreshAll() {
    for (const cal of calendars) {
      if (!cal.url) continue;
      try {
        const icsText = await fetchCalendar(cal.url);
        cal.events = parseICS(icsText, cal.name, cal.color);
      } catch(e) { console.warn('[Calendar] Refresh failed:', cal.name, e.message); }
    }
    save();
  }

  function removeCalendar(name) {
    calendars = calendars.filter(c=>c.name!==name);
    save();
  }

  // ── Get events in range ───────────────────────────────────────────────

  function getEventsForMonth(year, month) { // month: 0-indexed
    const start = new Date(year, month, 1);
    const end   = new Date(year, month+1, 0, 23, 59, 59);
    const all   = calendars.flatMap(c=>c.events||[]);
    return all.filter(e => e.start >= start && e.start <= end);
  }

  function getEventsForDay(date) {
    const d = new Date(date); d.setHours(0,0,0,0);
    const e = new Date(date); e.setHours(23,59,59,999);
    return calendars.flatMap(c=>c.events||[]).filter(ev => ev.start >= d && ev.start <= e);
  }

  function _randColor() {
    const colors = ['#6c63ff','#10b981','#fb7185','#3b82f6','#f59e0b','#8b5cf6','#06b6d4'];
    return colors[Math.floor(Math.random()*colors.length)];
  }

  return { load, addCalendar, loadFromFile, refreshAll, removeCalendar, getEventsForMonth, getEventsForDay, parseICS, get calendars() { return calendars; } };
})();
