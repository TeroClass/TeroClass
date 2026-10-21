// Recording consent (one checkbox per person) + auto-recording, end to end:
//  · first class room → ONE checkbox (ES); "yes" is stored in the database and the next entry doesn't ask;
//  · "no" → "Está bien" pop-up with an OPTIONAL comment (P-11: can be sent empty), joins NOT recorded, asked again next
//    class (nothing prefilled), the admin sees it in Groups → Consentimientos (badge, filters, CSV), email API called;
//  · profile menu "Grabación de mis clases: Activada / Desactivada" (confirmation; next entry asks again; turn back on);
//  · minor: guardian name + valid email + confirmation required; admin sees the flag, never the guardian's data;
//  · auto-recording indicator for everyone; the teacher pauses and resumes; View as is read-only; Métricas totals; mobile.
// Mock Supabase (tests/mock-supabase.cjs + mock-consent.cjs) in headless Chromium.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-consent.cjs   (SHOTS=<dir> saves cons-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';
const net = { notify: 0 };

async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true, hasTouch: !!opts.mobile, isMobile: !!opts.mobile });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await M.realtime.attach(ctx);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/vendor/classdoc-editor.js') return M.serveVendor(r);
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname === '/api/notify/consent') { net.notify++; net.notifyAuth = r.request().headers().authorization; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, sent: 0 }) }); }
    if (u.pathname === '/api/notify/session') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, sent: 0 }) });
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: '{"billing_configured":true,"billing_ok":true}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    // P-10: the guardian's page (public/tutor.html, as vercel.json serves it)
    if (u.pathname === '/tutor') return r.fulfill({ contentType: 'text/html', body: fs.readFileSync(require('path').join(__dirname, '..', 'public', 'tutor.html'), 'utf8') });
    if (u.pathname === '/legal.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(require('path').join(__dirname, '..', 'public', 'legal.css'), 'utf8') });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource|getUserMedia|NotAllowedError|NotFoundError|Requested device not found|WebSocket/.test(m.text())) st.errors.push('console: ' + m.text()); });
  return { ctx, page, st };
}
async function run(name, browser, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  M.resetDb(); net.notify = 0; const ctxs = [];
  const open = async opts => { const c = await newCtx(browser, opts); ctxs.push(c); return c; };
  try {
    await fn(open);
    const errs = ctxs.flatMap(c => c.st.errors);
    if (errs.length) throw new Error(errs.join(' | '));
    console.log('✓', name);
  } catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); if (process.env.DEBUG) console.log(e.stack); }
  finally { for (const c of ctxs) await c.ctx.close(); }
}
async function login(page, email, lang = 'es') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
  await page.waitForFunction(() => !appBooting); // the app finishes choosing its first screen before the test navigates
}
async function studentLogin(page, u, lang = 'es') {
  await page.goto('http://teroclass.test/?student');
  await page.evaluate(l => { try { localStorage.setItem('tc_ui_lang', l); } catch (e) { /* ignore */ } }, lang);
  await page.goto(`http://teroclass.test/#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=magiclink`);
  await page.waitForSelector('#panel-student.active .gs-enter');
}
// student: dashboard → Enter class → lobby (consent read from the database)
async function studentLobby(page, u) {
  await studentLogin(page, u);
  await page.waitForFunction(() => { const b = document.querySelector('.gs-enter .gc-join'); return b && !b.disabled; });
  await page.click('.gs-enter .gc-join');
  await page.waitForSelector('#panel-live.active #lc-joinas');
  await page.waitForSelector('#lc-consent, #lc-consent-ok');
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const shot = async (page, name, sel) => {
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(450);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/cons-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/cons-${name}.png` });
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style,video')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return out;
}, sel);
const noHScroll = async (page, where) => {
  const over = await page.evaluate(() => { const r = document.querySelector('.panel.active .lc-root, .panel.active'); return Math.max(document.documentElement.scrollWidth - window.innerWidth, r ? r.scrollWidth - r.clientWidth : 0); });
  if (over > 1) throw new Error(where + ': horizontal scroll ' + over);
};

function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  const owner = M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  mk('adm@otra.uy', 'Admin Otra', 'org_admin', otra.id);
  const st = email => M.newUser(email, { via: 'student_link' });
  const ana = st('ana@mail.com'); const beto = st('beto@mail.com'); const dani = st('dani@mail.com');
  const g = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: prof.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  db.class_groups.push(g);
  const e = (u, email, name, inst = centro.id, grp = g) => { const x = { id: M.uid(), institution_id: inst, email, name, user_id: u?.id || null, loaded_by: adm.id, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(x); if (grp) db.group_members.push({ group_id: grp.id, enrollment_id: x.id, created_at: new Date(Date.now() - 40 * 864e5).toISOString() }); return x; };
  e(ana, 'ana@mail.com', 'Ana Pérez'); e(beto, 'beto@mail.com', 'Beto Ruiz ' + XSS); e(null, 'caro@mail.com', 'Caro Díaz'); e(dani, 'dani@mail.com', 'Dani Menor');
  e(beto, 'beto@mail.com', 'Roberto (Otra)', otra.id, null); // another institution loaded Beto too: it must not see Centro's data
  const now = { id: M.uid(), institution_id: centro.id, group_id: g.id, series_id: null, teacher_id: prof.id, title: 'Unit 4: food', starts_at: new Date(Date.now() - 3 * MIN).toISOString(), ends_at: new Date(Date.now() + 57 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() };
  db.class_sessions.push(now);
  return { sol, centro, otra, owner, adm, prof, ana, beto, dani, g, now };
}
const grant = (u, extra = {}) => db.user_consents.push({ id: M.uid(), user_id: u.id, version: M.consent.VERSION, granted_at: new Date().toISOString(), revoked_at: null, revoked_reason: null, is_minor: false, guardian_name: null, guardian_email: null, guardian_consent: false, ...extra });
async function openConsents(page) {
  await page.click('#nav-groups');
  await page.waitForSelector('#gc-tab-consents');
  await page.click('#gc-tab-consents');
  await page.waitForSelector('#gc-cons-results');
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('First class room (ES): ONE checkbox; "yes" is stored and the room records; the next entry does not ask', browser, async open => {
    const t = seed();
    const S = await open();
    await studentLobby(S.page, t.ana);
    if ((await S.page.$$('#lc-consent-box input[type=checkbox]')).length !== 2) throw new Error('expected: consent + under 18 (the guardian confirms from their own link, P-10)');
    if (!/^Acepto que mis clases en TeroClass se graben \(solo audio\) y que la IA las analice para generar mis insights y mejorar las clases\.$/.test(await text(S.page, '.lc-consent-main'))) throw new Error('text: ' + await text(S.page, '.lc-consent-main'));
    if (!/Más información/.test(await text(S.page, '.lc-more summary'))) throw new Error('more info link');
    if (!/Te lo preguntamos una sola vez. Si no aceptás, podés entrar igual/.test(await text(S.page, '#lc-consent-box'))) throw new Error('can join anyway');
    if (await S.page.isChecked('#lc-consent')) throw new Error('prefilled');
    await S.page.click('.lc-more summary');
    let un = await untranslated(S.page, '.lc-lobby'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await S.page.click('.lc-more summary');
    await S.page.check('#lc-consent');
    if (!/Te vamos a grabar \(solo audio\)/.test(await text(S.page, '#lc-consent-summary'))) throw new Error('summary');
    await S.page.locator('#lc-consent-box').scrollIntoViewIfNeeded();
    await shot(S.page, 'lobby-es');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    const c = db.user_consents.filter(x => x.user_id === t.ana.id && !x.revoked_at);
    if (c.length !== 1 || c[0].version !== '2026-10') throw new Error('not stored: ' + JSON.stringify(db.user_consents));
    if (await S.page.$eval('#lc-rec', e => e.dataset.state) !== 'on') throw new Error('not recording from the start');
    if (!/Grabando — solo quienes dieron su consentimiento/.test(await text(S.page, '#lc-rec'))) throw new Error('indicator: ' + await text(S.page, '#lc-rec'));
    if (!/Grabado/.test(await text(S.page, '.lc-tile[data-pid="local"] .lc-tile-top'))) throw new Error('local badge');
    await S.page.waitForTimeout(600);
    await shot(S.page, 'room');
    // next entry (reload = new class visit): already agreed → no checkbox
    await studentLobby(S.page, t.ana);
    await S.page.waitForSelector('#lc-consent-ok');
    if (await S.page.$('#lc-consent')) throw new Error('asked again');
    if (!/Ya aceptaste/.test(await text(S.page, '#lc-consent-ok'))) throw new Error('granted text');
    un = await untranslated(S.page, '.lc-lobby'); if (un.length) throw new Error('untranslated (granted): ' + JSON.stringify(un));
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    if (calls.rpc.filter(x => x.fn === 'grant_recording_consent').length !== 1) throw new Error('granted twice');
  });

  await run('Saying no (ES): OPTIONAL comment pop-up (P-11); joins NOT recorded; asked again next class; the admin sees it neutrally in Consentimientos (badge, filters, CSV)', browser, async open => {
    const t = seed(); grant(t.ana);
    const S = await open();
    await studentLobby(S.page, t.beto);
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-decline-modal[open]');
    if (!/^Está bien$/.test(await text(S.page, '#lc-decline-h'))) throw new Error('title: ' + await text(S.page, '#lc-decline-h'));
    if (!/Si querés, contanos por qué \(opcional\)\. Tu respuesta le llega a la institución\./.test(await text(S.page, '#lc-decline-p'))) throw new Error('neutral wording');
    if (!/Podés entrar igual a la clase sin que te graben/.test(await text(S.page, '.lc-decline-ok'))) throw new Error('"you can still join" not visible');
    if (await S.page.evaluate(() => document.activeElement.id) !== 'lc-decline-text') throw new Error('focus not in the text box');
    if (await S.page.inputValue('#lc-decline-text') !== '') throw new Error('prefilled');
    if (await S.page.isDisabled('#lc-decline-send')) throw new Error('the comment is optional: sending empty must be possible');
    let un = await untranslated(S.page, '#lc-decline-modal'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(S.page, 'decline-es', '#lc-decline-modal .lc-modal');
    await S.page.keyboard.press('Escape');
    await S.page.waitForSelector('#lc-decline-modal', { state: 'hidden' });
    if (db.consent_declines.length || calls.rpc.some(x => x.fn === 'decline_recording_consent')) throw new Error('saved on cancel');
    if (await S.page.isVisible('#lc-room')) throw new Error('joined without answering');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-decline-modal[open]');
    if (await S.page.inputValue('#lc-decline-text') !== '') throw new Error('text kept after cancel');
    const reason = 'Me da vergüenza que graben mi voz <b>todavía</b> ' + XSS;
    await S.page.fill('#lc-decline-text', reason);
    if (await S.page.isDisabled('#lc-decline-send')) throw new Error('cannot send a valid reason');
    await S.page.click('#lc-decline-send');
    await S.page.waitForSelector('#lc-room');
    const d = db.consent_declines;
    if (d.length !== 1 || d[0].institution_id !== t.centro.id || d[0].session_id !== t.now.id || d[0].role !== 'student' || d[0].reason !== reason.trim()) throw new Error('decline: ' + JSON.stringify(d));
    if (db.user_consents.some(x => x.user_id === t.beto.id)) throw new Error('a "no" stored as consent');
    for (let i = 0; i < 30 && !net.notify; i++) await S.page.waitForTimeout(100);
    if (net.notify !== 1 || !/^Bearer tok-/.test(net.notifyAuth || '')) throw new Error('admin email API not called with the session');
    if (!/No se graba/.test(await text(S.page, '.lc-tile[data-pid="local"] .lc-tile-top'))) throw new Error('local badge');
    if (!/A vos no te graban/.test(await text(S.page, '#lc-rec'))) throw new Error('indicator "you: not recorded"');
    if (await S.page.evaluate(() => LiveClass.state.room.recorded)) throw new Error('recorded=true');
    // next class: asked again, nothing prefilled
    await studentLobby(S.page, t.beto);
    if (!(await S.page.$('#lc-consent')) || await S.page.isChecked('#lc-consent')) throw new Error('not asked again / prefilled');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-decline-modal[open]');
    if (await S.page.inputValue('#lc-decline-text') !== '') throw new Error('justification prefilled');
    await S.page.click('#lc-decline-send'); // this time without a comment: joins not recorded
    await S.page.waitForSelector('#lc-room');
    if (db.consent_declines.length !== 2 || db.consent_declines[1].reason !== '') throw new Error('empty "no": ' + JSON.stringify(db.consent_declines));
    // admin of the main institution: badge on Groups, Consentimientos tab
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(() => setAppMode('admin'));
    await A.page.evaluate(id => { if (typeof iswSelect === 'function') iswSelect(id); }, t.sol.id).catch(() => {});
    await A.page.waitForSelector('#nav-groups .sib-badge', { timeout: 8000 });
    if (await text(A.page, '#nav-groups .sib-badge') !== '1') throw new Error('badge: ' + await text(A.page, '#nav-groups .sib-badge'));
    await openConsents(A.page);
    await A.page.waitForSelector('.gc-cons-item');
    if (await A.page.$('#nav-groups .sib-badge')) throw new Error('badge not cleared after viewing');
    const body = await text(A.page, '#gc-cons-results');
    if (!/Beto Ruiz/.test(body) || !/No aceptó/.test(body) || !/Ana Pérez/.test(body) || !/Aceptó/.test(body) || !/Caro Díaz/.test(body) || !/Pendiente/.test(body) || !/Laura Gómez/.test(body)) throw new Error('people: ' + body);
    if (!/Respuestas sin comentario: 1/.test(body)) throw new Error('empty answers counted, not listed: ' + body);
    if (await A.page.$('.gc-cons-table .gc-chip.err')) throw new Error('"did not accept" shown in alarm red (P-11)');
    if (/Roberto \(Otra\)/.test(body)) throw new Error('another institution\'s name');
    const item = await text(A.page, '.gc-cons-item');
    if (!/Me da vergüenza que graben mi voz <b>todavía<\/b>/.test(item) || !/Unit 4: food/.test(item)) throw new Error('justification: ' + item);
    if (await A.page.$('.gc-cons-reason b, .gc-cons-reason img') || await A.page.evaluate(() => window.__xss)) throw new Error('XSS in the justification');
    un = await untranslated(A.page, '#gc-groups-body'); if (un.length) throw new Error('untranslated (admin): ' + JSON.stringify(un));
    await A.page.selectOption('#gc-cons-status', 'declined');
    if ((await A.page.$$('.gc-cons-table tbody tr')).length !== 1) throw new Error('status filter');
    await A.page.selectOption('#gc-cons-status', 'all');
    await A.page.fill('#gc-cons-search', 'caro');
    if ((await A.page.$$('.gc-cons-table tbody tr')).length !== 1 || (await A.page.$$('.gc-cons-item')).length) throw new Error('search filter');
    await A.page.fill('#gc-cons-search', '');
    await A.page.click('.gc-cons-stat.declined');
    if (await A.page.inputValue('#gc-cons-status') !== 'declined') throw new Error('stat → filter');
    await A.page.click('.gc-cons-stat.declined');
    const [dl] = await Promise.all([A.page.waitForEvent('download'), A.page.click('[data-gc="cons-csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    if (!/^﻿Nombre;Email;Rol;Unidad;Estado;Fecha;Menor de 18;Último comentario;Clase/.test(csv) || !/beto@mail\.com;Estudiante;Sede Centro;No aceptó;.*Me da vergüenza.*;Unit 4: food/.test(csv)) throw new Error('CSV: ' + csv.slice(0, 400));
    if (!/^consentimientos-/.test(dl.suggestedFilename())) throw new Error('file name ' + dl.suggestedFilename());
    await A.page.locator('#gc-groups-body').scrollIntoViewIfNeeded();
    await shot(A.page, 'admin');
    // admin of another institution that also loaded Beto: nothing from Centro
    const O = await open();
    await login(O.page, 'adm@otra.uy');
    await O.page.evaluate(() => setAppMode('admin'));
    await openConsents(O.page);
    const ob = await text(O.page, '#gc-cons-results');
    if (/Me da vergüenza|Beto Ruiz|Unit 4|Ana Pérez/.test(ob) || !/Roberto \(Otra\)/.test(ob)) throw new Error('cross-institution leak: ' + ob);
    if (await O.page.$('#nav-groups .sib-badge')) throw new Error('other admin got a badge');
  });

  await run('Profile (ES): "Grabación de mis clases: Activada" → confirm → Desactivada; next class asks again; the admin sees "Lo revocó"; turn it back on from the profile', browser, async open => {
    const t = seed(); grant(t.ana);
    const S = await open();
    await studentLogin(S.page, t.ana);
    await S.page.click('#user-avatar');
    await S.page.waitForFunction(() => document.getElementById('um-consent-state').textContent === 'Activada');
    if (!/Grabación de mis clases: Activada/.test(await text(S.page, '#um-consent'))) throw new Error('menu: ' + await text(S.page, '#um-consent'));
    await shot(S.page, 'profile', '#user-menu');
    await S.page.click('#um-consent');
    await S.page.waitForSelector('#lc-pmodal:not([hidden]) #lc-pm-revoke');
    if (!/¿Desactivar la grabación de tus clases\?/.test(await text(S.page, '#lc-pmodal'))) throw new Error('confirmation');
    let un = await untranslated(S.page, '#lc-pmodal'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await S.page.click('#lc-pmodal [data-pm="cancel"]');
    if (db.user_consents.some(c => c.revoked_at)) throw new Error('revoked on cancel');
    await S.page.click('#user-avatar'); await S.page.click('#um-consent');
    await S.page.click('#lc-pm-revoke');
    await waitToast(S.page, /Grabación desactivada/);
    const c = db.user_consents.find(x => x.user_id === t.ana.id);
    if (!c.revoked_at || c.revoked_reason !== 'user') throw new Error('not revoked');
    await S.page.click('#user-avatar');
    await S.page.waitForFunction(() => document.getElementById('um-consent-state').textContent === 'Desactivada');
    await S.page.click('#user-avatar');
    // the admin sees the revocation
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(() => setAppMode('admin'));
    await openConsents(A.page);
    const row = await A.page.locator('.gc-cons-table tr', { hasText: 'ana@mail.com' }).textContent();
    if (!/Lo revocó/.test(row)) throw new Error('admin row: ' + row);
    // next class: asked again
    await studentLobby(S.page, t.ana);
    if (!(await S.page.$('#lc-consent'))) throw new Error('not asked again after revoking');
    // turn it back on from the profile (same single checkbox)
    await S.page.click('#user-avatar'); await S.page.click('#um-consent');
    await S.page.waitForSelector('#lc-pmodal:not([hidden]) #lc-p-consent');
    if (!/Acepto que mis clases en TeroClass se graben/.test(await text(S.page, '#lc-pmodal'))) throw new Error('profile checkbox text');
    await S.page.click('#lc-pm-grant');
    if (!/Marcá la casilla/.test(await text(S.page, '#lc-pm-err'))) throw new Error('needs the checkbox');
    await shot(S.page, 'profile-dialog', '#lc-pmodal .lc-modal');
    await S.page.check('#lc-p-consent');
    await S.page.click('#lc-pm-grant');
    await waitToast(S.page, /Grabación activada/);
    if (!db.user_consents.some(x => x.user_id === t.ana.id && !x.revoked_at)) throw new Error('not granted again');
  });

  await run('Under 18 (P-10): guardian name + valid email; NOT recorded until the guardian confirms from their own link; then "Tutor/a ✓"; the admin never sees the guardian\'s data', browser, async open => {
    const t = seed();
    const S = await open();
    await studentLobby(S.page, t.dani);
    await S.page.check('#lc-consent');
    await S.page.check('#lc-minor');
    await S.page.waitForSelector('#lc-guardian', { state: 'visible' });
    if (!/Falta el consentimiento del tutor/.test(await text(S.page, '#lc-consent-summary'))) throw new Error('summary');
    await S.page.click('#lc-join');
    if (!/nombre del tutor/.test(await text(S.page, '#lc-lobby-err'))) throw new Error('guardian name required');
    await S.page.fill('#lc-g-name', 'Laura Pérez');
    await S.page.fill('#lc-g-email', 'no-es-email');
    await S.page.click('#lc-join');
    if (!/email válido del tutor/.test(await text(S.page, '#lc-lobby-err'))) throw new Error('valid email required');
    if (calls.rpc.some(x => x.fn === 'grant_recording_consent')) throw new Error('saved before the guardian part was complete');
    if (await S.page.$('#lc-g-consent')) throw new Error('the minor must not tick the guardian\'s box (P-10)');
    await S.page.fill('#lc-g-email', 'laura.tutora@example.com');
    await S.page.click('#lc-join');
    // saved, waiting for the guardian: the lobby shows the link to send (copy / WhatsApp)
    await S.page.waitForSelector('#lc-guardian-wait');
    const link = await S.page.inputValue('#lc-guardian-link');
    if (!/\/tutor\?t=[0-9a-f]{64}$/.test(link)) throw new Error('guardian link: ' + link);
    let c = db.user_consents.find(x => x.user_id === t.dani.id && !x.revoked_at);
    if (!c || !c.is_minor || c.guardian_email !== 'laura.tutora@example.com' || c.guardian_consent) throw new Error('minor consent must wait for the guardian: ' + JSON.stringify(c));
    const un = await untranslated(S.page, '.lc-lobby'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(S.page, 'minor-waiting', '.lc-lobby');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    if (await S.page.evaluate(() => LiveClass.state.room.recorded)) throw new Error('a minor recorded before the guardian confirmed');
    // the admin sees "waiting for the guardian", never the guardian's data
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(() => setAppMode('admin'));
    await openConsents(A.page);
    let row = await A.page.locator('.gc-cons-table tr', { hasText: 'dani@mail.com' }).textContent();
    if (!/Menor de 18 · esperando al tutor\/a/.test(row)) throw new Error('admin row (waiting): ' + row);
    // the guardian opens their link (no account) and confirms
    const G = await open();
    await G.page.goto(link.replace(/^https?:\/\/[^/]+/, 'http://teroclass.test') + '&lang=es');
    await G.page.waitForSelector('#tu-yes');
    if (!/Dani/.test(await text(G.page, '#tu-body'))) throw new Error('guardian page: ' + await text(G.page, '#tu-body'));
    await shot(G.page, 'guardian-page');
    await G.page.click('#tu-yes');
    await G.page.waitForFunction(() => /Aceptaste/.test(document.getElementById('tu-body').textContent));
    c = db.user_consents.find(x => x.user_id === t.dani.id && !x.revoked_at);
    if (!c.guardian_consent) throw new Error('guardian confirmation not stored');
    await openConsents(A.page);
    row = await A.page.locator('.gc-cons-table tr', { hasText: 'dani@mail.com' }).textContent();
    if (!/Aceptó/.test(row) || !/Menor de 18 · tutor\/a ✓/.test(row)) throw new Error('admin row: ' + row);
    if (/laura\.tutora|Laura Pérez/.test(await A.page.textContent('#gc-groups-root'))) throw new Error('guardian data shown to the admin');
    // next class: recorded, with the guardian badge
    await studentLobby(S.page, t.dani);
    await S.page.waitForSelector('#lc-consent-ok');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    if (!/Tutor\/a ✓/.test(await text(S.page, '.lc-tile[data-pid="local"] .lc-tile-top'))) throw new Error('guardian badge');
  });

  await run('Auto-recording for everyone: the teacher is asked once too, sees the indicator and can pause / resume; the student sees the indicator', browser, async open => {
    const t = seed(); grant(t.ana);
    const T = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await T.page.click('.gc-nextcard [data-gc="join"]');
    await T.page.waitForSelector('#lc-consent');
    await T.page.check('#lc-consent');
    await T.page.click('#lc-join');
    await T.page.waitForSelector('#lc-room');
    if (await T.page.$('#lc-ctl-rec')) throw new Error('REC button still there');
    if (await T.page.$eval('#lc-rec', e => e.dataset.state) !== 'on') throw new Error('teacher: not on');
    await T.page.click('#lc-ctl-pause');
    await T.page.waitForSelector('#lc-rec[data-state="paused"]');
    if (!/Grabación en pausa — se reanuda sola/.test(await text(T.page, '#lc-rec')) || await text(T.page, '#lc-ctl-pause .lc-ctl-lb') !== 'Reanudar') throw new Error('paused UI');
    await waitToast(T.page, /Se reanuda sola en 5 minutos/);
    await T.page.click('#lc-ctl-pause');
    await T.page.waitForSelector('#lc-rec[data-state="on"]');
    if (await text(T.page, '#lc-ctl-pause .lc-ctl-lb') !== 'Pausar grabación') throw new Error('resume label');
    const S = await open();
    await studentLobby(S.page, t.ana);
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    if (await S.page.$('#lc-ctl-pause')) throw new Error('student can pause');
    if (!/Grabando — solo quienes dieron su consentimiento/.test(await text(S.page, '#lc-rec'))) throw new Error('student indicator');
  });

  await run('View as (owner): Consentimientos renders read-only; the lobby consent is disabled and joining saves nothing; the profile toggle is blocked', browser, async open => {
    const t = seed(); grant(t.ana);
    db.consent_declines.push({ id: M.uid(), user_id: t.beto.id, institution_id: t.centro.id, session_id: t.now.id, role: 'student', version: '2026-10', reason: 'Prefiero que no por ahora', created_at: new Date().toISOString() });
    const P = await open();
    await login(P.page, M.SUPERADMIN_EMAIL);
    await P.page.waitForFunction(() => typeof appBooting !== 'undefined' && !appBooting && currentUser?.isSuperAdmin);
    for (let i = 0; i < 20 && !(await P.page.evaluate(id => enterViewAs({ unitId: id, perspective: 'admin' }), t.centro.id)); i++) await P.page.waitForTimeout(250);
    await P.page.waitForFunction(() => !!viewAs);
    await P.page.evaluate(() => setAppMode('admin'));
    await openConsents(P.page);
    await P.page.waitForSelector('.gc-cons-item');
    if (!/Prefiero que no por ahora/.test(await text(P.page, '.gc-cons-item'))) throw new Error('view as: justification');
    await P.page.click('#user-avatar');
    await P.page.waitForSelector('#um-consent[aria-disabled="true"]');
    await P.page.click('#um-consent', { force: true }); // aria-disabled: it explains why instead of doing nothing
    await waitToast(P.page, /solo lectura|read-only/);
    if (await P.page.isVisible('#lc-pmodal')) throw new Error('profile dialog opened in View as');
    await P.page.evaluate(() => { setAppMode('teacher'); openLiveClass(); });
    await P.page.click('#lc-start-btn');
    await P.page.waitForSelector('#lc-consent');
    if (!(await P.page.isDisabled('#lc-consent'))) throw new Error('checkbox enabled in View as');
    if (!/solo lectura/.test(await text(P.page, '#lc-consent-box'))) throw new Error('read-only note');
    await P.page.click('#lc-join');
    await P.page.waitForSelector('#lc-room', { timeout: 5000 }).catch(async e => { throw new Error('no room: ' + await text(P.page, '#lc-lobby-err') + ' / ' + P.st.errors.join(' | ') + ' / ' + await text(P.page, '#toast')); });
    if (calls.rpc.some(x => /grant_recording_consent|decline_recording_consent|revoke_recording_consent|my_consent/.test(x.fn))) throw new Error('consent RPC in View as: ' + calls.rpc.map(x => x.fn).filter(f => /consent/.test(f)));
  });

  await run('Métricas (owner): aggregate consent totals for the unit, no names', browser, async open => {
    const t = seed(); grant(t.ana);
    db.consent_declines.push({ id: M.uid(), user_id: t.beto.id, institution_id: t.centro.id, session_id: null, role: 'student', version: '2026-10', reason: 'No quiero que me graben', created_at: new Date().toISOString() });
    const P = await open();
    await login(P.page, M.SUPERADMIN_EMAIL);
    await P.page.evaluate(() => setAppMode('admin'));
    await P.page.evaluate(() => showPanel('metrics'));
    await P.page.waitForSelector('#in-t-consent');
    const tile = await text(P.page, '#in-t-consent');
    // all institutions: Ana granted; Beto declined; Caro, Dani, Laura, admins → pending
    if (!/Consentimiento de grabación/.test(tile) || !/Aceptó 1 · No aceptó 1/.test(tile) || /@|Beto|Ana/.test(tile)) throw new Error('tile: ' + tile);
  });

  await run('Mobile (390 px): lobby consent, decline pop-up, room indicator and admin Consentimientos fit the screen', browser, async open => {
    const t = seed(); grant(t.ana);
    db.consent_declines.push({ id: M.uid(), user_id: t.ana.id, institution_id: t.centro.id, session_id: t.now.id, role: 'student', version: '2026-10', reason: 'Una justificación vieja bastante larga para ver cómo se corta en el teléfono', created_at: new Date(Date.now() - 864e5).toISOString() });
    const mobile = { viewport: { width: 390, height: 844 }, mobile: true };
    const S = await open(mobile);
    await studentLobby(S.page, t.beto);
    await S.page.locator('#lc-consent-box').scrollIntoViewIfNeeded();
    await noHScroll(S.page, 'lobby');
    await S.page.check('#lc-minor');
    await noHScroll(S.page, 'lobby (guardian)');
    await S.page.uncheck('#lc-minor');
    await shot(S.page, 'mobile');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-decline-modal[open]');
    const box = await S.page.$eval('#lc-decline-modal .lc-modal', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; });
    if (box.l < 0 || box.r > 390 || box.b > 844) throw new Error('pop-up off screen: ' + JSON.stringify(box));
    await shot(S.page, 'mobile-decline');
    await S.page.fill('#lc-decline-text', 'No me siento cómodo con la grabación');
    await S.page.click('#lc-decline-send');
    await S.page.waitForSelector('#lc-room');
    const rec = await S.page.$eval('#lc-rec', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vis: r.width > 0 }; });
    if (!rec.vis || rec.l < 0 || rec.r > 390) throw new Error('indicator off screen: ' + JSON.stringify(rec));
    await noHScroll(S.page, 'room');
    await shot(S.page, 'mobile-room');
    const A = await open(mobile);
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(() => setAppMode('admin'));
    await openConsents(A.page); // (waits until the unit is known and the Groups button shows)
    await A.page.waitForSelector('.gc-cons-item');
    const over = await A.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) throw new Error('admin horizontal scroll ' + over);
    await A.page.evaluate(() => document.querySelector('.gc-cons-sum').scrollIntoView({ block: 'start' }));
    await shot(A.page, 'mobile-admin');
  });

  await browser.close();
  if (failed) { console.log(`${failed} consent scenario(s) failed`); process.exit(1); }
  console.log('All consent scenarios passed');
})();
