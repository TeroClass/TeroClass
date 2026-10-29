// Live room layout + the institution's room background (2026-10-29):
//   • 1:1 "speaker focus": the OTHER person fills the stage (teacher sees the student, student sees the teacher), me in a
//     picture-in-picture (bottom-right, draggable to another corner, remembered); 1 person alone: one large tile.
//   • 3 and 8 people: a grid that fits the stage without scrolling; teacher first for students; phones: 1–2 columns.
//   • A shared screen keeps priority (large, people in a strip).  • Board / Document: wide side panel (58%), "Bigger" → 75%,
//     drag handle, remembered per browser; the videos become a column.  • Unchanged tiles keep their <video> element.
//   • LiveKit provider (mocked room): a track is attached once per <video> element.
//   • Branding → Classroom: the admin picks a color or uploads an image (bucket room-backgrounds), live preview, saved with
//     set_room_background; a branch inherits; the lobby + stage of every participant show it (color and image).
// Mock Supabase (tests/mock-supabase.cjs + mock-roombg.cjs) in headless Chromium, demo media provider (no LiveKit server).
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-live-layout.cjs   (SHOTS=<dir> saves aula-*.png / marca-fondo.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;

async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 860 }, hasTouch: !!opts.mobile, isMobile: !!opts.mobile, deviceScaleFactor: opts.scale || (opts.mobile ? 2 : 1) });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await M.realtime.attach(ctx, {});
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/vendor/whiteboard/')) return M.serveWhiteboard(r);
    if (u.pathname === '/vendor/classdoc-editor.js') return M.serveVendor(r);
    if (/^\/vendor\/fonts\/[a-z0-9-]+\.woff2$/.test(u.pathname)) return r.fulfill({ contentType: 'font/woff2', body: require('fs').readFileSync(require('path').join(__dirname, '..', 'public', u.pathname)) });
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
  return { ctx, page, st };
}
async function run(name, browser, fn) {
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
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(700);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/${name}.png` }); else await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
// the board needs a moment to mount; the tiles animate (0.28 s) — geometry is read from the target rectangles
const settle = page => page.waitForTimeout(450);

function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const admC = mk('adm@centro.uy', 'Admin Centro', 'org_admin', centro.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  mk('adm@otra.uy', 'Admin Otra', 'org_admin', otra.id);
  const ana = M.newUser('ana@mail.com', { via: 'student_link' });
  const g = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: prof.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  db.class_groups.push(g);
  const en = { id: M.uid(), institution_id: centro.id, email: ana.email, name: 'Ana Pérez', user_id: ana.id, loaded_by: adm.id, source: 'manual', created_at: new Date().toISOString() };
  db.student_enrollments.push(en); db.group_members.push({ group_id: g.id, enrollment_id: en.id, created_at: new Date().toISOString() });
  const now = { id: M.uid(), institution_id: centro.id, group_id: g.id, series_id: null, teacher_id: prof.id, title: 'Unit 3: making plans', starts_at: new Date(Date.now() - 5 * MIN).toISOString(), ends_at: new Date(Date.now() + 55 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() };
  db.class_sessions.push(now);
  return { sol, centro, otra, adm, admC, prof, ana, g, now };
}
// a background image for the tests (a soft abstract "campus" picture rendered by Chromium itself)
async function makeImage(browser, type = 'jpeg') {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await p.setContent(`<body style="margin:0;width:1600px;height:900px;overflow:hidden;background:linear-gradient(135deg,#0f3d5e 0%,#14606b 45%,#2a8a7a 100%);position:relative">
    <div style="position:absolute;left:-120px;top:-160px;width:720px;height:720px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.22),rgba(255,255,255,0) 70%)"></div>
    <div style="position:absolute;right:-200px;bottom:-260px;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,rgba(255,214,140,.30),rgba(255,214,140,0) 70%)"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:260px;background:linear-gradient(transparent,rgba(5,20,30,.35))"></div>
    ${Array.from({ length: 9 }, (_, i) => `<div style="position:absolute;left:${80 + i * 170}px;bottom:${60 + (i % 3) * 22}px;width:120px;height:${180 + (i % 4) * 40}px;border-radius:14px 14px 0 0;background:rgba(255,255,255,${0.05 + (i % 3) * 0.03})"></div>`).join('')}
  </body>`);
  const buf = await p.screenshot({ type, ...(type === 'jpeg' ? { quality: 82 } : {}) });
  await p.close();
  return buf;
}
// the lobby camera preview is live (fake device) before joining, so my own tile has video
const waitCam = page => page.waitForFunction(() => { const v = document.getElementById('lc-preview-video'); return v && v.srcObject && v.srcObject.getVideoTracks().length && v.readyState >= 2; }, null, { timeout: 10000 });
async function teacherJoin(page) {
  await login(page, 'prof@sol.uy');
  await page.click('#nav-calendar');
  await page.waitForSelector('.gc-nextcard [data-gc="join"]');
  await page.click('.gc-nextcard [data-gc="join"]');
  await page.waitForSelector('#panel-live.active #lc-joinas');
  await waitCam(page);
  await page.check('#lc-consent');
  await page.click('#lc-join');
  await page.waitForSelector('#lc-room');
}
async function studentJoin(page, u) {
  await studentLogin(page, u);
  await page.waitForFunction(() => { const b = document.querySelector('.gs-enter .gc-join'); return b && !b.disabled; });
  await page.click('.gs-enter .gc-join');
  await page.waitForSelector('#panel-live.active #lc-joinas');
  await waitCam(page);
  await page.check('#lc-consent');
  await page.click('#lc-join');
  await page.waitForSelector('#lc-room');
}
// replace the remote participants (demo provider, no simulated people): local stays first in the provider list
const STUDENTS = ['Ana Pérez', 'Mateo Fernández', 'Sofía Pereira', 'Lucas Silva', 'Martina Gómez', 'Joaquín Castro', 'Valentina Ruiz', 'Bruno Díaz', 'Camila Sosa', 'Diego Núñez'];
const setPeople = (page, people) => page.evaluate(ps => {
  const pr = LiveClass.state.room.provider; const local = pr._list.find(p => p.isLocal);
  pr._list = [local, ...ps.map((p, i) => ({ id: 'p-' + i, isLocal: false, mic: true, cam: true, recorded: i % 3 !== 1, minor: false, guardianOk: false, hand: false, consent: {}, role: 'student', ...p }))];
  pr.emit('participants', pr._list);
}, people);
const students = n => STUDENTS.slice(0, n).map(name => ({ name }));
// target rectangles (style), relative to the stage content box
const geo = page => page.evaluate(() => {
  const g = document.getElementById('lc-grid'); const st = g.parentElement; const cs = getComputedStyle(st);
  const W = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), H = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const tiles = [...g.querySelectorAll(':scope > .lc-tile')].map(t => ({ pid: t.dataset.pid, x: parseFloat(t.style.left), y: parseFloat(t.style.top), w: parseFloat(t.style.width), h: parseFloat(t.style.height),
    main: t.classList.contains('lc-main'), pip: t.classList.contains('lc-pip'), share: t.classList.contains('lc-share-tile'), name: t.querySelector('.lc-tile-name')?.textContent || '' }));
  const room = document.getElementById('lc-room'); const body = room.querySelector('.lc-room-body').getBoundingClientRect(); const side = document.getElementById('lc-side').getBoundingClientRect();
  return { layout: g.dataset.layout, W, H, scroll: st.scrollHeight > st.clientHeight + 1, tiles, wide: room.classList.contains('side-wide'), sideW: side.width, bodyW: body.width, sidePos: getComputedStyle(document.getElementById('lc-side')).position };
});
function assertFits(G, n) {
  const ppl = G.tiles.filter(t => !t.share);
  if (ppl.length !== n) throw new Error('tiles: ' + ppl.length + ' / ' + n);
  if (G.scroll) throw new Error('the stage scrolls');
  for (const t of ppl) if (t.x < -1 || t.y < -1 || t.x + t.w > G.W + 1 || t.y + t.h > G.H + 1) throw new Error('tile outside the stage: ' + JSON.stringify(t) + ' in ' + G.W + '×' + G.H);
  for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) {
    const a = ppl[i], b = ppl[j];
    if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) throw new Error('tiles overlap: ' + a.pid + ' / ' + b.pid);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--unsafely-treat-insecure-origin-as-secure=http://teroclass.test'] });
  const IMG = await makeImage(browser);

  await run('Branding → Classroom: the admin picks a color (presets, live preview) and then uploads an image (≤ 3 MB, jpg/png/webp, bucket room-backgrounds); both saved with set_room_background (ES)', browser, async open => {
    const t = seed();
    const A = await open({ viewport: { width: 1366, height: 900 } });
    await login(A.page, 'adm@sol.uy');
    await A.page.click('#nav-branding');
    await A.page.waitForSelector('#panel-branding.active');
    await A.page.waitForFunction(() => document.getElementById('wl-name').value === 'Instituto Sol');
    await A.page.evaluate(() => goStep(4));
    await A.page.waitForSelector('#wizard-step-4.active');
    if (!/Aula/.test(await A.page.textContent('#step-item-4'))) throw new Error('step label: ' + await A.page.textContent('#step-item-4'));
    if (await A.page.isVisible('#rbg-opt-inherit')) throw new Error('"same as above" offered to the main institution');
    if (!(await A.page.isChecked('input[name="rbg-kind"][value="default"]'))) throw new Error('default not selected');
    if (!/Fondo del aula en vivo/.test(await A.page.textContent('#wizard-step-4'))) throw new Error('not translated');
    // color: a preset → the preview stage takes it
    await A.page.click('label.rbg-opt:has(input[value="color"])');
    await A.page.waitForSelector('#rbg-color-field:not([hidden])');
    await A.page.click('.rbg-preset[data-c="#0f766e"]');
    const pv = await A.page.$eval('#rbg-pv-stage', e => getComputedStyle(e).backgroundColor);
    if (pv !== 'rgb(15, 118, 110)') throw new Error('preview color: ' + pv);
    await A.page.fill('#rbg-color-hex', '#1E3A5F');
    if (await A.page.$eval('#rbg-pv-stage', e => getComputedStyle(e).backgroundColor) !== 'rgb(30, 58, 95)') throw new Error('typed color not previewed');
    await A.page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await A.page.click('.btn-save-brand');
    await waitToast(A.page, /Marca guardada/);
    const sol = () => db.institutions.find(i => i.id === t.sol.id);
    if (sol().room_bg_kind !== 'color' || sol().room_bg_color !== '#1e3a5f') throw new Error('color not saved: ' + JSON.stringify(sol()));
    if (!calls.rpc.some(c => c.fn === 'set_room_background' && c.body.p_inst === t.sol.id && c.body.p_kind === 'color')) throw new Error('set_room_background not called');
    // image: too big / wrong type refused, then a real one
    await A.page.click('label.rbg-opt:has(input[value="image"])');
    await A.page.waitForSelector('#rbg-image-field:not([hidden])');
    await A.page.setInputFiles('#rbg-upload', { name: 'campus.jpg', mimeType: 'image/jpeg', buffer: IMG });
    await A.page.waitForFunction(() => /url\("data:image\/jpeg/.test(document.getElementById('rbg-pv-stage').style.background));
    if (!/campus\.jpg/.test(await A.page.textContent('#rbg-file-ok'))) throw new Error('file name not shown');
    await A.page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    await shot(A.page, 'marca-fondo');
    await A.page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await A.page.click('.btn-save-brand');
    await waitToast(A.page, /Marca guardada/);
    await A.page.setInputFiles('#rbg-upload', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(3 * 1024 * 1024 + 10) });
    await waitToast(A.page, /menos de 3 MB/);
    await A.page.setInputFiles('#rbg-upload', { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await waitToast(A.page, /JPG, PNG o WebP/);
    if (await A.page.evaluate(() => document.getElementById('rbg-upload').value)) throw new Error('input not reset');
    const up = M.roomBg.storage.uploads.find(u => u.bucket === 'room-backgrounds');
    if (!up || !new RegExp('^' + t.sol.id + '/room-\\d+\\.jpg$').test(up.name) || up.type !== 'image/jpeg' || up.size !== IMG.length) throw new Error('upload: ' + JSON.stringify(M.roomBg.storage.uploads));
    if (sol().room_bg_kind !== 'image' || !sol().room_bg_url.endsWith('/storage/v1/object/public/room-backgrounds/' + up.name)) throw new Error('image not saved: ' + JSON.stringify(sol()));
    // the form shows what is saved after a reload
    await A.page.reload(); await A.page.waitForSelector('#screen-app.active');
    await A.page.click('#nav-branding'); await A.page.waitForFunction(() => document.getElementById('wl-name').value === 'Instituto Sol');
    await A.page.evaluate(() => goStep(4));
    if (!(await A.page.isChecked('input[name="rbg-kind"][value="image"]'))) throw new Error('saved image not selected after reload');
    if (!(await A.page.$eval('#rbg-pv-stage', e => e.style.background.includes('/room-backgrounds/')))) throw new Error('preview without the saved image');
  });

  await run('Branding → Classroom in a branch: "same as the unit above" (inherited, described); a branch color of its own; another institution cannot write it', browser, async open => {
    const t = seed();
    Object.assign(db.institutions.find(i => i.id === t.sol.id), { room_bg_kind: 'color', room_bg_color: '#1e3a5f' });
    const A = await open();
    await login(A.page, 'adm@centro.uy', 'en');
    await A.page.click('#nav-branding');
    await A.page.waitForFunction(() => document.getElementById('wl-name').value === 'Sede Centro');
    await A.page.evaluate(() => goStep(4));
    await A.page.waitForSelector('#rbg-opt-inherit:not([hidden])');
    if (!(await A.page.isChecked('input[name="rbg-kind"][value="inherit"]'))) throw new Error('inherit not selected');
    await A.page.waitForFunction(() => /a color #1e3a5f/.test(document.getElementById('rbg-inherit-desc').textContent));
    if (await A.page.$eval('#rbg-pv-stage', e => getComputedStyle(e).backgroundColor) !== 'rgb(30, 58, 95)') throw new Error('inherited preview');
    await A.page.click('label.rbg-opt:has(input[value="default"])');
    await A.page.click('.btn-save-brand');
    await waitToast(A.page, /Branding saved/);
    const c = db.institutions.find(i => i.id === t.centro.id);
    if (c.room_bg_kind !== 'default') throw new Error('branch default: ' + c.room_bg_kind);
    const r = await A.page.evaluate(id => sb.rpc('set_room_background', { p_inst: id, p_kind: 'color', p_color: '#000000' }).then(x => x.error?.message || 'ok'), t.sol.id);
    if (!/No autorizado/.test(r)) throw new Error('branch admin wrote the parent: ' + r);
    const O = await open(); await login(O.page, 'adm@otra.uy');
    const r2 = await O.page.evaluate(id => sb.rpc('get_room_background', { p_session: id }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/No autorizado/.test(r2)) throw new Error('other institution read the class: ' + r2);
  });

  await run('1:1 (teacher): the student fills the stage, the teacher is a picture-in-picture (bottom-right, ~21%), no scroll; drag to another corner (remembered); institution IMAGE behind', browser, async open => {
    const t = seed();
    const sol = db.institutions.find(i => i.id === t.sol.id);
    const name = t.sol.id + '/room-1.jpg';
    M.roomBg.storage.files['room-backgrounds/' + name] = { body: IMG, type: 'image/jpeg' };
    Object.assign(sol, { room_bg_kind: 'image', room_bg_url: SB + '/storage/v1/object/public/room-backgrounds/' + name });
    const T = await open();
    await teacherJoin(T.page);
    // the lobby already had it
    let G = await geo(T.page);
    if (G.layout !== 'solo' || G.tiles.length !== 1 || G.tiles[0].w < G.W * 0.6) throw new Error('alone: ' + JSON.stringify(G));
    await setPeople(T.page, [{ name: 'Ana Pérez' }]);
    await settle(T.page);
    G = await geo(T.page);
    const main = G.tiles.find(x => x.main), pip = G.tiles.find(x => x.pip);
    if (G.layout !== 'duo' || !main || !pip) throw new Error('layout: ' + JSON.stringify(G));
    if (main.name !== 'Ana Pérez' || pip.pid !== 'local') throw new Error('the teacher must see the STUDENT big: ' + JSON.stringify(G.tiles));
    if (Math.abs(main.w - G.W) > 2 || Math.abs(main.h - G.H) > 2 || G.scroll) throw new Error('main does not fill the stage: ' + JSON.stringify({ main, W: G.W, H: G.H }));
    if (pip.w / G.W < 0.19 || pip.w / G.W > 0.23 || pip.x + pip.w < G.W - 30 || pip.y + pip.h < G.H - 30) throw new Error('pip: ' + JSON.stringify(pip) + ' in ' + G.W + '×' + G.H);
    const fill = await T.page.evaluate(() => { const t = document.querySelector('.lc-tile.lc-main'), c = t.querySelector('.lc-sim-cam, video').getBoundingClientRect(), r = t.getBoundingClientRect(); return { cover: getComputedStyle(document.getElementById('lc-local-video')).objectFit, dw: Math.abs(c.width - r.width), dh: Math.abs(c.height - r.height) }; });
    if (fill.cover !== 'cover' || fill.dw > 1 || fill.dh > 1) throw new Error('the camera does not cover the tile: ' + JSON.stringify(fill));
    // the institution's image is behind the stage and really loads (img-src)
    const bg = await T.page.$eval('#lc-room .lc-stage', e => getComputedStyle(e).backgroundImage);
    if (!bg.includes('/room-backgrounds/' + name) || !/linear-gradient/.test(bg)) throw new Error('stage background: ' + bg);
    if (await T.page.$eval('#lc-root', e => e.dataset.roombg) !== 'image') throw new Error('data-roombg');
    const w = await T.page.evaluate(u => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth); i.onerror = () => r(0); i.src = u; }), sol.room_bg_url);
    if (w !== 1600) throw new Error('image not served: ' + w);
    await shot(T.page, 'aula-1a1');
    // drag the picture-in-picture to the top-left corner
    const box = await T.page.locator('.lc-tile.lc-pip').boundingBox();
    await T.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await T.page.mouse.down();
    await T.page.mouse.move(box.x - 600, box.y - 400, { steps: 8 }); await T.page.mouse.up();
    await settle(T.page);
    G = await geo(T.page); const p2 = G.tiles.find(x => x.pip);
    if (p2.x > 30 || p2.y > 30) throw new Error('pip not moved to top-left: ' + JSON.stringify(p2));
    if (await T.page.evaluate(() => localStorage.getItem('tc_lc_pip')) !== 'tl') throw new Error('corner not remembered');
    // speaking ring / hand / mic on the big tile still work
    await T.page.evaluate(() => { const pr = LiveClass.state.room.provider; pr._list[1].hand = true; pr.emit('participants', pr._list); pr.emit('speaking', new Set(['p-0'])); });
    await T.page.waitForSelector('.lc-tile.lc-main.hand.speaking');
    await T.page.click('#lc-ctl-hand');
    await T.page.waitForSelector('.lc-tile.lc-pip.hand');
    await T.page.evaluate(() => { const pr = LiveClass.state.room.provider; pr._list[1].mic = false; pr.emit('participants', pr._list); });
    await T.page.waitForSelector('.lc-tile.lc-main.muted:not(.speaking)');
    if (await T.page.textContent('.lc-tile.lc-main .lc-mic-ind') !== '🔇') throw new Error('mic indicator');
    { const b = await T.page.textContent('.lc-tile.lc-pip .lc-tile-top'); if (!/Grabado|Aceptó/.test(b)) throw new Error('badges on the pip: ' + b); }
    // the same <video> element is kept across participant updates (no re-attach)
    await T.page.evaluate(() => { window.__lv = document.getElementById('lc-local-video'); });
    await setPeople(T.page, [{ name: 'Ana Pérez', mic: true }]);
    await setPeople(T.page, [{ name: 'Ana Pérez', mic: false, hand: false }]);
    // LiveKit provider: a remote camera / screen track is attached once per element (the grid keeps its elements)
    const n = await T.page.evaluate(() => {
      const p = new LiveClass.providers.LiveKitProvider(); let calls = 0;
      const track = { attachedElements: [], attach(el) { calls++; this.attachedElements.push(el); } };
      p.LK = { Track: { Source: { Camera: 'camera', ScreenShare: 'screen_share' } } };
      p.room = { remoteParticipants: new Map([['u1', { getTrackPublication: () => ({ track }) }]]) };
      const el = document.createElement('video');
      p.attachVideo('u1', el); p.attachVideo('u1', el); p.attachScreen('u1', el);
      p.attachVideo('u1', document.createElement('video'));
      return calls;
    });
    if (n !== 2) throw new Error('LiveKit attach calls: ' + n);
    if (!(await T.page.evaluate(() => window.__lv === document.getElementById('lc-local-video') && !!window.__lv.srcObject))) throw new Error('local video element rebuilt: ' + await T.page.evaluate(() => [window.__lv?.isConnected, !!window.__lv?.srcObject, document.querySelector('.lc-tile[data-pid=local]')?.dataset.sig, LiveClass.state.room.stream?.getTracks().map(t => t.kind + t.readyState).join()]));
  });

  await run('1:1 (student): the TEACHER fills the stage, the student is the picture-in-picture; with 3 the teacher tile comes first; institution COLOR in the lobby and the room', browser, async open => {
    const t = seed();
    Object.assign(db.institutions.find(i => i.id === t.sol.id), { room_bg_kind: 'color', room_bg_color: '#1e3a5f' });
    const S = await open();
    await studentLogin(S.page, t.ana);
    await S.page.waitForFunction(() => { const b = document.querySelector('.gs-enter .gc-join'); return b && !b.disabled; });
    await S.page.click('.gs-enter .gc-join');
    await S.page.waitForSelector('#panel-live.active #lc-joinas');
    await S.page.waitForFunction(() => document.getElementById('lc-root').dataset.roombg === 'color');
    const lob = await S.page.$eval('#lc-root', e => getComputedStyle(e).backgroundColor);
    if (lob !== 'rgb(30, 58, 95)') throw new Error('lobby background: ' + lob);
    const head = await S.page.$eval('.lc-lobby > .lc-head', e => getComputedStyle(e).backgroundColor);
    if (!/rgba\(255, 255, 255, 0\.9/.test(head)) throw new Error('lobby title not readable on the color: ' + head);
    await shot(S.page, 'x-lobby-color');
    await waitCam(S.page);
    await S.page.check('#lc-consent');
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    if (await S.page.$eval('#lc-room .lc-stage', e => getComputedStyle(e).backgroundColor) !== 'rgb(30, 58, 95)') throw new Error('stage color');
    if (await S.page.$eval('.lc-tile', e => getComputedStyle(e).backgroundColor) === 'rgb(30, 58, 95)') throw new Error('tiles must keep their own background');
    await setPeople(S.page, [{ name: 'Laura Gómez', role: 'teacher' }]);
    await settle(S.page);
    let G = await geo(S.page);
    const main = G.tiles.find(x => x.main), pip = G.tiles.find(x => x.pip);
    if (G.layout !== 'duo' || main?.name !== 'Laura Gómez' || pip?.pid !== 'local') throw new Error('the student must see the TEACHER big: ' + JSON.stringify(G.tiles));
    if (Math.abs(main.w - G.W) > 2 || Math.abs(main.h - G.H) > 2) throw new Error('teacher tile does not fill the stage');
    await setPeople(S.page, [{ name: 'Beto Ruiz' }, { name: 'Laura Gómez', role: 'teacher' }]);
    await settle(S.page);
    G = await geo(S.page);
    if (G.layout !== 'grid' || G.tiles[0].name !== 'Laura Gómez' || G.tiles[1].pid !== 'local') throw new Error('order: ' + G.tiles.map(x => x.name || x.pid));
    assertFits(G, 3);
  });

  await run('3 and 8 people: grids that fit the stage without scrolling (and big tiles); 6 for the screenshot; a shared screen takes priority with people in a strip', browser, async open => {
    const t = seed();
    Object.assign(db.institutions.find(i => i.id === t.sol.id), { room_bg_kind: 'color', room_bg_color: '#1e3a5f' });
    const T = await open();
    await teacherJoin(T.page);
    await T.page.click('.lc-side-close');
    await setPeople(T.page, students(2)); await settle(T.page);
    let G = await geo(T.page); assertFits(G, 3);
    if (G.tiles[0].w < 380) throw new Error('3 people: tiles too small: ' + G.tiles[0].w);
    await setPeople(T.page, students(7)); await settle(T.page);
    G = await geo(T.page); assertFits(G, 8);
    if (G.tiles[0].w < 260) throw new Error('8 people: tiles too small: ' + G.tiles[0].w);
    // with the side panel open (chat) it still fits
    await T.page.click('#lc-ctl-chat'); await settle(T.page);
    G = await geo(T.page); assertFits(G, 8);
    await T.page.click('#lc-ctl-chat');
    await setPeople(T.page, students(5)); await settle(T.page);
    G = await geo(T.page); assertFits(G, 6);
    await T.page.evaluate(() => { const pr = LiveClass.state.room.provider; pr.emit('speaking', new Set(['p-1'])); pr._list[3].hand = true; pr.emit('participants', pr._list); });
    await T.page.waitForSelector('.lc-tile.hand'); await T.page.waitForSelector('.lc-tile.speaking');
    await shot(T.page, 'aula-grupo');
    // a remote screen share: large, people in a strip beside it
    await T.page.evaluate(() => LiveClass.state.room.provider.emit('screens', [{ id: 'p-0', name: 'Ana Pérez' }]));
    await T.page.waitForSelector('.lc-share-tile.remote'); await settle(T.page);
    G = await geo(T.page);
    const sh = G.tiles.find(x => x.share), small = G.tiles.filter(x => !x.share);
    if (G.layout !== 'share' || !sh || small.some(x => x.w * x.h >= sh.w * sh.h / 4)) throw new Error('share layout: ' + JSON.stringify(G.tiles));
    if (small.some(x => x.x < sh.x + sh.w)) throw new Error('people not in a strip beside the screen');
    await T.page.evaluate(() => LiveClass.state.room.provider.emit('screens', []));
    await T.page.waitForFunction(() => !document.querySelector('.lc-share-tile'));
    await settle(T.page);
    G = await geo(T.page); assertFits(G, 6);
  });

  await run('Board tab: the side panel widens to ~58% (videos become a column), "Bigger" → 75% (remembered per browser), drag handle, Chat goes back to 350px and the 1:1 layout', browser, async open => {
    const t = seed();
    Object.assign(db.institutions.find(i => i.id === t.sol.id), { room_bg_kind: 'color', room_bg_color: '#1e3a5f' });
    const T = await open();
    await teacherJoin(T.page);
    await setPeople(T.page, [{ name: 'Ana Pérez' }]);
    await T.page.click('#lc-tab-board');
    await T.page.waitForSelector('#lc-side-board .excalidraw', { timeout: 25000 });
    await settle(T.page);
    let G = await geo(T.page);
    if (!G.wide || Math.abs(G.sideW / G.bodyW - 0.58) > 0.02) throw new Error('board panel width: ' + G.sideW + ' / ' + G.bodyW);
    if (G.layout !== 'grid' || G.tiles.some(x => x.pip) || Math.abs(G.tiles[0].x - G.tiles[1].x) > 1) throw new Error('videos not in a column: ' + JSON.stringify(G.tiles));
    if (G.tiles[0].name !== 'Ana Pérez' || G.tiles[1].pid !== 'local') throw new Error('teacher view: the student on top, my tile last');
    assertFits(G, 2);
    if (!(await T.page.isVisible('#lc-side-size')) || !/Más grande/.test(await T.page.textContent('#lc-side-size'))) throw new Error('size toggle');
    await shot(T.page, 'aula-pizarra');
    await T.page.click('#lc-side-size'); await settle(T.page);
    G = await geo(T.page);
    if (Math.abs(G.sideW / G.bodyW - 0.75) > 0.02) throw new Error('bigger: ' + G.sideW / G.bodyW);
    if (await T.page.evaluate(() => localStorage.getItem('tc_lc_side_w')) !== '75' || !/Más chico/.test(await T.page.textContent('#lc-side-size'))) throw new Error('not remembered / label');
    assertFits(G, 2);
    // drag the handle to ~50%
    const body = await T.page.locator('#lc-room .lc-room-body').boundingBox(); const grip = await T.page.locator('#lc-side-grip').boundingBox();
    await T.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await T.page.mouse.down();
    await T.page.mouse.move(body.x + body.width * 0.5, grip.y + grip.height / 2, { steps: 10 }); await T.page.mouse.up();
    await settle(T.page);
    G = await geo(T.page);
    if (Math.abs(G.sideW / G.bodyW - 0.5) > 0.03 || Math.abs(Number(await T.page.evaluate(() => localStorage.getItem('tc_lc_side_w'))) - 50) > 3) throw new Error('drag: ' + G.sideW / G.bodyW);
    // the document tab is wide too
    await T.page.click('#lc-tab-doc'); await settle(T.page);
    G = await geo(T.page); if (!G.wide || Math.abs(G.sideW / G.bodyW - 0.5) > 0.03) throw new Error('document panel: ' + G.sideW / G.bodyW);
    // chat → normal side panel, the 1:1 layout again
    await T.page.click('#lc-tab-chat'); await settle(T.page);
    G = await geo(T.page);
    if (G.wide || Math.abs(G.sideW - 350) > 2 || G.layout !== 'duo') throw new Error('chat: ' + JSON.stringify({ wide: G.wide, side: G.sideW, layout: G.layout }));
    if (await T.page.isVisible('#lc-side-size')) throw new Error('size toggle visible with chat');
  });

  await run('Phone (390 px): 1–2 columns with scrolling for a big class, the side panel stays a full overlay (never "wide"), 1:1 keeps the picture-in-picture', browser, async open => {
    const t = seed();
    const T = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await teacherJoin(T.page);
    await T.page.evaluate(() => { const b = document.querySelector('.lc-side-close'); if (b && b.offsetParent) b.click(); });
    await setPeople(T.page, [{ name: 'Ana Pérez' }]); await settle(T.page);
    let G = await geo(T.page);
    if (G.layout !== 'duo' || !G.tiles.find(x => x.pip) || G.tiles.find(x => x.main).w < G.W - 2) throw new Error('phone 1:1: ' + JSON.stringify(G));
    await setPeople(T.page, students(7)); await settle(T.page);
    G = await geo(T.page);
    const cols = new Set(G.tiles.map(x => Math.round(x.x))).size;
    if (G.layout !== 'grid' || cols > 2 || G.tiles.some(x => x.x < -1 || x.x + x.w > G.W + 1)) throw new Error('phone grid: ' + cols + ' ' + JSON.stringify(G.tiles.slice(0, 3)));
    if (await T.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error('horizontal page scroll');
    await T.page.evaluate(() => document.getElementById('lc-ctl-board').click());
    await settle(T.page);
    G = await geo(T.page);
    if (G.wide || G.sidePos !== 'absolute') throw new Error('phone board panel must be an overlay: ' + JSON.stringify({ wide: G.wide, pos: G.sidePos }));
  });

  await browser.close();
  if (failed) { console.log(`${failed} live layout test(s) FAILED`); process.exit(1); }
  console.log('ALL LIVE LAYOUT TESTS PASSED');
})();
