// Unit tests for api/generate.js (AI token budget) and api/billing/status.js. No network: fetch is mocked.
// Usage: node --no-warnings --test tests/api-billing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AZURE_OPENAI_ENDPOINT = 'https://azure.example.com/';
process.env.AZURE_OPENAI_API_KEY = 'azure-secret';
const gen = (await import('../api/generate.js')).default;
const { appBody } = await import('./ai-fixtures.mjs');
const status = (await import('../api/billing/status.js')).default;

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000001', email: 'profe@tec.com' };
const JWT_KEY = 'eyJhbGciOiJIUzI1NiJ9.service.role';
const NEW_KEY = 'sb_secret_abcdefghijklmnopqrstuvwxyz';
const AZURE_OK = { choices: [{ message: { content: 'Class plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 } };

function mock({ quota = { allowed: true, used: 1, limit: 60 }, budget = { allowed: true, scope: 'institution', remaining: 5000, warn: false },
  after = { allowed: true, scope: 'institution', remaining: 3000, warn: true, allowance: 10000, root_id: 'secret-root' }, budgetStatus = 200, recordStatus = 200,
  azure = AZURE_OK, azureStatus = 200, ping = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const h = opts.headers || {};
    calls.push({ url: u, headers: h, body: opts.body ? JSON.parse(opts.body) : null });
    const j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/auth/v1/user')) return h.Authorization === 'Bearer good-token' ? j(200, USER) : j(401, { msg: 'bad jwt' });
    if (u.endsWith('/rpc/ip_rate_hit')) return j(200, true);
    if (u.endsWith('/rpc/consume_ai_quota')) return j(200, quota);
    if (u.endsWith('/rpc/ai_budget_check')) return j(budgetStatus, budgetStatus === 200 ? budget : { message: 'boom' });
    if (u.endsWith('/rpc/ai_record_usage')) return j(recordStatus, recordStatus === 200 ? after : { message: 'boom' });
    if (u.endsWith('/rpc/billing_service_ping')) return ping === 'fail' ? j(401, { message: 'Invalid API key' }) : j(200, ping);
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
// the app's own request shapes (api/_lib/guard.js refuses anything else, TC-01)
const req = (body = {}) => ({ method: 'POST', headers: { authorization: 'Bearer good-token', 'x-forwarded-for': '203.0.113.7' }, body: { ...appBody(body.kind || 'generate'), ...body } });
const setKey = k => { if (k) process.env.SUPABASE_SERVICE_ROLE_KEY = k; else delete process.env.SUPABASE_SERVICE_ROLE_KEY; };
const by = (calls, end) => calls.filter(c => c.url.endsWith(end));
const azureCalls = calls => calls.filter(c => c.url.startsWith('https://azure.example.com/'));

test('without SUPABASE_SERVICE_ROLE_KEY: works as before, no budget calls, warns once', async () => {
  setKey(null); const calls = mock();
  const warns = []; const ow = console.warn; console.warn = m => warns.push(String(m));
  try {
    const r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.choices[0].message.content, 'Class plan');
    assert.equal(r.body.budget, null);
    assert.equal(by(calls, '/rpc/ai_budget_check').length, 0);
    assert.equal(by(calls, '/rpc/ai_record_usage').length, 0);
    await gen(req(), res());
    assert.equal(warns.filter(w => /SUPABASE_SERVICE_ROLE_KEY/.test(w)).length, 1);
  } finally { console.warn = ow; }
});

test('with the key: daily limit (user JWT) → budget check (service key) → Azure → record real usage', async () => {
  setKey(JWT_KEY); const calls = mock();
  const r = res(); await gen(req({ kind: 'student' }), r);
  assert.equal(r.statusCode, 200);
  const order = calls.map(c => c.url.replace(/^.*\/(rpc\/)?/, '').replace(/\?.*$/, ''));
  assert.deepEqual(order, ['user', 'ip_rate_hit', 'consume_ai_quota', 'ai_budget_check', 'completions', 'ai_record_usage']);
  const q = by(calls, '/rpc/consume_ai_quota')[0]; assert.equal(q.headers.Authorization, 'Bearer good-token');
  const b = by(calls, '/rpc/ai_budget_check')[0];
  assert.equal(b.headers.apikey, JWT_KEY); assert.equal(b.headers.Authorization, 'Bearer ' + JWT_KEY);
  assert.deepEqual(b.body, { p_user: USER.id });
  const rec = by(calls, '/rpc/ai_record_usage')[0];
  assert.deepEqual(rec.body, { p_user: USER.id, p_prompt: 1200, p_completion: 800, p_kind: 'student' });
  assert.deepEqual(r.body.budget, { scope: 'institution', remaining: 3000, warn: true, allowance: 10000 });
  const out = JSON.stringify(r.body);
  assert.ok(!out.includes(JWT_KEY) && !out.includes('secret-root'), 'no key / internal ids in the response');
});

test('new-format secret key goes only in the apikey header; unknown kind → refused before any cost (TC-01)', async () => {
  setKey(NEW_KEY); let calls = mock();
  let r = res(); await gen(req({ kind: '<script>', messages: appBody('generate').messages }), r);
  assert.equal(r.statusCode, 400); assert.equal(r.body.code, 'invalid');
  assert.equal(azureCalls(calls).length, 0); assert.equal(by(calls, '/rpc/consume_ai_quota').length, 0);
  calls = mock();
  r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 200);
  const b = by(calls, '/rpc/ai_budget_check')[0];
  assert.equal(b.headers.apikey, NEW_KEY); assert.equal(b.headers.Authorization, undefined);
  assert.equal(by(calls, '/rpc/ai_record_usage')[0].body.p_kind, 'generate');
});

test('budget used up: 402 with the right message per role; Azure is not called', async () => {
  setKey(JWT_KEY);
  const cases = [
    [{ allowed: false, scope: 'institution', is_admin: false, can_buy: false }, /Tell your admin/, false],
    [{ allowed: false, scope: 'institution', is_admin: true, can_buy: true }, /Buy a token pack/, true],
    [{ allowed: false, scope: 'institution', is_admin: true, can_buy: false }, /main institution's admin/, false],
    [{ allowed: false, scope: 'personal', is_admin: false, can_buy: false, resets_on: '2026-11-01' }, /free AI allowance/, false],
  ];
  for (const [budget, re, canBuy] of cases) {
    const calls = mock({ budget });
    const r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 402);
    assert.equal(r.body.code, 'budget');
    assert.match(r.body.error, re);
    assert.equal(r.body.can_buy, canBuy);
    assert.equal(r.body.scope, budget.scope);
    assert.equal(azureCalls(calls).length, 0);
    assert.equal(by(calls, '/rpc/ai_record_usage').length, 0);
  }
});

test('budget check unavailable: fails closed (503), Azure not called', async () => {
  setKey(JWT_KEY); const calls = mock({ budgetStatus: 500 });
  const errs = []; const oe = console.error; console.error = m => errs.push(String(m));
  try {
    const r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, 'budget_check');
    assert.equal(azureCalls(calls).length, 0);
    assert.ok(!errs.join(' ').includes(JWT_KEY), 'key never logged');
  } finally { console.error = oe; }
});

test('daily request limit is still checked first (429, no budget call)', async () => {
  setKey(JWT_KEY); const calls = mock({ quota: { allowed: false, used: 60, limit: 60 } });
  const r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 429); assert.equal(r.body.code, 'quota');
  assert.equal(by(calls, '/rpc/ai_budget_check').length, 0);
});

test('recording failure does not lose the answer; Azure errors are not recorded', async () => {
  setKey(JWT_KEY);
  const oe = console.error; console.error = () => {};
  try {
    let calls = mock({ recordStatus: 500 });
    let r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.budget, null);
    assert.equal(by(calls, '/rpc/ai_record_usage').length, 1);
    calls = mock({ azureStatus: 500, azure: { error: { message: 'down' } } });
    r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 502);
    assert.equal(by(calls, '/rpc/ai_record_usage').length, 0);
  } finally { console.error = oe; }
});

test('a content-filtered answer that still consumed tokens is recorded', async () => {
  setKey(JWT_KEY);
  const calls = mock({ azure: { choices: [{ message: { content: null }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 900, completion_tokens: 0 } } });
  const r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 422);
  assert.equal(by(calls, '/rpc/ai_record_usage')[0].body.p_prompt, 900);
});

test('billing/status: booleans only, ping only for signed-in users', async () => {
  setKey(null); mock();
  let r = res(); await status({ method: 'GET', headers: {} }, r);
  assert.deepEqual(r.body, { billing_configured: false, billing_ok: null });
  assert.equal(r.headers['Cache-Control'], 'no-store');
  setKey(JWT_KEY); let calls = mock();
  r = res(); await status({ method: 'GET', headers: {} }, r);
  assert.deepEqual(r.body, { billing_configured: true, billing_ok: null });
  assert.equal(by(calls, '/rpc/billing_service_ping').length, 0);
  r = res(); await status({ method: 'GET', headers: { authorization: 'Bearer forged' } }, r);
  assert.equal(r.body.billing_ok, null);
  calls = mock();
  r = res(); await status({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, r);
  assert.deepEqual(r.body, { billing_configured: true, billing_ok: true });
  assert.ok(!JSON.stringify(r.body).includes(JWT_KEY));
  const oe = console.error; console.error = () => {};
  try {
    mock({ ping: 'fail' });
    r = res(); await status({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, r);
    assert.deepEqual(r.body, { billing_configured: true, billing_ok: false });
  } finally { console.error = oe; }
  r = res(); await status({ method: 'POST', headers: {} }, r);
  assert.equal(r.statusCode, 405);
  setKey(null);
});
