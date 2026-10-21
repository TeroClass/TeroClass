// Recording consent on the server (no network: fetch is mocked).
//  · api/_lib/class/token.js: recorded / consent / minor / guardian_consent come from my_consent() (database, caller's own
//    session), never from the request body; declined / revoked / outdated / minor without guardian / DB failure → not recorded.
//  · api/_lib/notify/consent.js: no-op without RESEND_API_KEY (or the service key); otherwise the admins' emails come from the
//    service-only payload and are sent through Resend; keys never echoed.
//  · The consent text version is the same in the database, the API and the browser.
// Usage: node --no-warnings --test tests/api-consent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tokenMod = await import('../api/_lib/class/token.js');
const notifyMod = await import('../api/_lib/notify/consent.js');

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000002', email: 'alumna@tec.com', user_metadata: { name: 'Alumna' } };
const ENV = { LIVEKIT_URL: 'wss://teroclass-br.livekit.cloud', LIVEKIT_API_KEY: 'APIdemoKey123', LIVEKIT_API_SECRET: 'super-secret-value-for-tests-0123456789' };
const V = tokenMod.CONSENT_VERSION;
const GRANTED = { current_version: V, status: 'granted', granted: true, recorded: true, version: V, minor: false, guardian_consent: null };
const NONE = { current_version: V, status: 'none', granted: false, recorded: false, version: null, minor: false, guardian_consent: null };
const REVOKED = { ...NONE, status: 'revoked', revoked_at: '2026-10-19T10:00:00Z' };
const OUTDATED = { current_version: V, status: 'outdated', granted: false, recorded: false, version: '2025-01', minor: false };
const MINOR_OK = { ...GRANTED, minor: true, guardian_consent: true };

function setEnv(on) { for (const [k, v] of Object.entries(ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } }
function mockFetch({ consent = GRANTED, consentStatus = 200, liveRole = 'student', resend = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url); calls.push({ url: u, opts });
    const auth = opts?.headers?.Authorization || '';
    const ok = auth === 'Bearer good-token';
    if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify(ok ? USER : { msg: 'bad jwt' }), { status: ok ? 200 : 401 });
    if (u.endsWith('/rest/v1/rpc/my_consent')) return new Response(JSON.stringify(ok ? consent : { message: 'JWT' }), { status: ok ? consentStatus : 401 });
    if (u.endsWith('/rest/v1/rpc/live_room_role')) return new Response(JSON.stringify(ok ? liveRole : null), { status: ok ? 200 : 401 });
    if (u.includes('/rest/v1/profiles')) return new Response(JSON.stringify([{ role: 'teacher', institution_id: null }]), { status: 200 });
    if (u.endsWith('/rest/v1/rpc/consent_decline_notify_payload')) return new Response(JSON.stringify([
      { id: 'd1', role: 'student', name: 'Equis <b>Uno</b>', unit_name: 'Sede 1', class_title: 'Química 3°B', created_at: '2026-10-20T13:00:00Z',
        reason: 'Prefiero no <script>x</script> ser grabado', recipients: ['adm@a.com', 'ADM@a.com', 'bad', 's1adm@a.com'] },
      { id: 'd2', role: 'teacher', name: 'Nadie', unit_name: 'U', reason: 'Sin admins para avisar', recipients: [] }]), { status: 200 });
    if (u === 'https://api.resend.com/emails') return new Response('{}', { status: resend });
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
const b64d = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
const room = 'sess-' + '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d';
// a client that LIES: claims full consent, minor with guardian, etc.
const lyingBody = { room, role: 'student', name: 'Alumna', recorded: true, consent: { recording: true, ai_analysis: true, storage: true },
  minor: true, guardian: { name: 'Laura Pérez', email: 'laura@example.com', consent: true }, guardianOk: true };
async function token(body, opts) {
  const calls = mockFetch(opts);
  const r = res(); await tokenMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body }, r);
  const md = r.body?.token ? JSON.parse(b64d(r.body.token.split('.')[1]).metadata) : null;
  return { r, md, calls };
}

test('version: database, API and browser use the same consent version', () => {
  const sql = readFileSync(new URL('../supabase/migrations/001_base.sql', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/live-class.js', import.meta.url), 'utf8');
  const sqlV = /function public\.tc_consent_version\(\)[\s\S]*?select '([^']+)'::text/.exec(sql)?.[1];
  const jsV = /const CONSENT_VERSION = '([^']+)'/.exec(js)?.[1];
  assert.ok(V && sqlV && jsV); assert.equal(sqlV, V); assert.equal(jsV, V);
});

test('token: recorded comes from my_consent() (asked with the caller\'s own session), not from the body', async () => {
  setEnv(true);
  const { r, md, calls } = await token(lyingBody, { consent: NONE });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = calls.find(x => x.url.endsWith('/rpc/my_consent'));
  assert.ok(c, 'my_consent was not called'); assert.equal(c.opts.headers.Authorization, 'Bearer good-token');
  assert.equal(r.body.recorded, false); assert.equal(md.recorded, false);
  assert.deepEqual(md.consent, { recording: false, ai_analysis: false, storage: false });
  assert.equal(md.minor, false); assert.equal(md.guardian_consent, null);
  setEnv(false);
});

test('token: granted in the DB → recorded even if the body says nothing', async () => {
  setEnv(true);
  const { r, md } = await token({ room, role: 'student', name: 'Alumna' }, { consent: GRANTED });
  assert.equal(r.body.recorded, true); assert.equal(md.recorded, true);
  assert.deepEqual(md.consent, { recording: true, ai_analysis: true, storage: true });
  assert.equal(md.consent_version, V);
  setEnv(false);
});

test('token: declined / revoked / outdated version → not recorded (they can still join)', async () => {
  setEnv(true);
  for (const consent of [NONE, REVOKED, OUTDATED, { ...GRANTED, version: '2025-01' }, { ...GRANTED, current_version: '2099-01' }]) {
    const { r, md } = await token(lyingBody, { consent });
    assert.equal(r.statusCode, 200); assert.equal(r.body.recorded, false, JSON.stringify(consent)); assert.equal(md.recorded, false);
  }
  setEnv(false);
});

test('token: minor — recorded only with the guardian\'s consent; guardian data never in the metadata', async () => {
  setEnv(true);
  let { r, md } = await token(lyingBody, { consent: MINOR_OK });
  assert.equal(r.body.recorded, true); assert.equal(md.minor, true); assert.equal(md.guardian_consent, true);
  assert.ok(!JSON.stringify(md).toLowerCase().includes('laura') && !r.body.token.includes('laura'));
  ({ r, md } = await token(lyingBody, { consent: { ...GRANTED, minor: true, guardian_consent: false } }));   // minor without guardian
  assert.equal(r.body.recorded, false); assert.equal(md.recorded, false); assert.equal(md.guardian_consent, false);
  ({ r, md } = await token(lyingBody, { consent: { ...NONE, minor: false } }));
  assert.equal(md.minor, false, 'the body cannot make someone a minor');
  setEnv(false);
});

test('token: if the consent cannot be read (DB error / garbage) the person joins NOT recorded', async () => {
  setEnv(true);
  for (const opts of [{ consentStatus: 500 }, { consent: 'nope' }, { consent: null }]) {
    const { r, md } = await token(lyingBody, opts);
    assert.equal(r.statusCode, 200); assert.equal(r.body.recorded, false); assert.equal(md.recorded, false);
  }
  setEnv(false);
});

test('token: consentFlags is strict', () => {
  assert.equal(tokenMod.consentFlags(GRANTED).recorded, true);
  assert.equal(tokenMod.consentFlags({ ...GRANTED, recorded: false }).recorded, false);
  assert.equal(tokenMod.consentFlags({ ...GRANTED, granted: 'true' }).recorded, false);
  assert.equal(tokenMod.consentFlags(undefined).recorded, false);
});

// ── notify/consent ──
test('notify/consent: without RESEND_API_KEY (or the service key) it is a no-op and reads nothing', async () => {
  delete process.env.RESEND_API_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let calls = mockFetch();
  let r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: {} }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.configured, false); assert.equal(calls.length, 0);
  process.env.RESEND_API_KEY = 're_test_secret_key';
  calls = mockFetch();
  r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: {} }, r);
  assert.equal(r.body.configured, false, 'needs the service key to read the admins\' emails'); assert.equal(calls.length, 0);
  const g = res(); await notifyMod.default({ method: 'GET', headers: {} }, g); assert.equal(g.statusCode, 405);
  delete process.env.RESEND_API_KEY;
});

test('notify/consent: with keys → caller must be signed in; admins from the service payload; escaped; keys never echoed', async () => {
  process.env.RESEND_API_KEY = 're_test_secret_key'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret-xyz';
  const log = console.error; console.error = () => {};
  try {
    let calls = mockFetch();
    let r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer forged' }, body: {} }, r);
    assert.equal(r.statusCode, 401);
    assert.ok(!calls.some(c => c.url.includes('notify_payload')), 'no payload for an unknown caller');
    calls = mockFetch();
    r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token', host: 'app.teroclass.test' }, body: { lang: 'es' } }, r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { configured: true, sent: 1, failed: 0 });
    const p = calls.find(c => c.url.endsWith('/rpc/consent_decline_notify_payload'));
    assert.equal(p.opts.headers.apikey, 'service-secret-xyz'); assert.equal(JSON.parse(p.opts.body).p_user, USER.id);
    const sentMail = calls.filter(c => c.url === 'https://api.resend.com/emails').map(c => JSON.parse(c.opts.body));
    assert.equal(sentMail.length, 1, 'a decline without admins sends nothing');
    assert.deepEqual(sentMail[0].to, ['adm@a.com', 's1adm@a.com']);
    assert.ok(/no aceptó que se graben sus clases/.test(sentMail[0].subject));
    assert.ok(!sentMail[0].html.includes('<script>') && sentMail[0].html.includes('&lt;script&gt;') && sentMail[0].html.includes('Equis &lt;b&gt;Uno&lt;/b&gt;'));
    assert.ok(!JSON.stringify(r.body).includes('re_test_secret_key') && !JSON.stringify(r.body).includes('service-secret-xyz'));
    // Resend failure is reported, not thrown
    mockFetch({ resend: 500 });
    r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: {} }, r);
    assert.deepEqual(r.body, { configured: true, sent: 0, failed: 1 });
  } finally { console.error = log; delete process.env.RESEND_API_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('notify/consent: email builder in English', () => {
  const e = notifyMod.buildDeclineEmails([{ role: 'teacher', name: 'Prof\nX', unit_name: 'U', reason: 'Not today please', recipients: ['a@b.com'] }], { lang: 'en', origin: 'https://x.test', from: 'T <t@x.test>' });
  assert.equal(e.length, 1); assert.ok(/did not agree/.test(e[0].subject) && !/\n/.test(e[0].subject)); assert.ok(e[0].html.includes('Teacher'));
});
