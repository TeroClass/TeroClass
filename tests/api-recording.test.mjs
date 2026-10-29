// Recording pipeline (LiveKit Egress → Azure Blob → Azure Speech → Azure OpenAI insights), no network: fetch is mocked.
// Usage: node --no-warnings --test tests/api-recording.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

const envMod = await import('../api/_lib/rec/env.js');
const az = await import('../api/_lib/rec/azure.js');
const lkApi = await import('../api/_lib/rec/livekit-api.js');
const AN = await import('../api/_lib/rec/analysis.js');
const pipeline = await import('../api/_lib/rec/pipeline.js');
const webhookMod = await import('../api/livekit/webhook.js');
const classFn = (await import('../api/class.js')).default;
const processMod = await import('../api/_lib/class/process.js');
const health = (await import('../api/health.js')).default;
const config = await import('../api/config.js');
const lib = await import('../api/_lib/livekit.js');
// the shared view (browser IIFE) in node: real insights must render exactly like the demo ones
globalThis.window = globalThis.window || {};
await import('../public/insights-view.js');
const V = globalThis.window.TCInsightsView;

const SB = 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const LK = 'https://teroclass-br.livekit.cloud';
const SPEECH = 'https://brazilsouth.api.cognitive.microsoft.com';
const STORAGE_KEY = Buffer.from('k'.repeat(48)).toString('base64');
const ENV = {
  RECORDING_ENABLED: 'true', LIVEKIT_URL: 'wss://teroclass-br.livekit.cloud', LIVEKIT_API_KEY: 'APIrecKey', LIVEKIT_API_SECRET: 'rec-secret-value-for-tests-0123456789',
  AZURE_STORAGE_ACCOUNT: 'teroclassrec', AZURE_STORAGE_KEY: STORAGE_KEY, AZURE_STORAGE_CONTAINER: 'recordings',
  AZURE_SPEECH_KEY: 'speech-key-123', AZURE_SPEECH_REGION: 'brazilsouth', CRON_SECRET: 'cron-secret-0123456789abcdef',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', AZURE_OPENAI_ENDPOINT: 'https://tero-ai.openai.azure.com', AZURE_OPENAI_API_KEY: 'aoai-key',
};
const ALL_KEYS = [...Object.keys(ENV), 'INSIGHTS_SESSION_TOKEN_CAP', 'RECORDING_SPANISH_LOCALE', 'AZURE_OPENAI_DEPLOYMENT_MINI', 'RECORDING_FAST_TRANSCRIPTION', 'RECORDING_KICK_HOST', 'VERCEL_URL', 'VERCEL_ENV', 'VERCEL_PROJECT_PRODUCTION_URL'];
function setEnv(on, extra = {}) { for (const k of ALL_KEYS) delete process.env[k]; if (on) Object.assign(process.env, ENV, extra); }
const SECRETS = [ENV.LIVEKIT_API_SECRET, ENV.AZURE_STORAGE_KEY, ENV.AZURE_SPEECH_KEY, ENV.CRON_SECRET, ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.AZURE_OPENAI_API_KEY];
const noSecrets = body => { const s = JSON.stringify(body); for (const k of SECRETS) assert.ok(!s.includes(k), 'leaked a secret'); };

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000001', email: 'profe@tec.com' };
const STUDENT = '2b3c4d5e-6f70-4b1c-8d9e-000000000002';
const NOCONSENT = '3c4d5e6f-7081-4c2d-9e0f-000000000003';
const CLASS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ROOM = 'sess-' + CLASS.replace(/-/g, '');
const LIVE = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

function res() { const r = { statusCode: 0, body: null, headers: {} }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; }
const b64d = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
const quiet = async fn => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; } };

// ── a fake network: routes = [[test(url, opts), handler(url, opts, body) → {status, json}]] ──
function mockNet(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body });
    for (const [t, h] of routes) {
      if (typeof t === 'string' ? u.startsWith(t) : t instanceof RegExp ? t.test(u) : t(u, opts)) {
        const r = await h(u, opts, body);
        if (r instanceof Response) return r;
        return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{"message":"unmocked"}', { status: 404 });
  };
  calls.rpc = fn => calls.filter(c => c.url.startsWith(`${SB}/rest/v1/rpc/${fn}`));
  calls.twirp = m => calls.filter(c => c.url.startsWith(`${LK}/twirp/`) && c.url.endsWith('/' + m));
  return calls;
}
const rpc = (fn, h) => [`${SB}/rest/v1/rpc/${fn}`, h];
const twirp = (m, h) => [`${LK}/twirp/`, (u, o, b) => (u.endsWith('/' + m) ? h(u, o, b) : null)];
// several twirp handlers in one route
const twirps = map => [u => u.startsWith(`${LK}/twirp/`), (u, o, b) => { const m = u.split('/').pop(); return map[m] ? map[m](u, o, b) : { status: 404, json: { msg: 'no ' + m } }; }];

function signedWebhook(body) {
  const now = Math.floor(Date.now() / 1000);
  return lib.signJwt({ iss: ENV.LIVEKIT_API_KEY, nbf: now, exp: now + 300, sha256: createHash('sha256').update(body).digest('base64') }, ENV.LIVEKIT_API_SECRET);
}
function hook(event) {
  const body = JSON.stringify(event); const s = Readable.from([Buffer.from(body)]);
  s.method = 'POST'; s.headers = { authorization: signedWebhook(body), 'content-type': 'application/webhook+json' };
  return s;
}
const micEvent = (identity, sid = 'TR_mic1', extra = {}) => ({ event: 'track_published', id: 'EV_' + sid, room: { name: ROOM, sid: 'RM_1' },
  participant: { identity, name: 'Someone', metadata: JSON.stringify({ role: 'student', recorded: true, consent: { recording: true } }) },
  track: { sid, type: 'AUDIO', source: 'MICROPHONE', mimeType: 'audio/opus', ...extra } });

// ════════════════════════════════════════════════════════════════════════════════════════
test('off by default: every variable is required; /api/health and /api/config only say true/false', async () => {
  setEnv(false);
  assert.equal(envMod.recordingEnv().configured, false);
  for (const k of Object.keys(ENV).filter(k => !k.startsWith('AZURE_OPENAI'))) {
    setEnv(true); delete process.env[k];
    assert.equal(envMod.recordingEnv().configured, false, `still on without ${k}`);
  }
  setEnv(true, { RECORDING_ENABLED: 'false' }); assert.equal(envMod.recordingEnv().configured, false);
  setEnv(true, { AZURE_STORAGE_ACCOUNT: 'Bad_Account!' }); assert.equal(envMod.recordingEnv().configured, false, 'invalid account name');
  setEnv(true, { CRON_SECRET: 'short' }); assert.equal(envMod.recordingEnv().configured, false, 'weak cron secret');
  setEnv(true); assert.equal(envMod.recordingEnv().configured, true);
  assert.equal(config.publicConfig({ RECORDING_ENABLED: 'true' }).recording, false, 'RECORDING_ENABLED alone is not enough');
  assert.equal(config.publicConfig(process.env).recording, true);
  mockNet([[`${SB}/auth/v1/health`, () => ({ json: {} })]]);
  let r = res(); await health({ method: 'GET' }, r);
  assert.equal(r.body.checks.recording_configured, true); noSecrets(r.body);
  setEnv(false); r = res(); await health({ method: 'GET' }, r);
  assert.equal(r.body.checks.recording_configured, false);
});

test('transcription locale: the class language (en-US default for TEC, es-UY / es-ES)', () => {
  assert.equal(envMod.speechLocale([null, '']), 'en-US');
  assert.equal(envMod.speechLocale(['', 'English']), 'en-US');
  assert.equal(envMod.speechLocale(['', 'Spanish']), 'es-UY');
  assert.equal(envMod.speechLocale(['', 'Spanish'], { spanishLocale: 'es-ES' }), 'es-ES');
  assert.equal(envMod.speechLocale(['es-es', 'English']), 'es-ES', 'the call language wins over the plan');
  assert.equal(envMod.speechLocale(['es-UY']), 'es-UY');
  assert.equal(envMod.speechLocale(['Klingon']), 'en-US');
});

test('SAS: short-lived, one blob, read-only, HTTPS only, signed with the account key', () => {
  const st = { account: 'teroclassrec', key: STORAGE_KEY, container: 'recordings' };
  const now = Date.parse('2026-10-28T12:00:00Z');
  const path = 'live-1/part-2/rec 3.ogg';
  const url = az.blobSasUrl(st, path, { now, ttlS: 3600 });
  const u = new URL(url);
  assert.equal(u.host, 'teroclassrec.blob.core.windows.net');
  assert.equal(u.pathname, '/recordings/live-1/part-2/rec%203.ogg');
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(Object.keys(q).sort(), ['se', 'sig', 'sp', 'spr', 'sr', 'st', 'sv']);
  assert.equal(q.sp, 'r'); assert.equal(q.sr, 'b'); assert.equal(q.spr, 'https'); assert.equal(q.sv, '2022-11-02');
  assert.equal(q.st, '2026-10-28T11:55:00Z'); assert.equal(q.se, '2026-10-28T13:00:00Z');
  const sts = ['r', q.st, q.se, `/blob/teroclassrec/recordings/${path}`, '', '', 'https', '2022-11-02', 'b', '', '', '', '', '', '', ''].join('\n');
  assert.equal(q.sig, createHmac('sha256', Buffer.from(STORAGE_KEY, 'base64')).update(sts).digest('base64'));
  assert.ok(!url.includes(STORAGE_KEY), 'the key itself never goes in the URL');
  assert.equal(new URL(az.blobSasUrl(st, path, { perm: 'd', ttlS: 300, now })).searchParams.get('sp'), 'd');
  assert.throws(() => az.blobSas(st, path, { perm: 'rwd' }), /permission/);
});

test('webhook: Track Egress (audio, straight to Azure Blob) ONLY for people whose consent the database confirms; retries are idempotent', async () => {
  setEnv(true);
  const reserved = new Set();
  const calls = mockNet([
    rpc('rec_track_published', (u, o, b) => {
      // the database decides (re-check): only USER and STUDENT have a valid consent; NOCONSENT's metadata lies
      if (b.p_user === NOCONSENT) return { json: { record: false, reason: 'no_consent' } };
      if (reserved.has(b.p_track)) return { json: { record: false, reason: 'already' } };
      reserved.add(b.p_track);
      return { json: { record: true, recording_id: 'rec-' + b.p_track, storage_path: `${LIVE}/p/${b.p_track}.ogg`, live_session_id: LIVE, participant_id: 'p' } };
    }),
    rpc('rec_egress_started', () => ({ json: { ok: true, stop: false } })),
    twirps({
      StartTrackEgress: (u, o, b) => ({ json: { egress_id: 'EG_' + b.track_id, status: 'EGRESS_STARTING' } }),
      UpdateParticipant: () => ({ json: {} }),
    }),
  ]);
  await quiet(async () => {
    let r = res(); await webhookMod.default(hook(micEvent(USER.id, 'TR_teacher')), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.record, true);
    r = res(); await webhookMod.default(hook(micEvent(NOCONSENT, 'TR_nope')), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.record, false);
    r = res(); await webhookMod.default(hook(micEvent(USER.id, 'TR_teacher')), r); // LiveKit retries the same event
    assert.equal(r.statusCode, 200); assert.equal(r.body.record, false);
    // not a microphone (camera, screen-share audio), an ad-hoc room, a non-UUID identity: nothing asked
    await webhookMod.default(hook(micEvent(STUDENT, 'TR_cam', { type: 'VIDEO', source: 'CAMERA' })), res());
    await webhookMod.default(hook(micEvent(STUDENT, 'TR_ssa', { source: 'SCREEN_SHARE_AUDIO' })), res());
    await webhookMod.default(hook({ ...micEvent(STUDENT, 'TR_adhoc'), room: { name: 'abcdef012345-x1' } }), res());
    await webhookMod.default(hook({ ...micEvent('guest-1', 'TR_guest') }), res());
  });
  const asked = calls.rpc('rec_track_published').map(c => c.body);
  assert.deepEqual(asked.map(b => b.p_track), ['TR_teacher', 'TR_nope', 'TR_teacher'], 'the DB is asked on every microphone track, nothing else');
  assert.ok(asked.every(b => b.p_room === ROOM));
  assert.ok(calls.rpc('rec_track_published').every(c => c.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY), 'server key');
  const eg = calls.twirp('StartTrackEgress');
  assert.equal(eg.length, 1, 'one egress: the consenting teacher, once');
  assert.deepEqual(eg[0].body, { room_name: ROOM, track_id: 'TR_teacher', file: { filepath: `${LIVE}/p/TR_teacher.ogg`,
    azure: { account_name: 'teroclassrec', account_key: STORAGE_KEY, container_name: 'recordings' } } });
  assert.ok(eg[0].url === `${LK}/twirp/livekit.Egress/StartTrackEgress`);
  const claims = b64d(eg[0].headers.Authorization.replace('Bearer ', '').split('.')[1]);
  assert.equal(claims.iss, ENV.LIVEKIT_API_KEY); assert.deepEqual(claims.video, { roomRecord: true }); assert.ok(claims.exp - claims.nbf <= 610);
  assert.deepEqual(calls.rpc('rec_egress_started').map(c => c.body), [{ p_recording: 'rec-TR_teacher', p_egress: 'EG_TR_teacher' }]);
  // "● Recording" for that participant: rec_active added to their metadata, the token's metadata kept
  const up = calls.twirp('UpdateParticipant'); assert.equal(up.length, 1);
  assert.deepEqual(JSON.parse(up[0].body.metadata), { role: 'student', recorded: true, consent: { recording: true }, rec_active: true });
  assert.equal(up[0].body.identity, USER.id);
  setEnv(false);
});

test('webhook: egress refused → reservation released and 503 (LiveKit retries); paused meanwhile → stopped at once', async () => {
  setEnv(true);
  let calls = mockNet([
    rpc('rec_track_published', () => ({ json: { record: true, recording_id: 'r1', storage_path: 'x/y/r1.ogg' } })),
    rpc('rec_egress_failed', () => ({ json: true })),
    twirps({ StartTrackEgress: () => ({ status: 503, json: { msg: 'no egress capacity' } }) }),
  ]);
  let r = res(); await quiet(() => webhookMod.default(hook(micEvent(USER.id)), r));
  assert.equal(r.statusCode, 503);
  assert.deepEqual(calls.rpc('rec_egress_failed').map(c => c.body), [{ p_recording: 'r1' }]);
  calls = mockNet([
    rpc('rec_track_published', () => ({ json: { record: true, recording_id: 'r1', storage_path: 'x/y/r1.ogg' } })),
    rpc('rec_egress_started', () => ({ json: { ok: true, stop: true } })),
    twirps({ StartTrackEgress: () => ({ json: { egressId: 'EG_9' } }), StopEgress: () => ({ json: {} }) }),
  ]);
  r = res(); await quiet(() => webhookMod.default(hook(micEvent(USER.id)), r));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls.twirp('StopEgress').map(c => c.body), [{ egress_id: 'EG_9' }]);
  // the database is down → 503 so LiveKit retries (never records without the check)
  calls = mockNet([rpc('rec_track_published', () => ({ status: 500, json: {} }))]);
  r = res(); await quiet(() => webhookMod.default(hook(micEvent(USER.id)), r));
  assert.equal(r.statusCode, 503); assert.equal(calls.twirp('StartTrackEgress').length, 0);
  setEnv(false);
});

test('webhook: pipeline off → nothing is recorded (only logged)', async () => {
  setEnv(true, { AZURE_SPEECH_KEY: '' });
  const calls = mockNet([]);
  const r = res(); await quiet(() => webhookMod.default(hook(micEvent(USER.id)), r));
  assert.equal(r.statusCode, 200); assert.equal(r.body.recording, false);
  assert.equal(calls.length, 0);
  setEnv(false);
});

test('webhook: egress_ended stores the file (times from nanoseconds); room_finished → processing + first transcription attempt', async () => {
  setEnv(true);
  const started = Date.parse('2026-10-28T12:00:00Z');
  const calls = mockNet([
    rpc('rec_egress_ended', () => ({ json: { changed: true, live_status: 'live', room: ROOM, identity: USER.id, participant_active: 0, status: 'uploaded', live_session_id: LIVE } })),
    rpc('rec_room_finished', () => ({ json: { ok: true, status: 'processing', live_session_id: LIVE } })),
    rpc('rec_work', () => ({ json: [{ id: LIVE, status: 'processing', started_at: new Date(started).toISOString(), plan_language: 'Spanish', class_language: '',
      recordings: [{ id: 'r1', status: 'uploaded', speech_status: null, storage_path: `${LIVE}/p/r1.ogg`, started_at: new Date(started + 5000).toISOString(), created_at: new Date(started).toISOString() }] }] })),
    rpc('rec_speech_submitted', () => ({ json: true })),
    [`${SPEECH}/speechtotext/transcriptions:submit`, () => ({ status: 201, json: { self: `${SPEECH}/speechtotext/transcriptions/job-1?api-version=2024-11-15`, status: 'NotStarted' } })],
    twirps({ GetParticipant: () => ({ json: { identity: USER.id, metadata: JSON.stringify({ role: 'teacher', rec_active: true }) } }), UpdateParticipant: () => ({ json: {} }) }),
  ]);
  const ns = ms => String(BigInt(ms) * 1000000n);
  let r = res();
  await quiet(() => webhookMod.default(hook({ event: 'egress_ended', egressInfo: { egressId: 'EG_1', roomName: ROOM, status: 'EGRESS_COMPLETE',
    startedAt: ns(started), endedAt: ns(started + 1500000), fileResults: [{ filename: 'x.ogg', startedAt: ns(started), endedAt: ns(started + 1500000), duration: ns(1500000) }] } }), r));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls.rpc('rec_egress_ended')[0].body, { p_egress: 'EG_1', p_ok: true, p_started: '2026-10-28T12:00:00.000Z', p_ended: '2026-10-28T12:25:00.000Z', p_duration_s: 1500, p_error: null });
  assert.deepEqual(JSON.parse(calls.twirp('UpdateParticipant')[0].body.metadata), { role: 'teacher', rec_active: false }, 'indicator off for that person');
  r = res(); await quiet(() => webhookMod.default(hook({ event: 'room_finished', room: { name: ROOM } }), r));
  assert.equal(r.statusCode, 200);
  const sub = calls.filter(c => c.url.includes(':submit'));
  assert.equal(sub.length, 1, 'transcription job created from the webhook');
  assert.equal(sub[0].headers['Ocp-Apim-Subscription-Key'], ENV.AZURE_SPEECH_KEY);
  assert.equal(sub[0].body.locale, 'es-UY', 'the class plan says Spanish');
  assert.equal(sub[0].body.properties.wordLevelTimestampsEnabled, true);
  assert.equal(sub[0].body.properties.timeToLiveHours, 48);
  const sas = new URL(sub[0].body.contentUrls[0]);
  assert.equal(sas.host, 'teroclassrec.blob.core.windows.net'); assert.equal(sas.searchParams.get('sp'), 'r');
  assert.ok(Date.parse(sas.searchParams.get('se')) - Date.now() <= 6 * 3600e3 + 5000, 'SAS valid a few hours at most');
  assert.equal(calls.rpc('rec_speech_submitted')[0].body.p_job, `${SPEECH}/speechtotext/transcriptions/job-1?api-version=2024-11-15`);
  assert.equal(calls.filter(c => c.url.includes('openai.azure.com')).length, 0, 'no AI from the webhook (bounded)');
  setEnv(false);
});

test('pause / resume / end: only the teacher or substitute of THAT class; the server stops / restarts the egresses', async () => {
  const call = async (body, { auth = 'Bearer good', role = 'teacher' } = {}) => {
    const calls = mockNet([
      [`${SB}/auth/v1/user`, (u, o) => (o.headers.Authorization === 'Bearer good' ? { json: USER } : { status: 401, json: {} })],
      rpc('live_room_role', (u, o) => (o.headers.Authorization === 'Bearer good' ? { json: role } : { status: 401, json: {} })),
      rpc('rec_set_state', (u, o, b) => ({ json: { ok: true, state: b.p_state, stop: b.p_state === 'paused' ? [{ egress_id: 'EG_a', identity: USER.id }, { egress_id: 'EG_b', identity: STUDENT }] : [] } })),
      rpc('rec_room_finished', () => ({ json: { ok: true, status: 'ended' } })),
      rpc('rec_track_published', (u, o, b) => ({ json: b.p_user === NOCONSENT ? { record: false, reason: 'no_consent' } : { record: true, recording_id: 'r-' + b.p_track, storage_path: 'p/' + b.p_track } })),
      rpc('rec_egress_started', () => ({ json: { ok: true, stop: false } })),
      twirps({
        StopEgress: () => ({ json: {} }), DeleteRoom: () => ({ json: {} }), UpdateParticipant: () => ({ json: {} }),
        GetParticipant: (u, o, b) => ({ json: { identity: b.identity, metadata: '{"role":"student","rec_active":true}' } }),
        StartTrackEgress: (u, o, b) => ({ json: { egress_id: 'EG_' + b.track_id } }),
        ListParticipants: () => ({ json: { participants: [
          { identity: USER.id, metadata: '{"role":"teacher"}', tracks: [{ sid: 'TR_t', type: 'AUDIO', source: 'MICROPHONE' }, { sid: 'TR_tv', type: 'VIDEO', source: 'CAMERA' }] },
          { identity: STUDENT, metadata: '{"role":"student"}', tracks: [{ sid: 'TR_s', source: 'MICROPHONE' }] },
          { identity: NOCONSENT, metadata: '{"role":"student","recorded":true}', tracks: [{ sid: 'TR_n', source: 'MICROPHONE' }] },
        ] } }),
      }),
    ]);
    const r = res(); await quiet(() => classFn({ method: 'POST', query: { action: 'rec' }, headers: { authorization: auth }, body }, r));
    return { r, calls };
  };
  setEnv(false);
  let { r } = await call({ room: ROOM, state: 'paused' }); assert.equal(r.statusCode, 501, 'pipeline off');
  setEnv(true);
  ({ r } = await call({ room: ROOM, state: 'paused' }, { auth: '' })); assert.equal(r.statusCode, 401);
  ({ r } = await call({ room: ROOM, state: 'paused' }, { role: 'student' })); assert.equal(r.statusCode, 403);
  ({ r } = await call({ room: ROOM, state: 'paused' }, { role: 'admin' })); assert.equal(r.statusCode, 403, 'admins watch, they do not pause');
  ({ r } = await call({ room: ROOM, state: 'paused' }, { role: null })); assert.equal(r.statusCode, 403);
  ({ r } = await call({ room: 'abcdef012345-x1', state: 'paused' })); assert.equal(r.statusCode, 400, 'ad-hoc rooms are never recorded');
  ({ r } = await call({ room: ROOM, state: 'off' })); assert.equal(r.statusCode, 400);
  let calls;
  ({ r, calls } = await call({ room: ROOM, state: 'paused' }));
  assert.equal(r.statusCode, 200); assert.equal(r.body.stopped, 2);
  assert.deepEqual(calls.twirp('StopEgress').map(c => c.body.egress_id).sort(), ['EG_a', 'EG_b']);
  assert.equal(calls.twirp('UpdateParticipant').length, 2, 'indicators off');
  ({ r, calls } = await call({ room: ROOM, state: 'on' }));
  assert.equal(r.statusCode, 200); assert.equal(r.body.started, 2, 'teacher + consenting student; never the one without consent');
  assert.deepEqual(calls.rpc('rec_track_published').map(c => c.body.p_track).sort(), ['TR_n', 'TR_s', 'TR_t'], 'each microphone re-checked in the DB');
  assert.deepEqual(calls.twirp('StartTrackEgress').map(c => c.body.track_id).sort(), ['TR_s', 'TR_t']);
  ({ r, calls } = await call({ room: ROOM, state: 'end' }));
  assert.equal(r.statusCode, 200);
  assert.equal(calls.twirp('DeleteRoom').length, 1); assert.equal(b64d(calls.twirp('DeleteRoom')[0].headers.Authorization.split('.')[1]).video.roomCreate, true);
  assert.equal(calls.rpc('rec_room_finished').length, 1);
  noSecrets(r.body);
  setEnv(false);
});

// ── processing: Speech polling, transcript, analysis ──
const T0 = Date.parse('2026-10-28T12:00:00Z');
function transcriptJson(phrases) {
  return { recognizedPhrases: phrases.map(([offMs, durMs, text]) => ({ recognitionStatus: 'Success', offsetInTicks: offMs * 10000, durationInTicks: durMs * 10000,
    nBest: [{ confidence: 0.9, display: text, lexical: text.toLowerCase(), words: text.split(' ').map(w => ({ word: w })) }] })) };
}
test('Speech: job polling (running → succeeded → segments with the call offset; failed → retried)', async () => {
  setEnv(true);
  const recs = [
    { id: 'rA', status: 'uploaded', speech_status: 'submitted', speech_job: `${SPEECH}/speechtotext/transcriptions/A`, started_at: new Date(T0 + 2000).toISOString(), created_at: new Date(T0).toISOString() },
    { id: 'rB', status: 'uploaded', speech_status: 'submitted', speech_job: `${SPEECH}/speechtotext/transcriptions/B`, started_at: new Date(T0).toISOString(), created_at: new Date(T0).toISOString() },
    { id: 'rC', status: 'uploaded', speech_status: 'submitted', speech_job: 'https://evil.example.com/speechtotext/transcriptions/C', started_at: new Date(T0).toISOString(), created_at: new Date(T0).toISOString() },
  ];
  const calls = mockNet([
    rpc('rec_work', () => ({ json: [{ id: LIVE, status: 'processing', started_at: new Date(T0).toISOString(), recordings: recs }] })),
    rpc('rec_store_transcript', () => ({ json: { ok: true, segments: 2 } })),
    rpc('rec_speech_failed', () => ({ json: { ok: true, status: 'uploaded', speech_status: null } })),
    [`${SPEECH}/speechtotext/transcriptions/A/files`, () => ({ json: { values: [{ kind: 'TranscriptionReport', links: { contentUrl: 'https://x.blob.core.windows.net/r' } }, { kind: 'Transcription', links: { contentUrl: 'https://spsvc.blob.core.windows.net/t.json?sig=1' } }] } })],
    [`${SPEECH}/speechtotext/transcriptions/A`, (u, o) => (o.method === 'DELETE' ? { status: 204 } : { json: { status: 'Succeeded' } })],
    [`${SPEECH}/speechtotext/transcriptions/B`, () => ({ json: { status: 'Failed', properties: { error: { code: 'InvalidData' } } } })],
    ['https://spsvc.blob.core.windows.net/t.json', () => ({ json: transcriptJson([[1000, 3000, 'What are you going to do?'], [9000, 1500, 'Great.']]) })],
  ]);
  const out = await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE }));
  assert.equal(out.state, 'processing'); assert.equal(out.step, 'transcribing');
  const store = calls.rpc('rec_store_transcript');
  assert.equal(store.length, 1);
  assert.deepEqual(store[0].body, { p_recording: 'rA', p_segments: [
    { start_ms: 3000, end_ms: 6000, text: 'What are you going to do?', words: 6, confidence: 0.9 },
    { start_ms: 11000, end_ms: 12500, text: 'Great.', words: 1, confidence: 0.9 }] }, 'ms from the start of the call (+2 s: that track started later)');
  assert.ok(calls.some(c => c.url.startsWith('https://spsvc.blob.core.windows.net') && !c.headers['Ocp-Apim-Subscription-Key']), 'result fetched without our key');
  assert.deepEqual(calls.rpc('rec_speech_failed').map(c => c.body.p_recording), ['rB']);
  assert.equal(calls.filter(c => c.url.startsWith('https://evil.example.com')).length, 0, 'never sends the key to a foreign job URL');
  assert.ok(calls.filter(c => c.url.startsWith(SPEECH)).every(c => c.method === 'DELETE' || /api-version=2024-11-15/.test(c.url)), 'current REST version');
  // Speech refuses the job (bad request) → counted as a failed attempt; 429/5xx → just retried later
  for (const [status, failed] of [[400, 1], [429, 0], [503, 0]]) {
    const c2 = mockNet([
      rpc('rec_work', () => ({ json: [{ id: LIVE, status: 'processing', started_at: new Date(T0).toISOString(), recordings: [{ id: 'rD', status: 'uploaded', speech_status: null, storage_path: 'a/b/c.ogg', started_at: new Date(T0).toISOString() }] }] })),
      rpc('rec_speech_failed', () => ({ json: { ok: true, status: 'uploaded' } })),
      [`${SPEECH}/speechtotext/transcriptions:submit`, () => ({ status, json: { code: 'x' } })],
    ]);
    await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE }));
    assert.equal(c2.rpc('rec_speech_failed').length, failed, `HTTP ${status}`);
    assert.equal(c2.filter(c => c.url.includes(':submit'))[0].body.locale, 'en-US', 'default: en-US (TEC)');
  }
  setEnv(false);
});

test('parseTranscript: ticks or ISO offsets, only recognised phrases, sorted', () => {
  const segs = az.parseTranscript({ recognizedPhrases: [
    { recognitionStatus: 'Success', offset: 'PT1M2.5S', duration: 'PT1S', nBest: [{ display: 'Second', confidence: 2 }] },
    { recognitionStatus: 'NoMatch', offsetInTicks: 0, durationInTicks: 10, nBest: [{ display: 'x' }] },
    { recognitionStatus: 'Success', offsetInTicks: 5000000, durationInTicks: 10000000, nBest: [{ display: '  First   one ', words: [{}, {}] }] },
  ] }, 100);
  assert.deepEqual(segs, [{ start_ms: 600, end_ms: 1600, text: 'First one', words: 2 }, { start_ms: 62600, end_ms: 63600, text: 'Second', words: 1, confidence: 1 }]);
});

// a transcript: teacher (T) and two consenting students; ms from the start of the call
const PARTS = [
  { participant_id: 'pT', role: 'teacher', name: 'Tina Teacher', recorded: true, user_id: USER.id },
  { participant_id: 'pA', role: 'student', name: 'Ana Alonso', recorded: true, enrollment_id: 'eA' },
  { participant_id: 'pB', role: 'student', name: 'Bruno Barrios', recorded: true, enrollment_id: 'eB' },
  { participant_id: 'pC', role: 'student', name: 'Caro', recorded: false, enrollment_id: 'eC' },
];
const SEGS = [
  { participant_id: 'pT', start_ms: 0, end_ms: 60000, text: 'Today we talk about plans. What are you going to do this weekend?' },
  { participant_id: 'pA', start_ms: 62000, end_ms: 92000, text: 'I am going to visit my grandmother and we are going to cook together' },
  { participant_id: 'pT', start_ms: 93000, end_ms: 95000, text: 'Great. Is it far?' },
  { participant_id: 'pB', start_ms: 99000, end_ms: 100000, text: 'No.' },
  { participant_id: 'pT', start_ms: 101000, end_ms: 161000, text: 'Now listen to the explanation about going to and will.' },
  { participant_id: 'pT', start_ms: 162000, end_ms: 182000, text: 'Remember the examples.' },
];
test('numbers from the timestamps: talk time, words per minute, questions (open / closed), wait time, longest turn', () => {
  const m = AN.computeMetrics({ participants: PARTS, segments: SEGS });
  assert.equal(m.teacherMs, 142000); assert.equal(m.studentMs, 31000);
  assert.deepEqual(m.questions, { total: 2, open: 1, closed: 1 });
  assert.equal(m.avgWaitS, 3, 'answers 2 s and 4 s after the questions');
  assert.equal(m.spoke, 2); assert.equal(m.consenting, 2, 'Caro was not recorded');
  assert.deepEqual(m.longest, { ms: 81000, start: 101000, end: 182000 }, 'two teacher segments 1 s apart = one turn');
  const cards = AN.teacherMetrics(m, 'es', 45);
  assert.deepEqual(cards.map(c => c.label), ['Teacher talk time', 'Student talk time', 'Questions asked', 'Average wait time', 'Students who spoke', 'Longest teacher turn']);
  assert.deepEqual(cards.map(c => c.value), ['82%', '18%', '2', '3 s', '2 / 2', '1:21']);
  assert.equal(cards[0].sub, '2,4 de 45 min'); assert.equal(cards[2].sub, '1 abiertas · 1 cerradas'); assert.equal(cards[5].sub, 'min 1–3');
  const pA = AN.studentProgress(m, 'pA', { level: 'B1', score: 74 }, { vocab: 10, wpm: 20, score: 70, level: 'A2+' }, 'language');
  assert.deepEqual(pA, { speakingMin: 0.5, teacherMin: 2.4, vocab: 11, vocabDelta: 1, level: 'B1', levelPrev: 'A2+', wpm: 28, wpmDelta: 8, score: 74, scoreDelta: 4 });
  const pB = AN.studentProgress(m, 'pB', { level: 'A2', score: 0 }, null, 'language');
  assert.equal(pB.wpm, 0, 'less than 10 s of speech: no words-per-minute'); assert.equal(pB.vocabDelta, 0); assert.equal(pB.levelPrev, 'A2');
  const disc = AN.studentProgress(m, 'pA', { level: 'Explica con apoyo', score: 60, terms_used: 4 }, null, 'discipline');
  assert.equal(disc.vocab, 4); assert.equal(disc.wpm, 0, 'discipline: "questions asked" by the student');
});

const AREA_OBJ = (rating = 'developing') => AN.AREAS.map(a => ({ area: a, rating, evidence: `Min 3: "${a}" evidence, 4 times.`, impact: 'Impact.', next: 'Next step.' }));
const TEACHER_AI = () => ({ kind: 'language', subject: 'English B1', objective: 'Talk about plans', observation_focus: 'STT & Participation',
  recap: { summary: 'We practised going to.', topics: [{ title: 'Going to', bullets: ['Intentions', 'Plans'] }] },
  highlights: [{ title: 'Rapport', text: 'Names used 12 times.' }, { title: 'Setup', text: 'Clear model at min 2.' }],
  focus: { title: 'Teacher talk', text: '82% teacher talk.' }, action: { title: 'Pair work', text: 'Pairs before whole class.' },
  areas: AREA_OBJ(), planVsActual: [{ section: 'Warm-up', planned: 5, actual: 7, note: 'Over' }],
  form: { evidence: 'Teacher talk 82%.', worked: 'Rapport.', priority: 'STT.', next: 'Pair work.' } });
const STUDENT_AI = ref => ({ ref, highlight: 'Clear answer about the weekend.', level: 'B1', score: 74,
  tracker: [{ concept: 'Going to', difficulty: 'Easy', used: 2, mastery: 80 }], pron: [{ item: '/θ/', score: 60, tip: 'Tongue between teeth.' }],
  didWell: [{ text: 'I am going to visit my grandmother', note: 'Correct going to.' }], improve: [{ original: 'we are going to cook together', corrected: "we're going to cook together", explanation: 'Contraction.' }],
  vocab: [{ word: 'grandmother', pos: 'noun', level: 'A1', def: 'Your parent’s mother.', quote: 'visit my grandmother', example: 'My grandmother cooks.' }] });

test('analysis JSON validation: exactly the 13 TEC areas, ratings, required texts; students by reference', () => {
  assert.equal(AN.validateTeacherAi(TEACHER_AI()).ok, true);
  assert.equal(AN.validateTeacherAi(JSON.stringify(TEACHER_AI())).ok, true, 'from the model text');
  assert.equal(AN.validateTeacherAi('```json\n' + JSON.stringify(TEACHER_AI()) + '\n```').ok, true);
  const bad = [
    x => { x.areas.pop(); }, x => { x.areas[3].rating = 'excellent'; }, x => { x.areas[1].area = 'Charisma'; }, x => { x.areas[2] = { ...x.areas[0] }; },
    x => { x.areas[0].evidence = ''; }, x => { x.kind = 'poetry'; }, x => { delete x.recap; }, x => { x.recap.topics = []; }, x => { delete x.form; }, x => { x.highlights = []; },
  ];
  for (const f of bad) { const x = TEACHER_AI(); f(x); assert.equal(AN.validateTeacherAi(x).ok, false, f.toString()); }
  assert.equal(AN.validateTeacherAi('not json').ok, false);
  const shuffled = TEACHER_AI(); shuffled.areas.reverse(); shuffled.areas[0].area = 'evidence of learning';
  assert.deepEqual(AN.validateTeacherAi(shuffled).value.areas.map(a => a.area), AN.AREAS, 'canonical order and names');
  const long = TEACHER_AI(); long.objective = 'x'.repeat(5000); assert.equal(AN.validateTeacherAi(long).value.objective.length, 400, 'lengths capped');
  const v = AN.validateStudentsAi({ students: [STUDENT_AI('S1'), STUDENT_AI('S9'), { ...STUDENT_AI('S2'), highlight: '' }] }, ['S1', 'S2']);
  assert.equal(v.ok, true); assert.deepEqual([...v.value.keys()], ['S1'], 'unknown and invalid ones dropped (retried later)'); assert.equal(v.errors.length, 1);
  assert.equal(AN.validateStudentsAi('{"students": "x"}', ['S1']).ok, false);
  // final data = exactly what public/insights-view.js renders
  const m = AN.computeMetrics({ participants: PARTS, segments: SEGS });
  const base = { kind: 'language', lang: 'en', subject: 'English B1', title: 'Making plans', recap: TEACHER_AI().recap };
  const td = AN.teacherData(AN.validateTeacherAi(TEACHER_AI()).value, AN.teacherMetrics(m, 'en', 45), base);
  const sd = AN.studentData(v.value.get('S1'), AN.studentProgress(m, 'pA', v.value.get('S1'), null, 'language'), base, 'en');
  assert.equal(sd.tracker[0].updated, 'Today');
  const X = V.modelFromSession({ session: { id: CLASS, title: 'Making plans', duration_min: 45, students_total: 2 }, teacher: { data: td, is_demo: false },
    students: [{ id: 's1', name: 'Ana Alonso', data: sd, is_demo: false }] });
  assert.equal(X.teacher.areas.length, 13); assert.equal(X.teacher.metrics[0].label, 'Teacher talk time');
  assert.equal(X.students[0].progress.wpm, 28); assert.equal(X.students[0].vocab[0].word, 'grandmother');
  assert.match(V.teacherReportHtml(X, { P: 't' }), /Classroom observation · 13 areas/);
  assert.match(V.studentTabsHtml(X, 0, 'progress', { P: 't', msg: { mode: 'read' } }), /Going to/);
  assert.throws(() => AN.studentData({ ...v.value.get('S1'), tracker: [{ concept: 'x', difficulty: 'Easy', used: 'many', mastery: 3 }] }, sd.progress, base, 'en'), /tracker/);
});

test('analysis end to end: teacher report + per-student insights stored (non-demo, validated, usage recorded as "insights"); token cap', async () => {
  setEnv(true);
  const ctx = { live: { id: LIVE, insights_tokens: 0, analysis_attempts: 1 }, session: { id: CLASS, title: 'Making plans', group_name: 'English B1', duration_min: 45, students_total: 3 },
    plan: { content: 'Warm-up (5 min)\nPresentation (10 min)' }, notebook: null, model: 'mini', participants: PARTS, segments: SEGS,
    done: { teacher: false, students: [] }, previous: { eA: { vocab: 10, wpm: 20, score: 70, level: 'A2+' } } };
  const work = [{ id: LIVE, status: 'processing', started_at: new Date(T0).toISOString(), class_language: 'en-US',
    recordings: [{ id: 'r1', status: 'transcribed' }, { id: 'r2', status: 'transcribed' }, { id: 'r3', status: 'failed' }] }];
  const aiBodies = [];
  const net = (over = {}) => mockNet([
    rpc('rec_work', () => ({ json: work })),
    rpc('rec_claim_analysis', () => ({ json: true })), rpc('rec_release_analysis', () => ({ json: null })),
    rpc('rec_session_context', () => ({ json: over.ctx || ctx })),
    rpc('rec_record_ai', (u, o, b) => ({ json: { session_tokens: (b.p_prompt + b.p_completion) } })),
    rpc('rec_store_teacher_insights', () => ({ json: { stored: true } })), rpc('rec_store_student_insights', () => ({ json: { stored: true } })),
    rpc('rec_finish', () => ({ json: true })),
    [/openai\.azure\.com/, (u, o, b) => { aiBodies.push({ u, b }); const student = /STUDENTS TO WRITE FOR/.test(b.messages[1].content);
      const content = student ? JSON.stringify({ students: [STUDENT_AI('S1'), STUDENT_AI('S2')] }) : JSON.stringify(TEACHER_AI());
      return { json: { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 1500, total_tokens: 4500 } } }; }],
  ]);
  let calls = net();
  let out = await quiet(() => pipeline.processSession(envMod.recordingEnv({ ...process.env, AZURE_OPENAI_DEPLOYMENT_MINI: 'gpt-4o-mini' }), { live: LIVE }));
  assert.equal(out.state, 'ready');
  assert.equal(aiBodies.length, 2, 'one teacher call + one student batch');
  assert.match(aiBodies[0].u, /deployments\/gpt-4o-mini\/chat\/completions/, 'ai_model_default.insights = mini');
  assert.deepEqual(aiBodies[0].b.response_format, { type: 'json_object' }); assert.ok(aiBodies[0].b.max_tokens <= 4000);
  assert.match(aiBodies[0].b.messages[1].content, /CLASS PLAN/); assert.match(aiBodies[0].b.messages[1].content, /\[1:02\] S1 Ana: I am going to visit/);
  assert.doesNotMatch(aiBodies[0].b.messages[1].content, /Caro|@/, 'only recorded people, first names, no emails');
  assert.match(aiBodies[0].b.messages[1].content, /teacher talk 2:22, student talk 0:31/, 'numbers from the timestamps given to the model');
  const t = calls.rpc('rec_store_teacher_insights')[0].body;
  assert.equal(t.p_live, LIVE); assert.equal(t.p_model, 'gpt-4o-mini');
  assert.equal(AN.checkTeacherShape(t.p_data), true);
  assert.equal(t.p_data.metrics[0].value, '82%', 'metrics computed in code'); assert.equal(t.p_data.source, 'recording'); assert.equal(t.p_data.lang, 'en');
  const st = calls.rpc('rec_store_student_insights').map(c => c.body);
  assert.deepEqual(st.map(s => [s.p_enrollment, s.p_participant]), [['eA', 'pA'], ['eB', 'pB']], 'only consenting students, never Caro');
  for (const s of st) assert.equal(AN.checkStudentShape(s.p_data), true);
  assert.equal(st[0].p_data.progress.vocabDelta, 1, 'delta against the previous real insight'); assert.equal(st[0].p_data.recap.summary, 'We practised going to.');
  assert.equal(calls.rpc('rec_record_ai').length, 2); assert.equal(calls.rpc('rec_record_ai')[0].body.p_ok, true);
  assert.deepEqual(calls.rpc('rec_finish').map(c => c.body.p_status), ['ready']);
  assert.equal(calls.rpc('rec_release_analysis').length, 1);
  // already claimed by another call → nothing
  calls = mockNet([rpc('rec_work', () => ({ json: work })), rpc('rec_claim_analysis', () => ({ json: false }))]);
  out = await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE }));
  assert.equal(out.step, 'analysis_running'); assert.equal(calls.filter(c => /openai/.test(c.url)).length, 0);
  // invalid model JSON → nothing stored, retried later (the call still counts in the usage)
  aiBodies.length = 0;
  calls = mockNet([
    rpc('rec_work', () => ({ json: work })), rpc('rec_claim_analysis', () => ({ json: true })), rpc('rec_release_analysis', () => ({ json: null })),
    rpc('rec_session_context', () => ({ json: ctx })), rpc('rec_record_ai', () => ({ json: { session_tokens: 4500 } })),
    [/openai\.azure\.com/, () => ({ json: { choices: [{ message: { content: JSON.stringify({ ...TEACHER_AI(), areas: AREA_OBJ().slice(0, 12) }) } }], usage: { prompt_tokens: 3000, completion_tokens: 1500 } } })],
  ]);
  out = await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE }));
  assert.equal(out.step, 'analysis_retry'); assert.equal(calls.rpc('rec_store_teacher_insights').length, 0); assert.equal(calls.rpc('rec_record_ai')[0].body.p_ok, true);
  // token cap per class
  calls = net({ ctx: { ...ctx, live: { ...ctx.live, insights_tokens: 19000 } } });
  out = await quiet(() => pipeline.processSession(envMod.recordingEnv({ ...process.env, INSIGHTS_SESSION_TOKEN_CAP: '20000' }), { live: LIVE }));
  assert.equal(out.error, 'token cap'); assert.equal(calls.filter(c => /openai/.test(c.url)).length, 0);
  assert.deepEqual(calls.rpc('rec_finish').map(c => c.body.p_status), ['failed']);
  // no AI configured → waits (nothing fails)
  calls = mockNet([rpc('rec_work', () => ({ json: work }))]);
  out = await quiet(() => pipeline.processSession(envMod.recordingEnv({ ...process.env, AZURE_OPENAI_API_KEY: '' }), { live: LIVE }));
  assert.equal(out.step, 'waiting_ai');
  // too little time left in this call → the next call does it
  calls = mockNet([rpc('rec_work', () => ({ json: work }))]);
  out = await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE, dl: pipeline.deadline(5000) }));
  assert.equal(out.step, 'analysis_pending'); assert.equal(calls.rpc('rec_claim_analysis').length, 0);
  setEnv(false);
});

test('retention: blobs past 30 days deleted (SAS "d") and marked; transcripts / insights untouched; failures retried tomorrow', async () => {
  setEnv(true);
  const calls = mockNet([
    rpc('recordings_due_for_deletion', () => ({ json: [{ id: 'r1', storage_path: 'L/P/r1.ogg' }, { id: 'r2', storage_path: 'L/P/r2.ogg' }, { id: 'r3', storage_path: 'L/P/r3.ogg' }] })),
    rpc('rec_mark_deleted', () => ({ json: true })),
    ['https://teroclassrec.blob.core.windows.net/recordings/L/P/r1.ogg', () => ({ status: 202 })],
    ['https://teroclassrec.blob.core.windows.net/recordings/L/P/r2.ogg', () => ({ status: 404 })],
    ['https://teroclassrec.blob.core.windows.net/recordings/L/P/r3.ogg', () => ({ status: 500 })],
  ]);
  const out = await quiet(() => pipeline.runRetention(envMod.recordingEnv()));
  assert.deepEqual(out, { due: 3, deleted: 2, failed: 1 });
  assert.match(calls.rpc('recordings_due_for_deletion')[0].url, /\?select=id,storage_path&limit=50$/);
  const dels = calls.filter(c => c.method === 'DELETE');
  assert.equal(dels.length, 3);
  for (const d of dels) { const q = new URL(d.url).searchParams; assert.equal(q.get('sp'), 'd'); assert.equal(q.get('sr'), 'b'); assert.ok(Date.parse(q.get('se')) - Date.now() <= 300e3 + 2000); }
  assert.deepEqual(calls.rpc('rec_mark_deleted').map(c => c.body.p_recording), ['r1', 'r2']);
  assert.equal(calls.filter(c => /transcript|insights/.test(c.url)).length, 0);
  setEnv(false);
});

test('process: the daily cron needs CRON_SECRET; the app only for people of that class; bounded and idempotent', async () => {
  const run = async (req) => { const r = res(); await quiet(() => classFn({ query: { action: 'process' }, headers: {}, ...req }, r)); return r; };
  setEnv(true);
  let calls = mockNet([
    rpc('recordings_due_for_deletion', () => ({ json: [] })),
    rpc('rec_work', () => ({ json: [] })),
  ]);
  assert.equal((await run({ method: 'GET' })).statusCode, 401, 'no secret');
  assert.equal((await run({ method: 'GET', headers: { authorization: 'Bearer wrong-secret-0123456789' } })).statusCode, 401);
  assert.equal((await run({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET.slice(0, -1) } })).statusCode, 401);
  let r = await run({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body.retention, { due: 0, deleted: 0, failed: 0 }); assert.equal(r.body.work.sessions, 0);
  assert.equal(calls.rpc('recordings_due_for_deletion').length, 1, 'retention runs from the cron'); noSecrets(r.body);
  setEnv(true, { RECORDING_ENABLED: '' });
  r = await run({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } });
  assert.deepEqual(r.body, { configured: false });
  setEnv(true);
  // the app: a signed-in person who can see the class (rec_session_status with THEIR session decides)
  const app = (status) => mockNet([
    [`${SB}/auth/v1/user`, (u, o) => (o.headers.Authorization === 'Bearer good' ? { json: USER } : { status: 401, json: {} })],
    rpc('rec_session_status', (u, o) => (o.headers.Authorization !== 'Bearer good' ? { status: 401, json: {} } : typeof status === 'number' ? { status, json: { message: 'No autorizado' } } : { json: status })),
    rpc('rec_work', () => ({ json: [{ id: LIVE, status: 'processing', recordings: [{ id: 'r1', status: 'recording', egress_id: null, created_at: new Date().toISOString() }] }] })),
  ]);
  calls = app({ state: 'processing', recordings: 1, transcribed: 0, has_insights: false });
  assert.equal((await run({ method: 'POST', body: { session: CLASS } })).statusCode, 401, 'no session');
  r = await run({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session: 'x' } }); assert.equal(r.statusCode, 400);
  r = await run({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session: CLASS } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.state, 'processing'); assert.equal(r.body.step, 'transcribing');
  assert.equal(calls.rpc('rec_session_status')[0].headers.Authorization, 'Bearer good', 'checked with the caller\'s own session');
  assert.deepEqual(calls.rpc('rec_work')[0].body, { p_live: null, p_class: CLASS, p_limit: 1 }, 'only that class');
  calls = app(400);
  r = await run({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session: CLASS } });
  assert.equal(r.statusCode, 403); assert.equal(calls.rpc('rec_work').length, 0, 'outsiders trigger nothing');
  calls = app({ state: 'ready', recordings: 2, transcribed: 2, has_insights: true });
  r = await run({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session: CLASS } });
  assert.equal(r.body.state, 'ready'); assert.equal(calls.rpc('rec_work').length, 0, 'nothing to do once ready');
  setEnv(false);
  r = await run({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session: CLASS } });
  assert.equal(r.statusCode, 501);
});

test('vercel.json: /api/class/rec and /api/class/process go to the dispatcher; daily cron; 300 s for the pipeline', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const find = p => v.rewrites.find(r => new RegExp('^' + r.source + '$').test(p));
  for (const a of ['rec', 'process', 'config', 'ticket', 'token']) assert.equal(find('/api/class/' + a).destination, '/api/class?action=$1');
  assert.deepEqual(v.crons, [{ path: '/api/class/process', schedule: '17 7 * * *' }], 'Hobby: at most once a day');
  assert.equal(v.functions['api/class.js'].maxDuration, 300, 'Fluid compute (Hobby): up to 300 s');
  assert.ok(processMod.CRON_BUDGET_MS + processMod.KICK_WAIT_MS + 15000 < 300000, 'a kick call fits in its 300 s');
  assert.ok(pipeline.FAST_MIN_MS > processMod.BUDGET_MS, 'the app\'s polling call never starts a fast transcription');
  assert.ok(v.functions['api/livekit/webhook.js'].maxDuration <= 60);
  assert.ok(pipeline.MIN_AI_MS + 2500 < 45000, 'an AI step fits in one call');
  const csp = v.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /blob\.core\.windows\.net|cognitive\.microsoft\.com|openai\.azure\.com/, 'the browser never talks to Azure');
});

test('LiveKit JSON helpers: enums as names or numbers, int64 nanoseconds, omitted zero values', () => {
  assert.equal(lkApi.httpUrl('wss://x.livekit.cloud/'), 'https://x.livekit.cloud');
  assert.equal(lkApi.isMicTrack({ sid: 'TR_1', source: 'MICROPHONE' }), true, 'type AUDIO = 0 omitted');
  assert.equal(lkApi.isMicTrack({ sid: 'TR_1', type: 0, source: 2 }), true);
  assert.equal(lkApi.isMicTrack({ sid: 'TR_1', type: 'VIDEO', source: 'CAMERA' }), false);
  assert.equal(lkApi.isMicTrack({ sid: 'TR_1', type: 'AUDIO', source: 'SCREEN_SHARE_AUDIO' }), false);
  assert.deepEqual(lkApi.egressFinal({ egress_id: 'E', status: 4, error: 'boom' }), { done: true, ok: false, status: 'EGRESS_FAILED', startedAt: null, endedAt: null, durationS: null, error: 'boom' });
  const f = lkApi.egressFinal({ status: 'EGRESS_COMPLETE', file: { startedAt: '1761652800000000000', endedAt: '1761652860000000000' } });
  assert.equal(f.ok, true); assert.equal(f.durationS, 60); assert.equal(f.startedAt.toISOString(), '2025-10-28T12:00:00.000Z');
  assert.equal(lkApi.egressFinal({ status: 'EGRESS_ACTIVE' }).done, false);
});

// ── FAST transcription + the server waking itself up ──
const BLOB = 'https://teroclassrec.blob.core.windows.net/recordings/';
const fastJson = phrases => ({ durationMilliseconds: 60000, combinedPhrases: [{ text: phrases.map(p => p[2]).join(' ') }],
  phrases: phrases.map(([o, d, text]) => ({ offsetMilliseconds: o, durationMilliseconds: d, text, confidence: 0.8, locale: 'en-US', words: text.split(' ').map(w => ({ text: w })) })) });
const freshWork = (extra = {}) => rpc('rec_work', () => ({ json: [{ id: LIVE, status: 'processing', started_at: new Date(T0).toISOString(),
  processing_started_at: new Date(Date.now() - 30000).toISOString(), class_language: 'English', ...extra,
  recordings: [
    { id: 'f1', status: 'uploaded', speech_status: null, storage_path: `${LIVE}/p1/f1.ogg`, started_at: new Date(T0 + 4000).toISOString(), created_at: new Date(T0).toISOString() },
    { id: 'f2', status: 'uploaded', speech_status: null, storage_path: `${LIVE}/p2/f2.ogg`, started_at: new Date(T0).toISOString(), created_at: new Date(T0).toISOString() }] }] }));

test('fast transcription: new recordings in parallel, under the class lock, no batch job; the transcript keeps the call offset', async () => {
  setEnv(true);
  const calls = mockNet([
    freshWork(),
    rpc('rec_claim_analysis', () => ({ json: true })), rpc('rec_release_analysis', () => ({ json: null })),
    rpc('rec_store_transcript', () => ({ json: { ok: true } })),
    [BLOB, () => new Response(Buffer.from('OggS-audio'), { status: 200 })],
    [`${SPEECH}/speechtotext/transcriptions:transcribe`, () => ({ json: fastJson([[1000, 2000, 'Hello teacher'], [5000, 1000, 'Yes.']]) })],
  ]);
  const out = await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE, dl: pipeline.deadline(280000), analysis: false }));
  assert.equal(out.step, 'analysis_pending'); assert.equal(out.transcribed, 2);
  assert.equal(calls.filter(c => c.url.includes(':submit')).length, 0, 'no batch job');
  const tr = calls.filter(c => c.url.includes(':transcribe'));
  assert.equal(tr.length, 2);
  assert.ok(tr.every(c => c.headers['Ocp-Apim-Subscription-Key'] === ENV.AZURE_SPEECH_KEY && /api-version=2024-11-15/.test(c.url)));
  assert.deepEqual(JSON.parse(tr[0].body.get('definition')).locales, ['en-US']);
  const blob = calls.filter(c => c.url.startsWith(BLOB));
  assert.ok(blob.every(c => new URL(c.url).searchParams.get('sp') === 'r' && !c.headers['Ocp-Apim-Subscription-Key']), 'read-only SAS, no Speech key to storage');
  const f1 = calls.rpc('rec_store_transcript').find(c => c.body.p_recording === 'f1');
  assert.deepEqual(f1.body.p_segments, [{ start_ms: 5000, end_ms: 7000, text: 'Hello teacher', words: 2, confidence: 0.8 }, { start_ms: 9000, end_ms: 10000, text: 'Yes.', words: 1, confidence: 0.8 }]);
  assert.equal(calls.rpc('rec_claim_analysis')[0].body.p_stale_s, pipeline.FAST_LOCK_S);
  assert.equal(calls.rpc('rec_release_analysis').length, 1, 'lock released');
  setEnv(false);
});

test('fast transcription fails → batch job in the same call; lock busy → nothing; RECORDING_FAST_TRANSCRIPTION=false → batch', async () => {
  for (const [label, extra, routes, expect] of [
    ['speech 500', {}, [rpc('rec_claim_analysis', () => ({ json: true })), [`${SPEECH}/speechtotext/transcriptions:transcribe`, () => ({ status: 500, json: {} })]], { submit: 2, transcribe: 2 }],
    ['lock busy', {}, [rpc('rec_claim_analysis', () => ({ json: false }))], { submit: 0, transcribe: 0 }],
    ['fast off', { RECORDING_FAST_TRANSCRIPTION: 'false' }, [], { submit: 2, transcribe: 0 }],
  ]) {
    setEnv(true, extra);
    const calls = mockNet([freshWork(), rpc('rec_release_analysis', () => ({ json: null })), rpc('rec_speech_submitted', () => ({ json: true })),
      [BLOB, () => new Response(Buffer.from('OggS'), { status: 200 })],
      [`${SPEECH}/speechtotext/transcriptions:submit`, () => ({ status: 201, json: { self: `${SPEECH}/speechtotext/transcriptions/j?api-version=2024-11-15` } })], ...routes]);
    await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE, dl: pipeline.deadline(280000), analysis: false }));
    assert.equal(calls.filter(c => c.url.includes(':submit')).length, expect.submit, label + ': batch jobs');
    assert.equal(calls.filter(c => c.url.includes(':transcribe')).length, expect.transcribe, label + ': fast calls');
  }
  setEnv(false);
});

test('short calls leave new recordings to the long "kick" call (5 min), then fall back to batch', async () => {
  for (const [label, extra, startedAgo, submit] of [
    ['no kick URL (old behaviour)', {}, 30000, 2], ['kick URL, new class', { VERCEL_URL: 'teroclass-abc.vercel.app' }, 30000, 0],
    ['kick URL, waiting > 5 min', { VERCEL_URL: 'teroclass-abc.vercel.app' }, 6 * 60000, 2]]) {
    setEnv(true); Object.assign(process.env, extra);
    const calls = mockNet([freshWork({ processing_started_at: new Date(Date.now() - startedAgo).toISOString() }), rpc('rec_speech_submitted', () => ({ json: true })),
      [`${SPEECH}/speechtotext/transcriptions:submit`, () => ({ status: 201, json: { self: `${SPEECH}/speechtotext/transcriptions/j?api-version=2024-11-15` } })]]);
    await quiet(() => pipeline.processSession(envMod.recordingEnv(), { live: LIVE, dl: pipeline.deadline(8000), analysis: false }));
    assert.equal(calls.filter(c => c.url.includes(':submit')).length, submit, label);
    assert.equal(calls.filter(c => c.url.includes(':transcribe')).length, 0, label + ': never fast in a short call');
    delete process.env.VERCEL_URL;
  }
  setEnv(false);
});

test('kick: room_finished wakes the server up (production domain, CRON_SECRET); the cron call chains itself while processing', async () => {
  assert.equal(envMod.kickBase({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'teroclass.com', VERCEL_URL: 'x.vercel.app' }), 'https://teroclass.com');
  assert.equal(envMod.kickBase({ VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'teroclass.com', VERCEL_URL: 'x.vercel.app' }), 'https://x.vercel.app');
  assert.equal(envMod.kickBase({ VERCEL_URL: 'evil.com/path?x' }), '');
  assert.equal(envMod.kickBase({}), '');
  setEnv(true, { RECORDING_KICK_HOST: 'teroclass.com' });
  let calls = mockNet([
    rpc('rec_room_finished', () => ({ json: { ok: true, status: 'processing', live_session_id: LIVE } })), freshWork(),
    ['https://teroclass.com/api/class/process', () => ({ json: { ok: true } })]]);
  let r = res(); await quiet(() => webhookMod.default(hook({ event: 'room_finished', room: { name: ROOM } }), r));
  assert.equal(r.statusCode, 200);
  const k = calls.filter(c => c.url.startsWith('https://teroclass.com/'));
  assert.equal(k.length, 1); assert.equal(k[0].url, 'https://teroclass.com/api/class/process?hop=0');
  assert.equal(k[0].headers.Authorization, 'Bearer ' + ENV.CRON_SECRET);
  assert.equal(calls.filter(c => c.url.includes(':submit') || c.url.includes(':transcribe')).length, 0, 'the webhook leaves it to the long call');
  // the kicked call: still processing → next hop; ready → stops; bad hop → 400; daily cron (no hop) runs retention
  process.env.RECORDING_KICK_WAIT_MS = '1';
  const get = async (q, state) => {
    calls = mockNet([rpc('rec_work', () => ({ json: state ? [{ id: LIVE, status: state, started_at: new Date(T0).toISOString(),
        recordings: [{ id: 'w1', status: 'uploaded', speech_status: 'submitted', speech_job: `${SPEECH}/speechtotext/transcriptions/W`, started_at: new Date(T0).toISOString() }] }] : [] })),
      [`${SPEECH}/speechtotext/transcriptions/W`, () => ({ json: { status: 'Running' } })],
      rpc('recordings_due_for_deletion', () => ({ json: [] })), ['https://teroclass.com/api/class/process', () => ({ json: { ok: true } })]]);
    const rr = res(); await quiet(() => classFn({ method: 'GET', query: { action: 'process', ...q }, headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }, rr));
    return rr;
  };
  r = await get({ hop: '3' }, 'processing');
  assert.equal(r.statusCode, 200); assert.equal(r.body.next, 4); assert.equal(r.body.retention, null);
  assert.equal(calls.filter(c => c.url === 'https://teroclass.com/api/class/process?hop=4').length, 1);
  r = await get({ hop: String(pipeline.MAX_KICKS) }, 'processing'); assert.equal(r.body.next, null, 'stops after MAX_KICKS');
  r = await get({ hop: '2' }, null); assert.equal(r.body.next, null, 'nothing processing: no more kicks');
  r = await get({ hop: '-1' }, null); assert.equal(r.statusCode, 400);
  r = await get({}, null); assert.ok(r.body.retention, 'daily cron: retention'); assert.equal(r.body.hop, null);
  delete process.env.RECORDING_KICK_WAIT_MS;
  setEnv(false);
});

test('fast transcript parser: phrases → segments, junk ignored', () => {
  assert.deepEqual(az.parseFastTranscript({ phrases: [{ offsetMilliseconds: 2000, durationMilliseconds: 500, text: ' Hi  there ' }, { text: 'no offset' }, { offsetMilliseconds: 10, text: '' }, null] }, 1000),
    [{ start_ms: 3000, end_ms: 3500, text: 'Hi there', words: 2 }]);
  assert.deepEqual(az.parseFastTranscript(null), []);
});
