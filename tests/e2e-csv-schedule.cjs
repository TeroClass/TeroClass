// CSV import with schedules + entering the room from the calendar.
//  · Admin (Spanish): CSV with schedules → preview funnel per group (teacher status, classes, students), errors (conflicting
//    schedule, ambiguous "M", bad date); commit; group cards show schedule + "Pendiente: email (invitado/a)"; re-import is
//    idempotent; a changed schedule moves only future classes not edited one by one; the teacher's week view shows the
//    classes; the unregistered teacher registers → auto-assigned → sees the classes. Edit group: pick an invited email.
//  · Enter room: the teacher opens the room outside the class window from the next-class card, the week view detail and
//    the agenda (→ live class with that session id, as teacher); the student sees "Opens at HH:MM" (disabled) until
//    10 minutes before, then Join → the same session id, as student.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-csv-schedule.cjs   (SHOTS=<dir> saves csv2-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true, hasTouch: !!opts.touch, isMobile: !!opts.mobile });
  const st = { errors: [] };
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/notify/session') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, sent: 0 }) });
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
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
async function logout(page) { await page.evaluate(() => handleLogout()); await page.waitForSelector('#tab-login', { state: 'visible' }); }
const waitToast = (page, re, timeout = 8000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const hideToast = page => page.evaluate(() => document.getElementById('toast').classList.remove('show'));
const shot = async (page, name, sel) => {
  if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(450);
  if (sel) await page.locator(sel).screenshot({ path: `${SHOTS}/csv2-${name}.png` }); else await page.screenshot({ path: `${SHOTS}/csv2-${name}.png` });
};
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const root = document.querySelector(sel); if (!root) return ['(missing ' + sel + ')'];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t) || t === 'G+' || /^Empieza en \d/.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);
// Montevideo calendar dates (UTC-3, no DST): today + n
const mvdDate = n => new Date(Date.now() - 3 * 3600e3 + n * 864e5);
const dmy = n => { const d = mvdDate(n); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
const countDays = (days, a, b) => { let c = 0; for (let n = a; n <= b; n++) { const dow = ((mvdDate(n).getUTCDay() + 6) % 7) + 1; if (days.includes(dow)) c++; } return c; };
const mvdHM = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

function seed() {
  const sol = M.seedInstitution({ name: 'Instituto Sol', slug: 'sol', admin_email: 'adm@sol.uy' });
  const centro = M.seedInstitution({ name: 'Sede Centro', slug: 'centro', parent_id: sol.id, color: null, bg_color: null, font: null });
  const otra = M.seedInstitution({ name: 'Otra Escuela', slug: 'otra' });
  const mk = (email, name, role, inst) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return u; };
  M.newUser(M.SUPERADMIN_EMAIL, { name: 'Owner' });
  const adm = mk('adm@sol.uy', 'Admin Sol', 'org_admin', sol.id);
  const prof = mk('prof@sol.uy', 'Laura Gómez', 'teacher', centro.id);
  const tx = mk('tx@otra.uy', 'Teacher Otra', 'teacher', otra.id);
  return { sol, centro, otra, adm, prof, tx };
}
const CSV = (start = '07:00', end = '08:00') => ['email,nombre,grupo,docente,suplente,días,hora_inicio,hora_fin,desde,hasta',
  `,,INEFOP A1.1 LMi 7:00,prof@sol.uy,nueva.suplente@sol.uy,"Lun;Mié",${start},${end},${dmy(1)},${dmy(28)}`,
  'ana@mail.com,Ana Pérez,INEFOP A1.1 LMi 7:00,,,,,,,',
  'beto@mail.com,Beto Ruiz,INEFOP A1.1 LMi 7:00,,,,09:15,,,',
  `cami@mail.com,Cami Sosa,Inglés B1 MaJ,docente.nueva@sol.uy,,Mar y Jue,19:30,21:00,${dmy(1)},${dmy(28)}`,
  'dani@mail.com,Dani Paz,Inglés B1 MaJ,,,M,,,,',
  'eli@mail.com,Eli Rey,Inglés B1 MaJ,,,,,,31/02/2027,',
  'fede@mail.com,Fede Lima,Francés,tx@otra.uy,,,,,,'].join('\n');
const counts = () => [db.class_groups.length, db.student_enrollments.length, db.group_members.length, db.class_sessions.length, db.session_series.length, db.invitations.length].join('/');

async function openImport(page, csv) {
  await page.click('.gc-head [data-gc="import"]');
  await page.waitForSelector('#gc-imp-text');
  await page.fill('#gc-imp-text', csv);
  await page.click('[data-gc="imp-check"]');
  await page.waitForSelector('.gc-imp-table');
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  await run('CSV with schedules (ES): funnel preview, errors, commit, idempotent re-import, schedule change, pending teacher auto-assigned', browser, async ({ page }) => {
    const t = seed();
    const nMW = countDays([1, 3], 1, 28); const nTT = countDays([2, 4], 1, 28);
    await login(page, 'adm@sol.uy', 'es');
    await page.click('#nav-groups');
    await page.waitForSelector('#panel-groups.active .gc-empty-big');
    // help text next to the uploader lists the accepted columns
    await page.click('.gc-head [data-gc="import"]');
    await page.waitForSelector('.gc-imp-help');
    const help = await page.textContent('.gc-imp-help');
    for (const c of ['docente / teacher_email', 'suplente / substitute', 'días / days', 'hora_inicio / start_time', 'desde / start_date', 'zona / timezone']) if (!help.includes(c)) throw new Error('help misses ' + c);
    const unH = await untranslated(page, '#gc-modal-box'); if (unH.length) throw new Error('untranslated (import dialog): ' + JSON.stringify(unH));
    await page.keyboard.press('Escape');
    await openImport(page, CSV());
    // rows → groups → classes per teacher
    const funnel = await page.$$eval('.gc-fstep b', b => b.map(x => x.textContent));
    if (JSON.stringify(funnel.slice(0, 3)) !== JSON.stringify(['7', '2', String(nMW + nTT)])) throw new Error('funnel: ' + JSON.stringify(funnel) + ' want 7/2/' + (nMW + nTT));
    const per = await page.textContent('.gc-fper');
    if (!new RegExp(`Laura Gómez: ${nMW} clase${nMW === 1 ? '' : 's'}`).test(per) || !new RegExp(`docente.nueva@sol.uy Pendiente: ${nTT} clase${nTT === 1 ? '' : 's'}`).test(per.replace(/\s+/g, ' '))) throw new Error('per teacher: ' + per);
    // per group: name, teacher (registered / invited), substitute, schedule in words, classes, students
    const groups = await page.$$eval('.gc-imp-g', gs => gs.map(g => ({ name: g.querySelector('.gc-imp-gname').textContent, classes: g.querySelector('.gc-imp-classes').textContent, students: g.querySelector('.gc-imp-students').textContent, text: g.textContent.replace(/\s+/g, ' ') })));
    if (groups.length !== 2) throw new Error('groups: ' + JSON.stringify(groups));
    const [g1, g2] = groups;
    if (g1.name !== 'INEFOP A1.1 LMi 7:00' || g1.classes !== String(nMW) || g1.students !== '1') throw new Error('INEFOP card: ' + JSON.stringify(g1));
    if (!/Lun y Mié 07:00–08:00, del \d+\/\d+(\/\d{4})? al \d+\/\d+/.test(g1.text) || !/Registrado ✓/.test(g1.text) || !/nueva.suplente@sol.uy Sin registrarse: lo invitamos/.test(g1.text) || !/Horario nuevo/.test(g1.text)) throw new Error('INEFOP text: ' + g1.text);
    if (g2.name !== 'Inglés B1 MaJ' || g2.classes !== String(nTT) || !/Mar y Jue 19:30–21:00/.test(g2.text) || !/docente.nueva@sol.uy Sin registrarse: lo invitamos/.test(g2.text)) throw new Error('Inglés card: ' + JSON.stringify(g2));
    // per-row errors: conflicting schedule, ambiguous "M", bad date, teacher of another institution
    const st = await page.$$eval('.gc-imp-table tbody tr', rows => rows.map(r => r.cells[0].textContent + ':' + r.cells[4].textContent.replace(/\s+/g, ' ').trim()));
    const want = ['2:Datos del grupo (sin estudiante)', '3:Grupo a crear', '4:No coincide con otra fila del mismo grupo: hora de inicio', '5:Grupo a crear',
      '6:Día ambiguo: "M" puede ser martes o miércoles (usá Ma / Mi)', '7:Fecha de inicio inválida', '8:No encontramos ese docente en tu institución'];
    if (JSON.stringify(st) !== JSON.stringify(want)) throw new Error('rows: ' + JSON.stringify(st));
    if (counts() !== '0/0/0/0/0/0') throw new Error('preview wrote data: ' + counts());
    const un = await untranslated(page, '#gc-modal-box'); if (un.length) throw new Error('untranslated (preview): ' + JSON.stringify(un));
    await shot(page, 'preview-es', '#gc-modal-box');
    // commit: groups → teacher / substitute → enrollments → weekly series
    await page.click('[data-gc="imp-commit"]');
    await waitToast(page, /Importado ✓ 2 agregados, 0 ya estaban, 4 salteados/);
    const inefop = db.class_groups.find(g => g.name === 'INEFOP A1.1 LMi 7:00'); const ingles = db.class_groups.find(g => g.name === 'Inglés B1 MaJ');
    if (inefop?.teacher_id !== t.prof.id || inefop.pending_substitute_email !== 'nueva.suplente@sol.uy') throw new Error('INEFOP: ' + JSON.stringify(inefop));
    if (ingles?.teacher_id || ingles?.pending_teacher_email !== 'docente.nueva@sol.uy') throw new Error('Inglés: ' + JSON.stringify(ingles));
    if (!db.invitations.some(i => i.email === 'docente.nueva@sol.uy' && i.role === 'teacher' && i.institution_id === ingles.institution_id)) throw new Error('teacher not invited');
    const ses1 = db.class_sessions.filter(s => s.group_id === inefop.id);
    if (ses1.length !== nMW || !ses1.every(s => mvdHM(s.starts_at) === '07:00' && mvdHM(s.ends_at) === '08:00')) throw new Error('INEFOP sessions: ' + ses1.length);
    if (db.class_sessions.filter(s => s.group_id === ingles.id).length !== nTT) throw new Error('Inglés sessions');
    // group cards: schedule + pending teacher
    await page.waitForFunction(() => document.querySelectorAll('.gc-gcard').length === 2);
    const cards = await page.$$eval('.gc-gcard', c => c.map(x => x.textContent.replace(/\s+/g, ' ')));
    const ci = cards.find(c => c.includes('Inglés B1 MaJ'));
    if (!/Pendiente: docente.nueva@sol.uy \(invitado\/a\)/.test(ci) || !/Mar y Jue 19:30–21:00/.test(ci)) throw new Error('Inglés card after import: ' + ci);
    const unG = await untranslated(page, '#panel-groups'); if (unG.length) throw new Error('untranslated (groups): ' + JSON.stringify(unG));
    await shot(page, 'groups-after-import');
    // re-import the same file: nothing to do, nothing duplicated
    const c1 = counts();
    await openImport(page, CSV());
    const t2 = await page.textContent('#gc-modal-box');
    if ((t2.match(/Mismo horario: no cambia nada/g) || []).length !== 2) throw new Error('re-import should show unchanged schedules');
    if (!(await page.isDisabled('[data-gc="imp-commit"]'))) throw new Error('re-import: commit enabled with nothing to do');
    await page.evaluate(async csv => { const r = TCImport.csvToRows(csv); await sb.rpc('import_students', { p_unit: GC._test.GR.unit, p_rows: TCImport.toRpcRows(r.rows), p_create_groups: true, p_commit: true }); }, CSV());
    if (counts() !== c1) throw new Error(`re-import duplicated data: ${c1} → ${counts()}`);
    await page.keyboard.press('Escape');
    // schedule change: only future classes that were not edited one by one
    const fut = ses1.filter(s => Date.parse(s.starts_at) > Date.now()).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const edited = fut[0]; edited.modified = true; edited.title = 'Editada a mano'; const editedAt = edited.starts_at;
    const past = { id: M.uid(), institution_id: inefop.institution_id, group_id: inefop.id, series_id: ses1[0].series_id, teacher_id: t.prof.id, title: 'Pasada', starts_at: new Date(Date.now() - 7 * 864e5).toISOString(), ends_at: new Date(Date.now() - 7 * 864e5 + 60 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false };
    db.class_sessions.push(past);
    await openImport(page, CSV('08:30', '09:30').replace('09:15', '08:30'));
    const chg = (await page.textContent('.gc-imp-g')).replace(/\s+/g, ' ');
    if (!/Cambia el horario/.test(chg) || !/Antes: Lun y Mié 07:00–08:00/.test(chg) || !/Lun y Mié 08:30–09:30/.test(chg)) throw new Error('schedule change preview: ' + chg);
    await shot(page, 'x-schedule-change', '#gc-modal-box');
    await page.click('[data-gc="imp-commit"]');
    await waitToast(page, /Importado/);
    const after = db.class_sessions.filter(s => s.group_id === inefop.id);
    const moved = after.filter(s => s !== edited && s !== past);
    if (moved.length !== nMW - 1 || !moved.every(s => mvdHM(s.starts_at) === '08:30' && s.seq === 1)) throw new Error('future classes not moved: ' + moved.map(s => mvdHM(s.starts_at) + '/' + s.seq));
    if (edited.starts_at !== editedAt || !after.includes(edited) || !after.includes(past) || past.title !== 'Pasada' || mvdHM(past.starts_at) !== mvdHM(new Date(Date.now() - 7 * 864e5).toISOString())) throw new Error('edited / past class changed');
    // Edit group: an invited, not-yet-registered email can be chosen (and someone new invited by email)
    await page.click(`.gc-gcard:has-text("Inglés B1 MaJ") [data-gc="g-edit"]`);
    await page.waitForSelector('#gc-g-teacher');
    const sel = await page.inputValue('#gc-g-teacher');
    if (sel !== 'email:docente.nueva@sol.uy') throw new Error('pending teacher not preselected: ' + sel);
    await page.selectOption('#gc-g-sub', '__new');
    await page.waitForSelector('#gc-g-sub-new', { state: 'visible' });
    await page.fill('#gc-g-sub-new', 'otra.suplente@sol.uy');
    await shot(page, 'x-edit-group-pending', '#gc-modal-box');
    await page.click('#gc-modal-box [type=submit]');
    await waitToast(page, /La persona invitada queda asignada cuando se registre/);
    if (ingles.pending_substitute_email !== 'otra.suplente@sol.uy' || ingles.pending_teacher_email !== 'docente.nueva@sol.uy') throw new Error('edit group pending: ' + JSON.stringify(ingles));
    if (!db.invitations.some(i => i.email === 'otra.suplente@sol.uy')) throw new Error('substitute not invited from Edit group');
    await hideToast(page);
    // the teacher's calendar shows the imported classes (week view, next week: Monday + Wednesday)
    await logout(page);
    await login(page, 'prof@sol.uy', 'es');
    await page.click('#nav-calendar');
    await page.waitForSelector('#panel-calendar.active .gc-week');
    await page.click('[data-gc="next"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.gc-ev')].filter(e => /INEFOP/.test(e.textContent)).length === 2);
    await shot(page, 'teacher-calendar');
    // the unregistered teacher registers with the invitation → assigned → sees the group's classes
    await logout(page);
    M.newUser('docente.nueva@sol.uy', { name: 'Nadia Nueva' });
    if (!ingles.teacher_id || ingles.pending_teacher_email) throw new Error('pending teacher not auto-assigned: ' + JSON.stringify(ingles));
    await login(page, 'docente.nueva@sol.uy', 'es');
    await page.click('#nav-calendar');
    await page.click('[data-gc="view"][data-v="agenda"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.gc-ag-item')].filter(e => /Inglés B1 MaJ/.test(e.textContent)).length > 0);
  });

  await run('Enter room: teacher outside the window (next card, week detail, agenda) → live class for that session; student only inside the window', browser, async ({ page }) => {
    const t = seed();
    const g = { id: M.uid(), institution_id: t.centro.id, name: 'INEFOP A1.1 LMi 7:00', teacher_id: t.prof.id, substitute_id: null, timezone: 'America/Montevideo' };
    db.class_groups.push(g);
    const ana = { id: M.uid(), institution_id: t.centro.id, email: 'ana@mail.com', name: 'Ana Pérez', user_id: null, source: 'csv', created_at: new Date().toISOString() };
    db.student_enrollments.push(ana); db.group_members.push({ group_id: g.id, enrollment_id: ana.id });
    const mk = (offMin, dur, title) => { const s = { id: M.uid(), institution_id: t.centro.id, group_id: g.id, series_id: null, teacher_id: t.prof.id, title, starts_at: new Date(Date.now() + offMin * MIN).toISOString(), ends_at: new Date(Date.now() + (offMin + dur) * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, updated_at: new Date().toISOString() }; db.class_sessions.push(s); return s; };
    const later = mk(180, 60, 'Unit 4: routines'); // 3 hours from now: outside the students' window
    const tomorrow = mk(26 * 60, 60, 'Unit 5: food');
    const lc = () => page.evaluate(() => ({ id: LiveClass.state.sessionId, role: LiveClass.state.lobby?.role }));
    const backToCalendar = async () => { await page.evaluate(() => { LiveClass.reset(); showPanel('calendar'); }); await page.waitForSelector('#panel-calendar.active #gc-cal-body .gc-week, #panel-calendar.active #gc-cal-body .gc-agenda'); };
    await login(page, 'prof@sol.uy');
    await page.click('#nav-calendar');
    // 1) today's / next class card: visible "Enter room" + note for students
    await page.waitForSelector('.gc-nextcard [data-gc="join"]');
    const card = (await page.textContent('.gc-nextcard')).replace(/\s+/g, ' ');
    if (!/Unit 4: routines/.test(card) || !/Enter room/.test(card) || !/Students can join from 10 min before/.test(card)) throw new Error('next card: ' + card);
    await shot(page, 'x-teacher-next-card', '.gc-nextcard');
    await page.click('.gc-nextcard [data-gc="join"]');
    await page.waitForSelector('#panel-live.active #lc-joinas');
    let r = await lc(); if (r.id !== later.id || r.role !== 'teacher') throw new Error('next card → live: ' + JSON.stringify(r));
    // 2) week view: click the event → detail with "Enter room"
    await backToCalendar();
    await page.click('[data-gc="view"][data-v="week"]');
    await page.waitForSelector('#gc-cal-body .gc-week');
    await page.waitForFunction(() => GC._test.CAL.loaded);
    await page.waitForTimeout(200);
    if (!(await page.$(`.gc-ev[data-id="${tomorrow.id}"]`))) { await page.click('[data-gc="next"]'); await page.waitForSelector(`.gc-ev[data-id="${tomorrow.id}"]`); } // tomorrow may be next week
    await page.click(`.gc-ev[data-id="${tomorrow.id}"]`);
    await page.waitForSelector('#gc-modal-box .gc-join-row [data-gc="join"]');
    if (!(await page.isEnabled('#gc-modal-box .gc-join-row [data-gc="join"]'))) throw new Error('detail: Enter room disabled');
    if (!/Students can join from 10 min before/.test(await page.textContent('#gc-modal-box .gc-join-row'))) throw new Error('detail: no note');
    await page.waitForSelector('#gc-people .gc-people-list');
    await shot(page, 'event-detail', '#gc-modal-box');
    await page.click('#gc-modal-box .gc-join-row [data-gc="join"]');
    await page.waitForSelector('#panel-live.active #lc-joinas');
    r = await lc(); if (r.id !== tomorrow.id || r.role !== 'teacher') throw new Error('detail → live: ' + JSON.stringify(r));
    // 3) agenda list: inline "Enter room" (does not open the detail)
    await backToCalendar();
    await page.click('[data-gc="today"]');
    await page.click('[data-gc="view"][data-v="agenda"]');
    await page.waitForSelector(`.gc-ag-item[data-id="${later.id}"] [data-gc="join"]`);
    await page.click(`.gc-ag-item[data-id="${later.id}"] [data-gc="join"]`);
    await page.waitForSelector('#panel-live.active #lc-joinas');
    r = await lc(); if (r.id !== later.id || r.role !== 'teacher') throw new Error('agenda → live: ' + JSON.stringify(r));
    if (await page.evaluate(() => document.getElementById('modal-gc').classList.contains('active'))) throw new Error('agenda join also opened the detail');
    // Spanish: everything translated on the calendar (card + agenda)
    await backToCalendar();
    await page.evaluate(() => setUiLang('es'));
    await page.click('[data-gc="view"][data-v="agenda"]');
    await page.waitForFunction(() => /Entrar a la sala/.test(document.querySelector('.gc-nextcard')?.textContent || ''));
    const un = await untranslated(page, '#panel-calendar'); if (un.length) throw new Error('untranslated: ' + JSON.stringify(un));
    await shot(page, 'x-teacher-agenda-es');
    // 4) student: outside the window → disabled "Abre a las HH:MM"; inside → Join → same room, as student
    await logout(page);
    await page.goto('http://teroclass.test/?student');
    await page.waitForSelector('#tab-student-login', { state: 'visible' });
    await page.evaluate(() => setUiLang('es'));
    await page.fill('#student-email', 'ana@mail.com'); await page.click('#btn-student-link');
    await page.waitForSelector('#student-sent', { state: 'visible' });
    const u = Object.values(db.users).find(x => x.email === 'ana@mail.com');
    await page.goto(`http://teroclass.test/#access_token=tok-${u.id}&refresh_token=r-${u.id}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&token_type=bearer&type=magiclink`);
    await page.waitForSelector('#panel-student.active .gs-enter .gc-join');
    const opens = new Intl.DateTimeFormat('es-UY', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Montevideo' }).format(new Date(Date.parse(later.starts_at) - 10 * MIN));
    const b1 = page.locator('.gs-enter .gc-join');
    if (await b1.isEnabled()) throw new Error('student join enabled 3 hours before');
    const mvdDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date(ms));
    const sameDayOpen = mvdDay(Date.parse(later.starts_at) - 10 * MIN) === mvdDay(Date.now()); // browser tz = Montevideo
    const btxt = (await b1.textContent()).trim();
    if (sameDayOpen ? btxt !== `Abre a las ${opens}` : !new RegExp(`^Abre el .+ a las ${opens}$`).test(btxt)) throw new Error('student button: ' + btxt);
    if (await page.$('.gs-cal [data-gc="join"]')) throw new Error('join in the student list outside the window');
    const unS = await untranslated(page, '#gc-student-root'); if (unS.length) throw new Error('untranslated (student): ' + JSON.stringify(unS));
    await shot(page, 'student-outside', '.gs-enter');
    await page.evaluate(() => { GC._test.ST.data = null; }); // simulate the clock reaching 5 minutes before the class
    later.starts_at = new Date(Date.now() + 5 * MIN).toISOString(); later.ends_at = new Date(Date.now() + 65 * MIN).toISOString();
    await page.click('[data-gc="st-reload"]').catch(async () => { await page.evaluate(() => GC.render('student')); });
    await page.waitForFunction(() => { const b = document.querySelector('.gs-enter .gc-join'); return b && !b.disabled; });
    if (!(await page.$('.gs-cal [data-gc="join"]'))) throw new Error('no join in the student calendar list during the window');
    await shot(page, 'student-inside', '.gs-enter');
    await page.click('.gs-enter .gc-join');
    await page.waitForSelector('#panel-live.active #lc-joinas');
    r = await lc(); if (r.id !== later.id || r.role !== 'student') throw new Error('student → live: ' + JSON.stringify(r));
  });

  await run('Mobile: next-class card and agenda "Enter room" fit the screen', browser, async ({ page }) => {
    const t = seed();
    const g = { id: M.uid(), institution_id: t.centro.id, name: 'INEFOP A1.1 LMi 7:00', teacher_id: t.prof.id, substitute_id: null, timezone: 'America/Montevideo' };
    db.class_groups.push(g);
    db.class_sessions.push({ id: M.uid(), institution_id: t.centro.id, group_id: g.id, series_id: null, teacher_id: t.prof.id, title: 'Unit 4: routines', starts_at: new Date(Date.now() + 180 * MIN).toISOString(), ends_at: new Date(Date.now() + 240 * MIN).toISOString(), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false });
    await login(page, 'prof@sol.uy', 'es');
    await page.click('#nav-calendar');
    await page.waitForSelector('.gc-nextcard [data-gc="join"]');
    await page.waitForSelector('.gc-agenda .gc-ag-item [data-gc="join"]');
    const ov = await page.evaluate(() => [...document.querySelectorAll('#panel-calendar *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className).slice(0, 5));
    if (ov.length) throw new Error('overflow: ' + JSON.stringify(ov));
    await shot(page, 'x-teacher-mobile');
  }, { viewport: { width: 390, height: 844 }, mobile: true, touch: true });

  await browser.close();
  if (failed) { console.log(`${failed} csv/schedule scenario(s) failed`); process.exit(1); }
  console.log('All csv/schedule scenarios passed');
})();
