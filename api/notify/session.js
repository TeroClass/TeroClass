// Vercel serverless: email the students of a session (invitation with the event attached, update or
// cancellation). "Dummy feature" like the live class: it sends through Resend ONLY when RESEND_API_KEY is set
// in Vercel. Without it, it is a no-op that answers {configured:false} and the app offers
// "Copy invitation link" instead. The key never leaves the server.
//   POST /api/notify/session  {session_id, kind: 'invite'|'update'|'cancel', lang: 'es'|'en'}
//   Authorization: Bearer <the teacher's Supabase session token>
// Who may notify, and to whom, is decided by the database (session_notify_payload: only the session's
// teacher / substitute / creator, recipients = its students), called with the caller's own token.
import { SUPABASE_URL, SUPABASE_KEY, bearer } from '../_lib/livekit.js';
import { buildCalendar, appOrigin, isUuid } from '../_lib/ics.js';

const KINDS = new Set(['invite', 'update', 'cancel']);
const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,190}\.[A-Za-z]{2,24}$/;
const MAX_RECIPIENTS = 200;
const TIMEOUT_MS = 10000;

export function resendKey() { return String(process.env.RESEND_API_KEY || '').trim() || null; }

async function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: controller.signal }); } finally { clearTimeout(timer); }
}

const T = {
  es: { invite: 'Invitación', update: 'Clase actualizada', cancel: 'Clase cancelada', join: 'Entrar a la clase',
        intro: { invite: 'Tenés una clase en TeroClass.', update: 'Cambió una de tus clases en TeroClass.', cancel: 'Se canceló una de tus clases en TeroClass.' },
        when: 'Cuándo', ics: 'El evento va adjunto: abrilo para sumarlo a tu calendario.' },
  en: { invite: 'Invitation', update: 'Class updated', cancel: 'Class cancelled', join: 'Join the class',
        intro: { invite: 'You have a class on TeroClass.', update: 'One of your classes on TeroClass changed.', cancel: 'One of your classes on TeroClass was cancelled.' },
        when: 'When', ics: 'The event is attached: open it to add it to your calendar.' },
};
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildEmails(p, { kind, lang, origin, from }) {
  const t = T[lang] || T.es;
  const when = (() => { try { return new Date(p.starts_at).toLocaleString(lang === 'en' ? 'en-US' : 'es-UY', { timeZone: p.timezone || 'America/Montevideo', dateStyle: 'full', timeStyle: 'short' }) + ` (${p.timezone || 'America/Montevideo'})`; } catch { return String(p.starts_at); } })();
  const title = String(p.title || p.group_name || 'Class').slice(0, 200);
  const ics = buildCalendar([p], { method: kind === 'cancel' ? 'CANCEL' : 'REQUEST', origin, name: 'TeroClass' });
  const link = `${origin}/?session=${p.id}`;
  const subject = `${t[kind]}: ${title} · ${when}`.replace(/[\r\n]+/g, ' ').slice(0, 250);
  const html = `<p>${escHtml(t.intro[kind])}</p><p><b>${escHtml(title)}</b>${p.group_name ? ` · ${escHtml(p.group_name)}` : ''}<br>${escHtml(t.when)}: ${escHtml(when)}</p>`
    + (kind === 'cancel' ? '' : `<p><a href="${escHtml(link)}">${escHtml(t.join)}</a></p>`) + `<p style="color:#888">${escHtml(t.ics)}</p>`;
  const recipients = (Array.isArray(p.recipients) ? p.recipients : [])
    .map(r => String(r?.email || '').trim()).filter(e => EMAIL_RE.test(e))
    .filter((e, i, a) => a.findIndex(x => x.toLowerCase() === e.toLowerCase()) === i).slice(0, MAX_RECIPIENTS);
  return recipients.map(to => ({ from, to: [to], subject, html,
    attachments: [{ filename: kind === 'cancel' ? 'cancel.ics' : 'invite.ics', content: Buffer.from(ics, 'utf8').toString('base64'), content_type: 'text/calendar; charset=utf-8; method=' + (kind === 'cancel' ? 'CANCEL' : 'REQUEST') }] }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const key = resendKey();
  // No email provider: nothing is read or sent (the app shows "copy invitation link").
  if (!key) return res.status(200).json({ configured: false, sent: 0, message: 'email not configured' });

  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isUuid(b.session_id) || !KINDS.has(b.kind)) return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const lang = b.lang === 'en' ? 'en' : 'es';

  let payload = null;
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/session_notify_payload`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session: b.session_id }),
    });
    if (r.status === 401) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
    if (!r.ok) return res.status(403).json({ error: 'Not allowed.', code: 'forbidden' });
    payload = await r.json();
  } catch { return res.status(502).json({ error: 'Could not reach the database.', code: 'upstream' }); }
  if (!payload || !isUuid(payload.id)) return res.status(403).json({ error: 'Not allowed.', code: 'forbidden' });

  const from = String(process.env.NOTIFY_FROM || 'TeroClass <no-reply@teroclass.com>').slice(0, 200);
  const emails = buildEmails(payload, { kind: b.kind, lang, origin: appOrigin(req), from });
  if (!emails.length) return res.status(200).json({ configured: true, sent: 0, failed: 0 });
  let sent = 0; let failed = 0;
  for (let i = 0; i < emails.length; i += 100) {             // Resend batch: up to 100 emails per call
    const chunk = emails.slice(i, i + 100);
    try {
      const r = await timedFetch('https://api.resend.com/emails/batch', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk),
      });
      if (r.ok) sent += chunk.length; else { failed += chunk.length; console.error(`notify: resend batch failed (HTTP ${r.status})`); }
    } catch { failed += chunk.length; console.error('notify: resend batch failed (network)'); }
  }
  return res.status(200).json({ configured: true, sent, failed });
}
