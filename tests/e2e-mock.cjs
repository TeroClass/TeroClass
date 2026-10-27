// Prueba de punta a punta con un Supabase simulado (no toca datos reales).
// Uso: NODE_PATH=/opt/npm-tools/node_modules node tests/e2e-mock.cjs
const { chromium } = require('playwright');

const { db, calls, handleSupabase, HTML, SB_JS, SB } = require('./mock-supabase.cjs');

// Admins have "Admin mode" | "Teacher mode": a sidebar button of the other mode is hidden, so switch first.
const TEACHER_NAV = ['#nav-home', '#nav-ai'];
async function nav(page, sel) {
  if (!(await page.isVisible(sel)) && (await page.isVisible('#mode-switch'))) await page.click(`#mode-switch [data-mode="${TEACHER_NAV.includes(sel) ? 'teacher' : 'admin'}"]`);
  await page.click(sel);
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const errors = [];
  let aiCall = null; let studentCalls = 0; let verifierCalls = 0;
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: SB_JS }));
  await ctx.route(SB + '/**', handleSupabase);
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await ctx.route('http://teroclass.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/generate') {
      const b = JSON.parse(r.request().postData());
      if (JSON.stringify(b).includes('STUDENT HANDOUT')) { studentCalls++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Chemical reactions\nToday\'s goals:\n- You will be able to balance equations\nCard 1: H2 + O2 → ________\nAnswer: 2H2 + O2 → 2H2O\nAnswer key\n1. 2, 1, 2' } }] }) }); }
      if (JSON.stringify(b).includes("institution's CORE")) { return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '- Pedagogical principles: learning by doing, always end with reflection' } }] }) }); }
      if (JSON.stringify(b).includes('exam reviewer')) { verifierCalls++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'NO_CHANGES' }, finish_reason: 'stop' }] }) }); }
      aiCall = { auth: r.request().headers()['authorization'], body: b };
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Week 1 - Class 1 - Test - Small talk\nAttendance:\n\nToday\'s Objectives:\n- Practice greetings <img src=x onerror=window.__xss=1>\n- Ask questions' } }] }) });
    }
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept()); // beforeunload (L13) never blocks reloads in the test
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, '→', e.message.split('\n')[0]); process.exitCode = 1; } };
  const shot = async n => page.screenshot({ path: `/tmp/claude-0/shot-${n}.png` });

  await page.goto('http://teroclass.test/');
  await step('Pantalla de login visible', async () => { await page.waitForSelector('#tab-login', { state: 'visible' }); });

  await step('Registro súper admin', async () => {
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Owner Test'); await page.fill('#reg-email', 'owner@teroclass.test'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await page.waitForSelector('#panel-superadmin.active');
    if (!(await page.isVisible('#nav-superadmin'))) throw new Error('nav superadmin oculto');
  });
  await shot(1);

  await step('Crear institución', async () => {
    await page.evaluate(() => showCreateInstitution());
    await page.fill('#new-inst-name', 'The English Coach'); await page.fill('#new-inst-slug', 'tec'); await page.fill('#new-inst-admin', 'dire@tec.com');
    await page.click('#modal-create-inst .btn-modal-save');
    await page.waitForSelector('.inst-card');
    const t = await page.textContent('.inst-name'); if (t !== 'The English Coach') throw new Error(t);
  });
  await shot(2);

  await step('Ver institución → dashboard + AI settings', async () => {
    await page.click('.btn-inst-action.primary');
    await page.waitForSelector('#panel-admin.active');
    await nav(page, '#nav-master');
    await page.fill('#mp-prompt', 'Always use CEFR levels.');
    await page.click('#panel-master .btn-save-settings');
    await page.waitForTimeout(300);
    if (db.institutions[0].master_prompt !== 'Always use CEFR levels.') throw new Error('master prompt no guardado');
    const badge = await page.textContent('#master-inst-badge'); if (!badge.includes('The English Coach')) throw new Error('AI Settings sin institución: ' + badge);
    const dash = await page.evaluate(() => { showPanel('admin'); return new Promise(r => setTimeout(() => r(document.getElementById('admin-inst-badge').textContent), 300)); });
    if (!dash.includes('The English Coach')) throw new Error('Dashboard sin institución: ' + dash);
    await nav(page, '#nav-master');
  });

  await step('Subir playbook de la institución', async () => {
    await page.setInputFiles('#playbook-upload', { name: 'playbook.txt', mimeType: 'text/plain', buffer: Buffer.from('Our school believes in learning by doing. Every class ends with a reflection moment. '.repeat(5)) });
    await page.waitForFunction(() => /Read by the AI/.test(document.getElementById('playbook-list')?.innerText || ''));
    if (!db.institution_documents[0]?.summary?.includes('learning by doing')) throw new Error('resumen no guardado');
  });

  await step('Procesar playbook pendiente (usa get_document_content)', async () => {
    db.institution_documents.push({ id: 'doc-pending', institution_id: db.institutions[0].id, name: 'values.txt', content: 'We value curiosity and kindness. '.repeat(5), chars: 165, summary: null, created_at: new Date().toISOString() });
    await page.evaluate(() => showPanel('master'));
    await page.waitForSelector('[data-action="pb-process"]');
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.click('[data-action="pb-process"]');
    await page.waitForFunction(() => /Playbook ready|Error/.test(document.getElementById('toast').textContent));
    if (!calls.rpc.some(c => c.fn === 'get_document_content' && c.body.p_id === 'doc-pending')) throw new Error('no usó get_document_content');
    if (!db.institution_documents.find(d => d.id === 'doc-pending').summary) throw new Error('resumen no guardado');
    const t = await page.textContent('#toast'); if (!/Playbook ready/.test(t)) throw new Error('sin aviso de éxito: ' + t);
  });

  await step('Marca: editar institución, registro por link (Panel) y badge "Editing"', async () => {
    // TC-02 / P-13: "Join by link" is in the Dashboard, explained, and turning it on asks for confirmation
    await nav(page, '#nav-admin');
    await page.waitForSelector('#access-card', { state: 'visible' });
    if (await page.isChecked('#access-open-reg') !== (db.institutions[0].open_registration === true)) throw new Error('estado del registro por link');
    if (await page.isChecked('#access-open-reg')) { await page.uncheck('#access-open-reg'); await page.waitForFunction(() => /Join by link is off/.test(document.getElementById('toast').textContent)); }
    if (db.institutions[0].open_registration !== false) throw new Error('open_registration no guardado');
    await page.check('#access-open-reg');
    await page.waitForSelector('#modal-danger.active');
    await page.click('#dg-ok');
    await page.waitForFunction(() => /Join by link is on/.test(document.getElementById('toast').textContent));
    if (db.institutions[0].open_registration !== true) throw new Error('open_registration no se volvió a abrir');
    await nav(page, '#nav-branding');
    await page.waitForSelector('#panel-branding.active');
    const badge = await page.textContent('#branding-ctx-badge'); if (!badge.includes('The English Coach')) throw new Error('sin badge: ' + badge);
    if (await page.inputValue('#wl-name') !== 'The English Coach') throw new Error('no cargó la institución');
    await page.evaluate(() => saveBranding());
    await page.waitForFunction(() => /Branding saved/.test(document.getElementById('toast').textContent));
    if (!(await page.isVisible('#panel-branding'))) throw new Error('saving branding left the screen'); // the switcher keeps the institution
    if (db.institutions[0].open_registration !== true) throw new Error('saving branding must not touch the join-by-link setting');
    const invs = db.invitations.filter(i => i.email === 'dire@tec.com').length; if (invs !== 1) throw new Error('invitación de admin duplicada: ' + invs);
  });

  await step('Invitar docente', async () => {
    await page.click('.btn-invite');
    await page.fill('#invite-email', 'owner@teroclass.test');
    await page.click('#modal-invite .btn-modal-save');
    await page.waitForFunction(() => /That email can't be invited\./.test(document.getElementById('toast').textContent));
    await page.fill('#invite-email', 'profe@tec.com');
    await page.click('#modal-invite .btn-modal-save');
    // P-03: no e-mail provider → the app does not promise an e-mail; it shows the link to share (copy / WhatsApp)
    await page.waitForSelector('#invite-result', { state: 'visible' });
    const sub = await page.textContent('#invite-res-sub'); if (!/No email is sent/.test(sub)) throw new Error('promete un email: ' + sub);
    const link = await page.inputValue('#invite-res-link'); if (!link.endsWith('/org/tec?invite=profe%40tec.com')) throw new Error('link: ' + link);
    if (!/wa\.me\/\?text=/.test(await page.getAttribute('#invite-wa', 'href'))) throw new Error('sin WhatsApp');
    await page.click('#invite-result .btn-modal-save');
    if (!db.invitations.find(i => i.email === 'profe@tec.com')) throw new Error('sin invitación');
  });

  await step('Generar y guardar clase', async () => {
    await nav(page, '#nav-ai');
    await page.fill('#subjects-input', 'Chemistry'); await page.press('#subjects-input', 'Enter');
    await page.selectOption('#st-language', 'Spanish'); await page.selectOption('#st-age', '15 years old');
    await page.fill('#prompt-input', 'Chemical reactions');
    await page.click('#btn-generate');
    await page.waitForSelector('#lp-doc');
    if (!aiCall?.auth?.startsWith('Bearer tok-')) throw new Error('la IA no recibió la sesión');
    if (process.env.SHOW_PROMPT) console.log(aiCall.body.messages[1].content);
    if (!aiCall.body.messages[1].content.includes('PEDAGOGICAL APPROACH')) throw new Error('las barras no llegan al prompt');
    if (!aiCall.body.messages[1].content.includes('ACCURACY RULES')) throw new Error('faltan reglas de exactitud para química');
    await page.waitForFunction(() => true); if (verifierCalls < 1) throw new Error('no se verificaron los cálculos');
    if (!aiCall.body.messages[1].content.includes('NOT a language class')) throw new Error('no respeta la disciplina');
    if (!aiCall.body.messages[1].content.includes('GOLDEN RULE')) throw new Error('falta materiales listos');
    const up = aiCall.body.messages[1].content;
    if (!up.includes('100% of the document in Spanish') || !up.includes('Objetivos de hoy')) throw new Error('no fuerza el idioma');
    if (/Semana X - Clase X|Asistencia:/.test(up)) throw new Error('P-19: el encabezado "Semana X - Clase X" / "Asistencia:" vacío sigue en el pedido');
    if (!up.includes("STUDENTS' AGE: 15 years old")) throw new Error('no usa la edad');
    if (JSON.stringify(aiCall.body).includes('apiKey')) throw new Error('se envía apiKey desde el navegador');
    await page.waitForFunction(() => document.getElementById('lp-doc-student')?.innerText.includes('You will be able'));
    if (studentCalls !== 1) throw new Error('no se pidió el material del alumno');
    await page.click('#tab-student');
    if (!(await page.isVisible('#lp-doc-student')) || await page.isVisible('#lp-doc')) throw new Error('pestañas no cambian');
    await page.click('#tab-teacher');
    await page.click('#btn-save');
    await page.waitForTimeout(400);
    if (!db.plannings[0]?.data?.student?.includes('You will be able')) throw new Error('no se guardó el material del alumno');
    const st = db.plannings[0].data.student; if (/2H2 \+ O2 → 2H2O|Answer key|2, 1, 2/.test(st)) throw new Error('se filtraron respuestas al alumno: ' + st);
    if (!aiCall.body.messages[0].content.includes('learning by doing')) throw new Error('el playbook no llega a la IA');
    if (db.plannings.length !== 1 || !db.plannings[0].data.content.includes('greetings')) throw new Error('clase no guardada con contenido');
    if (await page.evaluate(() => window.__xss)) throw new Error('HTML del modelo se ejecutó');
  });
  await shot(3);

  await step('Recargar: sesión y clases persisten', async () => {
    await page.reload();
    await page.waitForSelector('#screen-app.active');
    await nav(page, '#nav-home');
    await page.waitForSelector('.class-card');
  });

  await step('Abrir clase guardada, editarla y guardar cambios (sin duplicar)', async () => {
    await page.click('.class-card');
    await page.waitForSelector('#lp-doc');
    const txt = await page.textContent('#lp-doc'); if (!txt.includes('greetings')) throw new Error('contenido no cargado');
    await page.evaluate(() => { document.getElementById('lp-doc').insertAdjacentHTML('beforeend', '<div class="cls-line">Extra note</div>'); });
    await page.click('#btn-save');
    await page.waitForTimeout(400);
    if (studentCalls !== 1) throw new Error('regeneró el material del alumno al abrir');
    if (db.plannings.length !== 1) throw new Error('se duplicó: ' + db.plannings.length);
    if (!db.plannings[0].data.content.includes('Extra note')) throw new Error('no se guardó la edición');
  });

  await step('Cambiar la interfaz a español sin tocar la clase', async () => {
    await page.click('.topbar-right .lang-toggle button[data-lang="es"]');
    await nav(page, '#nav-ai');
    await shot(5);
    const gen = await page.textContent('#btn-generate'); if (!/Generar/.test(gen)) throw new Error('botón no traducido: ' + gen);
    const tab = await page.textContent('#tab-student'); if (!/Material del alumno/.test(tab)) throw new Error('pestaña no traducida');
    const doc = await page.textContent('#lp-doc'); if (/Objetivos de hoy/.test(doc) && !/Objectives/.test(doc)) throw new Error('tradujo la clase');
    if (!/Objectives/.test(doc)) throw new Error('la clase cambió');
    const val = await page.$eval('#st-level', e => e.value); if (val !== 'Intermediate') throw new Error('cambió el valor enviado: ' + val);
    await nav(page, '#nav-home');
    await page.waitForFunction(() => /Tus clases/.test(document.body.innerText));
    await page.click('.topbar-right .lang-toggle button[data-lang="en"]');
    await page.waitForFunction(() => /Your Classes/.test(document.body.innerText));
  });

  await step('Salir y entrar de nuevo', async () => {
    await page.evaluate(() => handleLogout());
    await page.waitForSelector('#tab-login', { state: 'visible' });
    await page.fill('#login-email', 'owner@teroclass.test'); await page.fill('#login-password', 'secreto123');
    await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#screen-app.active');
  });

  await step('Menú de usuario con nombre, email, rol y salir', async () => {
    await page.click('#user-avatar');
    await page.waitForSelector('#user-menu.open');
    const t = await page.textContent('#user-menu'); if (!t.includes('owner@teroclass.test') || !/Platform owner/.test(t)) throw new Error(t);
    await page.click('body', { position: { x: 400, y: 400 } });
    if (await page.isVisible('#user-menu')) throw new Error('el menú no se cierra');
  });

  await step('Docente invitado se registra desde /org/tec con la marca', async () => {
    await page.evaluate(() => handleLogout());
    await page.goto('http://teroclass.test/org/tec');
    await page.waitForFunction(() => document.getElementById('auth-org-name')?.textContent === 'The English Coach');
    await page.click('.auth-tab:nth-child(2)');
    await page.fill('#reg-name', 'Profe Test'); await page.fill('#reg-email', 'profe@tec.com'); await page.fill('#reg-password', 'secreto123');
    await page.click('#tab-register .auth-btn');
    await page.waitForSelector('#screen-app.active');
    const brand = await page.textContent('#topbar-brand-name'); if (brand !== 'The English Coach') throw new Error('marca: ' + brand);
    if (await page.isVisible('#nav-admin')) throw new Error('docente ve dashboard');
    if (await page.isVisible('#btn-invite-top')) throw new Error('docente ve Invitar');
    await nav(page, '#nav-home');
    if (await page.$('.class-card')) throw new Error('docente ve clases ajenas');
  });
  await shot(4);

  await step('Admin: cambiar rol y quitar docente (RPC, doble clic sin confirm())', async () => {
    await page.evaluate(() => handleLogout());
    await page.goto('http://teroclass.test/');
    await page.fill('#login-email', 'owner@teroclass.test'); await page.fill('#login-password', 'secreto123');
    await page.click('#tab-login .auth-btn');
    await page.waitForSelector('#screen-app.active');
    await nav(page, '#nav-superadmin'); await page.click('.btn-inst-action.primary');
    await page.waitForSelector('#members-card select.member-role');
    const profe = db.profiles.find(p => p.email === 'profe@tec.com');
    await page.selectOption(`select[data-id="${profe.id}"]`, 'org_admin');
    // P-31: a role change asks first; "Cancel" puts the select back
    await page.waitForSelector('#modal-danger.active'); await page.click('#dg-cancel');
    if (profe.role === 'org_admin' || (await page.inputValue(`select[data-id="${profe.id}"]`)) !== 'teacher') throw new Error('cambió el rol sin confirmar');
    await page.selectOption(`select[data-id="${profe.id}"]`, 'org_admin');
    await page.waitForSelector('#modal-danger.active'); await page.click('#dg-ok');
    await page.waitForFunction(() => /Role updated/.test(document.getElementById('toast').textContent));
    if (profe.role !== 'org_admin') throw new Error('rol no cambiado');
    await page.click(`button.member-remove[data-id="${profe.id}"]`);
    if (profe.institution_id === null) throw new Error('quitó sin confirmar');
    await page.click(`button.member-remove[data-id="${profe.id}"]`);
    await page.waitForFunction(() => /Removed/.test(document.getElementById('toast').textContent));
    if (profe.institution_id !== null) throw new Error('no se quitó');
    if (!calls.rpc.some(c => c.fn === 'remove_member')) throw new Error('no llamó remove_member');
  });

  const real = errors.filter(e => !/favicon|ERR_FAILED|Failed to load resource/.test(e));
  console.log(real.length ? 'Errores en consola:\n' + real.join('\n') : 'Sin errores de consola');
  if (real.length) process.exitCode = 1;
  await browser.close();
})();
