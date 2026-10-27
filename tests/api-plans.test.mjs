// Unit tests for plans / free trial / model choice in api/generate.js and the sales form API (api/_lib/notify/lead.js).
// No network: fetch is mocked. Usage: node --no-warnings --test tests/api-plans.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AZURE_OPENAI_ENDPOINT = 'https://azure.example.com/';
process.env.AZURE_OPENAI_API_KEY = 'azure-secret';
process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
delete process.env.AZURE_OPENAI_DEPLOYMENT_MINI;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.RESEND_API_KEY; delete process.env.SALES_NOTIFY_EMAIL;
delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
const genMod = await import('../api/generate.js');
const gen = genMod.default;
const leadMod = await import('../api/_lib/notify/lead.js');
const lead = leadMod.default;
const config = await import('../api/config.js');
const { appBody } = await import('./ai-fixtures.mjs');

const USER = { id: '1a2b3c4d-5e6f-4a1b-9c8d-000000000001', email: 'profe@tec.com' };
const AZURE_OK = { choices: [{ message: { content: 'Class plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 800 } };
const j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
function res() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const by = (calls, end) => calls.filter(c => c.url.endsWith(end));
const azureCalls = calls => calls.filter(c => c.url.startsWith('https://azure.example.com/'));
// consume: a function (body → [status, json]) or a json answer
function mock({ consume = { allowed: true, used: 1, limit: 60, event: 9, finish_key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', model: 'default' }, azure = AZURE_OK, azureStatus = 200,
  lead: leadAnswer = null, resend = 200, turnstile = true, service = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const h = opts.headers || {};
    let body = null; try { body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : Object.fromEntries(opts.body)) : null; } catch { body = String(opts.body); }
    calls.push({ url: u, headers: h, body });
    if (u.endsWith('/auth/v1/user')) return h.Authorization === 'Bearer good-token' ? j(200, USER) : j(401, { msg: 'bad jwt' });
    if (u.endsWith('/rpc/ip_rate_hit')) return j(200, true);
    if (u.endsWith('/rpc/consume_ai_quota')) { const a = typeof consume === 'function' ? consume(body) : [200, consume]; return j(a[0], a[1]); }
    if (u.endsWith('/rpc/finish_ai_event')) return j(200, true);
    if (u.endsWith('/rpc/submit_sales_lead')) return leadAnswer ? j(leadAnswer[0], leadAnswer[1]) : j(200, { id: 'lead-1', ...body.p_lead, source: body.p_source });
    if (u.endsWith('/rpc/submit_sales_lead_service')) return service ? j(service[0], service[1]) : j(200, { id: 'lead-anon', ...body.p_lead, source: body.p_source, anonymous: true });
    if (u.endsWith('/rpc/sales_lead_notified') || u.endsWith('/rpc/sales_lead_notified_service')) return j(200, true);
    if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return j(200, { success: turnstile });
    if (u === 'https://api.resend.com/emails') return j(resend, { id: 'em_1' });
    if (u.startsWith('https://azure.example.com/')) return j(azureStatus, azure);
    return j(404, {});
  };
  return calls;
}
const req = (body = {}, auth = 'Bearer good-token') => ({ method: 'POST', headers: { authorization: auth, 'x-forwarded-for': '203.0.113.9' }, body: { ...appBody(body.kind || 'generate'), ...body } });

// ── free trial ──
test('trial: the 6th class → 402 trial_limit (Azure not called, nothing to finish)', async () => {
  const calls = mock({ consume: { allowed: false, reason: 'trial_limit', trial_used: 5, trial_limit: 5, used: 9, limit: 15 } });
  const r = res(); await gen(req(), r);
  assert.equal(r.statusCode, 402);
  assert.equal(r.body.code, 'trial_limit'); assert.equal(r.body.trial_used, 5); assert.equal(r.body.trial_limit, 5);
  assert.match(r.body.error, /trial classes/);
  assert.equal(azureCalls(calls).length, 0); assert.equal(by(calls, '/rpc/finish_ai_event').length, 0);
});
test('trial: enforced with the user token, without the server key (consume_ai_quota, no service RPC)', async () => {
  const calls = mock();
  const r = res(); await gen(req({ meta: { subjects: ['Math'] } }), r);
  assert.equal(r.statusCode, 200);
  const q = by(calls, '/rpc/consume_ai_quota')[0];
  assert.equal(q.headers.Authorization, 'Bearer good-token');
  assert.ok(!('p_model' in q.body), 'no model unless asked');
  assert.equal(by(calls, '/rpc/ai_budget_check').length, 0);
});
test('trial: the request is finished with its key (so only the server can mark it as failed)', async () => {
  let calls = mock();
  let r = res(); await gen(req(), r);
  assert.deepEqual(by(calls, '/rpc/finish_ai_event')[0].body, { p_event: 9, p_ok: true, p_key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  const oe = console.error; console.error = () => {};
  try {
    calls = mock({ azureStatus: 500, azure: { error: { code: 'x' } } });
    r = res(); await gen(req(), r);
    assert.equal(r.statusCode, 502);
    assert.deepEqual(by(calls, '/rpc/finish_ai_event')[0].body, { p_event: 9, p_ok: false, p_key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  } finally { console.error = oe; }
  assert.ok(!JSON.stringify(r.body).includes('a1b2c3d4e5f6'), 'the key never reaches the browser');
  calls = mock({ consume: { allowed: true, used: 1, limit: 60, event: 9, finish_key: 'not a key!' } });
  r = res(); await gen(req(), r);
  assert.deepEqual(by(calls, '/rpc/finish_ai_event')[0].body, { p_event: 9, p_ok: true }, 'a malformed key is not sent');
});

// ── model choice ──
test('model: an invalid value is refused before anything is spent', async () => {
  const calls = mock();
  for (const m of ['gpt-5', 1, true, { x: 1 }]) {
    const r = res(); await gen(req({ model: m }), r);
    assert.equal(r.statusCode, 400, String(m)); assert.equal(r.body.code, 'invalid');
  }
  assert.equal(by(calls, '/rpc/consume_ai_quota').length, 0); assert.equal(azureCalls(calls).length, 0);
});
test('model: a non-superadmin asking for a model → 403 model_forbidden (the database decides)', async () => {
  const calls = mock({ consume: b => b.p_model ? [200, { allowed: false, reason: 'model', used: 0, limit: 60 }] : [200, { allowed: true, used: 1, limit: 60 }] });
  for (const m of ['mini', 'default']) {
    const r = res(); await gen(req({ model: m }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'model_forbidden');
  }
  assert.equal(by(calls, '/rpc/consume_ai_quota')[0].body.p_model, 'mini');
  assert.equal(azureCalls(calls).length, 0);
});
test('model: super admin + mini → the mini deployment (name returned only to them)', async () => {
  process.env.AZURE_OPENAI_DEPLOYMENT_MINI = 'gpt-4.1-mini';
  try {
    const calls = mock({ consume: { allowed: true, used: 1, limit: 500, event: 3, model: 'mini' } });
    const r = res(); await gen(req({ model: 'mini' }), r);
    assert.equal(r.statusCode, 200);
    assert.match(azureCalls(calls)[0].url, /\/openai\/deployments\/gpt-4\.1-mini\/chat\/completions/);
    assert.deepEqual(r.body.model, { used: 'mini', deployment: 'gpt-4.1-mini' });
    assert.equal(r.body.usage.prompt_tokens, 1200, 'usage is returned for the cost comparison');
  } finally { delete process.env.AZURE_OPENAI_DEPLOYMENT_MINI; }
});
test('model: mini without AZURE_OPENAI_DEPLOYMENT_MINI → the default deployment (fallback flagged)', async () => {
  const calls = mock({ consume: { allowed: true, used: 1, limit: 500, event: 3, model: 'mini' } });
  const r = res(); await gen(req({ model: 'mini' }), r);
  assert.equal(r.statusCode, 200);
  assert.match(azureCalls(calls)[0].url, /\/deployments\/gpt-4o\//);
  assert.deepEqual(r.body.model, { used: 'default', fallback: true, deployment: 'gpt-4o' });
});
test('model: the per-kind platform setting is respected without body.model (no deployment name leaked)', async () => {
  process.env.AZURE_OPENAI_DEPLOYMENT_MINI = 'gpt-4.1-mini';
  try {
    let calls = mock({ consume: { allowed: true, used: 1, limit: 60, event: 3, model: 'mini' } });
    let r = res(); await gen(req({ kind: 'student' }), r);
    assert.match(azureCalls(calls)[0].url, /\/deployments\/gpt-4\.1-mini\//);
    assert.deepEqual(r.body.model, { used: 'mini' });
    calls = mock({ consume: { allowed: true, used: 1, limit: 60, event: 3, model: 'default' } });
    r = res(); await gen(req(), r);
    assert.match(azureCalls(calls)[0].url, /\/deployments\/gpt-4o\//);
    assert.deepEqual(r.body.model, { used: 'default' });
  } finally { delete process.env.AZURE_OPENAI_DEPLOYMENT_MINI; }
});
test('model: a database without the p_model version → the model is ignored (default), generation works', async () => {
  const calls = mock({ consume: b => 'p_model' in b ? [404, { code: 'PGRST202', message: 'Could not find the function' }] : [200, { allowed: true, used: 1, limit: 60, event: 3 }] });
  const r = res(); await gen(req({ model: 'mini' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(by(calls, '/rpc/consume_ai_quota').length, 2);
  assert.match(azureCalls(calls)[0].url, /\/deployments\/gpt-4o\//);
});
test('pickDeployment: only a safe deployment name is used', () => {
  assert.deepEqual(genMod.pickDeployment('mini', { AZURE_OPENAI_DEPLOYMENT: 'gpt-4o', AZURE_OPENAI_DEPLOYMENT_MINI: '../evil' }), { used: 'default', deployment: 'gpt-4o', fallback: true });
  assert.deepEqual(genMod.pickDeployment('default', { AZURE_OPENAI_DEPLOYMENT_MINI: 'm' }), { used: 'default', deployment: 'gpt-4o', fallback: false });
});

// ── "Hablar con ventas" ──
const LEAD = { name: 'Ana <b>', institution: 'Colegio Sur', role: 'direccion', country: 'UY', teachers_count: '10-29', contact_channel: 'whatsapp',
  whatsapp: '+59899123456', email: 'ana@colegio.edu.uy', preferred_plan: 'institucion', message: 'Hola <script>alert(1)</script>', consent: true, lang: 'es',
  user_id: 'evil', status: 'ganado', anonymous: true };
const leadReq = (body, auth = 'Bearer good-token', ip = '198.51.100.20') => ({ method: 'POST', headers: { ...(auth ? { authorization: auth } : {}), 'x-forwarded-for': ip }, body });
test('lead: signed in → stored with the person\'s own session, only known fields; no e-mail without RESEND + SALES_NOTIFY_EMAIL', async () => {
  const calls = mock();
  const r = res(); await lead(leadReq({ lead: LEAD, source: 'popup_gen2' }), r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true, id: 'lead-1', emailed: false });
  const s = by(calls, '/rpc/submit_sales_lead')[0];
  assert.equal(s.headers.Authorization, 'Bearer good-token');
  assert.equal(s.body.p_source, 'popup_gen2');
  assert.ok(!('user_id' in s.body.p_lead) && !('status' in s.body.p_lead) && !('anonymous' in s.body.p_lead), 'unknown fields dropped');
  assert.equal(s.body.p_lead.consent, true);
  assert.equal(calls.filter(c => c.url.includes('resend.com')).length, 0);
});
test('lead: unknown source → other; GET refused', async () => {
  const calls = mock();
  let r = res(); await lead(leadReq({ lead: LEAD, source: 'evil' }), r);
  assert.equal(by(calls, '/rpc/submit_sales_lead')[0].body.p_source, 'other');
  r = res(); await lead({ method: 'GET', headers: {} }, r); assert.equal(r.statusCode, 405);
});
test('lead: with RESEND_API_KEY + SALES_NOTIFY_EMAIL → one e-mail to the owner (escaped, reply-to the lead), then marked', async () => {
  process.env.RESEND_API_KEY = 're_test'; process.env.SALES_NOTIFY_EMAIL = 'ventas@teroclass.test';
  try {
    const calls = mock();
    const r = res(); await lead(leadReq({ lead: LEAD, source: 'plans_page' }), r);
    assert.equal(r.body.emailed, true);
    const m = calls.find(c => c.url === 'https://api.resend.com/emails').body;
    assert.deepEqual(m.to, ['ventas@teroclass.test']); assert.equal(m.reply_to, 'ana@colegio.edu.uy');
    assert.ok(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;'), 'escaped');
    assert.ok(!/[<>]/.test(m.subject), 'safe subject: ' + m.subject);
    assert.match(m.html, /Página de planes/);
    assert.equal(by(calls, '/rpc/sales_lead_notified').length, 1);
    assert.ok(!JSON.stringify(r.body).includes('ventas@'), 'the owner address never reaches the browser');
  } finally { delete process.env.RESEND_API_KEY; delete process.env.SALES_NOTIFY_EMAIL; }
});
test('lead: an invalid SALES_NOTIFY_EMAIL sends nothing', async () => {
  process.env.RESEND_API_KEY = 're_test'; process.env.SALES_NOTIFY_EMAIL = 'not an email';
  try {
    const calls = mock();
    const r = res(); await lead(leadReq({ lead: LEAD }), r);
    assert.equal(r.body.emailed, false); assert.equal(calls.filter(c => c.url.includes('resend.com')).length, 0);
  } finally { delete process.env.RESEND_API_KEY; delete process.env.SALES_NOTIFY_EMAIL; }
});
test('lead: database errors → clear codes (rate, consent, field, forbidden)', async () => {
  for (const [msg, status, code] of [['Demasiados pedidos seguidos: probá de nuevo más tarde', 429, 'rate'], ['Hace falta el consentimiento para contactarte', 400, 'consent'],
    ['Pedido inválido: email', 400, 'invalid'], ['No autorizado', 403, 'forbidden']]) {
    mock({ lead: [400, { code: 'P0001', message: msg }] });
    const r = res(); await lead(leadReq({ lead: LEAD }), r);
    assert.equal(r.statusCode, status, msg); assert.equal(r.body.code, code);
    if (code === 'invalid') assert.equal(r.body.field, 'email');
  }
});
test('lead: not signed in and Turnstile not configured → 401 auth (nothing stored)', async () => {
  const calls = mock();
  const r = res(); await lead(leadReq({ lead: LEAD }, null), r);
  assert.equal(r.statusCode, 401); assert.equal(r.body.code, 'auth');
  assert.equal(calls.filter(c => c.url.includes('/rpc/')).length, 0);
  assert.equal(config.publicConfig({}).salesAnon, false);
});
test('lead: not signed in with Turnstile + server key → verified with Cloudflare, stored by the service RPC with an IP hash', async () => {
  Object.assign(process.env, { TURNSTILE_SITE_KEY: '0x4AAAAAAAsite', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' });
  try {
    assert.equal(config.publicConfig(process.env).salesAnon, true);
    let calls = mock({ turnstile: false });
    let r = res(); await lead(leadReq({ lead: LEAD, turnstileToken: 'bad' }, null, '192.0.2.77'), r);
    assert.equal(r.statusCode, 400); assert.equal(r.body.code, 'captcha');
    assert.equal(by(calls, '/rpc/submit_sales_lead_service').length, 0);
    r = res(); await lead(leadReq({ lead: LEAD }, null, '192.0.2.77'), r);
    assert.equal(r.body.code, 'captcha', 'a missing token is refused without asking Cloudflare');
    calls = mock({ turnstile: true });
    r = res(); await lead(leadReq({ lead: LEAD, turnstileToken: 'good', source: 'plans_page' }, null, '192.0.2.77'), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.id, 'lead-anon');
    const v = calls.find(c => c.url.includes('siteverify'));
    assert.equal(v.body.secret, '0x4AAAAAAAsecret'); assert.equal(v.body.remoteip, '192.0.2.77');
    const s = by(calls, '/rpc/submit_sales_lead_service')[0];
    assert.match(s.body.p_ip_key, /^lead:[0-9a-f]{64}$/); assert.ok(!JSON.stringify(s.body).includes('192.0.2.77'), 'never the raw IP');
    assert.equal(s.headers.apikey, 'sb_secret_test');
  } finally { for (const k of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k]; }
});
test('lead: per-IP limit in memory (20 per hour) before the database', async () => {
  mock();
  let last;
  for (let i = 0; i < 21; i++) { last = res(); await lead(leadReq({ lead: LEAD }, 'Bearer good-token', '198.51.100.99'), last); }
  assert.equal(last.statusCode, 429); assert.equal(last.body.code, 'rate');
});
test('lead: the e-mail builder keeps everything escaped and labels the origin', () => {
  const m = leadMod.buildLeadEmail({ ...LEAD, source: 'paywall', whatsapp: '' }, { origin: 'https://teroclass.com', from: 'TeroClass <x@y.com>', to: 'o@y.com', account: 'p@q.com' });
  assert.match(m.html, /Límite de la prueba/); assert.match(m.html, /p@q\.com/);
  assert.ok(!m.html.includes('<b>') || !m.html.includes('Ana <b>'), 'name escaped');
  assert.match(m.subject, /^Nuevo pedido de ventas: Ana b · Colegio Sur$/);
});
