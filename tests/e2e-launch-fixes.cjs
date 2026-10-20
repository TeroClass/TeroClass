// Regression tests for the pre-launch audit fixes (tech TC-xx + product P-xx), mock Supabase + mock AI; no real data.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-launch-fixes.cjs      (SHOTS=<dir> saves fix-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || '';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '→', String(e.message).split('\n')[0]); } };

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

  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL LAUNCH-FIX TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
