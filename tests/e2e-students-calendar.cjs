// Groups + Students + Calendar: admin groups + CSV import (preview, errors, idempotent), teacher weekly series in
// the week view (detail, students, invite fallback, .ics, edit), student magic link (only 3 sections, join window,
// no classmates' emails, Spanish), student without classes, View as → Student, mobile layout, calendar feed dialog.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-students-calendar.cjs   (SHOTS=<dir> saves stu-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const XSS = '<img src=x onerror="window.__xss=1">';
const MIN = 60000;

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true, hasTouch: !!opts.touch, isMobile: !!opts.mobile });
  const st = { errors: [], notify: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/notify/session') { st.notify.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, sent: 0, message: 'email not configured' }) }); }
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  await ctx.grantPermissions([]).catch(() => {});
  const page = await ctx.newPage(); page.__st = st;
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource|getUserMedia|NotAllowedError|NotFoundError|Requested device not found/.test(m.text())) st.errors.push('console: ' + m.text()); });
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
async function login(page, email, lang = 'en') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const shot = async (page, name) => { if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/stu-${name}.png` }); };
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || t === 'G+') continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);

// ── seed: Instituto Sol › Sede Centro ; Otra Escuela (another institution) ──
function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  const owner = M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  const sub = mk('sub@sol.uy', 'Pablo Suplente', 'teacher', centro.id);
  const tx = mk('tx@otra.uy', 'Teacher Otra', 'teacher', otra.id);
  return { sol, centro, otra, owner, adm, prof, sub, tx };
}
// a group with students and sessions (one starting in 5 minutes)
function seedClasses(t) {
  const g = { id: M.uid(), institution_id: t.centro.id, name: 'English B1 – Tue/Thu', teacher_id: t.prof.id, substitute_id: t.sub.id, timezone: 'America/Montevideo' };
  db.class_groups.push(g);
  const e = (email, name, inst = t.centro.id) => { const r = { id: M.uid(), institution_id: inst, email, name, user_id: null, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(r); return r; };
  const ana = e('Ana.Perez@mail.com', 'Ana Pérez'); const bruno = e('bruno@mail.com', 'Bruno ' + XSS); const carla = e('carla@mail.com', 'Carla Ruiz');
  e('ANA.PEREZ@mail.com', 'Ana (Otra)', t.otra.id); // the same person loaded by another institution
  [ana, bruno, carla].forEach(x => db.group_members.push({ group_id: g.id, enrollment_id: x.id }));
  const now = Date.now(); const mk = (offMin, dur, title, status = 'scheduled') => { const s = { id: M.uid(), institution_id: t.centro.id, group_id: g.id, series_id: null, teacher_id: t.prof.id, title, starts_at: new Date(now + offMin * MIN).toISOString(), ends_at: new Date(now + (offMin + dur) * MIN).toISOString(), timezone: 'America/Montevideo', status, seq: 0, modified: false, updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
  const soon = mk(5, 60, 'Making plans ' + XSS);
  const later = mk(26 * 60, 90, 'Future forms');
  mk(50 * 60, 90, 'Cancelled one', 'cancelled');
  return { g, ana, bruno, carla, soon, later };
}
async function magicLink(page, email) {
  await page.goto('http://teroclass.test/?student');
  await page.waitForSelector('#tab-student-login', { state: 'visible' });
  await page.fill('#student-email', email);
  await page.click('#btn-student-link');
  await page.waitForSelector('#student-sent', { state: 'visible' });
  const u = Object.values(db.users).find(x => x.email === email.toLowerCase());
  if (!u) throw new Error('no account created by the magic link');
  // "click" the link in the email: Supabase redirects back with the session in the URL hash
  await page.goto(`http://teroclass.test/#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=magiclink`);
  await page.waitForSelector('#screen-app.active');
  return u;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('Admin: Groups panel — create a group (teacher + substitute), CSV import with preview + errors, idempotent re-import', browser, async ({ page }) => {
    const t = seed();
    await login(page, 'adm@sol.uy');
    if (!(await page.isVisible('#nav-groups'))) throw new Error('Groups not in the Institution group');
    if (await page.isVisible('#nav-calendar')) throw new Error('Calendar shown in admin mode');
    await page.click('#nav-groups');
    await page.waitForSelector('#panel-groups.active .gc-empty-big');
    await page.click('#gc-groups-body [data-gc="new-group"]');
    await page.waitForSelector('#gc-g-name');
    await page.fill('#gc-g-name', 'English B1 – Tue/Thu');
    await page.selectOption('#gc-g-unit', t.centro.id);
    await page.selectOption('#gc-g-teacher', t.prof.id);
    await page.selectOption('#gc-g-sub', t.prof.id);
    await shot(page, 'x-group-form');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /substitute must be a different person/);
    await page.selectOption('#gc-g-sub', t.sub.id);
    await page.click('#gc-modal-box [type=submit]');
    await page.waitForSelector('.gc-gcard');
    const card = await page.textContent('.gc-gcard');
    if (!/Laura Gómez/.test(card) || !/Pablo Suplente/.test(card) || !/Sede Centro/.test(card)) throw new Error('card: ' + card);
    if (await page.evaluate(() => !!document.querySelector('#gc-g-teacher option[value]')?.textContent.includes('tx@otra'))) throw new Error('teacher of another institution offered');
    // manual student
    await page.click('.gc-gcard [data-gc="add-student"]');
    await page.fill('#gc-a-email', 'zoe@mail.com'); await page.fill('#gc-a-name', 'Zoe ' + XSS);
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /Student added/);
    // CSV import: flexible column order (header), comma/semicolon, errors in the preview
    await page.click('[data-gc="import"]');
    await page.waitForSelector('#gc-imp-text');
    const csv = ['Nombre;Correo;Grupo;Docente;Unidad',
      'Ana Pérez;Ana.Perez@mail.com;English B1 – Tue/Thu;;centro',
      'Bad;not-an-email;English B1 – Tue/Thu;;centro',
      'Ana again;ANA.PEREZ@mail.com;english b1 – tue/thu;;Sede Centro',
      'Eve;eve@mail.com;Math 2;prof@sol.uy;centro',
      'Gus;gus@mail.com;French;tx@otra.uy;centro',
      'Hal;hal@mail.com;;;Nowhere',
      'Zoe;zoe@mail.com;;;centro'].join('\n');
    await page.fill('#gc-imp-text', csv);
    await page.click('[data-gc="imp-check"]');
    await page.waitForSelector('.gc-imp-table');
    const statuses = await page.$$eval('.gc-imp-table tbody tr', rows => rows.map(r => r.cells[4].textContent.trim()));
    const want = ['Will be added', 'Invalid email', 'Repeated in the file', 'Group to create', 'Teacher not found in your institution', 'Unknown unit', 'Already loaded'];
    if (JSON.stringify(statuses) !== JSON.stringify(want)) throw new Error('statuses: ' + JSON.stringify(statuses));
    const sum = await page.$$eval('.gc-imp-sum .metric-value', v => v.map(x => x.textContent));
    if (JSON.stringify(sum) !== '["7","2","1","4"]') throw new Error('summary: ' + JSON.stringify(sum));
    if (!/Math 2/.test(await page.textContent('.gc-imp-newg'))) throw new Error('new group not offered');
    if (db.student_enrollments.length !== 1) throw new Error('preview wrote data');
    await shot(page, 'csv-preview');
    // unchecking "create the new groups" skips those rows
    await page.uncheck('#gc-imp-create');
    if (!/Skipped: unknown group/.test(await page.textContent('.gc-imp-table'))) throw new Error('unchecked new groups not skipped');
    await page.check('#gc-imp-create');
    await page.click('[data-gc="imp-commit"]');
    await waitToast(page, /Imported ✓ 2 added, 1 already there, 4 skipped/);
    await page.waitForFunction(() => document.querySelectorAll('.gc-gcard').length === 2);
    const math = db.class_groups.find(g => g.name === 'Math 2');
    if (!math || math.teacher_id !== t.prof.id) throw new Error('Math 2 not created with its teacher');
    if (!db.student_enrollments.some(e => e.email === 'Ana.Perez@mail.com')) throw new Error('email not stored as loaded');
    // members of the group (names + emails for the admin)
    if (!(await page.$('.gc-mtable'))) await page.click('.gc-gcard [data-gc="g-members"]'); // opens by itself after adding a student
    await page.waitForSelector('.gc-mtable');
    if (!/Ana.Perez@mail.com/.test(await page.textContent('.gc-mtable'))) throw new Error('members not listed');
    await shot(page, 'admin-groups');
    // re-import the same file: nothing new
    await page.click('[data-gc="import"]');
    await page.fill('#gc-imp-text', csv);
    await page.click('[data-gc="imp-check"]');
    await page.waitForSelector('.gc-imp-table');
    const sum2 = await page.$$eval('.gc-imp-sum .metric-value', v => v.map(x => x.textContent));
    if (sum2[1] !== '0') throw new Error('re-import would add rows: ' + JSON.stringify(sum2));
    if (!(await page.isDisabled('[data-gc="imp-commit"]'))) throw new Error('import button enabled with nothing to add');
    await page.click('[data-gc="close"], .btn-modal-cancel').catch(() => {});
    await page.keyboard.press('Escape');
    // template download
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.gc-head [data-gc="template"]')]);
    const txt = require('fs').readFileSync(await dl.path(), 'utf8');
    if (!/^﻿?email,name,group,teacher_email,unit,substitute_email,days,start_time,end_time,start_date,end_date,timezone\n/.test(txt)) throw new Error('template: ' + txt.slice(0, 120));
    if (!/INEFOP A1\.1 LMi 7:00/.test(txt) || txt.trim().split('\n').length < 4) throw new Error('template rows: ' + txt);
    // students tab: search, move / remove (two clicks)
    await page.click('[data-gc="gtab"][data-t="students"]');
    await page.waitForSelector('.gc-stable');
    await page.fill('#gc-st-search', 'eve');
    if ((await page.$$('.gc-stable tbody tr')).length !== 1) throw new Error('search');
    const rm = page.locator('.gc-stable [data-gc="s-remove"]').first();
    await rm.click(); await rm.click();
    await waitToast(page, /Student removed/);
    if (db.student_enrollments.some(e => e.email === 'eve@mail.com')) throw new Error('not removed');
    // Spanish: everything translated
    await page.evaluate(() => setUiLang('es'));
    await page.click('[data-gc="gtab"][data-t="groups"]');
    await page.waitForSelector('.gc-gcard');
    const un = await untranslated(page, '#panel-groups');
    if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
  });

  await run('Teacher: weekly series → week view; detail with students, invite fallback (no email provider), .ics, edit one class', browser, async ({ page }) => {
    const t = seed(); const c = seedClasses(t);
    db.class_sessions = []; // only what the teacher creates
    await login(page, 'prof@sol.uy');
    if (!(await page.isVisible('#nav-calendar'))) throw new Error('Calendar not in the Teaching group');
    await page.click('#nav-calendar');
    await page.waitForSelector('#panel-calendar.active .gc-week');
    await page.click('[data-gc="new-session"]');
    await page.waitForSelector('#gc-modal-box form[data-gcf="new"]');
    if ((await page.$$eval('input[name=gc-wd]:checked', i => i.map(x => x.value))).join() !== '2,4') throw new Error('default Tue/Thu');
    await page.fill('#gc-n-title', 'B1 class');
    await shot(page, 'x-teacher-new');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /classes scheduled ✓/);
    if (!db.class_sessions.length) throw new Error('no sessions');
    const tues = db.class_sessions.map(s => new Date(s.starts_at)).map(d => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d));
    if (!tues.every(x => /^(Tue|Thu) 18:00$/.test(x))) throw new Error('stored times: ' + tues.slice(0, 3));
    // next week always has a Tuesday and a Thursday
    await page.click('[data-gc="next"]');
    await page.waitForFunction(() => document.querySelectorAll('.gc-ev').length === 2);
    await shot(page, 'teacher-week');
    await page.click('.gc-ev');
    await page.waitForSelector('#gc-people .gc-people-list');
    const ppl = await page.textContent('#gc-people');
    if (!/Ana.Perez@mail.com/.test(ppl) || !/carla@mail.com/.test(ppl)) throw new Error('teacher should see students: ' + ppl);
    await shot(page, 'x-teacher-detail');
    // the teacher can always open the room (to prepare); students only from 10 minutes before
    if (!(await page.isEnabled('#gc-modal-box .gc-join'))) throw new Error('teacher cannot enter the room a week before');
    if (!/Enter room/.test(await page.textContent('#gc-modal-box .gc-join'))) throw new Error('no "Enter room"');
    if (!/Students can join from 10 min before/.test(await page.textContent('#gc-modal-box .gc-join-row'))) throw new Error('no note for students');
    const g = await page.getAttribute('#gc-modal-box a[href*="calendar.google.com"]', 'href');
    if (!/action=TEMPLATE/.test(g) || !/dates=\d{8}T\d{6}Z\/\d{8}T\d{6}Z/.test(g)) throw new Error('google link: ' + g);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gc-modal-box [data-gc="ics"]')]);
    const ics = require('fs').readFileSync(await dl.path(), 'utf8');
    if (!ics.startsWith('BEGIN:VCALENDAR\r\n') || !/\r\nUID:[0-9a-f-]{36}@teroclass\.com\r\n/.test(ics) || !/\r\nDTSTART:\d{8}T\d{6}Z\r\n/.test(ics) || /[^\r]\n/.test(ics)) throw new Error('ics: ' + ics.slice(0, 200));
    await page.click('[data-gc="notify"]');
    await page.waitForSelector('#gc-notify-note.warn');
    if (page.__st.notify.at(-1)?.kind !== 'invite') throw new Error('notify not called');
    await page.waitForTimeout(100);
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    // edit only this class
    await page.click('[data-gc="edit-one"]');
    await page.fill('#gc-e-time', '19:30');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /Class updated/);
    const edited = db.class_sessions.find(s => s.modified);
    if (!edited || edited.seq !== 1) throw new Error('single edit not stored');
    // agenda view (mobile-friendly list)
    await page.click('[data-gc="view"][data-v="agenda"]');
    await page.waitForSelector('.gc-agenda .gc-ag-item');
    // a one-off class inviting by email
    await page.click('[data-gc="new-session"]');
    await page.click('[data-gc="kind"][data-k="one"]');
    await page.selectOption('#gc-n-group', '');
    await page.fill('#gc-n-emails', 'new.kid@mail.com, bad@');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /Invalid email: bad@/);
    await page.fill('#gc-n-emails', 'new.kid@mail.com');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /Class scheduled ✓/);
    const kid = db.student_enrollments.find(e => e.email === 'new.kid@mail.com');
    if (!kid || kid.loaded_by !== t.prof.id || kid.source !== 'session' || kid.institution_id !== t.centro.id) throw new Error('ad hoc email not loaded by the teacher');
    await page.evaluate(() => setUiLang('es'));
    await page.click('[data-gc="view"][data-v="week"]');
    await page.waitForSelector('.gc-week');
    const un = await untranslated(page, '#panel-calendar');
    if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
  });

  await run('Student: magic link → only Calendar / Enter class / My insights; join within the window; no classmates\' emails; Spanish', browser, async ({ page }) => {
    const t = seed(); const c = seedClasses(t);
    await magicLink(page, 'ana.perez@mail.com');
    if (calls.otp.at(-1)?.data?.via !== 'student_link') throw new Error('signInWithOtp without via=student_link');
    await page.waitForSelector('#panel-student.active .gs-enter');
    const p = db.profiles.find(x => x.email === 'ana.perez@mail.com');
    if (p.role !== 'student' || p.institution_id) throw new Error('profile: ' + JSON.stringify(p));
    if (!db.student_enrollments.filter(e => e.user_id === p.id).length === 2) throw new Error('enrollments not claimed');
    const sections = await page.$$eval('#gc-student-root .gs-card h2', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    if (JSON.stringify(sections) !== '["▶️ Enter class","📅 Calendar","💡 My insights"]') throw new Error('sections: ' + JSON.stringify(sections));
    for (const sel of ['.icon-sidebar', '#nav-ai', '.btn-new-class', '#mode-switch', '#inst-switch', '#sliders-container', '.btn-invite'])
      if (await page.isVisible(sel)) throw new Error(sel + ' visible to a student');
    await page.evaluate(() => showPanel('ai'));
    if (!(await page.isVisible('#panel-student'))) throw new Error('student reached the generator');
    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/bruno@|carla@/.test(body)) throw new Error('classmates\' emails visible');
    if (!/teacher:\s*laura gómez/.test(body)) throw new Error('teacher name missing');
    if (!/👥\s*3/.test(await page.textContent('.gs-groups'))) throw new Error('classmate count');
    // join is enabled (starts in 5 minutes) → live class lobby for that session
    const join = page.locator('.gs-enter .gc-join');
    if (!(await join.isEnabled())) throw new Error('join disabled within the window');
    // the later class shows "starts in" (disabled)
    await shot(page, 'student-en');
    await join.click();
    await page.waitForSelector('#panel-live.active #lc-name');
    if (await page.evaluate(() => LiveClass.state.sessionId) !== c.soon.id) throw new Error('session id not passed to the live class');
    if (!(await page.isChecked('input[name="lc-role"][value="student"]'))) throw new Error('lobby role is not student');
    await page.click('[data-lc="back-home"]');
    await page.waitForSelector('#panel-student.active .gs-enter');
    // error toasts with the tero still work
    await page.evaluate(() => showToast('Test error', 'err'));
    await page.waitForSelector('#toast.show .tero-err-bird');
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    // Spanish (language toggle still in the top bar)
    await page.click('.topbar .lang-toggle button[data-lang="es"]');
    await page.waitForFunction(() => /Entrar a clase/.test(document.getElementById('gc-student-root').innerText));
    const un = await untranslated(page, '#gc-student-root');
    if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(page, 'student-es');
    // calendar subscription: personal token, Google link, reset
    await page.click('[data-gc="subscribe"]');
    await page.waitForSelector('#gc-feed-url');
    const url1 = await page.inputValue('#gc-feed-url');
    await shot(page, 'x-student-feed');
    if (!/^http:\/\/teroclass\.test\/cal\/[0-9a-f]{64}\.ics$/.test(url1)) throw new Error('feed url: ' + url1);
    const gh = await page.getAttribute('#gc-modal-box a[href*="calendar.google.com"]', 'href');
    if (!gh.includes('cid=' + encodeURIComponent('webcal://teroclass.test/cal/'))) throw new Error('google subscribe: ' + gh);
    const reset = page.locator('[data-gc="reset-feed"]');
    await reset.click(); await reset.click();
    await page.waitForFunction(u => document.getElementById('gc-feed-url')?.value !== u, url1);
    const un2 = await untranslated(page, '#gc-modal-box');
    if (un2.length) throw new Error('untranslated (feed): ' + JSON.stringify(un2));
  });

  await run('Student without classes: friendly screen, no generator; magic link does not bypass teacher registration', browser, async ({ page }) => {
    seed();
    await magicLink(page, 'nobody@mail.com');
    await page.waitForSelector('.gs-empty');
    if (!/You don't have assigned classes yet/.test(await page.textContent('.gs-empty'))) throw new Error('empty screen');
    await shot(page, 'x-student-empty');
    const p = db.profiles.find(x => x.email === 'nobody@mail.com');
    if (p.role !== 'student' || p.institution_id) throw new Error('magic link created a teacher: ' + JSON.stringify(p));
    if (await page.isVisible('#nav-ai') || await page.isVisible('.icon-sidebar')) throw new Error('generator reachable');
    // rate limit message
    await page.click('[data-gc="logout"]');
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.click('#auth-student-link');
    await page.fill('#student-email', 'ratelimit@mail.com');
    await shot(page, 'x-login-student');
    await page.click('#btn-student-link');
    await page.waitForFunction(() => /Too many emails/.test(document.getElementById('auth-error').textContent));
  });

  await run('View as → Student (unit → group → student): student dashboard, read-only, then exit', browser, async ({ page }) => {
    const t = seed(); seedClasses(t);
    await login(page, M.SUPERADMIN_EMAIL);
    await page.waitForFunction(() => !appBooting);
    await page.evaluate(() => openViewAs());
    await page.waitForSelector('#modal-viewas.active');
    await page.click(`#va-tree [data-id="${t.centro.id}"]`);
    await page.check('input[name="va-persp"][value="student"]');
    await page.waitForSelector('#va-group-field', { state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#va-group option').length > 1);
    await page.click('#va-start');
    await waitToast(page, /Choose a group first/);
    await page.selectOption('#va-group', { label: 'English B1 – Tue/Thu' });
    await page.waitForFunction(() => document.querySelectorAll('#va-person option').length === 4);
    await page.selectOption('#va-person', { index: 1 });
    await shot(page, 'x-viewas-modal');
    await page.click('#va-start');
    await page.waitForSelector('#panel-student.active .gs-enter');
    const banner = await page.textContent('#viewas-banner');
    if (!/Viewing as:\s*Student/.test(banner) || !/English B1/.test(banner)) throw new Error('banner: ' + banner);
    if (await page.isVisible('.icon-sidebar')) throw new Error('sidebar in student view');
    if (!/The calendar subscription is personal/.test(await page.textContent('#gc-student-root'))) throw new Error('feed not hidden in View as');
    const body = await page.evaluate(() => document.body.innerText);
    if (/bruno@|carla@/i.test(body)) throw new Error('emails in the student view');
    await page.click('#viewas-banner [data-va="exit"]');
    await waitToast(page, /Back to your account/);
    if (await page.evaluate(() => document.body.classList.contains('student-mode'))) throw new Error('student mode kept after exit');
    if (!(await page.isVisible('.icon-sidebar'))) throw new Error('sidebar not back');
  });

  await run('Mobile: student dashboard stacked, big Join, no horizontal scroll; teacher calendar opens in agenda', browser, async ({ page }) => {
    const t = seed(); seedClasses(t);
    await magicLink(page, 'ana.perez@mail.com');
    await page.waitForSelector('#panel-student.active .gs-enter');
    await page.evaluate(() => setUiLang('es'));
    await page.waitForFunction(() => /Entrar a clase/.test(document.getElementById('gc-student-root').innerText));
    const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, wrap: [...document.querySelectorAll('#gc-student-root *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className).slice(0, 5) }));
    if (ov.doc > 0 || ov.wrap.length) throw new Error('horizontal overflow: ' + JSON.stringify(ov));
    const jb = await page.locator('.gs-enter .gc-join').boundingBox();
    if (!jb || jb.width < 300) throw new Error('join button not full width: ' + JSON.stringify(jb));
    await shot(page, 'student-mobile');
    await page.evaluate(() => handleLogout());
    await login(page, 'prof@sol.uy');
    await page.click('#nav-calendar');
    await page.waitForSelector('#panel-calendar.active .gc-agenda, #panel-calendar.active .bl-empty');
    if (await page.isVisible('.gc-week')) throw new Error('week grid on a phone by default');
    const ov2 = await page.evaluate(() => [...document.querySelectorAll('#panel-calendar *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className).slice(0, 5));
    if (ov2.length) throw new Error('calendar overflows on a phone: ' + JSON.stringify(ov2));
    await shot(page, 'x-teacher-mobile');
  }, { viewport: { width: 390, height: 844 }, mobile: true, touch: true });

  await browser.close();
  if (failed) { console.log(`${failed} students/calendar scenario(s) failed`); process.exit(1); }
  console.log('All students/calendar scenarios passed');
})();
