// Vercel serverless: LiveKit webhook receiver.
// LiveKit signs every webhook: the Authorization header is a JWT signed with the API
// secret (iss = API key) whose "sha256" claim is the base64 SHA-256 of the raw body.
// Configure in LiveKit Cloud → Settings → Webhooks → https://teroclass.com/api/livekit/webhook
// RECORDING (api/_lib/rec/pipeline.js), only while the pipeline is configured (api/_lib/rec/env.js; otherwise it only logs):
//   room_started → the call is live · track_published (microphone) → consent re-checked IN THE DATABASE → Track Egress (audio
//   only) straight to Azure Blob · egress_ended → the recording is stored (30-day retention) · room_finished → "processing"
//   and a first, short processing attempt (transcription jobs). Every step is idempotent: a 503 makes LiveKit retry.
import { livekitEnv, verifyJwt, sha256Base64 } from '../_lib/livekit.js';
import { recordingEnv } from '../_lib/rec/env.js';
import * as pipeline from '../_lib/rec/pipeline.js';

// time the webhook spends on processing after room_finished / egress_ended (the cron and the app do the rest)
const WEBHOOK_PROCESS_MS = 8000;

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

  const rec = recordingEnv();
  if (!rec.configured) return res.status(200).json({ ok: true, recording: false });
  let out = { ok: true };
  try {
    switch (event.event) {
      case 'room_started': out = await pipeline.onRoomStarted(rec, event); break;
      case 'track_published': out = await pipeline.onTrackPublished(rec, event); break;
      case 'egress_ended': out = await pipeline.onEgressEnded(rec, event, WEBHOOK_PROCESS_MS); break;
      case 'room_finished': out = await pipeline.onRoomFinished(rec, event, WEBHOOK_PROCESS_MS); break;
      default: break; // participant_joined / left, egress_started / updated, track_unpublished: nothing to do
    }
  } catch (e) {
    console.error('livekit webhook: recording step failed', e?.message || e);
    out = { ok: false, retry: true };
  }
  if (out && out.retry) return res.status(503).json({ ok: false, retry: true });
  return res.status(200).json({ ok: true, ...(out && out.record !== undefined ? { record: out.record } : {}) });
}
