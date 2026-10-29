// Vercel serverless (via api/class.js): advance the recording pipeline. Idempotent; bounded work per call (< 50 s).
//   GET  /api/class/process   Authorization: Bearer <CRON_SECRET>   ← the daily Vercel cron (vercel.json "crons")
//        → deletes the audio past its 30 days (retention), then advances every class still "processing".
//   POST /api/class/process {session: <class id>}   Authorization: Bearer <Supabase session>
//        ← the app, while someone who can see that class (its teacher / substitute, its admins, or one of its students) has
//          its Insights open in "processing" (it polls every ~20 s). Advances ONLY that class.
//        → 200 {state: none | live | processing | ready | ended, step?, recordings, transcribed}
// 501 {configured:false} while the pipeline is off (RECORDING_ENABLED + every key: see api/_lib/rec/env.js).
import { getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../livekit.js';
import { recordingEnv, cronAuthorized } from '../rec/env.js';
import { processSession, processAll, runRetention, deadline, kick, MAX_KICKS } from '../rec/pipeline.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUDGET_MS = 45000;      // the app's polling call (answers within a minute)
export const CRON_BUDGET_MS = 230000; // the cron and the server's own "kick" calls (vercel.json gives api/class.js 300 s)
export const KICK_WAIT_MS = 20000;    // pause before the next kick while a class is still processing
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The class's recording state as the CALLER may see it (rec_session_status, with their own session): null = not allowed
export async function sessionStatus(token, sessionId) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rec_session_status`, { method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session: sessionId }) });
    if (!r.ok) return { allowed: false, status: r.status };
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = null; }
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    return d && typeof d === 'object' ? { allowed: true, data: d } : { allowed: false, status: 502 };
  } catch { return { allowed: false, status: 503 }; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  const env = recordingEnv();
  if (req.method === 'GET') {
    if (!cronAuthorized(req, env.cronSecret)) return res.status(401).json({ error: 'Unauthorized' });
    if (!env.configured) return res.status(200).json({ configured: false });
    const hopRaw = req.query?.hop; const hop = hopRaw === undefined ? null : parseInt(String(hopRaw), 10);
    if (hop !== null && !(hop >= 0 && hop <= MAX_KICKS)) return res.status(400).json({ error: 'Invalid request.' });
    const dl = deadline(CRON_BUDGET_MS);
    const retention = hop === null ? await runRetention(env, { dl: deadline(12000) }) : null; // retention: only the daily cron
    const work = await processAll(env, { dl });
    // still processing (e.g. waiting for Azure) → wake up again in a moment, in a new invocation
    let next = null;
    if (work.states.includes('processing') && (hop ?? 0) < MAX_KICKS) {
      await sleep(Math.min(KICK_WAIT_MS, Math.max(0, parseInt(process.env.RECORDING_KICK_WAIT_MS ?? '', 10) || KICK_WAIT_MS)));
      next = (await kick(env, (hop ?? 0) + 1)) ? (hop ?? 0) + 1 : null;
    }
    console.log('rec: cron', JSON.stringify({ hop, retention, work, next }));
    return res.status(200).json({ ok: true, hop, retention, work, next });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = bearer(req);
  let user; try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  if (!env.configured) return res.status(501).json({ configured: false });
  const sid = String(req.body?.session || '');
  if (!UUID.test(sid)) return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const before = await sessionStatus(token, sid);
  if (!before.allowed) return before.status >= 500 ? res.status(503).json({ error: 'Please try again.', code: 'access_check' })
    : res.status(403).json({ error: 'You are not part of this class.', code: 'not_member' });
  if (before.data.state !== 'processing') return res.status(200).json(before.data);
  const out = await processSession(env, { cls: sid.toLowerCase(), dl: deadline(BUDGET_MS) });
  const after = await sessionStatus(token, sid);
  return res.status(200).json({ ...(after.allowed ? after.data : before.data), step: out.step || null });
}
