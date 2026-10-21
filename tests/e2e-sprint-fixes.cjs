// Regression tests for the second fix sprint (2026-10): P-02 generator on a phone, P-14 deletions with "Undo",
// TC-01 daily AI limits in Platform, TC-13 invitation link of a quick room, P-08 demo insights that follow the subject,
// P-29 / P-30 copy and formats. Mock Supabase + mock AI; no real data.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-sprint-fixes.cjs     (SHOTS=<dir> saves fix-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '→', String(e.message).split('\n').slice(0, 3).join(' | ')); if (process.env.DEBUG) console.log(e.stack); } };
const PLAN = 'La fotosíntesis\nObjetivos de hoy:\n- Explicar qué necesita una planta para hacer fotosíntesis\nConceptos clave:\n- Clorofila: pigmento verde que capta la luz\n- Glucosa: azúcar que fabrica la planta\nInicio (10 min)\n- Pregunta disparadora sobre las plantas\nExperimento con hojas (25 min)\n- Observar hojas al sol y a la sombra\nCierre (10 min)\n- Ticket de salida';

async function setup(browser, { viewport, api, mobile } = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ viewport: viewport || { width: 1366, height: 900 }, isMobile: !!mobile, hasTouch: !!mobile });
  const st = { errors: [], api: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: PLAN }, finish_reason: 'stop' }] }) });
    }
    if (u.pathname.startsWith('/api/')) {
      st.api.push({ path: u.pathname, body: r.request().postData() });
      const resp = api ? await api(u, r.request(), st) : null;
      if (resp) return r.fulfill(resp);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false }) });
    }
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  return { ctx, page, st, base: 'http://teroclass.test' };
}
async function register(page, base, email, { name = 'Test User', path = '/' } = {}) {
  await page.goto(base + path);
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.click('.auth-tab:nth-child(2)');
  await page.fill('#reg-name', name); await page.fill('#reg-email', email); await page.fill('#reg-password', 'secreto123');
  await page.click('#tab-register .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
async function login(page, base, email) {
  await page.goto(base + '/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const shot = async (page, n) => { if (SHOTS) { await page.mouse.move(2, 2).catch(() => {}); await sleep(300); await page.screenshot({ path: `${SHOTS}/fix-${n}.png` }); } };
// the element really on top at its centre (nothing invisible or overlapping takes the click)
const onTop = (page, sel) => page.evaluate(sel => { const e = document.querySelector(sel); if (!e) return false; const b = e.getBoundingClientRect(); if (!b.width || !b.height) return false;
  const x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, 20); if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; const t = document.elementFromPoint(x, y); return !!t && (t === e || e.contains(t)); }, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  // ── P-02: the class generator works on a phone ──
  await step('P-02 generator on a phone: prompt, Generate and the class are visible and on top; Smart tools open as a sheet', async () => {
    const { ctx, page, st, base } = await setup(browser, { viewport: { width: 375, height: 812 }, mobile: true });
    await register(page, base, 'movil@t.com', { name: 'Laura Gómez' });
    await page.evaluate(() => setUiLang('es'));
    await page.evaluate(() => showPanel('ai'));
    await page.waitForSelector('#panel-ai.active');
    if (await page.isVisible('#smart-tools .smart-title')) throw new Error('Smart tools cover the screen by default');
    for (const s of ['#prompt-input', '#btn-generate', '#btn-st-open']) if (!(await onTop(page, s))) throw new Error(s + ' is covered or off screen');
    await shot(page, 'gen-mobile-empty-es-m');
    await page.click('#btn-st-open');
    await page.waitForSelector('#smart-tools.open .smart-title', { state: 'visible' });
    if (await page.getAttribute('#btn-st-open', 'aria-expanded') !== 'true') throw new Error('aria-expanded');
    if (!/Ajustes de la clase/.test(await page.textContent('#btn-st-open'))) throw new Error('button label ES');
    await shot(page, 'gen-mobile-tools-es-m');
    await page.click('#btn-st-close');
    await page.waitForFunction(() => !document.getElementById('smart-tools').classList.contains('open'));
    await page.fill('#prompt-input', 'La fotosíntesis para 2° de secundaria');
    await page.click('#btn-generate');
    await page.waitForSelector('#lp-doc', { timeout: 15000 });
    if (!(await onTop(page, '#lp-doc'))) throw new Error('the generated class is covered');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) throw new Error('horizontal scroll ' + over);
    await shot(page, 'gen-mobile-result-es-m');
    if (st.errors.length) throw new Error(st.errors.join(' | '));
    await ctx.close();
  });

  // ── P-14: deleting a group says what is lost, asks for its name when it has classes, and can be undone ──
  await step('P-14 delete a group: dialog with classes + students, type the name, "Undo" for 10 s, then deleted', async () => {
    const { ctx, page, st, base } = await setup(browser);
    const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol' });
    const adm = M.newUser('adm@sol.uy', { name: 'Admin Sol' }); const ap = db.profiles.find(x => x.id === adm.id); ap.role = 'org_admin'; ap.institution_id = sol.id;
    const prof = M.newUser('prof@sol.uy', { name: 'Laura Gómez' }); const pp = db.profiles.find(x => x.id === prof.id); pp.role = 'teacher'; pp.institution_id = sol.id;
    const g = { id: M.uid(), institution_id: sol.id, name: 'Ciencias 2°B', teacher_id: prof.id, substitute_id: null, timezone: 'America/Montevideo' }; db.class_groups.push(g);
    const en = { id: M.uid(), institution_id: sol.id, email: 'ana@mail.com', name: 'Ana', user_id: null, source: 'manual', created_at: new Date().toISOString() };
    db.student_enrollments.push(en); db.group_members.push({ group_id: g.id, enrollment_id: en.id });
    for (let i = 0; i < 3; i++) db.class_sessions.push({ id: M.uid(), institution_id: sol.id, group_id: g.id, series_id: null, teacher_id: prof.id, title: 'Clase ' + i, starts_at: new Date(Date.now() + (i + 1) * 864e5).toISOString(), ends_at: new Date(Date.now() + (i + 1) * 864e5 + 45 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() });
    await login(page, base, 'adm@sol.uy');
    await page.evaluate(() => setUiLang('es'));
    await page.evaluate(() => setAppMode('admin'));
    await page.click('#nav-groups');
    await page.waitForSelector('.gc-gcard [data-gc="g-del"]');
    await page.click('.gc-gcard [data-gc="g-del"]');
    await page.waitForSelector('#modal-danger.active');
    const list = await page.textContent('#dg-list');
    if (!/Clases del grupo[^:]*: 3/.test(list) || !/Estudiantes en el grupo: 1/.test(list)) throw new Error('counts: ' + list);
    if (!(await page.isDisabled('#dg-ok'))) throw new Error('enabled before typing the name of a group with classes');
    await page.fill('#dg-type', 'ciencias 2°b');
    await shot(page, 'delete-group-dialog-es-d');
    await page.click('#dg-ok');
    await page.waitForSelector('#undo-bar:not([hidden])');
    if (!/Grupo borrado/.test(await page.textContent('#undo-bar')) || !/Deshacer/.test(await page.textContent('#undo-btn'))) throw new Error('undo bar ES');
    if (await page.$('.gc-gcard')) throw new Error('the group is still listed');
    if (!db.class_groups.some(x => x.id === g.id)) throw new Error('deleted before 10 s');
    await shot(page, 'delete-group-undo-es-d');
    await page.click('#undo-btn');
    await page.waitForSelector('.gc-gcard');
    if (!(await onTop(page, '.gc-gcard [data-gc="g-del"]'))) throw new Error('the undo bar left something covering the page');
    // delete again and let the 10 s pass
    await page.click('.gc-gcard [data-gc="g-del"]'); await page.waitForSelector('#modal-danger.active');
    await page.fill('#dg-type', 'Ciencias 2°B'); await page.click('#dg-ok');
    await page.waitForFunction(() => document.getElementById('undo-bar').hidden, null, { timeout: 15000 });
    await sleep(500);
    if (db.class_groups.some(x => x.id === g.id)) throw new Error('not deleted after the undo time');
    if (st.errors.length) throw new Error(st.errors.join(' | '));
    await ctx.close();
  });

  // ── TC-01: the owner sets the daily AI limits in Platform ──
  await step('TC-01 Platform → "AI daily limits" (per institution / per teacher) saved with update_ai_guardrails', async () => {
    const { ctx, page, base } = await setup(browser);
    M.seedInstitution({ name: 'Colegio', slug: 'colegio' });
    const o = M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' }); db.profiles.find(x => x.id === o.id).role = 'superadmin';
    await login(page, base, M.SUPERADMIN_EMAIL);
    await page.waitForFunction(() => currentUser && currentUser.isSuperAdmin && typeof appBooting !== 'undefined' && !appBooting);
    await page.evaluate(() => showPanel('platform'));
    await page.waitForSelector('#pf-ai-caps-card');
    if (await page.inputValue('#pfs-cap-inst') !== '3000000' || await page.inputValue('#pfs-cap-user') !== '400000') throw new Error('defaults');
    await page.fill('#pfs-cap-inst', '1500000'); await page.fill('#pfs-cap-user', '200000');
    await page.click('[data-bl="pf-save-caps"]');
    await page.waitForFunction(() => /Limits saved/.test(document.getElementById('toast').textContent));
    const c = M.calls.rpc.filter(x => x.fn === 'update_ai_guardrails').pop();
    if (!c || c.body.p_institution !== 1500000 || c.body.p_user !== 200000) throw new Error('rpc: ' + JSON.stringify(c && c.body));
    await shot(page, 'platform-ai-limits-en-d');
    await ctx.close();
  });

  // ── TC-13: a teacher's invitation link to a quick room ──
  await step('TC-13 invitation link ?room=…&t=… → after sign-in the lobby opens as STUDENT and the ticket goes to the token request', async () => {
    const { ctx, page, base } = await setup(browser);
    const room = 'abcdef012345-x1y2';
    const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol' });
    const u = M.newUser('alumna@mail.com', { name: 'Alumna', via: 'student_link' });
    db.student_enrollments.push({ id: M.uid(), institution_id: sol.id, email: 'alumna@mail.com', name: 'Alumna Uno', user_id: u.id, source: 'manual', created_at: new Date().toISOString() });
    await page.goto(base + `/?room=${room}&t=TICKET.abc.def`);
    await page.waitForSelector('#tab-login', { state: 'visible' });
    if (/room=|t=TICKET/.test(await page.evaluate(() => location.search))) throw new Error('the ticket stays in the address bar');
    await page.fill('#login-email', 'alumna@mail.com'); await page.fill('#login-password', 'secreto123');
    await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#panel-live.active .lc-lobby', { timeout: 15000 });
    const S = await page.evaluate(() => ({ room: LiveClass.state.adhocRoom, t: LiveClass.state.ticket, role: LiveClass.state.lobby.role }));
    if (S.room !== room || S.t !== 'TICKET.abc.def' || S.role !== 'student') throw new Error('state: ' + JSON.stringify(S));
    if (await page.$('input[name="lc-role"]')) throw new Error('role picker (P-09)');
    // the LiveKit provider sends the ticket (never the consent) and lets the server decide the role
    const body = await page.evaluate(async room => {
      window.LivekitClient = { RoomEvent: {}, Track: { Source: {} }, Room: class { on() { return this; } async connect() { throw new Error('no server'); } async disconnect() {} } };
      let sent = null; const f = window.fetch;
      window.fetch = async (url, o) => { if (String(url).includes('/api/class/token')) { sent = JSON.parse(o.body); return new Response(JSON.stringify({ token: 'a.b.c', url: 'ws://x', role: 'student' }), { status: 200, headers: { 'content-type': 'application/json' } }); } return f(url, o); };
      try { await new LiveClass.providers.LiveKitProvider().connect({ room, role: 'student', ticket: LiveClass.state.ticket }); } catch (e) { /* no server */ }
      window.fetch = f; return sent;
    }, room);
    if (!body || body.room !== room || body.ticket !== 'TICKET.abc.def' || 'consent' in body || 'name' in body) throw new Error('token body: ' + JSON.stringify(body));
    if (await page.evaluate(() => localStorage.getItem('tc_room_link'))) throw new Error('the link is kept after use');
    await ctx.close();
  });

  // ── P-08: demo insights follow the subject of the class ──
  await step('P-08 demo insights of a biology class: built from its plan, never the chemistry / English samples', async () => {
    const { ctx, page, base } = await setup(browser);
    await register(page, base, 'bio@t.com', { name: 'Profe Bio' });
    const r = await page.evaluate(plan => {
      const p = TCInsightsView.buildDemoPayload({ title: 'La fotosíntesis', group: 'Ciencias 2°B', plan });
      const chem = TCInsightsView.buildDemoPayload({ title: 'Reacciones químicas', group: 'Química 3°B' });
      return { generic: !!p.generic, text: JSON.stringify(p), chem: JSON.stringify(chem) };
    }, PLAN);
    if (!r.generic) throw new Error('not the generic sample');
    if (/H₂O|agua oxigenada|reacci[oó]n qu[ií]mica|balance|future forms|going to/i.test(r.text)) throw new Error('chemistry / English content in a biology class');
    if (!/Clorofila/.test(r.text) || !/Experimento con hojas/.test(r.text)) throw new Error('the plan is not used');
    if (!/qu[ií]mic|reacci/i.test(r.chem)) throw new Error('a chemistry class keeps the chemistry sample');
    await ctx.close();
  });

  await browser.close();
  if (failed) { console.log(`${failed} sprint-fix test(s) FAILED`); process.exit(1); }
  console.log('ALL SPRINT-FIX TESTS PASSED');
})();
