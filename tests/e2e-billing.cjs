// Plan & usage: seats + monthly AI tokens + token packs (mock Supabase + mock /api/generate and /api/billing/status).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-billing.cjs
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, bill, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const XSS = '<img src=x onerror="window.__xss=1">';

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const st = { errors: [], gen: [], ai: opts.ai || (() => ({ status: 200, body: { choices: [{ message: { content: "Week 1 - Class 1 - Test\nToday's Objectives:\n- Practice" }, finish_reason: 'stop' }] } })), status: opts.status || null, statusCalls: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); st.gen.push(b);
      const a = st.ai(b); return r.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (u.pathname === '/api/billing/status') {
      st.statusCalls.push(r.request().headers().authorization || '');
      return st.status ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(st.status) }) : r.fulfill({ status: 404, body: 'not found' });
    }
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage(); page.__st = st;
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); }); // no confirm()/alert()
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
async function login(page, email, path = '/', lang = 'en') {
  await page.goto('http://teroclass.test' + path);
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const text = (page, sel) => page.textContent(sel);
// text nodes in a subtree that are not Spanish dictionary values (same check as the live-class suite)
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || /^\(UTC\)$/.test(t)) continue;
    if (vals.has(t)) continue;
    if (/^\d+% de la asignación mensual$/.test(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);

// Madre (root, plan 10 seats / 250k per month) › Sede 1. Admins at both levels, teachers, AI usage this month.
function seed({ used = 210000, monthly = 250000, extra = 0, seats = 10 } = {}) {
  const madre = M.seedInstitution({ name: 'Colegio <b>Madre</b>', slug: 'madre' });
  const sede = M.seedInstitution({ name: 'Sede Norte', slug: 'sede', color: null, bg_color: null, font: null, parent_id: madre.id });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, role, inst, name) => { const u = M.newUser(email, { name: name || email.split('@')[0] }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const owner = M.newUser('owner@teroclass.test', { name: 'Owner' });
  const madm = mk('madm@h.com', 'org_admin', madre.id, 'Marta Admin'), sadm = mk('sadm@h.com', 'org_admin', sede.id, 'Sergio Sede');
  const t1 = mk('t1@h.com', 'teacher', madre.id, 'Tina ' + XSS), t2 = mk('t2@h.com', 'teacher', sede.id, 'Tomás Norte');
  const oadm = mk('oadm@o.com', 'org_admin', otra.id, 'Otro Admin');
  bill.accounts[madre.id] = { seats, monthly_tokens: monthly, extra };
  bill.usage[madre.id] = used;
  bill.log.push({ root_id: madre.id, inst_id: madre.id, user_id: t1.id, total: 150000 }, { root_id: madre.id, inst_id: sede.id, user_id: t2.id, total: 60000 });
  return { madre, sede, otra, owner, madm, sadm, t1, t2, oadm };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('Admin: Plan & usage — seats, monthly tokens, ≈ classes, extra, by unit / teacher, warning at ≥80%', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'madm@h.com');
    await page.waitForSelector('#nav-billing', { state: 'visible' });
    await page.click('#nav-billing');
    await page.waitForSelector('#panel-billing.active #bl-seats');
    if ((await text(page, '#bl-seats')).trim() !== '4 / 10') throw new Error('seats: ' + await text(page, '#bl-seats'));
    if ((await text(page, '#bl-used')).trim() !== '210k / 250k') throw new Error('tokens: ' + await text(page, '#bl-used'));
    if (!/84%/.test(await text(page, '.bl-metrics'))) throw new Error('percent');
    if ((await text(page, '#bl-classes')).trim() !== '≈ 1') throw new Error('classes: ' + await text(page, '#bl-classes'));
    if (!/approx/i.test(await text(page, '.bl-metrics')) || !/23,000 tokens per class/.test(await text(page, '.bl-metrics'))) throw new Error('estimate not labelled');
    if ((await text(page, '#bl-extra')).trim() !== '0') throw new Error('extra');
    if (!(await page.isVisible('#billing-root .bl-banner.warn')) || await page.$('#billing-root .bl-banner.block')) throw new Error('warning banner at ≥80%');
    if (!/Colegio <b>Madre<\/b>/.test(await text(page, '.bl-account'))) throw new Error('account name (escaped)');
    if (!/Colegio <b>Madre<\/b>/.test(await text(page, '#bl-units')) || !/Sede Norte/.test(await text(page, '#bl-units'))) throw new Error('by unit');
    const teachers = await text(page, '#bl-teachers');
    if (!teachers.includes('Tina ' + XSS) || !/Tomás Norte/.test(teachers) || !/150k/.test(teachers)) throw new Error('by teacher: ' + teachers);
    if (await page.$('#bl-teachers img')) throw new Error('teacher name not escaped');
    if (!/Buy 2M tokens for USD 11\.99/.test((await text(page, '[data-bl="buy"]')).replace(/\s+/g, ' '))) throw new Error('buy label: ' + await text(page, '[data-bl="buy"]'));
    if (!/We'll contact you to complete the payment; tokens are added once confirmed\./.test(await text(page, '.bl-buy-card'))) throw new Error('explanation');
    if (!/No purchase requests yet/.test(await text(page, '#bl-requests'))) throw new Error('empty history');
    if (await page.isVisible('#ctx-bar') && !/Colegio/.test(await text(page, '#ctx-bar'))) throw new Error('context bar');
  });

  await run('Admin: buy a pack → two clicks → pending request (once) → history; second request refused while pending', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'madm@h.com');
    await page.click('#nav-billing');
    await page.waitForSelector('[data-bl="buy"]');
    await page.click('[data-bl="buy"]');
    if (!/Click again to send the request/.test(await text(page, '[data-bl="buy"]'))) throw new Error('no confirmation step');
    if (bill.requests.length) throw new Error('request created on the first click');
    await page.click('[data-bl="buy"]');
    await waitToast(page, /Request sent ✓ We'll contact you/);
    await page.waitForSelector('.bl-pending');
    if (bill.requests.length !== 1 || bill.requests[0].status !== 'pending' || bill.requests[0].pack_tokens !== 2000000) throw new Error('request: ' + JSON.stringify(bill.requests));
    if (calls.rpc.filter(c => c.fn === 'request_token_pack').length !== 1) throw new Error('rpc count');
    if (await page.$('[data-bl="buy"]')) throw new Error('buy button still shown while pending');
    if (!/Pending/.test(await text(page, '#bl-requests')) || !/USD 11\.99/.test(await text(page, '#bl-requests'))) throw new Error('history');
    // stale screen: the server refuses a second pending request with a clear message
    await page.evaluate(() => { BL.summary.pending = null; document.getElementById('billing-root').innerHTML = billingHtml(BL.summary); });
    await page.click('[data-bl="buy"]'); await page.click('[data-bl="buy"]');
    await waitToast(page, /already a pending purchase request/);
    if (bill.requests.length !== 1) throw new Error('duplicate request');
  });

  await run('Admin: blocking state at 100% (no extra) → red banner + buy button; extra balance unblocks', browser, async ({ page }) => {
    seed({ used: 250000, monthly: 250000 });
    await login(page, 'madm@h.com');
    await page.click('#nav-billing');
    await page.waitForSelector('.bl-banner.block');
    if (!/used all its AI tokens for this month/.test(await text(page, '.bl-banner.block'))) throw new Error('block text');
    if (!(await page.$('.bl-buy-card.blocked [data-bl="buy"]'))) throw new Error('no buy button in blocked state');
    if ((await text(page, '#bl-classes')).trim() !== '≈ 0') throw new Error('classes');
    bill.accounts[Object.keys(bill.accounts)[0]].extra = 2000000;
    await page.click('#nav-structure'); await page.click('#nav-billing');
    await page.waitForFunction(() => document.getElementById('bl-extra')?.textContent.trim() === '2M');
    if (await page.$('#billing-root .bl-banner')) throw new Error('banner with 2M extra left');
    if ((await text(page, '#bl-classes')).trim() !== '≈ 86') throw new Error('classes with extra: ' + await text(page, '#bl-classes'));
  });

  await run('Sub-unit admin: sees the account (read-only, own unit detail), cannot buy; teacher has no Plan screen', browser, async ({ page }) => {
    seed();
    await login(page, 'sadm@h.com');
    await page.click('#nav-billing');
    await page.waitForSelector('#bl-seats');
    if (await page.$('[data-bl="buy"]')) throw new Error('sub-unit admin sees buy button');
    if (!/Only admins of the main institution can buy tokens/.test(await text(page, '.bl-buy-card'))) throw new Error('explanation');
    const units = await text(page, '#bl-units'); if (/Madre/.test(units) || !/Sede Norte/.test(units)) throw new Error('unit detail scope: ' + units);
    if (/Tina/.test(await text(page, '#bl-teachers'))) throw new Error('sees teachers of another unit');
    await page.click('[data-h="go-structure"], #nav-structure').catch(() => {});
    await page.click('.user-menu-btn', { force: true }).catch(() => {});
  });

  await run('Teacher: generation blocked by budget → friendly modal (contact admin), no buy button, no error toast', browser, async ({ page, st }) => {
    seed();
    st.ai = () => ({ status: 402, body: { code: 'budget', scope: 'institution', is_admin: false, can_buy: false, error: 'Your institution has reached its monthly AI limit. Tell your admin so they can add more tokens.' } });
    await login(page, 't2@h.com');
    if (await page.isVisible('#nav-billing')) throw new Error('teacher sees Plan & usage');
    await page.click('#nav-ai');
    await page.fill('#prompt-input', 'Fractions');
    await page.click('#btn-generate');
    await page.waitForSelector('#modal-budget.active');
    if (!/Tell your admin/.test(await text(page, '#budget-msg'))) throw new Error('message');
    if (await page.$('#modal-budget [data-bl="buy-now"]') || await page.$('#modal-budget [data-bl="open-billing"]')) throw new Error('teacher gets admin actions');
    if (/Error/.test(await text(page, '#toast'))) throw new Error('error toast as well');
    if (st.gen[0].kind !== 'generate') throw new Error('kind not sent');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#modal-budget', { state: 'hidden' });
    if (!(await page.isVisible('#ai-empty'))) throw new Error('empty state not restored');
    if (await page.isDisabled('#btn-generate')) throw new Error('generate button stuck');
  });

  await run('Admin: generation blocked → modal with "Buy 2M tokens for USD 11.99" → creates the request', browser, async ({ page, st }) => {
    seed({ used: 250000, monthly: 250000 });
    st.ai = () => ({ status: 402, body: { code: 'budget', scope: 'institution', is_admin: true, can_buy: true, error: 'Your institution has used all its AI tokens for this month. Buy a token pack to keep generating.' } });
    await login(page, 'madm@h.com');
    await page.click('[data-mode="teacher"]');
    await page.click('#nav-ai');
    await page.fill('#prompt-input', 'Fractions');
    await page.click('#btn-generate');
    await page.waitForSelector('#modal-budget.active [data-bl="buy-now"]');
    if (!/Buy a token pack/.test(await text(page, '#budget-msg'))) throw new Error('message');
    if (!/Buy 2M tokens for USD 11\.99/.test((await text(page, '[data-bl="buy-now"]')).replace(/\s+/g, ' '))) throw new Error('label');
    if (!(await page.isVisible('#budget-explain'))) throw new Error('explanation');
    await page.click('[data-bl="buy-now"]');
    await waitToast(page, /Request sent/);
    await page.waitForSelector('#modal-budget', { state: 'hidden' });
    if (bill.requests.length !== 1) throw new Error('no request');
    // with a pending request the modal says so instead of offering to buy again
    await page.click('#btn-generate');
    await page.waitForSelector('#modal-budget.active .bl-modal-hint');
    if (await page.$('#modal-budget [data-bl="buy-now"]')) throw new Error('buy offered while pending');
    await page.click('#modal-budget [data-bl="open-billing"]');
    await page.waitForSelector('#panel-billing.active .bl-pending');
  });

  await run('Warning after a successful generation (≥80%) shows once; kinds sent per call', browser, async ({ page, st }) => {
    seed();
    st.ai = b => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify(b).includes('STUDENT HANDOUT') ? "Test\nToday's goals:\n- I can" : "Week 1 - Class 1 - Test\nToday's Objectives:\n- Practice" }, finish_reason: 'stop' }], budget: { scope: 'institution', remaining: 20000, warn: true } } });
    await login(page, 't1@h.com');
    await page.click('#nav-ai');
    await page.fill('#prompt-input', 'Fractions');
    await page.click('#btn-generate');
    await page.waitForSelector('#lp-doc');
    await waitToast(page, /Heads up: your institution is close to its monthly AI limit/, 9000);
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.click('#btn-generate');
    await page.waitForTimeout(4500);
    if (/Heads up/.test(await text(page, '#toast'))) throw new Error('warned twice');
    if (!st.gen.every(g => ['generate', 'student', 'verify', 'continue'].includes(g.kind))) throw new Error('kinds: ' + st.gen.map(g => g.kind));
  });

  await run('Super admin Platform: banner, settings, plan editor, approve/reject (two clicks, note), all escaped', browser, async ({ page, st }) => {
    const t = seed();
    st.status = { billing_configured: false, billing_ok: null };
    bill.requests.push({ id: 'req-1', root_id: t.madre.id, root_name: t.madre.name, requested_by: t.madm.id, pack_tokens: 2000000, price: 11.99, currency: 'USD', status: 'pending', note: '', created_at: new Date().toISOString() });
    bill.requests.push({ id: 'req-2', root_id: t.otra.id, root_name: t.otra.name, requested_by: t.oadm.id, pack_tokens: 2000000, price: 11.99, currency: 'USD', status: 'pending', note: '', created_at: new Date().toISOString() });
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-billing-banner', { state: 'visible' });
    if (!/Token limits are not active: add SUPABASE_SERVICE_ROLE_KEY in Vercel/.test((await text(page, '#pf-billing-banner')).replace(/\s+/g, ' '))) throw new Error('banner: ' + await text(page, '#pf-billing-banner'));
    if (!st.statusCalls[0]?.startsWith('Bearer tok-')) throw new Error('status without session');
    await page.waitForSelector('#pf-requests tr[data-req]');
    if (await page.locator('#pf-requests tr[data-req]').count() !== 2) throw new Error('pending rows');
    if (!/Colegio <b>Madre<\/b>/.test(await text(page, '#pf-requests')) || await page.$('#pf-requests b')) throw new Error('names escaped');
    // approve: two clicks
    const row = page.locator('#pf-requests tr[data-req="req-1"]');
    await row.locator('.bl-note').fill('Transfer ' + XSS);
    await row.locator('[data-bl="pf-approve"]').click();
    if (!/Click again to approve/.test(await row.locator('[data-bl="pf-approve"]').textContent())) throw new Error('no confirm');
    if (bill.requests[0].status !== 'pending') throw new Error('approved on one click');
    await row.locator('[data-bl="pf-approve"]').click();
    await waitToast(page, /Approved ✓/);
    if (bill.requests[0].status !== 'approved' || bill.accounts[t.madre.id].extra !== 2000000) throw new Error('not approved / balance');
    await page.waitForSelector('#pf-requests-done');
    if (!(await text(page, '#pf-requests-done')).includes('Transfer ' + XSS)) throw new Error('note not shown escaped');
    await page.waitForFunction(() => /2M/.test(document.querySelector('#pf-plans tr[data-root]')?.textContent || ''));
    // reject
    const r2 = page.locator('#pf-requests tr[data-req="req-2"]');
    await r2.locator('[data-bl="pf-reject"]').click(); await r2.locator('[data-bl="pf-reject"]').click();
    await waitToast(page, /Request rejected/);
    if (bill.requests[1].status !== 'rejected' || (bill.accounts[t.otra.id]?.extra || 0) !== 0) throw new Error('reject');
    await page.waitForFunction(() => /No pending requests/.test(document.getElementById('pf-requests').textContent));
    // settings
    await page.fill('#pfs-pack', '3000000'); await page.fill('#pfs-price', '15'); await page.fill('#pfs-currency', 'eur');
    if (!/Buy 3M tokens for EUR 15\.00/.test((await text(page, '#pfs-preview')).replace(/\s+/g, ' '))) throw new Error('preview: ' + await text(page, '#pfs-preview'));
    await page.fill('#pfs-personal', '300000'); await page.fill('#pfs-seats', '12'); await page.fill('#pfs-monthly', '4000000');
    await page.click('[data-bl="pf-save-settings"]');
    await waitToast(page, /Settings saved/);
    const c = calls.rpc.find(x => x.fn === 'update_platform_settings').body;
    if (c.p_pack_tokens !== 3000000 || c.p_pack_price !== 15 || c.p_currency !== 'EUR' || c.p_personal_monthly_tokens !== 300000 || c.p_default_seats !== 12 || c.p_default_monthly_tokens !== 4000000) throw new Error('settings payload ' + JSON.stringify(c));
    await page.fill('#pfs-seats', '1.5'); await page.click('[data-bl="pf-save-settings"]');
    await waitToast(page, /whole numbers/);
    await page.fill('#pfs-seats', '12');
    // plan editor
    const pr = page.locator('#pf-plans tr', { hasText: 'Otra Escuela' });
    await pr.locator('[data-f="seats"]').fill('25'); await pr.locator('[data-f="monthly"]').fill('5000000');
    await pr.locator('[data-bl="pf-save-plan"]').click();
    await waitToast(page, /Plan saved/);
    if (bill.accounts[t.otra.id].seats !== 25 || bill.accounts[t.otra.id].monthly_tokens !== 5000000) throw new Error('plan not saved');
    if (await page.$('#pf-plans tr:has-text("Sede Norte")')) throw new Error('sub-units listed as accounts');
  });

  await run('Platform banner: hidden when configured, warning when the key is rejected', browser, async ({ page, st }) => {
    seed();
    st.status = { billing_configured: true, billing_ok: true };
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-settings-card');
    if (await page.isVisible('#pf-billing-banner')) throw new Error('banner shown while configured');
    st.status = { billing_configured: true, billing_ok: false };
    await page.click('#nav-structure'); await page.click('#nav-platform');
    await page.waitForSelector('#pf-billing-banner.warn', { state: 'visible' });
    if (!/not working/.test(await text(page, '#pf-billing-banner'))) throw new Error('warn banner');
  });

  await run('Seats: invite refused when the plan is full (EN + ES message); /org/<slug> registration refused', browser, async ({ page }) => {
    const t = seed({ seats: 4 });
    await login(page, 'madm@h.com');
    await page.click('[data-h="invite"][data-id="' + t.sede.id + '"]');
    await page.fill('#invite-email', 'nueva@h.com');
    await page.click('#modal-invite .btn-modal-save');
    await waitToast(page, /No seats left in the institution's plan \(4 of 4 in use\)\. Ask the TeroClass team to add seats\./);
    if (db.invitations.some(i => i.email === 'nueva@h.com')) throw new Error('invitation saved');
    await page.evaluate(() => setUiLang('es')); // the open modal covers the topbar toggle
    await page.click('#modal-invite .btn-modal-save');
    await waitToast(page, /No quedan asientos en el plan de la institución \(4 de 4 en uso\)/);
    await page.keyboard.press('Escape');
    // registration page of a full institution
    await page.evaluate(() => sb.auth.signOut());
    await page.waitForSelector('#tab-login', { state: 'visible' });
    const p2 = page;
    await p2.goto('http://teroclass.test/org/sede');
    await p2.waitForSelector('#tab-login', { state: 'visible' });
    await p2.evaluate(() => setUiLang('en'));
    await p2.click('.auth-tab:nth-child(2)');
    await p2.waitForSelector('#reg-seats-full', { state: 'visible' });
    await p2.fill('#reg-name', 'Late'); await p2.fill('#reg-email', 'late@h.com'); await p2.fill('#reg-password', 'secreto123');
    await p2.click('#tab-register .auth-btn');
    await p2.waitForFunction(() => /no seats available/.test(document.getElementById('auth-error').textContent));
    if (Object.values(db.users).some(u => u.email === 'late@h.com')) throw new Error('account created');
    // an institution with free seats shows no notice
    await p2.goto('http://teroclass.test/org/otra');
    await p2.waitForSelector('#tab-login', { state: 'visible' });
    await p2.waitForTimeout(400);
    await p2.click('.auth-tab:nth-child(2)');
    if (await p2.isVisible('#reg-seats-full')) throw new Error('notice on an institution with seats');
  });

  await run('Spanish UI: Plan y consumo, modal and Platform cards fully translated', browser, async ({ page, st }) => {
    const t = seed();
    st.status = { billing_configured: false, billing_ok: null };
    bill.requests.push({ id: 'req-1', root_id: t.madre.id, root_name: t.madre.name, requested_by: t.madm.id, pack_tokens: 2000000, price: 11.99, currency: 'USD', status: 'rejected', note: 'sin pago', created_at: new Date().toISOString() });
    await login(page, 'madm@h.com', '/', 'es');
    if ((await text(page, '#nav-billing .sib-tooltip')) !== 'Plan y consumo') throw new Error('tooltip');
    await page.click('#nav-billing');
    await page.waitForSelector('#bl-seats');
    if (!/Comprar 2M tokens por USD 11\.99/.test((await text(page, '[data-bl="buy"]')).replace(/\s+/g, ' '))) throw new Error('buy ES');
    let u = await untranslated(page, '#panel-billing'); if (u.length) throw new Error('billing sin traducir: ' + JSON.stringify(u));
    await page.click('[data-bl="buy"]');
    u = await untranslated(page, '#panel-billing'); if (u.length) throw new Error('confirm sin traducir: ' + JSON.stringify(u));
    await page.evaluate(() => showBudgetModal({ code: 'budget', is_admin: true, can_buy: true, error: 'Your institution has used all its AI tokens for this month. Buy a token pack to keep generating.' }));
    await page.waitForSelector('#modal-budget.active [data-bl="buy-now"]');
    u = await untranslated(page, '#modal-budget'); if (u.length) throw new Error('modal sin traducir: ' + JSON.stringify(u));
    await page.keyboard.press('Escape');
    // super admin
    await page.click('.user-avatar-sm#user-avatar'); await page.click('.user-menu-btn');
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.fill('#login-email', 'owner@teroclass.test'); await page.fill('#login-password', 'secreto123');
    await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-settings-card');
    await page.waitForSelector('#pf-billing-banner', { state: 'visible' });
    for (const sel of ['#pf-billing-banner', '#pf-requests-card', '#pf-settings-card', '#pf-plans-card']) { u = await untranslated(page, sel); if (u.length) throw new Error(sel + ' sin traducir: ' + JSON.stringify(u)); }
  });

  console.log(failed ? `${failed} billing scenario(s) FAILED` : 'All billing scenarios passed');
  process.exitCode = failed ? 1 : 0;
  await browser.close();
})();
