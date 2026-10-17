// Shared helpers for the live classroom (LiveKit). No npm dependencies: JWTs are
// signed/verified with node:crypto (HS256), exactly as livekit-server-sdk does.
// Files under api/_lib are not deployed as functions (leading underscore).
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ppvqkjchhejjulrdqkdr.supabase.co';
export const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_D4ZATRSmyiURioJ4PvTb4A_rR_urilK';
const SUPABASE_TIMEOUT_MS = 10000;

// The live classroom is "configured" only when all three LiveKit variables exist.
export function livekitEnv() {
  const url = (process.env.LIVEKIT_URL || '').trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || '').trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || '').trim();
  return { url, apiKey, apiSecret, configured: !!(url && apiKey && apiSecret) };
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

// Returns the claims or throws. Checks alg, signature, nbf/exp (with 10 s leeway).
export function verifyJwt(token, secret, { now = Math.floor(Date.now() / 1000), leeway = 10 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString('utf8')); claims = JSON.parse(fromB64url(parts[1]).toString('utf8')); }
  catch { throw new Error('malformed token'); }
  if (header?.alg !== 'HS256') throw new Error('unsupported alg');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = fromB64url(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad signature');
  if (typeof claims.nbf === 'number' && now + leeway < claims.nbf) throw new Error('token not yet valid');
  if (typeof claims.exp === 'number' && now - leeway >= claims.exp) throw new Error('token expired');
  return claims;
}

export const sha256Base64 = body => createHash('sha256').update(body).digest('base64');

// Same approach as api/generate.js: ask Supabase who owns this access token.
export async function supabaseFetch(path, token, ms = SUPABASE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function getUser(token) {
  if (!token) return null;
  const r = await supabaseFetch('/auth/v1/user', token);
  return r.ok && r.data?.id ? r.data : null;
}

// Role from public.profiles (RLS lets each user read their own row).
export async function getProfile(token, userId) {
  const r = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role,institution_id,name`, token);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

export function bearer(req) {
  return String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
}
