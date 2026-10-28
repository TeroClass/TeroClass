// Supabase simulado para las pruebas e2e (no toca datos reales).
// Incluye las RPC nuevas: set_member_role, remove_member, get_document_content, y open_registration en institutions.
// Jerarquía: parent_id, methodology_config, get_effective_config, delete_institution, admin_move_member, platform_stats.
// Plan y consumo: get_billing_summary, request_token_pack, list_purchase_requests, decide_purchase_request,
// set_institution_plan, update_platform_settings, platform_billing_overview, get_seat_status (+ seats in invite_member / get_org_branding).
// Insights: platform_insights (super admin only; data from insightsData(), overridable per test via M.insights.fixture),
// update_ai_prices (+ ai_price_input / ai_price_output in the platform settings).
// Groups + students + calendar (tests/mock-students.cjs): list_groups, import_students, my_calendar, student_view,
// claim_enrollments, calendar tokens/feed…; magic link sign-in (POST /auth/v1/otp; via:"student_link" → role student).
// Class document + attendance (tests/mock-classdoc.cjs) and Realtime broadcast (tests/mock-realtime.cjs, routeWebSocket).
// Class insights (tests/mock-insights.cjs): generate_demo_insights, list_insight_sessions, get_session_insights,
// save_teacher_reflection, save_insight_message, my_insights, my_insight (+ insights in student_view).
// Recording consent (tests/mock-consent.cjs): my_consent, grant / revoke / decline_recording_consent, consent_overview,
// consent_new_declines, platform_consent_counts.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// supabase-js is self-hosted since 2026-10 (/vendor/supabase-js-2.116.0.js, byte-identical to the npm 2.116.0 UMD the tests
// load as SB_JS): the tests keep serving it through their CDN route, so the tag is pointed back there.
const RAW_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace('<script src="/vendor/supabase-js-2.116.0.js"></script>', '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js"></script>');
// Tests that answer every page request with HTML get the live-class assets inlined
// (in production they are separate files: see vercel.json). Function replacers: no $-patterns.
const asset = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const HTML = RAW_HTML
  .replace('<link rel="stylesheet" href="/live-class.css">', () => `<style>${asset('live-class.css')}</style>`)
  .replace('<link rel="stylesheet" href="/insights-view.css">', () => `<style>${asset('insights-view.css')}</style>`)
  .replace('<script src="/insights-view.js"></script>', () => `<script>${asset('insights-view.js')}</script>`)
  .replace('<script src="/live-class.js"></script>', () => `<script>${asset('live-class.js')}</script>`)
  .replace('<script src="/insights-panel.js"></script>', () => `<script>${asset('insights-panel.js')}</script>`)
  .replace('<link rel="stylesheet" href="/groups-calendar.css">', () => `<style>${asset('groups-calendar.css')}</style>`)
  .replace('<script src="/csv-import.js"></script>', () => `<script>${asset('csv-import.js')}</script>`)
  .replace('<script src="/groups-calendar.js"></script>', () => `<script>${asset('groups-calendar.js')}</script>`)
  .replace('<link rel="stylesheet" href="/class-doc.css">', () => `<style>${asset('class-doc.css')}</style>`)
  .replace('<script src="/attendance.js"></script>', () => `<script>${asset('attendance.js')}</script>`)
  .replace('<script src="/class-doc.js"></script>', () => `<script>${asset('class-doc.js')}</script>`)
  .replace('<link rel="stylesheet" href="/class-board.css">', () => `<style>${asset('class-board.css')}</style>`)
  .replace('<script src="/class-board.js"></script>', () => `<script>${asset('class-board.js')}</script>`)
  .replace('<link rel="stylesheet" href="/group-notebook.css">', () => `<style>${asset('group-notebook.css')}</style>`)
  .replace('<script src="/group-notebook.js"></script>', () => `<script>${asset('group-notebook.js')}</script>`)
  .replace('<link rel="stylesheet" href="/plans.css">', () => `<style>${asset('plans.css')}</style>`)
  .replace('<script src="/plans.js"></script>', () => `<script>${asset('plans.js')}</script>`)
  .replace('<script src="/plans-admin.js"></script>', () => `<script>${asset('plans-admin.js')}</script>`);
// The class-document editor is an ES module loaded on demand (import('/vendor/classdoc-editor.js')): tests that open a
// document serve it with serveVendor(route) (production: public/vendor/, see vercel.json).
const VENDOR_EDITOR = fs.readFileSync(path.join(ROOT, 'public/vendor/classdoc-editor.js'), 'utf8');
const serveVendor = route => route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: VENDOR_EDITOR });
// The whiteboard (Excalidraw + React) is a folder of files loaded on demand (/vendor/whiteboard/…): served from public/ as is.
const WB_TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
const serveWhiteboard = route => {
  const p = new URL(route.request().url()).pathname; const f = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!p.startsWith('/vendor/whiteboard/') || !f.startsWith(path.join(ROOT, 'public/vendor/whiteboard')) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, contentType: WB_TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
};
const SB_JS = fs.readFileSync(process.env.SB_JS || '/tmp/package/dist/umd/supabase.js', 'utf8');
const SB = 'https://ppvqkjchhejjulrdqkdr.supabase.co';
// Test-only platform owner (placeholder). The real system never promotes by email: the mock simply
// seeds this account as an existing superadmin, like production where the role lives in profiles.role.
const SUPERADMIN_EMAIL = 'owner@teroclass.test';

const db = { users: {}, profiles: [], institutions: [], plannings: [], invitations: [], institution_documents: [],
  class_groups: [], student_enrollments: [], group_members: [], session_series: [], class_sessions: [], session_invitees: [], calendar_tokens: [],
  teacher_insights: [], student_insights: [],
  class_docs: [], class_doc_updates: [], class_doc_versions: [], class_doc_presence: [], session_attendance: [],
  class_boards: [], class_board_elements: [], class_board_versions: [], class_board_presence: [],
  group_notebooks: [], group_notebook_sections: [], group_notebook_updates: [], group_notebook_versions: [], group_notebook_presence: [], group_notebook_notes: [],
  user_consents: [], consent_declines: [] };
const calls = { rpc: [], inserts: {}, otp: [] };
// billing state (same rules as the SQL functions, simplified): accounts[rootId] = {seats, monthly_tokens, extra}; usage[rootId] = used this month
const BILL_DEFAULTS = () => ({ settings: { pack_tokens: 2000000, pack_price: 11.99, currency: 'USD', personal_monthly_tokens: 200000, default_seats: 10, default_monthly_tokens: 2000000, ai_price_input: 2.5, ai_price_output: 10 }, accounts: {}, usage: {}, requests: [], log: [] });
const bill = BILL_DEFAULTS();
let n = 0; const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const tokUser = t => Object.values(db.users).find(u => 'tok-' + u.id === t);
const insights = { fixture: null }; // tests may set insights.fixture = (body) => json
function resetDb() { for (const k of Object.keys(db)) db[k] = k === 'users' ? {} : []; if (typeof realtime !== 'undefined') realtime.reset(); calls.rpc = []; calls.inserts = {}; calls.otp = []; calls.recover = []; calls.passwords = []; calls.captcha = []; Object.assign(bill, BILL_DEFAULTS()); insights.fixture = null; if (typeof plans !== 'undefined') plans.reset(); }
// Default insights: deterministic sample data shaped like public.platform_insights (smaller numbers for a unit)
function insightsData(body) {
  const days = Math.min(Math.max(Number(body.p_days) || 30, 1), 366); const unit = body.p_unit ? instById(body.p_unit) : null;
  const f = unit ? 1 : 3; const today = new Date(); const day = i => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - i))).toISOString().slice(0, 10);
  const per_day = Array.from({ length: days }, (_, i) => ({ day: day(i), classes: ((i * 7) % 5) * f + (i % 3 === 0 ? 1 : 0) }));
  const classes = per_day.reduce((n, d) => n + d.classes, 0);
  const roots = db.institutions.filter(i => (unit ? descendantsOf(unit.id).concat(unit.id).includes(i.id) : !i.parent_id));
  return { days, from: per_day[0].day, to: per_day[days - 1].day, exclude_self: body.p_exclude_self !== false, unit: unit ? { id: unit.id, name: unit.name } : null, tracking_since: new Date().toISOString(),
    usage: { per_day, classes, saved: Math.round(classes * 0.6), handouts: 4 * f, requests: classes + 9, failed: 1, active: { d1: 2 * f, d7: 4 * f, d30: 6 * f }, active_period: 6 * f, new_users: 3 * f, returning_users: 2 * f,
      top_institutions: roots.slice(0, 5).map((i, n) => ({ id: i.id, name: i.name, classes: (5 - n) * 4 * f })) },
    content: { classes, subjects: [{ name: 'Math', count: 9 * f }, { name: 'History', count: 5 * f }, { name: 'English', count: 3 * f }], languages: [{ name: 'Spanish', count: 12 * f }, { name: 'English', count: 4 * f }],
      age_bands: [{ name: 'teen', count: 8 * f }, { name: 'primary', count: 5 * f }, { name: 'adult', count: 2 * f }], levels: [{ name: 'Secondary', count: 9 * f }],
      bars: [{ key: 'gamification', avg: 42.5, count: 10 }, { key: 'projectbased', avg: 61, count: 10 }, { key: 'c_outdoor_x1', avg: 30, count: 4 }], playbook_institutions: 1, institutions: roots.length || 1 },
    students: { total: 40 * f, linked: 25 * f, active: 18 * f, groups: 3 * f, sessions: 24 * f,
      insight_sessions: db.teacher_insights.filter(t => { const s = db.class_sessions.find(x => x.id === t.session_id); return s && (!unit || descendantsOf(unit.id).concat(unit.id).includes(s.institution_id)); }).length },
    costs: { recorded_ever: true, requests: 30 * f, prompt_tokens: 1200000 * f, completion_tokens: 400000 * f, total_tokens: 1600000 * f, classes: 12 * f, price_input: bill.settings.ai_price_input, price_output: bill.settings.ai_price_output,
      usd: Math.round((1.2 * f * bill.settings.ai_price_input + 0.4 * f * bill.settings.ai_price_output) * 10000) / 10000,
      by_institution: roots.slice(0, 5).map((i, n) => ({ id: i.id, name: i.name, tokens: (5 - n) * 200000 * f, classes: (5 - n) * f, usd: (5 - n) * f })) } };
}
function session(u) {
  return { access_token: 'tok-' + u.id, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'r-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta, app_metadata: {} } };
}
function newUser(email, meta) {
  const id = uid(); db.users[id] = { id, email, meta };
  const inv = db.invitations.find(i => i.email === email.toLowerCase() && invPending(i)); // TC-16: only live invitations
  let bySlug = db.institutions.find(i => i.slug === meta.org_slug && i.open_registration !== false);
  let invUse = inv;
  const target = inv ? inv.institution_id : (bySlug ? bySlug.id : null);
  if (target && !seatFree(rootOf(target))) { invUse = null; bySlug = null; } // no free seat → account without institution
  const student = meta.via === 'student_link' && !invUse; // magic link from "I'm a student": no invitation → student, no unit
  if (student) bySlug = null;
  db.profiles.push({ id, email, created_at: new Date().toISOString(), name: meta.name || '', role: email.toLowerCase() === SUPERADMIN_EMAIL ? 'superadmin' : (invUse ? invUse.role : student ? 'student' : 'teacher'),
    institution_id: invUse ? invUse.institution_id : (bySlug ? bySlug.id : null) });
  if (invUse) invUse.accepted_at = new Date().toISOString();
  students.applyPending(db.profiles[db.profiles.length - 1]); // groups waiting for this email (pending teacher / substitute)
  return db.users[id];
}
// TC-07 / TC-16 (as 001_base.sql): pending = not accepted / declined / cancelled and not expired (14 days)
const INV_TTL = 14 * 864e5;
const invPending = i => !i.accepted_at && !i.declined_at && !i.cancelled_at && Date.parse(i.expires_at || i.created_at || 0) + (i.expires_at ? 0 : INV_TTL) > Date.now();
const invStatus = i => i.accepted_at ? 'accepted' : i.declined_at ? 'declined' : i.cancelled_at ? 'cancelled' : invPending(i) ? 'pending' : 'expired';
function seedInstitution(extra = {}) {
  const id = uid();
  const row = { id, name: 'School A', slug: 'a', color: '#7c5cbf', bg_color: '#f0eef8', font: 'Inter', admin_email: 'adm@a.com', master_prompt: '', doc_text: '', doc_name: '', logo_url: null, open_registration: true, parent_id: null, methodology_config: {}, created_at: new Date().toISOString(), ...extra };
  db.institutions.push(row); return row;
}
function applyFilters(rows, url) {
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'columns'].includes(k)) continue;
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
    if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
    if (v === 'is.null') rows = rows.filter(r => r[k] == null);
  }
  return rows;
}
// ── hierarchy helpers (same rules as the SQL functions) ──
const instById = id => db.institutions.find(i => i.id === id);
function chainOf(id) { const out = []; let cur = instById(id); let g = 0; while (cur && g++ < 10) { out.unshift(cur); cur = cur.parent_id ? instById(cur.parent_id) : null; } return out; } // root → node
function descendantsOf(id) { const out = []; for (let q = [id]; q.length;) { const x = q.shift(); db.institutions.filter(i => i.parent_id === x).forEach(c => { out.push(c.id); q.push(c.id); }); } return out; }
function effBranding(id) {
  const ch = chainOf(id).reverse(); const pick = k => (ch.find(i => i[k]) || {})[k] || null;
  return { name: instById(id)?.name, color: pick('color') || '#7c5cbf', bg_color: pick('bg_color') || '#f0eef8', font: pick('font') || 'Inter', logo_url: pick('logo_url'), path: chainOf(id).map(i => i.name).join(' › ') };
}
function effectiveConfig(id) {
  const ch = chainOf(id); let hidden = []; let custom = [];
  const chain = ch.map((i, n) => { const m = { hidden: (i.methodology_config || {}).hidden || [], custom: (i.methodology_config || {}).custom || [] };
    m.hidden.forEach(k => { if (!hidden.includes(k)) hidden.push(k); custom = custom.filter(c => c.key !== k); });
    m.custom.forEach(c => { custom = custom.filter(x => x.key !== c.key).concat([{ tooltip: '', ...c }]); hidden = hidden.filter(k => k !== c.key); });
    return { id: i.id, name: i.name, slug: i.slug, level: n + 1, parent_id: i.parent_id || null, master_prompt: i.master_prompt || '', methodology: m }; });
  return { chain, master_prompts: ch.filter(i => (i.master_prompt || '').trim()).map(i => ({ id: i.id, name: i.name, prompt: i.master_prompt })), methodology: { hidden, custom }, branding: effBranding(id) };
}
// ── billing helpers ──
const rootOf = id => chainOf(id)[0]?.id || null;
const treeIds = root => root ? [root, ...descendantsOf(root)] : [];
const account = root => bill.accounts[root] || (bill.accounts[root] = { seats: bill.settings.default_seats, monthly_tokens: bill.settings.default_monthly_tokens, extra: 0 });
const seatsUsed = root => db.profiles.filter(p => ['teacher', 'org_admin'].includes(p.role) && treeIds(root).includes(p.institution_id)).length;
const seatFree = root => seatsUsed(root) < account(root).seats;
function canViewBilling(me, root) { const p = me && db.profiles.find(x => x.id === me.id); if (!p || !root) return false; return p.role === 'superadmin' || (p.role === 'org_admin' && rootOf(p.institution_id) === root); }
function adminScope(me, root) { const p = db.profiles.find(x => x.id === me.id); if (p.role === 'superadmin') return treeIds(root); return treeIds(root).filter(id => chainOf(id).some(c => c.id === p.institution_id)); }
function billingSummary(me, inst) {
  const root = rootOf(inst); const a = account(root); const used = bill.usage[root] || 0; const p = db.profiles.find(x => x.id === me.id);
  const scope = adminScope(me, root); const logs = bill.log.filter(l => l.root_id === root && scope.includes(l.inst_id));
  const sum = (arr, key) => Object.values(arr.reduce((m, l) => { const k = l[key]; m[k] = m[k] || { k, used: 0, requests: 0 }; m[k].used += l.total; m[k].requests++; return m; }, {})).sort((x, y) => y.used - x.used);
  const month = new Date().toISOString().slice(0, 7) + '-01';
  return { root_id: root, root_name: instById(root)?.name, month, resets_on: month, seats: a.seats, seats_used: seatsUsed(root), monthly_tokens: a.monthly_tokens, used_month: used, extra_used_month: 0,
    extra_balance: a.extra, remaining: Math.max(a.monthly_tokens - used, 0) + a.extra, pack_tokens: bill.settings.pack_tokens, pack_price: bill.settings.pack_price, currency: bill.settings.currency,
    credit_tokens: 25000, packs: plans.state.plans.addons.filter(x => x.kind === 'classes').map(x => ({ id: x.id, credits: x.credits, usd: x.usd, name_es: x.name_es, name_en: x.name_en })),
    plan_status: a.plan_status || 'none', plan_id: a.plan_id || null,
    can_request: p.role === 'org_admin' && p.institution_id === root, full_detail: scope.includes(root),
    pending: bill.requests.find(r => r.root_id === root && r.status === 'pending') || null,
    by_unit: sum(logs, 'inst_id').map(x => ({ id: x.k, name: instById(x.k)?.name, used: x.used, requests: x.requests })),
    by_teacher: sum(logs, 'user_id').slice(0, 10).map(x => { const u = db.profiles.find(q => q.id === x.k) || {}; const masked = u.role === 'superadmin' && p.role !== 'superadmin';
      return masked ? { user_id: null, name: '', email: null, masked: true, used: x.used, requests: x.requests } : { user_id: x.k, name: u.name || u.email, email: u.email, masked: false, used: x.used, requests: x.requests }; }),
    requests: bill.requests.filter(r => r.root_id === root).slice().reverse().slice(0, 20) };
}
// what a user can read from institutions (RLS): superadmin all; org_admin own unit + below; teacher own unit
function visibleInstitutions(me) {
  const p = me && db.profiles.find(x => x.id === me.id); if (!p) return [];
  if (p.role === 'superadmin') return db.institutions;
  if (!p.institution_id) return [];
  const ids = p.role === 'org_admin' ? [p.institution_id, ...descendantsOf(p.institution_id)] : [p.institution_id];
  return db.institutions.filter(i => ids.includes(i.id));
}
function project(rows, url) {
  const sel = url.searchParams.get('select');
  if (!sel || sel === '*') return rows;
  const cols = sel.split(',');
  return rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
}
async function handleSupabase(route) {
  const req = route.request(); const url = new URL(req.url()); const p = url.pathname; const m = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
  const auth = (req.headers()['authorization'] || '').replace('Bearer ', '');
  if (m === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (body && body.gotrue_meta_security && body.gotrue_meta_security.captcha_token) { calls.captcha = calls.captcha || []; calls.captcha.push({ path: p, token: body.gotrue_meta_security.captcha_token }); }
  if (p === '/auth/v1/signup') {
    if (Object.values(db.users).some(u => u.email === body.email)) return json(422, { msg: 'User already registered', error_code: 'user_already_exists' });
    const u = newUser(body.email, body.data || {});
    if (/confirm/.test(body.email)) return json(200, session(u).user); // email confirmation required → no session
    return json(200, session(u));
  }
  if (p === '/auth/v1/token') { const u = Object.values(db.users).find(x => x.email === body.email); return u ? json(200, session(u)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' }); }
  // TC-04: password recovery (e-mail with a link) and the new password (updateUser); TC-18: captcha token recorded
  if (p === '/auth/v1/recover') { calls.recover = calls.recover || []; calls.recover.push(body); return json(200, {}); }
  if (p === '/auth/v1/user' && m === 'PUT') { const u = tokUser(auth); if (!u) return json(401, { msg: 'bad jwt' }); calls.passwords = calls.passwords || []; calls.passwords.push({ user: u.id, password: body.password }); u.password = body.password; return json(200, session(u).user); }
  if (p === '/auth/v1/user') { const u = tokUser(auth); return u ? json(200, session(u).user) : json(401, { msg: 'bad jwt' }); }
  if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  if (p === '/auth/v1/otp') { // magic link: creates the account if needed (like Supabase with shouldCreateUser); the test then "clicks" it
    const email = String(body.email || '').trim().toLowerCase(); calls.otp.push(body);
    if (/ratelimit/.test(email)) return json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
    if (!Object.values(db.users).some(u => u.email === email)) newUser(email, body.data || {});
    return json(200, {});
  }
  const me = tokUser(auth);
  if (p.startsWith('/rest/v1/rpc/')) {
    const fn = p.split('/').pop();
    calls.rpc.push({ fn, body });
    if (fn === 'get_org_branding') { const i = db.institutions.find(x => x.slug === body.p_slug); return json(200, i ? [{ ...i, ...effBranding(i.id), name: i.name, slug: i.slug, open_registration: i.open_registration, seats_full: !seatFree(rootOf(i.id)) }] : []); }
    const NOAUTH = () => json(400, { code: 'P0001', message: 'No autorizado' });
    const meP = me && db.profiles.find(x => x.id === me.id); const isSA = meP?.role === 'superadmin';
    if (fn === 'get_billing_summary') { const inst = body.p_inst || meP?.institution_id; const root = inst && rootOf(inst); if (!canViewBilling(me, root)) return NOAUTH(); return json(200, billingSummary(me, inst)); }
    if (fn === 'get_seat_status') { const root = rootOf(body.p_root || meP?.institution_id); if (!canViewBilling(me, root)) return NOAUTH(); const a = account(root); return json(200, { root_id: root, seats: a.seats, used: seatsUsed(root), available: Math.max(a.seats - seatsUsed(root), 0), full: !seatFree(root) }); }
    if (fn === 'request_token_pack') {
      const root = meP?.institution_id; if (meP?.role !== 'org_admin' || !root || instById(root)?.parent_id) return json(400, { code: 'P0001', message: 'No autorizado: solo los admins de la institución madre pueden comprar tokens' });
      if (bill.requests.some(r => r.root_id === root && r.status === 'pending')) return json(400, { code: 'P0001', message: 'Ya hay una solicitud de compra pendiente para esta institución' });
      const pk = plans.state.plans.addons.filter(x => x.kind === 'classes' && (!body?.p_pack || x.id === body.p_pack)).sort((x, y) => x.credits - y.credits)[0];
      if (!pk) return json(400, { code: 'P0001', message: 'Ese pack no existe' });
      const r = { id: uid(), root_id: root, root_name: instById(root).name, requested_by: me.id, pack_tokens: pk.credits * 25000, price: pk.usd, currency: 'USD', pack_id: pk.id, pack_credits: pk.credits, status: 'pending', note: '', created_at: new Date().toISOString(), decided_at: null };
      bill.requests.push(r); return json(200, r);
    }
    if (fn === 'list_purchase_requests') {
      if (!isSA && meP?.role !== 'org_admin') return NOAUTH();
      const root = isSA ? null : rootOf(meP.institution_id);
      const rows = bill.requests.filter(r => (!root || r.root_id === root) && (!body.p_status || r.status === body.p_status)).map(r => { const u = db.profiles.find(q => q.id === r.requested_by) || {}; const masked = u.role === 'superadmin' && !isSA; return { ...r, requested_by: undefined, requested_by_name: masked ? '' : (u.name || u.email || ''), requested_by_email: masked ? null : u.email, masked }; });
      return json(200, rows.sort((x, y) => (y.status === 'pending') - (x.status === 'pending') || (y.created_at > x.created_at ? 1 : -1)));
    }
    if (fn === 'decide_purchase_request') {
      if (!isSA) return NOAUTH(); const r = bill.requests.find(x => x.id === body.p_id); if (!r) return json(400, { code: 'P0001', message: 'Solicitud no encontrada' });
      if (r.status !== 'pending') return json(400, { code: 'P0001', message: 'Esta solicitud ya fue resuelta' });
      if (body.p_approve) account(r.root_id).extra += r.pack_tokens;
      Object.assign(r, { status: body.p_approve ? 'approved' : 'rejected', note: String(body.p_note || '').trim().slice(0, 500), decided_at: new Date().toISOString() }); return json(200, r.status);
    }
    if (fn === 'set_institution_plan') {
      if (!isSA) return NOAUTH(); if (instById(body.p_root)?.parent_id) return json(400, { code: 'P0001', message: 'El plan se define en la institución madre' });
      if (!(body.p_seats >= 0)) return json(400, { code: 'P0001', message: 'Cantidad de asientos inválida' });
      Object.assign(account(body.p_root), { seats: body.p_seats, monthly_tokens: body.p_monthly_tokens }); return json(200, { root_id: body.p_root, seats: body.p_seats, monthly_tokens: body.p_monthly_tokens });
    }
    if (fn === 'update_platform_settings') {
      if (!isSA) return NOAUTH(); if (!/^[A-Z]{3}$/.test(String(body.p_currency || '').toUpperCase())) return json(400, { code: 'P0001', message: 'Moneda inválida (código de 3 letras, ej. USD)' });
      Object.assign(bill.settings, { pack_tokens: body.p_pack_tokens, pack_price: body.p_pack_price, currency: String(body.p_currency).toUpperCase(), personal_monthly_tokens: body.p_personal_monthly_tokens, default_seats: body.p_default_seats, default_monthly_tokens: body.p_default_monthly_tokens });
      return json(200, bill.settings);
    }
    if (fn === 'platform_billing_overview') {
      if (!isSA) return NOAUTH();
      return json(200, { month: new Date().toISOString().slice(0, 7) + '-01', settings: { ...bill.settings, plans: plans.state.plans, ai_model_default: plans.state.modelDefault, ai_price_input_mini: plans.state.mini.input, ai_price_output_mini: plans.state.mini.output }, pending_requests: bill.requests.filter(r => r.status === 'pending').length, personal: { users: 0, used_month: 0 },
        accounts: db.institutions.filter(i => !i.parent_id).map(i => { const a = account(i.id); return { id: i.id, name: i.name, slug: i.slug, seats: a.seats, seats_used: seatsUsed(i.id), monthly_tokens: a.monthly_tokens, extra_balance: a.extra, used_month: bill.usage[i.id] || 0, extra_used_month: 0, pending: bill.requests.some(r => r.root_id === i.id && r.status === 'pending'), plan_status: a.plan_status || 'none', plan_id: a.plan_id || null }; }) });
    }
    if (fn === 'platform_insights') {
      if (!isSA) return NOAUTH(); if (body.p_unit && !instById(body.p_unit)) return json(400, { code: 'P0001', message: 'Unidad no encontrada' });
      return json(200, insights.fixture ? insights.fixture(body) : insightsData(body));
    }
    if (fn === 'update_ai_prices') {
      if (!isSA) return NOAUTH(); if (!(body.p_input >= 0 && body.p_input <= 1000 && body.p_output >= 0 && body.p_output <= 1000)) return json(400, { code: 'P0001', message: 'Precio de IA inválido (de 0 a 1000 USD por millón de tokens)' });
      Object.assign(bill.settings, { ai_price_input: body.p_input, ai_price_output: body.p_output }); return json(200, { ai_price_input: body.p_input, ai_price_output: body.p_output });
    }
    if (fn === 'update_ai_guardrails') { // TC-01: daily caps on estimated AI tokens
      if (!isSA) return NOAUTH(); if (!(body.p_institution >= 0 && body.p_user >= 0)) return json(400, { code: 'P0001', message: 'Cantidad de tokens inválida' });
      Object.assign(bill.settings, { ai_daily_tokens_institution: body.p_institution, ai_daily_tokens_user: body.p_user });
      return json(200, { ai_daily_tokens_institution: body.p_institution, ai_daily_tokens_user: body.p_user });
    }
    if (fn === 'create_institution') {
      if (db.institutions.some(i => i.slug === body.p_slug)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "institutions_slug_key"' });
      if (body.p_parent && chainOf(body.p_parent).length >= 3) return json(400, { code: 'P0001', message: 'Máximo 3 niveles: institución madre › sede/facultad › cátedra/área' });
      const row = body.p_parent
        ? seedInstitution({ name: body.p_name, slug: body.p_slug, color: body.p_color || null, bg_color: null, font: null, admin_email: body.p_admin_email || null, parent_id: body.p_parent, open_registration: false })
        : seedInstitution({ name: body.p_name, slug: body.p_slug, color: body.p_color || '#7c5cbf', admin_email: body.p_admin_email, open_registration: false }); // TC-02: closed by default
      if (body.p_admin_email) { try { inviteMember(row.id, body.p_admin_email, 'org_admin', me); } catch (e) { /* seats: invitation not created */ } }
      return json(200, row.id);
    }
    if (fn === 'get_effective_config') { const id = body.p_inst || db.profiles.find(x => x.id === me?.id)?.institution_id; return json(200, id && instById(id) ? effectiveConfig(id) : null); }
    if (fn === 'delete_institution') {
      if (db.institutions.some(i => i.parent_id === body.p_inst)) return json(400, { code: 'P0001', message: 'Primero borrá o mové sus sub-unidades' });
      if (db.profiles.some(p => p.institution_id === body.p_inst)) return json(400, { code: 'P0001', message: 'Primero mové o quitá a las personas de esta unidad' });
      db.institutions = db.institutions.filter(i => i.id !== body.p_inst); return json(200, 'deleted');
    }
    if (fn === 'admin_move_member') {
      const pr = db.profiles.find(x => x.id === body.p_user); if (!pr || pr.role === 'superadmin') return json(400, { code: 'P0001', message: 'No se puede modificar al súper admin' });
      pr.institution_id = body.p_inst || null; if (!pr.institution_id) pr.role = 'teacher'; return json(200, 'moved');
    }
    if (fn === 'platform_stats') return json(200, { institutions: db.institutions.length, top_level: db.institutions.filter(i => !i.parent_id).length, users: db.profiles.length, teachers: db.profiles.filter(p => p.role === 'teacher').length, admins: db.profiles.filter(p => p.role === 'org_admin').length, classes: db.plannings.length, ai_today: 7, ai_users_today: 2 });
    if (fn === 'invite_member') {
      if (body.p_email.toLowerCase() === SUPERADMIN_EMAIL) return json(200, isSA ? 'superadmin' : 'not_allowed'); // never reveals the owner to others
      const pr = db.profiles.find(x => x.email === body.p_email); const root = rootOf(body.p_inst);
      const counted = pr && ['teacher', 'org_admin'].includes(pr.role) && pr.institution_id && rootOf(pr.institution_id) === root;
      if (!counted && !seatFree(root)) return json(400, { code: 'P0001', message: `No quedan asientos disponibles en el plan de la institución (${seatsUsed(root)} de ${account(root).seats} en uso)` });
      const r = inviteMember(body.p_inst, body.p_email, body.p_role, me); return json(200, r);
    }
    if (fn === 'set_member_role') {
      const pr = db.profiles.find(x => x.id === body.p_user); if (!pr || !['teacher', 'org_admin'].includes(body.p_role)) return json(400, { message: 'invalid' });
      pr.role = body.p_role; return json(200, null);
    }
    if (fn === 'remove_member') {
      const pr = db.profiles.find(x => x.id === body.p_user); if (!pr) return json(400, { message: 'invalid' });
      pr.institution_id = null; pr.role = 'teacher'; return json(200, null);
    }
    // ── invitations (TC-07 / TC-16 / P-04) ──
    if (fn === 'my_invitations') {
      if (!me) return NOAUTH();
      const mine = db.invitations.filter(i => invPending(i) && (i.user_id === me.id || (!i.user_id && i.email === String(me.email).toLowerCase())));
      return json(200, mine.map(i => ({ id: i.id, role: i.role, institution_id: i.institution_id, unit_name: instById(i.institution_id)?.name, path: chainOf(i.institution_id).map(x => x.name).join(' › '),
        invited_by: (db.profiles.find(x => x.id === i.invited_by) || {}).name || 'TeroClass', created_at: i.created_at, expires_at: i.expires_at })));
    }
    if (fn === 'respond_invitation') {
      const i = db.invitations.find(x => x.id === body.p_id && (x.user_id === me?.id || (!x.user_id && x.email === String(me?.email).toLowerCase())));
      if (!i) return NOAUTH();
      if (!invPending(i)) return json(400, { code: 'P0001', message: 'Esta invitación ya no está vigente' });
      if (!body.p_accept) { i.declined_at = new Date().toISOString(); return json(200, { status: 'declined' }); }
      const root = rootOf(i.institution_id); const counted = meP && ['teacher', 'org_admin'].includes(meP.role) && meP.institution_id && rootOf(meP.institution_id) === root;
      if (!counted && !seatFree(root)) return json(400, { code: 'P0001', message: 'No quedan asientos disponibles en el plan de la institución' });
      meP.institution_id = i.institution_id; meP.role = i.role; i.accepted_at = new Date().toISOString(); i.user_id = me.id; students.applyPending(meP);
      return json(200, { status: 'accepted', institution_id: i.institution_id, role: i.role });
    }
    if (fn === 'list_invitations') {
      const scope = [body.p_unit, ...descendantsOf(body.p_unit)];
      if (!(isSA || (meP?.role === 'org_admin' && meP.institution_id && chainOf(body.p_unit).some(c => c.id === meP.institution_id)))) return NOAUTH();
      return json(200, db.invitations.filter(i => scope.includes(i.institution_id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(i => ({ id: i.id, email: i.email, role: i.role, unit_id: i.institution_id, unit_name: instById(i.institution_id)?.name, unit_slug: instById(i.institution_id)?.slug, created_at: i.created_at, expires_at: i.expires_at,
          status: invStatus(i), has_account: !!i.user_id, invited_by: (db.profiles.find(x => x.id === i.invited_by) || {}).name || 'TeroClass' })));
    }
    if (fn === 'cancel_invitation') { const i = db.invitations.find(x => x.id === body.p_id); if (!i) return NOAUTH(); if (i.accepted_at) return json(400, { code: 'P0001', message: 'Esta invitación ya fue aceptada' }); i.cancelled_at = new Date().toISOString(); return json(200, 'cancelled'); }
    if (fn === 'resend_invitation') {
      const i = db.invitations.find(x => x.id === body.p_id); if (!i) return NOAUTH();
      if (i.accepted_at || i.declined_at) return json(400, { code: 'P0001', message: 'Esta invitación ya fue aceptada' });
      i.cancelled_at = null; i.expires_at = new Date(Date.now() + INV_TTL).toISOString(); i.last_sent_at = new Date().toISOString();
      return json(200, { id: i.id, email: i.email, role: i.role, unit_name: instById(i.institution_id)?.name, unit_slug: instById(i.institution_id)?.slug, expires_at: i.expires_at, has_account: !!i.user_id });
    }
    // ── plan of a calendar class (P-06) ──
    if (fn === 'set_session_plan') {
      const s = db.class_sessions.find(x => x.id === body.p_session); const g = s && s.group_id && db.class_groups.find(x => x.id === s.group_id);
      const teaches = s && me && ((g && [g.teacher_id, g.substitute_id].includes(me.id)) || (!s.group_id && s.teacher_id === me.id));
      if (!teaches) return NOAUTH();
      let title = null;
      if (body.p_planning) { const pl = db.plannings.find(x => x.id === body.p_planning && x.owner_id === me.id); if (!pl) return json(400, { code: 'P0001', message: 'Esa planificación no es tuya' }); title = pl.title; }
      s.planning_id = body.p_planning || null; return json(200, { planning_id: s.planning_id, planning_title: title });
    }
    if (fn === 'session_plan') {
      const s = db.class_sessions.find(x => x.id === body.p_session); const g = s && s.group_id && db.class_groups.find(x => x.id === s.group_id);
      const teaches = s && me && ((g && [g.teacher_id, g.substitute_id].includes(me.id)) || (!s.group_id && s.teacher_id === me.id));
      const pl = teaches && s.planning_id && db.plannings.find(x => x.id === s.planning_id);
      return json(200, pl ? { id: pl.id, title: pl.title, content: pl.data?.content || '', student: pl.data?.student || '', params: pl.data?.params || {}, mine: pl.owner_id === me.id } : null);
    }
    if (fn === 'my_data_export') { if (!me) return NOAUTH(); return json(200, { exported_at: new Date().toISOString(), profile: { email: meP.email, name: meP.name, role: meP.role }, plannings: db.plannings.filter(x => x.owner_id === me.id).map(x => ({ title: x.title, data: x.data })) }); }
    { const r = plans.handle(fn, body, me); if (r) return json(r.status, r.data); }
    { const r = consent.handle(fn, body, me); if (r) return json(r.status, r.data); }
    { const r = classInsights.handle(fn, body, me); if (r) return json(r.status, r.data); }
    { const r = classBoard.handle(fn, body, me); if (r) return json(r.status, r.data); }
    { const r = notebook.handle(fn, body, me); if (r) return json(r.status, r.data); }
    { const r = classDoc.handle(fn, body, me);
      if (r && fn === 'group_sessions' && r.status === 200) r.data.sessions.forEach(x => Object.assign(x, classBoard.flags(x.id))); // + the class whiteboard
      if (r) return json(r.status, r.data); }
    { const r = students.handle(fn, body, me);
      if (r && fn === 'student_view' && r.status === 200) { // + attendance summary and the documents of past classes (own enrollments only)
        const eids = body.p_enrollment ? [body.p_enrollment] : (!body.p_group && me ? db.student_enrollments.filter(e => e.user_id === me.id).map(e => e.id) : []);
        Object.assign(r.data, classDoc.studentExtras(eids), { boards: classBoard.studentBoards(eids) });
      }
      if (r) return json(r.status, r.data); }
    if (fn === 'get_document_content') {
      const d = db.institution_documents.find(x => x.id === body.p_id); return d ? json(200, d.content) : json(400, { message: 'not found' });
    }
    return json(404, { message: 'no fn' });
  }
  if (p.startsWith('/rest/v1/')) {
    if (!me) return json(401, { message: 'JWT required' });
    const table = p.split('/').pop(); const rows = db[table];
    if (m === 'GET') {
      const meP = db.profiles.find(x => x.id === me.id); const sa = meP?.role === 'superadmin';
      let base = table === 'institutions' ? visibleInstitutions(me) : rows;
      if (table === 'profiles' && !sa) base = base.filter(r => (r.role !== 'superadmin' && r.role !== 'student') || r.id === me.id); // RLS: owner + students hidden
      if (table === 'plannings' && !sa) { const owners = new Set(db.profiles.filter(x => x.role === 'superadmin' && x.id !== me.id).map(x => x.id)); base = base.filter(r => !owners.has(r.owner_id)); }
      const out = project(applyFilters(base, url), url);
      const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
      if (single) return out.length ? json(200, out[0]) : json(406, { code: 'PGRST116', message: 'no rows' });
      return json(200, out);
    }
    if (m === 'POST') { calls.inserts[table] = (calls.inserts[table] || 0) + 1; const r = { id: uid(), created_at: new Date().toISOString(), ...body }; rows.push(r); return json(201, (req.headers()['accept'] || '').includes('vnd.pgrst.object') ? r : [r]); }
    if (m === 'DELETE') { const del = applyFilters(rows, url); db[table] = rows.filter(r => !del.includes(r)); return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }); }
    if (m === 'PATCH') { applyFilters(rows, url).forEach(r => Object.assign(r, body)); return json(200, []); }
  }
  return json(404, { message: 'unmocked ' + m + ' ' + p });
}
// invite_member core (permission checked by the caller), as 001_base.sql since 2026-10 (TC-07):
// own staff of the same account → moved directly ('added'); any other existing account → pending invitation it accepts in the
// app ('pending'); no account → invitation by e-mail ('invited'). Invitations expire after 14 days.
function inviteMember(inst, email, role, by) {
  email = String(email).toLowerCase(); const pr = db.profiles.find(x => x.email.toLowerCase() === email); const root = rootOf(inst);
  const counted = pr && ['teacher', 'org_admin'].includes(pr.role) && pr.institution_id && rootOf(pr.institution_id) === root;
  if (!counted && !seatFree(root)) { const e = new Error(`No quedan asientos disponibles en el plan de la institución (${seatsUsed(root)} de ${account(root).seats} en uso)`); e.seats = true; throw e; }
  if (pr && counted) { pr.institution_id = inst; pr.role = role; students.applyPending(pr); return 'added'; }
  const now = new Date().toISOString(); const exp = new Date(Date.now() + INV_TTL).toISOString();
  db.invitations = db.invitations.filter(i => !(i.institution_id === inst && !i.accepted_at && (i.email === email || (pr && i.user_id === pr.id))));
  const byP = by && db.profiles.find(x => x.id === by.id); // the owner is never stored as "invited by" (hide_superadmin_refs)
  db.invitations.push({ id: uid(), email, institution_id: inst, role, created_at: now, expires_at: exp, invited_by: byP && byP.role !== 'superadmin' ? byP.id : null, user_id: pr ? pr.id : null });
  return pr ? 'pending' : 'invited';
}
const classInsights = require('./mock-insights.cjs')({ db, uid, instById, chainOf, descendantsOf, rootOf });
const classDoc = require('./mock-classdoc.cjs')({ db, uid, instById, chainOf, descendantsOf, rootOf });
const plans = require('./mock-plans.cjs')({ db, uid, instById, rootOf, account, bill });
const consent = require('./mock-consent.cjs')({ db, uid, instById, chainOf, descendantsOf, rootOf });
const classBoard = require('./mock-classboard.cjs')({ db, uid, classDoc });
const notebook = require('./mock-notebook.cjs')({ db, uid, chainOf, classDoc });
const realtime = require('./mock-realtime.cjs')({ tokUser, canRealtime: (me, t, send) => classDoc.canRealtime(me, t, send) || classBoard.canRealtime(me, t, send) || notebook.canRealtime(me, t, send),
  publicTopicOk: t => classDoc.publicTopicOk(t) || classBoard.publicTopicOk(t) || notebook.publicTopicOk(t) });
const students = require('./mock-students.cjs')({ db, uid, instById, chainOf, descendantsOf, rootOf, inviteMember, seatsFree: root => Math.max(account(root).seats - seatsUsed(root), 0),
  insightSummaries: (eids, me) => classInsights.summaries(eids, 5, me) });
module.exports = { plans, tokUser, consent, students, classInsights, classDoc, classBoard, notebook, realtime, serveVendor, serveWhiteboard, db, bill, calls, insights, insightsData, uid, resetDb, newUser, seedInstitution, session, handleSupabase, HTML, RAW_HTML, SB_JS, SB, SUPERADMIN_EMAIL, effectiveConfig, chainOf };
