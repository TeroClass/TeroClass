// Vercel serverless: "Hablar con ventas" (2026-10-21). Stores a sales lead and, when e-mail is configured, tells the owner.
//   POST /api/notify/lead  {lead: {name, institution, role, country, teachers_count, contact_channel, whatsapp, email,
//                           preferred_plan, message, consent, lang}, source, turnstileToken?}
// · Signed in (Authorization: Bearer <Supabase session>): the lead is stored with the person's own session through
//   submit_sales_lead (validated and rate limited per person in the database; no server key needed). Students: refused.
// · Not signed in: ONLY when Cloudflare Turnstile is fully configured on the server (TURNSTILE_SITE_KEY +
//   TURNSTILE_SECRET_KEY) and SUPABASE_SERVICE_ROLE_KEY exists: the token is verified with Cloudflare, then the lead is
//   stored with submit_sales_lead_service (rate limited per IP — an HMAC of it, never the IP — in the database).
//   Otherwise 401 {code:'auth'} and the page asks the person to sign in or create a free account.
// · Per-IP limit for everyone (ip_rate_hit, like /api/generate).
// · E-mail to the owner: only with RESEND_API_KEY and SALES_NOTIFY_EMAIL (never hard-coded). Without them nothing is sent
//   and the lead is only in Plataforma → Pedidos de ventas (with a "new" badge).
// The lead is never echoed back beyond {ok, id}; the owner's address never reaches the browser.
import { getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../livekit.js';
import { serviceKey, serviceRpc } from '../billing.js';
import { resendKey, timedFetch, EMAIL_RE, escHtml, fromAddress, safeSubjectText } from '../mail.js';
import { clientIp, ipKey, memRateHit } from '../guard.js';
import { appOrigin } from '../ics.js';

const SOURCES = new Set(['popup_gen2', 'popup_gen4', 'paywall', 'plans_page', 'plan_usage']);
const FIELDS = ['name', 'institution', 'role', 'country', 'teachers_count', 'contact_channel', 'whatsapp', 'email', 'preferred_plan', 'message', 'lang'];

export function salesNotifyEmail(env = process.env) {
  const e = String(env.SALES_NOTIFY_EMAIL || '').trim();
  return EMAIL_RE.test(e) ? e : null;
}
export function turnstileSecret(env = process.env) { return String(env.TURNSTILE_SECRET_KEY || '').trim() || null; }
// Anonymous leads need the whole chain: the public site key (to show the check), the secret (to verify it) and the
// server key (to store the lead without a session).
export function anonLeadsEnabled(env = process.env) {
  return !!(String(env.TURNSTILE_SITE_KEY || '').trim() && turnstileSecret(env) && String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
}

// Only the known fields, as strings (the database validates and cleans them again)
export function pickLead(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of FIELDS) if (typeof b[f] === 'string') out[f] = b[f].slice(0, f === 'message' ? 1200 : 300);
  out.consent = b.consent === true;
  return out;
}

const ROLE = { direccion: ['Dirección', 'Leadership'], coordinacion: ['Coordinación académica', 'Academic coordination'], docente: ['Docente', 'Teacher'],
  administracion: ['Administración', 'Administration'], otro: ['Otro', 'Other'] };
const PLAN = { docente: 'Docente', institucion: 'Institución', institucion_plus: 'Institución+', unsure: '—' };
const SRC = { popup_gen2: 'Pop-up (2ª clase)', popup_gen4: 'Recordatorio (4ª clase)', paywall: 'Límite de la prueba', plans_page: 'Página de planes', plan_usage: 'Plan y consumo', other: 'Otro' };

// The e-mail to the owner (always in Spanish: it is for the TeroClass team). Everything the person typed is escaped,
// and the subject keeps only safe text (no links / addresses).
export function buildLeadEmail(lead, { origin, from, to, account }) {
  const name = safeSubjectText(lead.name, 50) || '—';
  const inst = safeSubjectText(lead.institution, 60) || '—';
  const row = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#666">${escHtml(k)}</td><td style="padding:3px 0"><b>${escHtml(v)}</b></td></tr>`;
  const wa = lead.whatsapp ? `${lead.whatsapp}${lead.contact_channel === 'whatsapp' ? ' (prefiere WhatsApp)' : ''}` : '—';
  const html = `<p>Nuevo pedido de <b>Hablar con ventas</b> en TeroClass.</p><table style="border-collapse:collapse;font-size:14px">`
    + row('Nombre', lead.name) + row('Institución', lead.institution) + row('Rol', (ROLE[lead.role] || ['—'])[0]) + row('País', lead.country)
    + row('Docentes', lead.teachers_count) + row('Plan', PLAN[lead.preferred_plan] || '—') + row('Email', lead.email + (lead.contact_channel === 'email' ? ' (prefiere email)' : ''))
    + row('WhatsApp', wa) + row('Origen', SRC[lead.source] || lead.source || '—') + row('Cuenta', account || 'sin sesión (verificado con Turnstile)')
    + `</table>` + (lead.message ? `<blockquote style="border-left:3px solid #7c5cbf;margin:12px 0;padding:6px 12px;white-space:pre-wrap">${escHtml(String(lead.message).slice(0, 1000))}</blockquote>` : '')
    + `<p><a href="${escHtml(origin + '/')}">Ver en TeroClass → Plataforma → Pedidos de ventas</a></p>`;
  return { from, to: [to], subject: `Nuevo pedido de ventas: ${name} · ${inst}`.slice(0, 200), html, ...(EMAIL_RE.test(lead.email) ? { reply_to: lead.email } : {}) };
}

async function userRpc(fn, token, body) {
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

export async function verifyTurnstile(token, ip, secret = turnstileSecret()) {
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, ...(ip && ip !== 'unknown' ? { remoteip: ip } : {}) });
    const r = await timedFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 8000);
    const d = await r.json().catch(() => null);
    return !!d?.success;
  } catch { return false; }
}

// Database messages → a code the page can show in both languages
function dbError(data) {
  const m = String(data?.message || '');
  if (/Demasiados pedidos/.test(m)) return { status: 429, code: 'rate', error: 'Too many requests in a row. Please try again later.' };
  if (/consentimiento/.test(m)) return { status: 400, code: 'consent', error: 'Please agree to be contacted.' };
  const f = /Pedido inválido: (\w+)/.exec(m);
  if (f) return { status: 400, code: 'invalid', field: f[1], error: 'Check the highlighted field.' };
  if (/No autorizado/.test(m)) return { status: 403, code: 'forbidden', error: 'This account cannot send a sales request.' };
  return { status: 502, code: 'upstream', error: 'Could not save your request. Please try again.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const lead = pickLead(b.lead);
  const source = SOURCES.has(b.source) ? b.source : 'other';
  const ip = clientIp(req);
  const secret = process.env.RATE_LIMIT_SECRET || process.env.AZURE_OPENAI_API_KEY || '';
  const key = ipKey('lead', ip, secret);
  if (!memRateHit(key, 20, 3600000)) return res.status(429).json({ code: 'rate', error: 'Too many requests in a row. Please try again later.' });

  const token = bearer(req);
  let user = null;
  if (token) { try { user = await getUser(token); } catch { user = null; } }
  let saved; let account = null;
  if (user?.id) {
    const ipOk = await userRpc('ip_rate_hit', token, { p_key: key, p_limit: 20, p_window_s: 3600 });
    if (ipOk.ok && ipOk.data === false) return res.status(429).json({ code: 'rate', error: 'Too many requests in a row. Please try again later.' });
    const r = await userRpc('submit_sales_lead', token, { p_lead: lead, p_source: source });
    if (!r.ok || !r.data?.id) { const e = dbError(r.data); return res.status(e.status).json(e); }
    saved = r.data; account = user.email || null;
  } else {
    if (!anonLeadsEnabled()) return res.status(401).json({ code: 'auth', error: 'Please sign in (or create a free account) to contact sales.' });
    if (!(await verifyTurnstile(b.turnstileToken, ip))) return res.status(400).json({ code: 'captcha', error: 'Please complete the security check.' });
    const r = await serviceRpc('submit_sales_lead_service', { p_lead: lead, p_source: source, p_ip_key: key });
    if (!r?.id) return res.status(502).json({ code: 'upstream', error: 'Could not save your request. Please try again.' });
    saved = r;
  }

  // Tell the owner (best effort: the lead is already stored)
  let emailed = false;
  const rk = resendKey(); const to = salesNotifyEmail();
  if (rk && to) {
    try {
      const mail = buildLeadEmail(saved, { origin: appOrigin(req), from: fromAddress(), to, account });
      const r = await timedFetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${rk}`, 'Content-Type': 'application/json' }, body: JSON.stringify(mail) });
      emailed = r.ok;
      if (!r.ok) console.error(`notify/lead: resend failed (HTTP ${r.status})`);
    } catch { console.error('notify/lead: resend failed (network)'); }
    if (emailed) {
      if (user?.id) await userRpc('sales_lead_notified', token, { p_id: saved.id });
      else if (serviceKey()) await serviceRpc('sales_lead_notified_service', { p_id: saved.id });
    }
  }
  return res.status(200).json({ ok: true, id: saved.id, emailed });
}
