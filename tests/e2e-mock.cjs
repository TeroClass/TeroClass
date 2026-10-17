// Prueba de punta a punta con un Supabase simulado (no toca datos reales).
// Uso: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-mock.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SB_JS = fs.readFileSync(process.env.SB_JS || '/tmp/package/dist/umd/supabase.js', 'utf8');
const SB = 'https://ppvqkjchhejjulrdqkdr.supabase.co';

const db = { users: {}, profiles: [], institutions: [], plannings: [], invitations: [] };
let n = 0; const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const tokUser = t => Object.values(db.users).find(u => 'tok-' + u.id === t);
function session(u) {
  return { access_token: 'tok-' + u.id, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'r-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta, app_metadata: {} } };
}
function newUser(email, meta) {
  const id = uid(); db.users[id] = { id, email, meta };
  const inv = db.invitations.find(i => i.email === email.toLowerCase() && !i.accepted_at);
  const bySlug = db.institutions.find(i => i.slug === meta.org_slug);
  db.profiles.push({ id, email, name: meta.name || '', role: email.toLowerCase() === 'im.silveiratrabal@gmail.com' ? 'superadmin' : (inv ? inv.role : 'teacher'),
    institution_id: inv ? inv.institution_id : (bySlug ? bySlug.id : null) });
  if (inv) inv.accepted_at = new Date().toISOString();
  return db.users[id];
}
function applyFilters(rows, url) {
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'columns'].includes(k)) continue;
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === v.slice(3));
  }
  return rows;
}
async function handleSupabase(route) {
  const req = route.request(); const url = new URL(req.url()); const p = url.pathname; const m = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
  const auth = (req.headers()['authorization'] || '').replace('Bearer ', '');
  if (m === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (p === '/auth/v1/signup') {
    if (Object.values(db.users).some(u => u.email === body.email)) return json(422, { msg: 'User already registered', error_code: 'user_already_exists' });
    return json(200, session(newUser(body.email, body.data || {})));
  }
  if (p === '/auth/v1/token') { const u = Object.values(db.users).find(x => x.email === body.email); return u ? json(200, session(u)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' }); }
  if (p === '/auth/v1/user') { const u = tokUser(auth); return u ? json(200, session(u).user) : json(401, { msg: 'bad jwt' }); }
  if (p === '/auth/v1/logout') return route.fulfill({ status: 204 });
  const me = tokUser(auth);
  if (p.startsWith('/rest/v1/rpc/')) {
    const fn = p.split('/').pop();
    if (fn === 'get_org_branding') { const i = db.institutions.find(x => x.slug === body.p_slug); return json(200, i ? [i] : []); }
    if (fn === 'create_institution') {
      const id = uid(); db.institutions.push({ id, name: body.p_name, slug: body.p_slug, color: body.p_color, bg_color: '#f0eef8', font: 'Inter', admin_email: body.p_admin_email, master_prompt: '', doc_text: '', doc_name: '', logo_url: null, created_at: new Date().toISOString() });
      db.invitations.push({ email: body.p_admin_email.toLowerCase(), institution_id: id, role: 'org_admin' }); return json(200, id);
    }
    if (fn === 'invite_member') { const pr = db.profiles.find(x => x.email === body.p_email); if (pr) { pr.institution_id = body.p_inst; pr.role = body.p_role; return json(200, 'added'); } db.invitations.push({ email: body.p_email, institution_id: body.p_inst, role: body.p_role }); return json(200, 'invited'); }
    return json(404, { message: 'no fn' });
  }
  if (p.startsWith('/rest/v1/')) {
    if (!me) return json(401, { message: 'JWT required' });
    const table = p.split('/').pop(); const rows = db[table];
    if (m === 'GET') {
      let out = applyFilters(rows, url);
      const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
      if (single) return out.length ? json(200, out[0]) : json(406, { code: 'PGRST116', message: 'no rows' });
      return json(200, out);
    }
    if (m === 'POST') { const r = { id: uid(), created_at: new Date().toISOString(), ...body }; rows.push(r); return json(201, (req.headers()['accept'] || '').includes('vnd.pgrst.object') ? r : [r]); }
    if (m === 'PATCH') { applyFilters(rows, url).forEach(r => Object.assign(r, body)); return json(200, []); }
  }
  return json(404, { message: 'unmocked ' + m + ' ' + p });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const errors = [];
  let aiCall = null; let studentCalls = 0;
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: SB_JS }));
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData());
      if (JSON.stringify(b).includes('STUDENT HANDOUT')) { studentCalls++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Chemical reactions\nToday\'s goals:\n- You will be able to balance equations\nCard 1: H2 + O2 → ________' } }] }) }); }
      aiCall = { auth: r.request().headers()['authorization'], body: b };
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Week 1 - Class 1 - Test - Small talk\nAttendance:\n\nToday\'s Objectives:\n- Practice greetings <img src=x onerror=window.__xss=1>\n- Ask questions' } }] }) });
    }
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, '→', e.message.split('\n')[0]); process.exitCode = 1; } };
  const shot = async n => page.screenshot({ path: `/tmp/claude-0/shot-${n}.png` });

  await page.goto('http://teroclass.test/');
  await step('Pantalla de login visible', async () => { await page.waitForSelector('#tab-login', { state: 'visible' }); });

  await step('Registro súper admin', async () => {
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Ignacio Silveira'); await page.fill('#reg-email', 'im.silveiratrabal@gmail.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await page.waitForSelector('#panel-superadmin.active');
    if (!(await page.isVisible('#nav-superadmin'))) throw new Error('nav superadmin oculto');
  });
  await shot(1);

  await step('Crear institución', async () => {
    await page.evaluate(() => showCreateInstitution());
    await page.fill('#new-inst-name', 'The English Coach'); await page.fill('#new-inst-slug', 'tec'); await page.fill('#new-inst-admin', 'dire@tec.com');
    await page.click('#modal-create-inst .btn-modal-save');
    await page.waitForSelector('.inst-card');
    const t = await page.textContent('.inst-name'); if (t !== 'The English Coach') throw new Error(t);
  });
  await shot(2);

  await step('Ver institución → dashboard + AI settings', async () => {
    await page.click('.btn-inst-action.primary');
    await page.waitForSelector('#panel-admin.active');
    await page.click('#nav-master');
    await page.fill('#mp-prompt', 'Always use CEFR levels.');
    await page.click('#panel-master .btn-save-settings');
    await page.waitForTimeout(300);
    if (db.institutions[0].master_prompt !== 'Always use CEFR levels.') throw new Error('master prompt no guardado');
  });

  await step('Invitar docente', async () => {
    await page.click('.btn-invite');
    await page.fill('#invite-email', 'profe@tec.com');
    await page.click('#modal-invite .btn-modal-save');
    await page.waitForTimeout(300);
    if (!db.invitations.find(i => i.email === 'profe@tec.com')) throw new Error('sin invitación');
  });

  await step('Generar y guardar clase', async () => {
    await page.click('#nav-ai');
    await page.fill('#subjects-input', 'Chemistry'); await page.press('#subjects-input', 'Enter');
    await page.fill('#prompt-input', 'Chemical reactions');
    await page.click('#btn-generate');
    await page.waitForSelector('#lp-doc');
    if (!aiCall?.auth?.startsWith('Bearer tok-')) throw new Error('la IA no recibió la sesión');
    if (process.env.SHOW_PROMPT) console.log(aiCall.body.messages[1].content);
    if (!aiCall.body.messages[1].content.includes('REQUIREMENTS')) throw new Error('las barras no llegan al prompt');
    if (!aiCall.body.messages[1].content.includes('NOT a language class')) throw new Error('no respeta la disciplina');
    if (!aiCall.body.messages[1].content.includes('GOLDEN RULE')) throw new Error('falta materiales listos');
    if (JSON.stringify(aiCall.body).includes('apiKey')) throw new Error('se envía apiKey desde el navegador');
    await page.waitForFunction(() => document.getElementById('lp-doc-student')?.innerText.includes('You will be able'));
    if (studentCalls !== 1) throw new Error('no se pidió el material del alumno');
    await page.click('#tab-student');
    if (!(await page.isVisible('#lp-doc-student')) || await page.isVisible('#lp-doc')) throw new Error('pestañas no cambian');
    await page.click('#tab-teacher');
    await page.click('#btn-save');
    await page.waitForTimeout(400);
    if (!db.plannings[0]?.data?.student?.includes('You will be able')) throw new Error('no se guardó el material del alumno');
    if (db.plannings.length !== 1 || !db.plannings[0].data.content.includes('greetings')) throw new Error('clase no guardada con contenido');
    if (await page.evaluate(() => window.__xss)) throw new Error('HTML del modelo se ejecutó');
  });
  await shot(3);

  await step('Recargar: sesión y clases persisten', async () => {
    await page.reload();
    await page.waitForSelector('#screen-app.active');
    await page.click('#nav-home');
    await page.waitForSelector('.class-card');
  });

  await step('Abrir clase guardada, editarla y guardar cambios (sin duplicar)', async () => {
    await page.click('.class-card');
    await page.waitForSelector('#lp-doc');
    const txt = await page.textContent('#lp-doc'); if (!txt.includes('greetings')) throw new Error('contenido no cargado');
    await page.evaluate(() => { document.getElementById('lp-doc').insertAdjacentHTML('beforeend', '<div class="cls-line">Extra note</div>'); });
    await page.click('#btn-save');
    await page.waitForTimeout(400);
    if (studentCalls !== 1) throw new Error('regeneró el material del alumno al abrir');
    if (db.plannings.length !== 1) throw new Error('se duplicó: ' + db.plannings.length);
    if (!db.plannings[0].data.content.includes('Extra note')) throw new Error('no se guardó la edición');
  });

  await step('Salir y entrar de nuevo', async () => {
    await page.evaluate(() => handleLogout());
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.fill('#login-email', 'im.silveiratrabal@gmail.com'); await page.fill('#login-password', 'secreto123');
    await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#screen-app.active');
  });

  await step('Docente invitado se registra desde /org/tec con la marca', async () => {
    await page.evaluate(() => handleLogout());
    await page.goto('http://teroclass.test/org/tec');
    await page.waitForFunction(() => document.getElementById('auth-org-name')?.textContent === 'The English Coach');
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Profe Test'); await page.fill('#reg-email', 'profe@tec.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    const brand = await page.textContent('#topbar-brand-name'); if (brand !== 'The English Coach') throw new Error('marca: ' + brand);
    if (await page.isVisible('#nav-admin')) throw new Error('docente ve dashboard');
    await page.click('#nav-home');
    if (await page.$('.class-card')) throw new Error('docente ve clases ajenas');
  });
  await shot(4);

  const real = errors.filter(e => !/favicon|ERR_FAILED|Failed to load resource/.test(e));
  console.log(real.length ? 'Errores en consola:\n' + real.join('\n') : 'Sin errores de consola');
  if (real.length) process.exitCode = 1;
  await browser.close();
})();
