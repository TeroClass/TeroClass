// End-to-end tests for the Live class (Aula en vivo) in DEMO mode, with a simulated Supabase.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-live.cjs
// Chromium runs with fake camera/microphone (no real devices, no real media server).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const M = require('./mock-supabase.cjs');
const { db, handleSupabase, RAW_HTML, SB_JS, SB } = M;

const PUB = path.join(__dirname, '..', 'public');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '→', e.message.split('\n')[0]); }
};
const SAVED = 'Reacciones químicas 3°B <script>\nObjetivos de hoy:\n- Balancear ecuaciones <b>bold</b>\nInicio: lluvia de ideas (10 min)\n- ¿Desaparece la materia? <img src=x onerror=window.__xss=1>\nActividad 1: conservación de la masa (15 minutos)\n- Bolsa cerrada\n- Registro de masas\nCierre (5\')\n- Ticket de salida';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--unsafely-treat-insecure-origin-as-secure=http://teroclass.test'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const net = { config: 0, livekitCdn: 0, token: 0 };
  await ctx.route('https://cdn.jsdelivr.net/**', r => {
    const u = r.request().url();
    if (u.includes('livekit-client')) { net.livekitCdn++; return r.abort(); }
    return u.includes('supabase-js') ? r.fulfill({ contentType: 'application/javascript', body: SB_JS }) : r.abort();
  });
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/class/config') { net.config++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false }) }); }
    if (u.pathname === '/api/class/token') { net.token++; return r.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ configured: false }) }); }
    if (u.pathname === '/live-class.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'live-class.js')) });
    if (u.pathname === '/live-class.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(PUB, 'live-class.css')) });
    if (u.pathname === '/csv-import.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'csv-import.js')) });
    if (u.pathname === '/groups-calendar.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'groups-calendar.js')) });
    if (u.pathname === '/groups-calendar.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(PUB, 'groups-calendar.css')) });
    if (u.pathname.startsWith('/api/')) return r.fulfill({ status: 404, body: '{}' });
    return r.fulfill({ contentType: 'text/html', body: RAW_HTML });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shot = n => page.screenshot({ path: `/tmp/claude-0/live-${n}.png` });
  const text = sel => page.textContent(sel);

  // ── sign up a teacher and give them a saved chemistry class ──
  await page.goto('http://teroclass.test/');
  await step('Registro de docente', async () => {
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.evaluate(() => setUiLang('en'));
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Ana Profe'); await page.fill('#reg-email', 'ana@school.uy'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    const me = db.profiles.find(p => p.email === 'ana@school.uy');
    db.plannings.push({ id: 'aaaaaaaa-1111-4000-8000-000000000001', owner_id: me.id, institution_id: null, title: 'Reacciones químicas 3°B <script>', created_at: new Date().toISOString(),
      data: { params: { subjects: ['Chemistry'], language: 'Spanish', duration: '30' }, content: SAVED, student: 'Hoja del alumno' } });
    await page.reload();
    await page.waitForSelector('#screen-app.active');
  });

  await step('Sidebar: "Live class" abre el panel con banner Demo y lista de sesiones', async () => {
    await page.click('#nav-live');
    await page.waitForSelector('#panel-live.active .lc-wrap');
    if (!(await page.isVisible('#nav-live'))) throw new Error('nav oculto');
    const h1 = await text('#lc-root h1'); if (!/Live class/.test(h1)) throw new Error(h1);
    const b = await text('#lc-root .lc-banner'); if (!/Demo data — real insights activate when the live classroom is connected/.test(b)) throw new Error('banner: ' + b);
    if ((await page.$$('.lc-session')).length !== 4) throw new Error('sesiones demo');
    const opts = await page.$$eval('#lc-plan-select option', os => os.map(o => o.textContent));
    if (!opts.some(o => o.includes('Reacciones químicas 3°B <script>'))) throw new Error('la clase guardada no aparece: ' + opts);
    await page.waitForFunction(() => true);
  });
  await shot('1-home');

  await step('Lobby: vista previa real de cámara/micrófono y selectores de dispositivo', async () => {
    await page.click('[data-lc="join-upcoming"][data-i="0"]');
    await page.waitForSelector('#lc-preview-video');
    await page.waitForFunction(() => { const v = document.getElementById('lc-preview-video'); return v && v.srcObject && v.srcObject.getVideoTracks().length && v.readyState >= 2; }, null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll('#lc-cam-select option').length >= 1 && document.querySelectorAll('#lc-mic-select option').length >= 1);
    const live = await page.evaluate(() => document.getElementById('lc-preview-video').srcObject.getTracks().map(t => t.kind + ':' + t.readyState).join(','));
    if (!/video:live/.test(live) || !/audio:live/.test(live)) throw new Error(live);
    if (net.config !== 0) { /* config is fetched only on join */ }
    await page.click('#lc-lobby-cam');
    if (await page.isVisible('#lc-preview-video')) { const vis = await page.$eval('#lc-preview-video', v => v.style.visibility); if (vis !== 'hidden') throw new Error('cámara no se apaga'); }
    if (await page.$eval('#lc-lobby-cam', b => b.getAttribute('aria-pressed')) !== 'false') throw new Error('aria-pressed');
    await page.click('#lc-lobby-cam');
  });

  await step('Consentimiento: IA/almacenamiento dependen de grabación; menor exige tutor', async () => {
    if (!(await page.isDisabled('#lc-c-ai'))) throw new Error('IA habilitado sin grabación');
    if (!/without being recorded/.test(await text('#lc-consent-summary'))) throw new Error('resumen inicial');
    await page.check('#lc-c-recording');
    if (await page.isDisabled('#lc-c-ai')) throw new Error('IA sigue deshabilitado');
    await page.check('#lc-c-ai'); await page.check('#lc-c-storage');
    if (!/You will be recorded/.test(await text('#lc-consent-summary'))) throw new Error('no avisa que graba');
    await page.check('#lc-minor');
    await page.waitForSelector('#lc-guardian', { state: 'visible' });
    if (!/Waiting for guardian consent/.test(await text('#lc-consent-summary'))) throw new Error('no pide tutor');
    await page.click('#lc-join');
    if (!/guardian's name/.test(await text('#lc-lobby-err'))) throw new Error('sin error de nombre del tutor');
    await page.fill('#lc-g-name', 'Laura <b>Pérez</b>');
    await page.fill('#lc-g-email', 'no-es-email');
    await page.click('#lc-join');
    if (!/valid guardian email/.test(await text('#lc-lobby-err'))) throw new Error('sin error de email');
    await page.fill('#lc-g-email', 'laura@example.com');
    await page.click('#lc-join');
    if (!/must confirm/.test(await text('#lc-lobby-err'))) throw new Error('sin error de confirmación');
    await page.check('#lc-g-consent');
    if (!/You will be recorded/.test(await text('#lc-consent-summary'))) throw new Error('con tutor debería grabar');
    await page.uncheck('#lc-c-recording');
    if (await page.isChecked('#lc-c-ai')) throw new Error('IA quedó marcado sin grabación');
    await page.check('#lc-c-recording'); await page.check('#lc-c-ai');
    await page.fill('#lc-name', '');
    await page.click('#lc-join');
    if (!/write your name/.test(await text('#lc-lobby-err'))) throw new Error('nombre vacío aceptado');
    await page.fill('#lc-name', 'Ana Profe');
  });
  await shot('2-lobby');

  await step('Entrar: sala con cámara local + participantes simulados y badges de consentimiento', async () => {
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    if (net.config < 1) throw new Error('no consultó /api/class/config');
    if (net.livekitCdn || net.token) throw new Error('cargó LiveKit sin estar configurado');
    const tiles = await page.$$('.lc-tile[data-pid]'); if (tiles.length < 6 || tiles.length > 9) throw new Error('tiles: ' + tiles.length);
    await page.waitForFunction(() => { const v = document.getElementById('lc-local-video'); return v && v.srcObject && v.srcObject.getVideoTracks()[0].readyState === 'live'; });
    const localBadge = await text('.lc-tile[data-pid="local"] .lc-tile-top'); if (!/Recorded/.test(localBadge) || !/Guardian/.test(localBadge)) throw new Error('badge local: ' + localBadge);
    if (!(await page.$('.lc-tile[data-pid^="sim-"] .lc-badge.off'))) throw new Error('falta participante "Not recorded"');
    if (!/Not recording/.test(await text('#lc-rec'))) throw new Error('REC inicial');
    if (!/Simulated participants/.test(await text('#lc-provider-chip'))) throw new Error('proveedor');
    if (await page.evaluate(() => LiveClass.state.room.kind) !== 'demo') throw new Error('no es demo');
    const tracks = await page.evaluate(() => LiveClass.state.room.stream.getTracks().length); if (tracks !== 2) throw new Error('tracks ' + tracks);
  });

  await step('Indicador de hablante simulado y medidor de habla docente/estudiantes', async () => {
    await page.waitForSelector('.lc-tile.speaking', { timeout: 8000 });
    await page.waitForFunction(() => { const t = parseInt(document.getElementById('lc-talk-t').textContent, 10), s = parseInt(document.getElementById('lc-talk-s').textContent, 10); return t + s === 100; }, null, { timeout: 12000 });
  });

  await step('Micrófono y cámara (pista real se apaga y el botón refleja el estado)', async () => {
    await page.click('#lc-ctl-mic');
    let st = await page.evaluate(() => ({ en: LiveClass.state.room.stream.getAudioTracks()[0].enabled, pressed: document.getElementById('lc-ctl-mic').getAttribute('aria-pressed'), lb: document.querySelector('#lc-ctl-mic .lc-ctl-lb').textContent, muted: document.querySelector('.lc-tile[data-pid="local"]').classList.contains('muted') }));
    if (st.en || st.pressed !== 'true' || st.lb !== 'Unmute' || !st.muted) throw new Error(JSON.stringify(st));
    await page.click('#lc-ctl-mic');
    await page.click('#lc-ctl-cam');
    st = await page.evaluate(() => ({ en: LiveClass.state.room.stream.getVideoTracks()[0].enabled, off: document.querySelector('.lc-tile[data-pid="local"]').classList.contains('cam-off') }));
    if (st.en || !st.off) throw new Error(JSON.stringify(st));
    await page.click('#lc-ctl-cam');
  });

  await step('Levantar la mano y bajar', async () => {
    await page.click('#lc-ctl-hand');
    await page.waitForSelector('.lc-tile[data-pid="local"].hand');
    if (await text('#lc-ctl-hand .lc-ctl-lb') !== 'Lower hand') throw new Error('etiqueta');
    await page.click('#lc-ctl-hand');
    await page.waitForSelector('.lc-tile[data-pid="local"]:not(.hand)');
  });

  await step('Chat local (escapado) y panel de personas', async () => {
    await page.click('#lc-ctl-chat');
    await page.waitForSelector('#lc-side-chat:not([hidden])');
    await page.fill('#lc-chat-input', 'Hola <b>clase</b> <img src=x onerror=window.__xss=1>');
    await page.press('#lc-chat-input', 'Enter');
    await page.waitForFunction(() => /Hola <b>clase<\/b>/.test(document.getElementById('lc-chat-list').innerText));
    if (await page.$('#lc-chat-list b:not([data-no-i18n]) , #lc-chat-list img')) { const bad = await page.$$eval('#lc-chat-list img', x => x.length); if (bad) throw new Error('HTML del chat sin escapar'); }
    await page.click('#lc-ctl-people');
    await page.waitForSelector('#lc-side-people:not([hidden]) .lc-person');
    const ppl = await text('#lc-people-list'); if (!/participants/.test(ppl) || !/Not recorded/.test(ppl)) throw new Error(ppl);
  });

  await step('Pantalla compartida (vista previa local) sin errores', async () => {
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.click('#lc-ctl-share');
    await page.waitForFunction(() => document.querySelector('.lc-share-tile') || /cancelled|not available/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    if (await page.$('.lc-share-tile')) {
      await page.waitForFunction(() => document.getElementById('lc-share-video').srcObject);
      if (!/You are presenting/.test(await text('.lc-share-tile'))) throw new Error('etiqueta de presentación');
      // chat stays usable as a side panel next to the shared screen
      await page.click('#lc-ctl-chat');
      await page.waitForSelector('#lc-side-chat:not([hidden])');
      const lay = await page.evaluate(() => { const st = document.querySelector('.lc-stage').getBoundingClientRect(), sd = document.getElementById('lc-side').getBoundingClientRect(), sh = document.querySelector('.lc-share-tile').getBoundingClientRect(); return { sideLeft: sd.left, stageRight: st.right, sideH: sd.height, shareW: sh.width, shareRight: sh.right }; });
      if (lay.sideLeft < lay.stageRight - 1 || lay.shareRight > lay.sideLeft + 1 || lay.sideH < 300 || lay.shareW < 300) throw new Error('chat no es panel lateral junto a la pantalla: ' + JSON.stringify(lay));
      await page.fill('#lc-chat-input', 'Mirad la diapositiva');
      await page.press('#lc-chat-input', 'Enter');
      await page.waitForFunction(() => /Mirad la diapositiva/.test(document.getElementById('lc-chat-list').innerText));
      if (!(await page.$('.lc-share-tile'))) throw new Error('el chat cortó la pantalla compartida');
      await page.click('#lc-ctl-share');
      await page.waitForFunction(() => !document.querySelector('.lc-share-tile'));
    } else console.log('   (getDisplayMedia no disponible en headless: se mostró el aviso)');
  });

  await step('REC: encender → contador; pausar congela; reanudar; detener', async () => {
    await page.click('#lc-ctl-rec');
    await page.waitForSelector('#lc-rec[data-state="on"]');
    if (!(await page.isVisible('#lc-ctl-pause'))) throw new Error('falta pausa');
    if (!/REC/.test(await text('#lc-rec .lc-rec-label'))) throw new Error('etiqueta REC');
    await page.waitForFunction(() => document.getElementById('lc-rec-time').textContent >= '00:02', null, { timeout: 5000 });
    await page.click('#lc-ctl-pause');
    await page.waitForSelector('#lc-rec[data-state="paused"]');
    const t1 = await text('#lc-rec-time'); await sleep(1600); const t2 = await text('#lc-rec-time');
    if (t1 !== t2) throw new Error('el contador sigue en pausa ' + t1 + ' ' + t2);
    if (await text('#lc-ctl-pause .lc-ctl-lb') !== 'Resume') throw new Error('etiqueta reanudar');
    await page.click('#lc-ctl-pause');
    await page.waitForSelector('#lc-rec[data-state="on"]');
    await page.click('#lc-ctl-rec');
    await page.waitForSelector('#lc-rec[data-state="off"]');
    if (await page.isVisible('#lc-ctl-pause')) throw new Error('pausa visible con REC apagado');
    await page.click('#lc-ctl-rec'); // keep recording for the processing summary
    await page.waitForSelector('#lc-rec[data-state="on"]');
  });

  await step('Plan de clase con temporizador por actividad', async () => {
    await page.click('#lc-ctl-plan');
    await page.waitForSelector('#lc-side-plan:not([hidden]) .lc-sec');
    const n = await page.$$eval('.lc-sec', x => x.length); if (n !== 5) throw new Error('secciones: ' + n);
    const t0 = await text('#lc-sec-time-0'); if (t0 !== '00:00 / 05:00') throw new Error(t0);
    await page.click('#lc-sec-btn-0');
    await page.waitForFunction(() => document.getElementById('lc-sec-time-0').textContent.startsWith('00:02'), null, { timeout: 5000 });
    if (!(await page.$('#lc-sec-0.running'))) throw new Error('no marca la actividad en curso');
    await page.click('#lc-sec-next');
    await page.waitForSelector('#lc-sec-1.running');
    await page.click('#lc-sec-btn-1');
    if (await page.$('.lc-sec.running')) throw new Error('no pausa');
    await page.click('[data-lc="sec-reset"][data-i="0"]');
    if (await text('#lc-sec-time-0') !== '00:00 / 05:00') throw new Error('no reinicia');
  });
  await shot('3-room');

  await step('Terminar clase: confirmación (Esc cancela) → procesamiento → insights', async () => {
    await page.click('#lc-ctl-end');
    await page.waitForSelector('#lc-end-modal:not([hidden])');
    if (await page.evaluate(() => document.activeElement.id) !== 'lc-end-cancel') throw new Error('foco no va al diálogo');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#lc-end-modal', { state: 'hidden' });
    await page.click('#lc-ctl-end');
    const streamRef = await page.evaluateHandle(() => LiveClass.state.room.stream);
    await page.click('#lc-end-confirm');
    await page.waitForSelector('.lc-processing');
    const ended = await streamRef.evaluate(s => s.getTracks().every(t => t.readyState === 'ended'));
    if (!ended) throw new Error('la cámara sigue encendida');
    if (!/participants consented/.test(await text('.lc-proc-summary'))) throw new Error('resumen de grabación');
    await page.waitForSelector('#lc-proc-0[data-state="done"]', { timeout: 4000 });
    await shot('4-processing');
    await page.waitForSelector('.lc-insights', { timeout: 8000 });
  });

  await step('Insights del estudiante: Overview · Recap · Progress · Feedback · Vocabulary', async () => {
    if (!/Making plans/.test(await text('.lc-insights .lc-sub'))) throw new Error('muestra equivocada');
    await page.click('#lc-draft-msg');
    const draft = await page.inputValue('#lc-teacher-msg'); if (!/^Hi Valentina!/.test(draft)) throw new Error('borrador: ' + draft);
    await page.click('#lc-sub-recap');
    if ((await page.$$('.lc-topic')).length !== 3) throw new Error('recap: 3 temas');
    if ((await page.$$('.lc-topic:first-child li')).length !== 3) throw new Error('3 viñetas');
    await page.click('#lc-sub-progress');
    if ((await page.$$('.lc-metric')).length !== 5) throw new Error('5 métricas');
    if (!/CEFR/.test(await text('.lc-sub-body'))) throw new Error('CEFR');
    if ((await page.$$('.lc-table tbody tr')).length < 3) throw new Error('tracker');
    if (!(await page.$('.lc-delta.up'))) throw new Error('deltas ▲');
    await page.click('#lc-sub-feedback');
    if ((await page.$$('.lc-pron-card')).length !== 3) throw new Error('pronunciación');
    if (!(await page.$('.lc-wrong')) || !(await page.$('.lc-right'))) throw new Error('original → corregido');
    await page.click('#lc-sub-vocab');
    if ((await page.$$('.lc-vocab-card')).length < 3) throw new Error('vocabulario');
    await page.click('.lc-person-chip[data-i="1"]');
    await page.click('#lc-sub-overview');
    if (!/Mateo/.test(await text('.lc-msgbox h3'))) throw new Error('no cambia de estudiante');
    const v = await page.inputValue('#lc-teacher-msg'); if (v) throw new Error('mensaje de otro estudiante');
  });
  await shot('5-student-insights');

  await step('Insights del docente: 13 áreas, plan vs realidad y reflexión editable', async () => {
    await page.click('#lc-ins-teacher');
    if ((await page.$$('.lc-area')).length !== 13) throw new Error('13 áreas');
    if ((await page.$$('.lc-hfa-card.hl')).length !== 2 || (await page.$$('.lc-hfa-card.fo')).length !== 1 || (await page.$$('.lc-hfa-card.ac')).length !== 1) throw new Error('highlight/focus/action');
    if ((await page.$$('.lc-table tbody tr')).length !== 5) throw new Error('plan vs realidad');
    for (const id of ['lc-f-evidence', 'lc-f-worked', 'lc-f-priority', 'lc-f-next', 'lc-f-reflection']) if (!(await page.$('#' + id))) throw new Error('falta ' + id);
    await page.fill('#lc-f-reflection', 'Voy a esperar más después de preguntar.');
    await page.click('#lc-save-reflection');
    await page.waitForFunction(() => /Reflection saved/.test(document.getElementById('toast').textContent));
    await page.click('#lc-ins-student'); await page.click('#lc-ins-teacher');
    if (await page.inputValue('#lc-f-reflection') !== 'Voy a esperar más después de preguntar.') throw new Error('se perdió la reflexión');
    await page.click('[data-lc="sample"][data-k="chemistry"]');
    if (!/Química/.test(await text('.lc-insights .lc-sub'))) throw new Error('muestra química');
    if (!/Corrección de concepciones erróneas/.test(await text('.lc-hfa'))) throw new Error('datos química');
  });
  await shot('6-teacher-insights');

  await step('Desde una clase guardada: "▶ Start live class" → lobby con su planificación', async () => {
    await page.click('#nav-home');
    await page.click('.class-card');
    await page.waitForSelector('#btn-live-class');
    await page.click('#btn-live-class');
    await page.waitForSelector('#panel-live.active .lc-lobby');
    if (!(await text('.lc-lobby .lc-sub')).includes('Reacciones químicas 3°B <script>')) throw new Error('título');
    if (await page.evaluate(() => LiveClass.state.sampleKey) !== 'chemistry') throw new Error('materia → muestra de química');
  });

  await step('Estudiante sin consentimiento: entra "no grabado"; REC del docente visible; plan parseado y escapado', async () => {
    await page.check('input[name="lc-role"][value="student"]');
    if (!/without being recorded/.test(await text('#lc-consent-summary'))) throw new Error('resumen');
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    if (await page.$('#lc-ctl-rec')) throw new Error('el estudiante ve el botón REC');
    if (!/Not recorded/.test(await text('.lc-tile[data-pid="local"] .lc-tile-top'))) throw new Error('badge no grabado');
    if (!/Leave/.test(await text('#lc-ctl-end'))) throw new Error('botón salir');
    await page.waitForSelector('#lc-rec[data-state="on"]', { timeout: 6000 });
    // the (simulated) teacher shares a slide: students see it as a large tile with a live video track
    await page.waitForSelector('.lc-share-tile.remote[data-pid="screen-sim-t"] video', { timeout: 8000 });
    await page.waitForFunction(() => { const v = document.querySelector('.lc-share-tile.remote video'); return v && v.srcObject && v.srcObject.getVideoTracks()[0]?.readyState === 'live'; });
    if (!/Prof\. Laura Méndez/.test(await text('.lc-share-tile.remote')) || !/is presenting/.test(await text('.lc-share-tile.remote'))) throw new Error('etiqueta pantalla remota');
    await page.waitForFunction(() => /is sharing their screen/.test(document.getElementById('toast').textContent), null, { timeout: 4000 }).catch(() => {});
    { const box = await page.$eval('.lc-share-tile.remote', e => e.getBoundingClientRect().width); const tile = await page.$eval('.lc-tile[data-pid="local"]', e => e.getBoundingClientRect().width); if (box <= tile) throw new Error('la pantalla compartida no es la vista grande'); }
    if (await page.isHidden('#lc-side-chat')) await page.click('#lc-ctl-chat'); // students start with the chat open
    await page.waitForSelector('#lc-side-chat:not([hidden])');
    if (!(await page.$('.lc-share-tile.remote'))) throw new Error('abrir el chat oculta la pantalla');
    await page.click('#lc-ctl-plan');
    const secs = await page.$$eval('.lc-sec-planned', x => x.map(e => e.textContent)); if (secs.join(',') !== '10 min,15 min,5 min') throw new Error('secciones: ' + secs);
    if (await page.$('.lc-plan-doc b, .lc-plan-doc img, .lc-plan-doc script')) throw new Error('plan sin escapar');
    if (await page.evaluate(() => window.__xss)) throw new Error('XSS');
    await page.click('#lc-ctl-end');
    await page.waitForSelector('.lc-insights', { timeout: 9000 });
    if (await page.$('#lc-ins-teacher')) throw new Error('el estudiante ve insights docentes');
    if (!/Reacciones químicas/.test(await text('.lc-recap, .lc-sub-body').catch(() => '')) && !/Valentina/.test(await text('.lc-student-pick'))) throw new Error('insights');
  });

  await step('Sin permiso de cámara/micrófono: aviso claro y se puede entrar igual', async () => {
    await page.click('[data-lc="back-home"]');
    await page.evaluate(() => { window.__gum = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    await page.click('#lc-start-btn');
    await page.waitForSelector('#lc-media-msg.show');
    if (!/blocked/.test(await text('#lc-media-msg'))) throw new Error(await text('#lc-media-msg'));
    if (!(await page.isVisible('#lc-preview-off'))) throw new Error('sin placeholder');
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    if (!(await page.isDisabled('#lc-ctl-mic')) || !(await page.isDisabled('#lc-ctl-cam'))) throw new Error('controles deberían estar deshabilitados');
    if (!(await page.$('.lc-tile[data-pid="local"].cam-off'))) throw new Error('tile local debería mostrar avatar');
    await page.click('#lc-ctl-end'); await page.click('#lc-end-confirm');
    await page.click('[data-lc="skip-processing"]');
    await page.waitForSelector('.lc-insights');
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__gum; });
  });

  await step('Accesibilidad: controles son botones/inputs enfocables; teclado activa REC', async () => {
    await page.click('[data-lc="back-home"]');
    await page.click('#lc-start-btn');
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    const bad = await page.$$eval('#lc-root [data-lc]', els => els.filter(e => !['BUTTON', 'INPUT', 'SELECT'].includes(e.tagName)).map(e => e.outerHTML.slice(0, 80)));
    if (bad.length) throw new Error('no enfocables: ' + bad.join(' | '));
    const noName = await page.$$eval('#lc-root button', els => els.filter(e => e.offsetParent && !(e.innerText.trim() || e.getAttribute('aria-label'))).map(e => e.id || e.className));
    if (noName.length) throw new Error('botones sin nombre: ' + noName);
    await page.focus('#lc-ctl-rec'); await page.keyboard.press('Enter');
    await page.waitForSelector('#lc-rec[data-state="on"]');
    await page.focus('#lc-ctl-rec'); await page.keyboard.press('Space');
    await page.waitForSelector('#lc-rec[data-state="off"]');
  });

  await step('Responsive a 768px: sin scroll horizontal en sala, inicio, lobby e insights', async () => {
    await page.setViewportSize({ width: 768, height: 900 });
    await sleep(200);
    const over = () => page.evaluate(() => { const r = document.getElementById('lc-root'); const p = document.documentElement; return Math.max(r.scrollWidth - r.clientWidth, p.scrollWidth - p.clientWidth); });
    let o = await over(); if (o > 1) throw new Error('sala desborda ' + o);
    const ctlVisible = await page.$eval('#lc-ctl-end', e => { const b = e.getBoundingClientRect(); return b.right <= window.innerWidth && b.bottom <= window.innerHeight; });
    if (!ctlVisible) throw new Error('botón Terminar fuera de pantalla');
    await page.click('#lc-ctl-plan');
    const side = await page.$eval('#lc-side', e => e.getBoundingClientRect().width); if (side > 768) throw new Error('panel lateral muy ancho');
    await shot('7-room-768');
    await page.click('#lc-ctl-end'); await page.click('#lc-end-confirm'); await page.click('[data-lc="skip-processing"]');
    await page.waitForSelector('.lc-insights');
    o = await over(); if (o > 1) throw new Error('insights desborda ' + o);
    await page.click('#lc-ins-teacher'); o = await over(); if (o > 1) throw new Error('insights docente desborda ' + o);
    await page.click('[data-lc="back-home"]'); o = await over(); if (o > 1) throw new Error('inicio desborda ' + o);
    await page.click('#lc-start-btn'); await page.waitForSelector('.lc-lobby'); o = await over(); if (o > 1) throw new Error('lobby desborda ' + o);
    await shot('8-lobby-768');
    await page.click('[data-lc="back-home"]');
    await page.setViewportSize({ width: 1366, height: 860 });
  });

  await step('Interfaz en español: sidebar, inicio, lobby, sala, procesamiento e insights traducidos', async () => {
    await page.click('.topbar-right .lang-toggle button[data-lang="es"]');
    const untranslated = () => page.evaluate(() => {
      const vals = new Set(Object.values(I18N_ES)); const out = [];
      const w = document.createTreeWalker(document.getElementById('lc-root'), NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) {
        const t = n.nodeValue.trim(); const p = n.parentElement;
        if (!t || p.closest('[data-no-i18n],.cls-doc,textarea,option')) continue;
        if (/^[\p{N}\p{P}\p{S}\p{M}\p{Cf}\s]*$/u.test(t)) continue; // numbers, punctuation, emoji
        if (vals.has(t)) continue;
        out.push(t);
      }
      return [...new Set(out)];
    });
    const check = async where => { const u = await untranslated(); if (u.length) throw new Error(`${where} sin traducir: ${JSON.stringify(u)}`); };
    const tip = await text('#nav-live .sib-tooltip'); if (tip !== 'Aula en vivo') throw new Error('tooltip: ' + tip);
    await page.click('#nav-live');
    if (!/Aula en vivo/.test(await text('#lc-root h1'))) throw new Error('h1');
    if (!/Datos de demostración/.test(await text('.lc-banner'))) throw new Error('banner');
    await check('inicio');
    await page.click('[data-lc="join-upcoming"][data-i="1"]');
    await page.waitForSelector('.lc-lobby');
    if (!/Entrar a la clase/.test(await text('#lc-join'))) throw new Error('botón entrar');
    await page.check('#lc-c-recording'); await page.check('#lc-minor');
    await check('lobby');
    await page.click('#lc-join');
    await page.waitForFunction(() => /tutor/.test(document.getElementById('lc-lobby-err').textContent));
    await page.uncheck('#lc-minor');
    await page.click('#lc-join');
    await page.waitForSelector('#lc-room');
    { const ml = await text('#lc-ctl-mic .lc-ctl-lb'); if (ml !== 'Silenciar') throw new Error('control mic: ' + ml); }
    await page.click('#lc-ctl-rec');
    await page.waitForFunction(() => document.querySelector('#lc-ctl-rec .lc-ctl-lb').textContent === 'Detener grabación');
    await page.click('#lc-ctl-plan'); await check('sala (plan)');
    await page.click('#lc-ctl-people'); await check('sala (personas)');
    await page.click('#lc-ctl-chat'); await check('sala (chat)');
    await shot('9-room-es');
    await page.click('#lc-ctl-end'); await page.waitForSelector('#lc-end-modal:not([hidden])'); await check('diálogo');
    await page.click('#lc-end-confirm');
    await page.waitForSelector('.lc-processing'); await check('procesamiento');
    await page.waitForSelector('.lc-insights', { timeout: 8000 });
    for (const sub of ['overview', 'recap', 'progress', 'feedback', 'vocab']) { await page.click('#lc-sub-' + sub); await check('insights ' + sub); }
    if (!/Seguimiento de conceptos/.test(await (async () => { await page.click('#lc-sub-progress'); return text('.lc-sub-body'); })())) throw new Error('etiquetas de disciplina');
    await page.click('#lc-ins-teacher'); await check('insights docente');
    if (!/Observación de clase · 13 áreas/.test(await text('.lc-ins-body'))) throw new Error('13 áreas ES');
    await shot('10-insights-es');
    await page.click('.topbar-right .lang-toggle button[data-lang="en"]');
  });

  await step('Con LiveKit configurado: carga el SDK, pide token con la sesión y, si no conecta, vuelve a la demo', async () => {
    // Uses the real livekit-client UMD when LK_UMD points to it (e.g. from `npm pack livekit-client@2.22.3`),
    // otherwise a tiny stub with the same surface. No real LiveKit server is contacted.
    const umd = process.env.LK_UMD && fs.existsSync(process.env.LK_UMD) ? fs.readFileSync(process.env.LK_UMD, 'utf8')
      : 'window.LivekitClient={RoomEvent:{},Track:{Source:{}},Room:class{on(){return this}async connect(){throw new Error("no server")}async disconnect(){}}};';
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const seen = { cdn: '', token: null };
    await c2.route('https://cdn.jsdelivr.net/**', r => {
      const u = r.request().url();
      if (u.includes('livekit-client')) { seen.cdn = u; return r.fulfill({ contentType: 'application/javascript', body: umd }); }
      return r.fulfill({ contentType: 'application/javascript', body: SB_JS });
    });
    await c2.route(SB + '/**', handleSupabase);
    await c2.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
    await c2.route('http://teroclass.test/**', async r => {
      const u = new URL(r.request().url());
      if (u.pathname === '/api/class/config') return r.fulfill({ contentType: 'application/json', body: '{"configured":true}' });
      if (u.pathname === '/api/class/token') { seen.token = { auth: r.request().headers().authorization, body: JSON.parse(r.request().postData()) }; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true, url: 'ws://127.0.0.1:9', token: 'a.b.c', identity: 'x', room: seen.token.body.room, recorded: false }) }); }
      if (u.pathname === '/live-class.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'live-class.js')) });
      if (u.pathname === '/live-class.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(PUB, 'live-class.css')) });
      if (u.pathname === '/csv-import.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'csv-import.js')) });
      if (u.pathname === '/groups-calendar.js') return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(PUB, 'groups-calendar.js')) });
      if (u.pathname === '/groups-calendar.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(PUB, 'groups-calendar.css')) });
      return r.fulfill({ contentType: 'text/html', body: RAW_HTML });
    });
    const p2 = await c2.newPage();
    const errs2 = [];
    p2.on('pageerror', e => errs2.push(e.message));
    await p2.goto('http://teroclass.test/');
    await p2.waitForSelector('#tab-login', { state: 'visible' });
    await p2.evaluate(() => setUiLang('en'));
    await p2.fill('#login-email', 'ana@school.uy'); await p2.fill('#login-password', 'secreto123');
    await p2.click('#tab-login .auth-btn');
    await p2.waitForSelector('#screen-app.active');
    await p2.click('#nav-live');
    await p2.click('#lc-start-btn');
    await p2.waitForSelector('.lc-lobby');
    await p2.check('#lc-c-recording');
    await p2.click('#lc-join');
    await p2.waitForSelector('#lc-room', { timeout: 30000 });
    if (!seen.cdn.includes('livekit-client@2.22.3/dist/livekit-client.umd.js')) throw new Error('CDN: ' + seen.cdn);
    if (!seen.token || !/^Bearer tok-/.test(seen.token.auth || '')) throw new Error('token sin sesión');
    const b = seen.token.body;
    if (b.role !== 'teacher' || b.consent.recording !== true || !/^[a-z0-9]{12}-[A-Za-z0-9]+$/.test(b.room)) throw new Error('cuerpo del token: ' + JSON.stringify(b));
    if (await p2.evaluate(() => LiveClass.state.room.kind) !== 'demo') throw new Error('no volvió a la demo');
    if (errs2.length) throw new Error(errs2.join(' | '));
    console.log('   (SDK: ' + (process.env.LK_UMD ? 'livekit-client real' : 'stub') + ')');
    await c2.close();
  });

  await step('LiveKit: pantallas compartidas por otros → evento "screens" y attachScreen (sala simulada)', async () => {
    const r = await page.evaluate(() => {
      const attached = [];
      const pub = (track, muted = false) => ({ track, isMuted: muted });
      const part = (identity, name, pubs) => ({ identity, name, metadata: '{"role":"student"}', getTrackPublication: src => pubs[src] || null });
      const P = new LiveClass.providers.LiveKitProvider();
      P.LK = { Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } } };
      const screenTrack = { attach: el => attached.push(el.id) };
      P.room = { localParticipant: part('me', 'Me', {}), remoteParticipants: new Map([
        ['u2', part('u2', 'Ana <b>Prof</b>', { screen_share: pub(screenTrack) })],
        ['u3', part('u3', 'Beto', { screen_share: pub({ attach() {} }, true) })],
        ['u4', part('u4', 'Caro', { camera: pub({ attach() {} }) })]]) };
      const seen = []; P.on('screens', l => seen.push(l));
      P._sync();
      const el = document.createElement('video'); el.id = 'v-u2';
      return { screens: seen[0], ok: P.attachScreen('u2', el), none: P.attachScreen('u4', document.createElement('video')), attached };
    });
    if (JSON.stringify(r.screens) !== JSON.stringify([{ id: 'u2', name: 'Ana <b>Prof</b>' }])) throw new Error('screens: ' + JSON.stringify(r.screens));
    if (!r.ok || r.none || r.attached.join() !== 'v-u2') throw new Error(JSON.stringify(r));
  });

  const real = errors.filter(e => !/favicon|ERR_FAILED|Failed to load resource/.test(e));
  await step('Sin errores de consola', async () => { if (real.length) throw new Error(real.join('\n')); });
  console.log(failed ? `${failed} live-class scenario(s) FAILED` : 'All live-class scenarios passed');
  process.exitCode = failed ? 1 : 0;
  await browser.close();
})();
