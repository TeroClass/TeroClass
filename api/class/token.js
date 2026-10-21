// Vercel serverless: LiveKit access token for the live classroom.
// - 401 if the Supabase session is missing/invalid (same check as api/generate.js)
// - 501 {configured:false} while LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set
//   (the app then stays in Demo mode and spends nothing)
// - 200 {configured:true, url, token, identity, room, recorded} otherwise
//
// Recording consent is NEVER taken from the request body: it is read from the database with the caller's own
// session (my_consent(), 001_base.sql: one checkbox per person, minors need a guardian). recorded / consent /
// minor / guardian_consent in the token metadata come only from there; if it can't be read, the person joins
// NOT recorded (fail closed). Guardian name/email never go into the metadata (everyone in the room can read it).
//
// Token format follows LiveKit's AccessToken (HS256 JWT): iss = API key, sub = identity,
// nbf/exp, name, metadata (string) and the "video" grant.
import { livekitEnv, signJwt, getUser, getProfile, bearer, SUPABASE_URL, SUPABASE_KEY } from '../_lib/livekit.js';
import { verifyTicket } from './ticket.js';

export const TOKEN_TTL_S = 2 * 60 * 60;     // a class plus margin
// = tc_consent_version() in 001_base.sql and CONSENT_VERSION in public/live-class.js (tests/api-consent.test.mjs checks
// they match). Bump all three when the consent text changes: everyone is asked again.
export const CONSENT_VERSION = '2026-10';
const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;
const STAFF_ROLES = new Set(['teacher', 'org_admin', 'superadmin']);

// Rooms are created by a teacher as "<ownerKey>-<random>"; only that teacher gets roomAdmin.
// Calendar classes ("sess-<uuid>") are checked against the database (live_room_role). Ad-hoc rooms (TC-13, 2026-10):
// the database decides (adhoc_room_access): the creating teacher hosts; staff (teachers / admins) of the SAME account
// (main institution) can join as participants; students and accounts without an institution cannot — their classes
// go through the calendar — or with an invitation ticket the creating teacher shared (api/class/ticket.js), never just by
// being signed in. The display name is decided by the database too (live_display_name, TC-27), never the body.
// P-09: the ROLE is decided here too (host of the room / teacher of the class → teacher; everyone else → student); a body
// asking for "teacher" without being the host is refused, and the answer says which role was given.
// "sess-" + 32 hex chars (uuid without dashes) → uuid, or null for ad-hoc rooms.
export function sessionIdFromRoom(room) {
  const m = /^sess-([0-9a-f]{32})$/i.exec(String(room || ''));
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// The caller's role in a calendar class, asked with THEIR session (RLS-safe). undefined = could not check.
async function liveRoomRole(token, sessionId) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/live_room_role`, {
      method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session: sessionId }),
    });
    if (!r.ok) return undefined;
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { return undefined; }
    return typeof d === 'string' ? d : null;
  } finally { clearTimeout(timer); }
}
// The caller's recording consent, read with THEIR session. null = could not be read (→ not recorded).
export async function myConsent(token) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_consent`, {
      method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) return null;
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { return null; }
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
    return d && typeof d === 'object' ? d : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
// Token metadata flags from the database answer only. A consent given to another text version does not count.
export function consentFlags(c) {
  const ok = !!(c && c.granted === true && c.current_version === CONSENT_VERSION && c.version === CONSENT_VERSION);
  const minor = !!(c && c.minor === true);
  const guardianOk = minor && c.guardian_consent === true;
  const recorded = ok && c.recorded === true && (!minor || guardianOk);
  return { recorded, minor: ok ? minor : false, guardianOk: ok ? guardianOk : false,
    consent: { recording: recorded, ai_analysis: recorded, storage: recorded } };
}
export const ownerKey = userId => String(userId || '').replace(/-/g, '').slice(0, 12).toLowerCase();
// Ask one function with the caller's own session. undefined = could not check (network / old database).
async function userRpcValue(token, fn, body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) return undefined;
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { return undefined; }
    return d;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

function cleanName(v, fallback) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

export function validateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const room = String(b.room || '');
  if (!ROOM_RE.test(room)) return { error: 'Invalid room name.' };
  // role: optional wish (the server decides, P-09); anything else than teacher / student is refused
  const role = b.role == null || b.role === '' ? null : b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : undefined;
  if (role === undefined) return { error: 'Invalid role.' };
  // consent / minor / guardian fields in the body are ignored on purpose (see myConsent)
  return { room, role, name: b.name, ...(typeof b.ticket === 'string' ? { ticket: b.ticket } : {}) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = bearer(req);
  let user;
  try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });

  const env = livekitEnv();
  if (!env.configured) return res.status(501).json({ configured: false, error: 'The live classroom is not connected yet.' });

  const v = validateBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, code: 'invalid' });

  let isAdmin = false; let role = 'student';
  // Calendar classes: room "sess-<session uuid without dashes>". Access is decided by the database
  // (teacher/substitute host, enrolled or invited students join); nobody else gets a token.
  const sessId = sessionIdFromRoom(v.room);
  if (sessId) {
    role = null;
    try { role = await liveRoomRole(token, sessId); } catch { role = undefined; }
    if (role === undefined) return res.status(503).json({ error: 'Could not check your access to this class. Please try again.', code: 'access_check' });
    if (role === 'teacher') { isAdmin = true; }
    else if (role === 'student') { if (v.role === 'teacher') return res.status(403).json({ error: 'Only the teacher of this class can host it.', code: 'owner' }); }
    else return res.status(403).json({ error: 'You are not part of this class.', code: 'not_member' });
  } else {
    // ad-hoc room "<ownerKey>-<…>": host = its creator; guests = staff of the creator's account (database decides)
    const key = /^([0-9a-f]{12})-/i.exec(v.room);
    if (!key) return res.status(403).json({ error: 'You are not part of this class.', code: 'not_member' });
    const access = await userRpcValue(token, 'adhoc_room_access', { p_owner_key: key[1].toLowerCase() });
    if (access === undefined) return res.status(503).json({ error: 'Could not check your access to this class. Please try again.', code: 'access_check' });
    if (access === 'host') { isAdmin = true; role = 'teacher'; }
    else if (access === 'guest') { if (v.role === 'teacher') return res.status(403).json({ error: 'Only the teacher who created this class can host it.', code: 'owner' }); }
    else if (v.ticket && v.role !== 'teacher' && verifyTicket(v.ticket, v.room)) { role = 'student'; } // invited by the room's creator
    else if (v.ticket && v.role !== 'teacher') return res.status(403).json({ error: 'This invitation link expired or is not valid. Ask your teacher for a new one.', code: 'ticket' });
    else if (v.role === 'teacher') {
      let profile = null;
      try { profile = await getProfile(token, user.id); } catch { profile = null; }
      if (!profile || !STAFF_ROLES.has(profile.role)) return res.status(403).json({ error: 'Only teachers can host a class.', code: 'role' });
      return res.status(403).json({ error: 'Only the teacher who created this class can host it.', code: 'owner' });
    } else return res.status(403).json({ error: 'You need the invitation link from your teacher to join this class. Your scheduled classes are in the calendar.', code: 'not_member' });
  }

  const now = Math.floor(Date.now() / 1000);
  const identity = user.id;
  // TC-27: the name everyone sees comes from the database (the name the institution loaded, or the profile)
  const dbName = await userRpcValue(token, 'live_display_name', { p_session: sessId || null });
  const name = cleanName(typeof dbName === 'string' ? dbName : '', cleanName(user.user_metadata?.name, 'Participant'));
  // Consent from the database (never from the body). Metadata is visible to everyone in the room: flags only.
  const f = consentFlags(await myConsent(token));
  const recorded = f.recorded;
  const metadata = JSON.stringify({
    role,
    consent: f.consent,
    recorded,
    minor: f.minor,
    guardian_consent: f.minor ? f.guardianOk : null,
    consent_version: CONSENT_VERSION,
  });
  const claims = {
    iss: env.apiKey,
    sub: identity,
    jti: identity,
    name,
    nbf: now,
    exp: now + TOKEN_TTL_S,
    metadata,
    video: {
      room: v.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ...(isAdmin ? { roomAdmin: true } : {}),
    },
  };
  // TODO(live): insert session_participants + consents rows (service role, copied from user_consents) for the audit trail.
  return res.status(200).json({
    configured: true,
    url: env.url,
    token: signJwt(claims, env.apiSecret),
    identity,
    room: v.room,
    role,
    recorded,
  });
}
