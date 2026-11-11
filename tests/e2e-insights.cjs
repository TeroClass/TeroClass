// Class insights (Insights per role) + the rename of the platform analytics to "Metrics" / "Métricas".
// Mock Supabase (tests/mock-supabase.cjs + tests/mock-insights.cjs) in a headless browser.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-insights.cjs   (SHOTS=<dir> saves ins-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, classInsights, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const XSS = '<img src=x onerror="window.__xss=1">';
const SHOTS = process.env.SHOTS || '';
const SECRET = 'SECRET-REFLECTION: wait 5 seconds after open questions';
const MIN = 60000;
// the shared view (browser IIFE) in node: the same demo payload the app sends
global.window = global.window || {};
require('../public/insights-view.js');
const V = global.window.TCInsightsView;

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, hasTouch: !!opts.mobile, isMobile: !!opts.mobile });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: '{"billing_configured":true,"billing_ok":true}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource/.test(m.text())) st.errors.push('console: ' + m.text()); });
  return { ctx, page, st };
}
async function run(name, browser, fn, opts) {
  const env = await setup(browser, opts);
  try {
    await fn(env);
    if (await env.page.evaluate(() => window.__xss)) throw new Error('XSS executed');
    if (env.st.errors.length) throw new Error(env.st.errors.join(' | '));
    console.log('✓', name);
  } catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); if (process.env.DEBUG) console.log(e.stack); }
  finally { await env.ctx.close(); }
}
async function login(page, email, lang = 'en') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
async function logout(page) { await page.evaluate(() => handleLogout()); await page.waitForSelector('#tab-login', { state: 'visible' }); }
const text = (page, sel) => page.textContent(sel);
const visible = (page, sel) => page.isVisible(sel);
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const shot = async (page, name) => { if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/ins-${name}.png` }); };
const hscroll = page => page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ins-root')].filter(r => r.offsetParent).map(r => r.scrollWidth - r.clientWidth)));
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);
const ago = ms => new Date(Date.now() - ms).toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();

// Coach (madre) › Sede Centro ; Coach › Sede Norte ; Otra Escuela. Group G1 (Centro: teacher Tina + substitute Sergio)
// with Ana, Bruno (accounts) and Carla; group G2 (Norte: teacher Nico) with Dani; group GO (Otra) with Olga.
function seed() {
  const madre = M.seedInstitution({ name: 'The English Coach', slug: 'coach', color: '#aa0000' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', color: null, bg_color: null, font: null, parent_id: madre.id });
  const norte = M.seedInstitution({ name: 'Sede Norte', slug: 'norte', color: null, bg_color: null, font: null, parent_id: madre.id });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, role, inst, name) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const owner = M.newUser('owner@teroclass.test', { name: 'Owner' });
  const madm = mk('madm@c.com', 'org_admin', madre.id, 'Marta Madre');
  const cadm = mk('cadm@c.com', 'org_admin', centro.id, 'Carlos Centro');
  const oadm = mk('oadm@o.com', 'org_admin', otra.id, 'Oscar Otra');
  const tc = mk('tc@c.com', 'teacher', centro.id, 'Tina Teacher');
  const sub = mk('sub@c.com', 'teacher', centro.id, 'Sergio Suplente');
  const tn = mk('tn@c.com', 'teacher', norte.id, 'Nico Norte');
  const to = mk('to@o.com', 'teacher', otra.id, 'Olivia Otra');
  const ana = M.newUser('ana@mail.com', { via: 'student_link', name: 'Ana' });
  const bruno = M.newUser('bruno@mail.com', { via: 'student_link', name: 'Bruno' });
  const g1 = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: tc.id, substitute_id: sub.id, timezone: 'America/Montevideo', pending_teacher_email: null, pending_substitute_email: null };
  const g2 = { id: M.uid(), institution_id: norte.id, name: 'Química 3°B', teacher_id: tn.id, substitute_id: null, timezone: 'America/Montevideo', pending_teacher_email: null, pending_substitute_email: null };
  const go = { id: M.uid(), institution_id: otra.id, name: 'Otra group', teacher_id: to.id, substitute_id: null, timezone: 'America/Montevideo', pending_teacher_email: null, pending_substitute_email: null };
  db.class_groups.push(g1, g2, go);
  const en = (inst, email, name, user) => { const e = { id: M.uid(), institution_id: inst, email, name, user_id: user ? user.id : null, loaded_by: null, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(e); return e; };
  const eAna = en(centro.id, 'ana@mail.com', 'Ana Alonso', ana); const eBruno = en(centro.id, 'bruno@mail.com', 'Bruno Barrios', bruno);
  const eCarla = en(centro.id, 'carla@mail.com', 'Carla ' + XSS, null); const eDani = en(norte.id, 'dani@mail.com', 'Dani Díaz', null); const eOlga = en(otra.id, 'olga@mail.com', 'Olga Ortiz', null);
  [[g1, eAna], [g1, eBruno], [g1, eCarla], [g2, eDani], [go, eOlga]].forEach(([g, e]) => db.group_members.push({ group_id: g.id, enrollment_id: e.id }));
  const ses = (g, title, start, mins = 45) => { const s = { id: M.uid(), institution_id: g.institution_id, group_id: g.id, series_id: null, teacher_id: g.teacher_id, title, starts_at: start, ends_at: new Date(Date.parse(start) + mins * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
  const s1 = ses(g1, 'Making plans', ago(2 * 864e5));
  const sToday = ses(g1, 'Future forms review', ago(30 * MIN));
  const sFuture = ses(g1, 'Next week', later(5 * 864e5));
  const s2 = ses(g2, 'Reacciones químicas', ago(864e5));
  const sO = ses(go, 'Otra clase', ago(864e5));
  return { madre, centro, norte, otra, owner, madm, cadm, oadm, tc, sub, tn, to, ana, bruno, g1, g2, go, eAna, eBruno, eCarla, eDani, s1, sToday, sFuture, s2, sO };
}
// Server-side generation as a given user (same rules as the RPC), for scenarios that start from existing insights
function generateAs(user, s) {
  const g = db.class_groups.find(x => x.id === s.group_id);
  const payload = V.buildDemoPayload({ title: s.title, group: g ? g.name : '' });
  const r = classInsights.handle('generate_demo_insights', { p_session: s.id, p_payload: payload }, { id: user.id });
  if (r.status !== 200) throw new Error('seed generate failed: ' + JSON.stringify(r.data));
  return r.data;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('Rename: the super admin analytics are "Métricas" in Spanish ("Metrics" in English) and the panel works', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1);
    await login(page, 'owner@teroclass.test', 'es');
    await page.waitForSelector('#panel-superadmin.active');
    if ((await text(page, '#nav-metrics .sib-label')) !== 'Métricas' || (await text(page, '#nav-metrics .sib-tooltip')) !== 'Métricas') throw new Error('nav label ES: ' + await text(page, '#nav-metrics .sib-label'));
    if ((await text(page, '#nav-unit-insights .sib-label')) !== 'Insights') throw new Error('class Insights label ES');
    await page.click('#nav-metrics');
    await page.waitForSelector('#panel-metrics.active #in-usage');
    if (!/📈 Métricas/.test(await text(page, '#panel-metrics .sa-title'))) throw new Error('panel title ES: ' + await text(page, '#panel-metrics .sa-title'));
    if (!/Uso y actividad/.test(await text(page, '#in-usage'))) throw new Error('panel content ES');
    if (!(await page.$('#in-t-insight-sessions'))) throw new Error('classes-with-insights tile');
    const u = await untranslated(page, '#panel-metrics'); if (u.length) throw new Error('Métricas sin traducir: ' + JSON.stringify(u));
    if (!calls.rpc.some(c => c.fn === 'platform_insights')) throw new Error('RPC not called');
    await shot(page, 'metrics-es');
    await page.evaluate(() => setUiLang('en'));
    if ((await text(page, '#nav-metrics .sib-label')) !== 'Metrics' || !/Metrics/.test(await text(page, '#panel-metrics .sa-title'))) throw new Error('EN label');
    // the old "insights" panel name is the class insights now, never the analytics
    await page.evaluate(() => showPanel('unit-insights'));
    await page.waitForSelector('#panel-unit-insights.active #ins-list');
    if (await page.$('#panel-unit-insights #in-usage')) throw new Error('analytics in class insights');
  });

  await run('Teacher: generates demo insights, reads the report, saves a reflection, drafts and publishes a message; ending a class from the calendar stores its insights', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'tc@c.com');
    if (!(await visible(page, '#nav-insights'))) throw new Error('no Insights in Teaching');
    if (await visible(page, '#nav-metrics') || await visible(page, '#nav-unit-insights')) throw new Error('admin/platform nav for a teacher');
    await page.click('#nav-insights');
    await page.waitForSelector('#panel-insights.active #ins-empty');
    if (!/End a class or generate demo insights/.test(await text(page, '#ins-empty'))) throw new Error('empty state');
    await shot(page, 'x-teacher-empty');
    const pend = await page.$$eval('#ins-pending .ins-title', els => els.map(e => e.textContent));
    if (JSON.stringify(pend) !== '["Future forms review","Making plans"]') throw new Error('pending (no future, newest first): ' + JSON.stringify(pend));
    await page.click(`#ins-pending [data-lc="ins-generate"][data-id="${t.s1.id}"]`);
    await page.waitForSelector('#panel-insights .ins-detail .ins-obs-head');
    if (db.teacher_insights.length !== 1 || db.student_insights.filter(x => x.session_id === t.s1.id).length !== 3) throw new Error('rows: ' + db.teacher_insights.length + '/' + db.student_insights.length);
    if (!db.student_insights.every(x => x.is_demo) || !db.teacher_insights[0].is_demo) throw new Error('not flagged demo');
    if (calls.rpc.filter(c => c.fn === 'generate_demo_insights').pop().body.p_payload.kind !== 'language') throw new Error('subject → language sample');
    // report: header, evidence → worked → priority → next → reflection, 13 areas, demo banner
    const head = await text(page, '.ins-obs-head');
    if (!/Tina Teacher/.test(head) || !/English B1/.test(head) || !/Students present\s*3/.test(head) || !/Class objective/.test(head) || !/Observation focus/.test(head) || !/45 min/.test(head)) throw new Error('header: ' + head);
    const steps = await page.$$eval('#ins-body .ins-step h3, #ins-body .ins-reflection h3', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    if (JSON.stringify(steps) !== '["1 Evidence I noticed","2 What worked well","3 Priority area","4 Suggested next step","5 Teacher reflection"]') throw new Error('steps: ' + JSON.stringify(steps));
    if (await page.locator('#ins-body .lc-area').count() !== 13) throw new Error('13 areas');
    if (await page.locator('#ins-body .ins-evidence .ins-tag').count() < 3) throw new Error('evidence tagged with areas');
    if (!/min/.test(await text(page, '#ins-body .ins-evidence'))) throw new Error('evidence without minutes');
    if (!(await page.$('.ins-detail .lc-banner'))) throw new Error('demo banner');
    if (await page.$('#ins-f-evidence[data-refl]')) throw new Error('AI fields should be read-only in the stored report');
    await page.fill('#ins-f-reflection', SECRET);
    await page.click('#ins-save-reflection');
    await waitToast(page, /Reflection saved/);
    if (db.teacher_insights[0].teacher_reflection !== SECRET) throw new Error('reflection not stored');
    await page.evaluate(() => { document.getElementById('ins-root').scrollTop = 0; });
    await shot(page, 'teacher-report');
    // students: draft with the assistant → save draft → publish
    await page.click('#ins-tab-students');
    await page.waitForSelector('#ins-body .lc-student-pick');
    const chips = await page.$$eval('#ins-body .lc-person-chip', b => b.map(x => x.textContent.trim()));
    if (chips.length !== 3 || !/Ana Alonso/.test(chips[0]) || !chips.some(c => c.includes('Carla <img'))) throw new Error('students: ' + JSON.stringify(chips));
    if (!/Draft: the student can’t see it/.test(await text(page, '#ins-msg-status'))) throw new Error('draft status');
    await page.click('#ins-draft-msg');
    const draft = await page.inputValue('#ins-teacher-msg'); if (!/^Hi Ana!/.test(draft)) throw new Error('assistant draft: ' + draft);
    await page.fill('#ins-teacher-msg', 'Great work today, Ana! Keep practising "going to".');
    await page.click('#ins-save-msg');
    await waitToast(page, /Draft saved/);
    const rowAna = db.student_insights.find(x => x.enrollment_id === t.eAna.id);
    if (rowAna.teacher_message !== 'Great work today, Ana! Keep practising "going to".' || rowAna.published_at) throw new Error('draft stored/published wrongly');
    await page.click('#ins-publish-msg');
    await waitToast(page, /Published/);
    if (!rowAna.published_at || rowAna.published_message !== rowAna.teacher_message) throw new Error('not published');
    await page.waitForSelector('#ins-msg-status.ok');
    if (!(await page.$('#ins-pick-0 .ins-dot-ok'))) throw new Error('published mark on the chip');
    await shot(page, 'x-teacher-students');
    // other tabs render for the teacher too
    for (const k of ['recap', 'progress', 'feedback', 'vocab']) { await page.click('#ins-sub-' + k); await page.waitForSelector(`#ins-sub-${k}.active`); }
    if (await page.locator('#ins-body .lc-topic').count() !== 3) { await page.click('#ins-sub-recap'); if (await page.locator('#ins-body .lc-topic').count() !== 3) throw new Error('recap topics'); }
    // list: counts, filters
    await page.click('[data-lc="ins-back"]');
    await page.waitForSelector('#ins-list');
    const item = await text(page, '#ins-list');
    if (!/Making plans/.test(item) || !/3\s*students/.test(item) || !/1\s*published/.test(item) || !/Reflection/.test(item) || !/Demo/.test(item)) throw new Error('list item: ' + item);
    await page.fill('#ins-f-q', 'bruno');
    await page.waitForFunction(() => document.querySelectorAll('#ins-list .ins-item').length === 1);
    await page.fill('#ins-f-q', 'zzz');
    await page.waitForSelector('#ins-empty');
    if (!/No classes match these filters/.test(await text(page, '#ins-empty'))) throw new Error('no-match state');
    await page.click('#ins-empty [data-lc="ins-clear"]');
    await page.waitForSelector('#ins-list');
    if (calls.rpc.filter(c => c.fn === 'list_insight_sessions').some(c => c.body.p_mine !== true)) throw new Error('teacher list must be p_mine');
    await logout(page);
    // the substitute ends today's class from the Calendar (live classroom demo) → its demo insights are stored and shown
    await login(page, 'sub@c.com');
    await page.click('#nav-calendar');
    await page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await page.click('.gc-nextcard [data-gc="join"]');
    await page.waitForSelector('#lc-join');
    await page.check('#lc-consent'); // first class room: the single recording consent (asked once)
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    await page.click('#lc-ctl-end'); await page.click('#lc-end-confirm');
    await page.waitForSelector('.lc-processing');
    await page.waitForSelector('#panel-insights.active .ins-detail .ins-obs-head', { timeout: 12000 });
    if (!db.teacher_insights.some(x => x.session_id === t.sToday.id) || db.student_insights.filter(x => x.session_id === t.sToday.id).length !== 3) throw new Error('ending the class did not store its insights');
    if (!/Future forms review/.test(await text(page, '.ins-detail h1'))) throw new Error('opened another class');
    const g = calls.rpc.filter(c => c.fn === 'generate_demo_insights').pop(); if (g.body.p_session !== t.sToday.id) throw new Error('generated for the wrong class');
    await page.click('[data-lc="ins-back"]');
    await page.waitForFunction(() => document.querySelectorAll('#ins-list .ins-item').length === 2);
    if (!/Substitute/.test(await text(page, '#ins-list'))) throw new Error('substitute chip');
    await shot(page, 'teacher-list');
    // ending again is idempotent
    const before = db.student_insights.length;
    const r = await page.evaluate(id => sb.rpc('generate_demo_insights', { p_session: id, p_payload: TCInsightsView.buildDemoPayload({ title: 'x' }) }).then(x => x.data), t.sToday.id);
    if (r.students_created !== 0 || db.student_insights.length !== before) throw new Error('not idempotent');
    // a future class can't get demo insights
    const f = await page.evaluate(id => sb.rpc('generate_demo_insights', { p_session: id, p_payload: TCInsightsView.buildDemoPayload({ title: 'x' }) }).then(x => x.error?.message || 'ok'), t.sFuture.id);
    if (!/hoy o anteriores/.test(f)) throw new Error('future class: ' + f);
  });

  await run('Student (Spanish): only their own insight and the published message; never classmates or the teacher reflection', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1);
    const rowAna = db.student_insights.find(x => x.enrollment_id === t.eAna.id); const rowBruno = db.student_insights.find(x => x.enrollment_id === t.eBruno.id);
    Object.assign(rowAna, { teacher_message: 'Borrador privado NO PUBLICADO', published_message: '¡Muy buen trabajo, Ana!', published_at: new Date().toISOString() });
    rowBruno.teacher_message = 'BORRADOR-BRUNO';
    db.teacher_insights[0].teacher_reflection = SECRET;
    await login(page, 'ana@mail.com', 'es');
    await page.waitForSelector('#panel-student.active .gs-ins-item');
    if (await page.locator('.gs-ins-item').count() !== 1) throw new Error('dashboard: own insights only');
    if (!/Mensaje de tu docente/.test(await text(page, '.gs-ins-item'))) throw new Error('message chip on the dashboard');
    await shot(page, 'x-student-dashboard-es');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#panel-insights.active #ins-dash-sheet');
    const body = await text(page, '#panel-insights');
    if (!/¡Muy buen trabajo, Ana!/.test(body)) throw new Error('published message not shown');
    for (const bad of ['NO PUBLICADO', 'BORRADOR-BRUNO', 'SECRET-REFLECTION', 'Bruno', 'Carla', 'Observación', 'Informe de observación']) if (body.includes(bad)) throw new Error('student sees: ' + bad);
    if (await page.$('#panel-insights textarea') || await page.$('#panel-insights .lc-student-pick') || await page.$('#ins-tab-report')) throw new Error('editing / other students / report visible to a student');
    // 2026-11-05: one-page DASHBOARD (every part of the class) instead of sub-tabs
    const heads = await page.$$eval('#ins-dash .ins-dash-h span:last-child', b => b.map(x => x.textContent.trim()));
    // 2026-11-11: grammar, vocabulary and pronunciation first
    if (JSON.stringify(heads) !== '["Gramática","Vocabulario","Pronunciación","Repaso","Progreso"]') throw new Error('dashboard sections ES: ' + JSON.stringify(heads));
    const dash = await text(page, '#ins-dash');
    if (!/Temas tratados/.test(dash) || !/Nivel oral \(MCER\)/.test(dash) || !/Tiempo de habla/.test(dash)) throw new Error('dashboard content ES');
    let u = await untranslated(page, '#ins-root'); if (u.length) throw new Error('dashboard sin traducir: ' + JSON.stringify(u));
    await shot(page, 'student-dashboard-es');
    // 2026-11-11: no search. A timeline (one class here, already opened → not "New") and the newest class open by itself
    if (await page.$('#ins-search') || await page.$('#ins-s-class')) throw new Error('the search bar is still there');
    if (await page.locator('#ins-rail .ins-cls').count() !== 1) throw new Error('timeline: one class');
    if (!(await page.$('#ins-rail .ins-cls.active'))) throw new Error('the newest class is not open');
    if (await page.$('#ins-rail .ins-new')) throw new Error('an opened class still says New');
    // PDF: a print frame with only the dashboard (no search bar, no buttons)
    await page.evaluate(() => { window.__printed = 0; const o = HTMLIFrameElement.prototype; });
    await page.click('#ins-pdf');
    await page.waitForFunction(() => { const f = document.getElementById('ins-print-frame'); return f && f.contentDocument && f.contentDocument.querySelector('#ins-dash-sheet'); });
    const pdf = await page.evaluate(() => { const d = document.getElementById('ins-print-frame').contentDocument; return { search: !!d.querySelector('#ins-search, #ins-rail'), txt: d.body.innerText, title: d.title }; });
    if (SHOTS) { const html = await page.evaluate(() => document.getElementById('ins-print-frame').contentDocument.documentElement.outerHTML);
      const pp = await page.context().newPage(); await pp.goto('http://teroclass.test/'); await pp.setContent(html, { waitUntil: 'load' }); await pp.emulateMedia({ media: 'print' });
      await pp.pdf({ path: SHOTS + '/ins-student-dashboard.pdf', format: 'A4', printBackground: true }); await pp.close(); }
    if (pdf.search || !/Generado con TeroClass|Generated with TeroClass/.test(pdf.txt) || !/TeroClass - /.test(pdf.title)) throw new Error('pdf frame: ' + JSON.stringify({ search: pdf.search, title: pdf.title }));
    await page.click('[data-lc="ins-student-home"]');
    await page.waitForSelector('#panel-student.active');
    // the database refuses anything else
    const r = await page.evaluate(async ([sid, other]) => [
      (await sb.rpc('get_session_insights', { p_session: sid })).error?.message || 'ok',
      (await sb.rpc('my_insight', { p_id: other })).error?.message || 'ok',
      (await sb.rpc('list_insight_sessions', { p_mine: false, p_unit: null })).error?.message || 'ok',
      (await sb.rpc('save_insight_message', { p_insight: other, p_message: 'x', p_publish: true })).error?.message || 'ok'], [t.s1.id, rowBruno.id]);
    if (!r.every(x => /No autorizado/.test(x))) throw new Error('student RPCs: ' + JSON.stringify(r));
    await logout(page);
    // a classmate: no message yet
    await login(page, 'bruno@mail.com', 'es');
    await page.waitForSelector('.gs-ins-item');
    await page.click('.gs-ins-item');
    await page.waitForSelector('.ins-msg-student');
    if (!/Tu docente todavía no te mandó un mensaje/.test(await text(page, '.ins-msg-student'))) throw new Error('empty message state');
    if ((await text(page, '#panel-insights')).includes('Ana')) throw new Error('classmate name leaked');
  });

  await run('Students without insights: clean empty state ("Insights appear after your classes")', browser, async ({ page }) => {
    seed();
    await login(page, 'ana@mail.com');
    await page.waitForSelector('#panel-student.active .gs-ins-empty');
    await page.evaluate(() => showPanel('insights'));
    await page.waitForSelector('#panel-insights.active #ins-empty');
    if (!/Insights appear after your classes/.test(await text(page, '#ins-empty'))) throw new Error('empty state');
    if (await visible(page, '.icon-sidebar')) throw new Error('sidebar shown to a student');
  });

  await run('Admins: Institution → Insights shows every class of their subtree (switcher) and nothing outside it; read-only', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1); generateAs(t.tn, t.s2); generateAs(t.to, t.sO);
    db.teacher_insights.find(x => x.session_id === t.s1.id).teacher_reflection = SECRET;
    // admin of Sede Centro
    await login(page, 'cadm@c.com');
    await page.waitForSelector('#nav-unit-insights', { state: 'visible' });
    await page.click('#nav-unit-insights');
    await page.waitForSelector('#panel-unit-insights.active #ins-list');
    let titles = await page.$$eval('#panel-unit-insights #ins-list .ins-title', e => e.map(x => x.textContent));
    if (JSON.stringify(titles) !== '["Making plans"]') throw new Error('centro admin list: ' + JSON.stringify(titles));
    // P-23: Institution → Insights is read-only: no "Generate demo insights" list for admins
    if (await page.$('#panel-unit-insights #ins-pending')) throw new Error('admin sees the demo-generation list');
    if (await page.$('#panel-unit-insights [data-lc="ins-generate"]')) throw new Error('admin sees a generate button');
    if (!/Read-only/.test(await text(page, '#ins-ro'))) throw new Error('read-only chip');
    await page.click('#panel-unit-insights [data-lc="ins-open"]');
    await page.waitForSelector('#panel-unit-insights .ins-obs-head');
    if (await page.$('#ins-f-reflection')) throw new Error('admin can edit the reflection');
    if (!(await text(page, '#ins-refl-text')).includes('SECRET-REFLECTION')) throw new Error('admin should read the reflection');
    await page.click('#ins-tab-students');
    if (await page.$('#ins-teacher-msg') || await page.$('#ins-publish-msg')) throw new Error('admin can write messages');
    const denied = await page.evaluate(async sid => (await sb.rpc('get_session_insights', { p_session: sid })).error?.message || 'ok', t.s2.id);
    if (!/No autorizado/.test(denied)) throw new Error('centro admin opened Norte');
    await logout(page);
    // admin of the main institution: whole subtree; the switcher narrows it; teacher filter
    await login(page, 'madm@c.com');
    await page.click('#nav-unit-insights');
    await page.waitForSelector('#panel-unit-insights.active #ins-list');
    titles = await page.$$eval('#panel-unit-insights #ins-list .ins-title', e => e.map(x => x.textContent));
    if (JSON.stringify(titles) !== '["Reacciones químicas","Making plans"]') throw new Error('madre admin list: ' + JSON.stringify(titles));
    if (/Otra/.test(await text(page, '#panel-unit-insights'))) throw new Error('other institution visible');
    const teachers = await page.$$eval('#ins-f-teacher option', o => o.map(x => x.textContent));
    if (JSON.stringify(teachers) !== '["All teachers","Nico Norte","Sergio Suplente","Tina Teacher"]') throw new Error('teacher filter: ' + JSON.stringify(teachers));
    await shot(page, 'admin-list');
    await page.selectOption('#ins-f-teacher', { label: 'Nico Norte' });
    await page.waitForFunction(() => document.querySelectorAll('#panel-unit-insights .ins-item').length === 1 && /Reacciones/.test(document.querySelector('#panel-unit-insights .ins-title').textContent));
    await page.click('[data-lc="ins-clear"]');
    await page.waitForFunction(() => document.querySelectorAll('#panel-unit-insights .ins-item').length === 2);
    await page.click('#isw-btn'); await page.locator('#isw-list .isw-opt', { hasText: 'Sede Norte' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#panel-unit-insights .ins-item').length === 1 && /Sede Norte/.test(document.getElementById('ins-scope').textContent));
    const last = calls.rpc.filter(c => c.fn === 'list_insight_sessions').pop().body;
    if (last.p_mine !== false || last.p_unit !== t.norte.id) throw new Error('unit scope args: ' + JSON.stringify(last));
    // the chemistry class uses the subject vocabulary (concepts instead of grammar)
    await page.click('#panel-unit-insights [data-lc="ins-open"]');
    await page.click('#ins-tab-students');
    await page.click('#ins-sub-progress');
    if (!/Concept tracker/.test(await text(page, '#ins-body'))) throw new Error('discipline labels');
    await logout(page);
    // super admin: All institutions
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-unit-insights');
    await page.waitForSelector('#panel-unit-insights.active #ins-list');
    if (await page.locator('#panel-unit-insights .ins-item').count() !== 3) throw new Error('super admin All');
    if (!/all institutions/.test(await text(page, '#ins-scope'))) throw new Error('All scope label');
  });

  await run('View as (super admin): Teacher, Admin and Student see the same Insights, read-only', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1);
    db.student_insights.find(x => x.enrollment_id === t.eAna.id).published_message = 'Mensaje publicado para Ana';
    db.student_insights.find(x => x.enrollment_id === t.eAna.id).published_at = new Date().toISOString();
    await login(page, 'owner@teroclass.test');
    await page.waitForFunction(() => typeof appBooting !== 'undefined' && !appBooting && document.getElementById('panel-superadmin').classList.contains('active'));
    // teacher
    await page.evaluate(([u, p]) => enterViewAs({ unitId: u, perspective: 'teacher', person: p }), [t.centro.id, { id: t.tc.id, name: 'Tina Teacher', email: 'tc@c.com' }]);
    await page.waitForSelector('#viewas-banner', { state: 'visible' });
    await page.click('#nav-insights');
    await page.waitForSelector('#panel-insights.active #ins-list');
    if (!/View as: read-only/.test(await text(page, '#ins-ro'))) throw new Error('read-only note');
    if (await page.$('#panel-insights [data-lc="ins-generate"]')) throw new Error('generate offered in View as');
    await page.click('#panel-insights [data-lc="ins-open"]');
    await page.waitForSelector('#panel-insights .ins-obs-head');
    if (await page.$('#ins-f-reflection') || await page.$('#ins-save-reflection')) throw new Error('reflection editable in View as');
    await page.click('#ins-tab-students');
    if (await page.$('#ins-teacher-msg')) throw new Error('message editable in View as');
    const w = await page.evaluate(id => sb.rpc('save_teacher_reflection', { p_session: id, p_reflection: 'x' }).then(r => r.error?.message || 'ok'), t.s1.id);
    if (!/read-only/.test(w)) throw new Error('write not blocked: ' + w);
    await page.click('#viewas-banner .va-exit'); await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    // admin
    await page.evaluate(u => enterViewAs({ unitId: u, perspective: 'admin', person: null }), t.centro.id);
    await page.waitForSelector('#nav-unit-insights', { state: 'visible' });
    await page.click('#nav-unit-insights');
    await page.waitForSelector('#panel-unit-insights.active #ins-list');
    if (await page.locator('#panel-unit-insights .ins-item').count() !== 1) throw new Error('admin view');
    await page.click('#viewas-banner .va-exit'); await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    // student (unit → group → student)
    await page.evaluate(([u, g, p]) => enterViewAs({ unitId: u, perspective: 'student', group: g, person: p }), [t.centro.id, { id: t.g1.id, name: t.g1.name }, { id: t.eAna.id, name: 'Ana Alonso', email: 'ana@mail.com' }]);
    await page.waitForSelector('#panel-student.active .gs-ins-item');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#panel-insights.active .ins-msg-student');
    if (!/Mensaje publicado para Ana/.test(await text(page, '.ins-msg-student'))) throw new Error('View as student: message');
    if ((await text(page, '#panel-insights')).includes('Bruno')) throw new Error('View as student: classmates');
    const c = calls.rpc.filter(x => x.fn === 'my_insight').pop().body; if (c.p_enrollment !== t.eAna.id) throw new Error('my_insight args ' + JSON.stringify(c));
    await shot(page, 'viewas-student');
    await page.click('#viewas-banner .va-exit'); await page.waitForSelector('#viewas-banner', { state: 'hidden' });
  });

  await run('Monthly report (Spanish): pinned for the student, the teacher adds a message, nobody else sees it', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1);
    const rep = { id: 'mr-1', enrollment_id: t.eAna.id, month: '2026-10-01', created_at: new Date().toISOString(), teacher_message: '', message_at: null, message_by: null,
      data: { v: 1, month: '2026-10', kind: 'language', lang: 'en', classes: 2, attended: 2, scheduled: 3, levelStart: 'B1', levelEnd: 'B1+', scoreStart: 70, scoreEnd: 74, speakingMin: 45.3,
        series: [{ date: '2026-10-06', title: 'Intro', level: 'B1', score: 70, speakingMin: 20 }, { date: '2026-10-20', title: 'Pitch', level: 'B1+', score: 74, speakingMin: 25.3 }],
        summary: 'You spoke more every class.', focus: 'Use has with he / she / it.',
        topErrors: [{ type: 'Verb agreement', original: 'he have', corrected: 'he has', rule: 'he / she / it + has', times: 2 }],
        vocab: [{ word: 'budget', level: 'B1', def: 'Money for something', synonyms: ['funds'] }], expressions: [{ said: 'do a shooting', natural: 'do a shoot', why: 'noun' }],
        pron: [{ item: 'budget', guide: 'BUH-jit', tip: 'j sound' }] } };
    db.student_monthly_reports.push(rep);
    await login(page, 'ana@mail.com', 'es');
    await page.waitForSelector('#panel-student.active .gs-ins-item');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#ins-rail .ins-report-card');
    if (!/Reporte de octubre de 2026/i.test(await text(page, '#ins-rail .ins-report-card'))) throw new Error('report card ES: ' + await text(page, '#ins-rail .ins-report-card'));
    if (!/nuevo/i.test(await text(page, '#ins-rail .ins-report-card'))) throw new Error('report not marked new');
    await page.click('#ins-rail .ins-report-card');
    await page.waitForSelector('#ins-dash .ins-month');
    const body = await text(page, '#ins-dash');
    for (const want of ['You spoke more every class.', 'Foco para el mes que viene', 'he have', 'he has', 'Palabras del mes', 'funds', 'do a shoot', 'BUH-jit', 'Clase por clase', '2 / 3', 'B1 → B1+'])
      if (!body.includes(want)) throw new Error('report misses: ' + want);
    if (await page.$('#ins-dash textarea')) throw new Error('a student can edit the teacher message');
    let u = await untranslated(page, '#ins-root'); if (u.length) throw new Error('report sin traducir: ' + JSON.stringify(u));
    await shot(page, 'student-monthly-report-es');
    await logout(page);
    // the teacher: list → open → message
    await login(page, 'tc@c.com', 'es');
    await page.click('#nav-insights');
    await page.click('#ins-mr-btn');
    await page.waitForSelector('[data-lc="ins-mr-teacher"]');
    await page.click('[data-lc="ins-mr-teacher"]');
    await page.waitForSelector('#mr-msg');
    await page.fill('#mr-msg', '¡Gran mes, Ana!');
    await page.click('#mr-save');
    await page.waitForFunction(() => /Gran mes/.test(document.getElementById('mr-msg')?.value || ''));
    if (rep.teacher_message !== '¡Gran mes, Ana!') throw new Error('message not saved');
    await shot(page, 'teacher-monthly-report-es');
    await logout(page);
    await login(page, 'ana@mail.com', 'es');
    await page.waitForSelector('#panel-student.active .gs-ins-item');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#ins-rail .ins-report-card'); await page.click('#ins-rail .ins-report-card');
    await page.waitForSelector('#ins-dash .ins-month');
    if (!/¡Gran mes, Ana!/.test(await text(page, '#ins-dash'))) throw new Error('student does not see the teacher message');
    if (/nuevo/i.test(await text(page, '#ins-rail .ins-report-card'))) throw new Error('opened report still new');
    await logout(page);
    // a classmate sees nothing; the admin cannot open it
    await login(page, 'bruno@mail.com', 'es');
    const r = await page.evaluate(async () => [JSON.stringify((await sb.rpc('my_monthly_reports')).data), (await sb.rpc('monthly_report', { p_id: 'mr-1' })).error?.message || 'ok']);
    if (r[0] !== '[]' || !/No autorizado/.test(r[1])) throw new Error('classmate: ' + JSON.stringify(r));
  });

  await run('Mobile: student insight and teacher list fit the screen (no horizontal scroll)', browser, async ({ page }) => {
    const t = seed(); generateAs(t.tc, t.s1);
    const row = db.student_insights.find(x => x.enrollment_id === t.eAna.id); Object.assign(row, { published_message: '¡Muy bien, Ana! Seguí practicando.', published_at: new Date().toISOString() });
    await login(page, 'ana@mail.com', 'es');
    await page.waitForSelector('.gs-ins-item');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#panel-insights.active .ins-msg-student');
    { await page.waitForSelector('#ins-dash-sheet'); const o = await hscroll(page); if (o > 1) throw new Error('student dashboard overflows by ' + o); }
    await shot(page, 'student-mobile');
    await logout(page);
    await login(page, 'tc@c.com');
    await page.click('#nav-insights');
    await page.waitForSelector('#ins-list');
    let o = await hscroll(page); if (o > 1) throw new Error('teacher list overflows by ' + o);
    await page.click('[data-lc="ins-open"]');
    await page.waitForSelector('.ins-obs-head');
    o = await hscroll(page); if (o > 1) throw new Error('teacher report overflows by ' + o);
    await page.click('#ins-tab-students');
    o = await hscroll(page); if (o > 1) throw new Error('students tab overflows by ' + o);
  }, { viewport: { width: 390, height: 800 }, mobile: true });

  await browser.close();
  console.log(failed ? `${failed} insights scenario(s) FAILED` : 'All insights scenarios passed');
  process.exitCode = failed ? 1 : 0;
})();
