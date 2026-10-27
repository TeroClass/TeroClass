// Vercel serverless: personal calendar subscription feed (Google Calendar, Outlook, Apple Calendar).
//   GET /api/calendar/feed?token=<64 hex>   (also /cal/<token>.ics, see vercel.json)
// The token is random, per user and rotatable (my_calendar_token). The database function calendar_feed is
// called with the PUBLISHABLE key: it returns only the sessions of the token's owner (no emails, no other
// students' data). Unknown token → an empty calendar; malformed token → 404 (the database is not called).
import { SUPABASE_URL, SUPABASE_KEY } from '../_lib/livekit.js';
import { buildCalendar, appOrigin } from '../_lib/ics.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 8000;

export function tokenFrom(req) {
  let t = req?.query?.token;
  if (Array.isArray(t)) t = t[0];
  if (!t) { try { t = new URL(req?.url || '', 'http://x').searchParams.get('token'); } catch { t = ''; } }
  return String(t || '').trim().toLowerCase().replace(/\.ics$/, '');
}

async function feedRows(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/calendar_feed`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }), signal: controller.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? data : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function send(res, status, body, type) {
  res.statusCode = status;
  if (type) res.setHeader('Content-Type', type);
  if (typeof res.status === 'function' && typeof res.send === 'function') return res.status(status).send(body);
  return res.end(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Robots-Tag', 'noindex');
  const token = tokenFrom(req);
  if (!TOKEN_RE.test(token)) return send(res, 404, 'Calendar not found', 'text/plain; charset=utf-8');
  const rows = await feedRows(token);
  if (!rows) return send(res, 502, 'Calendar temporarily unavailable', 'text/plain; charset=utf-8');
  const ics = buildCalendar(rows, { name: 'TeroClass', origin: appOrigin(req) });
  res.setHeader('Content-Disposition', 'inline; filename="teroclass.ics"');
  return send(res, 200, req.method === 'HEAD' ? '' : ics, 'text/calendar; charset=utf-8');
}
