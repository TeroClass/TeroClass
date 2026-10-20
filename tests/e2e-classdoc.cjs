// Class document ("Documento de la clase"): two browser contexts (teacher + student) editing the same document live
// through the simulated Realtime broadcast (tests/mock-realtime.cjs), lock, paste a class (student handout only, no
// answers), admin read-only from the group card, document inside the live room, polling fallback without Realtime,
// history + restore, export, mobile. Mock Supabase (tests/mock-supabase.cjs + mock-classdoc.cjs) in headless Chromium.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-classdoc.cjs   (SHOTS=<dir> saves doc-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';
let Yjs = null; // the vendored bundle in node (to seed documents)
const loadY = async () => (Yjs = Yjs || (await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/vendor/classdoc-editor.js')).toString('base64'))).Y);

async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true, hasTouch: !!opts.mobile, isMobile: !!opts.mobile });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await M.realtime.attach(ctx, { unavailable: !!opts.noRealtime });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/vendor/classdoc-editor.js') return M.serveVendor(r);
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: '{"billing_configured":true,"billing_ok":true}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => { if (d.type() === 'prompt' && page.__prompt != null) { d.accept(page.__prompt); return; } st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource|getUserMedia|NotAllowedError|NotFoundError|Requested device not found|WebSocket/.test(m.text())) st.errors.push('console: ' + m.text()); });
  page.__st = st; return { ctx, page, st };
}
async function run(name, browser, fn) {
  M.resetDb(); const ctxs = [];
  const open = async opts => { const c = await newCtx(browser, opts); ctxs.push(c); return c; };
  try {
    await fn(open);
    const errs = ctxs.flatMap(c => c.st.errors);
    if (errs.length) throw new Error(errs.join(' | '));
    console.log('✓', name);
  } catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); if (process.env.DEBUG) console.log(e.stack, JSON.stringify(M.realtime.log).slice(0, 1500)); }
  finally { for (const c of ctxs) await c.ctx.close(); }
}
async function login(page, email, lang = 'es') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
async function studentLogin(page, u, lang = 'es') {
  await page.goto('http://teroclass.test/?student');
  await page.evaluate(l => { try { localStorage.setItem('tc_ui_lang', l); } catch (e) { /* ignore */ } }, lang);
  await page.goto(`http://teroclass.test/#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=magiclink`);
  await page.waitForSelector('#panel-student.active .gs-enter');
}
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const shot = async (page, name, sel) => {
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(500);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/doc-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/doc-${name}.png` });
};
const docText = (page, scope = '#cd-overlay') => page.evaluate(s => document.querySelector(s + ' .cd-prose')?.innerText || '', scope);
const waitDocText = (page, re, scope = '#cd-overlay', timeout = 10000) => page.waitForFunction(([src, s]) => new RegExp(src).test(document.querySelector(s + ' .cd-prose')?.innerText || ''), [re.source, scope], { timeout });
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style,.ProseMirror')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || /^(H1|H2|H3|B|I|S|1\.|•≡|\+▤|\+▥|−▤|−▥|✕▦|PDF|HTML|Markdown)$/.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return out;
}, sel);

function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  const sub = mk('sub@sol.uy', 'Pablo Suplente', 'teacher', centro.id);
  const admOtra = mk('adm@otra.uy', 'Admin Otra', 'org_admin', otra.id);
  const ana = M.newUser('ana@mail.com', { via: 'student_link' });
  const beto = M.newUser('beto@mail.com', { via: 'student_link' });
  const carl = M.newUser('carl@mail.com', { via: 'student_link' }); // a student of another group
  const g = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: prof.id, substitute_id: sub.id, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  const g2 = { id: M.uid(), institution_id: centro.id, name: 'Math 2', teacher_id: sub.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  db.class_groups.push(g, g2);
  const e = (u, name, grp) => { const x = { id: M.uid(), institution_id: centro.id, email: u.email, name, user_id: u.id, loaded_by: adm.id, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(x); db.group_members.push({ group_id: grp.id, enrollment_id: x.id, created_at: new Date(Date.now() - 40 * 864e5).toISOString() }); return x; };
  const eAna = e(ana, 'Ana Pérez', g); const eBeto = e(beto, 'Beto Ruiz ' + XSS, g); e(carl, 'Carl Otro', g2);
  const mkS = (offMin, dur, title, grp = g) => { const s = { id: M.uid(), institution_id: centro.id, group_id: grp.id, series_id: null, teacher_id: grp.teacher_id, title, starts_at: new Date(Date.now() + offMin * MIN).toISOString(), ends_at: new Date(Date.now() + (offMin + dur) * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
  const now = mkS(-5, 60, 'Unit 3: making plans');
  const past = mkS(-26 * 60, 60, 'Unit 2: routines');
  db.plannings.push({ id: M.uid(), owner_id: prof.id, institution_id: centro.id, title: 'Making plans (B1)', created_at: new Date().toISOString(),
    data: { params: {}, content: 'Making plans — TEACHER GUIDE\nAnswer key\n1. am going (TEACHER-ONLY)\nMethodology applied\n- pair work',
      student: 'Making plans — worksheet\nActivity 1: complete the sentences\n- I ____ (go) to the beach on Saturday.\nAnswer: am going\n| Name | Weekend plan |\n|---|---|\n| Ana | |\nExit ticket\n- Write 3 plans.' } });
  db.plannings.push({ id: M.uid(), owner_id: prof.id, institution_id: centro.id, title: 'No handout yet', created_at: new Date().toISOString(), data: { params: {}, content: 'Guide only', student: '' } });
  return { sol, centro, otra, adm, prof, sub, admOtra, ana, beto, carl, g, g2, eAna, eBeto, now, past };
}
// a document with paragraphs, stored like the app does (one Yjs update) — used to test reading without typing first
async function seedDoc(sessionId, paras) {
  const Y = await loadY(); const d = new Y.Doc(); const f = d.getXmlFragment('default');
  paras.forEach((t, i) => { const p = new Y.XmlElement(i === 0 ? 'heading' : 'paragraph'); if (i === 0) p.setAttribute('level', 2); p.insert(0, [new Y.XmlText(t)]); f.insert(f.length, [p]); });
  const b64 = Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64');
  db.class_docs.push({ session_id: sessionId, state: b64, state_upto: 0, generation: 1, locked: false, channel_key: 'a'.repeat(64), updated_at: new Date().toISOString() });
}
async function openDocFromCalendar(page, sid) {
  await page.click('#nav-calendar');
  await page.waitForSelector('.gc-nextcard .gc-nc-title');
  await page.click(`.gc-nextcard [data-gc="open"][data-id="${sid}"]`);
  await page.waitForSelector('#gc-modal-box [data-gc="doc"]');
  await page.click('#gc-modal-box [data-gc="doc"]');
  await page.waitForSelector('#cd-overlay.active .cd-prose');
}
async function typeIn(page, text, scope = '#cd-overlay') {
  await page.click(scope + ' .cd-prose'); await page.keyboard.press('Control+End'); await page.keyboard.type(text, { delay: 8 });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('Two participants (teacher + student, two browsers) type in the same document and see each other live (private Realtime channel, ES)', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await openDocFromCalendar(T.page, t.now.id);
    if (!(await T.page.$eval('#cd-overlay .cd-prose', el => el.getAttribute('contenteditable'))).includes('true')) throw new Error('teacher cannot edit');
    await typeIn(T.page, 'Hola clase: hoy hablamos de planes.');
    await studentLogin(S.page, t.ana);
    await S.page.click('.gs-enter [data-gc="doc"]');
    await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /Hola clase: hoy hablamos de planes\./);
    await typeIn(S.page, ' Ana: voy a ir a la playa.');
    await waitDocText(T.page, /Ana: voy a ir a la playa\./);
    // both on the PRIVATE channel, live; presence names from the database (teacher sees Ana Pérez, not an email)
    await T.page.waitForFunction(() => /En vivo/.test(document.querySelector('#cd-overlay .cd-status')?.textContent || ''));
    await S.page.waitForFunction(() => /En vivo/.test(document.querySelector('#cd-overlay .cd-status')?.textContent || ''));
    const joins = M.realtime.log.joins.filter(j => j.topic === 'classdoc:' + t.now.id && j.priv);
    if (joins.length < 2) throw new Error('private channel joins: ' + JSON.stringify(M.realtime.log.joins));
    await T.page.waitForFunction(() => document.querySelectorAll('#cd-overlay .cd-av').length >= 2, null, { timeout: 8000 });
    const titles = await T.page.$$eval('#cd-overlay .cd-av', a => a.map(x => x.title).join('|'));
    if (!/Ana Pérez/.test(titles) || /@/.test(titles)) throw new Error('presence: ' + titles);
    // the other person's cursor appears with their name
    await T.page.waitForFunction(() => /Ana Pérez/.test([...document.querySelectorAll('#cd-overlay .collaboration-cursor__label')].map(x => x.textContent).join('|')), null, { timeout: 8000 });
    // rich text: heading + bold + list typed by the teacher reach the student
    await T.page.click('#cd-overlay .cd-prose'); await T.page.keyboard.press('Control+End'); await T.page.keyboard.press('Enter');
    await T.page.click('#cd-overlay [data-cd="fmt"][data-k="h2"]'); await T.page.keyboard.type('Vocabulario', { delay: 5 });
    await T.page.keyboard.press('Enter'); await T.page.click('#cd-overlay [data-cd="fmt"][data-k="ul"]'); await T.page.keyboard.type('going to', { delay: 5 });
    await S.page.waitForFunction(() => !!document.querySelector('#cd-overlay .cd-prose h2') && /Vocabulario/.test(document.querySelector('#cd-overlay .cd-prose h2')?.textContent || '') && /going to/.test(document.querySelector('#cd-overlay .cd-prose ul')?.textContent || ''), null, { timeout: 10000 });
    if (await S.page.evaluate(() => window.__xss) || await T.page.evaluate(() => window.__xss)) throw new Error('XSS');
    const un = await untranslated(T.page, '#cd-overlay'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    if (!db.class_doc_updates.length && !db.class_docs.find(d => d.session_id === t.now.id)?.state) throw new Error('nothing persisted');
    await shot(T.page, 'two-participants');
  });

  await run('Lock: the teacher locks → the student can read but not type (UI and database); unlock → typing again', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openDocFromCalendar(T.page, t.now.id);
    await typeIn(T.page, 'Texto del docente.');
    await studentLogin(S.page, t.ana); await S.page.click('.gs-enter [data-gc="doc"]'); await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /Texto del docente\./);
    await T.page.click('#cd-overlay [data-cd="lock"]');
    await waitToast(T.page, /Bloqueado: los estudiantes pueden leer/);
    await S.page.waitForFunction(() => document.querySelector('#cd-overlay .cd-prose')?.getAttribute('contenteditable') === 'false', null, { timeout: 8000 });
    const note = await S.page.textContent('#cd-overlay .cd-notice');
    if (!/El docente bloqueó el documento/.test(note)) throw new Error('student notice: ' + note);
    if (await S.page.isVisible('#cd-overlay .cd-toolbar')) throw new Error('toolbar visible while locked');
    await S.page.click('#cd-overlay .cd-prose'); await S.page.keyboard.type('NO DEBERÍA', { delay: 5 }); await S.page.waitForTimeout(600);
    if (/NO DEBERÍA/.test(await docText(S.page))) throw new Error('student typed while locked');
    const r = await S.page.evaluate(id => sb.rpc('classdoc_push', { p_session: id, p_generation: 1, p_update: btoa('x'), p_client: '1' }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/bloqueó/.test(r)) throw new Error('database accepted a locked push: ' + r);
    // the teacher still edits
    await typeIn(T.page, ' Sigue el docente.');
    await waitDocText(S.page, /Sigue el docente\./);
    await shot(T.page, 'locked-teacher', '#cd-overlay .cd-overlay-box');
    await T.page.click('#cd-overlay [data-cd="lock"]');
    await S.page.waitForFunction(() => document.querySelector('#cd-overlay .cd-prose')?.getAttribute('contenteditable') === 'true', null, { timeout: 8000 });
    await typeIn(S.page, ' Ana otra vez.');
    await waitDocText(T.page, /Ana otra vez\./);
  });

  await run('Paste a class: the teacher inserts the STUDENT HANDOUT of a saved class (no answers, no teacher guide); the student sees it', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openDocFromCalendar(T.page, t.now.id);
    await T.page.click('#cd-overlay [data-cd="paste"]');
    await T.page.waitForSelector('#cd-overlay .cd-pick-list');
    const off = await T.page.$$eval('#cd-overlay .cd-pick.off', l => l.map(x => x.textContent).join('|'));
    if (!/No handout yet/.test(off) || !/Todavía no tiene material del alumno/.test(off)) throw new Error('class without handout not disabled: ' + off);
    await shot(T.page, 'paste-class', '#cd-overlay .cd-sheet-box');
    await T.page.click('#cd-overlay .cd-pick:not(.off) [data-cd="paste-pick"]');
    await waitToast(T.page, /Material del alumno insertado/);
    const txt = await docText(T.page);
    if (!/I ____ \(go\) to the beach on Saturday\./.test(txt) || !/Write 3 plans\./.test(txt)) throw new Error('handout missing: ' + txt);
    if (/am going|TEACHER|Answer|Methodology/i.test(txt)) throw new Error('answers / teacher guide leaked into the shared doc: ' + txt);
    if (!(await T.page.$('#cd-overlay .cd-prose table'))) throw new Error('handout table not converted');
    if (!(await T.page.$('#cd-overlay .cd-prose h2, #cd-overlay .cd-prose h3'))) throw new Error('no headings');
    await studentLogin(S.page, t.ana); await S.page.click('.gs-enter [data-gc="doc"]'); await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /to the beach on Saturday/);
    if (await S.page.isVisible('#cd-overlay [data-cd="paste"]')) throw new Error('student can paste a class');
  });

  await run('Admin: group card → classes → document, READ-ONLY; other-institution admin and a student of another group are refused', browser, async open => {
    const t = seed();
    await seedDoc(t.past.id, ['Resumen de la clase', 'Hicimos ejercicios de rutinas.', 'Tarea: escribir tu rutina.']);
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(id => { currentOrgId = id; }, t.centro.id);
    await A.page.click('#nav-groups');
    await A.page.waitForSelector('#panel-groups.active .gc-gcard');
    const card = A.page.locator('.gc-gcard', { hasText: 'English B1' });
    await card.locator('[data-gc="g-sessions"]').click();
    await A.page.waitForSelector('#gc-modal-box .gcs-list');
    await shot(A.page, 'admin-group-sessions', '#gc-modal-box');
    await A.page.click(`#gc-modal-box [data-att="gs-doc"][data-id="${t.past.id}"]`);
    await A.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(A.page, /Hicimos ejercicios de rutinas\./, '#cd-overlay', 8000);
    if ((await A.page.$eval('#cd-overlay .cd-prose', el => el.getAttribute('contenteditable'))) !== 'false') throw new Error('admin can edit');
    if (await A.page.isVisible('#cd-overlay .cd-toolbar')) throw new Error('toolbar for admin');
    if (await A.page.isVisible('#cd-overlay [data-cd="lock"]') || await A.page.isVisible('#cd-overlay [data-cd="paste"]')) throw new Error('teacher actions for admin');
    if (!/Solo lectura/.test(await A.page.textContent('#cd-overlay .cd-notice'))) throw new Error('no read-only notice');
    const r = await A.page.evaluate(id => sb.rpc('classdoc_push', { p_session: id, p_generation: 1, p_update: btoa('x'), p_client: '9' }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/Solo lectura/.test(r)) throw new Error('admin push: ' + r);
    // history is visible to the admin, without restore
    await A.page.click('#cd-overlay [data-cd="history"]'); await A.page.waitForSelector('#cd-overlay .cd-sheet-box');
    if (await A.page.$('#cd-overlay [data-cd="ver-save"]')) throw new Error('admin can save versions');
    await A.page.click('#cd-overlay [data-cd="sheet-close"]');
    await shot(A.page, 'admin-readonly', '#cd-overlay .cd-overlay-box');
    const un = await untranslated(A.page, '#cd-overlay'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    // other institution's admin and a student of another group: no access (database)
    const O = await open(); await login(O.page, 'adm@otra.uy');
    const ro = await O.page.evaluate(id => sb.rpc('classdoc_open', { p_session: id }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/No autorizado/.test(ro)) throw new Error('other admin: ' + ro);
    const C = await open(); await studentLogin(C.page, t.carl).catch(() => {});
    const rc = await C.page.evaluate(id => sb.rpc('classdoc_open', { p_session: id }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/No autorizado/.test(rc)) throw new Error('student of another group: ' + rc);
  });

  await run('Inside the live room: "Documento" side tab with the same document (teacher), typing reaches a student', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await T.page.click('.gc-nextcard [data-gc="join"]');
    await T.page.waitForSelector('#panel-live.active #lc-name');
    await T.page.fill('#lc-name', 'Laura Gómez');
    await T.page.click('#lc-join');
    await T.page.waitForSelector('#lc-room');
    await T.page.click('#lc-tab-doc').catch(async () => { await T.page.click('#lc-ctl-doc'); });
    await T.page.waitForSelector('#lc-side-doc .cd-prose');
    await typeIn(T.page, 'Escriban sus planes acá 👇', '#lc-side-doc');
    await studentLogin(S.page, t.ana); await S.page.click('.gs-enter [data-gc="doc"]'); await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /Escriban sus planes acá/);
    await typeIn(S.page, ' Voy a estudiar.');
    await waitDocText(T.page, /Voy a estudiar\./, '#lc-side-doc');
    await shot(T.page, 'live-room');
  });

  await run('Without Realtime: the student falls back to polling ("live sync unavailable") and edits still arrive both ways', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open({ noRealtime: true });
    await login(T.page, 'prof@sol.uy'); await openDocFromCalendar(T.page, t.now.id);
    await studentLogin(S.page, t.ana); await S.page.click('.gs-enter [data-gc="doc"]'); await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await S.page.waitForFunction(() => /no disponible/.test(document.querySelector('#cd-overlay .cd-status')?.textContent || ''), null, { timeout: 25000 });
    await typeIn(T.page, 'Mensaje por polling.');
    await waitDocText(S.page, /Mensaje por polling\./, '#cd-overlay', 12000);
    await typeIn(S.page, ' Respuesta de Ana.');
    await waitDocText(T.page, /Respuesta de Ana\./, '#cd-overlay', 20000);
  });

  await run('History: the teacher saves a version, changes the text and restores it; the student sees the restored text and cannot restore', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openDocFromCalendar(T.page, t.now.id);
    await typeIn(T.page, 'Versión uno.');
    await T.page.waitForFunction(() => !/Guardando/.test(document.querySelector('#cd-overlay .cd-status')?.textContent || ''));
    await T.page.click('#cd-overlay [data-cd="history"]');
    await T.page.click('#cd-overlay [data-cd="ver-save"]');
    await waitToast(T.page, /Versión guardada/);
    await T.page.click('#cd-overlay [data-cd="sheet-close"]');
    await T.page.click('#cd-overlay .cd-prose'); await T.page.keyboard.press('Control+a'); await T.page.keyboard.type('Texto equivocado.', { delay: 5 });
    await studentLogin(S.page, t.ana); await S.page.click('.gs-enter [data-gc="doc"]'); await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /Texto equivocado\./);
    await T.page.click('#cd-overlay [data-cd="history"]');
    await T.page.waitForSelector('#cd-overlay .cd-ver-open');
    await T.page.click('#cd-overlay .cd-ver-open');
    await T.page.waitForFunction(() => /Versión uno\./.test(document.querySelector('#cd-overlay .cd-preview')?.innerText || ''));
    await T.page.click('#cd-overlay [data-cd="ver-restore"]'); await T.page.click('#cd-overlay [data-cd="ver-restore"]');
    await waitToast(T.page, /Versión restaurada/);
    await waitDocText(T.page, /^Versión uno\.$/m);
    await waitDocText(S.page, /Versión uno\./, '#cd-overlay', 12000);
    if (/Texto equivocado/.test(await docText(S.page))) throw new Error('student kept the old text');
    await S.page.click('#cd-overlay [data-cd="history"]'); await S.page.waitForSelector('#cd-overlay .cd-ver-open');
    await S.page.click('#cd-overlay .cd-ver-open'); await S.page.waitForSelector('#cd-overlay .cd-preview .ProseMirror');
    if (await S.page.$('#cd-overlay [data-cd="ver-restore"]')) throw new Error('student can restore');
    const r = await S.page.evaluate(id => sb.rpc('classdoc_restore', { p_version: id }).then(x => x.error?.message || 'ok'), db.class_doc_versions[0].id);
    if (!/No autorizado/.test(r)) throw new Error('student restore: ' + r);
  });

  await run('Export: print (window.print of the document view), HTML and Markdown downloads', browser, async open => {
    const t = seed();
    await seedDoc(t.past.id, ['Resumen', 'Línea con **asteriscos** y <b>etiquetas</b>.']);
    const T = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(id => TCClassDoc.open(id), t.past.id);
    await T.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(T.page, /Línea con/);
    await T.page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed = document.body.classList.contains('cd-printing') ? 1 : -1; }; });
    await T.page.click('#cd-overlay [data-cd="export-menu"]'); await T.page.click('#cd-overlay [data-cd="print"]');
    if (await T.page.evaluate(() => window.__printed) !== 1) throw new Error('print not called on the document view');
    await T.page.click('#cd-overlay [data-cd="export-menu"]');
    const [dl] = await Promise.all([T.page.waitForEvent('download'), T.page.click('#cd-overlay [data-cd="dl-html"]')]);
    const html = fs.readFileSync(await dl.path(), 'utf8');
    if (!/<h2>Resumen<\/h2>/.test(html) || !/&lt;b&gt;etiquetas&lt;\/b&gt;/.test(html) || /<b>etiquetas<\/b>/.test(html) || !/Unit 2: routines/.test(html)) throw new Error('html export: ' + html.slice(0, 400));
    await T.page.click('#cd-overlay [data-cd="export-menu"]');
    const [dl2] = await Promise.all([T.page.waitForEvent('download'), T.page.click('#cd-overlay [data-cd="dl-md"]')]);
    const md = fs.readFileSync(await dl2.path(), 'utf8');
    if (!/^# Unit 2: routines/m.test(md) || !/^## Resumen/m.test(md) || !/\\\*\\\*asteriscos\\\*\\\*/.test(md)) throw new Error('markdown export: ' + md);
    if (!/\.md$/.test(dl2.suggestedFilename())) throw new Error('md name: ' + dl2.suggestedFilename());
  });

  await run('Mobile: the student opens the document from the dashboard (full screen, toolbar scrolls, no horizontal page scroll)', browser, async open => {
    const t = seed();
    await seedDoc(t.now.id, ['Unit 3: making plans', 'Escribí tres planes para el fin de semana.']);
    const S = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await studentLogin(S.page, t.ana);
    await S.page.click('.gs-enter [data-gc="doc"]');
    await S.page.waitForSelector('#cd-overlay.active .cd-prose');
    await waitDocText(S.page, /tres planes/);
    await typeIn(S.page, ' Voy a correr.');
    const over = await S.page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, box: document.querySelector('.cd-overlay-box').scrollWidth - document.querySelector('.cd-overlay-box').clientWidth }));
    if (over.doc > 1 || over.box > 1) throw new Error('horizontal scroll: ' + JSON.stringify(over));
    await shot(S.page, 'mobile');
  });

  await browser.close();
  if (failed) { console.log(`${failed} class-document scenario(s) failed`); process.exit(1); }
  console.log('All class-document scenarios passed');
})();
