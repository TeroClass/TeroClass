// Top bar institution switcher (per role, persistence, "All institutions", View as lock), sidebar with labels
// and groups, and the super admin Metrics panel, formerly "Insights" (mock Supabase + mock /api/generate and /api/billing/status).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-nav-insights.cjs
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, bill, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const XSS = '<img src=x onerror="window.__xss=1">';
const SHOTS = process.env.SHOTS || '';

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1366, height: 900 } });
  const st = { errors: [], gen: [], status: opts.status || null };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); st.gen.push(b);
      const content = b.kind === 'student' ? "Test\nToday's goals:\n- I can greet" : "Week 1 - Class 1 - Test\nToday's Objectives:\n- Practice";
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
    }
    if (u.pathname === '/api/billing/status') return st.status ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(st.status) }) : r.fulfill({ status: 404, body: 'not found' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage(); page.__st = st;
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
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const text = (page, sel) => page.textContent(sel);
const visible = (page, sel) => page.isVisible(sel);
async function openSwitcher(page) { await page.click('#isw-btn'); await page.waitForSelector('#isw-menu.open'); }
async function pickUnit(page, name) {
  await openSwitcher(page);
  await page.locator('#isw-list .isw-opt', { hasText: name }).first().click();
  await page.waitForFunction(n => !document.getElementById('isw-menu').classList.contains('open') && document.getElementById('isw-label').textContent.includes(n), name);
}
const options = page => page.$$eval('#isw-list .isw-opt', els => els.map(e => ({ t: e.textContent.replace('└', '').trim(), l: (e.className.match(/\bl(\d)\b/) || [])[1] || '', sel: e.classList.contains('sel') })));
const shot = async (page, name) => { if (!SHOTS) return; await page.mouse.move(5, 5); await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/nav-${name}.png` }); };
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || /^\(UTC\)$/.test(t) || t === 'UTC' || t === 'Top 10' || t === 'Tokens') continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);

// Coach (madre) › Sede Centro › Cátedra Inglés ; Coach › Sede Norte ; Otra Escuela. Admins, teachers, classes.
function seed({ extraRoots = 0 } = {}) {
  const madre = M.seedInstitution({ name: 'The English Coach', slug: 'coach', color: '#aa0000', methodology_config: { hidden: [], custom: [{ key: 'c_outdoor_x1', label: 'Outdoor learning', tooltip: '', def: 30 }] } });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', color: null, bg_color: null, font: null, parent_id: madre.id });
  const norte = M.seedInstitution({ name: 'Sede Norte', slug: 'norte', color: null, bg_color: null, font: null, parent_id: madre.id });
  const cat = M.seedInstitution({ name: 'Cátedra Inglés', slug: 'cat', color: null, bg_color: null, font: null, parent_id: centro.id });
  const otra = M.seedInstitution({ name: 'Otra ' + XSS, slug: 'otra' });
  for (let i = 0; i < extraRoots; i++) M.seedInstitution({ name: 'Escuela ' + String(i + 1).padStart(2, '0'), slug: 'esc' + i });
  const mk = (email, role, inst, name) => { const u = M.newUser(email, { name: name || email.split('@')[0] }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const owner = M.newUser('owner@teroclass.test', { name: 'Owner' });
  const madm = mk('madm@c.com', 'org_admin', madre.id, 'Marta Madre');
  const cadm = mk('cadm@c.com', 'org_admin', cat.id, 'Carla Catedra');   // admin of a single unit (no sub-units)
  const sadm = mk('sadm@c.com', 'org_admin', centro.id, 'Sergio Centro');
  const tc = mk('tc@c.com', 'teacher', cat.id, 'Tina Catedra');
  const plan = (o, inst, subj) => db.plannings.push({ id: M.uid(), owner_id: o.id, institution_id: inst, title: 'Plan ' + subj, data: { params: { subjects: [subj], level: 'Primary' }, content: 'x' }, created_at: new Date().toISOString() });
  plan(tc, cat.id, 'Math'); plan(tc, cat.id, 'History');
  return { madre, centro, norte, cat, otra, owner, madm, cadm, sadm, tc };
}
const INST_NAV = ['#nav-structure', '#nav-admin', '#nav-branding', '#nav-master', '#nav-billing'];
const PLATFORM_NAV = ['#nav-superadmin', '#nav-metrics', '#nav-platform'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('Super admin switcher: All institutions + indented tree; selecting a unit drives every institution screen; Institutions = All', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'owner@teroclass.test');
    await page.waitForSelector('#panel-superadmin.active');
    if ((await text(page, '#isw-label')) !== 'All institutions') throw new Error('default should be All: ' + await text(page, '#isw-label'));
    for (const id of INST_NAV) if (await visible(page, id)) throw new Error(id + ' visible in All institutions');
    for (const id of PLATFORM_NAV) if (!(await visible(page, id))) throw new Error(id + ' missing for super admin');
    // All institutions: the institution group holds only Insights (class insights of every institution)
    if (JSON.stringify(await page.$$eval('.sib-group[data-group="inst"] .sib-btn', bs => bs.filter(b => b.offsetParent).map(b => b.id))) !== '["nav-unit-insights"]') throw new Error('institution group in All: only Insights expected');
    await openSwitcher(page);
    if (await visible(page, '#isw-search')) throw new Error('search shown with few units');
    const o = await options(page);
    const exp = [['All institutions', ''], ['Otra ' + XSS, '1'], ['The English Coach', '1'], ['Sede Centro', '2'], ['Cátedra Inglés', '3'], ['Sede Norte', '2']];
    if (JSON.stringify(o.map(x => [x.t.replace(/^🌐\s*/, ''), x.l])) !== JSON.stringify(exp)) throw new Error('options: ' + JSON.stringify(o));
    if (!o[0].sel) throw new Error('All not marked selected');
    await page.keyboard.press('Escape');
    if (await visible(page, '#isw-menu')) throw new Error('Escape did not close');
    await shot(page, 'superadmin-all');
    await pickUnit(page, 'Sede Centro');
    await page.waitForSelector('#panel-admin.active'); // from the list → dashboard of the unit
    for (const id of INST_NAV.concat(PLATFORM_NAV)) if (!(await visible(page, id))) throw new Error(id + ' missing with a unit selected');
    await page.waitForFunction(() => /Sede Centro/.test(document.getElementById('admin-inst-badge').textContent) && document.getElementById('m-plans').textContent === '2');
    await page.click('#nav-structure');
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length === 2);
    const names = await page.$$eval('.tree-name > span:first-child', els => els.map(e => e.textContent));
    if (JSON.stringify(names) !== '["Sede Centro","Cátedra Inglés"]') throw new Error('structure = unit + below: ' + JSON.stringify(names));
    await page.click('#nav-master');
    await page.waitForFunction(() => /Sede Centro/.test(document.getElementById('master-inst-badge').textContent));
    await page.click('#nav-billing');
    await page.waitForFunction(() => /The English Coach/.test(document.getElementById('billing-root').textContent));
    await page.click('#nav-branding');
    await page.waitForFunction(() => document.getElementById('wl-name').value === 'Sede Centro');
    // switching while on a screen re-renders it for the new unit
    await pickUnit(page, 'The English Coach');
    await page.waitForFunction(() => document.getElementById('wl-name').value === 'The English Coach' && document.getElementById('panel-branding').classList.contains('active'));
    await page.click('#nav-admin');
    await page.waitForFunction(() => /Coach/.test(document.getElementById('ctx-bar').textContent));
    await page.click('#ctx-bar [data-h="isw-open"]');
    await page.waitForSelector('#isw-menu.open');
    await page.locator('#isw-list .isw-opt', { hasText: 'Cátedra Inglés' }).click();
    await page.waitForFunction(() => /Cátedra Inglés/.test(document.getElementById('ctx-crumb')?.textContent || ''));
    await shot(page, 'superadmin-unit');
    // "Institutions" in the sidebar = All institutions + the cards
    await page.click('#nav-superadmin');
    await page.waitForSelector('#panel-superadmin.active .inst-card');
    if ((await text(page, '#isw-label')) !== 'All institutions') throw new Error('Institutions did not select All');
    if (await visible(page, '#nav-structure')) throw new Error('institution nav after Institutions');
    // "View" on a card sets the switcher
    await page.locator('.inst-card', { hasText: 'The English Coach' }).locator('[data-action="view-inst"]').click();
    await page.waitForSelector('#panel-admin.active');
    if ((await text(page, '#isw-label')) !== 'The English Coach') throw new Error('View did not set the switcher');
    // choosing All from an institution screen goes back to the list
    await pickUnit(page, 'All institutions');
    await page.waitForSelector('#panel-superadmin.active');
    // institution screens can't be opened by code without a unit
    await page.evaluate(() => showPanel('billing'));
    if (!(await visible(page, '#panel-superadmin'))) throw new Error('billing opened in All');
  });

  await run('Switcher search (more than 8 units) and keyboard', browser, async ({ page }) => {
    seed({ extraRoots: 6 });
    await login(page, 'owner@teroclass.test');
    await openSwitcher(page);
    if (!(await visible(page, '#isw-search'))) throw new Error('no search with 11 units');
    await page.waitForFunction(() => document.activeElement?.id === 'isw-search');
    await page.fill('#isw-search', 'centro');
    const o = await options(page);
    if (o.length !== 3 || !/Sede Centro/.test(o[1].t) || !/Cátedra Inglés/.test(o[2].t)) throw new Error('search by name/path: ' + JSON.stringify(o));
    await page.fill('#isw-search', 'zzz');
    if (!/No units match your search/.test(await text(page, '#isw-list'))) throw new Error('no empty result message');
    await page.fill('#isw-search', 'escuela 03');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'Escuela 03');
    await openSwitcher(page);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement?.className || '');
    if (!/isw-opt/.test(focused)) throw new Error('arrow keys do not move through options');
    await page.mouse.click(900, 600); // click outside closes
    if (await visible(page, '#isw-menu')) throw new Error('click outside did not close');
  });

  await run('Persistence per user (localStorage, validated): super admin and admin; invalid values fall back', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'owner@teroclass.test');
    await pickUnit(page, 'Sede Norte');
    const key = 'tc_inst_sel:' + t.owner.id;
    if (await page.evaluate(k => localStorage.getItem(k), key) !== t.norte.id) throw new Error('not saved per user');
    await page.reload(); await page.waitForSelector('#screen-app.active');
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'Sede Norte');
    if (!(await visible(page, '#nav-structure'))) throw new Error('institution nav after reload');
    await page.waitForSelector('#panel-structure.active'); // admin mode lands on Structure of the remembered unit
    await pickUnit(page, 'All institutions');
    if (await page.evaluate(k => localStorage.getItem(k), key) !== '__all__') throw new Error('All not saved');
    // a unit that no longer exists → All
    await page.evaluate(k => localStorage.setItem(k, '00000000-0000-4000-8000-00000000dead'), key);
    await page.reload(); await page.waitForSelector('#screen-app.active');
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'All institutions');
    // admin of the madre: remembered sub-unit; a unit outside their subtree is ignored (→ own unit)
    await page.evaluate(() => handleLogout());
    await login(page, 'madm@c.com');
    await pickUnit(page, 'Cátedra Inglés');
    await page.reload(); await page.waitForSelector('#screen-app.active');
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'Cátedra Inglés');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), ['tc_inst_sel:' + t.madm.id, t.otra.id]);
    await page.reload(); await page.waitForSelector('#screen-app.active');
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'The English Coach');
    // localStorage unavailable → still works
    await page.evaluate(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
    await pickUnit(page, 'Sede Norte');
  });

  await run('Admin: dropdown limited to their subtree (no All); single-unit admin sees a static name; teacher sees nothing', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'madm@c.com');
    await page.waitForSelector('#panel-structure.active');
    if ((await text(page, '#isw-label')) !== 'The English Coach') throw new Error('admin default = own unit');
    await openSwitcher(page);
    const o = await options(page);
    if (JSON.stringify(o.map(x => x.t)) !== '["The English Coach","Sede Centro","Cátedra Inglés","Sede Norte"]') throw new Error('admin options: ' + JSON.stringify(o));
    await page.keyboard.press('Escape');
    for (const id of PLATFORM_NAV) if (await visible(page, id)) throw new Error(id + ' visible for an admin');
    for (const id of INST_NAV) if (!(await visible(page, id))) throw new Error(id + ' missing for an admin');
    if (!(await page.evaluate(() => typeof setInstSel === 'function'))) throw new Error('no setInstSel');
    await page.evaluate(id => setInstSel(id), t.otra.id); // outside the subtree: ignored
    if ((await text(page, '#isw-label')) !== 'The English Coach') throw new Error('admin picked a unit outside the subtree');
    await page.evaluate(() => setInstSel(null)); // All: super admin only
    if ((await text(page, '#isw-label')) !== 'The English Coach') throw new Error('admin chose All');
    await pickUnit(page, 'Sede Centro');
    await page.waitForSelector('#panel-structure.active');
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length === 2);
    await shot(page, 'admin');
    // admin of a sede: dropdown with its 2 units
    await page.evaluate(() => handleLogout());
    await login(page, 'sadm@c.com');
    await openSwitcher(page);
    if (JSON.stringify((await options(page)).map(x => x.t)) !== '["Sede Centro","Cátedra Inglés"]') throw new Error('sede admin options');
    await page.keyboard.press('Escape');
    // admin of a single unit: static name, no dropdown
    await page.evaluate(() => handleLogout());
    await login(page, 'cadm@c.com');
    await page.waitForSelector('#isw-static', { state: 'visible' });
    if (await visible(page, '#isw-btn')) throw new Error('dropdown for a single-unit admin');
    if (!/Cátedra Inglés/.test(await text(page, '#isw-static'))) throw new Error('static name');
    // teacher: nothing, teaching screens as today
    await page.evaluate(() => handleLogout());
    await login(page, 'tc@c.com');
    await page.waitForSelector('#panel-home.active');
    if (await visible(page, '#inst-switch')) throw new Error('teacher sees the switcher');
    for (const id of ['#nav-home', '#nav-ai', '#nav-live']) if (!(await visible(page, id))) throw new Error(id + ' missing for a teacher');
    for (const id of INST_NAV.concat(PLATFORM_NAV)) if (await visible(page, id)) throw new Error(id + ' visible for a teacher');
    await page.waitForFunction(() => document.querySelectorAll('#classes-grid .class-card').length === 2);
    await page.click('#nav-live'); await page.waitForSelector('#panel-live.active');
    await page.click('#nav-ai'); await page.waitForSelector('#panel-ai.active');
    await shot(page, 'teacher');
  });

  await run('View as: switcher locked to the viewed unit; Exit restores the previous selection (not saved meanwhile)', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'owner@teroclass.test');
    await pickUnit(page, 'Sede Norte');
    const key = 'tc_inst_sel:' + t.owner.id;
    await page.evaluate(id => enterViewAs({ unitId: id, perspective: 'admin', person: null }), t.centro.id);
    await page.waitForSelector('#viewas-banner', { state: 'visible' });
    await page.waitForSelector('#isw-static.locked', { state: 'visible' });
    if (await visible(page, '#isw-btn')) throw new Error('dropdown available in View as');
    if (!/The English Coach › Sede Centro/.test(await text(page, '#isw-static'))) throw new Error('locked label: ' + await text(page, '#isw-static'));
    if (await visible(page, '#nav-metrics')) throw new Error('Metrics visible in View as');
    await page.evaluate(id => setInstSel(id), t.norte.id);
    await page.evaluate(() => showPanel('metrics'));
    if (await visible(page, '#panel-metrics')) throw new Error('Metrics opened in View as');
    await page.click('#nav-admin');
    await page.waitForFunction(() => /Sede Centro/.test(document.getElementById('admin-inst-badge').textContent));
    if (await page.evaluate(k => localStorage.getItem(k), key) !== t.norte.id) throw new Error('View as changed the saved selection');
    await page.click('#viewas-banner .va-exit');
    await page.waitForSelector('#viewas-banner', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('isw-label').textContent === 'Sede Norte' && getComputedStyle(document.getElementById('isw-btn')).display !== 'none');
    if (await visible(page, '#isw-static')) throw new Error('lock not removed');
  });

  await run('Metrics: renders the three areas with mock data; period / scope / exclude-self filters; empty and not-recorded states', browser, async ({ page, st }) => {
    const t = seed();
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-metrics');
    await page.waitForSelector('#panel-metrics.active #in-usage');
    let c = calls.rpc.filter(x => x.fn === 'platform_insights').pop().body;
    if (c.p_days !== 30 || c.p_unit !== null || c.p_exclude_self !== true) throw new Error('default call: ' + JSON.stringify(c));
    if (!(await page.isDisabled('#in-scope-unit'))) throw new Error('unit scope enabled without a unit');
    const d = M.insightsData({ p_days: 30 });
    if ((await text(page, '#in-t-classes .metric-value')).trim() !== d.usage.classes.toLocaleString('en-US')) throw new Error('classes tile');
    if (await page.locator('#in-usage .in-col').count() !== 30) throw new Error('per-day bars');
    if (!/1.*7 days.*30 days/s.test(await text(page, '#in-t-active'))) throw new Error('active tile');
    if (!/Otra <img/.test(await text(page, '#in-usage'))) throw new Error('top institutions (escaped name)');
    if (!/Math/.test(await text(page, '#in-content')) || !/Spanish/.test(await text(page, '#in-content')) || !/Ages 13–15/.test(await text(page, '#in-content')) || !/Gamification/.test(await text(page, '#in-content')) || !/Outdoor learning/.test(await text(page, '#in-content')) || /c_outdoor/.test(await text(page, '#in-content'))) throw new Error('content: ' + await text(page, '#in-content'));
    if (!/1 \/ 2/.test(await text(page, '#in-t-playbook'))) throw new Error('playbook tile: ' + await text(page, '#in-t-playbook'));
    if ((await text(page, '#in-t-tokens .metric-value')).trim() !== '4.8M') throw new Error('tokens: ' + await text(page, '#in-t-tokens'));
    if ((await text(page, '#in-t-usd .metric-value')).trim() !== 'USD 21.00') throw new Error('usd: ' + await text(page, '#in-t-usd'));
    if ((await text(page, '#in-t-tpc .metric-value')).trim() !== '133.3k') throw new Error('tokens per class: ' + await text(page, '#in-t-tpc'));
    if (await page.$('#in-cost-notice')) throw new Error('notice with recorded data');
    if (!/input USD 2\.50 · output USD 10\.00/.test(await text(page, '#in-costs'))) throw new Error('prices line');
    // hover tooltip on a day bar
    await page.hover('#in-usage .in-col >> nth=3');
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('#in-usage .in-col .in-tip')[3]).opacity === '1', null, { timeout: 3000 }).catch(() => { throw new Error('no tooltip on hover'); });
    await shot(page, 'insights-all');
    if (SHOTS) { await page.evaluate(() => { document.getElementById('panel-metrics').scrollTop = 99999; }); await shot(page, 'insights-costs'); await page.evaluate(() => { document.getElementById('panel-metrics').scrollTop = 0; }); }
    // period
    await page.click('[data-in-days="7"]');
    await page.waitForFunction(() => document.querySelectorAll('#in-usage .in-col').length === 7);
    await page.click('[data-in-days="90"]');
    await page.waitForFunction(() => document.querySelectorAll('#in-usage .in-col').length === 90);
    // exclude my own activity
    await page.uncheck('#in-excl');
    await page.waitForFunction(() => document.querySelectorAll('#in-usage .in-col').length === 90);
    c = calls.rpc.filter(x => x.fn === 'platform_insights').pop().body;
    if (c.p_exclude_self !== false || c.p_days !== 90) throw new Error('exclude toggle: ' + JSON.stringify(c));
    // scope follows the switcher; "All institutions" button overrides it
    await pickUnit(page, 'Sede Centro');
    await page.waitForFunction(() => /Sede Centro/.test(document.getElementById('in-scope')?.textContent || ''));
    if (!(await page.isVisible('#panel-metrics'))) throw new Error('left Metrics when picking a unit');
    c = calls.rpc.filter(x => x.fn === 'platform_insights').pop().body;
    if (c.p_unit !== t.centro.id) throw new Error('unit scope: ' + JSON.stringify(c));
    if (!/Selected unit: Sede Centro/.test(await text(page, '#in-scope-unit'))) throw new Error('scope button label');
    await page.click('[data-in-scope="all"]');
    await page.waitForFunction(() => /all institutions/.test(document.getElementById('in-scope')?.textContent || ''));
    if (calls.rpc.filter(x => x.fn === 'platform_insights').pop().body.p_unit !== null) throw new Error('All scope');
    await page.click('[data-in-scope="unit"]');
    await page.waitForFunction(() => /Sede Centro/.test(document.getElementById('in-scope')?.textContent || ''));
    // not recorded (no service key): clear notice instead of zeros
    st.status = { billing_configured: false, billing_ok: null };
    M.insights.fixture = body => { const x = M.insightsData(body); x.tracking_since = null; x.costs = { ...x.costs, recorded_ever: false, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, usd: 0, classes: 0, by_institution: [] }; return x; };
    await page.evaluate(() => { IN.status = undefined; });
    await page.click('[data-in-days="30"]');
    await page.waitForSelector('#in-cost-notice');
    if (!/SUPABASE_SERVICE_ROLE_KEY/.test(await text(page, '#in-cost-notice'))) throw new Error('notice text');
    if (await page.$('#in-t-tokens') || await page.$('#in-cost-empty')) throw new Error('zeros shown instead of the notice');
    if (!(await page.$('#in-tracking-note'))) throw new Error('no tracking note');
    // empty period
    st.status = { billing_configured: true, billing_ok: true };
    M.insights.fixture = body => { const x = M.insightsData(body); x.usage = { ...x.usage, per_day: x.usage.per_day.map(p => ({ ...p, classes: 0 })), classes: 0, saved: 0, top_institutions: [] }; x.content = { ...x.content, subjects: [], languages: [], age_bands: [], bars: [] }; x.costs = { ...x.costs, total_tokens: 0, by_institution: [] }; return x; };
    await page.evaluate(() => { IN.status = undefined; });
    await page.click('[data-in-days="7"]');
    await page.waitForSelector('#in-cost-empty');
    if (!/No classes generated in this period/.test(await text(page, '#in-usage'))) throw new Error('usage empty state');
    if (!/No data in this period/.test(await text(page, '#in-content'))) throw new Error('content empty state');
    if (await page.$('#in-cost-notice')) throw new Error('not-recorded notice while configured');
    if (await page.locator('#in-usage .in-col').count()) throw new Error('empty chart drawn');
  });

  await run('Métricas in Spanish (formerly Insights) + AI prices editable in Platform', browser, async ({ page }) => {
    seed();
    await login(page, 'owner@teroclass.test', 'es');
    if ((await text(page, '#nav-metrics .sib-label')) !== 'Métricas' || (await text(page, '#nav-metrics .sib-label')) !== (await text(page, '#nav-metrics .sib-tooltip')) || (await text(page, '#nav-admin .sib-label')) !== 'Panel') throw new Error('label/tooltip ES');
    if ((await text(page, '#nav-unit-insights .sib-label')) !== 'Insights') throw new Error('class insights label ES');
    if ((await text(page, '#isw-label')) !== 'Todas las instituciones') throw new Error('switcher ES');
    await page.click('#nav-metrics');
    await page.waitForSelector('#in-usage');
    if (!/Métricas/.test(await text(page, '#panel-metrics .sa-title'))) throw new Error('panel title ES');
    for (const sel of ['#panel-metrics', '.icon-sidebar']) { const u = await untranslated(page, sel); if (u.length) throw new Error(sel + ' sin traducir: ' + JSON.stringify(u)); }
    if (!/Uso y actividad/.test(await text(page, '#in-usage')) || !/Costos/.test(await text(page, '#in-costs'))) throw new Error('titles ES');
    await shot(page, 'insights-es');
    await openSwitcher(page);
    let u = await untranslated(page, '#isw-menu'); if (u.length) throw new Error('switcher sin traducir: ' + JSON.stringify(u));
    await page.keyboard.press('Escape');
    // prices (Platform → AI cost estimate) feed the estimate
    await page.click('#in-costs [data-in="prices"]');
    await page.waitForSelector('#pf-ai-prices-card');
    u = await untranslated(page, '#pf-ai-prices-card'); if (u.length) throw new Error('precios sin traducir: ' + JSON.stringify(u));
    if (await page.inputValue('#pfs-ai-in') !== '2.5' || await page.inputValue('#pfs-ai-out') !== '10') throw new Error('price defaults');
    await page.fill('#pfs-ai-in', '-1'); await page.click('[data-bl="pf-save-prices"]');
    await waitToast(page, /Usá un precio entre 0 y 1000/);
    await page.fill('#pfs-ai-in', '5'); await page.fill('#pfs-ai-out', '15'); await page.click('[data-bl="pf-save-prices"]');
    await waitToast(page, /Precios guardados/);
    const c = calls.rpc.filter(x => x.fn === 'update_ai_prices').pop().body;
    if (c.p_input !== 5 || c.p_output !== 15) throw new Error('prices payload ' + JSON.stringify(c));
    await page.click('#nav-metrics');
    await page.waitForFunction(() => /entrada USD 5\.00 · salida USD 15\.00|input USD 5\.00 · output USD 15\.00/.test(document.getElementById('in-costs')?.textContent || ''));
  });

  await run('Admins and teachers never see Metrics (nav, direct call, RPC denied)', browser, async ({ page }) => {
    seed();
    for (const email of ['madm@c.com', 'tc@c.com']) {
      await login(page, email);
      if (await visible(page, '#nav-metrics') || await visible(page, '#nav-platform') || await visible(page, '#nav-superadmin')) throw new Error('platform nav for ' + email);
      await page.evaluate(() => showPanel('metrics'));
      if (await visible(page, '#panel-metrics')) throw new Error('Metrics opened for ' + email);
      const r = await page.evaluate(async () => (await sb.rpc('platform_insights', { p_days: 30 })).error?.message || 'ok');
      if (!/No autorizado/.test(r)) throw new Error('RPC not denied for ' + email);
      await page.evaluate(() => handleLogout()); await page.waitForSelector('#tab-login', { state: 'visible' });
    }
  });

  await run('Sidebar: visible labels + tooltips, groups with separators; narrow screens back to icons; no horizontal scroll', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'owner@teroclass.test');
    await pickUnit(page, 'Sede Centro');
    const w = await page.evaluate(() => document.querySelector('.icon-sidebar').getBoundingClientRect().width);
    if (w < 80 || w > 90) throw new Error('sidebar width ' + w);
    const labels = await page.$$eval('.icon-sidebar .sib-btn', bs => bs.filter(b => b.offsetParent).map(b => b.querySelector('.sib-label').textContent));
    if (JSON.stringify(labels) !== '["Structure","Groups","Dashboard","Insights","Branding","AI Settings","Plan & usage","Institutions","Metrics","Platform"]') throw new Error('labels: ' + JSON.stringify(labels));
    const tips = await page.$$eval('.icon-sidebar .sib-btn', bs => bs.every(b => b.querySelector('.sib-tooltip')?.textContent === b.querySelector('.sib-label').textContent));
    if (!tips) throw new Error('tooltips missing');
    const seps = await page.$$eval('.sib-group', gs => gs.filter(g => g.offsetParent).map(g => getComputedStyle(g).borderTopWidth));
    if (JSON.stringify(seps) !== '["0px","1px"]') throw new Error('separators (P-20: no teaching group in admin mode): ' + JSON.stringify(seps));
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.sib-label')].filter(l => l.offsetParent && l.scrollWidth > l.clientWidth + 1).map(l => l.textContent));
    if (overflow.length) throw new Error('labels overflow: ' + overflow);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForTimeout(150);
    const w2 = await page.evaluate(() => document.querySelector('.icon-sidebar').getBoundingClientRect().width);
    if (w2 > 64) throw new Error('narrow sidebar width ' + w2);
    // P-28: a phone keeps a short name under each icon (not icons only), without overflowing the sidebar
    if (!(await page.isVisible('#nav-admin .sib-label'))) throw new Error('no labels on a phone');
    { const ov = await page.evaluate(() => [...document.querySelectorAll('.sib-label')].filter(l => l.offsetParent).map(l => l.getBoundingClientRect()).filter(b => b.right > document.querySelector('.icon-sidebar').getBoundingClientRect().right + 1).length); if (ov) throw new Error('labels outside the sidebar: ' + ov); }
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('horizontal scroll on a phone');
    if (!(await visible(page, '#isw-btn'))) throw new Error('switcher hidden on a phone');
    await openSwitcher(page);
    const box = await page.evaluate(() => { const r = document.getElementById('isw-menu').getBoundingClientRect(); return r.right <= window.innerWidth + 1; });
    if (!box) throw new Error('switcher menu off screen');
    await shot(page, 'mobile');
  });

  await run('AI requests carry class metadata (subjects, language, age band, level, bars) for Metrics', browser, async ({ page, st }) => {
    seed();
    await login(page, 'tc@c.com');
    await page.click('#nav-ai');
    await page.fill('#subjects-input', 'Math'); await page.press('#subjects-input', 'Enter');
    await page.selectOption('#st-language', 'Spanish'); await page.selectOption('#st-age', '14 years old');
    await page.fill('#prompt-input', 'Fractions'); await page.click('#btn-generate');
    await page.waitForSelector('#lp-doc');
    const main = st.gen.find(g => g.kind === 'generate');
    const m = main && main.meta;
    if (!m || JSON.stringify(m.subjects) !== '["Math"]' || m.language !== 'Spanish' || m.age_band !== 'teen' || m.level !== 'Intermediate' || typeof m.bars?.gamification !== 'number') throw new Error('meta: ' + JSON.stringify(m));
    if (JSON.stringify(main.meta).includes('Fractions')) throw new Error('prompt text sent as metadata');
    await page.waitForFunction(() => true);
  });

  await browser.close();
  console.log(failed ? `${failed} nav/insights scenario(s) FAILED` : 'All nav/insights scenarios passed');
  process.exitCode = failed ? 1 : 0;
})();
