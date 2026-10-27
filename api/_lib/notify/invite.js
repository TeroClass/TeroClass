// Vercel serverless: e-mails an invitation (P-03, 2026-10). Like the class e-mails it sends ONLY when RESEND_API_KEY exists;
// without it the answer is {configured:false} and the app shows the invitation link to copy or share by WhatsApp —
// it never promises an e-mail that doesn't exist.
//   POST /api/notify/invite  {invitation_id, lang: 'es'|'en'}     Authorization: Bearer <the admin's Supabase session token>
// Who may send it is decided by the database (invitation_notify_payload: only admins of that unit, only a pending
// invitation), with the admin's own token. The daily e-mail quota is taken first (TC-08, email_quota_take; fail closed).
import { SUPABASE_URL, SUPABASE_KEY, bearer } from '../livekit.js';
import { appOrigin, isUuid } from '../ics.js';
import { resendKey, EMAIL_RE, timedFetch, safeSubjectText, takeQuota, sendEmails, fromAddress, escHtml } from '../mail.js';

const T = {
  es: { subject: u => `Te invitaron a ${u} en TeroClass`, hi: 'Hola:', body: (who, u, role) => `${who} te invitó a sumarte a ${u} en TeroClass como ${role}.`,
        teacher: 'docente', org_admin: 'admin de la institución', cta: 'Aceptar la invitación',
        newAcc: 'Creá tu cuenta con este mismo email desde el link.', hasAcc: 'Ingresá con tu cuenta: vas a ver la invitación para aceptarla o rechazarla.',
        expires: d => `La invitación vence el ${d}.`, ignore: 'Si no esperabas este email, podés ignorarlo.' },
  en: { subject: u => `You were invited to ${u} on TeroClass`, hi: 'Hi,', body: (who, u, role) => `${who} invited you to join ${u} on TeroClass as ${role}.`,
        teacher: 'a teacher', org_admin: 'an institution admin', cta: 'Accept the invitation',
        newAcc: 'Create your account with this same e-mail from the link.', hasAcc: 'Sign in with your account: you will see the invitation to accept or decline it.',
        expires: d => `The invitation expires on ${d}.`, ignore: "If you weren't expecting this e-mail, you can ignore it." },
};

// The link the invited person opens (also shown in the app when there is no e-mail provider)
export function inviteLink(origin, p) {
  if (p.has_account) return `${origin}/?invitations`;
  const slug = /^[a-z0-9-]{2,60}$/.test(String(p.unit_slug || '')) ? p.unit_slug : '';
  return `${origin}${slug ? `/org/${slug}` : '/'}?invite=${encodeURIComponent(String(p.email || ''))}`;
}
export function buildInviteEmail(p, { lang = 'es', origin, from }) {
  const t = T[lang] || T.es;
  if (!EMAIL_RE.test(String(p.email || ''))) return null;
  const unit = safeSubjectText(p.unit_name, 60) || 'TeroClass';
  const who = safeSubjectText(p.inviter, 60) || 'TeroClass';
  const link = inviteLink(origin, p);
  let exp = ''; try { exp = new Date(p.expires_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'es-UY', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { exp = ''; }
  const html = `<p>${escHtml(t.hi)}</p><p>${escHtml(t.body(who, unit, t[p.role === 'org_admin' ? 'org_admin' : 'teacher']))}</p>`
    + `<p><a href="${escHtml(link)}">${escHtml(t.cta)}</a></p><p>${escHtml(p.has_account ? t.hasAcc : t.newAcc)}</p>`
    + (exp ? `<p style="color:#666">${escHtml(t.expires(exp))}</p>` : '') + `<p style="color:#888">${escHtml(t.ignore)}</p>`;
  return { from, to: [String(p.email)], subject: t.subject(unit).slice(0, 200), html };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const key = resendKey();
  if (!key) return res.status(200).json({ configured: false, sent: 0, message: 'email not configured' });
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isUuid(b.invitation_id)) return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const lang = b.lang === 'en' ? 'en' : 'es';
  let payload = null;
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/invitation_notify_payload`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: b.invitation_id }),
    });
    if (r.status === 401) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
    if (!r.ok) return res.status(403).json({ error: 'Not allowed.', code: 'forbidden' });
    payload = await r.json();
  } catch { return res.status(502).json({ error: 'Could not reach the database.', code: 'upstream' }); }
  const email = payload && buildInviteEmail(payload, { lang, origin: appOrigin(req), from: fromAddress() });
  if (!email) return res.status(200).json({ configured: true, sent: 0, failed: 0 });
  const q = await takeQuota(token, 'invite', 1);
  if (!q) return res.status(503).json({ configured: true, sent: 0, error: 'Could not check your e-mail limit. Nothing was sent.', code: 'email_quota_check' });
  if (!q.allowed) return res.status(429).json({ configured: true, sent: 0, error: 'You reached the e-mail limit for today. Share the invitation link instead.', code: 'email_quota', reason: q.reason || null });
  const { sent, failed } = await sendEmails(key, [email]);
  return res.status(200).json({ configured: true, sent, failed });
}
