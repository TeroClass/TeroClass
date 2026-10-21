// Vercel serverless: invitation ticket for an ad-hoc live room (TC-13, 2026-10).
//   POST /api/class/ticket  {room}   Authorization: Bearer <the host teacher's Supabase session>
//   → 200 {ticket, expires_at, link}  ·  401 no session  ·  403 not the room's creator  ·  501 live classroom not connected
//
// Ad-hoc rooms ("<ownerKey>-<random>", started with "▶ Start live class" outside the calendar) are not in the database.
// Being signed in is NOT enough to join one: the teacher who created it shares a link with a short-lived signed ticket
// (HS256, a secret derived from LIVEKIT_API_SECRET, or ROOM_TICKET_SECRET), and api/class/token.js lets a student in only
// with a valid ticket for THAT room. Staff of the same account still join without one (adhoc_room_access 'guest').
// Classes of the calendar never use tickets: the database decides who is in them (live_room_role).
import { createHmac } from 'node:crypto';
import { livekitEnv, signJwt, verifyJwt, getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../_lib/livekit.js';

export const TICKET_TTL_S = 6 * 60 * 60;   // a class day; the teacher can always make a new link
const ROOM_RE = /^([0-9a-f]{12})-[A-Za-z0-9_-]{1,51}$/;

function ticketSecret() {
  const own = (process.env.ROOM_TICKET_SECRET || '').trim();
  if (own) return own;
  const lk = livekitEnv();
  return lk.apiSecret ? createHmac('sha256', lk.apiSecret).update('teroclass-room-ticket-v1').digest('hex') : '';
}
export function signTicket(room, ownerKey, { now = Math.floor(Date.now() / 1000), ttl = TICKET_TTL_S } = {}) {
  const secret = ticketSecret(); if (!secret) return null;
  return signJwt({ typ: 'room-ticket', room, by: ownerKey, nbf: now, exp: now + ttl }, secret);
}
// → true only for a valid, unexpired ticket of exactly this room
export function verifyTicket(ticket, room) {
  const secret = ticketSecret(); if (!secret || !ticket || typeof ticket !== 'string' || ticket.length > 1000) return false;
  try {
    const c = verifyJwt(ticket, secret, { leeway: 0 });
    return c.typ === 'room-ticket' && c.room === room && typeof c.exp === 'number';
  } catch { return false; }
}

async function adhocAccess(token, ownerKey) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/adhoc_room_access`, { method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_owner_key: ownerKey }) });
    if (!r.ok) return undefined;
    const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return undefined; }
  } catch { return undefined; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = bearer(req);
  let user; try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  if (!livekitEnv().configured) return res.status(501).json({ configured: false, error: 'The live classroom is not connected yet.' });
  const room = String(req.body?.room || '');
  const m = ROOM_RE.exec(room);
  if (!m) return res.status(400).json({ error: 'Invalid room name.', code: 'invalid' });
  const access = await adhocAccess(token, m[1]);
  if (access === undefined) return res.status(503).json({ error: 'Could not check your access to this class. Please try again.', code: 'access_check' });
  if (access !== 'host') return res.status(403).json({ error: 'Only the teacher who created this class can invite students.', code: 'owner' });
  const ticket = signTicket(room, m[1]);
  if (!ticket) return res.status(501).json({ configured: false, error: 'The live classroom is not connected yet.' });
  const origin = (process.env.APP_URL || '').replace(/\/+$/, '') || `https://${req.headers['x-forwarded-host'] || req.headers.host || 'teroclass.com'}`;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ticket, expires_at: new Date((Math.floor(Date.now() / 1000) + TICKET_TTL_S) * 1000).toISOString(),
    link: `${origin}/?room=${encodeURIComponent(room)}&t=${encodeURIComponent(ticket)}` });
}
