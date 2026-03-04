// js/smtp-client.js — SMTP with attachment support

'use strict';
const SmtpClient = (() => {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch(e) {}

  const SERVERS = {
    gmail:   { host:'smtp.gmail.com',        port:587 },
    yahoo:   { host:'smtp.mail.yahoo.com',   port:587 },
    outlook: { host:'smtp-mail.outlook.com', port:587 },
    hotmail: { host:'smtp-mail.outlook.com', port:587 },
    live:    { host:'smtp-mail.outlook.com', port:587 },
    icloud:  { host:'smtp.mail.me.com',      port:587 },
    aol:     { host:'smtp.aol.com',          port:587 },
  };

  function _htmlToPlain(h) { return (h||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' '); }

  async function send(cfg, { to, cc, bcc, subject, text, html, replyTo, attachments }) {
    if (!nodemailer) throw new Error('nodemailer not installed. Run: npm install');
    const domain = (cfg.email || '').split('@')[1]?.toLowerCase() || '';
    const key    = cfg.provider !== 'imap' ? cfg.provider : Object.keys(SERVERS).find(k => domain.includes(k)) || null;
    const srv    = (key && SERVERS[key]) || { host: cfg.smtpHost || cfg.host || '', port: 587 };

    // fromAlias: send as a different address (Yahoo temp mail, aliases)
    // SMTP auth still uses the real account credentials; only From header changes.
    const fromAddr = cfg.fromAlias && cfg.fromAlias !== cfg.email ? cfg.fromAlias : cfg.email;

    const transporter = nodemailer.createTransport({
      host: srv.host, port: srv.port, secure: false,
      auth: { user: cfg.email, pass: cfg.password },
      tls: { rejectUnauthorized: false },
    });

    const mail = {
      from: fromAddr, to, subject,
      ...(cc  && cc.trim()  ? { cc }  : {}),
      ...(bcc && bcc.trim() ? { bcc } : {}),
      ...(html ? { html, text: text || _htmlToPlain(html) } : { text: text || '' }),
      replyTo: replyTo || fromAddr,
    };

    // Attachments: array of { name, type, data (ArrayBuffer) }
    if (attachments && attachments.length) {
      mail.attachments = attachments.map(a => ({
        filename: a.name,
        content:  Buffer.from(a.data),
        contentType: a.type,
      }));
    }

    await transporter.sendMail(mail);
  }

  return { send };
})();