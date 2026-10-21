// Attendance: a student enters the class room → present for the teacher (automatic join / leave); the teacher corrects
// a status with a note; the admin sees the group report in the group card (%, matrix, date range) and exports the CSV;
// other institutions are refused; the student sees only their own summary on the dashboard; mobile.
// Mock Supabase (tests/mock-supabase.cjs + mock-classdoc.cjs) in headless Chromium.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-attendance.cjs   (SHOTS=<dir> saves att-*.png)
const { chromium } = require('playwright');
const fs = require('fs');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';

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
    if (u.pathname === '/api/notify/session') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, sent: 0 }) });
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
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(450);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/att-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/att-${name}.png` });
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || t === 'G+' || t === 'min' || /^Empieza en \d/.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return out;
}, sel);

function seed({ history = false } = {}) {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  mk('adm@otra.uy', 'Admin Otra', 'org_admin', otra.id);
  const ana = M.newUser('ana@mail.com', { via: 'student_link' });
  const beto = M.newUser('beto@mail.com', { via: 'student_link' });
  const g = { id: M.uid(), institution_id: centro.id, name: 'English B1 – Tue/Thu', teacher_id: prof.id, substitute_id: null, timezone: 'America/Montevideo', created_at: new Date().toISOString() };
  db.class_groups.push(g);
  const e = (u, email, name) => { const x = { id: M.uid(), institution_id: centro.id, email, name, user_id: u?.id || null, loaded_by: adm.id, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(x); db.group_members.push({ group_id: g.id, enrollment_id: x.id, created_at: new Date(Date.now() - 40 * 864e5).toISOString() }); return x; };
  const eAna = e(ana, 'ana@mail.com', 'Ana Pérez'); const eBeto = e(beto, 'beto@mail.com', 'Beto Ruiz ' + XSS); const eCaro = e(null, 'caro@mail.com', 'Caro Díaz');
  const mkS = (offMin, dur, title) => { const s = { id: M.uid(), institution_id: centro.id, group_id: g.id, series_id: null, teacher_id: prof.id, title, starts_at: new Date(Date.now() + offMin * MIN).toISOString(), ends_at: new Date(Date.now() + (offMin + dur) * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
  const now = mkS(-3, 60, 'Unit 4: food');
  const out = { sol, centro, otra, adm, prof, ana, beto, g, eAna, eBeto, eCaro, now, past: [] };
  if (history) {
    const row = (s, en, st, extra = {}) => db.session_attendance.push({ id: M.uid(), session_id: s.id, enrollment_id: en.id, user_id: en.user_id, kind: 'student', first_join: st === 'absent' ? null : new Date(Date.parse(s.starts_at) + (st === 'late' ? 15 : 1) * MIN).toISOString(), last_seen: null, seconds_present: st === 'absent' ? 0 : 2400, in_room: false, joins: 1, auto_status: st === 'absent' ? null : st, status: null, source: 'auto', note: '', ...extra });
    const p1 = mkS(-6 * 24 * 60, 60, 'Unit 1: hello'); const p2 = mkS(-4 * 24 * 60, 60, 'Unit 2: family'); const p3 = mkS(-2 * 24 * 60, 60, 'Unit 3: routines');
    row(p1, eAna, 'present'); row(p2, eAna, 'late'); row(p3, eAna, 'present');
    row(p1, eBeto, 'present'); row(p3, eBeto, 'absent', { status: 'excused', source: 'teacher', note: 'Médico' });
    row(p2, eCaro, 'present');
    out.past = [p1, p2, p3];
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('A student enters the class room → present for the teacher (automatic); the teacher corrects a status with a note; leaving closes the stay', browser, async open => {
    const t = seed();
    const S = await open(); const T = await open();
    await studentLogin(S.page, t.ana);
    await S.page.waitForFunction(() => { const b = document.querySelector('.gs-enter .gc-join'); return b && !b.disabled; });
    await S.page.click('.gs-enter .gc-join');
    await S.page.waitForSelector('#panel-live.active #lc-joinas');
    await S.page.check('#lc-consent'); // first class room: the single recording consent (asked once)
    await S.page.click('#lc-join');
    await S.page.waitForSelector('#lc-room');
    await S.page.waitForFunction(() => window.TCAttendance.room.sid);
    const row = () => db.session_attendance.find(a => a.session_id === t.now.id && a.enrollment_id === t.eAna.id);
    for (let i = 0; i < 40 && !row(); i++) await S.page.waitForTimeout(100);
    if (!row() || row().auto_status !== 'present' || !row().in_room) throw new Error('join not recorded: ' + JSON.stringify(row()));
    // teacher: Calendar → class detail → Attendance
    await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard .gc-nc-title');
    await T.page.click(`.gc-nextcard [data-gc="open"][data-id="${t.now.id}"]`);
    await T.page.waitForSelector('#gc-att .att-row');
    const txt = (await T.page.textContent('#gc-att')).replace(/\s+/g, ' ');
    if (!/Ana Pérez/.test(txt) || !/Automático: Presente/.test(txt) || !/Todavía no entró/.test(txt) || !/beto@mail\.com/.test(txt)) throw new Error('teacher list: ' + txt);
    if (!(await T.page.$(`#gc-att .att-row[data-e="${t.eAna.id}"] .att-in`))) throw new Error('Ana not shown in the room now');
    // correction: Beto excused + note
    await T.page.selectOption(`#gc-att select[data-e="${t.eBeto.id}"]`, 'excused');
    await waitToast(T.page, /Asistencia actualizada/);
    await T.page.waitForSelector(`#gc-att select[data-e="${t.eBeto.id}"]`);
    await T.page.fill(`#gc-att input[data-e="${t.eBeto.id}"]`, 'Avisó por WhatsApp');
    await T.page.press(`#gc-att input[data-e="${t.eBeto.id}"]`, 'Tab');
    await waitToast(T.page, /Nota guardada/);
    const b = db.session_attendance.find(a => a.session_id === t.now.id && a.enrollment_id === t.eBeto.id);
    if (!b || b.status !== 'excused' || b.source !== 'teacher' || b.note !== 'Avisó por WhatsApp') throw new Error('override: ' + JSON.stringify(b));
    if (await T.page.evaluate(() => window.__xss)) throw new Error('XSS');
    const un = await untranslated(T.page, '#gc-att'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await T.page.waitForTimeout(300);
    await shot(T.page, 'session-list', '#gc-modal-box');
    // the student leaves → attendance_leave
    await S.page.click('#lc-ctl-end');
    for (let i = 0; i < 40 && row().in_room; i++) await S.page.waitForTimeout(100);
    if (row().in_room || !row().last_leave) throw new Error('leave not recorded: ' + JSON.stringify(row()));
    if (!calls.rpc.some(c => c.fn === 'attendance_leave')) throw new Error('no attendance_leave call');
    // a student outside the join window records nothing (database refuses)
    const r = await S.page.evaluate(id => sb.rpc('attendance_join', { p_session: id }).then(x => x.error?.message || 'ok'), t.now.id);
    if (r !== 'ok') throw new Error('rejoin within window should work: ' + r);
  });

  await run('Admin: group card → attendance report (%, matrix, date range) read-only + CSV export; another institution is refused', browser, async open => {
    const t = seed({ history: true });
    const A = await open();
    await login(A.page, 'adm@sol.uy');
    await A.page.evaluate(id => { currentOrgId = id; }, t.centro.id);
    await A.page.click('#nav-groups');
    await A.page.waitForSelector('#panel-groups.active .gc-gcard');
    await A.page.click('.gc-gcard [data-gc="g-att"]');
    await A.page.waitForSelector('#gc-modal-box .att-table');
    const heads = await A.page.$$eval('#gc-modal-box .att-table thead th', h => h.length);
    if (heads !== 6 + 4) throw new Error('matrix columns: ' + heads); // name, %, P T A J + 4 classes held (3 past + today)
    const ana = (await A.page.locator('#gc-modal-box .att-table tbody tr', { hasText: 'Ana Pérez' }).textContent()).replace(/\s+/g, ' ');
    if (!/100%/.test(ana)) throw new Error('Ana % (pending class not counted): ' + ana);
    const beto = (await A.page.locator('#gc-modal-box .att-table tbody tr', { hasText: 'Beto Ruiz' }).textContent()).replace(/\s+/g, ' ');
    if (!/50%/.test(beto)) throw new Error('Beto % (excused not counted, one absence): ' + beto);
    if (!/ana@mail\.com/.test(ana)) throw new Error('email loaded by the institution not shown to its admin');
    if (!/Solo lectura/.test(await A.page.textContent('#gc-modal-box .modal-sub'))) throw new Error('admin report not read-only');
    if (await A.page.evaluate(() => window.__xss)) throw new Error('XSS');
    const un = await untranslated(A.page, '#gc-modal-box'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(A.page, 'group-report', '#gc-modal-box');
    // CSV export (Spanish headers, ; separator, email + status per class)
    const [dl] = await Promise.all([A.page.waitForEvent('download'), A.page.click('#gc-modal-box [data-att="rep-csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.trim().split(/\r?\n/);
    if (!/^Nombre;Email;/.test(lines[0]) || !/Presente;Tarde;Ausente;Justificado;%$/.test(lines[0])) throw new Error('csv header: ' + lines[0]);
    const anaLine = lines.find(l => l.startsWith('Ana Pérez;ana@mail.com;'));
    if (!anaLine || !/Presente;Tarde;Presente/.test(anaLine)) throw new Error('csv Ana: ' + anaLine);
    if (!lines.some(l => /^"?Beto Ruiz/.test(l) && /Justificado/.test(l))) throw new Error('csv Beto: ' + csv);
    if (!/^asistencia-English-B1-Tue-Thu-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename())) throw new Error('csv name: ' + dl.suggestedFilename());
    // date range: only the last 3 days → 2 classes (routines + today)
    const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(d);
    await A.page.fill('#att-from', ymd(new Date(Date.now() - 3 * 864e5))); await A.page.fill('#att-to', ymd(new Date()));
    await A.page.click('#gc-modal-box [data-att="rep-apply"]');
    await A.page.waitForFunction(() => document.querySelectorAll('#gc-modal-box .att-table thead th').length === 8);
    // group card → classes & documents → attendance of one class (read-only list)
    await A.page.click('#gc-modal-box [data-gc="close"]');
    await A.page.click('.gc-gcard [data-gc="g-sessions"]');
    await A.page.waitForSelector(`#gc-modal-box [data-att="gs-att"][data-id="${t.past[2].id}"]`);
    await A.page.click(`#gc-modal-box [data-att="gs-att"][data-id="${t.past[2].id}"]`);
    await A.page.waitForSelector('#att-session-box .att-row');
    if (await A.page.$('#att-session-box select')) throw new Error('admin can correct');
    if (!/Médico/.test(await A.page.textContent('#att-session-box'))) throw new Error('teacher note not shown to the admin');
    // another institution's admin: refused by the database
    const O = await open(); await login(O.page, 'adm@otra.uy');
    const r = await O.page.evaluate(id => sb.rpc('attendance_report', { p_group: id }).then(x => x.error?.message || 'ok'), t.g.id);
    if (!/No autorizado/.test(r)) throw new Error('other admin: ' + r);
    const r2 = await O.page.evaluate(id => sb.rpc('session_attendance', { p_session: id }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/No autorizado/.test(r2)) throw new Error('other admin (class): ' + r2);
  });

  await run('Teacher: group report from the class detail (correct from the Calendar); a student cannot read the class list', browser, async open => {
    const t = seed({ history: true });
    const T = await open();
    await login(T.page, 'prof@sol.uy');
    await T.page.click('#nav-calendar');
    await T.page.waitForSelector('.gc-nextcard .gc-nc-title');
    await T.page.click(`.gc-nextcard [data-gc="open"][data-id="${t.now.id}"]`);
    await T.page.waitForSelector('#gc-modal-box [data-gc="att-report"]');
    await T.page.click('#gc-modal-box [data-gc="att-report"]');
    await T.page.waitForSelector('#gc-modal-box .att-table');
    if (!/Para corregir un estado, abrí la clase en el Calendario/.test(await T.page.textContent('#gc-modal-box .modal-sub'))) throw new Error('teacher hint');
    await T.page.click('#gc-modal-box [data-att="rep-back"]');
    await T.page.waitForSelector('#gc-att .att-row');
    const S = await open(); await studentLogin(S.page, t.ana);
    const r = await S.page.evaluate(id => sb.rpc('session_attendance', { p_session: id }).then(x => x.error?.message || 'ok'), t.now.id);
    if (!/No autorizado/.test(r)) throw new Error('student read the class list: ' + r);
    const r2 = await S.page.evaluate(id => sb.rpc('attendance_report', { p_group: id }).then(x => x.error?.message || 'ok'), t.g.id);
    if (!/No autorizado/.test(r2)) throw new Error('student read the report: ' + r2);
  });

  await run('Student dashboard: own attendance summary ("Asististe a 3 de 3 clases"), nothing about classmates; class documents list', browser, async open => {
    const t = seed({ history: true });
    db.class_docs.push({ session_id: t.past[2].id, state: null, state_upto: 0, generation: 1, locked: false, channel_key: 'b'.repeat(64), updated_at: new Date().toISOString() });
    const S = await open();
    await studentLogin(S.page, t.ana);
    await S.page.waitForSelector('.gs-att .gs-att-big');
    const card = (await S.page.textContent('.gs-att')).replace(/\s+/g, ' ');
    if (!/Asististe a 3 de 3 clases/.test(card) || !/Presente: 2/.test(card) || !/Tarde: 1/.test(card)) throw new Error('summary: ' + card);
    const all = await S.page.textContent('#gc-student-root');
    if (/Beto|Caro|beto@|caro@/.test(all)) throw new Error('classmates shown');
    if (!/Unit 3: routines/.test(await S.page.textContent('.gs-docs-card'))) throw new Error('documents list');
    const un = await untranslated(S.page, '#gc-student-root'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(S.page, 'student-dashboard');
    // Beto: present once, absent once, excused once (shown as a chip) → 1 of 3
    const B = await open(); await studentLogin(B.page, t.beto);
    await B.page.waitForSelector('.gs-att .gs-att-big');
    if (!/Asististe a 1 de 3 clases.*Justificado: 1/.test((await B.page.textContent('.gs-att')).replace(/\s+/g, ' '))) throw new Error('Beto summary: ' + await B.page.textContent('.gs-att'));
  });

  await run('Mobile: attendance list in the class detail and the student summary fit the screen (no horizontal scroll)', browser, async open => {
    const t = seed({ history: true });
    const S = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await studentLogin(S.page, t.ana);
    await S.page.waitForSelector('.gs-att .gs-att-big');
    await S.page.locator('.gs-att').scrollIntoViewIfNeeded();
    let over = await S.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) throw new Error('student horizontal scroll: ' + over);
    await shot(S.page, 'mobile-student', '.gs-att');
    const T = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await login(T.page, 'prof@sol.uy');
    await T.page.evaluate(() => showPanel('calendar'));
    await T.page.waitForSelector('.gc-nextcard .gc-nc-title');
    await T.page.click(`.gc-nextcard [data-gc="open"][data-id="${t.now.id}"]`);
    await T.page.waitForSelector('#gc-att .att-row');
    await T.page.locator('#gc-att').scrollIntoViewIfNeeded();
    over = await T.page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, document.getElementById('gc-modal-box').scrollWidth - document.getElementById('gc-modal-box').clientWidth));
    if (over > 1) throw new Error('teacher horizontal scroll: ' + over);
    await shot(T.page, 'mobile');
  });

  await browser.close();
  if (failed) { console.log(`${failed} attendance scenario(s) failed`); process.exit(1); }
  console.log('All attendance scenarios passed');
})();
