// Vercel serverless: e-mails the guardian of a minor the link to confirm (or not) the recording consent (P-10, 2026-10).
// Sends ONLY when RESEND_API_KEY exists; without it the app shows the link for the student to forward (copy / WhatsApp).
//   POST /api/notify/guardian  {lang}     Authorization: Bearer <the minor's own Supabase session token>
// The database returns only the caller's own pending request (guardian_email_payload); max 3 e-mails a day (TC-08).
import { SUPABASE_URL, SUPABASE_KEY, bearer } from '../_lib/livekit.js';
import { appOrigin } from '../_lib/ics.js';
import { resendKey, EMAIL_RE, timedFetch, safeSubjectText, takeQuota, sendEmails, fromAddress, escHtml } from '../_lib/mail.js';

const T = {
  es: { subject: 'TeroClass: confirmá el consentimiento de grabación', hi: n => `Hola${n ? ' ' + n : ''}:`,
        body: s => `${s || 'Una persona menor de 18 años'} te indicó como su madre, padre o tutor/a para autorizar que sus clases en TeroClass se graben (solo audio) y que la IA las analice para generar sus insights.`,
        cta: 'Ver y responder', note: 'Hasta que respondas, sus clases no se graban. Podés cambiar tu respuesta desde el mismo link.' },
  en: { subject: 'TeroClass: please confirm the recording consent', hi: n => `Hi${n ? ' ' + n : ''},`,
        body: s => `${s || 'A person under 18'} named you as their parent or guardian to allow their TeroClass classes to be recorded (audio only) and analysed by AI for their insights.`,
        cta: 'See and answer', note: 'Until you answer, their classes are not recorded. You can change your answer from the same link.' },
};
export const guardianLink = (origin, token) => `${origin}/tutor?t=${encodeURIComponent(String(token || ''))}`;
export function buildGuardianEmail(p, { lang = 'es', origin, from }) {
  const t = T[lang] || T.es;
  if (!p || !EMAIL_RE.test(String(p.guardian_email || '')) || !/^[0-9a-f]{64}$/.test(String(p.token || ''))) return null;
  const html = `<p>${escHtml(t.hi(safeSubjectText(p.guardian_name, 60)))}</p><p>${escHtml(t.body(safeSubjectText(p.student, 60)))}</p>`
    + `<p><a href="${escHtml(guardianLink(origin, p.token))}">${escHtml(t.cta)}</a></p><p style="color:#666">${escHtml(t.note)}</p>`;
  return { from, to: [String(p.guardian_email)], subject: t.subject, html };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const key = resendKey();
  if (!key) return res.status(200).json({ configured: false, sent: 0, message: 'email not configured' });
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const lang = req.body?.lang === 'en' ? 'en' : 'es';
  let payload = null;
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/guardian_email_payload`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r.status === 401) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
    if (!r.ok) return res.status(403).json({ error: 'Not allowed.', code: 'forbidden' });
    payload = await r.json();
  } catch { return res.status(502).json({ error: 'Could not reach the database.', code: 'upstream' }); }
  const email = buildGuardianEmail(payload, { lang, origin: appOrigin(req), from: fromAddress() });
  if (!email) return res.status(200).json({ configured: true, sent: 0, failed: 0 });
  const q = await takeQuota(token, 'guardian', 1);
  if (!q) return res.status(503).json({ configured: true, sent: 0, error: 'Could not check your e-mail limit. Nothing was sent.', code: 'email_quota_check' });
  if (!q.allowed) return res.status(429).json({ configured: true, sent: 0, error: 'You reached the e-mail limit for today. Send the link yourself.', code: 'email_quota', reason: q.reason || null });
  const { sent, failed } = await sendEmails(key, [email]);
  return res.status(200).json({ configured: true, sent, failed });
}
