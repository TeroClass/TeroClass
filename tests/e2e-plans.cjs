// Plans, free trial, "Hablar con ventas", Plan & usage in classes, plan status, compare models (2026-10-21).
// Mock Supabase (tests/mock-supabase.cjs + tests/mock-plans.cjs) and mock /api/generate + /api/notify/lead (as the server answers).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-plans.cjs   (SHOTS=<dir> saves pay-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const M = require('./mock-supabase.cjs');
const { db, bill, handleSupabase, HTML, SB_JS, SB } = M;

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || '';
let failed = 0;
const XSS = '<img src=x onerror="window.__xss=1">';
const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `pay-${name}.png`), ...opts }); };

// content of the mock AI: a marker per model so "which model answered" is visible on screen
const AI = (model, kind, body) => kind === 'student'
  ? `Hoja del alumno (${model === 'mini' ? 'MODEL-MINI' : 'MODEL-DEFAULT'})\nObjetivos de hoy:\n- Completar la actividad`
  : `Semana 1 - Clase 1 - ${model === 'mini' ? 'MODEL-MINI' : 'MODEL-DEFAULT'} guía\nObjetivos de hoy:\n- Practicar\nInicio\n- Pregunta disparadora`;

async function setup(browser, opts = {}) {
  M.resetDb();
  M.plans.state.trialOn = opts.trialOn !== false;
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1366, height: 900 }, locale: opts.locale || 'es-UY' });
  const st = { errors: [], gen: [], leads: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url()); const tok = (r.request().headers().authorization || '').replace('Bearer ', ''); const me = M.tokUser(tok);
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData()); st.gen.push(b);
      const a = M.plans.generate(me, b, AI); return r.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (u.pathname === '/api/notify/lead') {
      const b = JSON.parse(r.request().postData()); st.leads.push({ auth: !!me, body: b });
      const a = M.plans.submitLead(me, b); return r.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ billing_configured: true, billing_ok: true, model_mini: opts.mini !== false, sales_email: false }) });
    if (u.pathname === '/api/config') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ turnstileSiteKey: null, salesAnon: false, email: false }) });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    if (/^\/(planes|plans)$/.test(u.pathname)) return r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'public/planes.html'), 'utf8').replace('<script src="/vendor/supabase-js-2.116.0.js"></script>', '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js"></script>') });
    if (/^\/(plans\.js|plans\.css|favicon-32\.png|favicon-512\.png|apple-touch-icon\.png)$/.test(u.pathname)) { const f = path.join(ROOT, 'public', u.pathname); return r.fulfill({ contentType: u.pathname.endsWith('.js') ? 'application/javascript' : u.pathname.endsWith('.css') ? 'text/css' : 'image/png', body: fs.readFileSync(f) }); }
    if (u.pathname.startsWith('/vendor/fonts/')) return r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(ROOT, 'public', u.pathname)) });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage(); page.__st = st;
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource|402|403/.test(m.text())) st.errors.push('console: ' + m.text()); });
  return { ctx, page, st };
}
async function run(name, browser, fn, opts) {
  const env = await setup(browser, opts);
  try {
    await fn(env);
    if (await env.page.evaluate(() => window.__xss).catch(() => false)) throw new Error('XSS executed');
    if (env.st.errors.length) throw new Error(env.st.errors.join(' | '));
    console.log('✓', name);
  } catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); if (process.env.DEBUG) console.log(e.stack); }
  finally { await env.ctx.close(); }
}
async function login(page, email, lang = 'es') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
  await page.evaluate(() => { window.TCPlans.POPUP_DELAY_MS = 300; });
}
const mk = (email, role, inst, name) => { const u = M.newUser(email, { name: name || email.split('@')[0] }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
async function generate(page, topic = 'Fotosíntesis') {
  await page.evaluate(() => document.getElementById('lp-doc')?.setAttribute('data-old', '1'));
  if (!(await page.isVisible('#panel-ai.active'))) await page.click('#nav-ai');
  await page.fill('#prompt-input', topic);
  await page.click('#btn-generate');
}
async function generateOk(page, topic) {
  await generate(page, topic);
  await page.waitForSelector('#ai-output.visible #lp-doc:not([data-old])');
  await page.waitForFunction(() => !document.getElementById('btn-generate').disabled);
  await page.waitForFunction(() => /MODEL-/.test(document.getElementById('lp-doc-student')?.innerText || ''), null, { timeout: 8000 });
}
const logout = page => page.evaluate(() => { docDirty = false; return handleLogout(); });
const popupOpen = page => page.waitForSelector('#tp-overlay:not([hidden]) .tp-modal', { timeout: 5000 });
const popupText = page => page.textContent('#tp-overlay .tp-modal');
const noPopup = async (page, ms = 900) => { await page.waitForTimeout(ms); if (await page.isVisible('#tp-overlay:not([hidden])')) throw new Error('unexpected pop-up: ' + (await popupText(page)).slice(0, 80)); };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  await run('Trial user: banner, pop-up after the 2nd class (once), reminder at the 4th, watermark, hard block at the 6th with the plans pop-up (server too)', browser, async ({ page, st }) => {
    M.newUser('solo@t.com', { name: 'Sole Docente' });
    await login(page, 'solo@t.com');
    await page.click('#user-avatar');
    if (await page.getAttribute('#um-plans', 'href') !== '/planes' || !(await page.isVisible('#um-plans'))) throw new Error('user menu → /planes');
    await page.click('#user-avatar');
    await page.waitForSelector('#trial-banner:not([hidden])');
    if (!/Te quedan 5 clases de prueba/.test(await page.textContent('#trial-banner'))) throw new Error('banner: ' + await page.textContent('#trial-banner'));
    await generateOk(page, 'Clase 1');
    await noPopup(page);
    if (!/Te quedan 4 clases de prueba/.test(await page.textContent('#trial-banner'))) throw new Error('banner after 1');
    await generateOk(page, 'Clase 2');
    await popupOpen(page);
    const t2 = await popupText(page);
    if (!/¡Ya generaste 2 clases con TeroClass!/.test(t2) || !/Te quedan 3 clases de prueba/.test(t2)) throw new Error('pop-up 2: ' + t2.slice(0, 160));
    for (const re of [/Docente/, /USD 12\/mes/, /USD 99\/año \(ahorrás 31%\)/, /Institución/, /desde USD 10 por docente\/mes/, /Institución\+/, /A medida/, /Quiero el plan Docente/, /Hablar con ventas/, /Seguir probando/]) if (!re.test(t2)) throw new Error('pop-up copy missing ' + re);
    if (/Más elegido|últimos|solo hoy|quedan pocos/i.test(t2)) throw new Error('no fake scarcity / social proof');
    if (await page.evaluate(() => document.activeElement?.closest('#tp-overlay') == null)) throw new Error('focus not in the pop-up');
    await shot(page, 'popup-es');
    if (!M.plans.state.trial[db.profiles.find(p => p.email === 'solo@t.com').id].paywall_shown_at) throw new Error('paywall not recorded');
    await page.click('#tp-overlay [data-tp="dismiss"].tp-link');
    await page.waitForSelector('#tp-overlay', { state: 'hidden' });
    if (!/Te quedan 3 clases de prueba/.test(await page.textContent('#trial-banner'))) throw new Error('banner after 2');
    await shot(page, 'banner', { clip: { x: 0, y: 0, width: 1366, height: 160 } });
    await generateOk(page, 'Clase 3');
    await noPopup(page);
    await generateOk(page, 'Clase 4');
    await popupOpen(page);
    const t4 = await popupText(page);
    if (!/Te queda 1 clase de prueba/.test(t4) || !/Elegí un plan para no cortar tu ritmo/.test(t4) || !/Más tarde/.test(t4)) throw new Error('reminder: ' + t4.slice(0, 120));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tp-overlay', { state: 'hidden' });
    if (!(await page.isVisible('#trial-banner.last'))) throw new Error('last-class banner');
    // the PDF of a trial class carries the watermark
    await page.evaluate(() => { window.open = u => { window.__pdf = u; return {}; }; });
    await page.click('button[onclick="exportPDF()"]');
    const pdf = await page.evaluate(async () => (await fetch(window.__pdf)).text());
    if (!/Creado con TeroClass — versión de prueba/.test(pdf)) throw new Error('watermark missing');
    await generateOk(page, 'Clase 5');
    await noPopup(page);
    if (!(await page.isVisible('#trial-banner.out')) || !/Usaste tus 5 clases de prueba/.test(await page.textContent('#trial-banner'))) throw new Error('banner at 0');
    // 6th: the app opens the plans pop-up without calling the AI
    const before = st.gen.length;
    await generate(page, 'Clase 6');
    await popupOpen(page);
    const t6 = await popupText(page);
    if (!/Usaste tus 5 clases de prueba/.test(t6) || !/Todo lo que creaste sigue acá/.test(t6) || !/Elegir plan Docente/.test(t6) || !/Hablar con ventas/.test(t6)) throw new Error('hard wall: ' + t6.slice(0, 160));
    if (st.gen.length !== before) throw new Error('the 6th reached /api/generate from the UI');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400); // the "dismiss" mark comes back from the server first
    // …and the server refuses it anyway (stale client state): 402 trial_limit → same pop-up, no error toast
    await page.evaluate(() => { TCPlans._state.trial.remaining = 3; });
    await generate(page, 'Clase 6 bis');
    await popupOpen(page);
    if (!/Usaste tus 5 clases de prueba/.test(await popupText(page))) throw new Error('server 402 did not open the plans pop-up');
    if (st.gen.length !== before + 1 || st.gen[st.gen.length - 1].kind !== 'generate') throw new Error('the request was not sent');
    if (/Error:/.test(await page.textContent('#toast'))) throw new Error('error toast on trial_limit');
    // the classes already created are still there (view + export)
    await page.keyboard.press('Escape');
    if (!(await page.isVisible('#ai-output.visible #lp-doc'))) throw new Error('class no longer visible');
  });

  await run('Teacher of an institution without a plan: variant pop-up ("Avisarle a mi admin"); active-plan teachers never see the trial', browser, async ({ page }) => {
    const libre = M.seedInstitution({ name: 'Libre', slug: 'libre' }); const paga = M.seedInstitution({ name: 'Paga', slug: 'paga' });
    bill.accounts[paga.id] = { seats: 10, monthly_tokens: 2000000, extra: 0, plan_status: 'active', plan_id: 'institucion' };
    mk('tl@t.com', 'teacher', libre.id, 'Tere Libre'); mk('tp@t.com', 'teacher', paga.id, 'Tomás Paga');
    await login(page, 'tp@t.com');
    await page.waitForTimeout(400);
    if (await page.isVisible('#trial-banner')) throw new Error('banner for an active-plan teacher');
    for (let i = 1; i <= 6; i++) await generateOk(page, 'Clase ' + i);
    await noPopup(page, 700);
    if (await page.isVisible('#trial-banner')) throw new Error('banner appeared');
    await page.evaluate(() => { window.open = u => { window.__pdf = u; return {}; }; });
    await page.click('button[onclick="exportPDF()"]');
    if (/versión de prueba/.test(await page.evaluate(async () => (await fetch(window.__pdf)).text()))) throw new Error('watermark on a paid plan');
    await logout(page);
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await login(page, 'tl@t.com');
    await page.waitForSelector('#trial-banner:not([hidden])');
    await generateOk(page, 'A'); await generateOk(page, 'B');
    await popupOpen(page);
    const t = await popupText(page);
    if (!/Tu institución todavía no tiene un plan activo/.test(t) || !/Avisarle a mi admin/.test(t) || !/Hablar con ventas/.test(t)) throw new Error('variant: ' + t.slice(0, 120));
    await page.click('[data-tp="notify-admin"]');
    // http test origin: no Clipboard API → the message is shown ready to copy (on https it is copied, with a toast)
    await page.waitForSelector('#tp-admin-msg');
    const clip = await page.inputValue('#tp-admin-msg');
    if (!/teroclass\.test\/planes/.test(clip)) throw new Error('admin message: ' + clip);
  });

  await run('Super admin and students never see the trial', browser, async ({ page }) => {
    M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'owner@teroclass.test');
    await page.waitForTimeout(500);
    if (await page.isVisible('#trial-banner')) throw new Error('banner for the super admin');
    await logout(page);
    await page.waitForSelector('#tab-login', { state: 'visible' });
    const s = M.newUser('alumna@t.com', { name: 'Alumna' }); db.profiles.find(p => p.id === s.id).role = 'student';
    await login(page, 'alumna@t.com');
    await page.waitForTimeout(500);
    if (await page.isVisible('#trial-banner') || await page.isVisible('#tp-overlay:not([hidden])')) throw new Error('trial UI for a student');
    if (await page.evaluate(() => getComputedStyle(document.getElementById('um-plans')).display) !== 'none') throw new Error('plans link for a student');
  });

  for (const [label, vp, lang, file] of [['ES desktop', { width: 1366, height: 900 }, 'es', 'planes-es-desktop'], ['ES mobile', { width: 390, height: 844 }, 'es', 'planes-es-mobile'], ['EN desktop', { width: 1366, height: 900 }, 'en', 'planes-en-desktop']]) {
    await run(`/planes without signing in (${label}): plans from the database, toggles, tiers, FAQ, accessible, no horizontal scroll`, browser, async ({ page }) => {
      await page.goto(`http://teroclass.test/planes?lang=${lang}`);
      await page.waitForSelector('.tp-card[data-plan="docente"]');
      const txt = await page.textContent('#tp-root');
      const must = lang === 'es'
        ? [/Planes de TeroClass/, /Prueba gratis/, /USD 99\/año/, /desde USD 10 por docente\/mes/, /A medida/, /3–9/, /USD 14/, /USD 17/, /Pack 50 clases/, /¿Los alumnos pagan\?/, /¿Qué es una hora de aula\?/, /¿Mis datos y los de mis alumnos\?/, /¿Qué es una "clase"\?/]
        : [/TeroClass plans/, /Free trial/, /USD 99\/year/, /from USD 10 per teacher\/month/, /Custom/, /Do students pay\?/, /What is a classroom hour\?/, /50-class pack/];
      for (const re of must) if (!re.test(txt)) throw new Error('missing ' + re);
      if (await page.$('[data-offer]')) throw new Error('launch offers shown while disabled');
      if (await page.evaluate(() => document.documentElement.lang) !== lang) throw new Error('html lang');
      if (await page.evaluate(() => document.querySelectorAll('h1').length) !== 1) throw new Error('one h1');
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error('horizontal scroll');
      await shot(page, file, { fullPage: true });
      // monthly ↔ yearly
      await page.click('[data-tp-period="monthly"]');
      if (await page.getAttribute('[data-tp-period="monthly"]', 'aria-pressed') !== 'true') throw new Error('aria-pressed');
      if (!new RegExp(lang === 'es' ? 'USD 12/mes' : 'USD 12/month').test(await page.textContent('.tp-card[data-plan="docente"]'))) throw new Error('monthly price');
      if (!/USD 12\b/.test(await page.textContent('.tp-card[data-plan="institucion"]'))) throw new Error('institution monthly from');
      // EUR for Spain / EU
      await page.click('[data-tp-cur="EUR"]');
      const doc = await page.textContent('.tp-card[data-plan="docente"]');
      if (!/11,99 €|€11\.99/.test(doc) || !/(IVA incluido|VAT included)/.test(doc)) throw new Error('EUR docente: ' + doc);
      if (!/(\+ IVA|\+ VAT)/.test(await page.textContent('.tp-card[data-plan="institucion"]'))) throw new Error('EUR + VAT');
      // FAQ opens with the keyboard
      await page.focus('.tp-faq summary'); await page.keyboard.press('Enter');
      if (!(await page.evaluate(() => document.querySelector('.tp-faq').open))) throw new Error('FAQ keyboard');
      // the sales form without a session: asks to sign in (no anonymous leads without Turnstile on the server)
      await page.click('.tp-card[data-plan="institucion"] [data-tp="sales"]');
      await page.waitForSelector('#tp-form');
      await page.waitForFunction(() => /(ingresá o creá una cuenta gratis|sign in or create a free account)/.test(document.getElementById('tpf-form-err').textContent));
      await page.keyboard.press('Escape');
    }, { viewport: vp, locale: lang === 'es' ? 'es-UY' : 'en-US' });
  }

  await run('Sales form from the pop-up: validation, WhatsApp / consent, submit → thanks; the super admin sees, updates and exports it (badge)', browser, async ({ page, st, ctx }) => {
    M.newUser('solo2@t.com', { name: 'Ana ' + XSS }); M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'solo2@t.com');
    await page.evaluate(() => TCPlans.showPopup('gen2'));
    await popupOpen(page);
    await page.click('#tp-overlay .tp-card[data-plan="institucion"] [data-tp="sales"]');
    await page.waitForSelector('#tp-form');
    if (await page.inputValue('#tpf-email') !== 'solo2@t.com') throw new Error('email prefilled');
    if (await page.inputValue('#tpf-preferred_plan') !== 'institucion') throw new Error('plan preselected');
    await page.fill('#tpf-name', '');
    await page.click('#tpf-send');
    for (const f of ['name', 'institution', 'role', 'teachers_count', 'whatsapp', 'consent']) if (!(await page.textContent(`#tpf-${f}-err`)).trim()) throw new Error('no error for ' + f);
    if (st.leads.length) throw new Error('sent with errors');
    await page.fill('#tpf-name', 'Ana <b>Pérez</b>'); await page.fill('#tpf-institution', 'Colegio Sur');
    await page.selectOption('#tpf-role', 'direccion'); await page.selectOption('#tpf-country', 'UY'); await page.selectOption('#tpf-teachers_count', '10-29');
    await page.fill('#tpf-whatsapp', '099 123'); await page.check('#tpf-consent');
    await page.fill('#tpf-message', 'Queremos una demo para 12 docentes ' + XSS);
    await page.click('#tpf-send');
    if (!/formato internacional/.test(await page.textContent('#tpf-whatsapp-err'))) throw new Error('whatsapp format');
    await page.fill('#tpf-whatsapp', '+598 99 123 456');
    await shot(page, 'sales-form');
    await page.click('#tpf-send');
    await page.waitForSelector('#tp-overlay .tp-ok');
    if (!/¡Gracias, Ana! Te escribimos en menos de 24 horas hábiles/.test(await popupText(page))) throw new Error('thanks: ' + await popupText(page));
    const sent = st.leads[0];
    if (!sent.auth || sent.body.source !== 'popup_gen2' || sent.body.lead.whatsapp !== '+59899123456' || sent.body.lead.consent !== true) throw new Error('payload: ' + JSON.stringify(sent));
    await page.click('#tp-overlay [data-tp="close-form"].tp-btn');
    // after a request no more pop-ups (banner only)
    if (!(await page.evaluate(() => TCPlans.trial().lead_sent))) throw new Error('lead_sent');
    // super admin: badge, list, update, CSV
    await logout(page); await page.waitForSelector('#tab-login', { state: 'visible' });
    await login(page, 'owner@teroclass.test');
    await page.waitForSelector('#nav-platform .sib-badge');
    if ((await page.textContent('#nav-platform .sib-badge')).trim() !== '1') throw new Error('badge');
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-leads tr[data-lead]');
    const row = await page.textContent('#pf-leads tr[data-lead]');
    for (const re of [/Ana\s+b\s+Pérez\s+\/b/, /Colegio Sur/, /Dirección/, /\+59899123456/, /solo2@t\.com/, /Institución/, /10–29/, /Pop-up \(2ª clase\)/, /Queremos una demo/]) if (!re.test(row)) throw new Error('lead row missing ' + re + ': ' + row);
    if (await page.$('#pf-leads img')) throw new Error('lead not escaped');
    if (!(await page.isVisible('#pf-leads-mail'))) throw new Error('e-mail hint (no RESEND)');
    await page.$eval('#pf-leads-card', el => el.scrollIntoView());
    await shot(page, 'leads');
    await page.selectOption('#pf-leads tr[data-lead] [data-f="status"]', 'contactado');
    await page.fill('#pf-leads tr[data-lead] [data-f="notes"]', 'Llamar el martes');
    await page.click('#pf-leads [data-pa="lead-save"]');
    await page.waitForFunction(() => /Pedido actualizado/.test(document.getElementById('toast').textContent));
    const l = M.plans.state.leads[0];
    if (l.status !== 'contactado' || l.notes !== 'Llamar el martes') throw new Error('not updated');
    await page.waitForFunction(() => !document.querySelector('#nav-platform .sib-badge'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-pa="lead-csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    if (!/contactado;Ana/.test(csv) || !/'\+59899123456/.test(csv) || !/Llamar el martes/.test(csv)) throw new Error('csv: ' + csv.slice(0, 300));
    if (!/^teroclass-pedidos-ventas-/.test(dl.suggestedFilename())) throw new Error('csv name');
  });

  await run('"Quiero el plan Docente": the form opens preselected with the "payment coming soon" note (no fake checkout)', browser, async ({ page, st }) => {
    M.newUser('solo3@t.com', { name: 'Bea' });
    await login(page, 'solo3@t.com', 'en');
    await page.evaluate(() => TCPlans.showPopup('limit'));
    await popupOpen(page);
    if (!/You've used your 5 trial classes/.test(await popupText(page))) throw new Error('EN hard wall');
    await page.click('#tp-overlay [data-tp="docente"].tp-btn >> nth=0');
    await page.waitForSelector('#tp-form');
    if (await page.inputValue('#tpf-preferred_plan') !== 'docente') throw new Error('docente preselected');
    if (!/Online payment is coming soon/.test(await page.textContent('#tpf-docnote'))) throw new Error('note');
    if (await page.$('#tp-overlay [href*="checkout"], #tp-overlay input[autocomplete="cc-number"]')) throw new Error('fake checkout');
  });

  await run('Plan & usage in classes: monthly classes, class packs (USD 25 / 85), request a pack; plans link', browser, async ({ page }) => {
    const madre = M.seedInstitution({ name: 'Madre', slug: 'madre' });
    bill.accounts[madre.id] = { seats: 10, monthly_tokens: 750000, extra: 1250000, plan_status: 'active', plan_id: 'institucion' }; bill.usage[madre.id] = 500000;
    mk('adm@m.com', 'org_admin', madre.id, 'Admin');
    await login(page, 'adm@m.com');
    await page.click('#nav-billing');
    await page.waitForSelector('#bl-used');
    if ((await page.textContent('#bl-used')).trim() !== '20 / 30') throw new Error('classes: ' + await page.textContent('#bl-used'));
    if ((await page.textContent('#bl-classes')).trim() !== '60') throw new Error('left: ' + await page.textContent('#bl-classes'));
    if ((await page.textContent('#bl-extra')).trim() !== '50') throw new Error('extra');
    if (!/Activo/.test(await page.textContent('.bl-planrow'))) throw new Error('plan status');
    if (await page.getAttribute('#bl-plans-link', 'href') !== '/planes') throw new Error('plans link');
    const packs = await page.textContent('.bl-packs');
    if (!/Pedir\s+Pack 50 clases · USD 25/.test(packs) || !/Pack 200 clases · USD 85/.test(packs)) throw new Error('packs: ' + packs);
    if (/tokens/i.test(await page.textContent('.bl-metrics'))) throw new Error('raw tokens shown to the admin');
    await page.click('[data-bl="buy"][data-pack="pack_clases_200"]');
    await page.click('[data-bl="buy"][data-pack="pack_clases_200"]');
    await page.waitForSelector('.bl-pending');
    if (!/200 clases · USD 85,00/.test(await page.textContent('.bl-pending'))) throw new Error('pending: ' + await page.textContent('.bl-pending'));
    const r = bill.requests[0]; if (r.pack_id !== 'pack_clases_200' || r.pack_tokens !== 5000000) throw new Error('request: ' + JSON.stringify(r));
  }, { trialOn: false });

  await run('Super admin: plans editor + launch offers reach /planes; plan status per institution ends the trial of its teachers; Docente plan', browser, async ({ page, ctx }) => {
    const libre = M.seedInstitution({ name: 'Libre <i>X</i>', slug: 'libre' });
    mk('tl@t.com', 'teacher', libre.id, 'Tere'); M.newUser('indiv@t.com', { name: 'Indi' }); M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForSelector('#pp-d-um');
    await page.fill('#pp-d-um', '13'); await page.check('[data-offer="founder"]');
    await page.click('[data-pa="plans-save"]');
    await page.waitForFunction(() => /Planes guardados/.test(document.getElementById('toast').textContent));
    if (M.plans.state.plans.plans[1].prices.usd.monthly !== 13 || !M.plans.state.plans.launch_offers[0].enabled) throw new Error('plans not saved');
    // plan status: Libre → active
    const tr = `#pf-plans tr[data-root="${libre.id}"]`;
    await page.selectOption(`${tr} [data-f="status"]`, 'active'); await page.selectOption(`${tr} [data-f="plan"]`, 'institucion');
    await page.click(`${tr} [data-bl="pf-save-plan"]`);
    await page.waitForFunction(() => /Plan guardado/.test(document.getElementById('toast').textContent));
    if (bill.accounts[libre.id].plan_status !== 'active') throw new Error('status not saved');
    // Docente plan
    await page.fill('#pf-ind-email', 'indiv@t.com'); await page.selectOption('#pf-ind-status', 'active');
    await page.click('[data-pa="ind-save"]');
    await page.waitForFunction(() => /Plan Docente guardado|Error/.test(document.getElementById('toast').textContent));
    if (!/guardado/.test(await page.textContent('#toast'))) throw new Error('toast: ' + await page.textContent('#toast'));
    await page.waitForSelector('#pf-ind-list >> text=indiv@t.com');
    const p2 = await ctx.newPage();
    await p2.goto('http://teroclass.test/planes?lang=es&currency=USD');
    await p2.waitForSelector('[data-offer="founder"]');
    await p2.click('[data-tp-period="monthly"]');
    if (!/USD 13\/mes/.test(await p2.textContent('.tp-card[data-plan="docente"]'))) throw new Error('/planes price not updated');
    if (/Quedan/.test(await p2.textContent('[data-offer="founder"]'))) throw new Error('scarcity line without real founders');
    await p2.close();
    await logout(page); await page.waitForSelector('#tab-login', { state: 'visible' });
    await login(page, 'tl@t.com');
    await page.waitForTimeout(400);
    if (await page.isVisible('#trial-banner')) throw new Error('teacher of an activated institution still on trial');
    await logout(page); await page.waitForSelector('#tab-login', { state: 'visible' });
    await login(page, 'indiv@t.com');
    await page.waitForTimeout(400);
    if (await page.isVisible('#trial-banner')) throw new Error('Docente plan still on trial');
  });

  await run('Compare models (super admin): blind A/B with the same pipeline, names hidden until rated, rating saved, summary', browser, async ({ page, st }) => {
    M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForSelector('#pf-compare-card [data-pa="cmp-add-topic"]');
    await page.fill('#pf-cmp-topic', 'Fotosíntesis 2º año');
    await page.click('[data-pa="cmp-add-topic"]');
    await page.click('[data-pa="cmp-run"]');
    await page.waitForFunction(() => document.querySelectorAll('.pf-cmp-col .pf-cmp-doc').length === 4, null, { timeout: 15000 });
    const cols = await page.$$eval('.pf-cmp-col', els => els.map(e => e.innerText));
    if (!cols.some(c => /MODEL-MINI/.test(c)) || !cols.some(c => /MODEL-DEFAULT/.test(c))) throw new Error('both outputs: ' + cols.join(' || ').slice(0, 200));
    const head = await page.$$eval('.pf-cmp-title', els => els.map(e => e.innerText).join(' | '));
    if (/mini|defecto|gpt/i.test(head)) throw new Error('names visible before rating: ' + head);
    if (!/Modelo A/.test(head) || !/Modelo B/.test(head)) throw new Error('labels: ' + head);
    if (!/≈ USD/.test(cols[0]) || !/tokens/.test(cols[0]) || !/ s/.test(cols[0])) throw new Error('stats: ' + cols[0].slice(0, 120));
    const gens = st.gen.filter(g => g.model);
    if (!gens.some(g => g.model === 'mini' && g.kind === 'generate') || !gens.some(g => g.model === 'default' && g.kind === 'student')) throw new Error('pipeline per model: ' + JSON.stringify(gens.map(g => [g.kind, g.model])));
    await page.$eval('#pf-compare-card', el => el.scrollIntoView());
    await shot(page, 'compare');
    const leftIsMini = /MODEL-MINI/.test(cols[0]);
    await page.click('[data-pa="cmp-pick"][data-v="a"]');
    await page.fill('#pf-cmp-note', 'A es más clara');
    await page.click('[data-pa="cmp-save"]');
    await page.waitForSelector('.pf-cmp-model');
    const c = M.plans.state.comparisons[0];
    if (!c || c.winner !== (leftIsMini ? 'mini' : 'default') || c.left_model !== (leftIsMini ? 'mini' : 'default') || c.note !== 'A es más clara') throw new Error('saved: ' + JSON.stringify(c && { w: c.winner, l: c.left_model }));
    if (!/gpt-4\.1-mini|gpt-4o/.test(await page.textContent('.pf-cmp-title'))) throw new Error('names not revealed after rating');
    await page.waitForSelector('#pf-cmp-summary .metric-card');
    if (!/100%/.test(await page.textContent('#pf-cmp-summary'))) throw new Error('summary: ' + await page.textContent('#pf-cmp-summary'));
  });

  await run('The per-kind model setting is respected; a teacher cannot choose a model', browser, async ({ page, st }) => {
    const madre = M.seedInstitution({ name: 'Madre', slug: 'madre' }); bill.accounts[madre.id] = { seats: 10, monthly_tokens: 2000000, extra: 0, plan_status: 'active' };
    mk('t@m.com', 'teacher', madre.id, 'Teo'); M.newUser('owner@teroclass.test', { name: 'Owner' });
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-platform');
    await page.waitForSelector('[data-model-kind="main"]');
    await page.selectOption('[data-model-kind="main"]', 'mini');
    await page.click('[data-pa="models-save"]');
    await page.waitForFunction(() => /Modelos guardados/.test(document.getElementById('toast').textContent));
    if (M.plans.state.modelDefault.main !== 'mini' || M.plans.state.modelDefault.student !== 'default') throw new Error('setting: ' + JSON.stringify(M.plans.state.modelDefault));
    await logout(page); await page.waitForSelector('#tab-login', { state: 'visible' });
    await login(page, 't@m.com');
    await generateOk(page, 'Clase con mini');
    if (!/MODEL-MINI/.test(await page.textContent('#lp-doc')) || !/MODEL-DEFAULT/.test(await page.textContent('#lp-doc-student'))) throw new Error('model per kind not applied');
    if (st.gen.some(g => g.model)) throw new Error('the teacher sent a model');
    const r = await page.evaluate(async () => { const { data: { session } } = await sb.auth.getSession();
      const x = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ kind: 'generate', messages: [], model: 'mini' }) }); return [x.status, (await x.json()).code]; });
    if (r[0] !== 403 || r[1] !== 'model_forbidden') throw new Error('teacher model: ' + r);
  }, { trialOn: false });

  await run('Métricas: free-trial funnel (trial users, 2nd class, pop-up, leads, converted)', browser, async ({ page }) => {
    M.newUser('owner@teroclass.test', { name: 'Owner' }); const a = M.newUser('f1@t.com', { name: 'F1' });
    M.plans.state.trial[a.id] = { used: 3, paywall_shown_at: new Date().toISOString() };
    await login(page, 'owner@teroclass.test');
    await page.click('#nav-metrics');
    await page.waitForSelector('#in-funnel');
    const t = await page.textContent('#in-funnel');
    for (const re of [/Prueba gratis → planes/, /Usuarios en prueba/, /Llegaron a la 2ª clase/, /Vieron el pop-up de planes/, /Pedidos de ventas/, /Convertidos/]) if (!re.test(t)) throw new Error('funnel missing ' + re);
    if ((await page.textContent('#in-f-2nd .metric-value')).trim() !== '1') throw new Error('2nd class count');
  });

  await browser.close();
  if (failed) { console.log(`${failed} plans scenario(s) failed`); process.exit(1); }
  console.log('All plans scenarios passed');
})();
