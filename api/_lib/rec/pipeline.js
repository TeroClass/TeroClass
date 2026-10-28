// Recording pipeline orchestration (server only). Every write goes through the service-role RPCs of 001_base.sql
// ("RECORDING PIPELINE" block); every step is idempotent so webhook retries, the daily cron and the client's polling can all
// call it at the same time without duplicating anything.
//   webhook → onRoomStarted · onTrackPublished (DB consent re-check → Track Egress to Azure Blob) · onEgressEnded · onRoomFinished
//   api/class?action=rec      → setRecState (teacher pause / resume / end of class)
//   api/class?action=process  → processSession / processAll (transcription jobs, polling, analysis) · runRetention (30 days)
import { serviceKey, serviceHeaders, SUPABASE_URL } from '../billing.js';
import { speechLocale } from './env.js';
import * as LK from './livekit-api.js';
import * as AZ from './azure.js';
import * as AN from './analysis.js';

export const MIN_AI_MS = 22000;          // an AI step starts only with at least this much time left
export const MAX_ANALYSIS_ATTEMPTS = 40; // process calls that claimed the analysis of one class (each does one or more steps)
const SAS_TTL_S = 6 * 3600;              // Speech may start a job some time after it is created

export const deadline = ms => { const end = Date.now() + ms; return { left: () => end - Date.now(), end }; };
const log = (...a) => console.log('rec:', ...a);
const warn = (...a) => console.warn('rec:', ...a);

// Service-role RPC → { ok, status, data } (never throws). query: extra PostgREST params (select / limit for set-returning fns).
export async function svc(fn, body, { timeoutMs = 8000, query = '' } = {}) {
  const key = serviceKey(); if (!key) return { ok: false, status: 0, data: null };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}${query ? '?' + query : ''}`, {
      method: 'POST', headers: serviceHeaders(key), body: JSON.stringify(body || {}), signal: controller.signal });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!r.ok) warn(`${fn} failed (HTTP ${r.status})`, data?.message || '');
    return { ok: r.ok, status: r.status, data };
  } catch (e) { warn(`${fn} failed (${e?.name === 'AbortError' ? 'timeout' : 'network'})`); return { ok: false, status: 0, data: null }; }
  finally { clearTimeout(timer); }
}

const isCalendarRoom = room => /^sess-[0-9a-f]{32}$/.test(String(room || ''));

// "● Recording" in the room is shown only once an egress really started for that person: the server sets rec_active in
// their LiveKit metadata (keeping everything the token put there). Best effort.
export async function markActive(env, room, identity, on, metadata) {
  let md = metadata;
  if (md === undefined) { const g = await LK.getParticipant(env.livekit, room, identity, 3000); if (!g.ok) return false; md = g.data?.metadata; }
  let o = {}; try { o = JSON.parse(md || '{}') || {}; } catch { o = {}; }
  if (typeof o !== 'object' || Array.isArray(o)) o = {};
  if (!!o.rec_active === !!on) return true;
  o.rec_active = !!on;
  const u = await LK.updateParticipant(env.livekit, room, identity, JSON.stringify(o), 3000);
  return u.ok;
}

// ── webhook events ──
export async function onRoomStarted(env, event) {
  const room = event?.room?.name; if (!isCalendarRoom(room)) return { ok: true, skipped: 'room' };
  const r = await svc('rec_room_started', { p_room: room });
  return { ok: r.ok, retry: !r.ok };
}

// One microphone track → DB re-check (role + consent read NOW from user_consents) → reserve → Track Egress → started.
export async function recordTrack(env, { room, identity, trackSid, name, metadata }) {
  const r = await svc('rec_track_published', { p_room: room, p_user: identity, p_track: trackSid, p_name: name || null });
  if (!r.ok) return { ok: false, retry: true, reason: 'db' };
  if (!r.data?.record) return { ok: true, record: false, reason: r.data?.reason || 'no' };
  const eg = await LK.startTrackEgress(env.livekit, { room, trackId: trackSid, filepath: r.data.storage_path, storage: env.storage }, 8000);
  const id = LK.egressIdOf(eg.data);
  if (!eg.ok || !id) {
    warn('StartTrackEgress failed', eg.status, eg.data?.msg || eg.data?.code || '');
    await svc('rec_egress_failed', { p_recording: r.data.recording_id });
    return { ok: false, retry: true, reason: 'egress' };
  }
  const st = await svc('rec_egress_started', { p_recording: r.data.recording_id, p_egress: id });
  if (!st.ok || st.data?.ok === false || st.data?.stop) { // paused / ended meanwhile, or not stored: never leave it running
    await LK.stopEgress(env.livekit, id, 5000);
    return { ok: st.ok, record: false, reason: st.data?.stop ? 'paused' : 'db', retry: !st.ok };
  }
  await markActive(env, room, identity, true, metadata);
  return { ok: true, record: true, egress_id: id };
}
export async function onTrackPublished(env, event) {
  const room = event?.room?.name; const p = event?.participant || {}; const t = event?.track || {};
  if (!isCalendarRoom(room)) return { ok: true, skipped: 'room' };
  if (!LK.isMicTrack(t)) return { ok: true, skipped: 'track' };
  if (!LK.UUID_RE.test(String(p.identity || ''))) return { ok: true, skipped: 'identity' };
  return recordTrack(env, { room, identity: p.identity, trackSid: t.sid, name: p.name, metadata: p.metadata });
}

const iso = d => (d ? new Date(d).toISOString() : null);
async function egressEnded(env, info) {
  const id = LK.egressIdOf(info); if (!id) return { ok: true, skipped: 'id' };
  const f = LK.egressFinal(info);
  const r = await svc('rec_egress_ended', { p_egress: id, p_ok: f.ok, p_started: iso(f.startedAt), p_ended: iso(f.endedAt),
    p_duration_s: f.durationS, p_error: f.ok ? null : (f.error || f.status) });
  return { ok: r.ok, retry: !r.ok, data: r.data, final: f };
}
export async function onEgressEnded(env, event, budgetMs = 8000) {
  const info = event?.egressInfo || event?.egress_info;
  const e = await egressEnded(env, info);
  const d = e.data;
  if (d?.changed && d.live_status === 'live' && d.identity && d.participant_active === 0) await markActive(env, d.room, d.identity, false);
  if (d?.changed && d.live_status === 'processing') await processSession(env, { live: d.live_session_id, dl: deadline(budgetMs), analysis: false });
  return { ok: e.ok, retry: e.retry };
}
export async function onRoomFinished(env, event, budgetMs = 8000) {
  const room = event?.room?.name; if (!isCalendarRoom(room)) return { ok: true, skipped: 'room' };
  const r = await svc('rec_room_finished', { p_room: room });
  if (!r.ok) return { ok: false, retry: true };
  if (r.data?.status === 'processing') await processSession(env, { live: r.data.live_session_id, dl: deadline(budgetMs), analysis: false });
  return { ok: true, status: r.data?.status };
}

// ── teacher: pause / resume / end of class ──
export async function setRecState(env, room, state, budgetMs = 15000) {
  if (state === 'paused' || state === 'end') {
    const r = await svc('rec_set_state', { p_room: room, p_state: 'paused' });
    if (!r.ok) return { ok: false };
    const stop = Array.isArray(r.data?.stop) ? r.data.stop : [];
    await Promise.all(stop.map(async s => { await LK.stopEgress(env.livekit, s.egress_id, 5000); if (state === 'paused') await markActive(env, room, s.identity, false); }));
    if (state === 'paused') return { ok: true, state, stopped: stop.length };
    // end of class: close the room for everyone (LiveKit sends room_finished too; both paths are idempotent)
    await LK.deleteRoom(env.livekit, room, 5000);
    const fin = await svc('rec_room_finished', { p_room: room });
    if (fin.data?.status === 'processing') await processSession(env, { live: fin.data.live_session_id, dl: deadline(Math.min(budgetMs, 8000)), analysis: false });
    return { ok: true, state, stopped: stop.length, status: fin.data?.status || null };
  }
  const r = await svc('rec_set_state', { p_room: room, p_state: 'on' });
  if (!r.ok) return { ok: false };
  // resume: every microphone in the room again (each one re-checked in the database)
  const lp = await LK.listParticipants(env.livekit, room, 5000);
  const people = Array.isArray(lp.data?.participants) ? lp.data.participants : [];
  const jobs = [];
  for (const p of people.slice(0, 60)) {
    if (!LK.UUID_RE.test(String(p.identity || ''))) continue;
    for (const t of Array.isArray(p.tracks) ? p.tracks : []) {
      if (LK.isMicTrack(t)) jobs.push(recordTrack(env, { room, identity: p.identity, trackSid: t.sid, name: p.name, metadata: p.metadata }));
    }
  }
  const res = await Promise.all(jobs);
  return { ok: lp.ok, state: 'on', started: res.filter(x => x.record).length };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// PROCESSING (bounded: each call stops before its deadline; the next call continues)
// ════════════════════════════════════════════════════════════════════════════════════════
async function stepRecording(env, s, rec, base, locale, dl) {
  if (rec.status === 'recording') {
    // still recording for the database: ask LiveKit (a lost egress_ended webhook must not block the class)
    if (rec.egress_id) {
      const le = await LK.listEgress(env.livekit, { egressId: rec.egress_id }, Math.min(5000, dl.left()));
      const info = Array.isArray(le.data?.items) ? le.data.items.find(i => LK.egressIdOf(i) === rec.egress_id) : null;
      const stale = Date.now() - (Date.parse(s.processing_started_at) || Date.now()) > 15 * 60000;
      if (le.ok && ((info && LK.egressFinal(info).done) || (!info && stale))) {
        const e = await egressEnded(env, info || { egressId: rec.egress_id, status: 'EGRESS_FAILED', error: 'egress not found' });
        if (e.data?.status) rec.status = e.data.status;
      }
    } else if (Date.now() - Date.parse(rec.created_at) > 2 * 60000) {
      const g = await svc('rec_egress_failed', { p_recording: rec.id }); if (g.ok && g.data === true) rec.status = 'gone';
    }
    return;
  }
  if (rec.status !== 'uploaded') return;
  if (!rec.speech_status) {
    const url = AZ.blobSasUrl(env.storage, rec.storage_path, { perm: 'r', ttlS: SAS_TTL_S });
    const sub = await AZ.submitTranscription(env.speech, { url, locale, name: `teroclass ${rec.id}` }, Math.min(10000, dl.left()));
    if (sub.ok) {
      const r = await svc('rec_speech_submitted', { p_recording: rec.id, p_job: sub.job });
      if (r.ok && r.data === true) { rec.speech_status = 'submitted'; rec.speech_job = sub.job; }
    } else {
      warn('Speech submit failed', sub.status, sub.data?.code || sub.data?.message || '');
      const transient = sub.status === 0 || sub.status === 429 || sub.status >= 500;
      if (!transient) { const r = await svc('rec_speech_failed', { p_recording: rec.id, p_error: `submit ${sub.status}`, p_retry: true }); if (r.data?.status) rec.status = r.data.status; }
    }
    return;
  }
  if (rec.speech_status !== 'submitted' || !rec.speech_job) return;
  const g = await AZ.getTranscription(env.speech, rec.speech_job, Math.min(8000, dl.left()));
  if (!g.ok) return; // transient: next call
  if (g.state === 'Succeeded') {
    const res = await AZ.getTranscriptionResult(env.speech, rec.speech_job, Math.min(15000, dl.left()));
    if (!res.ok) return;
    const offset = Math.max(0, (Date.parse(rec.started_at) || base) - base);
    const segs = AZ.parseTranscript(res.data, offset);
    const st = await svc('rec_store_transcript', { p_recording: rec.id, p_segments: segs }, { timeoutMs: 15000 });
    if (st.ok) { rec.status = 'transcribed'; AZ.deleteTranscription(env.speech, rec.speech_job, 3000).catch(() => {}); }
  } else if (g.state === 'Failed') {
    warn('transcription failed', g.error);
    const r = await svc('rec_speech_failed', { p_recording: rec.id, p_error: String(g.error || 'transcription failed').slice(0, 300), p_retry: true });
    if (r.data) { rec.status = r.data.status || rec.status; rec.speech_status = r.data.speech_status ?? null; }
  }
}

const DONE = new Set(['transcribed', 'failed', 'deleted', 'gone']);
function counts(s) {
  const r = s.recordings.filter(x => x.status !== 'gone');
  return { recordings: r.length, transcribed: r.filter(x => x.status === 'transcribed' || x.status === 'deleted').length, failed: r.filter(x => x.status === 'failed').length };
}

// One class (live session id, or the latest one of a calendar class). analysis:false = only transcription work.
export async function processSession(env, { live = null, cls = null, dl = deadline(45000), analysis = true } = {}) {
  const w = await svc('rec_work', { p_live: live, p_class: cls, p_limit: 1 });
  const s = Array.isArray(w.data) ? w.data[0] : null;
  if (!w.ok) return { state: 'error' };
  if (!s) return { state: 'none' };
  if (s.status !== 'processing') return { state: s.status, live: s.id };
  const recs = Array.isArray(s.recordings) ? s.recordings : []; s.recordings = recs;
  const starts = recs.map(r => Date.parse(r.started_at)).filter(Number.isFinite);
  const base = Date.parse(s.started_at) || (starts.length ? Math.min(...starts) : Date.now());
  const locale = speechLocale([s.class_language, s.plan_language], env);
  for (const rec of recs) {
    if (dl.left() < 4000) break;
    try { await stepRecording(env, s, rec, base, locale, dl); } catch (e) { warn('recording step failed', e?.message || e); }
  }
  const c = counts(s);
  if (!recs.every(r => DONE.has(r.status))) return { state: 'processing', step: 'transcribing', live: s.id, ...c };
  if (!c.transcribed) {
    await svc('rec_finish', { p_live: s.id, p_status: c.recordings ? 'failed' : 'ended', p_error: c.recordings ? 'transcription failed' : null });
    return { state: 'ended', live: s.id, ...c };
  }
  if (!analysis) return { state: 'processing', step: 'analysis_pending', live: s.id, ...c };
  return { ...(await analyze(env, s, locale, dl)), live: s.id, ...c };
}

export function pickModel(env, choice) {
  const mini = String(env.deploymentMini || '').trim();
  return choice === 'mini' && /^[A-Za-z0-9._-]{1,64}$/.test(mini) ? mini : env.deployment;
}

async function analyze(env, s, locale, dl) {
  if (!env.aiConfigured) return { state: 'processing', step: 'waiting_ai' };
  if (dl.left() < MIN_AI_MS) return { state: 'processing', step: 'analysis_pending' };
  const claim = await svc('rec_claim_analysis', { p_live: s.id, p_stale_s: 90 });
  if (!claim.ok || claim.data !== true) return { state: 'processing', step: 'analysis_running' };
  try {
    const c = await svc('rec_session_context', { p_live: s.id }, { timeoutMs: 15000 });
    const ctx = c.data;
    if (!c.ok || !ctx) return { state: 'processing', step: 'analysis_retry' };
    const fail = async why => { await svc('rec_finish', { p_live: s.id, p_status: 'failed', p_error: why }); return { state: 'ended', step: 'failed', error: why }; };
    if (!ctx.session) return fail('no calendar class');
    if ((ctx.live?.analysis_attempts || 0) > MAX_ANALYSIS_ATTEMPTS) return fail('too many attempts');
    if (!Array.isArray(ctx.segments) || !ctx.segments.length) return fail('no speech');
    const lang = locale.slice(0, 2);
    const metrics = AN.computeMetrics(ctx);
    const deployment = pickModel(env, ctx.model);
    const cfg = { endpoint: env.ai.endpoint, key: env.ai.key, apiVersion: env.ai.apiVersion, deployment };
    let used = Number(ctx.live?.insights_tokens) || 0;
    const info = { lang, locale, metrics, kind: null, subject: '' };
    let base = ctx.done?.teacher ? ctx.done.teacher_base : null;
    const ai = async (messages, maxTokens) => {
      if (used + AN.estimateTokens(messages, maxTokens) > env.sessionTokenCap) return { capped: true };
      const res = await AN.callAzureJson(cfg, messages, maxTokens, Math.min(50000, dl.left() - 2500));
      if (res.usage) {
        const rr = await svc('rec_record_ai', { p_live: s.id, p_prompt: res.usage.prompt_tokens || 0, p_completion: res.usage.completion_tokens || 0, p_ok: res.ok, p_lang: locale });
        used = Number(rr.data?.session_tokens) || used + (res.usage.total_tokens || 0);
      }
      return res;
    };
    if (!ctx.done?.teacher) {
      const res = await ai(AN.teacherMessages(ctx, info), AN.TEACHER_MAX_TOKENS);
      if (res.capped) return fail('token cap');
      if (!res.ok) { warn('teacher analysis failed', res.status, res.error); return { state: 'processing', step: 'analysis_retry' }; }
      const v = AN.validateTeacherAi(res.content);
      if (!v.ok) { warn('teacher analysis invalid:', v.error); return { state: 'processing', step: 'analysis_retry' }; }
      base = { kind: v.value.kind, lang, subject: v.value.subject || ctx.session.group_name || '', title: ctx.session.title || '', recap: v.value.recap };
      const data = AN.teacherData(v.value, AN.teacherMetrics(metrics, lang, ctx.session.duration_min), base);
      const st = await svc('rec_store_teacher_insights', { p_live: s.id, p_data: data, p_model: deployment });
      if (!st.ok) return { state: 'processing', step: 'analysis_retry' };
    }
    if (!base || !base.recap) return fail('no teacher report');
    info.kind = base.kind === 'discipline' ? 'discipline' : 'language'; info.subject = base.subject || '';
    const studentBase = { kind: info.kind, lang: /^[a-z]{2}$/.test(base.lang || '') ? base.lang : lang, subject: String(base.subject || ''), title: String(base.title || ''), recap: base.recap };
    const sp = AN.speakers(ctx);
    const doneSet = new Set(Array.isArray(ctx.done?.students) ? ctx.done.students : []);
    const todo = (ctx.participants || []).filter(p => p.role === 'student' && p.recorded && p.enrollment_id && !doneSet.has(p.enrollment_id));
    let left = todo.length;
    while (todo.length && dl.left() >= MIN_AI_MS) {
      const batch = todo.splice(0, AN.STUDENT_BATCH);
      const res = await ai(AN.studentMessages(ctx, info, batch), AN.STUDENT_MAX_TOKENS);
      if (res.capped) { await svc('rec_finish', { p_live: s.id, p_status: 'ready' }); return { state: 'ready', step: 'token_cap', students_missing: left }; }
      if (!res.ok) { warn('student analysis failed', res.status, res.error); break; }
      const v = AN.validateStudentsAi(res.content, batch.map(b => sp.get(b.participant_id).ref));
      if (v.errors.length) warn('student analysis invalid:', v.errors.slice(0, 3).join('; '));
      for (const b of batch) {
        const one = v.value.get(sp.get(b.participant_id).ref); if (!one) continue;
        let data;
        try { data = AN.studentData(one, AN.studentProgress(metrics, b.participant_id, one, ctx.previous?.[b.enrollment_id], info.kind), studentBase, studentBase.lang); }
        catch (e) { warn('student data invalid', e?.message); continue; }
        const st = await svc('rec_store_student_insights', { p_live: s.id, p_enrollment: b.enrollment_id, p_participant: b.participant_id, p_data: data, p_model: deployment });
        if (st.ok) left--;
      }
      if (!v.ok) break;
    }
    if (left > 0) return { state: 'processing', step: 'students', students_missing: left };
    await svc('rec_finish', { p_live: s.id, p_status: 'ready' });
    log('insights ready', s.id);
    return { state: 'ready' };
  } finally {
    await svc('rec_release_analysis', { p_live: s.id });
  }
}

// Daily cron: every class still "processing" (oldest first) while there is time
export async function processAll(env, { dl = deadline(40000) } = {}) {
  const w = await svc('rec_work', { p_limit: 10 });
  const list = Array.isArray(w.data) ? w.data : [];
  const out = [];
  for (const s of list) {
    if (dl.left() < 6000) break;
    out.push(await processSession(env, { live: s.id, dl }));
  }
  return { sessions: list.length, processed: out.length, states: out.map(x => x.state) };
}

// Daily cron: delete the audio whose 30 days are over (recordings_due_for_deletion), then mark it deleted. The transcript
// and the insights stay. A failed delete stays due and is retried the next day.
export async function runRetention(env, { dl = deadline(10000), limit = 50 } = {}) {
  const due = await svc('recordings_due_for_deletion', {}, { query: `select=id,storage_path&limit=${Math.max(1, Math.min(200, limit))}` });
  const rows = Array.isArray(due.data) ? due.data : [];
  let deleted = 0; let failed = 0;
  for (const r of rows) {
    if (dl.left() < 1500) break;
    const d = await AZ.deleteBlob(env.storage, r.storage_path, Math.min(8000, dl.left()));
    if (d.ok) { const m = await svc('rec_mark_deleted', { p_recording: r.id }); if (m.ok) deleted++; else failed++; }
    else { failed++; warn('blob delete failed', d.status); }
  }
  return { due: rows.length, deleted, failed };
}
