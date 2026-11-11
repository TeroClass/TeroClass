/* TeroClass · Insights panels (no build, vanilla JS)
 * ------------------------------------------------------------------------------------------
 * "Insights" = the class insights each role can see (the platform analytics screen is "Metrics"):
 *   · Teaching → Insights (teacher / substitute): their classes with insights. A class opens the teacher
 *     observation report (+ their reflection) and each student's insights (+ the message to that student:
 *     draft with the assistant, save, publish).
 *   · Institution → Insights (admins): every class of the unit chosen in the top switcher and below it
 *     (super admin: "All institutions" or a unit). Read-only.
 *   · Students: "My insights" (their own, newest first; the teacher's message only once published).
 * Filters: group, teacher (admins), date range, student search. "Generate demo insights" on recent classes.
 * Data only through security-definer RPCs (001_base.sql): list_insight_sessions, get_session_insights,
 * save_teacher_reflection, save_insight_message, generate_demo_insights, my_insights, my_insight.
 * View as (super admin): read-only, same screens for the viewed teacher / admin / student.
 * REAL insights (recording pipeline on: APP_CONFIG.recording): a class whose recording is being processed shows "Processing
 * your class…" (rec_processing_sessions / rec_session_status) and, while it is open, asks the server to advance it
 * (POST /api/class/process) every ~20 s until its real insights (is_demo = false) are stored, then shows them.
 * Renderers: public/insights-view.js (window.TCInsightsView). Depends on index.html globals: sb, currentUser,
 * currentOrgId, viewAs, vaBlocked, showPanel, showToast, esc, trText, uiLocale, dbErr, I18N_ES.
 */
(function () {
  'use strict';
  const V = window.TCInsightsView;
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const E = s => (typeof esc === 'function' ? esc(s) : String(s ?? ''));
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t); };
  const errMsg = e => { const m = (e && e.message) || String(e || ''); return typeof dbErr === 'function' ? dbErr(m) : m; };
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;
  const blocked = () => (typeof vaBlocked === 'function' ? vaBlocked() : false);
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const fmt = (d, o) => { try { return new Date(d).toLocaleString(loc(), o && o.hour ? { hourCycle: 'h23', ...o } : o); } catch (e) { return ''; } }; // P-30: 24 h
  const fDay = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fTime = d => fmt(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // P-30: 24 h like the calendar
  async function rpc(fn, args) {
    try { const { data, error } = await sb.rpc(fn, args || {}); return { data, error }; } catch (e) { return { data: null, error: e }; }
  }
  const EMPTY_F = () => ({ group: '', teacher: '', from: '', to: '', q: '' });
  const recOn = () => typeof APP_CONFIG !== 'undefined' && APP_CONFIG.recording === true;
  const pollMs = () => Math.max(50, Number(window.TC_REC_POLL_MS) || 20000);
  const IP = {
    proc: new Set(), rec: null, recFailed: false, pollTimer: null,
    scope: null, key: '', view: 'list', seq: 0, list: null, err: null, f: EMPTY_F(), qTimer: null,
    sid: null, detail: null, dseq: 0, tab: 'report', si: 0, sub: 'overview', stq: '', drafts: {}, refl: {},
    mine: null, mid: null, mdetail: null, pendingOpen: null, from: null, asStudent: false, hasMine: false,
    mreports: null, mrid: null, mrdetail: null, mrs: null, mrErr: null,
  };

  const isStudent = () => !!(typeof currentUser !== 'undefined' && currentUser && currentUser.isStudent);
  const scopeFor = name => (isStudent() || (IP.asStudent && name !== 'unit-insights' && !inViewAs()) ? 'student' : name === 'unit-insights' ? 'unit' : 'mine');
  const rootEl = () => document.getElementById(IP.scope === 'unit' ? 'ins-unit-root' : 'ins-root');
  const panelName = () => (IP.scope === 'unit' ? 'unit-insights' : 'insights');
  const isActive = () => !!document.getElementById('panel-' + panelName())?.classList.contains('active');
  function unitId() {
    if (inViewAs()) return viewAs.unitId;
    if (currentUser?.isSuperAdmin) return (typeof currentOrgId !== 'undefined' && currentOrgId) || null;
    return (typeof currentOrgId !== 'undefined' && currentOrgId) || currentUser?.orgId || null;
  }
  const unitName = id => (typeof orgsCache !== 'undefined' && orgsCache[id]?.name) || (inViewAs() ? viewAs.path : '') || '';
  const scopeKey = () => [IP.scope, IP.scope === 'unit' ? (unitId() || 'all') : '', inViewAs() ? 'va:' + viewAs.unitId + ':' + (viewAs.person?.id || '') : (currentUser?.id || '')].join('|');

  // ── entry point (showPanel) ──
  function render(name) {
    const sc = scopeFor(name);
    IP.scope = sc;
    const key = scopeKey();
    if (key !== IP.key) { IP.key = key; IP.view = 'list'; IP.list = null; IP.mine = null; IP.detail = null; IP.mdetail = null; IP.err = null; IP.f = EMPTY_F(); IP.drafts = {}; IP.refl = {}; IP.mid = null; IP.mrid = null; IP.mrdetail = null; IP.mreports = null; IP.mrs = null; }
    if (IP.pendingOpen) { const p = IP.pendingOpen; IP.pendingOpen = null; if (sc === 'student') { openMine(p.id); if (!IP.mine) loadMine(() => {}); } else openSession(p.id, p); return; }
    if (sc === 'student') { IP.view = 'list'; paintMineList(); loadMine(); return; }
    if (IP.view === 'mr-list') { openMrList(); return; }
    if (IP.view === 'mr' && IP.mrdetail) { paintMrTeacher(); return; }
    if (IP.view === 'session' && IP.detail) { paintDetail(); return; }
    IP.view = 'list'; paintList(); loadList();
  }
  function onLang() { if (IP.scope && isActive()) repaint(); }
  function repaint() {
    if (IP.scope === 'student') { paintMineList(); return; }
    if (IP.view === 'mr-list') { paintMrList(); return; }
    if (IP.view === 'mr') { paintMrTeacher(); return; }
    if (IP.view === 'session') paintDetail(); else paintList();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // STAFF LIST (teacher / substitute · admin)
  // ════════════════════════════════════════════════════════════════════════════════════════
  function listArgs() {
    const f = IP.f; const base = { p_group: f.group || null, p_teacher: null, p_from: f.from || null, p_to: f.to || null, p_q: f.q.trim() || null };
    if (IP.scope === 'unit') return { ...base, p_mine: false, p_unit: unitId(), p_teacher: f.teacher || null };
    if (inViewAs()) return { ...base, p_mine: false, p_unit: viewAs.unitId, p_teacher: viewAs.person?.id || null }; // viewed teacher (read-only)
    return { ...base, p_mine: true, p_unit: null };
  }
  async function loadList() {
    const seq = ++IP.seq; const scope = IP.scope;
    const [{ data, error }, proc] = await Promise.all([rpc('list_insight_sessions', listArgs()),
      recOn() && !inViewAs() ? rpc('rec_processing_sessions') : Promise.resolve({ data: [] })]);
    if (seq !== IP.seq || scope !== IP.scope || IP.view !== 'list') return;
    IP.proc = new Set((Array.isArray(proc.data) ? proc.data : []).map(x => x && x.id).filter(Boolean));
    IP.err = error || null; IP.list = error ? null : (data || {});
    if (document.getElementById('ins-results')) { paintFilters(); paintResults(); } else paintList();
    if (scope === 'mine' && !inViewAs() && !IP.hasMine) {
      const m = await rpc('my_insights');
      if (!m.error && Array.isArray(m.data) && m.data.length && IP.scope === 'mine' && IP.view === 'list') { IP.hasMine = true; const h = document.getElementById('ins-mine-switch'); if (h) h.hidden = false; }
    }
  }
  const hasFilters = () => { const f = IP.f; return !!(f.group || f.teacher || f.from || f.to || f.q.trim()); };
  function headHtml() {
    const ro = inViewAs() || IP.scope === 'unit';
    const title = '<h1><span aria-hidden="true">💡</span> <span>Insights</span></h1>';
    const sub = IP.scope === 'unit'
      ? '<p class="lc-sub">The classes of this unit and everything below it: the teacher’s observation report and each student’s insights.</p>'
      : '<p class="lc-sub">After each class: an observation report for you and insights for each student, with a message from you.</p>';
    const u = unitId();
    const scope = IP.scope === 'unit' ? `<div class="ins-scope" id="ins-scope"><span aria-hidden="true">📍</span> ${u ? `<span>Scope:</span> <b data-no-i18n>${E(typeof hierPathLabel === 'function' && !inViewAs() ? (hierPathLabel(u) || unitName(u)) : unitName(u))}</b> <span>and everything below it</span>` : '<span>Scope: all institutions</span>'}</div>` : '';
    const mineBtn = IP.scope === 'mine' && !inViewAs() ? `<button type="button" class="lc-btn" data-lc="ins-as-student" id="ins-mine-switch"${IP.hasMine ? '' : ' hidden'}>🎒 <span>My insights as a student</span></button>` : '';
    const mrBtn = IP.scope === 'mine' && !inViewAs() ? '<button type="button" class="lc-btn" data-lc="ins-mr-list" id="ins-mr-btn">📅 <span>Monthly reports</span></button>' : '';
    return `<header class="lc-head"><div>${title}${sub}</div><div class="lc-row">${mrBtn}${mineBtn}</div>${ro ? `<span class="ins-ro" id="ins-ro"><span aria-hidden="true">👁</span> <span>${inViewAs() ? 'View as: read-only' : 'Read-only'}</span></span>` : ''}</header>${scope}`;
  }
  function paintList() {
    const root = rootEl(); if (!root) return;
    root.innerHTML = `<div class="lc-wrap ins-wrap">
      ${headHtml()}
      <div id="ins-banner"></div>
      <form class="ins-filters" id="ins-filters" role="search" onsubmit="return false"></form>
      <div id="ins-results" aria-live="polite"><div class="in-loading">Loading…</div></div>
    </div>`;
    paintFilters(); if (IP.list || IP.err) paintResults();
  }
  function paintFilters() {
    const box = document.getElementById('ins-filters'); if (!box) return;
    const L = IP.list || {}; const f = IP.f;
    const groups = Array.isArray(L.groups) ? L.groups : []; const teachers = Array.isArray(L.teachers) ? L.teachers : [];
    const showUnitName = IP.scope === 'unit' && new Set(groups.map(g => g.unit_name)).size > 1;
    const focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
    if (focus === 'ins-f-q') return; // keep typing undisturbed
    box.innerHTML = `
      <div class="lc-field"><label for="ins-f-group">Group</label><select id="ins-f-group"><option value="">All groups</option>${groups.map(g => `<option value="${E(g.id)}"${g.id === f.group ? ' selected' : ''} data-no-i18n>${E(g.name)}${showUnitName ? ' · ' + E(g.unit_name) : ''}</option>`).join('')}</select></div>
      ${IP.scope === 'unit' ? `<div class="lc-field"><label for="ins-f-teacher">Teacher</label><select id="ins-f-teacher"><option value="">All teachers</option>${teachers.map(t => `<option value="${E(t.id)}"${t.id === f.teacher ? ' selected' : ''} data-no-i18n>${E(t.name || '—')}</option>`).join('')}</select></div>` : ''}
      <div class="lc-field"><label for="ins-f-from">From</label><input type="date" id="ins-f-from" value="${E(f.from)}"></div>
      <div class="lc-field"><label for="ins-f-to">To</label><input type="date" id="ins-f-to" value="${E(f.to)}"></div>
      <div class="lc-field q"><label for="ins-f-q">Search student</label><input type="search" id="ins-f-q" value="${E(f.q)}" placeholder="Name or email" autocomplete="off"></div>
      ${hasFilters() ? '<button type="button" class="lc-btn lc-sm" data-lc="ins-clear">Clear filters</button>' : ''}`;
    if (focus) document.getElementById(focus)?.focus();
  }
  function whenBox(d) { return `<span class="ins-when" aria-hidden="true"><b data-no-i18n>${E(fmt(d, { day: 'numeric' }))}</b><span data-no-i18n>${E(fmt(d, { month: 'short' }))}</span></span>`; }
  function itemHtml(s) {
    const unit = IP.scope === 'unit' || inViewAs();
    return `<li><button type="button" class="ins-item" data-lc="ins-open" data-id="${E(s.id)}">
      ${whenBox(s.starts_at)}
      <span class="ins-main"><span class="ins-title" data-no-i18n>${E(s.title || s.group_name || tr('Class'))}</span>
        <span class="ins-meta"><span data-no-i18n>${E(fDay(s.starts_at))} · ${E(fTime(s.starts_at))}</span>${s.group_name ? ` · <span data-no-i18n>${E(s.group_name)}</span>` : ''}${unit && s.unit_name ? ` · <span data-no-i18n>${E(s.unit_name)}</span>` : ''}${unit && s.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(s.teacher_name)}</span>` : ''}</span></span>
      <span class="ins-chips">${s.is_demo ? V.demoChip() : ''}<span class="lc-chip">🎒 <b data-no-i18n>${Number(s.students) || 0}</b> <span>students</span></span>${Number(s.published) ? `<span class="lc-chip lc-chip-ok">💬 <b data-no-i18n>${Number(s.published)}</b> <span>published</span></span>` : ''}${s.has_reflection ? '<span class="lc-chip">📝 <span>Reflection</span></span>' : ''}${s.role === 'substitute' ? '<span class="lc-chip">Substitute</span>' : ''}</span>
      <span class="ins-go" aria-hidden="true">›</span></button></li>`;
  }
  function pendingHtml(list) {
    if (!list.length) return '';
    const ro = inViewAs() || IP.scope === 'unit'; // P-23: Institution → Insights is read-only (no demo generation for admins)
    if (IP.scope === 'unit') return '';
    return `<section class="lc-card" aria-labelledby="ins-pending-h" id="ins-pending">
      <h2 id="ins-pending-h">Recent classes without insights</h2>
      <p class="lc-hint">${ro ? 'View as is read-only: nothing can be generated.' : 'Generate sample insights to see how they look with your real groups and students. They are marked as demo.'}</p>
      <ul class="ins-pending">${list.map(p => `<li>
        <span class="ins-main"><span class="ins-title" data-no-i18n>${E(p.title || p.group_name || tr('Class'))}</span>
          <span class="ins-meta"><span data-no-i18n>${E(fDay(p.starts_at))} · ${E(fTime(p.starts_at))}</span>${p.group_name ? ` · <span data-no-i18n>${E(p.group_name)}</span>` : ''}${(IP.scope === 'unit' || inViewAs()) && p.teacher_name ? ` · <span data-no-i18n>${E(p.teacher_name)}</span>` : ''} · 🎒 <b data-no-i18n>${Number(p.students) || 0}</b> <span>students</span></span></span>
        ${IP.proc.has(p.id) ? `<button type="button" class="lc-btn lc-sm ins-proc-btn" data-lc="ins-open" data-id="${E(p.id)}"><span aria-hidden="true">⏳</span> <span>Processing…</span></button>`
          : ro ? '' : `<button type="button" class="lc-btn lc-sm" data-lc="ins-generate" data-id="${E(p.id)}" data-title="${E(p.title || '')}" data-group="${E(p.group_name || '')}">✨ Generate demo insights</button>`}
      </li>`).join('')}</ul>
    </section>`;
  }
  function emptyHtml() {
    if (hasFilters()) return '<div class="lc-card ins-empty" id="ins-empty"><h2>No classes match these filters.</h2><button type="button" class="lc-btn" data-lc="ins-clear">Clear filters</button></div>';
    const unit = IP.scope === 'unit';
    return `<div class="lc-card ins-empty" id="ins-empty">
      <div class="ins-empty-art" aria-hidden="true"><span>👩‍🏫</span><span>💡</span><span>🎒</span></div>
      <h2>${unit ? 'No class insights in this unit yet' : 'End a class or generate demo insights'}</h2>
      <p>${unit ? 'End a class or generate demo insights: the classes of this unit’s groups will appear here with the teacher’s report and each student’s insights.'
        : 'Insights appear here after you end a class from your Calendar (live classroom demo), or when you generate demo insights for a recent class below.'}</p>
      <p class="lc-fine">Real insights will come from the recorded live class, when it is connected.</p>
    </div>`;
  }
  function paintResults() {
    const box = document.getElementById('ins-results'); if (!box) return;
    const bn = document.getElementById('ins-banner');
    if (IP.err) { box.innerHTML = `<div class="lc-card ins-empty"><h2>We couldn't load the insights</h2><p>${E(errMsg(IP.err))}</p><button type="button" class="lc-btn" data-lc="ins-reload">Try again</button></div>`; if (bn) bn.innerHTML = ''; return; }
    const L = IP.list || {}; const sessions = Array.isArray(L.sessions) ? L.sessions : []; const pending = Array.isArray(L.pending) ? L.pending : [];
    if (bn) bn.innerHTML = sessions.some(s => s.is_demo) || (!sessions.length && pending.length) ? V.banner() : '';
    box.innerHTML = (sessions.length
      ? `<p class="ins-count"><b data-no-i18n>${sessions.length}</b> <span>${sessions.length === 1 ? 'class with insights' : 'classes with insights'}</span></p><ul class="ins-list" id="ins-list">${sessions.map(itemHtml).join('')}</ul>`
      : emptyHtml()) + pendingHtml(pending);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ONE CLASS: teacher report + students
  // ════════════════════════════════════════════════════════════════════════════════════════
  async function openSession(id, opts) {
    opts = opts || {};
    stopPoll(); IP.rec = null; IP.recFailed = false;
    IP.view = 'session'; IP.sid = id; IP.detail = null; IP.tab = opts.tab || 'report'; IP.si = 0; IP.sub = 'overview'; IP.stq = ''; IP.from = opts.from || null;
    const root = rootEl(); if (root) root.innerHTML = '<div class="lc-wrap"><div class="in-loading">Loading…</div></div>';
    const seq = ++IP.dseq;
    const { data, error } = await rpc('get_session_insights', { p_session: id });
    if (seq !== IP.dseq || IP.view !== 'session') return;
    if (error) { IP.view = 'list'; toast(errMsg(error), 'err'); paintList(); loadList(); return; }
    IP.detail = data || {};
    // a recorded class still being processed: say so and keep it moving. Also when the teacher report is already real: the
    // students come in a later step (before 2026-11-03 the page stopped polling there and the students never arrived).
    if (recOn() && !inViewAs()) {
      const st = await rpc('rec_session_status', { p_session: id });
      if (seq !== IP.dseq || IP.view !== 'session') return;
      if (!st.error && st.data && ['processing', 'live'].includes(st.data.state)) { IP.rec = st.data; paintDetail(); startPoll(id); return; }
      IP.recFailed = !st.error && !!st.data && st.data.failed && st.data.state === 'ended';
    }
    paintDetail();
  }

  // ── real insights: processing state + polling (POST /api/class/process advances the pipeline of THIS class) ──
  function stopPoll() { clearTimeout(IP.pollTimer); IP.pollTimer = null; }
  async function triggerProcess(id) {
    try {
      const { data: { session } = {} } = await sb.auth.getSession();
      const r = await fetch('/api/class/process', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
        body: JSON.stringify({ session: id }) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return j && typeof j.state === 'string' ? j : null;
    } catch (e) { return null; }
  }
  function startPoll(id) {
    stopPoll();
    const tick = async () => {
      IP.pollTimer = null;
      if (IP.view !== 'session' || IP.sid !== id || !IP.rec) return;
      if (!isActive()) { IP.pollTimer = setTimeout(tick, pollMs()); return; } // panel hidden: wait, don't work
      let st = await triggerProcess(id);
      if (!st) { const r = await rpc('rec_session_status', { p_session: id }); st = r.error ? IP.rec : r.data; }
      if (IP.view !== 'session' || IP.sid !== id || !IP.rec) return;
      if (st && ['processing', 'live'].includes(st.state)) {
        IP.rec = st; paintProcStep();
        IP.pollTimer = setTimeout(tick, pollMs()); return;
      }
      // finished (ready, or ended without insights): load the class again
      IP.rec = null; IP.recFailed = !!(st && st.failed && !st.has_insights);
      const seq = ++IP.dseq;
      const { data, error } = await rpc('get_session_insights', { p_session: id });
      if (seq !== IP.dseq || IP.view !== 'session' || IP.sid !== id) return;
      if (!error) { IP.detail = data || {}; IP._m = null; }
      paintDetail();
      if (st && st.has_insights) toast(tr('Your class insights are ready ✓'), 'ok');
    };
    IP.pollTimer = setTimeout(tick, 0);
  }
  function procStepHtml() {
    const r = IP.rec || {};
    if (r.state === 'live') return '<span>The class is still live: the insights are prepared when it ends.</span>';
    return `<span>Recordings transcribed:</span> <b data-no-i18n>${Number(r.transcribed) || 0} / ${Number(r.recordings) || 0}</b>`;
  }
  function paintProcStep() { const el = document.getElementById('ins-proc-step'); if (el) el.innerHTML = procStepHtml(); else if (IP.view === 'session') paintDetail(); }
  function processingHtml() {
    return `<section class="lc-card ins-processing" id="ins-processing" role="status" aria-live="polite">
      <div class="ins-proc-row"><span class="ins-spinner" aria-hidden="true"></span><h2>Processing your class… (it may take a few minutes)</h2></div>
      <p>We transcribe the voices of the people who consented and prepare the insights. This page updates by itself.</p>
      <p class="lc-fine" id="ins-proc-step">${procStepHtml()}</p>
    </section>`;
  }
  const canEdit = () => !!(IP.detail && IP.detail.can_edit) && !inViewAs();
  function detailModel() { return IP._m && IP._m.src === IP.detail ? IP._m.X : (IP._m = { src: IP.detail, X: V.modelFromSession(IP.detail) }).X; }
  function paintDetail() {
    const root = rootEl(); const d = IP.detail; if (!root || !d) return;
    const s = d.session || {}; const X = detailModel(); const rows = Array.isArray(d.students) ? d.students : [];
    const demo = !!(d.teacher && d.teacher.is_demo) || rows.some(r => r.is_demo);
    const missing = !d.teacher || rows.length < (Number(s.students_total) || 0);
    const real = !!(d.teacher && !d.teacher.is_demo);
    const genBtn = !inViewAs() && IP.scope !== 'unit' && missing && !real && !IP.rec && s.status !== 'cancelled' ? `<button type="button" class="lc-btn lc-sm" data-lc="ins-generate" data-id="${E(s.id)}" data-title="${E(s.title || '')}" data-group="${E(s.group_name || '')}" data-reopen="1">✨ ${d.teacher ? '<span>Add missing students</span>' : '<span>Generate demo insights</span>'}</button>` : '';
    root.innerHTML = `<div class="lc-wrap ins-wrap ins-detail">
      <button type="button" class="lc-link" data-lc="ins-back">← <span>All insights</span></button>
      <header class="lc-head ins-detail-head"><div><h1 data-no-i18n>${E(s.title || s.group_name || tr('Class'))}</h1>
        <p class="lc-sub"><span data-no-i18n>${E(fDay(s.starts_at))} · ${E(fTime(s.starts_at))}</span>${s.group_name ? ` · <span data-no-i18n>${E(s.group_name)}</span>` : ''}${s.unit_name ? ` · <span data-no-i18n>${E(s.unit_name)}</span>` : ''}${s.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(s.teacher_name)}</span>` : ''}${s.duration_min ? ` · <span data-no-i18n>${Number(s.duration_min)} min</span>` : ''}</p></div>
        <div class="ins-head-actions">${demo ? V.demoChip() : ''}${genBtn}${canEdit() ? '' : `<span class="ins-ro"><span aria-hidden="true">👁</span> <span>${inViewAs() ? 'View as: read-only' : 'Read-only'}</span></span>`}</div></header>
      ${IP.rec ? processingHtml() : ''}
      ${IP.recFailed && !real ? '<div class="lc-card ins-empty" id="ins-rec-failed"><h2>We couldn’t prepare the insights for this class.</h2><p>Nothing could be transcribed from the recording.</p></div>' : ''}
      ${demo && !IP.rec ? V.banner() : ''}
      ${IP.rec && !d.teacher && !rows.length ? '' : `<div class="lc-tabs" role="tablist" aria-label="${E(tr('Insights'))}">
        <button type="button" role="tab" class="lc-tab${IP.tab === 'report' ? ' active' : ''}" aria-selected="${IP.tab === 'report'}" data-lc="ins-tab" data-k="report" id="ins-tab-report">👩‍🏫 <span>Teacher report</span></button>
        <button type="button" role="tab" class="lc-tab${IP.tab === 'students' ? ' active' : ''}" aria-selected="${IP.tab === 'students'}" data-lc="ins-tab" data-k="students" id="ins-tab-students">🎒 <span>Students</span> <span class="lc-chip" data-no-i18n>${rows.length}</span></button>
      </div>
      <div class="lc-ins-body" role="tabpanel" id="ins-body">${IP.tab === 'students' ? studentsHtml(X) : reportHtml(X)}</div>`}
    </div>`;
    applyStudentFilter();
  }
  function reportHtml(X) {
    const d = IP.detail; const s = d.session || {}; const T = d.teacher;
    if (!T) return `<div class="lc-card ins-empty"><h2>No observation report for this class yet.</h2>${inViewAs() ? '' : '<p>Generate demo insights to see an example.</p>'}</div>`;
    return V.teacherReportHtml(X, {
      P: 'ins',
      header: { teacher: s.teacher_name, group: [s.group_name, s.unit_name].filter(Boolean).join(' · '), date: `${fDay(s.starts_at)} · ${fTime(s.starts_at)}`,
        students: (d.students || []).length || s.students_total || 0, duration: s.duration_min },
      fields: { editable: false },
      reflection: { mode: canEdit() ? 'edit' : 'read', text: IP.refl[s.id] ?? T.reflection ?? '', savedAt: T.reflection_at },
    });
  }
  function studentsHtml(X) {
    if (!X.students.length) return `<div class="lc-card ins-empty"><h2>No student insights for this class.</h2><p>${(IP.detail.session || {}).students_total ? 'Generate demo insights to add the students of this class.' : 'This class has no students yet.'}</p></div>`;
    IP.si = Math.min(IP.si, X.students.length - 1);
    const st = X.students[IP.si]; const row = st._row || {};
    const msg = canEdit() ? { mode: 'edit', key: row.id, text: IP.drafts[row.id] ?? row.teacher_message ?? '', published: row.published_at ? row.published_message : '', publishedAt: row.published_at }
      : { mode: 'read', published: row.published_at ? row.published_message : '', publishedAt: row.published_at };
    const search = X.students.length > 6 ? `<div class="ins-st-search"><label class="lc-sr" for="ins-st-q">Search student</label><input type="search" id="ins-st-q" placeholder="Search student" value="${E(IP.stq)}" autocomplete="off"></div>` : '';
    return search + V.studentTabsHtml(X, IP.si, IP.sub, { P: 'ins', msg });
  }
  function applyStudentFilter() {
    const q = IP.stq.trim().toLowerCase(); const root = rootEl(); if (!root) return;
    root.querySelectorAll('.lc-student-pick .lc-person-chip').forEach(b => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q) && !b.classList.contains('active'); });
  }
  function repaintBody(focusSel) {
    const body = document.getElementById('ins-body'); if (!body) { paintDetail(); return; }
    const sc = rootEl()?.scrollTop || 0; paintDetail(); const r = rootEl(); if (r) r.scrollTop = sc;
    const f = focusSel && rootEl()?.querySelector(focusSel); if (f) f.focus();
  }

  async function saveMessage(publish, btn) {
    if (blocked() || !canEdit()) return;
    const X = detailModel(); const st = X.students[IP.si]; const row = st && st._row; if (!row) return;
    const ta = rootEl()?.querySelector('#ins-teacher-msg'); const text = ta ? ta.value : (IP.drafts[row.id] ?? row.teacher_message ?? '');
    if (publish && !text.trim()) { toast('Write a message first.', 'err'); ta?.focus(); return; }
    if (btn) btn.disabled = true;
    const { data, error } = await rpc('save_insight_message', { p_insight: row.id, p_message: text, p_publish: !!publish });
    if (btn) btn.disabled = false;
    if (error) { toast(errMsg(error), 'err'); return; }
    Object.assign(row, { teacher_message: data.teacher_message, published_message: data.published_message, published_at: data.published_at });
    delete IP.drafts[row.id];
    toast(publish ? 'Published ✓ The student can see it now.' : 'Draft saved ✓', 'ok');
    IP._m = null; repaintBody(publish ? '#ins-publish-msg' : '#ins-save-msg');
  }
  async function saveReflection(btn) {
    if (blocked() || !canEdit()) return;
    const d = IP.detail; const sid = d.session.id;
    const ta = rootEl()?.querySelector('#ins-f-reflection'); const text = ta ? ta.value : (IP.refl[sid] ?? '');
    if (btn) btn.disabled = true;
    const { data, error } = await rpc('save_teacher_reflection', { p_session: sid, p_reflection: text });
    if (btn) btn.disabled = false;
    if (error) { toast(errMsg(error), 'err'); return; }
    d.teacher.reflection = data.reflection; d.teacher.reflection_at = data.reflection_at; delete IP.refl[sid];
    toast('Reflection saved ✓', 'ok');
    repaintBody('#ins-save-reflection');
  }
  // Demo insights for a class (teacher / substitute or admin). Idempotent in the database.
  async function generate(id, meta, btn) {
    if (blocked()) return false;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    // P-08: the demo follows the class: its attached plan when there is one (only its teacher can read it)
    let plan = meta && meta.plan;
    if (plan == null) { try { const r = await rpc('session_plan', { p_session: id }); plan = r && !r.error && r.data ? (typeof r.data === 'string' ? JSON.parse(r.data) : r.data).content || '' : ''; } catch (e) { plan = ''; } }
    const payload = V.buildDemoPayload({ title: meta && meta.title, group: meta && meta.group, plan });
    const { data, error } = await rpc('generate_demo_insights', { p_session: id, p_payload: payload });
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    if (error) { toast(errMsg(error), 'err'); return false; }
    toast(data && (data.teacher_created || data.students_created) ? 'Demo insights generated ✓' : 'This class already had its insights.', 'ok');
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // STUDENT: My insights (own only; the teacher's message only once published)
  // ════════════════════════════════════════════════════════════════════════════════════════
  const vaStudent = () => (inViewAs() && viewAs.perspective === 'student' ? { p_group: viewAs.group?.id || null, p_enrollment: viewAs.person?.id || null } : null);
  // 2026-11-11 (Ignacio): "My insights" with NO search. A timeline on the left (the monthly reports pinned on top, then the
  // classes grouped by month, newest first, "New" until opened) and the chosen class or report on the right; the newest class
  // opens by itself. Accounts that teach AND study (a teacher enrolled in someone else's group) reach it from Teaching → Insights.
  const dayKey = d => { try { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; } catch (e) { return ''; } };
  const monthKey = d => dayKey(d).slice(0, 7);
  // "New" = not opened yet on this device (a convenience: never required for anything)
  const seenKey = () => 'tc-ins-seen:' + (inViewAs() ? 'va' : (currentUser?.id || ''));
  function seenSet() { try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]')); } catch (e) { return new Set(); } }
  function markSeen(id) {
    if (!id || inViewAs()) return;
    try { const s = seenSet(); if (s.has(id)) return; s.add(id); localStorage.setItem(seenKey(), JSON.stringify([...s].slice(-500))); } catch (e) { /* storage off */ }
  }
  async function loadMine(then) {
    const seq = ++IP.seq; const va = vaStudent();
    const [ins, rep] = await Promise.all([rpc('my_insights', va || {}),
      va && !va.p_enrollment ? Promise.resolve({ data: [] }) : rpc('my_monthly_reports', va ? { p_enrollment: va.p_enrollment } : {})]);
    if (seq !== IP.seq || IP.scope !== 'student') return;
    IP.err = ins.error || null; IP.mine = ins.error ? null : (Array.isArray(ins.data) ? ins.data : []);
    IP.mreports = rep.error ? [] : (Array.isArray(rep.data) ? rep.data : (typeof rep.data === 'string' ? (() => { try { return JSON.parse(rep.data); } catch (e) { return []; } })() : []));
    paintMineList();
    if (then) then(); else if (!IP.mid && !IP.mrid && IP.mine && IP.mine.length) openMine(IP.mine[0].id);
  }
  const fNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(d).replace('.', typeof uiLang !== 'undefined' && uiLang === 'es' ? ',' : '.') : ''; };
  function railHtml() {
    const seen = seenSet(); const list = IP.mine || []; const reps = IP.mreports || [];
    const repCards = reps.map(r => `<button type="button" class="ins-report-card${r.id === IP.mrid ? ' active' : ''}" data-lc="ins-mr-open" data-id="${E(r.id)}" aria-pressed="${r.id === IP.mrid}">
        <small><span>Monthly report</span>${seen.has('mr:' + r.id) || inViewAs() ? '' : ' · <span>new</span>'}</small>
        <b><span>Report of</span> <span data-no-i18n>${E(V.monthName(r.month))}</span></b>
        <span><span data-no-i18n>${E(r.classes)}</span> <span>${Number(r.classes) === 1 ? 'class with insights' : 'classes with insights'}</span>${r.level_end ? ` · <span data-no-i18n>${E(r.level_end)}</span>` : ''}</span>
      </button>`).join('');
    const months = []; const by = new Map();
    list.forEach(x => { const k = monthKey(x.starts_at); if (!by.has(k)) { by.set(k, []); months.push(k); } by.get(k).push(x); });
    const cls = x => { const bits = [x.level, x.speaking_min != null && x.speaking_min !== '' ? `${fNum(x.speaking_min, 1)} min` : '', x.score != null && x.score !== '' ? `${tr('grammar')} ${fNum(x.score)}` : ''].filter(Boolean);
      return `<button type="button" class="ins-cls${x.id === IP.mid && !IP.mrid ? ' active' : ''}" data-lc="ins-mine-open" data-id="${E(x.id)}" aria-pressed="${x.id === IP.mid && !IP.mrid}">
        <span class="ins-cls-top"><span data-no-i18n>${E(fmt(x.starts_at, { weekday: 'short', day: 'numeric', month: 'short' }))}${x.teacher_name ? ' · ' + E(x.teacher_name) : ''}</span>${seen.has(x.id) || inViewAs() ? '' : '<span class="ins-new">New</span>'}${x.is_demo ? V.demoChip() : ''}</span>
        <span class="ins-cls-t" data-no-i18n>${E(x.title || x.group_name || tr('Class'))}</span>
        ${bits.length ? `<span class="ins-cls-k" data-no-i18n>${E(bits.join(' · '))}</span>` : ''}
      </button>`; };
    const nextMonth = (() => { const d = new Date(); const n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return fmt(n, { day: 'numeric', month: 'long' }); })();
    return `${repCards}
      ${months.map(k => `<div class="ins-month-h" data-no-i18n>${E(V.monthName(k))}</div>${by.get(k).map(cls).join('')}`).join('')}
      <p class="lc-fine"><span>Your monthly report appears here on</span> <span data-no-i18n>${E(nextMonth)}</span>.</p>`;
  }
  function paintMineList() {
    const root = rootEl(); if (!root) return;
    const list = IP.mine; const va = vaStudent();
    let body;
    if (IP.err) body = `<div class="lc-card ins-empty"><h2>We couldn't load your insights</h2><p>${E(errMsg(IP.err))}</p><button type="button" class="lc-btn" data-lc="ins-reload">Try again</button></div>`;
    else if (!list) body = '<div class="in-loading">Loading…</div>';
    else if (!list.length && !(IP.mreports || []).length) body = `<div class="lc-card ins-empty" id="ins-empty">
        <div class="ins-empty-art" aria-hidden="true"><span>🗣️</span><span>📚</span><span>💬</span></div>
        <h2>Insights appear after your classes</h2>
        <p>${va && !va.p_enrollment ? 'Pick a student in View as to see their insights.' : 'After each class you’ll see a recap, your progress, feedback and a message from your teacher.'}</p></div>`;
    else body = `<div class="ins-layout"><aside class="ins-rail no-print" id="ins-rail" aria-label="${E(tr('Your classes'))}">${railHtml()}</aside>
        <div id="ins-dash" class="ins-dash" aria-live="polite">${IP.mrid ? (IP.mrdetail ? reportDashHtml() : '<div class="in-loading">Loading…</div>') : IP.mdetail ? dashHtml() : '<div class="in-loading">Loading…</div>'}</div></div>`;
    const back = IP.asStudent ? '<button type="button" class="lc-link no-print" data-lc="ins-as-teacher">← <span>Teaching insights</span></button>'
      : '<button type="button" class="lc-link no-print" data-lc="ins-student-home">← <span>Back to my classes</span></button>';
    root.innerHTML = `<div class="lc-wrap ins-wrap">
      ${back}
      <header class="lc-head no-print"><div><h1><span aria-hidden="true">💡</span> <span>My insights</span></h1><p class="lc-sub">After each class: your grammar, vocabulary and pronunciation, with a message from your teacher. Every month, a report.</p></div>${inViewAs() ? '<span class="ins-ro"><span aria-hidden="true">👁</span> <span>View as: read-only</span></span>' : ''}</header>
      ${list && list.some(x => x.is_demo) ? V.banner() : ''}
      ${body}
    </div>`;
  }
  function paintRail() { const r = document.getElementById('ins-rail'); if (r) r.innerHTML = railHtml(); else paintMineList(); }
  async function openMine(id) {
    IP.view = 'list'; IP.mid = id; IP.mdetail = null; IP.mrid = null; IP.mrdetail = null;
    const box = document.getElementById('ins-dash'); if (box) box.innerHTML = '<div class="in-loading">Loading…</div>';
    if (!box) paintMineList(); else paintRail();
    const seq = ++IP.dseq; const va = vaStudent();
    const { data, error } = await rpc('my_insight', { p_id: id, p_enrollment: va ? va.p_enrollment : null });
    if (seq !== IP.dseq || IP.scope !== 'student') return;
    if (error) { toast(errMsg(error), 'err'); IP.mid = null; const d = document.getElementById('ins-dash'); if (d) d.innerHTML = ''; return; }
    IP.mdetail = data || {}; markSeen(id);
    if (!IP.mine) { loadMine(() => paintMineDetail()); return; }
    paintMineDetail();
  }
  async function openReport(id) {
    IP.view = 'list'; IP.mrid = id; IP.mrdetail = null;
    const box = document.getElementById('ins-dash'); if (box) box.innerHTML = '<div class="in-loading">Loading…</div>';
    if (!box) paintMineList(); else paintRail();
    const seq = ++IP.dseq; const va = vaStudent();
    const { data, error } = await rpc('monthly_report', { p_id: id, p_enrollment: va ? va.p_enrollment : null });
    if (seq !== IP.dseq || IP.scope !== 'student') return;
    if (error) { toast(errMsg(error), 'err'); IP.mrid = null; paintMineList(); return; }
    IP.mrdetail = (typeof data === 'string' ? JSON.parse(data) : data) || {}; markSeen('mr:' + id);
    paintMineDetail();
  }
  function dashHtml() {
    const d = IP.mdetail; if (!d) return '';
    const s = d.session || {}; const X = V.modelFromStudent(d);
    return `<article class="ins-dash-sheet" id="ins-dash-sheet">
      <header class="ins-dash-head">
        <div><div class="ins-dash-brand" aria-hidden="true"><span data-no-i18n>TeroClass</span> · <span>My insights</span></div>
          <h2 class="ins-dash-title" data-no-i18n>${E(s.title || s.group_name || tr('Class'))}</h2>
          <p class="lc-sub"><span data-no-i18n>${E(fDay(s.starts_at))} · ${E(fTime(s.starts_at))}</span>${s.group_name ? ` · <span data-no-i18n>${E(s.group_name)}</span>` : ''}${s.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(s.teacher_name)}</span>` : ''}${d.student_name ? ` · <span>Student:</span> <span data-no-i18n>${E(d.student_name)}</span>` : ''}</p></div>
        <div class="ins-head-actions">${d.is_demo ? V.demoChip() : ''}<button type="button" class="lc-btn no-print" data-lc="ins-pdf" id="ins-pdf">⬇ <span>Download PDF</span></button></div>
      </header>
      ${V.studentDashboardHtml(X, { P: 'ins', msg: { mode: 'student', published: d.message || '', publishedAt: d.published_at } })}
    </article>`;
  }
  function reportDashHtml(mode) {
    const d = IP.mrdetail; if (!d) return '';
    return `<article class="ins-dash-sheet" id="ins-dash-sheet">
      <header class="ins-dash-head">
        <div><div class="ins-dash-brand" aria-hidden="true"><span data-no-i18n>TeroClass</span> · <span>Monthly report</span></div>
          <h2 class="ins-dash-title"><span>Report of</span> <span data-no-i18n>${E(V.monthName(d.month))}</span></h2>
          <p class="lc-sub">${d.student_name ? `<span>Student:</span> <span data-no-i18n>${E(d.student_name)}</span>` : ''}</p></div>
        <div class="ins-head-actions"><button type="button" class="lc-btn no-print" data-lc="ins-pdf" id="ins-pdf">⬇ <span>Download PDF</span></button></div>
      </header>
      ${V.monthlyReportHtml(d, { P: 'mr', mode: mode || 'student' })}
    </article>`;
  }
  function paintMineDetail() {
    const box = document.getElementById('ins-dash');
    if (!box) { paintMineList(); return; }
    box.innerHTML = IP.mrid ? reportDashHtml() : dashHtml();
    paintRail();
  }

  // ── Teacher / substitute: the monthly reports of their students (they can add a message) ──
  async function openMrList() {
    IP.view = 'mr-list'; IP.mrs = null; IP.mrErr = null; paintMrList();
    const seq = ++IP.seq;
    const { data, error } = await rpc('teacher_monthly_reports');
    if (seq !== IP.seq || IP.view !== 'mr-list') return;
    IP.mrErr = error || null; IP.mrs = error ? [] : (Array.isArray(data) ? data : (typeof data === 'string' ? JSON.parse(data) : []));
    paintMrList();
  }
  function paintMrList() {
    const root = rootEl(); if (!root) return;
    const list = IP.mrs; const months = []; const by = new Map();
    (list || []).forEach(r => { const k = String(r.month).slice(0, 7); if (!by.has(k)) { by.set(k, []); months.push(k); } by.get(k).push(r); });
    root.innerHTML = `<div class="lc-wrap ins-wrap">
      <button type="button" class="lc-link" data-lc="ins-back">← <span>All insights</span></button>
      <header class="lc-head"><div><h1><span aria-hidden="true">📅</span> <span>Monthly reports</span></h1><p class="lc-sub">On the 1st of each month every student with classes gets a report. Add a personal message if you want: they see it right away.</p></div></header>
      ${IP.mrErr ? `<div class="lc-card ins-empty"><p>${E(errMsg(IP.mrErr))}</p></div>` : !list ? '<div class="in-loading">Loading…</div>'
        : !list.length ? '<div class="lc-card ins-empty"><h2>No monthly reports yet</h2><p>They are created on the 1st of each month for the students who had classes with insights.</p></div>'
        : months.map(k => `<h2 class="ins-dash-h" data-no-i18n>${E(V.monthName(k))}</h2><div class="ins-mr-list">${by.get(k).map(r => `<button type="button" class="ins-cls" data-lc="ins-mr-teacher" data-id="${E(r.id)}">
            <span class="ins-cls-t" data-no-i18n>${E(r.student_name || '')}</span>
            <span class="ins-cls-k"><span data-no-i18n>${E(r.classes)}</span> <span>${Number(r.classes) === 1 ? 'class with insights' : 'classes with insights'}</span>${r.level_end ? ` · <span data-no-i18n>${E(r.level_end)}</span>` : ''} · ${r.has_message ? '<span>✓ message added</span>' : '<span>no message yet</span>'}</span></button>`).join('')}</div>`).join('')}
    </div>`;
  }
  async function openMrTeacher(id) {
    IP.view = 'mr'; IP.mrdetail = null; IP.mrid = id;
    const root = rootEl(); if (root) root.innerHTML = '<div class="lc-wrap ins-wrap"><div class="in-loading">Loading…</div></div>';
    const seq = ++IP.dseq;
    const { data, error } = await rpc('monthly_report', { p_id: id });
    if (seq !== IP.dseq || IP.view !== 'mr') return;
    if (error) { toast(errMsg(error), 'err'); openMrList(); return; }
    IP.mrdetail = (typeof data === 'string' ? JSON.parse(data) : data) || {};
    paintMrTeacher();
  }
  function paintMrTeacher() {
    const root = rootEl(); if (!root) return;
    root.innerHTML = `<div class="lc-wrap ins-wrap"><button type="button" class="lc-link no-print" data-lc="ins-mr-list">← <span>Monthly reports</span></button>
      ${reportDashHtml(IP.mrdetail?.can_edit && !inViewAs() ? 'edit' : 'read')}</div>`;
  }
  async function saveMr(btn) {
    const d = IP.mrdetail; const ta = document.getElementById('mr-msg'); if (!d || !ta || blocked()) return;
    if (btn) btn.disabled = true;
    const { data, error } = await rpc('save_monthly_message', { p_id: d.id, p_message: ta.value });
    if (btn) btn.disabled = false;
    if (error) { toast(errMsg(error), 'err'); return; }
    const r = typeof data === 'string' ? JSON.parse(data) : (data || {});
    d.message = r.message || ''; d.message_at = r.message_at || null;
    toast(d.message ? 'Message saved ✓ The student can see it now.' : 'Message removed', 'ok');
    paintMrTeacher();
  }
  // PDF: the dashboard printed alone (hidden frame with the app's styles → the browser's "Save as PDF")
  function downloadPdf() {
    const sheet = document.getElementById('ins-dash-sheet'); const rep = IP.mrid && IP.mrdetail; const d = rep ? IP.mrdetail : IP.mdetail; if (!sheet || !d) return;
    const s = rep ? { title: `${tr('Monthly report')} ${V.monthName(d.month)}`, starts_at: d.month } : (d.session || {});
    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).map(n => n.outerHTML).join('\n');
    const name = `TeroClass - ${rep ? (d.student_name || tr('My insights')) : tr('My insights')} - ${s.title || s.group_name || tr('Class')}${rep ? '' : ' - ' + dayKey(s.starts_at)}`.replace(/[\\/:*?"<>|]+/g, ' ');
    const foot = `${tr('Generated with TeroClass')} · ${fDay(new Date())}`;
    const old = document.getElementById('ins-print-frame'); if (old) old.remove();
    const fr = document.createElement('iframe'); fr.id = 'ins-print-frame'; fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(fr);
    const doc = fr.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="${E(document.documentElement.lang || 'es')}"><head><meta charset="UTF-8"><title>${E(name)}</title><base href="${E(location.origin + '/')}">${styles}
      <style>html,body{background:#fff!important;height:auto!important;overflow:visible!important}body{margin:0;padding:18px 22px}.no-print{display:none!important}
      .lc-card{box-shadow:none!important}.lc-metric,.lc-topic,.lc-fb,.lc-pron-card,.lc-vocab-card,.lc-msgbox,tr{break-inside:avoid}.ins-dash-h{break-after:avoid}.ins-print-foot{margin-top:18px;padding-top:8px;border-top:1px solid #ddd;font:11px Inter,Arial,sans-serif;color:#888;text-align:center}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{margin:1.3cm}</style></head>
      <body class="lc-root ins-root ins-print"><div class="lc-wrap ins-wrap">${sheet.outerHTML}<div class="ins-print-foot">${E(foot)}</div></div></body></html>`);
    doc.close();
    const prevTitle = document.title;
    const go = () => {
      document.title = name; // Chrome / Safari suggest the file name from the title
      try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { console.warn(e); toast('Could not open the print window.', 'err'); }
      setTimeout(() => { document.title = prevTitle; }, 1500);
    };
    toast('Choose “Save as PDF” in the window that opens.', 'ok');
    const fonts = fr.contentDocument.fonts; setTimeout(() => (fonts && fonts.ready ? fonts.ready.then(go, go) : go()), 400);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // EVENTS (only inside the Insights roots)
  // ════════════════════════════════════════════════════════════════════════════════════════
  const inRoot = el => !!el && !!el.closest('.ins-root');
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-lc]'); if (!el || !inRoot(el)) return;
    const a = el.dataset.lc; const id = el.dataset.id;
    switch (a) {
      case 'ins-open': openSession(id); break;
      case 'ins-back': stopPoll(); IP.rec = null; IP.view = 'list'; IP.detail = null; paintList(); loadList(); break;
      case 'ins-reload': IP.err = null; if (IP.scope === 'student') { IP.mine = null; paintMineList(); loadMine(); } else { IP.list = null; paintList(); loadList(); } break;
      case 'ins-clear': IP.f = EMPTY_F(); paintFilters(); loadList(); break;
      case 'ins-tab': IP.tab = el.dataset.k === 'students' ? 'students' : 'report'; repaintBody('#ins-tab-' + IP.tab); break;
      case 'pick-student': IP.si = parseInt(el.dataset.i, 10) || 0; repaintBody('#ins-pick-' + IP.si); break;
      case 'ins-sub': {
        IP.sub = V.SUBTABS.some(([k]) => k === el.dataset.k) ? el.dataset.k : 'overview';
        if (IP.scope === 'student') { paintMineDetail(); rootEl()?.querySelector('#ins-sub-' + IP.sub)?.focus(); } else repaintBody('#ins-sub-' + IP.sub);
        break;
      }
      case 'draft-msg': {
        if (!canEdit()) break;
        const X = detailModel(); const st = X.students[IP.si]; const ta = rootEl()?.querySelector('#ins-teacher-msg'); if (!st || !ta) break;
        ta.value = V.draftMessage(X, st); IP.drafts[st._row.id] = ta.value; ta.focus();
        toast('Draft ready — edit it before publishing.', 'ok'); break;
      }
      case 'save-msg': saveMessage(false, el); break;
      case 'publish-msg': saveMessage(true, el); break;
      case 'save-reflection': saveReflection(el); break;
      case 'ins-generate': {
        const ok = await generate(id, { title: el.dataset.title, group: el.dataset.group }, el);
        if (ok) { if (IP.scope !== 'student') { IP.list = null; openSession(id, { tab: el.dataset.reopen ? IP.tab : 'report' }); } }
        break;
      }
      case 'ins-mine-open': openMine(id); break;
      case 'ins-mr-open': openReport(id); break;
      case 'ins-mr-list': openMrList(); break;
      case 'ins-mr-teacher': openMrTeacher(id); break;
      case 'mr-save': saveMr(el); break;
      case 'ins-pdf': downloadPdf(); break;
      case 'ins-as-student': IP.asStudent = true; render('insights'); break;
      case 'ins-as-teacher': IP.asStudent = false; render('insights'); break;
      case 'ins-student-home': if (typeof showPanel === 'function') showPanel('student'); break;
      default: break;
    }
  });
  document.addEventListener('change', e => {
    const t = e.target; if (!inRoot(t)) return;
    const k = { 'ins-f-group': 'group', 'ins-f-teacher': 'teacher', 'ins-f-from': 'from', 'ins-f-to': 'to' }[t.id];
    if (k) { IP.f[k] = t.value || ''; loadList(); }
  });
  document.addEventListener('input', e => {
    const t = e.target; if (!inRoot(t)) return;
    if (t.id === 'ins-f-q') { IP.f.q = t.value; clearTimeout(IP.qTimer); IP.qTimer = setTimeout(loadList, 300); return; }
    if (t.id === 'ins-st-q') { IP.stq = t.value; applyStudentFilter(); return; }
    if (t.id === 'ins-teacher-msg' && t.dataset.key) { IP.drafts[t.dataset.key] = t.value; return; }
    if (t.id === 'ins-f-reflection' && IP.detail?.session) { IP.refl[IP.detail.session.id] = t.value; }
  });

  // From the live class (end of a calendar class) or the calendar: open one class in Teaching → Insights
  function openFromOutside(id, opts) {
    opts = opts || {};
    IP.pendingOpen = { id, ...opts };
    // admins coming from the unit calendar: Institution → Insights; everyone else: Teaching → Insights
    if (typeof showPanel === 'function') showPanel(opts.unit && !isStudent() && typeof isAdminUser === 'function' && isAdminUser() ? 'unit-insights' : 'insights');
  }
  function openMineFromOutside(id) { IP.pendingOpen = { id }; if (typeof showPanel === 'function') showPanel('insights'); }

  window.TCInsightsPanel = { render, onLang, openSession: openFromOutside, openMine: openMineFromOutside, generate, get state() { return IP; } };

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ERRORS + SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/Los insights de demo se generan para clases de hoy o anteriores/, 'Demo insights can only be generated for today’s or past classes.'],
    [/Una clase cancelada no tiene insights/, 'A cancelled class has no insights.'], [/Datos de demo inválidos/, 'Invalid demo data.'],
    [/Todavía no hay insights para esta clase/, 'This class has no insights yet.'], [/Escribí un mensaje antes de publicarlo/, 'Write a message before publishing it.']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Insights': 'Insights', 'My insights': 'Mis insights', 'Loading…': 'Cargando…', 'Class': 'Clase', 'Teacher:': 'Docente:', 'Substitute': 'Suplente',
    'The classes of this unit and everything below it: the teacher’s observation report and each student’s insights.': 'Las clases de esta unidad y de todo lo que cuelga de ella: el informe de observación del docente y los insights de cada estudiante.',
    'After each class: an observation report for you and insights for each student, with a message from you.': 'Después de cada clase: un informe de observación para vos e insights para cada estudiante, con un mensaje tuyo.',
    'Scope:': 'Alcance:', 'and everything below it': 'y todo lo que cuelga de ella', 'Scope: all institutions': 'Alcance: todas las instituciones',
    'View as: read-only': '"Ver como": solo lectura', 'Read-only': 'Solo lectura',
    'Group': 'Grupo', 'All groups': 'Todos los grupos', 'Teacher': 'Docente', 'All teachers': 'Todos los docentes', 'From': 'Desde', 'To': 'Hasta',
    'Search student': 'Buscar estudiante', 'PH:Name or email': 'Nombre o email', 'PH:Search student': 'Buscar estudiante', 'Clear filters': 'Limpiar filtros',
    'students': 'estudiantes', 'published': 'publicados', 'Reflection': 'Reflexión', 'class with insights': 'clase con insights', 'classes with insights': 'clases con insights',
    'Recent classes without insights': 'Clases recientes sin insights', 'View as is read-only: nothing can be generated.': '"Ver como" es solo lectura: no se puede generar nada.',
    'Generate sample insights to see how they look with your real groups and students. They are marked as demo.': 'Generá insights de ejemplo para ver cómo quedan con tus grupos y estudiantes reales. Quedan marcados como demo.',
    '✨ Generate demo insights': '✨ Generar insights de demo', 'Generate demo insights': 'Generar insights de demo', 'Add missing students': 'Agregar estudiantes que faltan',
    'No classes match these filters.': 'Ninguna clase coincide con estos filtros.',
    'No class insights in this unit yet': 'Todavía no hay insights de clases en esta unidad', 'End a class or generate demo insights': 'Terminá una clase o generá insights de demo',
    'End a class or generate demo insights: the classes of this unit’s groups will appear here with the teacher’s report and each student’s insights.': 'Terminá una clase o generá insights de demo: las clases de los grupos de esta unidad van a aparecer acá con el informe del docente y los insights de cada estudiante.',
    'Insights appear here after you end a class from your Calendar (live classroom demo), or when you generate demo insights for a recent class below.': 'Los insights aparecen acá cuando terminás una clase desde tu Calendario (demo del aula en vivo) o cuando generás insights de demo para una clase reciente, abajo.',
    'Real insights will come from the recorded live class, when it is connected.': 'Los insights reales van a salir de la clase en vivo grabada, cuando se conecte.',
    "We couldn't load the insights": 'No pudimos cargar los insights', 'Try again': 'Reintentar', 'All insights': 'Todos los insights',
    'Teacher report': 'Informe del docente', 'Students': 'Estudiantes', 'Generate demo insights to see an example.': 'Generá insights de demo para ver un ejemplo.',
    'Generate demo insights to add the students of this class.': 'Generá insights de demo para sumar a los estudiantes de esta clase.', 'This class has no students yet.': 'Esta clase todavía no tiene estudiantes.',
    'Write a message first.': 'Primero escribí un mensaje.', 'Published ✓ The student can see it now.': 'Publicado ✓ El estudiante ya lo puede ver.', 'Draft saved ✓': 'Borrador guardado ✓',
    'Reflection saved ✓': 'Reflexión guardada ✓', 'Demo insights generated ✓': 'Insights de demo generados ✓', 'This class already had its insights.': 'Esta clase ya tenía sus insights.',
    'Draft ready — edit it before publishing.': 'Borrador listo: editalo antes de publicarlo.',
    "We couldn't load your insights": 'No pudimos cargar tus insights', 'Insights appear after your classes': 'Los insights aparecen después de tus clases',
    'Pick a student in View as to see their insights.': 'Elegí un estudiante en "Ver como" para ver sus insights.',
    'After each class you’ll see a recap, your progress, feedback and a message from your teacher.': 'Después de cada clase vas a ver un repaso, tu progreso, una devolución y un mensaje de tu docente.',
    'Message from your teacher': 'Mensaje de tu docente', 'Back to my classes': 'Volver a mis clases',
    'Search my insights': 'Buscar en mis insights', 'Latest class': 'Última clase', 'Search': 'Buscar', 'Clear': 'Limpiar',
    'No classes match this search': 'Ninguna clase coincide con la búsqueda', 'Try other dates or clear the search.': 'Probá con otras fechas o limpiá la búsqueda.',
    'classes found — choose one:': 'clases encontradas. Elegí una:', 'Download PDF': 'Descargar PDF', 'Student:': 'Estudiante:',
    'Choose “Save as PDF” in the window that opens.': 'En la ventana que se abre, elegí “Guardar como PDF”.', 'Could not open the print window.': 'No se pudo abrir la ventana para imprimir.',
    // 2026-11-11: My insights without search + monthly reports
    'Monthly report': 'Reporte mensual', 'new': 'nuevo', 'New': 'Nuevo', 'Report of': 'Reporte de', 'grammar': 'gramática', 'Your classes': 'Tus clases',
    'Your monthly report appears here on': 'Tu reporte mensual aparece acá el',
    'After each class: your grammar, vocabulary and pronunciation, with a message from your teacher. Every month, a report.': 'Después de cada clase: tu gramática, tu vocabulario y tu pronunciación, con un mensaje de tu docente. Y cada mes, un reporte.',
    'Monthly reports': 'Reportes mensuales', 'No monthly reports yet': 'Todavía no hay reportes mensuales',
    'They are created on the 1st of each month for the students who had classes with insights.': 'Se crean el día 1 de cada mes para los alumnos que tuvieron clases con insights.',
    'On the 1st of each month every student with classes gets a report. Add a personal message if you want: they see it right away.': 'El día 1 de cada mes cada alumno con clases recibe un reporte. Si querés, sumale un mensaje personal: lo ve enseguida.',
    '✓ message added': '✓ con mensaje', 'no message yet': 'sin mensaje todavía', 'Message saved ✓ The student can see it now.': 'Mensaje guardado ✓ El alumno ya lo puede ver.',
    'Message removed': 'Mensaje quitado', 'El mensaje es demasiado largo': 'El mensaje es demasiado largo',
    'Generated with TeroClass': 'Generado con TeroClass', 'My insights as a student': 'Mis insights como estudiante', 'Teaching insights': 'Insights de docencia',
    'After each class: a recap, your progress, feedback and a message from your teacher.': 'Después de cada clase: un repaso, tu progreso, una devolución y un mensaje de tu docente.',
    'Demo insights can only be generated for today’s or past classes.': 'Los insights de demo se generan para clases de hoy o anteriores.',
    'A cancelled class has no insights.': 'Una clase cancelada no tiene insights.', 'Invalid demo data.': 'Datos de demo inválidos.',
    'This class has no insights yet.': 'Esta clase todavía no tiene insights.', 'Write a message before publishing it.': 'Escribí un mensaje antes de publicarlo.',
    // real insights (recorded classes)
    'Processing your class… (it may take a few minutes)': 'Procesando tu clase… (puede tardar unos minutos)',
    'We transcribe the voices of the people who consented and prepare the insights. This page updates by itself.': 'Transcribimos las voces de quienes dieron su consentimiento y preparamos los insights. Esta página se actualiza sola.',
    'Recordings transcribed:': 'Grabaciones transcriptas:', 'Processing…': 'Procesando…',
    'The class is still live: the insights are prepared when it ends.': 'La clase sigue en vivo: los insights se preparan cuando termina.',
    'Your class insights are ready ✓': 'Los insights de tu clase están listos ✓',
    'We couldn’t prepare the insights for this class.': 'No pudimos preparar los insights de esta clase.',
    'Nothing could be transcribed from the recording.': 'No se pudo transcribir nada de la grabación.',
  });
})();
