// LiveKit server API (Twirp over HTTPS, JSON) without npm dependencies: the same calls livekit-server-sdk makes.
// Every request carries a short-lived HS256 JWT signed with LIVEKIT_API_SECRET (api/_lib/livekit.js) with only the grant
// it needs: roomRecord for Egress, roomAdmin (+ room) for the RoomService.
//   Egress:      StartTrackEgress · StopEgress · ListEgress
//   RoomService: ListParticipants · GetParticipant · UpdateParticipant · DeleteRoom
import { signJwt } from '../livekit.js';

export const httpUrl = url => String(url || '').trim().replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');

export function serverToken(lk, grant, now = Math.floor(Date.now() / 1000)) {
  return signJwt({ iss: lk.apiKey, sub: 'teroclass-server', nbf: now - 5, exp: now + 600, video: grant }, lk.apiSecret);
}

// → { ok, status, data }. Never throws (network / timeout → ok:false, status 0).
export async function twirp(lk, service, method, body, grant, timeoutMs = 8000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const r = await fetch(`${httpUrl(lk.url)}/twirp/livekit.${service}/${method}`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${serverToken(lk, grant)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { msg: e?.name === 'AbortError' ? 'timeout' : 'network' } };
  } finally { clearTimeout(timer); }
}

// Track Egress of ONE audio track, written by LiveKit straight to Azure Blob Storage (account key stays server-side:
// LiveKit receives it in this request, over HTTPS, only to upload this file).
export function startTrackEgress(lk, { room, trackId, filepath, storage }, timeoutMs) {
  return twirp(lk, 'Egress', 'StartTrackEgress', {
    room_name: room, track_id: trackId,
    file: { filepath, azure: { account_name: storage.account, account_key: storage.key, container_name: storage.container } },
  }, { roomRecord: true }, timeoutMs);
}
export const stopEgress = (lk, egressId, timeoutMs) => twirp(lk, 'Egress', 'StopEgress', { egress_id: egressId }, { roomRecord: true }, timeoutMs);
export const listEgress = (lk, { room, egressId } = {}, timeoutMs) =>
  twirp(lk, 'Egress', 'ListEgress', { ...(room ? { room_name: room } : {}), ...(egressId ? { egress_id: egressId } : {}) }, { roomRecord: true }, timeoutMs);
export const listParticipants = (lk, room, timeoutMs) => twirp(lk, 'RoomService', 'ListParticipants', { room }, { roomAdmin: true, room }, timeoutMs);
export const getParticipant = (lk, room, identity, timeoutMs) => twirp(lk, 'RoomService', 'GetParticipant', { room, identity }, { roomAdmin: true, room }, timeoutMs);
export const updateParticipant = (lk, room, identity, metadata, timeoutMs) =>
  twirp(lk, 'RoomService', 'UpdateParticipant', { room, identity, metadata }, { roomAdmin: true, room }, timeoutMs);
export const deleteRoom = (lk, room, timeoutMs) => twirp(lk, 'RoomService', 'DeleteRoom', { room }, { roomCreate: true }, timeoutMs);

// ── reading LiveKit's JSON (protojson: camelCase in webhooks, proto names in some answers; zero enums may be omitted) ──
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
export const egressIdOf = info => String(pick(info, 'egressId', 'egress_id') || '');
const STATUS = ['EGRESS_STARTING', 'EGRESS_ACTIVE', 'EGRESS_ENDING', 'EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED'];
export function egressStatus(info) {
  const s = pick(info, 'status');
  if (typeof s === 'number') return STATUS[s] || 'EGRESS_STARTING';
  return typeof s === 'string' && s ? s : 'EGRESS_STARTING';
}
// int64 nanoseconds (string or number) → Date / seconds
export function nsToDate(v) {
  if (v === undefined || v === null || v === '' || v === '0' || v === 0) return null;
  try { const ms = Number(BigInt(String(v).split('.')[0]) / 1000000n); return ms > 0 ? new Date(ms) : null; } catch { return null; }
}
export function nsToSeconds(v) {
  if (v === undefined || v === null || v === '') return null;
  try { return Math.round(Number(BigInt(String(v).split('.')[0]) / 1000000n) / 1000); } catch { return null; }
}
// Final state of an egress: {done, ok, startedAt, endedAt, durationS, error}
export function egressFinal(info) {
  const status = egressStatus(info);
  const done = ['EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED'].includes(status);
  const file = pick(info, 'file') || (pick(info, 'fileResults', 'file_results') || [])[0] || pick(pick(info, 'result') || {}, 'file') || {};
  const startedAt = nsToDate(pick(file, 'startedAt', 'started_at')) || nsToDate(pick(info, 'startedAt', 'started_at'));
  const endedAt = nsToDate(pick(file, 'endedAt', 'ended_at')) || nsToDate(pick(info, 'endedAt', 'ended_at'));
  let durationS = nsToSeconds(pick(file, 'duration'));
  if (durationS == null && startedAt && endedAt) durationS = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const ok = status === 'EGRESS_COMPLETE' || status === 'EGRESS_LIMIT_REACHED';
  return { done, ok, status, startedAt, endedAt, durationS, error: String(pick(info, 'error') || '').slice(0, 300) };
}
// The microphone (audio) track of a participant? (webhook track info or ListParticipants track)
export function isMicTrack(t) {
  if (!t || typeof t !== 'object') return false;
  const type = pick(t, 'type'); const source = pick(t, 'source');
  const audio = type === undefined || type === 'AUDIO' || type === 0;
  const mic = source === 'MICROPHONE' || source === 2;
  return audio && mic && /^[A-Za-z0-9_-]{3,100}$/.test(String(pick(t, 'sid') || ''));
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
