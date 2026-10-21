// Class whiteboard ("Pizarra", Excalidraw): two browser contexts (teacher + student) drawing on the same board live through
// the simulated Realtime broadcast (tests/mock-realtime.cjs) and the access-checked RPCs (tests/mock-classboard.cjs), lock,
// admin read-only from the group card, the board inside the live room (+ full screen), polling fallback without Realtime,
// history + restore, PNG / SVG export, images refused, mobile (touch drawing). Mock Supabase in headless Chromium.
// The app under the REAL CSP headers is covered by tests/e2e-csp.cjs (it opens a board too).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-classboard.cjs   (SHOTS=<dir> saves wb-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';

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
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(700);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/wb-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/wb-${name}.png` });
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || /^(PNG|SVG)$/.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return out;
}, sel);

// ── board helpers ──
const SCOPE = '#cb-overlay';
const view = (page, scope = SCOPE) => page.evaluate(s => !!document.querySelector(s + ' .excalidraw'), scope);
async function waitBoard(page, scope = SCOPE) {
  await page.waitForSelector(scope + ' .excalidraw canvas.interactive', { timeout: 25000 });
  await page.waitForFunction(s => { const v = s === '#cb-overlay' ? TCClassBoard._test.view : window.__lcBoard?.(); return !!(v && v.api); }, scope, { timeout: 15000 }).catch(() => {});
}
// elements on screen (live scene of the board in that scope), as "type" list
const scene = (page, scope = SCOPE) => page.evaluate(s => {
  const v = s === '#cb-overlay' ? TCClassBoard._test.view : window.__lcBoard?.();
  return v && v.api ? v.api.getSceneElements().map(e => e.type) : null;
}, scope);
const waitScene = (page, pred, scope = SCOPE, timeout = 8000) => page.waitForFunction(([s, src]) => {
  const v = s === '#cb-overlay' ? TCClassBoard._test.view : window.__lcBoard?.();
  if (!v || !v.api) return false; const types = v.api.getSceneElements().map(e => e.type);
  return new Function('t', 'return ' + src)(types);
}, [scope, pred], { timeout });
async function pickTool(page, tool, scope = SCOPE) {
  await page.click(`${scope} label:has([data-testid="toolbar-${tool}"])`);
}
async function drag(page, from, to, scope = SCOPE) {
  const box = await page.locator(scope + ' .excalidraw canvas.interactive').boundingBox();
  await page.mouse.move(box.x + from[0], box.y + from[1]); await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 }); await page.mouse.up();
}
const stored = sid => db.class_board_elements.filter(e => e.session_id === sid && !e.deleted).map(e => e.data.type).sort();
const waitStored = async (sid, pred, timeout = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (pred(stored(sid))) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('stored: ' + JSON.stringify(stored(sid))); };
const el = (id, type, ver = 1, extra = {}) => ({ id, type, version: ver, versionNonce: 1000 + ver, isDeleted: false, x: 80, y: 60, width: 220, height: 120, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, boundElements: null, updated: 1, link: null, locked: false, index: 'a' + id.length, ...extra });
function seedBoard(sid, els) {
  db.class_boards.push({ session_id: sid, rev: 1, generation: 1, locked: false, bytes: 1000, channel_key: 'b'.repeat(64), updated_at: new Date().toISOString() });
  els.forEach(x => db.class_board_elements.push({ session_id: sid, element_id: x.id, version: x.version, nonce: x.versionNonce, deleted: false, rev: 1, data: x, bytes: JSON.stringify(x).length }));
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
  const now = mkS(-5, 60, 'Unit 3: making plans');
  const past = mkS(-26 * 60, 60, 'Unit 2: routines');
  return { sol, centro, otra, adm, prof, sub, ana, beto, carl, g, g2, now, past };
}
async function openBoardFromCalendar(page, sid) {
  await page.click('#nav-calendar');
  await page.waitForSelector('.gc-nextcard .gc-nc-title');
  await page.click(`.gc-nextcard [data-gc="open"][data-id="${sid}"]`);
  await page.waitForSelector('#gc-modal-box [data-gc="board"]');
  await page.click('#gc-modal-box [data-gc="board"]');
  await waitBoard(page);
}
async function studentOpenBoard(page) {
  await page.click('.gs-enter [data-gc="board"]');
  await waitBoard(page);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('Two participants (teacher + student, two browsers) draw on the same board and see each other live (private Realtime channel, names from the database, ES)', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await openBoardFromCalendar(T.page, t.now.id);
    if (await T.page.evaluate(() => TCClassBoard._test.view.api.getAppState().viewModeEnabled)) throw new Error('teacher in view mode');
    await studentLogin(S.page, t.ana);
    await studentOpenBoard(S.page);
    // the teacher draws a rectangle → the student sees it (broadcast, before the database round trip) and it is stored
    await pickTool(T.page, 'rectangle'); await drag(T.page, [380, 220], [620, 380]);
    const t0 = Date.now();
    await waitScene(S.page, "t.includes('rectangle')", SCOPE, 4000);
    const ms = Date.now() - t0;
    await waitStored(t.now.id, s => s.includes('rectangle'));
    if (!M.realtime.log.broadcasts.some(b => b.event === 'els' && b.topic === 'realtime:classboard:' + t.now.id)) throw new Error('elements did not travel on the private channel: ' + JSON.stringify(M.realtime.log.broadcasts.slice(0, 5)));
    // the student draws an ellipse and a free-hand stroke → the teacher sees both
    await pickTool(S.page, 'ellipse'); await drag(S.page, [700, 260], [880, 400]);
    await pickTool(S.page, 'freedraw'); await drag(S.page, [420, 480], [700, 560]);
    await waitScene(T.page, "t.includes('ellipse') && t.includes('freedraw') && t.includes('rectangle')");
    await waitStored(t.now.id, s => s.includes('ellipse') && s.includes('freedraw') && s.includes('rectangle'));
    // both on the PRIVATE channel, live; presence names from the database (Ana Pérez, never an email)
    const joins = M.realtime.log.joins.filter(j => j.topic === 'classboard:' + t.now.id && j.priv);
    if (joins.length < 2) throw new Error('private channel joins: ' + JSON.stringify(M.realtime.log.joins));
    await T.page.waitForFunction(() => /En vivo/.test(document.querySelector('#cb-overlay .cd-status')?.textContent || ''));
    await T.page.waitForFunction(() => document.querySelectorAll('#cb-overlay .cd-av').length >= 2, null, { timeout: 8000 });
    const titles = await T.page.$$eval('#cb-overlay .cd-av', a => a.map(x => x.title).join('|'));
    if (!/Ana Pérez/.test(titles) || /@/.test(titles)) throw new Error('presence: ' + titles);
    // the student's pointer reaches the teacher as an Excalidraw collaborator with the name from the database
    const box = await S.page.locator('#cb-overlay canvas.interactive').boundingBox();
    await S.page.mouse.move(box.x + 300, box.y + 300); await S.page.mouse.move(box.x + 320, box.y + 310, { steps: 3 });
    await T.page.waitForFunction(() => [...TCClassBoard._test.view.api.getAppState().collaborators.values()].some(c => c.username === 'Ana Pérez' && c.pointer), null, { timeout: 8000 });
    // concurrent edits converge: the same element moved on both sides ends up identical (version / versionNonce)
    const ids = await T.page.evaluate(() => TCClassBoard._test.view.api.getSceneElements().map(e => e.id + ':' + e.version).sort().join(','));
    await S.page.waitForFunction(x => TCClassBoard._test.view.api.getSceneElements().map(e => e.id + ':' + e.version).sort().join(',') === x, ids, { timeout: 8000 });
    // the Spanish UI (Excalidraw in es-ES) and our header
    const lbl = await T.page.getAttribute('#cb-overlay [data-testid="toolbar-rectangle"]', 'aria-label');
    if (!/Rectángulo/.test(lbl || '')) throw new Error('Excalidraw not in Spanish: ' + lbl);
    const un = await untranslated(T.page, '#cb-overlay .cb-head'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    if (await S.page.evaluate(() => window.__xss) || await T.page.evaluate(() => window.__xss)) throw new Error('XSS');
    // images are not offered
    if (await T.page.$('#cb-overlay [data-testid="toolbar-image"]')) throw new Error('image tool visible');
    console.log('    (the rectangle was on the student\'s screen ' + ms + ' ms after the stroke ended)');
    await shot(T.page, 'two-participants');
  });

  await run('Lock: the teacher locks → the student can only look (UI, database and Realtime); unlock → drawing again', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openBoardFromCalendar(T.page, t.now.id);
    await studentLogin(S.page, t.ana); await studentOpenBoard(S.page);
    await T.page.click('#cb-overlay [data-cb="lock"]');
    await waitToast(T.page, /Bloqueada: los estudiantes pueden mirar/);
    await S.page.waitForFunction(() => TCClassBoard._test.view.api.getAppState().viewModeEnabled === true, null, { timeout: 8000 });
    const note = await S.page.textContent('#cb-overlay .cd-notice');
    if (!/El docente bloqueó la pizarra/.test(note)) throw new Error('student notice: ' + note);
    if (await S.page.isVisible('#cb-overlay [data-testid="toolbar-rectangle"]')) throw new Error('drawing tools visible while locked');
    await drag(S.page, [400, 300], [600, 420]); await S.page.waitForTimeout(700);
    if ((await scene(S.page)).length) throw new Error('student drew while locked');
    const r = await S.page.evaluate(id => sb.rpc('classboard_push', { p_session: id, p_generation: 1, p_elements: [{ id: 'hack1', type: 'rectangle', version: 1, versionNonce: 1 }], p_client: 'x' }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/bloqueó/.test(r)) throw new Error('database accepted a locked push: ' + r);
    // the Realtime policy refuses the student's broadcasts while locked (a new join re-checks it)
    if (M.classBoard.canRealtime({ id: t.ana.id }, 'classboard:' + t.now.id, true)) throw new Error('Realtime send allowed while locked');
    if (!M.classBoard.canRealtime({ id: t.ana.id }, 'classboard:' + t.now.id, false)) throw new Error('Realtime listen refused while locked');
    // the teacher still draws and the student sees it
    await pickTool(T.page, 'diamond'); await drag(T.page, [400, 250], [560, 380]);
    await waitScene(S.page, "t.includes('diamond')");
    await shot(S.page, 'locked-student');
    await T.page.click('#cb-overlay [data-cb="lock"]');
    await S.page.waitForFunction(() => TCClassBoard._test.view.api.getAppState().viewModeEnabled === false, null, { timeout: 8000 });
    await pickTool(S.page, 'rectangle'); await drag(S.page, [700, 260], [880, 400]);
    await waitScene(T.page, "t.includes('rectangle') && t.includes('diamond')");
    await waitStored(t.now.id, s => s.includes('rectangle'));
  });

  await run('Broadcasts are never trusted for storage: a shape that only travelled on the channel (never saved) disappears from the others\' screens', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openBoardFromCalendar(T.page, t.now.id);
    await studentLogin(S.page, t.ana); await studentOpenBoard(S.page);
    await S.page.waitForFunction(() => TCClassBoard._test.view.rt === 'private', null, { timeout: 10000 });
    // a forged message straight on the channel (no classboard_push): shown at once, but the database never got it
    await S.page.evaluate(() => { const v = TCClassBoard._test.view; v.channel.send({ type: 'broadcast', event: 'els', payload: { c: 'forged', g: 1, e: [
      { id: 'forged1', type: 'ellipse', version: 3, versionNonce: 9, isDeleted: false, x: 100, y: 100, width: 300, height: 200, angle: 0, strokeColor: '#e03131', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 4,
        strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, boundElements: null, updated: 1, link: null, locked: false, index: 'a5' },
      { id: 'forged2', type: 'image', version: 1, versionNonce: 1, fileId: 'x', x: 0, y: 0, width: 10, height: 10 }] } }); });
    await waitScene(T.page, "t.includes('ellipse') && !t.includes('image')");
    if (db.class_board_elements.some(e => e.element_id === 'forged1')) throw new Error('a broadcast was stored');
    // the next pulls compare it with the database: gone within ~20 s
    await waitScene(T.page, "!t.includes('ellipse')", SCOPE, 25000);
    // a real drawing (pushed through the RPC) stays
    await pickTool(S.page, 'rectangle'); await drag(S.page, [400, 300], [600, 420]);
    await waitScene(T.page, "t.includes('rectangle')");
    await T.page.waitForTimeout(12000);
    if (!(await scene(T.page)).includes('rectangle')) throw new Error('a saved drawing was removed');
  });

  await run('Admin: group card → classes → board, READ-ONLY (sees drawings, cannot draw / lock / restore); other-institution admin and a student of another group are refused', browser, async open => {
    const t = seed();
    seedBoard(t.past.id, [el('r1', 'rectangle', 3), el('t1', 'text', 2, { x: 110, y: 100, width: 160, height: 25, text: 'Rutina diaria', originalText: 'Rutina diaria', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 }),
      el('a1', 'arrow', 2, { x: 320, y: 120, width: 180, height: 0, points: [[0, 0], [180, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false })]);
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(id => { currentOrgId = id; }, t.centro.id);
    await A.page.click('#nav-groups');
    await A.page.waitForSelector('#panel-groups.active .gc-gcard');
    await A.page.locator('.gc-gcard', { hasText: 'English B1' }).locator('[data-gc="g-sessions"]').click();
    await A.page.waitForSelector('#gc-modal-box .gcs-list');
    const chip = await A.page.textContent(`#gc-modal-box .gcs-item:has([data-id="${t.past.id}"])`);
    if (!/Pizarra/.test(chip)) throw new Error('board chip missing: ' + chip);
    await A.page.click(`#gc-modal-box [data-att="gs-board"][data-id="${t.past.id}"]`);
    await waitBoard(A.page);
    await waitScene(A.page, "t.length === 3 && t.includes('text') && t.includes('arrow')");
    if (!(await A.page.evaluate(() => TCClassBoard._test.view.api.getAppState().viewModeEnabled))) throw new Error('admin can draw');
    if (await A.page.isVisible('#cb-overlay [data-cb="lock"]')) throw new Error('lock button for admin');
    if (!/Solo lectura/.test(await A.page.textContent('#cb-overlay .cd-notice'))) throw new Error('no read-only notice');
    const r = await A.page.evaluate(id => sb.rpc('classboard_push', { p_session: id, p_generation: 1, p_elements: [{ id: 'x1', type: 'rectangle', version: 1, versionNonce: 1 }], p_client: '9' }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/Solo lectura/.test(r)) throw new Error('admin push: ' + r);
    if (M.classBoard.canRealtime({ id: t.adm.id }, 'classboard:' + t.past.id, true) || !M.classBoard.canRealtime({ id: t.adm.id }, 'classboard:' + t.past.id, false)) throw new Error('admin Realtime: listen only');
    await A.page.click('#cb-overlay [data-cb="history"]'); await A.page.waitForSelector('#cb-overlay .cd-sheet-box');
    if (await A.page.$('#cb-overlay [data-cb="ver-save"]')) throw new Error('admin can save versions');
    await A.page.click('#cb-overlay [data-cb="sheet-close"]');
    await shot(A.page, 'admin-readonly');
    const un = await untranslated(A.page, '#cb-overlay .cb-shell'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    const O = await open(); await login(O.page, 'adm@otra.uy');
    const ro = await O.page.evaluate(id => sb.rpc('classboard_open', { p_session: id }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/No autorizado/.test(ro)) throw new Error('other admin: ' + ro);
    const C = await open(); await studentLogin(C.page, t.carl).catch(() => {});
    const rc = await C.page.evaluate(id => sb.rpc('classboard_open', { p_session: id }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/No autorizado/.test(rc)) throw new Error('student of another group: ' + rc);
    // the student of the class finds the past board on the dashboard
    const S = await open(); await studentLogin(S.page, t.ana);
    await S.page.waitForSelector(`.gs-docs-card [data-gc="board"][data-id="${t.past.id}"]`);
  });

  await run('Inside the live room: "Pizarra" side tab (teacher) + full screen; drawing reaches a student', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(() => { window.__lcBoard = () => document.getElementById('lc-side-board')?.__boardView; });
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await T.page.click('.gc-nextcard [data-gc="join"]');
    await T.page.waitForSelector('#panel-live.active #lc-joinas');
    await T.page.check('#lc-consent');
    await T.page.click('#lc-join');
    await T.page.waitForSelector('#lc-room');
    await T.page.click('#lc-tab-board');
    await waitBoard(T.page, '#lc-side-board');
    await studentLogin(S.page, t.ana); await studentOpenBoard(S.page);
    await pickTool(T.page, 'rectangle', '#lc-side-board'); await drag(T.page, [120, 200], [300, 320], '#lc-side-board');
    await waitScene(S.page, "t.includes('rectangle')");
    await shot(T.page, 'live-room-panel');
    // full screen inside the room: the board covers the stage, the room controls stay
    await T.page.click('#lc-side-board [data-cb="expand"]');
    await T.page.waitForFunction(() => document.getElementById('lc-room').classList.contains('board-full'));
    const w = await T.page.evaluate(() => document.getElementById('lc-side').getBoundingClientRect().width);
    if (w < 1000) throw new Error('board not full width: ' + w);
    if (!(await T.page.isVisible('#lc-ctl-end'))) throw new Error('room controls hidden');
    await pickTool(T.page, 'ellipse', '#lc-side-board'); await drag(T.page, [700, 220], [900, 380], '#lc-side-board');
    await waitScene(S.page, "t.includes('ellipse')");
    await shot(T.page, 'live-room');
    await T.page.click('#lc-side-board [data-cb="expand"]');
    await T.page.waitForFunction(() => !document.getElementById('lc-room').classList.contains('board-full'));
    const un = await untranslated(T.page, '#lc-side'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
  });

  await run('Without Realtime: the student falls back to polling ("live sync unavailable") and drawings still arrive both ways', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open({ noRealtime: true });
    await login(T.page, 'prof@sol.uy'); await openBoardFromCalendar(T.page, t.now.id);
    await studentLogin(S.page, t.ana); await studentOpenBoard(S.page);
    await S.page.waitForFunction(() => /no disponible/.test(document.querySelector('#cb-overlay .cd-status')?.textContent || ''), null, { timeout: 25000 });
    await pickTool(T.page, 'rectangle'); await drag(T.page, [380, 220], [620, 380]);
    await waitScene(S.page, "t.includes('rectangle')", SCOPE, 12000);
    await pickTool(S.page, 'ellipse'); await drag(S.page, [700, 260], [880, 400]);
    await waitScene(T.page, "t.includes('ellipse')", SCOPE, 20000);
  });

  await run('History: the teacher saves a version, keeps drawing and restores it; the student sees the restored board and cannot restore', browser, async open => {
    const t = seed();
    const T = await open(); const S = await open();
    await login(T.page, 'prof@sol.uy'); await openBoardFromCalendar(T.page, t.now.id);
    await pickTool(T.page, 'rectangle'); await drag(T.page, [380, 220], [620, 380]);
    await waitStored(t.now.id, s => s.includes('rectangle'));
    await T.page.click('#cb-overlay [data-cb="history"]');
    await T.page.click('#cb-overlay [data-cb="ver-save"]');
    await waitToast(T.page, /Versión guardada/);
    await T.page.click('#cb-overlay [data-cb="sheet-close"]');
    await pickTool(T.page, 'ellipse'); await drag(T.page, [700, 260], [880, 400]);
    await pickTool(T.page, 'diamond'); await drag(T.page, [420, 450], [560, 560]);
    await waitStored(t.now.id, s => s.length === 3);
    await studentLogin(S.page, t.ana); await studentOpenBoard(S.page);
    await waitScene(S.page, 't.length === 3');
    await T.page.click('#cb-overlay [data-cb="history"]');
    await T.page.waitForSelector('#cb-overlay .cd-ver-open');
    await T.page.click('#cb-overlay .cd-ver-open >> nth=0');
    await T.page.waitForSelector('#cb-overlay .cb-preview svg');
    await T.page.click('#cb-overlay [data-cb="ver-restore"]'); await T.page.click('#cb-overlay [data-cb="ver-restore"]');
    await waitToast(T.page, /Versión restaurada/);
    await waitScene(T.page, "t.length === 1 && t[0] === 'rectangle'");
    await waitScene(S.page, "t.length === 1 && t[0] === 'rectangle'", SCOPE, 12000);
    await S.page.click('#cb-overlay [data-cb="history"]'); await S.page.waitForSelector('#cb-overlay .cd-ver-open');
    await S.page.click('#cb-overlay .cd-ver-open >> nth=0'); await S.page.waitForSelector('#cb-overlay .cb-preview svg');
    if (await S.page.$('#cb-overlay [data-cb="ver-restore"]')) throw new Error('student can restore');
    const r = await S.page.evaluate(id => sb.rpc('classboard_restore', { p_version: id }).then(x => x.error?.message || 'ok'), db.class_board_versions[0].id);
    if (!/No autorizado/.test(r)) throw new Error('student restore: ' + r);
    // a student's push from before the restore (old generation) is refused
    const r2 = await S.page.evaluate(id => sb.rpc('classboard_push', { p_session: id, p_generation: 1, p_elements: [{ id: 'old1', type: 'rectangle', version: 1, versionNonce: 1 }], p_client: 'x' }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/desactualizada/.test(r2)) throw new Error('stale push: ' + r2);
  });

  await run('Export (Excalidraw export): PNG and SVG downloads; images are refused (tool hidden, inserted ones removed, database says no)', browser, async open => {
    const t = seed();
    seedBoard(t.past.id, [el('r1', 'rectangle', 3), el('t1', 'text', 2, { x: 110, y: 100, width: 160, height: 25, text: 'Hola <b>clase</b>', originalText: 'Hola <b>clase</b>', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 })]);
    const T = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(id => TCClassBoard.open(id), t.past.id);
    await waitBoard(T.page);
    await waitScene(T.page, 't.length === 2');
    await T.page.click('#cb-overlay [data-cb="export-menu"]');
    const [dl] = await Promise.all([T.page.waitForEvent('download'), T.page.click('#cb-overlay [data-cb="png"]')]);
    const png = fs.readFileSync(await dl.path());
    if (png.slice(1, 4).toString() !== 'PNG' || png.length < 2000 || !/^Unit-2-routines-\d{4}-\d\d-\d\d\.png$/.test(dl.suggestedFilename())) throw new Error('png: ' + dl.suggestedFilename() + ' ' + png.length);
    await T.page.click('#cb-overlay [data-cb="export-menu"]');
    const [dl2] = await Promise.all([T.page.waitForEvent('download'), T.page.click('#cb-overlay [data-cb="svg"]')]);
    const svg = fs.readFileSync(await dl2.path(), 'utf8');
    if (!/^<svg/.test(svg) || !/Hola &lt;b&gt;clase&lt;\/b&gt;/.test(svg) || /<b>clase/.test(svg) || !/@font-face/.test(svg)) throw new Error('svg: ' + svg.slice(0, 300));
    // images: no tool; one added anyway (paste / drop / library) is removed at once and never stored
    if (await T.page.$('#cb-overlay [data-testid="toolbar-image"]')) throw new Error('image tool visible');
    await T.page.evaluate(() => { const v = TCClassBoard._test.view; const els = v.api.getSceneElementsIncludingDeleted();
      v.api.updateScene({ elements: [...els, { ...els[0], id: 'img1', type: 'image', fileId: 'f1', status: 'saved', scale: [1, 1], version: 1, versionNonce: 5, index: 'a9' }] }); });
    await waitToast(T.page, /no se pueden poner imágenes/);
    await waitScene(T.page, "!t.includes('image')");
    await T.page.waitForTimeout(800);
    if (db.class_board_elements.some(e => e.data.type === 'image')) throw new Error('image stored');
    const r = await T.page.evaluate(id => sb.rpc('classboard_push', { p_session: id, p_generation: 1, p_elements: [{ id: 'img2', type: 'image', version: 1, versionNonce: 1, fileId: 'x' }], p_client: 'x' }).then(x => x.error?.message || 'ok'), t.past.id);
    if (!/imágenes/.test(r)) throw new Error('database accepted an image: ' + r);
  });

  await run('Mobile: the student opens the board from the dashboard on a phone and draws with a finger (touch), no horizontal page scroll', browser, async open => {
    const t = seed();
    seedBoard(t.now.id, [el('r1', 'rectangle', 3, { x: 20, y: 40, width: 160, height: 90, backgroundColor: '#ffec99' })]);
    const S = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await studentLogin(S.page, t.ana);
    await S.page.click('.gs-enter [data-gc="board"]');
    await waitBoard(S.page);
    await waitScene(S.page, 't.length === 1');
    // the pencil (free draw) in the mobile toolbar, then a finger stroke (real touch events → pointerType "touch")
    await S.page.tap('#cb-overlay label:has([data-testid="toolbar-freedraw"])');
    const box = await S.page.locator('#cb-overlay canvas.interactive').boundingBox();
    const cdp = await S.page.context().newCDPSession(S.page);
    const pt = (x, y) => [{ x: box.x + x, y: box.y + y, id: 1, radiusX: 4, radiusY: 4, force: 0.6 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(80, 300) });
    for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(80 + i * 18, 300 + Math.round(Math.sin(i / 2) * 40)) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitScene(S.page, "t.includes('freedraw')");
    await waitStored(t.now.id, s => s.includes('freedraw'));
    const over = await S.page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, box: document.querySelector('#cb-overlay .cd-overlay-box').scrollWidth - document.querySelector('#cb-overlay .cd-overlay-box').clientWidth }));
    if (over.doc > 1 || over.box > 1) throw new Error('horizontal scroll: ' + JSON.stringify(over));
    const cv = await S.page.locator('#cb-overlay canvas.interactive').boundingBox();
    if (cv.height < 450) throw new Error('canvas too small on a phone: ' + cv.height);
    await shot(S.page, 'mobile');
    // a tablet in landscape: the full desktop toolbar fits
    await S.page.setViewportSize({ width: 1024, height: 768 }); await S.page.waitForTimeout(500);
    const over2 = await S.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over2 > 1) throw new Error('tablet horizontal scroll: ' + over2);
  });

  await browser.close();
  if (failed) { console.log(`${failed} class-board scenario(s) failed`); process.exit(1); }
  console.log('All class-board scenarios passed');
})();
