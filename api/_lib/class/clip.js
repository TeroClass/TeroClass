// Vercel serverless (via api/class.js): "listen to how you said it in class" (student pronunciation, 2026-11-13).
//   POST /api/class/clip {insight: <student_insights id>, start_ms, end_ms}   Authorization: Bearer <Supabase session>
//   → 200 {url, from_s, to_s}: a READ-ONLY link (10 minutes) to that student's own microphone track + where to play
//     · 404 when the audio is gone (30-day retention) or there is no recording · 403 not the student nor someone who sees the class
// The database decides who may listen (rec_clip_source with the caller's own session); the server only signs the link.
import { getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../livekit.js';
import { recordingEnv } from '../rec/env.js';
import { blobSasUrl } from '../rec/azure.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLIP_MS = 20000;

export async function clipSource(token, insight, ms) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rec_clip_source`, { method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_insight: insight, p_ms: ms }) });
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = null; }
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (!r.ok) return { status: /autorizado/i.test(String(d?.message || '')) ? 403 : 503 };
    return { status: 200, data: d && typeof d === 'object' ? d : null };
  } catch { return { status: 503 }; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = bearer(req);
  let user; try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const env = recordingEnv();
  if (!env.configured) return res.status(501).json({ configured: false });
  const b = req.body || {};
  const insight = String(b.insight || '');
  const start = Math.round(Number(b.start_ms)); const end = Math.round(Number(b.end_ms));
  if (!UUID.test(insight) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const src = await clipSource(token, insight.toLowerCase(), start);
  if (src.status === 403) return res.status(403).json({ error: 'You cannot listen to this recording.', code: 'not_allowed' });
  if (src.status !== 200) return res.status(503).json({ error: 'Please try again.', code: 'upstream' });
  const path = src.data?.storage_path;
  if (!path || !/^[A-Za-z0-9/_.-]{1,500}$/.test(path)) return res.status(404).json({ error: 'The class audio is no longer available.', code: 'gone' });
  const fromMs = Math.max(0, Number(src.data.from_ms) || 0);
  const len = Math.min(MAX_CLIP_MS, end - start);
  return res.status(200).json({ url: blobSasUrl(env.storage, path, { perm: 'r', ttlS: 600 }), from_s: fromMs / 1000, to_s: (fromMs + len) / 1000 });
}
