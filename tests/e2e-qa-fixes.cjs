// Regression tests for the QA findings (mock Supabase + mock AI; no real data).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-qa-fixes.cjs
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEACHER_DOC = "Week 1 - Class 1 - Test\nAttendance:\n\nToday's Objectives:\n- Practice greetings <img src=x onerror=window.__xss=1>\n- \"quote\" & <b>bold</b>\n\nMaterials:\n- Card 1: Hello → Hi\n- https://example.com/a?b=\"c\"";
let failed = 0;

// Admins have "Admin mode" | "Teacher mode": a sidebar button of the other mode is hidden, so switch first.
const TEACHER_NAV = ['#nav-home', '#nav-ai'];
// top bar institution switcher (super admin / admins): choose a unit by name
async function pickUnit(page, name) {
  await page.click('#isw-btn'); await page.waitForSelector('#isw-menu.open');
  await page.locator('#isw-list .isw-opt', { hasText: name }).first().click();
  await page.waitForFunction(n => document.getElementById('isw-label').textContent.includes(n), name);
}
async function nav(page, sel) {
  if (!(await page.isVisible(sel)) && (await page.isVisible('#mode-switch'))) await page.click(`#mode-switch [data-mode="${TEACHER_NAV.includes(sel) ? 'teacher' : 'admin'}"]`);
  await page.click(sel);
}
async function setup(browser, { ai } = {}) {
  M.resetDb();
  const ctx = await browser.newContext();
  const st = { main: 0, student: 0, summary: 0, errors: [], aiBodies: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); const s = JSON.stringify(b);
      const kind = s.includes('STUDENT HANDOUT') ? 'student' : s.includes("institution's CORE") ? 'summary' : 'main';
      st[kind]++; st.aiBodies.push(b);
      const resp = ai ? await ai(kind, b, st) : null;
      if (resp === 'abort') return r.abort('internetdisconnected');
      if (resp && resp.raw) return r.fulfill(resp.raw);
      if (resp && resp.delay) await sleep(resp.delay);
      const content = resp && 'content' in resp ? resp.content : (kind === 'student' ? "Test\nToday's goals:\n- I can greet\nActivity 1 — Hi\nAnswer: ____" : kind === 'summary' ? '- core' : TEACHER_DOC);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
    }
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  return { ctx, page, st };
}
async function register(page, email, path = '/') {
  await page.goto('http://teroclass.test' + path);
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.click('.auth-tab:nth-child(2)');
  await page.fill('#reg-name', 'Test User'); await page.fill('#reg-email', email); await page.fill('#reg-password', 'secreto123');
  await page.click('#tab-register .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const clearToast = page => page.evaluate(() => { document.getElementById('toast').textContent = ''; });
const waitToast = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout: 8000 });
async function generate(page, prompt = 'Greetings') {
  await nav(page, '#nav-ai'); await page.fill('#prompt-input', prompt); await page.click('#btn-generate');
  await page.waitForSelector('#lp-doc');
}
async function run(name, browser, opts, fn) {
  const env = await setup(browser, opts);
  try { await fn(env); if (env.st.errors.length) throw new Error(env.st.errors.join(' | ')); console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); }
  finally { await env.ctx.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('C1 exportPDF escapes content and uses a Blob URL; L4 pop-up blocked toast', browser, {}, async ({ page }) => {
    await register(page, 't1@x.com'); await generate(page);
    const html = await page.evaluate(async () => {
      let url = null; const orig = window.open;
      window.open = u => { url = u; return { closed: false }; };
      exportPDF(); window.open = orig;
      if (!url || !url.startsWith('blob:')) return 'NO_BLOB:' + url;
      return await (await fetch(url)).text();
    });
    if (html.startsWith('NO_BLOB')) throw new Error(html);
    if (/<img src=x/i.test(html) || /<b>bold<\/b>/.test(html)) throw new Error('raw HTML in print document');
    if (!html.includes('&lt;img src=x onerror=window.__xss=1&gt;')) throw new Error('content missing/unescaped');
    await page.evaluate(() => { window.open = () => null; exportPDF(); });
    await waitToast(page, /Allow pop-ups/);
    if (await page.evaluate(() => window.__xss)) throw new Error('xss ran');
  });

  await run('C2/L1 DB and user data never becomes markup (inst names/slugs/logo, subjects, class titles)', browser, {}, async ({ page }) => {
    M.seedInstitution({ name: '<img src=x onerror=window.__x1=1>', slug: "a');window.__x2=1;('", logo_url: 'javascript:window.__x3=1' });
    M.seedInstitution({ name: 'Logo" onerror="window.__x4=1', slug: 'b', logo_url: 'https://x.test/l.png" onerror="window.__x5=1' });
    await register(page, M.SUPERADMIN_EMAIL);
    await nav(page, '#nav-superadmin'); await page.waitForSelector('.inst-card');
    if (await page.$('[onclick*="copyLink"],[onclick*="loginAsAdmin"],[onclick*="editInstitution"],[onclick*="openClass"]')) throw new Error('inline handlers with data remain');
    await clearToast(page);
    await page.click('.inst-card [data-action="copy-link"]');
    await waitToast(page, /Link copied|Copy this link/);
    await nav(page, '#nav-ai'); await page.fill('#subjects-input', '<img src=x onerror=window.__x6=1>'); await page.press('#subjects-input', 'Enter');
    if (await page.$('.subjects-container img')) throw new Error('subject tag rendered HTML');
    const tag = await page.textContent('.subject-tag'); if (!tag.includes('<img')) throw new Error('subject text lost: ' + tag);
    await page.evaluate(() => { wlLogoData = 'javascript:alert(1)'; updatePreview(); });
    if (await page.$('#prev-logo-box img')) throw new Error('unsafe logo url rendered');
    await page.evaluate(() => { wlLogoData = 'data:image/png;base64,iVBORw0KGgo="onerror="window.__x7=1'; updatePreview(); });
    const src = await page.getAttribute('#prev-logo-box img', 'src'); if (!src || !src.includes('"onerror=')) throw new Error('logo attribute not escaped: ' + src);
    await nav(page, '#nav-superadmin');
    await page.click('.inst-card:nth-child(1) [data-action="view-inst"]');
    await page.waitForSelector('#panel-admin.active');
    await sleep(300);
    const r = await page.evaluate(() => [1, 2, 3, 4, 5, 6, 7].filter(i => window['__x' + i]));
    if (r.length) throw new Error('payload executed: ' + r.join(','));
  });

  await run('H1 skills drag gives the right order after many panel switches', browser, {}, async ({ page }) => {
    await register(page, 't2@x.com');
    for (let i = 0; i < 4; i++) { await nav(page, '#nav-home'); await nav(page, '#nav-ai'); }
    await page.dragAndDrop('.skill-drag-item[data-skill="Writing"]', '.skill-drag-item[data-skill="Speaking"]');
    const order = await page.evaluate(() => getSkillsPriority().join(','));
    if (order !== 'Writing,Speaking,Listening,Reading') throw new Error(order);
    const ranks = await page.evaluate(() => [...document.querySelectorAll('.skill-drag-rank')].map(x => x.textContent).join(''));
    if (ranks !== '1234') throw new Error('ranks ' + ranks);
  });

  let mode = 'ok';
  const aiModes = async (kind) => {
    if (kind !== 'main') return null;
    switch (mode) {
      case 'offline': return 'abort';
      case 'quota': return { raw: { status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Your institution reached its monthly AI limit.', code: 'quota' }) } };
      case '429': return { raw: { status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'slow down' }) } };
      case '504': return { raw: { status: 504, contentType: 'text/html', body: '<html>Gateway Timeout</html>' } };
      case '422': return { raw: { status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'The request was blocked by the content filter.' }) } };
      case 'html200': return { raw: { status: 200, contentType: 'text/html', body: '<html>oops</html>' } };
      case 'empty': return { content: '' };
      case '401': return { raw: { status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Please sign in again.' }) } };
      case 'slow': return { delay: 2500 };
      default: return null;
    }
  };
  await run('H6/M9/M10 callAIMessages error mapping, empty content, size pre-check, opts.full, 401 → login', browser, { ai: aiModes }, async ({ page }) => {
    await register(page, 't3@x.com');
    const call = () => page.evaluate(() => callAIMessages([{ role: 'user', content: 'hi' }]).then(c => 'OK:' + c, e => 'ERR:' + e.message));
    const expect = async (m, re) => { mode = m; const r = await call(); if (!re.test(r)) throw new Error(m + ' → ' + r); };
    await expect('offline', /ERR:No connection/);
    await expect('quota', /ERR:Your institution reached its monthly AI limit/);
    await expect('429', /ERR:Too many requests/);
    await expect('504', /ERR:The AI took too long/);
    await expect('422', /ERR:The request was blocked by the content filter/);
    await expect('html200', /ERR:Unexpected answer/);
    await expect('empty', /ERR:The AI returned an empty answer/);
    mode = 'ok';
    const full = await page.evaluate(() => callAIMessages([{ role: 'user', content: 'hi' }], .5, { full: true }));
    if (!full || full.finish_reason !== 'stop' || !full.content.includes('Week 1')) throw new Error('opts.full: ' + JSON.stringify(full));
    const big = await page.evaluate(() => callAIMessages([{ role: 'user', content: 'x'.repeat(80000) }]).then(() => 'OK', e => e.message));
    if (!/too long/.test(big)) throw new Error('size check: ' + big);
    const max = await page.evaluate(() => [document.getElementById('prompt-input').maxLength, document.getElementById('mp-prompt').maxLength]);
    if (max[0] !== 4000 || max[1] !== 8000) throw new Error('maxlength ' + max);
    // ES translation of a friendly error
    await page.click('.topbar-right .lang-toggle button[data-lang="es"]');
    mode = 'offline'; await clearToast(page); await generate(page).catch(() => {});
    await waitToast(page, /Sin conexión/);
    await page.evaluate(() => showToast('Error: No se puede quitar el último administrador de la institución', 'err'));
    await waitToast(page, /No se puede quitar al último admin/);
    await page.click('.topbar-right .lang-toggle button[data-lang="en"]');
    await page.evaluate(() => showToast('Error: No se puede quitar el último administrador de la institución', 'err'));
    await waitToast(page, /Error: You can't remove the institution's last admin\./);
    mode = '401'; await call();
    await page.waitForSelector('#tab-login', { state: 'visible' });
    const msg = await page.textContent('#auth-error'); if (!/session expired/.test(msg)) throw new Error('login msg: ' + msg);
    if (await page.isVisible('#screen-app')) throw new Error('app still visible');
    mode = 'ok';
    await page.fill('#login-email', 't3@x.com'); await page.fill('#login-password', 'secreto123'); await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#screen-app.active');
  });

  await run('M1 Enter spam starts one generation; M2 double save inserts once; L13 unsaved work tracked', browser, { ai: aiModes }, async ({ page, st }) => {
    await register(page, 't4@x.com');
    mode = 'slow';
    await nav(page, '#nav-ai'); await page.fill('#prompt-input', 'Greetings');
    await page.press('#prompt-input', 'Enter'); await page.press('#prompt-input', 'Enter'); await page.press('#prompt-input', 'Enter');
    if (!(await page.evaluate(() => hasUnsavedWork()))) throw new Error('generation not counted as unsaved work');
    await page.waitForSelector('#lp-doc', { timeout: 10000 });
    mode = 'ok';
    if (st.main !== 1) throw new Error('main AI calls: ' + st.main);
    if (!(await page.evaluate(() => hasUnsavedWork()))) throw new Error('fresh class not counted as unsaved');
    await page.evaluate(() => { savePlanning(); savePlanning(); });
    await page.waitForFunction(() => /Saved/.test(document.getElementById('toast').textContent));
    await sleep(300);
    if (calls.inserts.plannings !== 1 || db.plannings.length !== 1) throw new Error('inserts: ' + calls.inserts.plannings);
    if (await page.evaluate(() => hasUnsavedWork())) throw new Error('still dirty after save');
  });

  await run('M4 a running generation does not replace a class opened meanwhile; M5 params restored; M3 stale handout', browser, { ai: aiModes }, async ({ page, st }) => {
    await register(page, 't5@x.com');
    const owner = db.profiles[0].id;
    db.plannings.push({ id: 'p-old', owner_id: owner, institution_id: null, title: 'Saved fractions class', created_at: new Date().toISOString(),
      data: { params: { prompt: 'Fractions with pizza', language: 'Portuguese', level: 'Primary', age: '9 years old', groupSize: '18', duration: '60 min', subjects: ['Math', 'Art'], skills: ['Reading', 'Writing', 'Speaking', 'Listening'], gamification: 80 }, content: 'Saved fractions class\nAttendance:\n- slices', student: 'Fractions\n- ____' } });
    await page.evaluate(() => loadPlannings().then(renderClasses));
    mode = 'slow';
    await nav(page, '#nav-ai'); await page.fill('#prompt-input', 'Other topic'); await page.click('#btn-generate');
    await sleep(300);
    await nav(page, '#nav-home'); await page.click('.class-card[data-id="p-old"]');
    await page.waitForSelector('#lp-doc');
    await clearToast(page);
    await waitToast(page, /Previous generation discarded/);
    mode = 'ok';
    const doc = await page.textContent('#lp-doc'); if (!doc.includes('Saved fractions class')) throw new Error('opened class was replaced: ' + doc.slice(0, 60));
    const ui = await page.evaluate(() => ({ p: document.getElementById('prompt-input').value, l: document.getElementById('st-language').value, lv: document.getElementById('st-level').value, a: document.getElementById('st-age').value, d: document.getElementById('st-duration').value, g: document.getElementById('st-groupsize').value, s: getSubjects().join('|'), k: getSkillsPriority().join(','), gm: document.getElementById('sl-gamification').value, btn: document.getElementById('btn-generate').disabled }));
    const exp = { p: 'Fractions with pizza', l: 'Portuguese', lv: 'Primary', a: '9 years old', d: '60 min', g: '18', s: 'Math|Art', k: 'Reading,Writing,Speaking,Listening', gm: '80', btn: false };
    for (const k of Object.keys(exp)) if (ui[k] !== exp[k]) throw new Error(`param ${k}: ${ui[k]} != ${exp[k]}`);
    if (st.student !== 0) throw new Error('stale generation produced a handout');
    const studentShown = await page.evaluate(() => document.getElementById('lp-doc-student').innerText);
    if (!studentShown.includes('Fractions')) throw new Error('stored handout not shown');
  });

  await run('M3 student handout error for a previous class does not overwrite the current one', browser, { ai: async kind => kind === 'student' ? { delay: 1500, raw: { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) } } : null }, async ({ page }) => {
    await register(page, 't6@x.com');
    db.plannings.push({ id: 'p2', owner_id: db.profiles[0].id, title: 'Stored', created_at: new Date().toISOString(), data: { params: {}, content: 'Stored\n- x', student: 'Stored handout OK' } });
    await page.evaluate(() => loadPlannings().then(renderClasses));
    await generate(page); // starts handout (will fail after 1.5s)
    await nav(page, '#nav-home'); await page.click('.class-card[data-id="p2"]');
    await sleep(2200);
    const s = await page.evaluate(() => document.getElementById('lp-doc-student').innerText);
    if (!s.includes('Stored handout OK')) throw new Error('handout overwritten: ' + s);
  });

  await run('M7 loadScriptOnce retries after failure and times out', browser, {}, async ({ page }) => {
    await register(page, 't7@x.com');
    const r = await page.evaluate(async () => {
      const a = await loadScriptOnce('https://cdn.jsdelivr.net/npm/nope@1/x.js').then(() => 'ok', e => 'err');
      const tags = document.querySelectorAll('script[src="https://cdn.jsdelivr.net/npm/nope@1/x.js"]').length;
      const p1 = loadScriptOnce('https://cdn.jsdelivr.net/npm/nope@1/x.js'); const p2 = loadScriptOnce('https://cdn.jsdelivr.net/npm/nope@1/x.js');
      const same = p1 === p2; await p1.catch(() => {});
      const t = await loadScriptOnce('https://hang.test/x.js', 300).then(() => 'ok', e => 'timeout');
      return { a, tags, same, t };
    });
    if (r.a !== 'err' || r.tags !== 0 || !r.same || r.t !== 'timeout') throw new Error(JSON.stringify(r));
  });

  await run('M8 super admin context: Branding keeps viewed institution; New institution clears; AI Settings notice', browser, {}, async ({ page }) => {
    M.seedInstitution({ name: 'Colegio Uno', slug: 'uno', font: 'Georgia', open_registration: false });
    M.seedInstitution({ name: 'Colegio Dos', slug: 'dos' });
    await register(page, M.SUPERADMIN_EMAIL);
    // "All institutions": institution screens are not offered (and can't be opened by code either)
    if (await page.isVisible('#nav-master') || await page.isVisible('#nav-branding')) throw new Error('institution nav visible in All institutions');
    await page.evaluate(() => showPanel('master'));
    if (!(await page.isVisible('#panel-superadmin'))) throw new Error('institution screen opened without a unit');
    await page.click('.inst-card:nth-child(1) [data-action="view-inst"]');
    await page.waitForSelector('#panel-admin.active');
    if (!(await page.textContent('#isw-label')).includes('Colegio Uno')) throw new Error('View did not set the switcher');
    await nav(page, '#nav-superadmin'); // the list = All institutions
    if (!(await page.textContent('#isw-label')).includes('All institutions') || await page.isVisible('#nav-branding')) throw new Error('Institutions did not select All');
    await pickUnit(page, 'Colegio Uno');
    await nav(page, '#nav-branding');
    if (await page.inputValue('#wl-name') !== 'Colegio Uno') throw new Error('branding lost the viewed institution');
    if (!(await page.textContent('#branding-ctx-badge')).includes('Colegio Uno')) throw new Error('badge');
    if (await page.isChecked('#wl-open-reg')) throw new Error('open_registration not loaded');
    const font = await page.getAttribute('.font-option.selected', 'data-font'); if (font !== 'Georgia') throw new Error('font not highlighted: ' + font);
    await nav(page, '#nav-master');
    if (!(await page.textContent('#master-inst-badge')).includes('Colegio Uno')) throw new Error('AI settings badge');
    await nav(page, '#nav-superadmin'); await page.click('.inst-card:nth-child(2) [data-action="edit-inst"]');
    if (await page.inputValue('#wl-name') !== 'Colegio Dos' || !(await page.isChecked('#wl-open-reg'))) throw new Error('L2 fields not reset');
    if ((await page.getAttribute('.font-option.selected', 'data-font')) !== 'Inter') throw new Error('L2 font not reset');
    if (!(await page.textContent('#isw-label')).includes('Colegio Dos')) throw new Error('Edit did not set the switcher');
    await page.click('#btn-new-inst'); // "＋ New institution" opens the create modal (the switcher keeps Colegio Dos)
    await page.waitForSelector('#modal-create-inst.active');
    if (await page.evaluate(() => currentOrgId) === null) throw new Error('new institution cleared the selection');
    await page.fill('#new-inst-name', 'Escuela Ñandú Señor');
    const slug = await page.inputValue('#new-inst-slug'); if (slug !== 'escuela-nandu-senor') throw new Error('slug ' + slug);
    const link = await page.textContent('#new-inst-link'); if (!link.endsWith('/org/escuela-nandu-senor')) throw new Error('link ' + link);
    await page.fill('#new-inst-admin', 'dir@nandu.edu');
    await page.click('#modal-create-inst .btn-modal-save');
    await waitToast(page, /Institution "Escuela Ñandú Señor" created/);
    await page.click('#isw-btn');
    if (!(await page.textContent('#isw-list')).includes('Escuela Ñandú Señor')) throw new Error('new institution not in the switcher');
    await page.keyboard.press('Escape');
    const created = db.institutions.find(i => i.slug === 'escuela-nandu-senor'); if (!created) throw new Error('not created');
    if (calls.rpc.filter(c => c.fn === 'invite_member').length) throw new Error('L3 double invite');
  });

  await run('L9 create modal: slug transliteration + live link, color hex sync, group size clamp', browser, {}, async ({ page }) => {
    await register(page, M.SUPERADMIN_EMAIL);
    await page.evaluate(() => showCreateInstitution());
    await page.fill('#new-inst-name', 'Liceo Güemes Año');
    if (await page.inputValue('#new-inst-slug') !== 'liceo-guemes-ano') throw new Error(await page.inputValue('#new-inst-slug'));
    if (!(await page.textContent('#new-inst-link')).endsWith('/org/liceo-guemes-ano')) throw new Error('no live link');
    await page.fill('#new-inst-color-hex', '#112233');
    if (await page.inputValue('#new-inst-color') !== '#112233') throw new Error('hex→picker');
    await page.$eval('#new-inst-color', el => { el.value = '#445566'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    if (await page.inputValue('#new-inst-color-hex') !== '#445566') throw new Error('picker→hex');
    await page.fill('#new-inst-admin', 'a@b.com'); await page.click('#modal-create-inst .btn-modal-save');
    await page.waitForSelector('.inst-card');
    if (db.institutions[0].slug !== 'liceo-guemes-ano' || db.institutions[0].color !== '#445566') throw new Error(JSON.stringify(db.institutions[0]));
    await nav(page, '#nav-ai'); await page.fill('#st-groupsize', '0'); await page.dispatchEvent('#st-groupsize', 'change');
    if (await page.inputValue('#st-groupsize') !== '1') throw new Error('group size not clamped');
  });

  await run('L10 sign-up confirmation message in green; teaching language defaults to Spanish in ES', browser, {}, async ({ page }) => {
    await page.goto('http://teroclass.test/');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('tc_ui_lang', 'es'); });
    await page.reload();
    if (await page.inputValue('#st-language') !== 'Spanish') throw new Error('teach lang ' + await page.inputValue('#st-language'));
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'C'); await page.fill('#reg-email', 'confirm@x.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#auth-error.ok', { state: 'visible' });
    const t = await page.textContent('#auth-error'); if (!/Cuenta creada/.test(t)) throw new Error('not translated: ' + t);
    await page.evaluate(() => setUiLang('en'));
  });

  await run('M12/M13 i18n: DB names stay untranslated, statuses inside the handout are translated, dates follow UI locale, no "Vista previa" in EN', browser, { ai: async k => k === 'student' ? { delay: 4000 } : null }, async ({ page }) => {
    M.seedInstitution({ name: 'Home', slug: 'home' });
    await page.goto('http://teroclass.test/');
    await page.evaluate(() => localStorage.setItem('tc_ui_lang', 'en'));
    await register(page, 'teacher@x.com', '/org/home');
    if (await page.textContent('#topbar-brand-name') !== 'Home') throw new Error('brand');
    await nav(page, '#nav-ai'); await page.fill('#subjects-input', 'Speaking'); await page.press('#subjects-input', 'Enter');
    await page.fill('#prompt-input', 'x'); await page.click('#btn-generate'); await page.waitForSelector('#lp-doc');
    await page.click('.topbar-right .lang-toggle button[data-lang="es"]');
    if (await page.textContent('#topbar-brand-name') !== 'Home') throw new Error('brand name translated');
    if (!(await page.textContent('.subject-tag')).startsWith('Speaking')) throw new Error('subject translated');
    const ph = await page.evaluate(() => document.getElementById('lp-doc-student').innerText);
    if (!/Preparando el material del alumno/.test(ph)) throw new Error('handout status not translated: ' + ph);
    await page.click('#btn-save'); await page.waitForFunction(() => /Guardado/.test(document.getElementById('toast').textContent));
    await nav(page, '#nav-home');
    const date = await page.textContent('.class-card-date');
    const expected = await page.evaluate(() => new Date().toLocaleDateString('es-UY', { month: 'short', day: 'numeric', year: 'numeric' }));
    if (date !== expected) throw new Error('date ' + date + ' vs ' + expected);
    await page.click('.topbar-right .lang-toggle button[data-lang="en"]');
    if (/Vista previa/.test(await page.evaluate(() => document.body.innerText))) throw new Error('Vista previa in EN');
    if (await page.isVisible('.topbar-search') || await page.isVisible('.prompt-add-btn') || await page.isVisible('.video-play-btn')) throw new Error('dead UI still visible');
    if ((await page.$$('.soon-badge')).length !== 2) throw new Error('no coming soon badges');
  });

  await run('Branding preview Admin/Teacher toggle switches the preview', browser, {}, async ({ page }) => {
    M.seedInstitution({ name: 'Colegio Uno', slug: 'uno' });
    await register(page, M.SUPERADMIN_EMAIL);
    await pickUnit(page, 'Colegio Uno');
    await nav(page, '#nav-branding');
    const vis = () => page.isVisible('#preview-box .preview-metrics');
    if (!(await vis())) throw new Error('admin view missing metrics');
    await page.click('#prev-teacher'); if (await vis()) throw new Error('teacher view shows admin metrics');
    await page.click('#prev-admin'); if (!(await vis())) throw new Error('toggle back failed');
  });

  await run('L12 logo input reset after error', browser, {}, async ({ page }) => {
    M.seedInstitution({ name: 'Colegio Uno', slug: 'uno' });
    await register(page, M.SUPERADMIN_EMAIL);
    await pickUnit(page, 'Colegio Uno');
    await nav(page, '#nav-branding');
    await page.setInputFiles('#wl-logo-upload', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 10) });
    await waitToast(page, /under 2MB/);
    if (await page.evaluate(() => document.getElementById('wl-logo-upload').value)) throw new Error('input not reset');
  });

  await browser.close();
  console.log(failed ? `${failed} scenario(s) failed` : 'All QA-fix scenarios passed');
  if (failed) process.exitCode = 1;
})();
