// Vercel serverless: LiveKit access token for the live classroom.
// - 401 if the Supabase session is missing/invalid (same check as api/generate.js)
// - 501 {configured:false} while LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set
//   (the app then stays in Demo mode and spends nothing)
// - 200 {configured:true, url, token, identity, room, recorded} otherwise
//
// Token format follows LiveKit's AccessToken (HS256 JWT): iss = API key, sub = identity,
// nbf/exp, name, metadata (string) and the "video" grant.
import { livekitEnv, signJwt, getUser, getProfile, bearer, SUPABASE_URL, SUPABASE_KEY } from '../_lib/livekit.js';

export const TOKEN_TTL_S = 2 * 60 * 60;     // a class plus margin
export const CONSENT_VERSION = '2026-10';   // bump when the consent text changes
const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;
const STAFF_ROLES = new Set(['teacher', 'org_admin', 'superadmin']);

// Rooms are created by a teacher as "<ownerKey>-<random>"; only that teacher gets roomAdmin.
// Calendar classes ("sess-<uuid>") are checked against the database (live_room_role). Ad-hoc rooms below:
// only the creating teacher hosts; anyone signed in with the link can join as a student.
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
export const ownerKey = userId => String(userId || '').replace(/-/g, '').slice(0, 12).toLowerCase();

function cleanName(v, fallback) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

export function validateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const room = String(b.room || '');
  if (!ROOM_RE.test(room)) return { error: 'Invalid room name.' };
  const role = b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : null;
  if (!role) return { error: 'Invalid role.' };
  const c = b.consent && typeof b.consent === 'object' ? b.consent : {};
  const minor = b.minor === true;
  const g = b.guardian && typeof b.guardian === 'object' ? b.guardian : null;
  const guardianOk = !!(g && cleanName(g.name, '') && EMAIL_RE.test(String(g.email || '').trim()) && g.consent === true);
  if (minor && (c.recording || c.ai_analysis || c.storage) && !guardianOk) {
    return { error: 'A guardian must consent for participants under 18.' };
  }
  // AI analysis and storage only make sense on top of a recording consent.
  const recording = c.recording === true;
  const consent = { recording, ai_analysis: recording && c.ai_analysis === true, storage: recording && c.storage === true };
  return { room, role, minor, consent, guardianOk, name: b.name };
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

  let isAdmin = false;
  // Calendar classes: room "sess-<session uuid without dashes>". Access is decided by the database
  // (teacher/substitute host, enrolled or invited students join); nobody else gets a token.
  const sessId = sessionIdFromRoom(v.room);
  if (sessId) {
    let role = null;
    try { role = await liveRoomRole(token, sessId); } catch { role = undefined; }
    if (role === undefined) return res.status(503).json({ error: 'Could not check your access to this class. Please try again.', code: 'access_check' });
    if (role === 'teacher') isAdmin = v.role === 'teacher';
    else if (role === 'student') { if (v.role === 'teacher') return res.status(403).json({ error: 'Only the teacher of this class can host it.', code: 'owner' }); }
    else return res.status(403).json({ error: 'You are not part of this class.', code: 'not_member' });
  } else if (v.role === 'teacher') {
    let profile = null;
    try { profile = await getProfile(token, user.id); } catch { profile = null; }
    if (!profile || !STAFF_ROLES.has(profile.role)) return res.status(403).json({ error: 'Only teachers can host a class.', code: 'role' });
    if (!v.room.toLowerCase().startsWith(ownerKey(user.id) + '-')) {
      return res.status(403).json({ error: 'Only the teacher who created this class can host it.', code: 'owner' });
    }
    isAdmin = true;
  }

  const now = Math.floor(Date.now() / 1000);
  const identity = user.id;
  const name = cleanName(v.name, cleanName(user.user_metadata?.name, 'Participant'));
  // Metadata is visible to everyone in the room: flags only, never guardian name/email.
  const recorded = v.consent.recording && (!v.minor || v.guardianOk);
  const metadata = JSON.stringify({
    role: v.role,
    consent: v.consent,
    recorded,
    minor: v.minor,
    guardian_consent: v.minor ? v.guardianOk : null,
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
  // TODO(live): insert session_participants + consents rows (service role) for the audit trail.
  return res.status(200).json({
    configured: true,
    url: env.url,
    token: signJwt(claims, env.apiSecret),
    identity,
    room: v.room,
    recorded,
  });
}
