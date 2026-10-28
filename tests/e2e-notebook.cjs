// Group notebook ("Cuaderno del grupo": one per group and school year, a section per class) + the group board pages:
// teacher + student editing the same section live through the simulated Realtime broadcast, the outline jumps to a section,
// generator → "Enviar al cuaderno del grupo" (student handout without answers into the right section; teacher guide only as a
// teacher-only note; plan attached to the class), the live room "Documento" / "Pizarra" tabs open the group notebook / board on
// today's page, the board page selector, past-classes lock, previous class documents linked + imported, admin read-only, export,
// quick-room hint, mobile. Mock Supabase (tests/mock-supabase.cjs + mock-notebook.cjs) in headless Chromium.
// The notebook under the REAL CSP headers is covered by tests/e2e-csp.cjs.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-notebook.cjs   (SHOTS=<dir> saves nb-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';
let Yjs = null;
const loadY = async () => (Yjs = Yjs || (await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/vendor/classdoc-editor.js')).toString('base64'))).Y);

async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true, hasTouch: !!opts.mobile, isMobile: !!opts.mobile, deviceScaleFactor: opts.mobile ? 2 : 1 });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await M.realtime.attach(ctx, { unavailable: !!opts.noRealtime });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/vendor/whiteboard/')) return M.serveWhiteboard(r);
    if (u.pathname === '/vendor/classdoc-editor.js') return M.serveVendor(r);
    if (u.pathname.startsWith('/vendor/')) return r.fulfill({ status: 404, body: '' });
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: '{"billing_configured":true,"billing_ok":true}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource|getUserMedia|NotAllowedError|NotFoundError|Requested device not found|WebSocket/.test(m.text())) st.errors.push('console: ' + m.text()); });
  page.__st = st; return { ctx, page, st };
}
async function run(name, browser, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  M.resetDb(); const ctxs = [];
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
}
async function studentLogin(page, u, lang = 'es') {
  await page.goto('http://teroclass.test/?student');
  await page.evaluate(l => { try { localStorage.setItem('tc_ui_lang', l); } catch (e) { /* ignore */ } }, lang);
  await page.goto(`http://teroclass.test/#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=magiclink`);
  await page.waitForSelector('#panel-student.active .gs-enter');
}
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const shot = async (page, name, sel) => {
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(600);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/nb-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/nb-${name}.png` });
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style,.ProseMirror')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || /^(H1|H2|H3|B|I|S|1\.|•≡|\+▤|\+▥|−▤|−▥|✕▦|PDF|HTML|Markdown|PNG|SVG)$/.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return out;
}, sel);

const NB = '#nb-overlay';
// text of one section (by class session id) in a notebook view
const secText = (page, sid, scope = NB) => page.evaluate(([s, id]) => {
  const v = s === '#nb-overlay' ? TCNotebook._test.view : document.querySelector(s)?.__nbView;
  if (!v) return null; const sec = [...v.secs.values()].find(x => x.meta.session_id === id || x.meta.id === id);
  return sec ? sec.el.querySelector('.ProseMirror')?.innerText || '' : null;
}, [scope, sid]);
const waitSecText = (page, sid, re, scope = NB, timeout = 10000) => page.waitForFunction(([s, id, src]) => {
  const v = s === '#nb-overlay' ? TCNotebook._test.view : document.querySelector(s)?.__nbView;
  if (!v) return false; const sec = [...v.secs.values()].find(x => x.meta.session_id === id || x.meta.id === id);
  return !!sec && new RegExp(src).test(sec.el.querySelector('.ProseMirror')?.innerText || '');
}, [scope, sid, re.source], { timeout });
const secSel = (sid, scope = NB) => `${scope} .nb-sec[data-sec="${sid}"]`;
const sectionIdOf = sessionId => db.group_notebook_sections.find(x => x.session_id === sessionId)?.id;
async function typeInSec(page, sessionId, text, scope = NB) {
  const sel = `${secSel(sectionIdOf(sessionId), scope)} .ProseMirror`;
  await page.click(sel); await page.keyboard.press('Control+End'); await page.keyboard.type(text, { delay: 8 });
}
async function openNbFromCalendar(page, sid) {
  await page.click('#nav-calendar');
  await page.waitForSelector('.gc-nextcard .gc-nc-title');
  await page.click(`.gc-nextcard [data-gc="open"][data-id="${sid}"]`);
  await page.waitForSelector('#gc-modal-box [data-gc="doc"]');
  await page.click('#gc-modal-box [data-gc="doc"]');
  await page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
}
async function studentOpenNb(page) {
  await page.click('.gs-enter [data-gc="doc"]');
  await page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
}

function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  const sub = mk('sub@sol.uy', 'Pablo Suplente', 'teacher', centro.id);
  mk('adm@otra.uy', 'Admin Otra', 'org_admin', otra.id);
  const ana = M.newUser('ana@mail.com', { via: 'student_link' });
  const beto = M.newUser('beto@mail.com', { via: 'student_link' });
  const carl = M.newUser('carl@mail.com', { via: 'student_link' });
  const g = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: prof.id, substitute_id: sub.id, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  const g2 = { id: M.uid(), institution_id: centro.id, name: 'Math 2', teacher_id: sub.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  db.class_groups.push(g, g2);
  const e = (u, name, grp) => { const x = { id: M.uid(), institution_id: centro.id, email: u.email, name, user_id: u.id, loaded_by: adm.id, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(x); db.group_members.push({ group_id: grp.id, enrollment_id: x.id, created_at: new Date(Date.now() - 40 * 864e5).toISOString() }); return x; };
  e(ana, 'Ana Pérez', g); e(beto, 'Beto Ruiz ' + XSS, g); e(carl, 'Carl Otro', g2);
  const mkS = (offMin, dur, title, grp = g) => { const s = { id: M.uid(), institution_id: centro.id, group_id: grp.id, series_id: null, teacher_id: grp.teacher_id, title, starts_at: new Date(Date.now() + offMin * MIN).toISOString(), ends_at: new Date(Date.now() + (offMin + dur) * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
  // the classes of the year so far: older ones first (they get "Clase 1, 2…"); today's class; the next one
  const old = mkS(-5 * 24 * 60, 60, 'Unit 1: greetings');
  const past = mkS(-26 * 60, 60, 'Unit 2: routines');
  const now = mkS(-5, 60, 'Unit 3: making plans');
  const next = mkS(2 * 24 * 60, 60, 'Unit 4: the future');
  db.plannings.push({ id: M.uid(), owner_id: prof.id, institution_id: centro.id, title: 'Making plans (B1)', created_at: new Date().toISOString(),
    data: { params: {}, content: 'Making plans — TEACHER GUIDE\nAnswer key\n1. am going (TEACHER-ONLY)\nMethodology applied\n- pair work',
      student: 'Making plans — worksheet\nActivity 1: complete the sentences\n- I ____ (go) to the beach on Saturday.\nAnswer: am going\n| Name | Weekend plan |\n|---|---|\n| Ana | |\nExit ticket\n- Write 3 plans.' } });
  return { sol, centro, otra, adm, prof, sub, ana, beto, carl, g, g2, old, past, now, next };
}
// an old per-class document (from before the notebook) for a class
async function seedClassDoc(sessionId, paras) {
  const Y = await loadY(); const d = new Y.Doc(); const f = d.getXmlFragment('default');
  paras.forEach((t, i) => { const p = new Y.XmlElement(i === 0 ? 'heading' : 'paragraph'); if (i === 0) p.setAttribute('level', 2); p.insert(0, [new Y.XmlText(t)]); f.insert(f.length, [p]); });
  db.class_docs.push({ session_id: sessionId, state: Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'), state_upto: 0, generation: 1, locked: false, channel_key: 'a'.repeat(64), updated_at: new Date().toISOString() });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('Teacher + student write in the SAME section of the group notebook live (private Realtime channel); outline with a section per class in date order (ES)', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await openNbFromCalendar(T.page, t.now.id);
    // one section per class that already started, in date order, "Clase N · <day>"; today's marked; the future class has none yet
    const outline = await T.page.$$eval(`${NB} .nb-ol-item`, l => l.map(x => x.textContent.trim()));
    if (outline.length !== 3 || !/^Clase 1 · /.test(outline[0]) || !/^Clase 3 · .*Hoy$/.test(outline[2])) throw new Error('outline: ' + JSON.stringify(outline));
    if (!/Cuaderno · English B1 – Tue\/Thu · \d{4}/.test(await T.page.textContent(`${NB} .cd-title`))) throw new Error('title: ' + await T.page.textContent(`${NB} .cd-title`));
    // opened on today's section
    const act = await T.page.$eval(`${NB} .nb-ol-item.on`, x => x.textContent);
    if (!/Hoy/.test(act)) throw new Error('not opened on today: ' + act);
    await typeInSec(T.page, t.now.id, 'Hola clase: hoy hablamos de planes.');
    await studentLogin(S.page, t.ana);
    await studentOpenNb(S.page);
    await waitSecText(S.page, t.now.id, /Hola clase: hoy hablamos de planes\./);
    await typeInSec(S.page, t.now.id, ' Ana: voy a ir a la playa.');
    await waitSecText(T.page, t.now.id, /Ana: voy a ir a la playa\./);
    // the other sections stay as they are
    if ((await secText(T.page, t.past.id)) !== '' && !/^\s*$/.test(await secText(T.page, t.past.id))) throw new Error('past section changed: ' + await secText(T.page, t.past.id));
    await T.page.waitForFunction(() => /En vivo/.test(document.querySelector('#nb-overlay .cd-status')?.textContent || ''));
    await S.page.waitForFunction(() => /En vivo/.test(document.querySelector('#nb-overlay .cd-status')?.textContent || ''));
    const nb = db.group_notebooks[0];
    const joins = M.realtime.log.joins.filter(j => j.topic === 'notebook:' + nb.id && j.priv);
    if (joins.length < 2) throw new Error('private channel joins: ' + JSON.stringify(M.realtime.log.joins));
    await T.page.waitForFunction(() => document.querySelectorAll('#nb-overlay .cd-av').length >= 2, null, { timeout: 8000 });
    const titles = await T.page.$$eval(`${NB} .cd-av`, a => a.map(x => x.title).join('|'));
    if (!/Ana Pérez/.test(titles) || /@/.test(titles)) throw new Error('presence: ' + titles);
    await T.page.waitForFunction(() => /Ana Pérez/.test([...document.querySelectorAll('#nb-overlay .collaboration-cursor__label')].map(x => x.textContent).join('|')), null, { timeout: 8000 });
    // rich text in the section: heading + list typed by the teacher reach the student
    await T.page.click(`${secSel(sectionIdOf(t.now.id))} .ProseMirror`); await T.page.keyboard.press('Control+End'); await T.page.keyboard.press('Enter');
    await T.page.click(`${NB} [data-nb="fmt"][data-k="h3"]`); await T.page.keyboard.type('Vocabulario', { delay: 5 });
    await T.page.keyboard.press('Enter'); await T.page.click(`${NB} [data-nb="fmt"][data-k="ul"]`); await T.page.keyboard.type('going to', { delay: 5 });
    await S.page.waitForFunction(sel => /Vocabulario/.test(document.querySelector(sel + ' h3')?.textContent || '') && /going to/.test(document.querySelector(sel + ' ul')?.textContent || ''), secSel(sectionIdOf(t.now.id)) + ' .ProseMirror', { timeout: 10000 });
    if (await S.page.evaluate(() => window.__xss) || await T.page.evaluate(() => window.__xss)) throw new Error('XSS');
    const un = await untranslated(T.page, NB); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    if (!db.group_notebook_updates.length && !db.group_notebook_sections.some(x => x.state)) throw new Error('nothing persisted');
    await T.page.waitForTimeout(500);
    await shot(T.page, 'two-participants');
  });

  await run('Outline: clicking a class jumps to its section; "Agregar sección de hoy" is idempotent; the next class gets its section when opened from the calendar', browser, async open => {
    const t = seed();
    const T = await open({ viewport: { width: 1366, height: 700 } });
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(id => TCNotebook.open({ group: id }), t.g.id);
    await T.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    // write a lot in today's section so the first one is far up
    await typeInSec(T.page, t.now.id, 'Línea\n'.repeat(1).trim());
    for (let i = 0; i < 12; i++) { await T.page.keyboard.press('Enter'); await T.page.keyboard.type('Párrafo ' + i, { delay: 1 }); }
    const first = sectionIdOf(t.old.id);
    await T.page.click(`${NB} .nb-ol-item[data-sec="${first}"]`);
    await T.page.waitForFunction(id => { const p = document.querySelector('#nb-overlay .nb-page'); const s = document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"]`); const a = s.getBoundingClientRect().top - p.getBoundingClientRect().top; return a >= -2 && a < 40; }, first, { timeout: 4000 });
    if (!(await T.page.$eval(`${NB} .nb-ol-item[data-sec="${first}"]`, b => b.classList.contains('on') && b.getAttribute('aria-current') === 'true'))) throw new Error('outline item not marked');
    // jump back to today
    await T.page.click(`${NB} .nb-ol-item.today`);
    await T.page.waitForFunction(id => { const p = document.querySelector('#nb-overlay .nb-page'); const s = document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"]`); const a = s.getBoundingClientRect().top - p.getBoundingClientRect().top; return a >= -2 && a < 40; }, sectionIdOf(t.now.id), { timeout: 4000 });
    // "Agregar sección de hoy": today's class already has its section → nothing new
    const n0 = db.group_notebook_sections.length;
    await T.page.click(`${NB} [data-nb="today"]`);
    await waitToast(T.page, /La sección de hoy ya estaba/);
    if (db.group_notebook_sections.length !== n0) throw new Error('duplicate section');
    await T.page.evaluate(() => TCNotebook.close());
    // the next class (not started): opening its notebook from the calendar adds its section, once
    await T.page.evaluate(id => TCNotebook.open({ session: id }), t.next.id);
    await T.page.waitForSelector(`${NB}.active .nb-ol-item:nth-child(1)`);
    await T.page.waitForFunction(() => document.querySelectorAll('#nb-overlay .nb-ol-item').length === 4);
    await T.page.evaluate(() => TCNotebook.close());
    await T.page.evaluate(id => TCNotebook.open({ session: id }), t.next.id);
    await T.page.waitForFunction(() => document.querySelectorAll('#nb-overlay .nb-ol-item').length === 4);
    if (db.group_notebook_sections.filter(x => x.session_id === t.next.id).length !== 1) throw new Error('next class section count');
    const on = await T.page.$eval(`${NB} .nb-ol-item.on`, x => x.dataset.sec);
    if (on !== sectionIdOf(t.next.id)) throw new Error('not opened on the requested class');
  });

  await run('Generator → "Enviar al cuaderno del grupo": picker (group, class: next by default, what to send) → the student handout WITHOUT answers lands in that class\'s section as rich text; teacher guide only as a teacher-only note', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    const p = db.plannings[0];
    // a saved class open in the generator (its student handout is ready)
    await T.page.evaluate(id => loadPlannings().then(() => openClass(id)), p.id); // a saved class in the generator (its handout is ready)
    await T.page.waitForSelector('#btn-send-notebook');
    await T.page.click('#btn-send-notebook');
    await T.page.waitForSelector('#nb-send.active #nb-send-session');
    const def = await T.page.$eval('#nb-send-session', s => s.value);
    if (def !== t.now.id) throw new Error('default class is not the current / next one: ' + def);
    const opts = await T.page.$$eval('#nb-send-session option', l => l.map(o => o.textContent));
    if (!opts.some(o => /Clase 3 · .*Unit 3: making plans · Hoy/.test(o)) || !/sección nueva sin clase/.test(opts[opts.length - 1])) throw new Error('class options: ' + JSON.stringify(opts));
    if (!(await T.page.isChecked('input[name="nb-send-what"][value="student"]'))) throw new Error('student handout not the default');
    const un = await untranslated(T.page, '#nb-send'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(T.page, 'send-picker', '#nb-send .cd-sheet-box');
    await T.page.check('#nb-send-attach');
    await T.page.click('#nb-send-go');
    await T.page.waitForSelector('#nb-send [data-nb-send="open-nb"]');
    await waitToast(T.page, /Enviado al cuaderno del grupo/);
    if (db.class_sessions.find(x => x.id === t.now.id).planning_id !== p.id) throw new Error('plan not attached');
    await T.page.click('#nb-send [data-nb-send="open-nb"]');
    await T.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    await waitSecText(T.page, t.now.id, /I ____ \(go\) to the beach on Saturday\./);
    const txt = await secText(T.page, t.now.id);
    if (!/Write 3 plans\./.test(txt) || /am going|TEACHER|Answer|Methodology/i.test(txt)) throw new Error('handout wrong / answers leaked: ' + txt);
    if (!(await T.page.$(`${secSel(sectionIdOf(t.now.id))} table`)) || !(await T.page.$(`${secSel(sectionIdOf(t.now.id))} h2`))) throw new Error('not rich text (table / heading)');
    for (const other of [t.old.id, t.past.id]) if (/beach/.test(await secText(T.page, other))) throw new Error('inserted into the wrong section');
    // the student sees it in that section
    await studentLogin(S.page, t.ana); await studentOpenNb(S.page);
    await waitSecText(S.page, t.now.id, /to the beach on Saturday/);
    // teacher guide → only a teacher note in that section (never the shared notebook)
    await T.page.evaluate(() => TCNotebook.close());
    await T.page.click('#btn-send-notebook');
    await T.page.waitForSelector('#nb-send.active #nb-send-session');
    await T.page.check('input[name="nb-send-what"][value="guide"]');
    await T.page.click('#nb-send-go');
    await waitToast(T.page, /Nota docente guardada/);
    if (db.group_notebook_notes.length !== 1 || !/Answer key/.test(db.group_notebook_notes[0].body) || db.group_notebook_notes[0].section_id !== sectionIdOf(t.now.id)) throw new Error('teacher note: ' + JSON.stringify(db.group_notebook_notes));
    if (db.group_notebook_updates.some(u => /Answer key|TEACHER/.test(Buffer.from(u.d, 'base64').toString('latin1')))) throw new Error('the guide went into the shared notebook');
    await T.page.click('#nb-send [data-nb-send="open-nb"]');
    await T.page.waitForSelector(`${NB}.active`); await T.page.waitForSelector(`${secSel(sectionIdOf(t.now.id))} .nb-notes:not([hidden])`);
    const r = await S.page.evaluate(id => sb.rpc('notebook_notes', { p_notebook: id }).then(x => x.error?.message || 'ok'), db.group_notebooks[0].id);
    if (!/No autorizado/.test(r)) throw new Error('student read teacher notes: ' + r);
    if (await S.page.$(`${NB} .nb-notes:not([hidden])`)) throw new Error('student sees a notes box');
    // a new section without a class (title = the class title)
    await T.page.evaluate(() => TCNotebook.close());
    await T.page.click('#btn-send-notebook'); await T.page.waitForSelector('#nb-send.active #nb-send-session');
    await T.page.selectOption('#nb-send-session', '__new');
    await T.page.click('#nb-send-go'); await waitToast(T.page, /Enviado al cuaderno del grupo/);
    const free = db.group_notebook_sections.find(x => !x.session_id);
    if (!free || free.title !== 'Making plans (B1)') throw new Error('free section: ' + JSON.stringify(free));
  });

  await run('"Pegar una clase" inside the notebook targets the current section; previous class documents are linked and can be imported (originals kept)', browser, async open => {
    const t = seed();
    await seedClassDoc(t.past.id, ['Resumen de la clase 2', 'Hicimos ejercicios de rutinas.']);
    const T = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(id => TCNotebook.open({ session: id }), t.now.id);
    await T.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    await T.page.click(`${secSel(sectionIdOf(t.past.id))} .ProseMirror`);
    await T.page.click(`${NB} [data-nb="paste"]`);
    await T.page.waitForSelector(`${NB} .cd-pick-list`);
    if (!/Clase 2/.test(await T.page.textContent(`${NB} .cd-sheet-sub`))) throw new Error('paste target: ' + await T.page.textContent(`${NB} .cd-sheet-sub`));
    await T.page.click(`${NB} .cd-pick [data-nb="paste-pick"]`);
    await waitToast(T.page, /Material del alumno insertado/);
    const txt = await secText(T.page, t.past.id);
    if (!/beach on Saturday/.test(txt) || /am going|Answer/i.test(txt)) throw new Error('paste: ' + txt);
    if (/beach/.test(await secText(T.page, t.now.id))) throw new Error('pasted into the wrong section');
    // the previous document of class 2: linked, opens on top, can be imported
    const legacy = `${secSel(sectionIdOf(t.past.id))} [data-nb="legacy"]`;
    if (!(await T.page.$(legacy))) throw new Error('no link to the previous document');
    if (await T.page.$(`${secSel(sectionIdOf(t.now.id))} [data-nb="legacy"]`)) throw new Error('legacy link on a class without one');
    await T.page.click(legacy);
    await T.page.waitForFunction(() => /Hicimos ejercicios de rutinas/.test(document.querySelector('#cd-overlay .cd-prose')?.innerText || ''), null, { timeout: 8000 });
    const z = await T.page.evaluate(() => [getComputedStyle(document.getElementById('cd-overlay')).zIndex, getComputedStyle(document.getElementById('nb-overlay')).zIndex]);
    if (!(Number(z[0]) > Number(z[1]))) throw new Error('previous document behind the notebook: ' + z);
    await T.page.evaluate(() => TCClassDoc.close());
    await T.page.click(`${secSel(sectionIdOf(t.past.id))} [data-nb="import"]`); await T.page.click(`${secSel(sectionIdOf(t.past.id))} [data-nb="import"]`);
    await waitToast(T.page, /Documento anterior importado/);
    await waitSecText(T.page, t.past.id, /Hicimos ejercicios de rutinas\./);
    if (!db.class_docs.some(d => d.session_id === t.past.id)) throw new Error('the original was removed');
  });

  await run('Lock: "only past classes" → the student writes today but not in a past class (UI + database); whole lock → nothing; unlock', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openNbFromCalendar(T.page, t.now.id);
    await studentLogin(S.page, t.ana); await studentOpenNb(S.page);
    await T.page.click(`${NB} [data-nb="lock-menu"]`); await T.page.click(`${NB} [data-nb="lock"][data-mode="past"]`);
    await waitToast(T.page, /Clases anteriores bloqueadas/);
    await S.page.waitForFunction(id => document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"] .ProseMirror`)?.getAttribute('contenteditable') === 'false', sectionIdOf(t.past.id), { timeout: 20000 });
    if ((await S.page.$eval(`${secSel(sectionIdOf(t.now.id))} .ProseMirror`, x => x.getAttribute('contenteditable'))) !== 'true') throw new Error('today locked too');
    if (!/clases anteriores están bloqueadas/.test(await S.page.textContent(`${NB} .cd-notice`))) throw new Error('notice: ' + await S.page.textContent(`${NB} .cd-notice`));
    const nb = db.group_notebooks[0].id;
    const r = await S.page.evaluate(([n, s]) => sb.rpc('notebook_push', { p_notebook: n, p_section: s, p_generation: 1, p_update: btoa('x'), p_client: '1' }).then(x => x.error?.message || 'ok'), [nb, sectionIdOf(t.past.id)]);
    if (!/clases anteriores/.test(r)) throw new Error('database accepted a past push: ' + r);
    await typeInSec(S.page, t.now.id, 'Ana hoy.');
    await waitSecText(T.page, t.now.id, /Ana hoy\./);
    await T.page.click(`${NB} [data-nb="lock-menu"]`); await T.page.click(`${NB} [data-nb="lock"][data-mode="all"]`);
    await S.page.waitForFunction(id => document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"] .ProseMirror`)?.getAttribute('contenteditable') === 'false', sectionIdOf(t.now.id), { timeout: 20000 });
    if (await S.page.isVisible(`${NB} .cd-toolbar`)) throw new Error('toolbar while locked');
    await T.page.click(`${NB} [data-nb="lock-menu"]`); await T.page.click(`${NB} [data-nb="lock"][data-mode="none"]`);
    await S.page.waitForFunction(id => document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"] .ProseMirror`)?.getAttribute('contenteditable') === 'true', sectionIdOf(t.past.id), { timeout: 20000 });
  });

  await run('Live room: the "Documento" tab opens the GROUP notebook on today\'s section and "Pizarra" the group board on today\'s page; typing reaches a student', browser, async open => {
    const t = seed();
    const T = await open({ viewport: { width: 1440, height: 900 } }); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await T.page.click('.gc-nextcard [data-gc="join"]');
    await T.page.waitForSelector('#panel-live.active #lc-joinas');
    await T.page.check('#lc-consent');
    await T.page.click('#lc-join');
    await T.page.waitForSelector('#lc-room');
    // the class started: its section exists even before anyone opens the notebook
    await T.page.waitForFunction(() => true); await new Promise(r => setTimeout(r, 400));
    if (!sectionIdOf(t.now.id)) throw new Error('section not created when the class started');
    await T.page.click('#lc-tab-doc');
    await T.page.waitForSelector('#lc-side-doc .nb-sec .ProseMirror');
    const sel = await T.page.$eval('#lc-side-doc .nb-jump-sel', s => s.options[s.selectedIndex].textContent);
    if (!/Clase 3 · .*Hoy/.test(sel)) throw new Error('not on today: ' + sel);
    await typeInSec(T.page, t.now.id, 'Escriban sus planes acá 👇', '#lc-side-doc');
    await studentLogin(S.page, t.ana); await studentOpenNb(S.page);
    await waitSecText(S.page, t.now.id, /Escriban sus planes acá/);
    await typeInSec(S.page, t.now.id, ' Voy a estudiar.');
    await waitSecText(T.page, t.now.id, /Voy a estudiar\./, '#lc-side-doc');
    await shot(T.page, 'live-tabs-doc');
    // Pizarra: the group board, today's page selected, the other classes as pages
    await T.page.click('#lc-tab-board');
    await T.page.waitForSelector('#lc-side-board .cb-page-sel');
    await T.page.waitForSelector('#lc-side-board .excalidraw canvas.interactive', { timeout: 25000 });
    const pg = await T.page.$eval('#lc-side-board .cb-page-sel', s => ({ v: s.value, n: s.options.length, t: s.options[s.selectedIndex].textContent }));
    if (pg.v !== t.now.id || pg.n !== 4 || !/Clase 3 · .*Hoy/.test(pg.t)) throw new Error('board page: ' + JSON.stringify(pg));
    await shot(T.page, 'live-tabs-board');
    // ending the class keeps an "end of class" version of the notebook
    await T.page.click('#lc-ctl-end'); await T.page.click('#lc-end-confirm').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    if (!db.group_notebook_versions.some(v => v.label === 'class_end')) throw new Error('no class_end version: ' + JSON.stringify(db.group_notebook_versions.map(v => v.label)));
    const un = await untranslated(T.page, '#panel-live'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
  });

  await run('Group board page selector: a page per class of the year ("Hoy" by default), ‹ › and the select switch to that class\'s board (its old drawing kept)', browser, async open => {
    const t = seed();
    // the board that class 2 already had (before the group board) is its page
    const el = (id, type) => ({ id, type, version: 1, versionNonce: 11, isDeleted: false, x: 80, y: 60, width: 220, height: 120, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, boundElements: null, updated: 1, link: null, locked: false, index: 'a0' });
    db.class_boards.push({ session_id: t.past.id, rev: 1, generation: 1, locked: false, bytes: 500, channel_key: 'c'.repeat(64), updated_at: new Date().toISOString() });
    const x = el('old1', 'ellipse'); db.class_board_elements.push({ session_id: t.past.id, element_id: x.id, version: 1, nonce: 11, deleted: false, rev: 1, data: x, bytes: 300 });
    const S = await open();
    await studentLogin(S.page, t.ana);
    await S.page.click(`.gs-groups [data-gc="board-group"][data-id="${t.g.id}"]`);
    await S.page.waitForSelector('#cb-overlay.active .cb-page-sel');
    await S.page.waitForSelector('#cb-overlay .excalidraw canvas.interactive', { timeout: 25000 });
    const sel = () => S.page.$eval('#cb-overlay .cb-page-sel', s => ({ v: s.value, opts: [...s.options].map(o => o.textContent) }));
    let p = await sel();
    if (p.v !== t.now.id || p.opts.length !== 4 || !/^Clase 1 · /.test(p.opts[0]) || !/Hoy/.test(p.opts[2])) throw new Error('pages: ' + JSON.stringify(p));
    await shot(S.page, 'board-pages');
    await S.page.click('#cb-overlay [data-cb="page-prev"]');
    await S.page.waitForFunction(id => TCClassBoard._test.view?.sid === id && !!TCClassBoard._test.view.api, t.past.id, { timeout: 20000 });
    await S.page.waitForFunction(() => TCClassBoard._test.view.api.getSceneElements().some(e => e.type === 'ellipse'), null, { timeout: 8000 });
    p = await sel(); if (p.v !== t.past.id) throw new Error('select not on the previous page: ' + p.v);
    await S.page.click('#cb-overlay [data-cb="page-today"]');
    await S.page.waitForFunction(id => TCClassBoard._test.view?.sid === id, t.now.id, { timeout: 20000 });
    await S.page.selectOption('#cb-overlay .cb-page-sel', t.next.id);
    await S.page.waitForFunction(id => TCClassBoard._test.view?.sid === id && !!TCClassBoard._test.view.api, t.next.id, { timeout: 20000 });
    const un = await untranslated(S.page, '#cb-overlay .cb-pages'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
  });

  await run('Admin: group card → Cuaderno READ-ONLY (no toolbar / lock / paste / notes, database refuses writes); other-institution admin and a student of another group refused', browser, async open => {
    const t = seed();
    // the teacher's class already wrote something
    const T = await open(); await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(id => TCNotebook.open({ session: id }), t.now.id);
    await T.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    await typeInSec(T.page, t.now.id, 'Resumen para la dirección.');
    await T.page.waitForFunction(() => !/Guardando/.test(document.querySelector('#nb-overlay .cd-status')?.textContent || ''));
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(id => { currentOrgId = id; }, t.centro.id);
    await A.page.click('#nav-groups');
    await A.page.waitForSelector('#panel-groups.active .gc-gcard');
    await A.page.locator('.gc-gcard', { hasText: 'English B1' }).locator('[data-gc="nb-group"]').click();
    await A.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    await waitSecText(A.page, t.now.id, /Resumen para la dirección\./);
    if (await A.page.$$eval(`${NB} .ProseMirror`, l => l.some(x => x.getAttribute('contenteditable') !== 'false'))) throw new Error('admin can edit');
    if (await A.page.isVisible(`${NB} .cd-toolbar`)) throw new Error('toolbar for admin');
    for (const k of ['lock-menu', 'paste', 'today']) if (await A.page.isVisible(`${NB} [data-nb="${k}"]`)) throw new Error('teacher action for admin: ' + k);
    if (!/Solo lectura/.test(await A.page.textContent(`${NB} .cd-notice`))) throw new Error('no read-only notice');
    const nb = db.group_notebooks[0].id;
    const r = await A.page.evaluate(([n, s]) => sb.rpc('notebook_push', { p_notebook: n, p_section: s, p_generation: 1, p_update: btoa('x'), p_client: '9' }).then(x => x.error?.message || 'ok'), [nb, sectionIdOf(t.now.id)]);
    if (!/Solo lectura/.test(r)) throw new Error('admin push: ' + r);
    await A.page.click(`${NB} [data-nb="history"]`); await A.page.waitForSelector(`${NB} .cd-sheet-box`);
    if (await A.page.$(`${NB} [data-nb="ver-save"]`)) throw new Error('admin can save versions');
    await A.page.click(`${NB} [data-nb="sheet-close"]`);
    const un = await untranslated(A.page, NB); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(A.page, 'admin-readonly');
    const O = await open(); await login(O.page, 'adm@otra.uy');
    const ro = await O.page.evaluate(id => sb.rpc('notebook_open', { p_notebook: id }).then(x => x.error?.message || 'ok'), nb);
    if (!/No autorizado/.test(ro)) throw new Error('other admin: ' + ro);
    const C = await open(); await studentLogin(C.page, t.carl).catch(() => {});
    const rc = await C.page.evaluate(id => sb.rpc('notebook_open', { p_notebook: id }).then(x => x.error?.message || 'ok'), nb);
    if (!/No autorizado/.test(rc)) throw new Error('student of another group: ' + rc);
  });

  await run('History + export: the teacher saves a version, changes text and restores it (student follows); whole-notebook HTML and one-section Markdown', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openNbFromCalendar(T.page, t.now.id);
    await typeInSec(T.page, t.now.id, 'Versión uno.');
    await typeInSec(T.page, t.past.id, 'Clase dos <b>negrita</b>.');
    await T.page.waitForFunction(() => !/Guardando/.test(document.querySelector('#nb-overlay .cd-status')?.textContent || ''));
    await T.page.click(`${NB} [data-nb="history"]`); await T.page.click(`${NB} [data-nb="ver-save"]`);
    await waitToast(T.page, /Versión guardada/);
    await T.page.click(`${NB} [data-nb="sheet-close"]`);
    await T.page.click(`${secSel(sectionIdOf(t.now.id))} .ProseMirror`); await T.page.keyboard.press('Control+a'); await T.page.keyboard.type('Texto equivocado.', { delay: 5 });
    await studentLogin(S.page, t.ana); await studentOpenNb(S.page);
    await waitSecText(S.page, t.now.id, /Texto equivocado\./);
    await T.page.click(`${NB} [data-nb="history"]`); await T.page.waitForSelector(`${NB} .cd-ver-open`);
    await T.page.click(`${NB} .cd-ver-open`);
    await T.page.waitForFunction(() => /Versión uno\./.test(document.querySelector('#nb-overlay .nb-preview')?.innerText || ''));
    await T.page.click(`${NB} [data-nb="ver-restore"]`); await T.page.click(`${NB} [data-nb="ver-restore"]`);
    await waitToast(T.page, /Versión restaurada/);
    await waitSecText(T.page, t.now.id, /Versión uno\./); if (/Texto equivocado/.test(await secText(T.page, t.now.id))) throw new Error("teacher kept the old text");
    await waitSecText(S.page, t.now.id, /Versión uno\./, NB, 15000); // (the teacher's cursor label may be in the text)
    if (/Texto equivocado/.test(await secText(S.page, t.now.id))) throw new Error('student kept the old text');
    const r = await S.page.evaluate(id => sb.rpc('notebook_restore', { p_version: id }).then(x => x.error?.message || 'ok'), db.group_notebook_versions[0].id);
    if (!/No autorizado/.test(r)) throw new Error('student restore: ' + r);
    // export
    await T.page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed = document.body.classList.contains('nb-printing') ? (document.querySelector('#nb-overlay .nb-print-one') ? 2 : 1) : -1; }; });
    await T.page.click(`${NB} [data-nb="export-menu"]`); await T.page.click(`${NB} [data-nb="print"][data-scope="all"]`);
    if (await T.page.evaluate(() => window.__printed) !== 1) throw new Error('print whole');
    await T.page.click(`${NB} .nb-ol-item[data-sec="${sectionIdOf(t.past.id)}"]`);
    await T.page.click(`${NB} [data-nb="export-menu"]`); await T.page.click(`${NB} [data-nb="print"][data-scope="one"]`);
    if (await T.page.evaluate(() => window.__printed) !== 2) throw new Error('print one section');
    await T.page.click(`${NB} [data-nb="export-menu"]`);
    const [dl] = await Promise.all([T.page.waitForEvent('download'), T.page.click(`${NB} [data-nb="dl-html"][data-scope="all"]`)]);
    const html = fs.readFileSync(await dl.path(), 'utf8');
    if (!/Clase 2 · /.test(html) || !/Clase 3 · /.test(html) || !/Versión uno\./.test(html) || !/&lt;b&gt;negrita&lt;\/b&gt;/.test(html) || /<b>negrita<\/b>/.test(html)) throw new Error('html export: ' + html.slice(0, 600));
    await T.page.click(`${NB} [data-nb="export-menu"]`);
    const [dl2] = await Promise.all([T.page.waitForEvent('download'), T.page.click(`${NB} [data-nb="dl-md"][data-scope="one"]`)]);
    const md = fs.readFileSync(await dl2.path(), 'utf8');
    if (!/^## Clase 2 · /m.test(md) || /Clase 3 · /.test(md) || !/negrita/.test(md)) throw new Error('markdown export: ' + md);
    if (!/clase-2\.md$/.test(dl2.suggestedFilename())) throw new Error('md name: ' + dl2.suggestedFilename());
  });

  await run('Quick rooms keep working without a notebook (hint shown); a one-off class keeps its own class document', browser, async open => {
    const t = seed();
    const one = { id: M.uid(), institution_id: t.centro.id, group_id: null, series_id: null, teacher_id: t.prof.id, title: 'Clase suelta', starts_at: new Date(Date.now() - 5 * MIN).toISOString(), ends_at: new Date(Date.now() + 55 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() };
    db.class_sessions.push(one);
    const T = await open(); await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-live');
    await T.page.waitForSelector('#lc-nb-hint');
    if (!/Para tener cuaderno y pizarra, entrá desde una clase del Calendario\./.test(await T.page.textContent('#lc-nb-hint'))) throw new Error('hint: ' + await T.page.textContent('#lc-nb-hint'));
    await T.page.evaluate(id => TCNotebook.open({ session: id }), one.id);
    await T.page.waitForSelector('#cd-overlay.active .cd-prose');
    if (await T.page.$('#nb-overlay.active')) throw new Error('a notebook opened for a one-off class');
    if (db.group_notebooks.length) throw new Error('a notebook was created');
  });

  await run('Admin Panel: the school year starts in March (stored for the unit; a unit below inherits it unless it chooses its own)', browser, async open => {
    const t = seed();
    const A = await open(); await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(id => { currentOrgId = id; }, t.sol.id);
    await A.page.click('#nav-admin');
    await A.page.waitForSelector('#schoolyear-card #schoolyear-month:not([disabled])');
    const opts = await A.page.$$eval('#schoolyear-month option', l => l.map(o => o.textContent));
    if (opts.length !== 12 || !/^Enero — año calendario$/.test(opts[0]) || await A.page.$eval('#schoolyear-month', s => s.value) !== '1') throw new Error('options: ' + JSON.stringify(opts));
    await A.page.selectOption('#schoolyear-month', '3');
    await waitToast(A.page, /Guardado: se actualizó el año lectivo/);
    if (t.sol.school_year_start_month !== 3) throw new Error('not stored: ' + t.sol.school_year_start_month);
    const un = await untranslated(A.page, '#schoolyear-card'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await A.page.evaluate(id => { currentOrgId = id; renderDashboard(); }, t.centro.id);
    await A.page.waitForFunction(() => /Igual que la unidad de arriba \(Marzo\)/.test(document.querySelector('#schoolyear-month option')?.textContent || '') && document.getElementById('schoolyear-month').value === '');
    const T = await open(); await login(T.page, 'prof@sol.uy');
    const r = await T.page.evaluate(id => sb.rpc('set_school_year_start', { p_unit: id, p_month: 9 }).then(x => x.error?.message || 'ok'), t.sol.id);
    if (!/No autorizado/.test(r)) throw new Error('teacher changed the school year: ' + r);
  });

  await run('Mobile: the student opens the group notebook from the dashboard ("Go to" select instead of the outline, today\'s section, no horizontal scroll)', browser, async open => {
    const t = seed();
    const S = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await studentLogin(S.page, t.ana);
    await S.page.click(`.gs-docs-card [data-gc="nb-group"][data-id="${t.g.id}"]`);
    await S.page.waitForSelector(`${NB}.active .nb-sec .ProseMirror`);
    if (await S.page.isVisible(`${NB} .nb-outline`)) throw new Error('outline column on a phone');
    if (!(await S.page.isVisible(`${NB} .nb-jump-sel`))) throw new Error('no "Go to" select');
    await typeInSec(S.page, t.now.id, 'Voy a correr.');
    await S.page.selectOption(`${NB} .nb-jump-sel`, sectionIdOf(t.old.id));
    await S.page.waitForFunction(id => { const p = document.querySelector('#nb-overlay .nb-page'); const s = document.querySelector(`#nb-overlay .nb-sec[data-sec="${id}"]`); const a = s.getBoundingClientRect().top - p.getBoundingClientRect().top; return a >= -2 && a < 40; }, sectionIdOf(t.old.id), { timeout: 4000 });
    await S.page.selectOption(`${NB} .nb-jump-sel`, sectionIdOf(t.now.id));
    const over = await S.page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, box: document.querySelector('#nb-overlay .cd-overlay-box').scrollWidth - document.querySelector('#nb-overlay .cd-overlay-box').clientWidth }));
    if (over.doc > 1 || over.box > 1) throw new Error('horizontal scroll: ' + JSON.stringify(over));
    await S.page.waitForTimeout(300);
    await shot(S.page, 'mobile');
  });

  await browser.close();
  if (failed) { console.log(`${failed} group-notebook scenario(s) failed`); process.exit(1); }
  console.log('All group-notebook scenarios passed');
})();
