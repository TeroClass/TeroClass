// Regression tests for the pre-launch audit fixes (tech TC-xx + product P-xx), mock Supabase + mock AI; no real data.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-launch-fixes.cjs      (SHOTS=<dir> saves fix-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;
M.calls = M.calls || require('./mock-supabase.cjs').calls;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || '';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '→', String(e.message).split('\n').slice(0, 3).join(' | ')); } };

async function setup(browser, { host = 'teroclass.test', viewport, ai, api } = {}) {
  M.resetDb();
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const st = { errors: [], aiBodies: [], api: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route(`http://${host}/**`, async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); st.aiBodies.push(b);
      const resp = ai ? await ai(b, st) : null;
      if (resp && resp.raw) return r.fulfill(resp.raw);
      const content = resp && 'content' in resp ? resp.content : "Clase de prueba\nObjetivos de hoy:\n- Saludar\nInicio (5 min)\n- Hola\nActividad 1 (10 min)\n- Practicar";
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
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
  return { ctx, page, st, base: `http://${host}` };
}
async function register(page, base, email, { name = 'Test User', path = '/' } = {}) {
  await page.goto(base + path);
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.click('.auth-tab:nth-child(2)');
  await page.fill('#reg-name', name); await page.fill('#reg-email', email); await page.fill('#reg-password', 'secreto123');
  await page.click('#tab-register .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const shot = async (page, n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/fix-${n}.png` }); };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ── P-01: a hidden toast never takes clicks (desktop: Generate; phone: the room controls) ──
  await step('P-01 hidden error toast lets clicks through (desktop)', async () => {
    const { ctx, page, st, base } = await setup(browser);
    await register(page, base, 'toast@t.com');
    await page.evaluate(() => showPanel('ai'));
    await page.fill('#prompt-input', '');
    await page.click('#btn-generate');                                   // validation toast
    await page.waitForSelector('#toast.show');
    const kind = await page.evaluate(() => document.getElementById('toast').className);
    if (!/warn/.test(kind)) throw new Error('a validation message must not show the tero (P-15): ' + kind);
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    await sleep(400);
    const hit = await page.evaluate(() => { const r = document.getElementById('btn-generate').getBoundingClientRect(); const t = document.getElementById('toast').getBoundingClientRect();
      const x = Math.min(r.right - 4, t.right - 4), y = Math.min(r.bottom - 4, t.bottom - 4);
      return { pe: getComputedStyle(document.getElementById('toast')).pointerEvents, el: document.elementFromPoint(x, y)?.closest('#toast') ? 'toast' : 'other' }; });
    if (hit.pe !== 'none' || hit.el === 'toast') throw new Error('hidden toast still catches clicks ' + JSON.stringify(hit));
    await page.fill('#prompt-input', 'Saludos');
    await page.click('#btn-generate');
    await page.waitForFunction(() => /Clase de prueba/.test(document.getElementById('lp-doc')?.innerText || ''), null, { timeout: 15000 });
    if (!st.aiBodies.length) throw new Error('Generate did not run');
    await ctx.close();
  });
  await step('P-01 hidden error toast lets clicks through (phone: room controls)', async () => {
    const { ctx, page, base } = await setup(browser, { viewport: { width: 375, height: 812 } });
    await register(page, base, 'toastm@t.com');
    await page.evaluate(() => showToast('Could not save', 'err'));
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    await sleep(400);
    const under = await page.evaluate(() => { const t = document.getElementById('toast').getBoundingClientRect(); const el = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2); return el && el.closest('#toast') ? 'toast' : 'other'; });
    if (under === 'toast') throw new Error('hidden toast covers the screen');
    await ctx.close();
  });

  // ── TC-04 / P-05: forgot password → e-mail; recovery link → new password; change password from the menu ──
  await step('TC-04 forgot password sends a reset e-mail (same answer whether the account exists or not)', async () => {
    const { ctx, page, base } = await setup(browser);
    await page.goto(base + '/'); await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.click('#auth-forgot-link');
    await page.waitForSelector('#tab-forgot', { state: 'visible' });
    await page.fill('#forgot-email', 'nadie@t.com'); await page.click('#btn-forgot');
    await page.waitForFunction(() => /If an account exists|Si existe una cuenta/.test(document.getElementById('auth-error').textContent));
    if (M.calls.recover.length !== 1 || M.calls.recover[0].email !== 'nadie@t.com') throw new Error('recover not called: ' + JSON.stringify(M.calls.recover));
    await shot(page, 'forgot-password');
    await ctx.close();
  });
  await step('TC-04 recovery link opens "choose a new password" and updates it (min 8)', async () => {
    const { ctx, page, base } = await setup(browser);
    const u = M.newUser('rec@t.com', { name: 'Rec Uno' });
    await page.goto(`${base}/?reset=1#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=recovery`);
    await page.waitForSelector('#modal-password.active', { timeout: 15000 });
    await page.fill('#pw-new', 'corta'); await page.fill('#pw-new2', 'corta'); await page.click('#pw-save');
    if (!/8/.test(await page.textContent('#pw-err'))) throw new Error('min 8 not enforced');
    await page.fill('#pw-new', 'nuevaClave123'); await page.fill('#pw-new2', 'nuevaClave123'); await page.click('#pw-save');
    await page.waitForSelector('#screen-app.active');
    if (!M.calls.passwords.some(x => x.user === u.id && x.password === 'nuevaClave123')) throw new Error('password not updated');
    if (/type=recovery|reset=1/.test(page.url())) throw new Error('recovery tokens left in the URL: ' + page.url());
    await ctx.close();
  });
  await step('P-05 change password from the account menu; register needs 8 characters; legal links (P-12)', async () => {
    const { ctx, page, base } = await setup(browser);
    await page.goto(base + '/'); await page.waitForSelector('#tab-login', { state: 'visible' });
    if (!(await page.$('#screen-auth a[href="/privacidad"]')) || !(await page.$('#screen-auth a[href="/terminos"]'))) throw new Error('legal links missing on login');
    await page.click('.auth-tab:nth-child(2)');
    if (!(await page.isVisible('#reg-legal a[href="/terminos"]'))) throw new Error('terms link missing on sign-up');
    await page.fill('#reg-name', 'Pw'); await page.fill('#reg-email', 'pw@t.com'); await page.fill('#reg-password', '1234567');
    await page.click('#tab-register .auth-btn');
    await page.waitForFunction(() => /8/.test(document.getElementById('auth-error').textContent));
    await page.fill('#reg-password', 'secreto123'); await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await page.click('#user-avatar'); await page.click('#um-password');
    await page.waitForSelector('#modal-password.active');
    await page.fill('#pw-new', 'otraClave456'); await page.fill('#pw-new2', 'otraClave456'); await page.click('#pw-save');
    await page.waitForFunction(() => /Password updated|Contraseña actualizada/.test(document.getElementById('toast').textContent));
    await page.click('#user-avatar');
    if (!(await page.$('#user-menu a[href="/privacidad"]'))) throw new Error('privacy link missing in the account menu');
    await shot(page, 'account-menu');
    await ctx.close();
  });

  // ── TC-15: a sign-out in another tab reloads this one (no stale data in memory) ──
  await step('TC-15 sign-out in another tab → this tab reloads to the login screen', async () => {
    const { ctx, page, base } = await setup(browser);
    await register(page, base, 'tabs@t.com');
    await page.evaluate(() => { window.__marker = 'old page'; });
    const p2 = await ctx.newPage(); await p2.goto(base + '/'); await p2.waitForSelector('#screen-app.active');
    await p2.evaluate(() => handleLogout());
    await page.waitForFunction(() => !window.__marker && document.getElementById('tab-login') && getComputedStyle(document.getElementById('screen-auth')).display !== 'none', null, { timeout: 15000 });
    if (await page.isVisible('#screen-app.active')) throw new Error('app still visible');
    await ctx.close();
  });

  // ── TC-07 / P-03 / P-04: invite an existing account → pending until it accepts; honest result; list, cancel, resend ──
  await step('TC-07 / P-03 / P-04 invitations: existing student is not moved; link to share; list with cancel / resend; accept in the app', async () => {
    const { ctx, page, base } = await setup(browser);
    const inst = M.seedInstitution({ name: 'Colegio Lanzamiento', slug: 'lanza', open_registration: false });
    db.invitations.push({ id: M.uid(), email: 'adm@lanza.uy', institution_id: inst.id, role: 'org_admin', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString() });
    M.newUser('alumna@gmail.com', { via: 'student_link', name: 'Alumna' });
    await register(page, base, 'adm@lanza.uy', { name: 'Ana Admin' });
    await page.evaluate(() => setAppMode('admin'));
    await page.evaluate(() => showPanel('admin'));
    await page.waitForSelector('#members-card .card-invite', { state: 'visible' });
    await page.waitForSelector('#access-card', { state: 'visible' });
    if (await page.isChecked('#access-open-reg')) throw new Error('join by link must start off');
    await page.click('#members-card .card-invite');
    await page.fill('#invite-email', 'alumna@gmail.com'); await page.selectOption('#invite-role', 'org_admin');
    await page.click('#btn-invite-send');
    await page.waitForSelector('#invite-result', { state: 'visible' });
    if (!/already has a TeroClass account/.test(await page.textContent('#invite-res-sub'))) throw new Error('result: ' + await page.textContent('#invite-res-sub'));
    if (db.profiles.find(p => p.email === 'alumna@gmail.com').role !== 'student') throw new Error('student was moved without accepting');
    await shot(page, 'invite-result');
    await page.click('#invite-another');
    await page.fill('#invite-email', 'nuevo@lanza.uy'); await page.click('#btn-invite-send');
    await page.waitForSelector('#invite-result', { state: 'visible' });
    if (!/No email is sent/.test(await page.textContent('#invite-res-sub'))) throw new Error('an e-mail was promised without a provider');
    if (!(await page.inputValue('#invite-res-link')).endsWith('/org/lanza?invite=nuevo%40lanza.uy')) throw new Error('link: ' + await page.inputValue('#invite-res-link'));
    await page.click('#invite-result .btn-modal-save');
    await page.waitForFunction(() => { const t = document.getElementById('invites-table-body').textContent; return /alumna@gmail\.com/.test(t) && /nuevo@lanza\.uy/.test(t); });
    await shot(page, 'invitations-list');
    const row = page.locator('#invites-table-body tr', { hasText: 'nuevo@lanza.uy' });
    await row.locator('[data-inv-act="cancel"]').click();
    await page.waitForSelector('#modal-danger.active'); await page.click('#dg-ok');
    await page.waitForFunction(() => /Cancelled|Cancelada/.test(document.querySelector('#invites-table-body').textContent));
    if (!db.invitations.find(i => i.email === 'nuevo@lanza.uy').cancelled_at) throw new Error('not cancelled');
    await page.locator('#invites-table-body tr', { hasText: 'nuevo@lanza.uy' }).locator('[data-inv-act="resend"]').click();
    await page.waitForSelector('#invite-result', { state: 'visible' });
    await page.click('#invite-result .btn-modal-save');
    await page.waitForFunction(() => /nuevo@lanza\.uy[\s\S]*(Pending|Pendiente)/.test(document.querySelector('#invites-table-body').textContent));
    // the student accepts in the app
    const c2 = await browser.newContext(); await c2.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: SB_JS }));
    await c2.route(SB + '/**', handleSupabase); await c2.route(`${base}/**`, r => r.fulfill({ contentType: 'text/html', body: HTML }));
    const p2 = await c2.newPage();
    await p2.goto(base + '/'); await p2.waitForSelector('#tab-login', { state: 'visible' });
    await p2.fill('#login-email', 'alumna@gmail.com'); await p2.fill('#login-password', 'secreto123'); await p2.click('#tab-login .auth-btn');
    await p2.waitForSelector('#modal-my-inv.active', { timeout: 15000 });
    await shot(p2, 'my-invitation');
    await p2.click('#modal-my-inv [data-inv-accept]');
    await p2.waitForSelector('#nav-admin', { state: 'visible', timeout: 15000 });
    const pr = db.profiles.find(p => p.email === 'alumna@gmail.com');
    if (pr.role !== 'org_admin' || pr.institution_id !== inst.id) throw new Error('not applied after accepting: ' + pr.role);
    await c2.close(); await ctx.close();
  });

  // ── P-21: "Test version" badge only outside production ──
  await step('P-21 staging badge: shown on a preview host, hidden on teroclass.com', async () => {
    let { ctx, page, base } = await setup(browser);
    await page.goto(base + '/'); await page.waitForSelector('#tab-login', { state: 'visible' });
    if (!(await page.isVisible('#env-badge'))) throw new Error('badge hidden on a preview host');
    const pe = await page.evaluate(() => getComputedStyle(document.getElementById('env-badge')).pointerEvents);
    if (pe !== 'none') throw new Error('badge must never take clicks');
    await shot(page, 'staging-badge');
    await ctx.close();
    ({ ctx, page, base } = await setup(browser, { host: 'teroclass.com' }));
    await page.goto(base + '/'); await page.waitForSelector('#tab-login', { state: 'visible' });
    if (await page.isVisible('#env-badge')) throw new Error('badge visible in production');
    await ctx.close();
  });

  // ── TC-18: Cloudflare Turnstile only when a site key is configured ──
  await step('TC-18 CAPTCHA off without a site key; with a key the token goes to Supabase Auth', async () => {
    let { ctx, page, base } = await setup(browser);
    await register(page, base, 'nocap@t.com');
    if (await page.isVisible('#auth-captcha')) throw new Error('captcha visible without a key');
    if ((M.calls.captcha || []).length) throw new Error('captcha token sent without a key');
    await ctx.close();
    ({ ctx, page, base } = await setup(browser, { api: u => u.pathname === '/api/config' ? { contentType: 'application/json', body: JSON.stringify({ turnstileSiteKey: '0x4AAAAAAAtestkey', email: false, env: 'preview' }) } : null }));
    await ctx.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript', body: 'window.turnstile={render:function(el,o){el.textContent="captcha ok";setTimeout(function(){o.callback("cap-token-1")},50);return 7},reset:function(){}};' }));
    await page.goto(base + '/'); await page.waitForSelector('#auth-captcha', { state: 'visible' });
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Cap'); await page.fill('#reg-email', 'cap@t.com'); await page.fill('#reg-password', 'secreto123');
    await page.waitForTimeout(200);
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    if (!M.calls.captcha.some(c => c.token === 'cap-token-1' && /signup/.test(c.path))) throw new Error('captcha token not sent: ' + JSON.stringify(M.calls.captcha));
    await ctx.close();
  });

  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL LAUNCH-FIX TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
