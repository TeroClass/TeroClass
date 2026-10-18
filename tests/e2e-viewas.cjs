// "View as" (super admin only) + platform owner identity hidden in the UI (mock Supabase + mock AI).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-viewas.cjs
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, bill, calls, handleSupabase, HTML, SB_JS, SB, SUPERADMIN_EMAIL } = M;

let failed = 0;
const WRITE_RPC = ['invite_member', 'set_member_role', 'remove_member', 'create_institution', 'delete_institution', 'request_token_pack',
  'decide_purchase_request', 'set_institution_plan', 'update_platform_settings', 'admin_move_member'];

async function setup(browser) {
  M.resetDb();
  const ctx = await browser.newContext();
  const st = { errors: [], main: [], apiPosts: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/api/') && r.request().method() === 'POST') st.apiPosts.push(u.pathname);
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); const s = JSON.stringify(b);
      const kind = s.includes('STUDENT HANDOUT') ? 'student' : s.includes("institution's CORE") ? 'summary' : 'main';
      if (kind === 'main') st.main.push(b);
      const content = kind === 'student' ? "Test\nToday's goals:\n- I can greet" : kind === 'summary' ? '- core' : 'Week 1 - Class 1 - Preview\nAttendance:\n\nToday\'s Objectives:\n- Practice greetings';
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
    }
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false }) });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage(); page.__st = st;
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource/.test(m.text())) st.errors.push('console: ' + m.text()); });
  return { ctx, page, st };
}
async function run(name, browser, fn) {
  const env = await setup(browser);
  try { await fn(env); if (env.st.errors.length) throw new Error(env.st.errors.join(' | ')); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); }
  finally { await env.ctx.close(); }
}
async function login(page, email, path = '/') {
  await page.goto('http://teroclass.test' + path);
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(() => setUiLang('en'));
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
// Error toasts carry the tero + apology headline; the message itself is in .tero-err-detail
const waitToast = (page, re) => page.waitForFunction(src => { const t = document.getElementById('toast'); const d = t.querySelector('.tero-err-detail'); return new RegExp(src).test((d || t).textContent); }, re.source, { timeout: 8000 });
const clearToast = page => page.evaluate(() => { document.getElementById('toast').textContent = ''; });
const expectReadOnly = async (page, what) => {
  try { await waitToast(page, /View as is read-only/); } catch (e) { throw new Error('no read-only toast for: ' + what); }
  await clearToast(page);
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t)) continue;
    if (!vals.has(t)) out.push(t);
  }
  return out;
}, sel);
const brand = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim().toLowerCase());
async function pickUnit(page, name) {
  await page.click('#isw-btn'); await page.waitForSelector('#isw-menu.open');
  await page.locator('#isw-list .isw-opt', { hasText: name }).first().click();
  await page.waitForFunction(n => document.getElementById('isw-label').textContent.includes(n), name);
}
const nodeRow = (page, name) => page.locator('.tree-row', { has: page.locator('.tree-name', { hasText: name }) }).first();
const writeCalls = () => calls.rpc.filter(c => WRITE_RPC.includes(c.fn)).map(c => c.fn);

// The English Coach (madre) › Sede Centro (own color) › Cátedra Inglés (inherits) ; The English Coach › Sede Norte
function seed() {
  const madre = M.seedInstitution({ name: 'The English Coach', slug: 'coach', color: '#aa0000', bg_color: '#fff0f0', master_prompt: 'Coach rule', methodology_config: { hidden: ['gamification'] } });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', color: '#00aa00', bg_color: null, font: null, parent_id: madre.id, master_prompt: 'Centro rule' });
  const norte = M.seedInstitution({ name: 'Sede Norte', slug: 'norte', color: null, bg_color: null, font: null, parent_id: madre.id });
  const cat = M.seedInstitution({ name: 'Cátedra Inglés', slug: 'cat-ingles', color: null, bg_color: null, font: null, parent_id: centro.id, master_prompt: 'Catedra rule',
    methodology_config: { custom: [{ key: 'c_cat_bar', label: 'Cat bar', tooltip: 'Cátedra bar', def: 40 }] } });
  const mk = (email, role, inst, name) => { const u = M.newUser(email, { name: name || email.split('@')[0] }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const ownerUser = M.newUser(SUPERADMIN_EMAIL, { name: 'Owner Person' }); const owner = db.profiles.find(p => p.id === ownerUser.id);
  const madm = mk('madm@coach.com', 'org_admin', madre.id, 'Marta Madre');
  const cadm = mk('cadm@coach.com', 'org_admin', centro.id, 'Carlos Centro');
  const tc = mk('tc@coach.com', 'teacher', cat.id, 'Tina Catedra');
  const tn = mk('tn@coach.com', 'teacher', norte.id, 'Nico Norte');
  const plan = (o, inst, title) => db.plannings.push({ id: M.uid(), owner_id: o.id, institution_id: inst, title, data: { params: { subjects: ['English'], level: 'Primary' }, content: title + ' content' }, created_at: new Date().toISOString() });
  plan(tc, cat.id, 'Tina class one'); plan(tc, cat.id, 'Tina class two'); plan(tn, norte.id, 'Nico class');
  db.institution_documents.push({ id: 'doc-coach', institution_id: madre.id, name: 'coach.txt', summary: '- Coach principle: speak from minute one', chars: 100, created_at: new Date().toISOString() });
  db.institution_documents.push({ id: 'doc-centro', institution_id: centro.id, name: 'centro.txt', summary: '- Centro principle', chars: 100, created_at: new Date().toISOString() });
  bill.log.push({ root_id: madre.id, inst_id: cat.id, user_id: tc.id, total: 3000 }, { root_id: madre.id, inst_id: norte.id, user_id: tn.id, total: 5000 });
  return { madre, centro, norte, cat, owner, madm, cadm, tc, tn };
}
const snapshot = () => JSON.stringify({ inst: db.institutions, plans: db.plannings.length, inv: db.invitations.length, docs: db.institution_documents.length, profs: db.profiles.map(p => p.role + p.institution_id), req: bill.requests.length });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('Owner: View as Institution admin of a sub-unit (Platform button) — navigation, branding, scope, read-only, Exit restores', browser, async ({ page, st }) => {
    const t = seed();
    await login(page, SUPERADMIN_EMAIL);
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-table-body tr');
    const before = snapshot();
    // picker: searchable tree, perspective, person
    await page.click('#btn-pf-viewas');
    await page.waitForSelector('#modal-viewas.active');
    if (!(await page.isDisabled('#va-start'))) throw new Error('start enabled without a unit');
    if ((await page.locator('#va-tree .va-node').count()) !== 4) throw new Error('tree should list all 4 units');
    await page.fill('#va-search', 'centro');
    const names = await page.locator('#va-tree .va-node').allTextContents();
    // matches by name or path: the campus and the cátedra below it, not Sede Norte
    if (names.length !== 2 || !/^Sede Centro/.test(names[0]) || names.some(n => /Norte/.test(n))) throw new Error('search: ' + JSON.stringify(names));
    await page.click('#va-tree .va-node >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('#va-person option').length === 2); // generic + Carlos (admins of that unit)
    if (!/Carlos Centro/.test(await page.textContent('#va-person'))) throw new Error('person list');
    await page.click('#va-start');
    await page.waitForSelector('#viewas-banner', { state: 'visible' });
    const ban = (await page.textContent('#viewas-banner')).replace(/\s+/g, ' ');
    if (!/Viewing as: Institution admin · The English Coach › Sede Centro — read-only Exit/.test(ban)) throw new Error('banner: ' + ban);
    // navigation as an admin of that unit
    await page.waitForSelector('#panel-structure.active');
    for (const id of ['#nav-platform', '#nav-superadmin', '#um-viewas']) if (await page.isVisible(id)) throw new Error(id + ' visible in View as');
    if (!(await page.isVisible('#mode-switch')) || !(await page.isVisible('#nav-billing'))) throw new Error('admin nav missing');
    await page.waitForSelector('.tree-row');
    const tree = await page.locator('.tree-name').allTextContents();
    if (tree.length !== 2 || !tree.some(x => /Sede Centro/.test(x)) || !tree.some(x => /Cátedra Inglés/.test(x))) throw new Error('structure not limited to subtree: ' + JSON.stringify(tree));
    if (await page.locator('[data-h="view-as"]').count()) throw new Error('nested View as offered');
    if (await page.isVisible('#btn-structure-new-inst')) throw new Error('create institution offered');
    // branding inherited from the unit (own color) and its name
    if ((await brand(page)) !== '#00aa00') throw new Error('brand ' + await brand(page));
    if ((await page.textContent('#topbar-brand-name')) !== 'Sede Centro') throw new Error('brand name');
    // dashboard of that unit: its team, no owner
    await page.click('#nav-admin');
    await page.waitForSelector('#members-card', { state: 'visible' });
    await page.waitForFunction(() => /Carlos Centro/.test(document.getElementById('members-table-body').textContent));
    const team = await page.textContent('#members-table-body');
    if (/Owner|teroclass\.test|Nico/.test(team)) throw new Error('team scope: ' + team);
    if ((await page.textContent('#m-plans')) !== '2') throw new Error('plans in scope: ' + await page.textContent('#m-plans'));
    // AI settings: prompt chain
    await page.click('#nav-master');
    await page.waitForFunction(() => document.getElementById('mp-prompt').value === 'Centro rule');
    await page.waitForFunction(() => /Coach rule/.test(document.getElementById('mp-inherited').textContent));
    // Plan & usage of that billing account, detail limited to this sub-unit
    await page.click('#nav-billing');
    await page.waitForSelector('#bl-teachers');
    const bt = await page.textContent('#bl-teachers');
    if (!/Tina Catedra/.test(bt) || /Nico/.test(bt)) throw new Error('billing scope: ' + bt);
    if (!/The English Coach/.test(await page.textContent('#billing-root'))) throw new Error('billing account');
    // writes are blocked
    await page.click('#nav-master');
    await page.fill('#mp-prompt', 'HACKED'); await page.click('#panel-master .btn-save-settings'); await expectReadOnly(page, 'master prompt');
    await page.waitForSelector('#meth-list input[data-hc="meth-show"]');
    await page.locator('#meth-list input[data-hc="meth-show"]').first().click(); await expectReadOnly(page, 'bars');
    await page.click('[data-action="pb-delete"]'); await expectReadOnly(page, 'playbook delete');
    await page.setInputFiles('#playbook-upload', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(200)) }); await expectReadOnly(page, 'playbook upload');
    await page.click('#btn-invite-top'); await expectReadOnly(page, 'invite');
    if (await page.isVisible('#modal-invite')) throw new Error('invite modal opened');
    await page.click('#nav-admin');
    await page.waitForSelector('#members-table-body select.member-role');
    await page.selectOption('#members-table-body select.member-role >> nth=0', 'teacher'); await expectReadOnly(page, 'role change');
    if ((await page.inputValue('#members-table-body select.member-role >> nth=0')) !== 'org_admin') throw new Error('role select not reverted');
    await page.click('#members-table-body [data-action="member-remove"] >> nth=0'); await expectReadOnly(page, 'remove member');
    await page.click('#nav-structure'); await page.waitForSelector('.tree-row');
    await nodeRow(page, 'Sede Centro').locator('[data-h="add-unit"]').click(); await expectReadOnly(page, 'create unit');
    await nodeRow(page, 'Sede Centro').locator('[data-h="brand"]').click();
    await page.waitForSelector('#panel-branding.active');
    await page.click('.btn-save-brand'); await expectReadOnly(page, 'branding save');
    // safety net below the UI
    const net = await page.evaluate(async id => {
      const a = await sb.from('institutions').update({ name: 'x' }).eq('id', id);
      const b = await sb.rpc('invite_member', { p_inst: id, p_email: 'x@x.com', p_role: 'teacher' });
      const c = await sb.from('plannings').insert({ owner_id: id, title: 'x' }).select('id').single();
      const d = await sb.storage.from('logos').upload(id + '/x.png', new Blob(['x']));
      const e = await fetch('/api/class/token', { method: 'POST', body: '{}' });
      return [a.error?.message, b.error?.message, c.error?.message, d.error?.message, e.status].join('|');
    }, t.centro.id);
    if (net !== 'View as is read-only|View as is read-only|View as is read-only|View as is read-only|403') throw new Error('safety net: ' + net);
    await clearToast(page);
    if (snapshot() !== before) throw new Error('data changed during View as');
    if (writeCalls().length) throw new Error('write RPC reached the server: ' + writeCalls());
    if (st.apiPosts.some(p => p !== '/api/generate')) throw new Error('API write reached the server: ' + st.apiPosts);
    // Exit → exactly where the owner was
    await page.click('#viewas-banner .va-exit');
    await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    await page.waitForSelector('#panel-platform.active');
    if (!(await page.isVisible('#nav-platform')) || !(await page.isVisible('#nav-superadmin'))) throw new Error('owner nav not restored');
    if ((await page.textContent('#topbar-brand-name')) !== 'Tero Class') throw new Error('branding not restored');
    if ((await brand(page)) !== '#7c5cbf') throw new Error('brand color not restored: ' + await brand(page));
    if ((await page.textContent('#um-email')) !== SUPERADMIN_EMAIL) throw new Error('user menu not restored');
    if (!/All institutions/.test(await page.textContent('#isw-label'))) throw new Error('switcher selection not restored');
    await pickUnit(page, 'The English Coach');
    await page.click('#nav-structure');
    await page.waitForFunction(() => document.querySelectorAll('#structure-tree .tree-name').length === 4, null, { timeout: 8000 }).catch(() => { throw new Error('owner structure not restored'); });
    if (await page.evaluate(() => localStorage.getItem('tc_app_mode')) === 'teacher') throw new Error('owner mode overwritten');
  });

  await run('Owner: View as Teacher of a cátedra with a chosen person (Structure action) — classes, bars, prompt chain, preview generation not saved, Exit restores the open class', browser, async ({ page, st }) => {
    const t = seed();
    await login(page, SUPERADMIN_EMAIL);
    // the owner has an unsaved draft open in teacher mode
    await page.click('#mode-switch [data-mode="teacher"]');
    await page.click('#nav-ai');
    await page.fill('#prompt-input', 'Owner topic'); await page.click('#btn-generate'); await page.waitForSelector('#lp-doc');
    await page.evaluate(() => { document.getElementById('lp-doc').innerText = 'OWNER DRAFT'; });
    await page.click('#mode-switch [data-mode="admin"]');
    await pickUnit(page, 'The English Coach'); await page.click('#nav-structure');
    await page.waitForSelector('#panel-structure.active'); await page.waitForSelector('.tree-row');
    const before = snapshot();
    await nodeRow(page, 'Cátedra Inglés').locator('[data-h="view-as"]').click();
    await page.waitForSelector('#modal-viewas.active');
    if (!/Cátedra Inglés/.test(await page.textContent('#va-tree .va-node.sel'))) throw new Error('unit not preselected');
    await page.check('input[name="va-persp"][value="teacher"]');
    await page.waitForFunction(() => /Tina Catedra/.test(document.getElementById('va-person').textContent));
    await page.selectOption('#va-person', { label: 'Tina Catedra · tc@coach.com' });
    await page.click('#va-start');
    await page.waitForSelector('#panel-home.active');
    const ban = (await page.textContent('#viewas-banner')).replace(/\s+/g, ' ');
    if (!/Viewing as: Teacher \(Tina Catedra\) · The English Coach › Sede Centro › Cátedra Inglés/.test(ban)) throw new Error('banner: ' + ban);
    for (const id of ['#mode-switch', '#nav-structure', '#nav-admin', '#nav-billing', '#nav-platform', '#btn-invite-top']) if (await page.isVisible(id)) throw new Error(id + ' visible for a teacher');
    if (!(await page.isVisible('#nav-ai')) || !(await page.isVisible('#nav-live'))) throw new Error('teacher nav');
    await page.waitForFunction(() => document.querySelectorAll('#classes-grid .class-card').length === 2);
    if (/Nico/.test(await page.textContent('#classes-grid'))) throw new Error('other teacher classes shown');
    if ((await brand(page)) !== '#00aa00') throw new Error('inherited brand: ' + await brand(page));
    if ((await page.textContent('#um-name')) !== 'Tina Catedra') throw new Error('user menu person');
    // effective bars: hidden by the main institution, custom bar of the cátedra
    await page.click('#nav-ai');
    await page.waitForSelector('#sl-c_cat_bar');
    if (await page.locator('#sl-gamification').count()) throw new Error('bar hidden by the main institution is shown');
    if (!(await page.isVisible('#va-gen-note'))) throw new Error('no preview note');
    // preview generation uses the simulated unit's prompt chain + playbooks, and cannot be saved
    st.main.length = 0;
    await page.fill('#prompt-input', 'Greetings'); await page.click('#btn-generate'); await page.waitForSelector('#lp-doc');
    await page.waitForFunction(() => /Preview/.test(document.getElementById('lp-doc').textContent));
    const sys = st.main[st.main.length - 1].messages[0].content;
    for (const s of ['Coach rule', 'Centro rule', 'Catedra rule', 'Coach principle']) if (!sys.includes(s)) throw new Error('prompt chain missing ' + s);
    await page.click('#btn-save'); await expectReadOnly(page, 'save class');
    await page.click('#nav-home'); await page.click('#classes-grid .class-card >> nth=0');
    await page.waitForSelector('#lp-doc'); await page.click('#btn-save'); await expectReadOnly(page, 'save opened class');
    // live class opens (demo) as that teacher
    await page.click('#nav-live'); await page.waitForSelector('#panel-live.active');
    if (snapshot() !== before) throw new Error('data changed during View as');
    if (writeCalls().length || calls.inserts.plannings) throw new Error('write reached the server');
    // Exit: Structure (admin mode) again and the owner's draft is back untouched
    await page.click('#um-viewas-exit', { force: true }).catch(async () => { await page.click('#user-avatar'); await page.click('#um-viewas-exit'); });
    await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    await page.waitForSelector('#panel-structure.active');
    if (!(await page.isVisible('#mode-switch'))) throw new Error('mode switch not restored');
    await page.click('#mode-switch [data-mode="teacher"]'); await page.click('#nav-ai');
    if ((await page.textContent('#lp-doc')).trim() !== 'OWNER DRAFT') throw new Error('owner draft lost: ' + await page.textContent('#lp-doc'));
    // bars follow the unit chosen in the switcher (The English Coach hides Gamification); "All institutions" → the owner's own bars
    if (!/The English Coach/.test(await page.textContent('#isw-label'))) throw new Error('switcher not restored after Exit');
    await pickUnit(page, 'All institutions');
    await page.waitForSelector('#sl-gamification'); // the owner's own bars again
    if (await page.isVisible('#va-gen-note')) throw new Error('preview note still visible');
  });

  await run('Generic teacher → empty Home; reload always starts in normal mode; Spanish banner', browser, async ({ page }) => {
    const t = seed();
    await login(page, SUPERADMIN_EMAIL);
    await page.waitForSelector('#panel-superadmin.active'); await page.waitForSelector('.inst-card');
    const ok = await page.evaluate(id => enterViewAs({ unitId: id, perspective: 'teacher', person: null }), t.norte.id);
    if (!ok) throw new Error('enterViewAs refused for the owner');
    await page.waitForSelector('#panel-home.active');
    await page.waitForSelector('#classes-grid .classes-empty');
    await page.evaluate(() => setUiLang('es'));
    const ban = (await page.textContent('#viewas-banner')).replace(/\s+/g, ' ');
    if (!/Viendo como: Docente · The English Coach › Sede Norte — solo lectura Salir/.test(ban)) throw new Error('ES banner: ' + ban);
    let u = await untranslated(page, '#viewas-banner'); if (u.length) throw new Error('banner sin traducir: ' + JSON.stringify(u));
    await page.click('#nav-ai'); await page.waitForSelector('#va-gen-note', { state: 'visible' });
    u = await untranslated(page, '#va-gen-note'); if (u.length) throw new Error('nota sin traducir: ' + JSON.stringify(u));
    await page.click('#btn-generate'); // empty prompt → normal validation, no crash
    await page.evaluate(() => savePlanning()); await waitToast(page, /"Ver como" es solo lectura/);
    await page.evaluate(() => setUiLang('en'));
    // admin of the main institution: Plan & usage offers the purchase, but the request is blocked
    await page.click('#viewas-banner .va-exit'); await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    await page.evaluate(id => enterViewAs({ unitId: id, perspective: 'admin', person: null }), t.madre.id);
    await page.waitForSelector('#panel-structure.active');
    if ((await brand(page)) !== '#aa0000') throw new Error('main institution brand');
    await page.click('#nav-billing'); await page.waitForSelector('[data-bl="buy"]');
    await page.click('[data-bl="buy"]'); await page.click('[data-bl="buy"]'); await expectReadOnly(page, 'token purchase');
    if (bill.requests.length) throw new Error('purchase request created');
    await page.reload();
    await page.waitForSelector('#screen-app.active');
    await page.waitForSelector('#nav-platform', { state: 'visible', timeout: 8000 }).catch(() => { throw new Error('owner not back to normal after reload'); });
    if (await page.isVisible('#viewas-banner')) throw new Error('View as survived a reload');
    if (await page.evaluate(() => !!viewAs || document.body.classList.contains('viewas-on'))) throw new Error('View as state after reload');
    await page.evaluate(() => setUiLang('es'));
    await page.click('#user-avatar'); await page.click('#um-viewas');
    await page.waitForSelector('#modal-viewas.active'); await page.click('#va-tree .va-node >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('#va-person option').length >= 1 && /genérico/.test(document.getElementById('va-person').textContent));
    u = await untranslated(page, '#modal-viewas'); if (u.length) throw new Error('modal sin traducir: ' + JSON.stringify(u));
    if (!/Buscar unidades/.test(await page.getAttribute('#va-search', 'placeholder'))) throw new Error('placeholder');
    await page.keyboard.press('Escape');
    await page.evaluate(() => setUiLang('en'));
  });

  await run('Institution admin and teacher cannot see or trigger View as', browser, async ({ page }) => {
    const t = seed();
    for (const email of ['madm@coach.com', 'tc@coach.com']) {
      await login(page, email);
      if (await page.isVisible('#um-viewas')) throw new Error(email + ': menu entry visible');
      await page.click('#user-avatar');
      if (await page.isVisible('#um-viewas')) throw new Error(email + ': menu entry visible (open menu)');
      if (await page.locator('[data-h="view-as"]').count()) throw new Error(email + ': Structure action visible');
      const res = await page.evaluate(async id => { await openViewAs(id); const r = await enterViewAs({ unitId: id, perspective: 'admin', person: null }); return [r, document.getElementById('modal-viewas').classList.contains('active'), !!viewAs]; }, t.cat.id);
      if (res.join() !== 'false,false,false') throw new Error(email + ': ' + res.join());
      if (await page.isVisible('#viewas-banner')) throw new Error(email + ': banner');
      await page.evaluate(() => handleLogout());
      await page.waitForSelector('#tab-login', { state: 'visible' });
    }
  });

  await run('Owner identity hidden from institution admins (team, classes, invite message, Plan & usage)', browser, async ({ page }) => {
    const t = seed();
    t.owner.institution_id = t.madre.id; // worst case: the owner belongs to the institution
    db.plannings.push({ id: M.uid(), owner_id: t.owner.id, institution_id: t.madre.id, title: 'Owner secret class', data: { params: { subjects: ['Secret'] }, content: 'x' }, created_at: new Date().toISOString() });
    bill.log.push({ root_id: t.madre.id, inst_id: t.madre.id, user_id: t.owner.id, total: 9000 });
    await login(page, 'madm@coach.com');
    await page.click('#nav-admin');
    await page.waitForFunction(() => /Marta Madre/.test(document.getElementById('members-table-body').textContent));
    const dash = await page.textContent('#panel-admin');
    if (/Owner|teroclass\.test|Secret/.test(dash)) throw new Error('owner visible in dashboard');
    await page.click('#btn-invite-top'); await page.waitForSelector('#modal-invite.active');
    await page.fill('#invite-email', SUPERADMIN_EMAIL); await page.click('#modal-invite .btn-modal-save');
    await waitToast(page, /^That email can't be invited\.$/);
    await page.keyboard.press('Escape');
    await page.click('#nav-billing'); await page.waitForSelector('#bl-teachers');
    const bt = await page.textContent('#bl-teachers');
    if (!/TeroClass team/.test(bt) || /Owner|teroclass\.test/.test(bt)) throw new Error('billing: ' + bt);
    if (/Owner|teroclass\.test/.test(await page.textContent('#user-menu'))) throw new Error('user menu');
  });

  console.log(failed ? `${failed} view-as scenario(s) FAILED` : 'All view-as scenarios passed');
  process.exitCode = failed ? 1 : 0;
  await browser.close();
})();
