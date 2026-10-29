// Azure for the recording pipeline, without SDKs:
//   · Blob Storage: short-lived service SAS URLs (HMAC-SHA256 with the account key, server-side only) to let Azure Speech
//     read ONE blob, and to delete a blob when its 30 days are over.
//   · Speech (batch transcription, REST 2024-11-15 by default): create a job per blob (word timestamps on), poll it, read
//     the result. The key goes only to <region>.api.cognitive.microsoft.com.
import { createHmac } from 'node:crypto';

export const SAS_VERSION = '2022-11-02';
const iso = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
export const blobUrl = (st, path) => `https://${st.account}.blob.core.windows.net/${st.container}/${encPath(path)}`;

// Service SAS for one blob (sr=b), HTTPS only. perm: 'r' (read) | 'd' (delete). ttl in seconds; starts 5 min earlier (clock skew).
export function blobSas(st, path, { perm = 'r', ttlS = 6 * 3600, now = Date.now() } = {}) {
  if (!/^[rd]+$/.test(perm)) throw new Error('bad permission');
  const sp = perm; const stt = iso(now - 5 * 60000); const se = iso(now + ttlS * 1000);
  const canonical = `/blob/${st.account}/${st.container}/${path}`;
  // string-to-sign for service SAS version 2020-12-06 and later (blob)
  const sts = [sp, stt, se, canonical, '', '', 'https', SAS_VERSION, 'b', '', '', '', '', '', '', ''].join('\n');
  const sig = createHmac('sha256', Buffer.from(st.key, 'base64')).update(sts, 'utf8').digest('base64');
  const q = new URLSearchParams({ sv: SAS_VERSION, st: stt, se, sr: 'b', sp, spr: 'https', sig });
  return q.toString();
}
export const blobSasUrl = (st, path, o) => `${blobUrl(st, path)}?${blobSas(st, path, o)}`;

async function call(url, opts, timeoutMs = 10000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: { error: e?.name === 'AbortError' ? 'timeout' : 'network' } }; }
  finally { clearTimeout(timer); }
}

// Delete one blob (a SAS with only "d", valid 5 minutes). Already gone (404) counts as deleted.
export async function deleteBlob(st, path, timeoutMs = 8000) {
  const r = await call(blobSasUrl(st, path, { perm: 'd', ttlS: 300 }), { method: 'DELETE', headers: { 'x-ms-version': SAS_VERSION } }, timeoutMs);
  return { ok: r.ok || r.status === 404, status: r.status };
}

// ── Speech batch transcription ──
export const speechHost = sp => `${sp.region}.api.cognitive.microsoft.com`;
const withVersion = (u, v) => { const x = new URL(u); if (!x.searchParams.has('api-version')) x.searchParams.set('api-version', v); return x.toString(); };
// The job URL comes back from Azure; it is only ever called with the key if it points to OUR Speech region.
export function isOwnSpeechUrl(sp, u) {
  try { const x = new URL(u); return x.protocol === 'https:' && x.host === speechHost(sp) && x.pathname.startsWith('/speechtotext/'); } catch { return false; }
}
export function transcriptionBody({ url, locale, name }) {
  return {
    displayName: String(name || 'teroclass').slice(0, 100), locale, contentUrls: [url],
    properties: { wordLevelTimestampsEnabled: true, punctuationMode: 'DictatedAndAutomatic', profanityFilterMode: 'None', timeToLiveHours: 48 },
  };
}
// → { ok, status, job (self URL), data }
export async function submitTranscription(sp, { url, locale, name }, timeoutMs = 10000) {
  const r = await call(`https://${speechHost(sp)}/speechtotext/transcriptions:submit?api-version=${encodeURIComponent(sp.apiVersion)}`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': sp.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(transcriptionBody({ url, locale, name })),
  }, timeoutMs);
  const job = r.data && typeof r.data.self === 'string' ? r.data.self : '';
  return { ...r, ok: r.ok && isOwnSpeechUrl(sp, job), job };
}
// → { ok, status, state: NotStarted | Running | Succeeded | Failed, error }
export async function getTranscription(sp, job, timeoutMs = 8000) {
  if (!isOwnSpeechUrl(sp, job)) return { ok: false, status: 0, state: 'Failed', error: 'bad job url' };
  const r = await call(withVersion(job, sp.apiVersion), { headers: { 'Ocp-Apim-Subscription-Key': sp.key } }, timeoutMs);
  if (r.status === 404) return { ok: true, status: 404, state: 'Failed', error: 'job not found' };
  return { ...r, state: r.data?.status || '', error: r.data?.properties?.error?.message || r.data?.properties?.error?.code || '' };
}
// The transcription JSON of a finished job (the result link is a SAS URL from Azure: fetched WITHOUT our key)
export async function getTranscriptionResult(sp, job, timeoutMs = 15000) {
  if (!isOwnSpeechUrl(sp, job)) return { ok: false, error: 'bad job url' };
  const files = await call(withVersion(`${job.replace(/\/+$/, '')}/files`, sp.apiVersion), { headers: { 'Ocp-Apim-Subscription-Key': sp.key } }, timeoutMs);
  if (!files.ok) return { ok: false, status: files.status, error: 'files' };
  const f = (files.data?.values || []).find(v => v && v.kind === 'Transcription' && v.links?.contentUrl);
  if (!f) return { ok: false, error: 'no transcription file' };
  let u; try { u = new URL(f.links.contentUrl); } catch { return { ok: false, error: 'bad content url' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'bad content url' };
  const c = await call(u.toString(), {}, timeoutMs);
  return c.ok && c.data ? { ok: true, data: c.data } : { ok: false, status: c.status, error: 'content' };
}
export async function deleteTranscription(sp, job, timeoutMs = 5000) {
  if (!isOwnSpeechUrl(sp, job)) return { ok: false };
  return call(withVersion(job, sp.apiVersion), { method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': sp.key } }, timeoutMs);
}

// ── Speech FAST transcription (synchronous: the audio goes up, the transcript comes back in the same call) ──
// Download one blob with a short read-only SAS → { ok, status, buf }
export async function downloadBlob(st, path, timeoutMs = 30000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const r = await fetch(blobSasUrl(st, path, { perm: 'r', ttlS: 900 }), { headers: { 'x-ms-version': SAS_VERSION }, signal: controller.signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  } catch (e) { return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : 'network' }; }
  finally { clearTimeout(timer); }
}
const audioType = name => (/\.ogg$/i.test(name) ? 'audio/ogg' : /\.webm$/i.test(name) ? 'audio/webm' : /\.mp4$|\.m4a$/i.test(name) ? 'audio/mp4' : 'application/octet-stream');
// → { ok, status, data } (data = { durationMilliseconds, phrases: [...] })
export async function fastTranscribe(sp, { audio, filename = 'audio.ogg', locale }, timeoutMs = 60000) {
  const fd = new FormData();
  fd.append('audio', new Blob([audio], { type: audioType(filename) }), filename);
  fd.append('definition', JSON.stringify({ locales: [locale], profanityFilterMode: 'None' }));
  return call(`https://${speechHost(sp)}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(sp.apiVersion)}`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': sp.key }, body: fd,
  }, timeoutMs);
}
// Fast transcription JSON → the same segments as parseTranscript (ms from the start of the CALL: + offsetMs)
export function parseFastTranscript(json, offsetMs = 0) {
  const off = Math.max(0, Math.round(Number(offsetMs) || 0));
  const out = [];
  for (const p of Array.isArray(json?.phrases) ? json.phrases : []) {
    const text = String(p?.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) continue;
    const start = Number(p.offsetMilliseconds); const dur = Number(p.durationMilliseconds);
    if (!Number.isFinite(start) || start < 0) continue;
    const words = Array.isArray(p.words) && p.words.length ? p.words.length : text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
    const conf = Number(p.confidence);
    out.push({ start_ms: off + Math.round(start), end_ms: off + Math.round(start) + Math.max(0, Math.round(dur) || 0), text, words,
      ...(Number.isFinite(conf) ? { confidence: Math.min(1, Math.max(0, conf)) } : {}) });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

// "PT1M2.5S" → ms
export function isoDurationMs(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(s || ''));
  if (!m) return null;
  return Math.round(((+(m[1] || 0) * 24 + +(m[2] || 0)) * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0)) * 1000);
}
const ticksMs = (ticks, iso) => (Number.isFinite(Number(ticks)) && ticks !== null && ticks !== undefined ? Math.round(Number(ticks) / 10000) : isoDurationMs(iso));
// Azure's transcription JSON → [{start_ms, end_ms, text, confidence, words}] (ms from the start of the CALL: + offsetMs)
export function parseTranscript(json, offsetMs = 0) {
  const off = Math.max(0, Math.round(Number(offsetMs) || 0));
  const out = [];
  for (const p of Array.isArray(json?.recognizedPhrases) ? json.recognizedPhrases : []) {
    if (!p || (p.recognitionStatus && p.recognitionStatus !== 'Success')) continue;
    const best = Array.isArray(p.nBest) ? p.nBest[0] : null;
    const text = String(best?.display || best?.lexical || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) continue;
    const start = ticksMs(p.offsetInTicks, p.offset); const dur = ticksMs(p.durationInTicks, p.duration);
    if (start == null) continue;
    const words = Array.isArray(best.words) && best.words.length ? best.words.length : text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
    const conf = Number(best.confidence);
    out.push({ start_ms: off + start, end_ms: off + start + Math.max(0, dur || 0), text, words,
      ...(Number.isFinite(conf) ? { confidence: Math.min(1, Math.max(0, conf)) } : {}) });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}
