// Vercel serverless: emails the institution admins when someone says NO to recording and writes the justification
// (optional since 2026-10, P-11; a "no" without text sends nothing — 001_base.sql consent_decline_notify_payload). "Dummy feature" like the class invitations: it sends ONLY
// when RESEND_API_KEY is set in Vercel; otherwise it is a no-op ({configured:false}) and admins see the justification
// in Groups → Consentimientos. The admins' emails are read with the service key (consent_decline_notify_payload, which
// only the service role can execute), so they never reach the browser. No key ever leaves the server.
//   POST /api/notify/consent  {lang: 'es'|'en'}   Authorization: Bearer <the person's Supabase session token>
// Only the caller's own declines of the last 15 minutes that were not notified yet are sent (each one once).
import { getUser, bearer } from '../livekit.js';
import { serviceRpc, serviceKey } from '../billing.js';
import { appOrigin } from '../ics.js';
import { resendKey } from './session.js';

const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,190}\.[A-Za-z]{2,24}$/;
const TIMEOUT_MS = 10000;
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

const T = {
  es: { subject: n => `Consentimiento de grabación: ${n} no aceptó que se graben sus clases`,
        intro: 'Una persona de tu institución no aceptó que se graben sus clases en TeroClass y dejó este comentario (era opcional):',
        student: 'Estudiante', teacher: 'Docente', unit: 'Unidad', cls: 'Clase', when: 'Fecha',
        note: 'Entró a la clase sin ser grabada. Se le va a volver a preguntar en su próxima clase.',
        open: 'Ver en TeroClass → Grupos → Consentimientos' },
  en: { subject: n => `Recording consent: ${n} did not agree to have their classes recorded`,
        intro: 'Someone in your institution did not agree to have their classes recorded on TeroClass and left this comment (it was optional):',
        student: 'Student', teacher: 'Teacher', unit: 'Unit', cls: 'Class', when: 'Date',
        note: 'They joined the class without being recorded. They will be asked again at their next class.',
        open: 'See it in TeroClass → Groups → Consents' },
};

export function buildDeclineEmails(items, { lang = 'es', origin, from }) {
  const t = T[lang] || T.es;
  const out = [];
  for (const d of Array.isArray(items) ? items : []) {
    const recipients = (Array.isArray(d?.recipients) ? d.recipients : []).map(e => String(e || '').trim()).filter(e => EMAIL_RE.test(e))
      .filter((e, i, a) => a.findIndex(x => x.toLowerCase() === e.toLowerCase()) === i).slice(0, 50);
    if (!recipients.length) continue;
    const name = oneLine(d.name).slice(0, 120) || '—';
    const when = (() => { try { return new Date(d.created_at).toLocaleString(lang === 'en' ? 'en-US' : 'es-UY', { timeZone: d.timezone || 'America/Montevideo', dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(d.created_at || ''); } })();
    const html = `<p>${escHtml(t.intro)}</p>`
      + `<p><b>${escHtml(name)}</b> · ${escHtml(d.role === 'teacher' ? t.teacher : t.student)}<br>${escHtml(t.unit)}: ${escHtml(d.unit_name)}`
      + (d.class_title ? `<br>${escHtml(t.cls)}: ${escHtml(d.class_title)}` : '') + `<br>${escHtml(t.when)}: ${escHtml(when)}</p>`
      + `<blockquote style="border-left:3px solid #7c5cbf;margin:0;padding:6px 12px;white-space:pre-wrap">${escHtml(String(d.reason || '').slice(0, 1000))}</blockquote>`
      + `<p style="color:#666">${escHtml(t.note)}</p><p><a href="${escHtml(origin + '/')}">${escHtml(t.open)}</a></p>`;
    out.push({ from, to: recipients, subject: t.subject(name).slice(0, 250), html });
  }
  return out;
}

async function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: controller.signal }); } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const key = resendKey();
  // No email provider (or no service key to read the admins' emails): nothing is read or sent.
  if (!key || !serviceKey()) return res.status(200).json({ configured: false, sent: 0, message: 'email not configured' });
  const token = bearer(req);
  let user = null;
  try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const lang = b.lang === 'en' ? 'en' : 'es';
  const items = await serviceRpc('consent_decline_notify_payload', { p_user: user.id });
  if (!Array.isArray(items)) return res.status(502).json({ error: 'Could not reach the database.', code: 'upstream' });
  const from = String(process.env.NOTIFY_FROM || 'TeroClass <no-reply@teroclass.com>').slice(0, 200);
  const emails = buildDeclineEmails(items, { lang, origin: appOrigin(req), from });
  let sent = 0; let failed = 0;
  for (const e of emails) {
    try {
      const r = await timedFetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(e) });
      if (r.ok) sent++; else { failed++; console.error(`notify/consent: resend failed (HTTP ${r.status})`); }
    } catch { failed++; console.error('notify/consent: resend failed (network)'); }
  }
  return res.status(200).json({ configured: true, sent, failed });
}
