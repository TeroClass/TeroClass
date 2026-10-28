// Real (recorded) class insights in the Insights panel: the "processing" state while the server transcribes and analyses the
// class (POST /api/class/process every ~20 s; here every 300 ms), then the REAL insights (is_demo = false) render with the same
// view as the demo ones. Mock Supabase (tests/mock-supabase.cjs) + mocked /api/config and /api/class/process.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-recording.cjs   (SHOTS=<dir> saves rec-*.png)
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, calls, recording, handleSupabase, HTML, SB_JS, SB } = M;

let failed = 0;
const SHOTS = process.env.SHOTS || '';
const MIN = 60000;
const XSS = '<img src=x onerror="window.__xss=1">';

async function setup(browser, opts = {}) {
  M.resetDb();
  const ctx = await browser.newContext({ timezoneId: 'America/Montevideo', viewport: opts.viewport || { width: 1366, height: 900 }, hasTouch: !!opts.mobile, isMobile: !!opts.mobile });
  const st = { errors: [], process: [] };
  await ctx.addInitScript(() => { window.TC_REC_POLL_MS = 300; });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.request().url().includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort());
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/config') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ recording: opts.recording !== false }) });
    if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":false}' });
    if (u.pathname === '/api/billing/status') return r.fulfill({ contentType: 'application/json', body: '{"billing_configured":true,"billing_ok":true}' });
    if (u.pathname === '/api/class/process') {
      const body = JSON.parse(r.request().postData() || '{}'); st.process.push({ body, auth: r.request().headers().authorization || '' });
      const out = opts.onProcess ? opts.onProcess(body, st.process.length) : { state: 'processing' };
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(out) });
    }
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => { st.errors.push('dialog: ' + d.message()); d.dismiss(); });
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
async function login(page, email, lang = 'en') {
  await page.goto('http://teroclass.test/');
  await page.waitForSelector('#tab-login', { state: 'visible' });
  await page.evaluate(l => setUiLang(l), lang);
  await page.fill('#login-email', email); await page.fill('#login-password', 'secreto123');
  await page.click('#tab-login .auth-btn');
  await page.waitForSelector('#screen-app.active');
}
const text = (page, sel) => page.textContent(sel);
const shot = async (page, name) => { if (!SHOTS) return; await page.mouse.move(2, 2); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/rec-${name}.png` }); };
const hscroll = page => page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ins-root')].filter(r => r.offsetParent).map(r => r.scrollWidth - r.clientWidth)));
const untranslated = (page, sel) => page.evaluate(sel => {
  const vals = new Set(Object.values(I18N_ES)); const out = [];
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.trim(); const p = n.parentElement;
    if (!t || !p.offsetParent || p.closest('[data-no-i18n],textarea,option,script,style')) continue;
    if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t)) continue;
    if (vals.has(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}, sel);
const ago = ms => new Date(Date.now() - ms).toISOString();

function seed() {
  const madre = M.seedInstitution({ name: 'TEC', slug: 'tec', color: '#aa0000' });
  const centro = M.seedInstitution({ name: 'TEC Centro', slug: 'tec-centro', color: null, bg_color: null, font: null, parent_id: madre.id });
  const mk = (email, role, inst, name) => { const u = M.newUser(email, { name }); const p = db.profiles.find(x => x.id === u.id); p.role = role; p.institution_id = inst; return p; };
  const tc = mk('tc@tec.com', 'teacher', centro.id, 'Tina Teacher');
  const ana = M.newUser('ana@mail.com', { via: 'student_link', name: 'Ana' });
  const g1 = { id: M.uid(), institution_id: centro.id, name: 'English B1', teacher_id: tc.id, substitute_id: null, timezone: 'America/Montevideo', pending_teacher_email: null, pending_substitute_email: null };
  db.class_groups.push(g1);
  const en = (email, name, user) => { const e = { id: M.uid(), institution_id: centro.id, email, name, user_id: user ? user.id : null, loaded_by: null, source: 'manual', created_at: new Date().toISOString() }; db.student_enrollments.push(e); db.group_members.push({ group_id: g1.id, enrollment_id: e.id }); return e; };
  const eAna = en('ana@mail.com', 'Ana Alonso', ana); const eBruno = en('bruno@mail.com', 'Bruno ' + XSS, null); const eCaro = en('caro@mail.com', 'Caro Castro', null);
  const s1 = { id: M.uid(), institution_id: centro.id, group_id: g1.id, series_id: null, teacher_id: tc.id, title: 'Making plans', starts_at: ago(3 * 60 * MIN),
    ends_at: ago(3 * 60 * MIN - 45 * MIN), timezone: 'America/Montevideo', status: 'scheduled', seq: 0, modified: false, created_at: ago(864e5), updated_at: ago(864e5) };
  db.class_sessions.push(s1);
  return { tc, ana, g1, eAna, eBruno, eCaro, s1 };
}

// the server finishing the analysis: rows exactly as api/_lib/rec/analysis.js builds them (is_demo = false)
let AN;
async function realRows(t) {
  AN = AN || await import('../api/_lib/rec/analysis.js');
  const parts = [{ participant_id: 'pT', role: 'teacher', name: 'Tina', recorded: true }, { participant_id: 'pA', role: 'student', name: 'Ana', recorded: true }, { participant_id: 'pB', role: 'student', name: 'Bruno', recorded: true }];
  const segs = [
    { participant_id: 'pT', start_ms: 0, end_ms: 90000, text: 'Hello everyone. What are you going to do this weekend?' },
    { participant_id: 'pA', start_ms: 92500, end_ms: 122500, text: 'I am going to visit my grandmother and we are going to cook together' },
    { participant_id: 'pB', start_ms: 125000, end_ms: 140000, text: 'I will play football with my friends on Saturday' },
    { participant_id: 'pT', start_ms: 141000, end_ms: 400000, text: 'Great. Now the explanation of going to and will.' },
  ];
  const m = AN.computeMetrics({ participants: parts, segments: segs });
  const ai = AN.validateTeacherAi({ kind: 'language', subject: 'English B1', objective: 'Talk about future plans with going to', observation_focus: 'Student talk time',
    recap: { summary: 'REAL RECAP: we talked about weekend plans with going to and will.', topics: [{ title: 'Going to for plans', bullets: ['I am going to visit…', 'Time expressions'] }, { title: 'Will for decisions', bullets: ['I will play…'] }] },
    highlights: [{ title: 'Warm start', text: 'Min 0:00–1:30: every student was greeted.' }, { title: 'Clear question', text: 'Min 1:20: an open question got two answers.' }],
    focus: { title: 'Teacher talk', text: 'One teacher turn of 4:19 (min 2–6).' }, action: { title: 'Pair work', text: 'Pairs answer before the whole class.' },
    areas: AN.AREAS.map((a, i) => ({ area: a, rating: i === 2 ? 'focus' : i % 3 ? 'developing' : 'strength', evidence: `REAL EVIDENCE ${i + 1}: min ${i}:00, 2 times.`, impact: 'Impact.', next: 'Next step.' })),
    planVsActual: [], form: { evidence: 'Teacher talk 85%.', worked: 'Warm start.', priority: 'Student talk time.', next: 'Pair work.' } }).value;
  const base = { kind: 'language', lang: 'en', subject: 'English B1', title: 'Making plans', recap: ai.recap };
  const teacher = AN.teacherData(ai, AN.teacherMetrics(m, 'en', 45), base);
  const stu = (ref, pid, hl) => { const s = AN.validateStudentsAi({ students: [{ ref, highlight: hl, level: 'B1', score: 76,
    tracker: [{ concept: 'Going to (plans)', difficulty: 'Easy', used: 2, mastery: 82 }], pron: [{ item: 'grandmother', score: 70, tip: 'Stress on GRAND.' }],
    didWell: [{ text: 'I am going to visit my grandmother', note: 'Correct going to.' }], improve: [], vocab: [{ word: 'grandmother', pos: 'noun', level: 'A1', def: 'Mother of a parent.', quote: 'visit my grandmother', example: 'My grandmother cooks.' }] }] }, [ref]).value.get(ref);
    return AN.studentData(s, AN.studentProgress(m, pid, s, null, 'language'), base, 'en'); };
  const now = new Date().toISOString();
  db.teacher_insights.push({ id: M.uid(), session_id: t.s1.id, data: teacher, is_demo: false, teacher_reflection: '', reflection_at: null, created_at: now });
  db.student_insights.push({ id: M.uid(), session_id: t.s1.id, enrollment_id: t.eAna.id, data: stu('S1', 'pA', 'REAL: Ana answered with a full going-to sentence.'), is_demo: false, teacher_message: '', published_message: '', published_at: null, created_at: now });
  db.student_insights.push({ id: M.uid(), session_id: t.s1.id, enrollment_id: t.eBruno.id, data: stu('S2', 'pB', 'REAL: Bruno used will for a decision.'), is_demo: false, teacher_message: '', published_message: '', published_at: null, created_at: now });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  let T;
  const finishOn = n => (body, k) => {
    if (k < n) { recording.status[T.s1.id] = { state: 'processing', recordings: 3, transcribed: Math.min(k, 3), has_insights: false, failed: false }; return { ...recording.status[T.s1.id], step: 'transcribing' }; }
    if (!db.teacher_insights.some(x => x.session_id === T.s1.id)) realRowsSync();
    recording.status[T.s1.id] = { state: 'ready', recordings: 3, transcribed: 3, has_insights: true, failed: false }; recording.processing = [];
    return recording.status[T.s1.id];
  };
  let realRowsSync = () => {};

  await run('Teacher (ES): a recorded class shows "Procesando tu clase…", polls the server, then its REAL insights render (no demo)', browser, async ({ page, st }) => {
    T = seed(); AN = AN || await import('../api/_lib/rec/analysis.js');
    realRowsSync = () => { realRows(T); };
    recording.processing = [{ id: T.s1.id, status: 'processing' }];
    recording.status[T.s1.id] = { state: 'processing', recordings: 3, transcribed: 0, has_insights: false, failed: false };
    await login(page, 'tc@tec.com', 'es');
    await page.click('#nav-insights');
    await page.waitForSelector('#panel-insights.active #ins-pending');
    // the class is not offered for demo generation: it is being processed
    const pend = await text(page, '#ins-pending');
    if (!/Procesando…/.test(pend)) throw new Error('pending item: ' + pend);
    if (await page.$(`#ins-pending [data-lc="ins-generate"][data-id="${T.s1.id}"]`)) throw new Error('demo generation offered for a recorded class');
    if (!calls.rpc.some(c => c.fn === 'rec_processing_sessions')) throw new Error('processing list not asked');
    st.process.length = 0;
    await page.click(`#ins-pending [data-lc="ins-open"][data-id="${T.s1.id}"]`);
    await page.waitForSelector('#ins-processing');
    const proc = await text(page, '#ins-processing');
    if (!/Procesando tu clase… \(puede tardar unos minutos\)/.test(proc)) throw new Error('processing text: ' + proc);
    if (!/Transcribimos las voces de quienes dieron su consentimiento/.test(proc)) throw new Error('processing sub: ' + proc);
    if (await page.$('.ins-detail .lc-banner') || await page.$('.ins-detail .lc-chip-demo')) throw new Error('demo banner while processing');
    if (await page.$('.ins-detail [data-lc="ins-generate"]')) throw new Error('generate button while processing');
    const u = await untranslated(page, '#panel-insights'); if (u.length) throw new Error('sin traducir: ' + JSON.stringify(u));
    await page.waitForFunction(() => /Grabaciones transcriptas:\s*[12] \/ 3/.test(document.getElementById('ins-proc-step')?.textContent || ''), null, { timeout: 5000 });
    await shot(page, 'processing-es');
    // … the server finishes on the 3rd call: the real report appears by itself
    await page.waitForSelector('.ins-detail .ins-obs-head', { timeout: 8000 });
    if (await page.$('#ins-processing')) throw new Error('processing card still shown');
    if (st.process.length < 3) throw new Error('polled only ' + st.process.length + ' times');
    if (!st.process.every(p => p.body.session === T.s1.id && /^Bearer .+/.test(p.auth))) throw new Error('process call: ' + JSON.stringify(st.process[0]));
    if (await page.$('.ins-detail .lc-banner') || await page.$('.ins-detail .lc-chip-demo')) throw new Error('real insights shown as demo');
    if (await page.$('.ins-detail [data-lc="ins-generate"]')) throw new Error('demo generation offered next to real insights');
    if (await page.locator('#ins-body .lc-area').count() !== 13) throw new Error('13 areas');
    const report = await text(page, '#ins-body');
    if (!/REAL EVIDENCE 3/.test(report) || !/Talk about future plans with going to/.test(report)) throw new Error('real report content');
    const metrics = await page.$$eval('#ins-body .lc-metrics .lc-metric', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    if (!/^Habla del docente89%/.test(metrics[0]) || !/^Estudiantes que hablaron2 \/ 2/.test(metrics[4])) throw new Error('metric labels: ' + JSON.stringify(metrics));
    if (!metrics.some(x => /89%/.test(x))) throw new Error('teacher talk computed from timestamps: ' + JSON.stringify(metrics));
    if (!/listos/.test(await text(page, '#toast'))) throw new Error('ready toast: ' + await text(page, '#toast'));
    await shot(page, 'real-report-es');
    // students: real per-student insights (only the recorded ones), progress from the timestamps
    await page.click('#ins-tab-students');
    await page.waitForSelector('#ins-body .lc-student-pick');
    const chips = await page.$$eval('#ins-body .lc-person-chip', b => b.map(x => x.textContent.trim()));
    if (chips.length !== 2 || !/Ana Alonso/.test(chips[0]) || !chips.some(c => c.includes('Bruno <img'))) throw new Error('students: ' + JSON.stringify(chips));
    if (!/REAL: Ana answered/.test(await text(page, '#ins-body'))) throw new Error('Ana real highlight');
    await page.click('#ins-sub-progress'); await page.waitForSelector('#ins-sub-progress.active');
    const prog = await text(page, '#ins-body');
    if (!/0\.5 min/.test(prog) || !/Going to \(plans\)/.test(prog)) throw new Error('progress: ' + prog.slice(0, 300));
    await page.click('#ins-sub-recap'); await page.waitForSelector('#ins-sub-recap.active');
    if (!/REAL RECAP/.test(await text(page, '#ins-body'))) throw new Error('recap');
    await page.click('[data-lc="ins-back"]');
    await page.waitForSelector('#ins-list');
    const item = await text(page, '#ins-list');
    if (!/Making plans/.test(item) || /Demo/.test(item)) throw new Error('list item (real, not demo): ' + item);
  }, { onProcess: (b, k) => finishOn(3)(b, k) });

  await run('Teacher (EN): a class that is still live says so, and the polling stops when going back', browser, async ({ page, st }) => {
    T = seed();
    recording.status[T.s1.id] = { state: 'live', recordings: 0, transcribed: 0, has_insights: false, failed: false };
    await login(page, 'tc@tec.com');
    await page.evaluate(id => window.TCInsightsPanel.openSession(id), T.s1.id);
    await page.waitForSelector('#ins-processing');
    if (!/Processing your class… \(it may take a few minutes\)/.test(await text(page, '#ins-processing'))) throw new Error('EN text');
    await page.waitForFunction(() => /still live/.test(document.getElementById('ins-proc-step')?.textContent || ''), null, { timeout: 5000 });
    await page.click('[data-lc="ins-back"]');
    const n = st.process.length; await page.waitForTimeout(1200);
    if (st.process.length > n) throw new Error('kept polling after leaving the class');
    if (n < 1) throw new Error('never asked the server');
    const o = await hscroll(page); if (o > 1) throw new Error('overflow ' + o);
  }, { onProcess: () => ({ state: 'live', recordings: 0, transcribed: 0, has_insights: false }) });

  await run('Student (ES): her REAL insight (no demo chip), only her own', browser, async ({ page }) => {
    T = seed(); await realRows(T);
    await login(page, 'ana@mail.com', 'es');
    await page.waitForSelector('.gs-ins-item');
    if (await page.locator('.gs-ins-item').count() !== 1) throw new Error('own insights only');
    await page.click('.gs-ins-item');
    await page.waitForSelector('#panel-insights.active .ins-detail');
    if (await page.$('.ins-detail .lc-chip-demo') || await page.$('.ins-detail .lc-banner')) throw new Error('real insight shown as demo');
    if (!/REAL: Ana answered/.test(await text(page, '#ins-body'))) throw new Error('highlight');
    if (/Bruno/.test(await text(page, '#ins-body'))) throw new Error('classmate visible');
    await page.click('#ins-sub-vocab'); await page.waitForSelector('#ins-sub-vocab.active');
    if (!/grandmother/.test(await text(page, '#ins-body'))) throw new Error('vocabulary');
    const o = await hscroll(page); if (o > 1) throw new Error('overflow ' + o);
    await shot(page, 'student-real-es');
  }, { viewport: { width: 390, height: 800 }, mobile: true });

  await run('Pipeline off: no recording RPCs, the demo flow is unchanged', browser, async ({ page, st }) => {
    T = seed();
    await login(page, 'tc@tec.com');
    await page.click('#nav-insights');
    await page.waitForSelector(`#ins-pending [data-lc="ins-generate"][data-id="${T.s1.id}"]`);
    await page.click(`#ins-pending [data-lc="ins-generate"][data-id="${T.s1.id}"]`);
    await page.waitForSelector('.ins-detail .ins-obs-head');
    if (!(await page.$('.ins-detail .lc-banner'))) throw new Error('demo banner');
    if (calls.rpc.some(c => /^rec_/.test(c.fn)) || st.process.length) throw new Error('recording calls with the pipeline off');
  }, { recording: false });

  T = null;
  await browser.close();
  console.log(failed ? `${failed} recording scenario(s) FAILED` : 'All recording scenarios passed');
  process.exitCode = failed ? 1 : 0;
})();
