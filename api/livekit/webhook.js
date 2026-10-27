// Vercel serverless: LiveKit webhook receiver (stub — logs only for now).
// LiveKit signs every webhook: the Authorization header is a JWT signed with the API
// secret (iss = API key) whose "sha256" claim is the base64 SHA-256 of the raw body.
// Configure in LiveKit Cloud → Settings → Webhooks → https://<app>/api/livekit/webhook
import { livekitEnv, verifyJwt, sha256Base64 } from '../_lib/livekit.js';

const MAX_BODY = 256 * 1024;

// The signature covers the exact bytes, so read the raw body. If Vercel's helpers already
// consumed the stream (LiveKit sends Content-Type: application/webhook+json), fall back to
// req.body. If a deploy ever shows "checksum does not match", set NODEJS_HELPERS=0.
export const config = { api: { bodyParser: false } };

export async function readRawBody(req) {
  if (req.readableEnded !== false || typeof req[Symbol.asyncIterator] !== 'function') {
    let b; try { b = req.body; } catch { b = undefined; }
    if (typeof b === 'string') return b;
    if (Buffer.isBuffer(b)) return b.toString('utf8');
    if (b && typeof b === 'object') return JSON.stringify(b);
    return '';
  }
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Returns the parsed event or throws (same checks as livekit-server-sdk WebhookReceiver).
export function verifyWebhook(rawBody, authHeader, { apiKey, apiSecret }) {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('authorization header is empty');
  const claims = verifyJwt(token, apiSecret);
  if (claims.iss !== apiKey) throw new Error('invalid issuer');
  if (!claims.sha256 || claims.sha256 !== sha256Base64(rawBody)) throw new Error('sha256 checksum of body does not match');
  return JSON.parse(rawBody);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const env = livekitEnv();
  if (!env.configured) return res.status(501).json({ configured: false });

  let raw, event;
  try { raw = await readRawBody(req); } catch { return res.status(413).json({ error: 'Body too large' }); }
  try { event = verifyWebhook(raw, req.headers?.authorization, env); }
  catch (e) {
    console.warn('livekit webhook rejected:', e.message);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log('livekit webhook', JSON.stringify({
    event: event.event, room: event.room?.name, participant: event.participant?.identity,
    track: event.track?.sid, id: event.id, createdAt: event.createdAt,
  }));

  switch (event.event) {
    case 'room_started':
      // TODO(live): live_sessions.status = 'live', started_at = now() (service role key).
      break;
    case 'participant_joined':
      // TODO(live): session_participants.joined_at; read consent flags from participant.metadata.
      break;
    case 'track_published':
      // TODO(live): if the participant's metadata says recorded=true and the track is audio,
      // dispatch the recorder worker (Azure Container Apps) to capture this track only.
      break;
    case 'participant_left':
      // TODO(live): session_participants.left_at.
      break;
    case 'room_finished':
      // TODO(live): live_sessions.status = 'processing'; enqueue Azure Speech batch
      // transcription → GPT-4o insights → student_insights / teacher_insights.
      break;
    default:
      break;
  }
  return res.status(200).json({ ok: true });
}
