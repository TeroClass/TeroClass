// Supabase simulado para las pruebas e2e (no toca datos reales).
// Incluye las RPC nuevas: set_member_role, remove_member, get_document_content, y open_registration en institutions.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
// Tests that answer every page request with HTML get the live-class assets inlined
// (in production they are separate files: see vercel.json). Function replacers: no $-patterns.
const asset = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const HTML = RAW_HTML
  .replace('<link rel="stylesheet" href="/live-class.css">', () => `<style>${asset('live-class.css')}</style>`)
  .replace('<script src="/live-class.js"></script>', () => `<script>${asset('live-class.js')}</script>`);
const SB_JS = fs.readFileSync(process.env.SB_JS || '/tmp/package/dist/umd/supabase.js', 'utf8');
const SB = 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const SUPERADMIN_EMAIL = 'im.silveiratrabal@gmail.com';

const db = { users: {}, profiles: [], institutions: [], plannings: [], invitations: [], institution_documents: [] };
const calls = { rpc: [], inserts: {} };
let n = 0; const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const tokUser = t => Object.values(db.users).find(u => 'tok-' + u.id === t);
function resetDb() { for (const k of Object.keys(db)) db[k] = k === 'users' ? {} : []; calls.rpc = []; calls.inserts = {}; }
function session(u) {
  return { access_token: 'tok-' + u.id, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'r-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta, app_metadata: {} } };
}
function newUser(email, meta) {
  const id = uid(); db.users[id] = { id, email, meta };
  const inv = db.invitations.find(i => i.email === email.toLowerCase() && !i.accepted_at);
  const bySlug = db.institutions.find(i => i.slug === meta.org_slug && i.open_registration !== false);
  db.profiles.push({ id, email, name: meta.name || '', role: email.toLowerCase() === SUPERADMIN_EMAIL ? 'superadmin' : (inv ? inv.role : 'teacher'),
    institution_id: inv ? inv.institution_id : (bySlug ? bySlug.id : null) });
  if (inv) inv.accepted_at = new Date().toISOString();
  return db.users[id];
}
function seedInstitution(extra = {}) {
  const id = uid();
  const row = { id, name: 'School A', slug: 'a', color: '#7c5cbf', bg_color: '#f0eef8', font: 'Inter', admin_email: 'adm@a.com', master_prompt: '', doc_text: '', doc_name: '', logo_url: null, open_registration: true, created_at: new Date().toISOString(), ...extra };
  db.institutions.push(row); return row;
}
function applyFilters(rows, url) {
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'columns'].includes(k)) continue;
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
  }
  return rows;
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
  if (p === '/auth/v1/signup') {
    if (Object.values(db.users).some(u => u.email === body.email)) return json(422, { msg: 'User already registered', error_code: 'user_already_exists' });
    const u = newUser(body.email, body.data || {});
    if (/confirm/.test(body.email)) return json(200, session(u).user); // email confirmation required → no session
    return json(200, session(u));
  }
  if (p === '/auth/v1/token') { const u = Object.values(db.users).find(x => x.email === body.email); return u ? json(200, session(u)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' }); }
  if (p === '/auth/v1/user') { const u = tokUser(auth); return u ? json(200, session(u).user) : json(401, { msg: 'bad jwt' }); }
  if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  const me = tokUser(auth);
  if (p.startsWith('/rest/v1/rpc/')) {
    const fn = p.split('/').pop();
    calls.rpc.push({ fn, body });
    if (fn === 'get_org_branding') { const i = db.institutions.find(x => x.slug === body.p_slug); return json(200, i ? [i] : []); }
    if (fn === 'create_institution') {
      if (db.institutions.some(i => i.slug === body.p_slug)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "institutions_slug_key"' });
      const row = seedInstitution({ name: body.p_name, slug: body.p_slug, color: body.p_color, admin_email: body.p_admin_email });
      db.invitations.push({ email: body.p_admin_email.toLowerCase(), institution_id: row.id, role: 'org_admin' }); return json(200, row.id);
    }
    if (fn === 'invite_member') {
      if (body.p_email.toLowerCase() === SUPERADMIN_EMAIL) return json(200, 'superadmin');
      const pr = db.profiles.find(x => x.email === body.p_email); if (pr) { pr.institution_id = body.p_inst; pr.role = body.p_role; return json(200, 'added'); }
      db.invitations.push({ email: body.p_email, institution_id: body.p_inst, role: body.p_role }); return json(200, 'invited');
    }
    if (fn === 'set_member_role') {
      const pr = db.profiles.find(x => x.id === body.p_user); if (!pr || !['teacher', 'org_admin'].includes(body.p_role)) return json(400, { message: 'invalid' });
      pr.role = body.p_role; return json(200, null);
    }
    if (fn === 'remove_member') {
      const pr = db.profiles.find(x => x.id === body.p_user); if (!pr) return json(400, { message: 'invalid' });
      pr.institution_id = null; pr.role = 'teacher'; return json(200, null);
    }
    if (fn === 'get_document_content') {
      const d = db.institution_documents.find(x => x.id === body.p_id); return d ? json(200, d.content) : json(400, { message: 'not found' });
    }
    return json(404, { message: 'no fn' });
  }
  if (p.startsWith('/rest/v1/')) {
    if (!me) return json(401, { message: 'JWT required' });
    const table = p.split('/').pop(); const rows = db[table];
    if (m === 'GET') {
      const out = project(applyFilters(rows, url), url);
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
module.exports = { db, calls, uid, resetDb, newUser, seedInstitution, session, handleSupabase, HTML, RAW_HTML, SB_JS, SB, SUPERADMIN_EMAIL };
