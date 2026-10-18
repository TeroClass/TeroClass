// Unit tests for the AI request metadata (Insights): api/_lib/meta.js and how api/generate.js sends it.
// No network: fetch is mocked. Usage: node --no-warnings --test tests/api-meta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AZURE_OPENAI_ENDPOINT = 'https://azure.example.com/';
process.env.AZURE_OPENAI_API_KEY = 'azure-secret';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const gen = (await import('../api/generate.js')).default;
const { sanitizeMeta } = await import('../api/_lib/meta.js');

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000001', email: 'profe@tec.com' };
const AZURE_OK = { choices: [{ message: { content: 'Class plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

function mock({ quota = { allowed: true, used: 1, limit: 60, event: 41 }, quotaStatus = 200, quotaV2 = 'ok', azureStatus = 200, azure = AZURE_OK, finishStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const h = opts.headers || {};
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, headers: h, body });
    const j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/auth/v1/user')) return h.Authorization === 'Bearer good-token' ? j(200, USER) : j(401, { msg: 'bad jwt' });
    if (u.endsWith('/rpc/consume_ai_quota')) {
      // quotaV2 = 'missing': database without the p_meta version (PostgREST: function not found)
      if (body && 'p_meta' in body && quotaV2 === 'missing') return j(404, { code: 'PGRST202', message: 'Could not find the function public.consume_ai_quota(p_meta)' });
      return j(quotaStatus, quotaStatus === 200 ? quota : { message: 'boom' });
    }
    if (u.endsWith('/rpc/finish_ai_event')) return j(finishStatus, finishStatus === 200 ? true : { message: 'boom' });
    if (u.startsWith('https://azure.example.com/')) return j(azureStatus, azure);
    return j(404, {});
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
const req = (body = {}) => ({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { messages: [{ role: 'user', content: 'Hola' }], ...body } });
const by = (calls, end) => calls.filter(c => c.url.endsWith(end));
const order = calls => calls.map(c => c.url.replace(/^.*\/(rpc\/)?/, '').replace(/\?.*$/, ''));

test('sanitizeMeta: whitelists values, trims subjects, clamps bars, drops everything else', () => {
  const m = sanitizeMeta({
    subjects: ['  Math  ', 'math', 'Bio\u0000logy <b>', 42, 'History', 'Art', 'Music', 'Geo', 'x'.repeat(200)],
    language: 'Spanish', age_band: 'teen', level: 'Secondary',
    bars: { gamification: 70.4, pbl: 150, neg: -3, 'Bad Key': 5, collab: 'x', nan: NaN, inf: Infinity, __proto__x: 5 },
    institution_id: 'evil', user_id: 'evil', inst_id: 'evil', root_id: 'evil', email: 'a@b.c', extra: { deep: true },
  }, 'generate');
  assert.deepEqual(m, {
    kind: 'generate', subjects: ['Math', 'Bio logy b', 'History', 'Art', 'Music'],
    language: 'Spanish', age_band: 'teen', level: 'Secondary', bars: { gamification: 70, pbl: 100, neg: 0 },
  });
});

test('sanitizeMeta: unknown or wrong-typed values are dropped; kind defaults', () => {
  assert.deepEqual(sanitizeMeta({ language: 'Klingon', age_band: 'old', level: 'Wizard', subjects: 'Math', bars: [1, 2] }, '<script>'), { kind: 'other', subjects: [] });
  assert.deepEqual(sanitizeMeta(null, undefined), { kind: 'generate', subjects: [] });
  assert.deepEqual(sanitizeMeta([1, 2, 3], 'student'), { kind: 'student', subjects: [] });
  assert.deepEqual(sanitizeMeta('meta', 'verify'), { kind: 'verify', subjects: [] });
  for (const k of ['generate', 'continue', 'verify', 'student', 'playbook']) assert.equal(sanitizeMeta({}, k).kind, k);
  const many = {}; for (let i = 0; i < 40; i++) many['k' + i] = i;
  assert.equal(Object.keys(sanitizeMeta({ bars: many }, 'generate').bars).length, 20, 'at most 20 bars');
  assert.equal(sanitizeMeta({ subjects: ['  ', '<>'] }, 'generate').subjects.length, 0);
  assert.equal(sanitizeMeta({ subjects: ['a'.repeat(200)] }, 'generate').subjects[0].length, 60);
});

test('generate: sends the sanitized meta with the user token (no service key), then marks the event ok', async () => {
  const calls = mock();
  const r = res();
  await gen(req({ kind: 'student', meta: { subjects: ['Math'], language: 'Spanish', age_band: 'teen', institution_id: 'evil', user_id: 'evil' } }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(order(calls), ['user', 'consume_ai_quota', 'completions', 'finish_ai_event']);
  const q = by(calls, '/rpc/consume_ai_quota')[0];
  assert.equal(q.headers.Authorization, 'Bearer good-token');
  assert.deepEqual(q.body, { p_meta: { kind: 'student', subjects: ['Math'], language: 'Spanish', age_band: 'teen' } });
  const f = by(calls, '/rpc/finish_ai_event')[0];
  assert.equal(f.headers.Authorization, 'Bearer good-token');
  assert.deepEqual(f.body, { p_event: 41, p_ok: true });
  assert.ok(!JSON.stringify(r.body).includes('"event"'), 'event id not sent to the browser');
});

test('generate: a request without meta is still recorded (kind only)', async () => {
  const calls = mock();
  await gen(req({ kind: 'playbook' }), res());
  assert.deepEqual(by(calls, '/rpc/consume_ai_quota')[0].body, { p_meta: { kind: 'playbook', subjects: [] } });
});

test('generate: Azure errors / content filter mark the event as failed', async () => {
  let calls = mock({ azureStatus: 500, azure: { error: { message: 'down' } } });
  let r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 502);
  assert.deepEqual(by(calls, '/rpc/finish_ai_event')[0].body, { p_event: 41, p_ok: false });
  calls = mock({ azure: { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] } });
  r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 422);
  assert.deepEqual(by(calls, '/rpc/finish_ai_event')[0].body, { p_event: 41, p_ok: false });
});

test('generate: finish failure never breaks the answer; no event → no finish call', async () => {
  let calls = mock({ finishStatus: 500 });
  let r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 200);
  calls = mock({ quota: { allowed: true, used: 1, limit: 60 } });
  r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(by(calls, '/rpc/finish_ai_event').length, 0);
  calls = mock({ quota: { allowed: true, used: 1, limit: 60, event: 'x; drop table' } });
  r = res(); await gen(req(), r);
  assert.equal(by(calls, '/rpc/finish_ai_event').length, 0, 'only a positive integer event id is used');
});

test('generate: database without the meta version → retries without meta (generation still works)', async () => {
  const calls = mock({ quotaV2: 'missing', quota: { allowed: true, used: 2, limit: 60 } });
  const r = res(); await gen(req({ meta: { subjects: ['Math'] } }), r);
  assert.equal(r.statusCode, 200);
  const q = by(calls, '/rpc/consume_ai_quota');
  assert.equal(q.length, 2);
  assert.ok('p_meta' in q[0].body); assert.deepEqual(q[1].body, {});
});

test('generate: quota still fails closed (503, Azure not called), and 429 records nothing more', async () => {
  let calls = mock({ quotaStatus: 500 });
  let r = res(); await gen(req({ meta: { subjects: ['Math'] } }), r);
  assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'quota_check');
  assert.equal(calls.filter(c => c.url.startsWith('https://azure.example.com/')).length, 0);
  assert.equal(by(calls, '/rpc/consume_ai_quota').length, 1, 'no retry on a real error');
  calls = mock({ quota: { allowed: false, used: 60, limit: 60 } });
  r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 429);
  assert.equal(by(calls, '/rpc/finish_ai_event').length, 0);
});
