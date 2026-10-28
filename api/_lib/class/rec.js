// Vercel serverless (via api/class.js): the teacher pauses / resumes the recording, or ends the class for everyone.
//   POST /api/class/rec {room: "sess-<class id>", state: "paused" | "on" | "end"}   Authorization: Bearer <Supabase session>
//   → 200 {ok, state, …} · 400 invalid · 401 no session · 403 not the teacher / substitute of that class
//     · 501 {configured:false} while the recording pipeline is off (the room keeps its client-side pause; nothing is recorded)
// Who: ONLY the teacher or substitute of that calendar class (live_room_role with the caller's own session → 'teacher').
// The 5-minute automatic resume stays in the teacher's browser (public/live-class.js), which calls this again with "on".
import { getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../livekit.js';
import { sessionIdFromRoom } from './token.js';
import { recordingEnv } from '../rec/env.js';
import { setRecState } from '../rec/pipeline.js';

export async function roleInClass(token, sessionId) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/live_room_role`, { method: 'POST', signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session: sessionId }) });
    if (!r.ok) return undefined;
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { return undefined; }
    return typeof d === 'string' ? d : null;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const token = bearer(req);
  let user; try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  const env = recordingEnv();
  if (!env.configured) return res.status(501).json({ configured: false });
  const room = String(req.body?.room || ''); const state = String(req.body?.state || '');
  const sid = /^sess-[0-9a-f]{32}$/.test(room) ? sessionIdFromRoom(room) : null; // calendar classes only (ad-hoc rooms are never recorded)
  if (!sid || !['paused', 'on', 'end'].includes(state)) return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const role = await roleInClass(token, sid);
  if (role === undefined) return res.status(503).json({ error: 'Could not check your access to this class. Please try again.', code: 'access_check' });
  if (role !== 'teacher') return res.status(403).json({ error: 'Only the teacher of this class can pause or end the recording.', code: 'owner' });
  const out = await setRecState(env, room, state);
  if (!out.ok) return res.status(503).json({ error: 'Could not change the recording. Please try again.', code: 'upstream' });
  return res.status(200).json(out);
}
