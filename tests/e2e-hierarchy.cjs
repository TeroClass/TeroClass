// Hierarchy (3 levels) + admin/teacher modes + Structure / Platform screens (mock Supabase + mock AI).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-hierarchy.cjs
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;

async function setup(browser) {
  M.resetDb();
  const ctx = await browser.newContext();
  const st = { errors: [], main: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); const s = JSON.stringify(b);
      const kind = s.includes('STUDENT HANDOUT') ? 'student' : s.includes("institution's CORE") ? 'summary' : 'main';
      if (kind === 'main') st.main.push(b);
      const content = kind === 'student' ? "Test\nToday's goals:\n- I can greet" : kind === 'summary' ? '- core' : "Week 1 - Class 1 - Test\nAttendance:\n\nToday's Objectives:\n- Practice greetings";
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
    }
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
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const waitToast = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout: 8000 });
const clearToast = page => page.evaluate(() => { document.getElementById('toast').textContent = ''; });
// top bar institution switcher: choose a unit by name ('All institutions' = super admin's platform view)
async function pickUnit(page, name) {
  await page.click('#isw-btn'); await page.waitForSelector('#isw-menu.open');
  await page.locator('#isw-list .isw-opt', { hasText: name }).first().click();
  await page.waitForFunction(n => !document.getElementById('isw-menu').classList.contains('open') && document.getElementById('isw-label').textContent.includes(n), name);
}
const nodeRow = (page, name) => page.locator('.tree-row', { has: page.locator('.tree-name', { hasText: name }) }).first();
// Madre › Sede 1 (own color) › Cátedra 1 ; Madre › Sede 2. Admins at each level, teachers, classes and playbooks.
function seedTree() {
  const madre = M.seedInstitution({ name: 'Madre H', slug: 'madre', color: '#222222', master_prompt: 'Madre rule', logo_url: null });
  const sede1 = M.seedInstitution({ name: 'Sede 1', slug: 'sede1', color: '#123456', bg_color: null, font: null, parent_id: madre.id, master_prompt: 'Sede rule' });
  const sede2 = M.seedInstitution({ name: 'Sede 2', slug: 'sede2', color: null, bg_color: null, font: null, parent_id: madre.id });
  const cat1 = M.seedInstitution({ name: 'Cátedra 1', slug: 'cat1', color: null, bg_color: null, font: null, parent_id: sede1.id, master_prompt: 'Catedra rule' });
  const mk = (email, role, inst) => { const u = M.newUser(email, { name: email.split('@')[0] }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const owner = M.newUser('owner@teroclass.test', { name: 'Owner' });
  const madm = mk('madm@h.com', 'org_admin', madre.id), s1adm = mk('s1adm@h.com', 'org_admin', sede1.id);
  const tc1 = mk('tc1@h.com', 'teacher', cat1.id), ts2 = mk('ts2@h.com', 'teacher', sede2.id), tm = mk('tm@h.com', 'teacher', madre.id);
  const plan = (o, inst, subj) => db.plannings.push({ id: M.uid(), owner_id: o.id, institution_id: inst, title: 'Plan ' + subj, data: { params: { subjects: [subj], level: 'Primary' }, content: 'x' }, created_at: new Date().toISOString() });
  plan(tc1, cat1.id, 'Math'); plan(tc1, cat1.id, 'Math'); plan(ts2, sede2.id, 'History'); plan(tm, madre.id, 'Art');
  db.institution_documents.push({ id: 'doc-m', institution_id: madre.id, name: 'madre.txt', summary: '- Madre principle: learning by doing', chars: 100, created_at: new Date().toISOString() });
  db.institution_documents.push({ id: 'doc-s1', institution_id: sede1.id, name: 'sede.txt', summary: '- Sede principle: lab every week', chars: 100, created_at: new Date().toISOString() });
  return { madre, sede1, sede2, cat1, owner, madm, s1adm, tc1, ts2, tm };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('Super admin: mode switch, first institution, Structure empty state → sub-unit → cátedra (3 levels max)', browser, async ({ page }) => {
    M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'owner@teroclass.test');
    await page.waitForSelector('#panel-superadmin.active');
    if (!(await page.isVisible('#mode-switch'))) throw new Error('no mode switch for super admin');
    if (await page.isVisible('#nav-ai') || await page.isVisible('#nav-home')) throw new Error('admin mode shows teacher nav');
    if (!(await page.isVisible('#nav-superadmin')) || !(await page.isVisible('#nav-platform')) || !(await page.isVisible('#nav-insights'))) throw new Error('platform nav missing');
    if (await page.isVisible('#nav-structure')) throw new Error('institution nav visible in "All institutions"');
    if (await page.isVisible('.btn-new-class')) throw new Error('"New class" visible in admin mode');
    if (!/All institutions/.test(await page.textContent('#isw-label'))) throw new Error('switcher not on All');
    await page.waitForSelector('.inst-empty');
    if (!/No institutions yet/.test(await page.textContent('.inst-empty'))) throw new Error('no empty state');
    await page.click('#panel-superadmin .btn-create-inst');
    await page.fill('#new-inst-name', 'Universidad X'); await page.fill('#new-inst-admin', 'rector@x.edu');
    await page.click('#modal-create-inst .btn-modal-save');
    await waitToast(page, /created/);
    await pickUnit(page, 'Universidad X');
    await page.waitForSelector('#nav-structure', { state: 'visible' });
    await page.click('#nav-structure');
    await page.waitForSelector('.tree-hint');
    if (!/Create your first unit/.test(await page.textContent('.tree-hint'))) throw new Error('no "first unit" guidance');
    if (!/Main institution/.test(await page.textContent('.tree-row'))) throw new Error('no level label');
    await page.click('.tree-hint [data-h="add-unit"]');
    await page.waitForSelector('#modal-create-unit.active');
    if (!/Campus \/ Faculty/.test(await page.textContent('#modal-create-unit'))) throw new Error('modal does not say the level');
    await page.fill('#unit-name', 'Facultad de Ingeniería');
    if (await page.inputValue('#unit-slug') !== 'facultad-de-ingenieria') throw new Error('slug not generated: ' + await page.inputValue('#unit-slug'));
    await page.click('#btn-create-unit');
    await waitToast(page, /Unit "Facultad de Ingeniería" created/);
    const c = calls.rpc.find(x => x.fn === 'create_institution' && x.body.p_parent);
    if (!c || c.body.p_parent !== db.institutions[0].id || c.body.p_color !== null) throw new Error('create_institution without parent: ' + JSON.stringify(c && c.body));
    await page.waitForSelector('.tree-children .tree-row');
    if (!/Campus \/ Faculty/.test(await page.textContent('.tree-children .tree-row'))) throw new Error('child level label');
    await nodeRow(page, 'Facultad de Ingeniería').locator('[data-h="add-unit"]').click();
    await page.fill('#unit-name', 'Cátedra de Física'); await page.click('#btn-create-unit');
    await page.waitForFunction(() => document.querySelectorAll('.tree-children .tree-children .tree-row').length === 1);
    const cat = nodeRow(page, 'Cátedra de Física');
    if (!/Department \/ Area/.test(await cat.textContent())) throw new Error('level 3 label');
    if (await cat.locator('[data-h="add-unit"]').count()) throw new Error('level 3 offers "+ Sub-unit"');
    // delete the empty cátedra with two clicks (no confirm())
    await cat.locator('[data-h="del"]').click();
    if (!db.institutions.some(i => i.name === 'Cátedra de Física')) throw new Error('deleted on first click');
    await cat.locator('[data-h="del"]').click();
    await waitToast(page, /Unit deleted/);
    if (db.institutions.some(i => i.name === 'Cátedra de Física')) throw new Error('not deleted');
    // switch to teacher mode, remembered after reload
    await page.click('#mode-switch [data-mode="teacher"]');
    await page.waitForSelector('#panel-home.active');
    if (await page.isVisible('#nav-structure') || !(await page.isVisible('#nav-ai'))) throw new Error('teacher mode nav wrong');
    await page.reload(); await page.waitForSelector('#screen-app.active');
    await page.waitForSelector('#nav-ai', { state: 'visible' });
    if (await page.isVisible('#nav-admin')) throw new Error('mode not remembered');
  });

  await run('Admin of the madre: Open a grandchild (breadcrumb), invite to it, dashboard aggregates + breakdown per unit', browser, async ({ page }) => {
    const t = seedTree();
    await login(page, 'madm@h.com');
    await page.waitForSelector('#panel-structure.active');
    await page.waitForSelector('.tree-row');
    if (await page.locator('.tree-row').count() !== 4) throw new Error('tree should show 4 units, got ' + await page.locator('.tree-row').count());
    const madreTxt = await nodeRow(page, 'Madre H').textContent();
    if (!/Including sub-units:/.test(madreTxt)) throw new Error('no totals: ' + madreTxt);
    await nodeRow(page, 'Cátedra 1').locator('[data-h="open"]').click();
    await page.waitForSelector('#panel-admin.active');
    await page.waitForFunction(() => /Madre H›Sede 1›Cátedra 1/.test(document.getElementById('ctx-crumb')?.textContent || ''));
    if (!/Department \/ Area/.test(await page.textContent('#ctx-bar'))) throw new Error('breadcrumb level');
    await page.waitForFunction(() => document.getElementById('m-plans').textContent === '2');
    if (!/Cátedra 1/.test(await page.textContent('#isw-label'))) throw new Error('Open did not set the switcher');
    await page.click('#nav-structure');
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length === 1); // Structure = the selected unit
    await pickUnit(page, 'Madre H');
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length === 4);
    await nodeRow(page, 'Sede 2').locator('[data-h="invite"]').click();
    await page.waitForSelector('#modal-invite.active');
    if (!/Madre H › Sede 2/.test(await page.textContent('#invite-org-name'))) throw new Error('invite modal target: ' + await page.textContent('#invite-org-name'));
    await page.fill('#invite-email', 'nuevo@h.com'); await page.click('#modal-invite .btn-modal-save');
    await waitToast(page, /Invitation saved/);
    const inv = calls.rpc.filter(x => x.fn === 'invite_member').pop();
    if (inv.body.p_inst !== t.sede2.id) throw new Error('invited to wrong unit');
    await nodeRow(page, 'Madre H').locator('[data-h="open"]').click();
    await page.waitForFunction(() => document.getElementById('m-plans').textContent === '4');
    if (await page.textContent('#m-teachers') !== '3') throw new Error('teachers of whole tree: ' + await page.textContent('#m-teachers'));
    await page.waitForSelector('#units-card', { state: 'visible' });
    const rows = await page.$$eval('#units-table-body tr', trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim())));
    const s1 = rows.find(r => r[0].startsWith('Sede 1')); const own = rows.find(r => /this unit only/.test(r[0]));
    if (!s1 || s1[2] !== '1' || s1[3] !== '2') throw new Error('Sede 1 subtree totals: ' + JSON.stringify(rows));
    if (!own || own[3] !== '1') throw new Error('own row: ' + JSON.stringify(rows));
    await page.click('#units-table-body .unit-link >> text=Sede 2');
    await page.waitForFunction(() => /Madre H›Sede 2/.test(document.getElementById('ctx-crumb')?.textContent || ''));
  });

  await run('Sede admin sees only its subtree; Structure tree starts at its unit', browser, async ({ page }) => {
    seedTree();
    await login(page, 's1adm@h.com');
    await page.waitForSelector('#panel-structure.active');
    await page.waitForSelector('.tree-row');
    const names = await page.$$eval('.tree-name > span:first-child', els => els.map(e => e.textContent));
    if (JSON.stringify(names) !== JSON.stringify(['Sede 1', 'Cátedra 1'])) throw new Error('visible units: ' + JSON.stringify(names));
    if (!/Campus \/ Faculty/.test(await nodeRow(page, 'Sede 1').textContent())) throw new Error('root level should be 2 for a sede');
    if (await nodeRow(page, 'Sede 1').locator('[data-h="del"]').count()) throw new Error('sede admin can delete own unit');
    await page.click('#nav-admin');
    await page.waitForFunction(() => /Madre H›Sede 1/.test(document.getElementById('ctx-crumb')?.textContent || ''));
  });

  await run('AI Settings: madre hides a bar + adds its own; sede sees it locked/inherited; teacher of the cátedra gets the effective bars, prompts and playbooks', browser, async ({ page }) => {
    const t = seedTree();
    await login(page, 'madm@h.com');
    await nodeRow(page, 'Madre H').locator('[data-h="open"]').click();
    await page.click('#nav-master');
    await page.waitForSelector('#meth-list .meth-row');
    await clearToast(page);
    await page.locator('#meth-list label.meth-row', { hasText: 'Gamification' }).locator('input').uncheck();
    await waitToast(page, /Bars saved/);
    if (JSON.stringify(t.madre.methodology_config.hidden) !== '["gamification"]') throw new Error('hidden not saved: ' + JSON.stringify(t.madre.methodology_config));
    await page.fill('#meth-new-label', 'Outdoor learning'); await page.fill('#meth-new-tip', 'Activities outside. Use the schoolyard'); await page.fill('#meth-new-def', '40');
    await clearToast(page);
    await page.click('[data-h="meth-add"]');
    await waitToast(page, /Bars saved/);
    const cu = t.madre.methodology_config.custom[0];
    if (!cu || cu.label !== 'Outdoor learning' || cu.def !== 40 || !/^c_outdoor_learning_[a-z0-9]{1,4}$/.test(cu.key)) throw new Error('custom bar: ' + JSON.stringify(cu));
    await page.fill('#meth-new-label', '<b>x</b>'); await clearToast(page); await page.click('[data-h="meth-add"]');
    await waitToast(page, /cannot contain/);
    // sede: inherited view (switcher → AI Settings follows it)
    await pickUnit(page, 'Sede 1');
    await page.waitForFunction(() => /Hidden by\s*Madre H/.test(document.getElementById('meth-list')?.innerText || ''));
    const txt = await page.textContent('#meth-list');
    if (!/Outdoor learning/.test(txt) || !/from\s*Madre H/.test(txt) || !/Bars inherited from the units above/.test(txt)) throw new Error('inherited view: ' + txt);
    if (!/Madre rule/.test(await page.textContent('#mp-inherited'))) throw new Error('inherited master prompt not shown');
    if (!/madre\.txt/.test(await page.textContent('#pb-inherited'))) throw new Error('inherited playbook not shown');
    await page.locator('#meth-list label.meth-row', { hasText: 'Teacher Talking Time' }).locator('input').uncheck();
    await waitToast(page, /Bars saved/);
    if (JSON.stringify(t.sede1.methodology_config.hidden) !== '["ttt"]') throw new Error('sede hidden: ' + JSON.stringify(t.sede1.methodology_config));
    // teacher of the cátedra
    await page.evaluate(() => handleLogout());
    await login(page, 'tc1@h.com');
    if (await page.isVisible('#mode-switch')) throw new Error('teacher sees mode switch');
    await page.click('#nav-ai');
    await page.waitForSelector('#sl-c_' + cu.key.slice(2));
    const keys = await page.$$eval('#sliders-container input.tc-slider', els => els.map(e => e.id.slice(3)));
    if (keys.includes('gamification') || keys.includes('ttt') || !keys.includes('stt') || keys[keys.length - 1] !== cu.key) throw new Error('effective sliders: ' + keys.join(','));
    if (await page.inputValue('#sl-' + cu.key) !== '40') throw new Error('custom default not used');
    await page.fill('#prompt-input', 'Plants'); await page.click('#btn-generate'); await page.waitForSelector('#lp-doc');
    const b1 = await getMain(page); const sys = b1.messages[0].content; let user = b1.messages[1].content;
    if (!/kept the default balance/.test(user) || !/Outdoor learning/.test(user) || /Gamification/.test(user)) throw new Error('default-balance block: ' + user.match(/PEDAGOGICAL[^\n]*/)?.[0]);
    if (/Talk time: balance/.test(user)) throw new Error('talk-time split used with TTT hidden');
    if (!/\[Madre H\]\nMadre rule[\s\S]*\[Sede 1\]\nSede rule[\s\S]*\[Cátedra 1\]\nCatedra rule/.test(sys)) throw new Error('master prompts chain: ' + sys.slice(sys.indexOf('INSTITUTION REQUIREMENTS'), sys.indexOf('INSTITUTION REQUIREMENTS') + 400));
    if (!/── Madre H ──\n\[madre\.txt\][\s\S]*── Sede 1 ──\n\[sede\.txt\]/.test(sys)) throw new Error('playbook cores chain');
    await page.evaluate(k => { const s = document.getElementById('sl-' + k); s.value = 85; s.dispatchEvent(new Event('input')); }, cu.key);
    await page.click('#btn-generate');
    const b2 = await getMain(page, 2); user = b2.messages[1].content;
    if (!/REQUIRED · Outdoor learning = 85 → DOMINANT[^\n]*Meaning: Activities outside\./.test(user)) throw new Error('custom bar not required: ' + (user.match(/- REQUIRED[^\n]*/g) || []).join(' | '));
  });

  await run('Teacher registers via /org/<cátedra>: path on login, inherited branding, no admin UI', browser, async ({ page }) => {
    seedTree();
    await page.goto('http://teroclass.test/org/cat1');
    await page.waitForFunction(() => document.getElementById('auth-org-name')?.textContent === 'Cátedra 1');
    if (await page.textContent('#auth-org-path') !== 'Madre H › Sede 1 › Cátedra 1') throw new Error('path: ' + await page.textContent('#auth-org-path'));
    const col = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim());
    if (col !== '#123456') throw new Error('login branding not inherited: ' + col);
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Nueva Profe'); await page.fill('#reg-email', 'nueva@h.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    const p = db.profiles.find(x => x.email === 'nueva@h.com');
    if (p.institution_id !== db.institutions.find(i => i.slug === 'cat1').id || p.role !== 'teacher') throw new Error('joined wrong unit');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() === '#123456');
    if (await page.isVisible('#mode-switch') || await page.isVisible('#nav-structure') || await page.isVisible('#ctx-bar')) throw new Error('teacher sees admin UI');
  });

  await run('Branding of a sub-unit: "same as the unit above" ↔ own colors', browser, async ({ page }) => {
    const t = seedTree();
    await login(page, 'madm@h.com');
    await nodeRow(page, 'Sede 2').locator('[data-h="brand"]').click();
    await page.waitForSelector('#panel-branding.active');
    if (!(await page.isChecked('#wl-inherit'))) throw new Error('sede 2 (no own branding) should inherit');
    if (await page.textContent('#wl-inherit-parent') !== 'Madre H') throw new Error('parent name');
    if (await page.inputValue('#wl-primary-hex') !== '#222222' || !(await page.isDisabled('#wl-primary-hex'))) throw new Error('inherited color not shown/locked');
    await page.uncheck('#wl-inherit');
    await page.fill('#wl-primary-hex', '#aa0000'); await page.dispatchEvent('#wl-primary-hex', 'input');
    await page.evaluate(() => saveBranding()); await waitToast(page, /Branding saved/);
    if (t.sede2.color !== '#aa0000') throw new Error('own color not saved: ' + t.sede2.color);
    await nodeRow(page, 'Sede 2').locator('[data-h="brand"]').click().catch(async () => { await page.click('#nav-structure'); await nodeRow(page, 'Sede 2').locator('[data-h="brand"]').click(); });
    await page.waitForSelector('#panel-branding.active');
    if (await page.isChecked('#wl-inherit')) throw new Error('should not inherit after own color');
    await page.check('#wl-inherit');
    await page.evaluate(() => saveBranding()); await waitToast(page, /Branding saved/);
    if (t.sede2.color !== null || t.sede2.font !== null || t.sede2.logo_url !== null) throw new Error('inherit did not clear own values: ' + JSON.stringify([t.sede2.color, t.sede2.font]));
    await pickUnit(page, 'Madre H');
    await page.click('#nav-structure'); await page.waitForFunction(() => document.querySelectorAll('.tree-row').length === 4);
    if (await page.isVisible('#wl-inherit-row')) throw new Error('inherit row visible outside branding');
    await nodeRow(page, 'Madre H').locator('[data-h="brand"]').click();
    if (await page.isVisible('#wl-inherit-row')) throw new Error('main institution offers inheritance');
  });

  await run('Platform (super admin): totals, search, change role, move to a unit; Spanish UI', browser, async ({ page }) => {
    const t = seedTree();
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForFunction(() => document.getElementById('pf-m-classes').textContent === '4');
    if (await page.textContent('#pf-m-inst') !== '4' || await page.textContent('#pf-m-top') !== '1' || await page.textContent('#pf-m-ai') !== '7') throw new Error('totals');
    await page.waitForSelector('#pf-table-body tr');
    const n0 = await page.locator('#pf-table-body tr').count();
    if (n0 !== 6) throw new Error('accounts: ' + n0);
    const madmRow = page.locator('#pf-table-body tr', { hasText: 'madm@h.com' });
    if (!/Madre H/.test(await madmRow.locator('select.pf-inst option:checked').textContent())) throw new Error('institution path');
    await page.fill('#pf-search', 'sede 2');
    await page.waitForFunction(() => document.querySelectorAll('#pf-table-body tr').length === 1);
    if (!/ts2@h\.com/.test(await page.textContent('#pf-table-body'))) throw new Error('search by institution');
    await page.fill('#pf-search', 'tc1');
    const row = page.locator('#pf-table-body tr', { hasText: 'tc1@h.com' });
    await row.locator('select.pf-inst').selectOption(t.sede2.id);
    if (t.tc1.institution_id !== t.cat1.id) throw new Error('moved without confirming');
    await row.locator('[data-h="pf-move"]').click();
    await waitToast(page, /Moved/);
    if (t.tc1.institution_id !== t.sede2.id) throw new Error('not moved');
    if (!calls.rpc.some(c => c.fn === 'admin_move_member' && c.body.p_user === t.tc1.id && c.body.p_inst === t.sede2.id)) throw new Error('admin_move_member not called');
    await page.fill('#pf-search', 'tm@');
    await page.locator('#pf-table-body tr', { hasText: 'tm@h.com' }).locator('select[data-hc="pf-role"]').selectOption('org_admin');
    await waitToast(page, /Role updated/);
    if (t.tm.role !== 'org_admin') throw new Error('role not changed');
    await page.fill('#pf-search', 'owner');
    if (await page.locator('#pf-table-body select').count()) throw new Error('platform owner row is editable');
    await page.click('.topbar-right .lang-toggle button[data-lang="es"]');
    await page.waitForFunction(() => /Modo admin/.test(document.getElementById('mode-switch').innerText) && /Todas las cuentas/.test(document.body.innerText));
    if (await page.textContent('#isw-label') !== 'Todas las instituciones') throw new Error('switcher label not translated');
    await pickUnit(page, 'Madre H');
    await page.click('#nav-structure');
    await page.waitForFunction(() => /Institución madre/.test(document.getElementById('structure-tree').textContent) && /Sede \/ Facultad/.test(document.getElementById('structure-tree').textContent)); // badges are uppercased by CSS
    if (!/Estructura/.test(await page.textContent('#panel-structure .sa-title'))) throw new Error('title not translated');
    await page.click('.topbar-right .lang-toggle button[data-lang="en"]');
  });

  await browser.close();
  console.log(failed ? `${failed} hierarchy scenario(s) FAILED` : 'All hierarchy scenarios passed');
  process.exitCode = failed ? 1 : 0;
})();

// AI requests captured by setup()
async function getMain(page, n = 1) {
  const st = page.__st;
  for (let i = 0; i < 40; i++) { if (st && st.main.length >= n) return st.main[n - 1]; await sleep(100); }
  throw new Error('no AI request #' + n);
}
