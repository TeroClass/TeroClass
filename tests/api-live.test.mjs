// Unit tests for the live-classroom API (no network: fetch is mocked).
// Usage: node --no-warnings --test tests/api-live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const tokenMod = await import('../api/class/token.js');
const configMod = await import('../api/class/config.js');
const webhookMod = await import('../api/livekit/webhook.js');
const lib = await import('../api/_lib/livekit.js');

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000001', email: 'profe@tec.com', user_metadata: { name: 'Profe' } };
const ENV = { LIVEKIT_URL: 'wss://teroclass-br.livekit.cloud', LIVEKIT_API_KEY: 'APIdemoKey123', LIVEKIT_API_SECRET: 'super-secret-value-for-tests-0123456789' };

function setEnv(on) { for (const [k, v] of Object.entries(ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } }
// my_consent (001_base.sql): the token reads the caller's consent from the database (never from the body)
const GRANTED = { current_version: '2026-10', status: 'granted', granted: true, recorded: true, version: '2026-10', minor: false, guardian_consent: null };
function mockFetch({ user = USER, role = 'teacher', liveRole = null, liveFail = false, consent = GRANTED, adhoc = null, dbName = 'Profe <b>Ana</b>' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const auth = opts?.headers?.Authorization || '';
    const ok = user && auth === 'Bearer good-token';
    if (String(url).endsWith('/auth/v1/user')) return new Response(JSON.stringify(ok ? user : { msg: 'bad jwt' }), { status: ok ? 200 : 401 });
    if (String(url).endsWith('/rest/v1/rpc/live_room_role')) return liveFail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(ok ? liveRole : null), { status: ok ? 200 : 401 });
    // TC-13: ad-hoc rooms → the database says host (creator) / guest (staff of the same account) / null
    if (String(url).endsWith('/rest/v1/rpc/adhoc_room_access')) { const k = JSON.parse(opts.body).p_owner_key; return new Response(JSON.stringify(ok ? (k === tokenMod.ownerKey(USER.id) ? 'host' : adhoc) : null), { status: ok ? 200 : 401 }); }
    if (String(url).endsWith('/rest/v1/rpc/live_display_name')) return new Response(JSON.stringify(ok ? dbName : null), { status: ok ? 200 : 401 });
    if (String(url).endsWith('/rest/v1/rpc/my_consent')) return new Response(JSON.stringify(ok ? consent : { message: 'JWT' }), { status: ok ? 200 : 401 });
    if (String(url).includes('/rest/v1/profiles')) return new Response(JSON.stringify(ok ? [{ role, institution_id: null }] : []), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return calls;
}
function res() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const room = `${tokenMod.ownerKey(USER.id)}-abc123`;
const goodBody = { room, role: 'teacher', name: 'Someone Else', consent: { recording: true, ai_analysis: true, storage: false } }; // name: ignored (TC-27)
const b64d = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('config: configured false/true without leaking secrets', async () => {
  setEnv(false); let r = res(); configMod.default({ method: 'GET' }, r);
  assert.deepEqual(r.body, { configured: false });
  setEnv(true); r = res(); configMod.default({ method: 'GET' }, r);
  assert.deepEqual(r.body, { configured: true });
  assert.ok(!JSON.stringify(r.body).includes(ENV.LIVEKIT_API_SECRET));
  setEnv(false);
});

test('token: 401 without a valid Supabase user', async () => {
  setEnv(true); mockFetch();
  let r = res(); await tokenMod.default({ method: 'POST', headers: {}, body: goodBody }, r);
  assert.equal(r.statusCode, 401);
  r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer forged' }, body: goodBody }, r);
  assert.equal(r.statusCode, 401);
  setEnv(false);
});

test('token: 501 {configured:false} when LiveKit env vars are missing', async () => {
  setEnv(false); mockFetch();
  const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: goodBody }, r);
  assert.equal(r.statusCode, 501);
  assert.equal(r.body.configured, false);
  process.env.LIVEKIT_URL = ENV.LIVEKIT_URL; // partial config is still "not configured"
  const r2 = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: goodBody }, r2);
  assert.equal(r2.statusCode, 501);
  setEnv(false);
});

test('token: 405 for GET', async () => {
  const r = res(); await tokenMod.default({ method: 'GET', headers: {} }, r);
  assert.equal(r.statusCode, 405);
});

test('token: valid LiveKit JWT (structure, claims, HS256 signature)', async () => {
  setEnv(true); mockFetch();
  const before = Math.floor(Date.now() / 1000);
  const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: goodBody }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, ENV.LIVEKIT_URL);
  const [h, p, s] = r.body.token.split('.');
  assert.deepEqual(b64d(h), { alg: 'HS256', typ: 'JWT' });
  const expected = createHmac('sha256', ENV.LIVEKIT_API_SECRET).update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected);
  const c = b64d(p);
  assert.equal(c.iss, ENV.LIVEKIT_API_KEY);
  assert.equal(c.sub, USER.id);
  assert.equal(c.name, 'Profe bAna/b');
  assert.ok(c.nbf >= before && c.exp - c.nbf === tokenMod.TOKEN_TTL_S);
  assert.deepEqual(c.video, { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: true });
  const md = JSON.parse(c.metadata);
  assert.equal(md.role, 'teacher');
  assert.deepEqual(md.consent, { recording: true, ai_analysis: true, storage: true }); // one consent covers all three (from the DB)
  assert.equal(md.recorded, true);
  assert.ok(!r.body.token.includes(ENV.LIVEKIT_API_SECRET));
  // also verifies with the shared verifier
  assert.equal(lib.verifyJwt(r.body.token, ENV.LIVEKIT_API_SECRET).sub, USER.id);
  assert.throws(() => lib.verifyJwt(r.body.token, 'wrong-secret'), /bad signature/);
  setEnv(false);
});

test('token: students get no roomAdmin; teachers only in their own rooms', async () => {
  setEnv(true); mockFetch({ adhoc: 'guest' });
  let r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { ...goodBody, role: 'student', room: 'ffffffffffff-x1' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(b64d(r.body.token.split('.')[1]).video.roomAdmin, undefined);
  r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { ...goodBody, room: 'ffffffffffff-x1' } }, r);
  assert.equal(r.statusCode, 403);
  setEnv(false);
});

test('TC-13: ad-hoc rooms are closed to anyone the database does not allow (students, other institutions, made-up names)', async () => {
  setEnv(true); mockFetch({ adhoc: null });
  const call = async b => { const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: b }, r); return r; };
  assert.equal((await call({ ...goodBody, role: 'student', room: 'ffffffffffff-x1' })).statusCode, 403, 'not the same account');
  assert.equal((await call({ ...goodBody, role: 'student', room: 'otherroom-1' })).statusCode, 403, 'not a TeroClass room name');
  assert.equal((await call({ ...goodBody, role: 'student', room })).statusCode, 200, 'the creator can always join their own room');
  setEnv(false);
});

test('TC-27: the name in the room comes from the database, never from the request body', async () => {
  setEnv(true); mockFetch({ dbName: 'Ana Loaded' });
  const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { ...goodBody, name: 'Docente' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(b64d(r.body.token.split('.')[1]).name, 'Ana Loaded');
  setEnv(false);
});

test('token: input validation; consent fields of the body are ignored (see tests/api-consent.test.mjs)', async () => {
  setEnv(true); mockFetch();
  const call = async body => { const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body }, r); return r; };
  assert.equal((await call({ ...goodBody, room: 'bad room!' })).statusCode, 400);
  assert.equal((await call({ ...goodBody, role: 'admin' })).statusCode, 400);
  // the old client-side "minor without guardian" check is gone: the database decides (a minor's "yes" needs a guardian there)
  assert.equal((await call({ ...goodBody, role: 'student', minor: true })).statusCode, 200);
  const v = tokenMod.validateBody({ room, role: 'student', consent: { recording: true }, minor: true, guardian: { name: 'x' } });
  assert.deepEqual(v, { room, role: 'student', name: undefined });
  setEnv(false);
});

// ── webhook ──
function signedWebhook(body, { secret = ENV.LIVEKIT_API_SECRET, iss = ENV.LIVEKIT_API_KEY, hashOf = body } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return lib.signJwt({ iss, nbf: now, exp: now + 300, sha256: createHash('sha256').update(hashOf).digest('base64') }, secret);
}
const EVENT = JSON.stringify({ event: 'room_started', room: { name: room }, id: 'EV_1', createdAt: '1760000000' });
function streamReq(body, auth) {
  const s = Readable.from([Buffer.from(body)]);
  s.method = 'POST'; s.headers = { authorization: auth, 'content-type': 'application/webhook+json' };
  return s;
}

test('webhook: verifyWebhook accepts a valid signature and rejects tampering', () => {
  const env = { apiKey: ENV.LIVEKIT_API_KEY, apiSecret: ENV.LIVEKIT_API_SECRET };
  assert.equal(webhookMod.verifyWebhook(EVENT, signedWebhook(EVENT), env).event, 'room_started');
  assert.throws(() => webhookMod.verifyWebhook(EVENT + ' ', signedWebhook(EVENT), env), /sha256/);
  assert.throws(() => webhookMod.verifyWebhook(EVENT, signedWebhook(EVENT, { secret: 'nope' }), env), /bad signature/);
  assert.throws(() => webhookMod.verifyWebhook(EVENT, signedWebhook(EVENT, { iss: 'OTHER' }), env), /issuer/);
  assert.throws(() => webhookMod.verifyWebhook(EVENT, '', env), /empty/);
});

test('webhook handler: 501 unconfigured, 200 valid (raw stream), 401 invalid', async () => {
  setEnv(false);
  let r = res(); await webhookMod.default(streamReq(EVENT, signedWebhook(EVENT)), r);
  assert.equal(r.statusCode, 501);
  setEnv(true);
  const log = console.log; const warn = console.warn; console.log = () => {}; console.warn = () => {};
  try {
    r = res(); await webhookMod.default(streamReq(EVENT, signedWebhook(EVENT)), r);
    assert.equal(r.statusCode, 200);
    r = res(); await webhookMod.default(streamReq(EVENT.replace('room_started', 'room_finished'), signedWebhook(EVENT)), r);
    assert.equal(r.statusCode, 401);
    // body already consumed by helpers → string fallback
    r = res(); await webhookMod.default({ method: 'POST', readableEnded: true, body: EVENT, headers: { authorization: signedWebhook(EVENT) } }, r);
    assert.equal(r.statusCode, 200);
  } finally { console.log = log; console.warn = warn; setEnv(false); }
});

test('token: calendar class rooms are authorized by the database (teacher hosts, students join, others denied)', async () => {
  const sid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.equal(tokenMod.sessionIdFromRoom('sess-' + sid.replace(/-/g, '')), sid);
  assert.equal(tokenMod.sessionIdFromRoom('sess-xyz'), null);
  const body = role => ({ ...goodBody, role, room: 'sess-' + sid.replace(/-/g, '') });
  const call = async b => { const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: b }, r); return r; };
  setEnv(true);
  let calls = mockFetch({ liveRole: 'teacher' });
  let r = await call(body('teacher'));
  assert.equal(r.statusCode, 200); assert.equal(b64d(r.body.token.split('.')[1]).video.roomAdmin, true);
  assert.ok(calls.some(c => c.url.endsWith('/rpc/live_room_role') && JSON.parse(c.opts.body).p_session === sid));
  mockFetch({ liveRole: 'student' });
  r = await call(body('student')); assert.equal(r.statusCode, 200); assert.equal(b64d(r.body.token.split('.')[1]).video.roomAdmin, undefined);
  r = await call(body('teacher')); assert.equal(r.statusCode, 403);
  for (const lr of [null, 'admin']) { mockFetch({ liveRole: lr }); r = await call(body('student')); assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'not_member'); }
  mockFetch({ liveFail: true }); r = await call(body('student')); assert.equal(r.statusCode, 503);
  setEnv(false);
});
