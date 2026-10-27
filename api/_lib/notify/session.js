// Vercel serverless: email the students of a session (invitation with the event attached, update or
// cancellation). "Dummy feature" like the live class: it sends through Resend ONLY when RESEND_API_KEY is set
// in Vercel. Without it, it is a no-op that answers {configured:false} and the app offers
// "Copy invitation link" instead. The key never leaves the server.
//   POST /api/notify/session  {session_id, kind: 'invite'|'update'|'cancel', lang: 'es'|'en'}
//   Authorization: Bearer <the teacher's Supabase session token>
// Who may notify, and to whom, is decided by the database (session_notify_payload: only the session's
// teacher / substitute / creator, recipients = its students), called with the caller's own token.
// TC-08 (2026-10): before anything is sent the database grants the teacher's daily e-mail quota (email_quota_take;
// fail closed), at most 100 recipients per send, and the class title is cleaned before it goes into the subject
// (one line, no links or addresses, 60 characters). Only people the institution loaded (or who already signed in) are
// e-mailed; addresses a teacher typed for a one-off class are "skipped" (the app offers the link to share).
import { SUPABASE_URL, SUPABASE_KEY, bearer } from '../livekit.js';
import { buildCalendar, appOrigin, isUuid } from '../ics.js';
import { resendKey, EMAIL_RE, timedFetch, safeSubjectText, takeQuota, sendEmails, fromAddress, escHtml } from '../mail.js';

export { resendKey };
const KINDS = new Set(['invite', 'update', 'cancel']);
export const MAX_RECIPIENTS = 100;

const T = {
  es: { invite: 'Invitación', update: 'Clase actualizada', cancel: 'Clase cancelada', join: 'Entrar a la clase',
        intro: { invite: 'Tenés una clase en TeroClass.', update: 'Cambió una de tus clases en TeroClass.', cancel: 'Se canceló una de tus clases en TeroClass.' },
        when: 'Cuándo', ics: 'El evento va adjunto: abrilo para sumarlo a tu calendario.' },
  en: { invite: 'Invitation', update: 'Class updated', cancel: 'Class cancelled', join: 'Join the class',
        intro: { invite: 'You have a class on TeroClass.', update: 'One of your classes on TeroClass changed.', cancel: 'One of your classes on TeroClass was cancelled.' },
        when: 'When', ics: 'The event is attached: open it to add it to your calendar.' },
};

export function buildEmails(p, { kind, lang, origin, from }) {
  const t = T[lang] || T.es;
  const when = (() => { try { return new Date(p.starts_at).toLocaleString(lang === 'en' ? 'en-US' : 'es-UY', { timeZone: p.timezone || 'America/Montevideo', dateStyle: 'full', timeStyle: 'short' }) + ` (${p.timezone || 'America/Montevideo'})`; } catch { return String(p.starts_at); } })();
  const title = safeSubjectText(p.title || p.group_name || 'Class', 120) || 'TeroClass';
  const ics = buildCalendar([p], { method: kind === 'cancel' ? 'CANCEL' : 'REQUEST', origin, name: 'TeroClass' });
  const link = `${origin}/?session=${p.id}`;
  const subject = `${t[kind]}: ${safeSubjectText(title, 60)} · ${when}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const html = `<p>${escHtml(t.intro[kind])}</p><p><b>${escHtml(title)}</b>${p.group_name ? ` · ${escHtml(safeSubjectText(p.group_name, 80))}` : ''}<br>${escHtml(t.when)}: ${escHtml(when)}</p>`
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

  const emails = buildEmails(payload, { kind: b.kind, lang, origin: appOrigin(req), from: fromAddress() });
  // TC-08: addresses a teacher typed for a one-off class (not loaded by the institution, never signed in) are skipped
  const skipped = Number(payload.skipped) || 0;
  if (!emails.length) return res.status(200).json({ configured: true, sent: 0, failed: 0, skipped });
  const q = await takeQuota(token, 'session', emails.length);
  if (!q) return res.status(503).json({ configured: true, sent: 0, error: 'Could not check your e-mail limit. Nothing was sent.', code: 'email_quota_check' });
  if (!q.allowed) return res.status(429).json({ configured: true, sent: 0, error: 'You reached the e-mail limit for today. Share the class link instead.', code: 'email_quota', reason: q.reason || null });
  const { sent, failed } = await sendEmails(key, emails);
  return res.status(200).json({ configured: true, sent, failed, skipped });
}
