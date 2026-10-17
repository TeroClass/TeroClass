// Vercel serverless: LiveKit access token for the live classroom.
// - 401 if the Supabase session is missing/invalid (same check as api/generate.js)
// - 501 {configured:false} while LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set
//   (the app then stays in Demo mode and spends nothing)
// - 200 {configured:true, url, token, identity, room, recorded} otherwise
//
// Token format follows LiveKit's AccessToken (HS256 JWT): iss = API key, sub = identity,
// nbf/exp, name, metadata (string) and the "video" grant.
import { livekitEnv, signJwt, getUser, getProfile, bearer } from '../_lib/livekit.js';

export const TOKEN_TTL_S = 2 * 60 * 60;     // a class plus margin
export const CONSENT_VERSION = '2026-10';   // bump when the consent text changes
const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;
const STAFF_ROLES = new Set(['teacher', 'org_admin', 'superadmin']);

// Rooms are created by a teacher as "<ownerKey>-<random>"; only that teacher gets roomAdmin.
// TODO(live): once supabase/migrations/002_live_class.sql runs, look the room up in
// live_sessions (livekit_room → teacher_id, enrolled session_participants) instead.
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
  if (v.role === 'teacher') {
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
