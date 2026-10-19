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
  const fmt = (d, o) => { try { return new Date(d).toLocaleString(loc(), o); } catch (e) { return ''; } };
  const fDay = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fTime = d => fmt(d, { hour: '2-digit', minute: '2-digit' });
  async function rpc(fn, args) {
    try { const { data, error } = await sb.rpc(fn, args || {}); return { data, error }; } catch (e) { return { data: null, error: e }; }
  }
  const EMPTY_F = () => ({ group: '', teacher: '', from: '', to: '', q: '' });
  const IP = {
    scope: null, key: '', view: 'list', seq: 0, list: null, err: null, f: EMPTY_F(), qTimer: null,
    sid: null, detail: null, dseq: 0, tab: 'report', si: 0, sub: 'overview', stq: '', drafts: {}, refl: {},
    mine: null, mid: null, mdetail: null, pendingOpen: null, from: null,
  };

  const isStudent = () => !!(typeof currentUser !== 'undefined' && currentUser && currentUser.isStudent);
  const scopeFor = name => (isStudent() ? 'student' : name === 'unit-insights' ? 'unit' : 'mine');
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
    if (key !== IP.key) { IP.key = key; IP.view = 'list'; IP.list = null; IP.mine = null; IP.detail = null; IP.mdetail = null; IP.err = null; IP.f = EMPTY_F(); IP.drafts = {}; IP.refl = {}; }
    if (IP.pendingOpen) { const p = IP.pendingOpen; IP.pendingOpen = null; if (sc === 'student') openMine(p.id); else openSession(p.id, p); return; }
    if (sc === 'student') { if (IP.view === 'mine-detail' && IP.mdetail) paintMineDetail(); else { IP.view = 'list'; paintMineList(); loadMine(); } return; }
    if (IP.view === 'session' && IP.detail) { paintDetail(); return; }
    IP.view = 'list'; paintList(); loadList();
  }
  function onLang() { if (IP.scope && isActive()) repaint(); }
  function repaint() {
    if (IP.scope === 'student') { if (IP.view === 'mine-detail') paintMineDetail(); else paintMineList(); return; }
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
    const { data, error } = await rpc('list_insight_sessions', listArgs());
    if (seq !== IP.seq || scope !== IP.scope || IP.view !== 'list') return;
    IP.err = error || null; IP.list = error ? null : (data || {});
    if (document.getElementById('ins-results')) { paintFilters(); paintResults(); } else paintList();
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
    return `<header class="lc-head"><div>${title}${sub}</div>${ro ? `<span class="ins-ro" id="ins-ro"><span aria-hidden="true">👁</span> <span>${inViewAs() ? 'View as: read-only' : 'Read-only'}</span></span>` : ''}</header>${scope}`;
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
    const ro = inViewAs();
    return `<section class="lc-card" aria-labelledby="ins-pending-h" id="ins-pending">
      <h2 id="ins-pending-h">Recent classes without insights</h2>
      <p class="lc-hint">${ro ? 'View as is read-only: nothing can be generated.' : 'Generate sample insights to see how they look with your real groups and students. They are marked as demo.'}</p>
      <ul class="ins-pending">${list.map(p => `<li>
        <span class="ins-main"><span class="ins-title" data-no-i18n>${E(p.title || p.group_name || tr('Class'))}</span>
          <span class="ins-meta"><span data-no-i18n>${E(fDay(p.starts_at))} · ${E(fTime(p.starts_at))}</span>${p.group_name ? ` · <span data-no-i18n>${E(p.group_name)}</span>` : ''}${(IP.scope === 'unit' || inViewAs()) && p.teacher_name ? ` · <span data-no-i18n>${E(p.teacher_name)}</span>` : ''} · 🎒 <b data-no-i18n>${Number(p.students) || 0}</b> <span>students</span></span></span>
        ${ro ? '' : `<button type="button" class="lc-btn lc-sm" data-lc="ins-generate" data-id="${E(p.id)}" data-title="${E(p.title || '')}" data-group="${E(p.group_name || '')}">✨ Generate demo insights</button>`}
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
    IP.view = 'session'; IP.sid = id; IP.detail = null; IP.tab = opts.tab || 'report'; IP.si = 0; IP.sub = 'overview'; IP.stq = ''; IP.from = opts.from || null;
    const root = rootEl(); if (root) root.innerHTML = '<div class="lc-wrap"><div class="in-loading">Loading…</div></div>';
    const seq = ++IP.dseq;
    const { data, error } = await rpc('get_session_insights', { p_session: id });
    if (seq !== IP.dseq || IP.view !== 'session') return;
    if (error) { IP.view = 'list'; toast(errMsg(error), 'err'); paintList(); loadList(); return; }
    IP.detail = data || {};
    paintDetail();
  }
  const canEdit = () => !!(IP.detail && IP.detail.can_edit) && !inViewAs();
  function detailModel() { return IP._m && IP._m.src === IP.detail ? IP._m.X : (IP._m = { src: IP.detail, X: V.modelFromSession(IP.detail) }).X; }
  function paintDetail() {
    const root = rootEl(); const d = IP.detail; if (!root || !d) return;
    const s = d.session || {}; const X = detailModel(); const rows = Array.isArray(d.students) ? d.students : [];
    const demo = !!(d.teacher && d.teacher.is_demo) || rows.some(r => r.is_demo);
    const missing = !d.teacher || rows.length < (Number(s.students_total) || 0);
    const genBtn = !inViewAs() && missing && s.status !== 'cancelled' ? `<button type="button" class="lc-btn lc-sm" data-lc="ins-generate" data-id="${E(s.id)}" data-title="${E(s.title || '')}" data-group="${E(s.group_name || '')}" data-reopen="1">✨ ${d.teacher ? '<span>Add missing students</span>' : '<span>Generate demo insights</span>'}</button>` : '';
    root.innerHTML = `<div class="lc-wrap ins-wrap ins-detail">
      <button type="button" class="lc-link" data-lc="ins-back">← <span>All insights</span></button>
      <header class="lc-head ins-detail-head"><div><h1 data-no-i18n>${E(s.title || s.group_name || tr('Class'))}</h1>
        <p class="lc-sub"><span data-no-i18n>${E(fDay(s.starts_at))} · ${E(fTime(s.starts_at))}</span>${s.group_name ? ` · <span data-no-i18n>${E(s.group_name)}</span>` : ''}${s.unit_name ? ` · <span data-no-i18n>${E(s.unit_name)}</span>` : ''}${s.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(s.teacher_name)}</span>` : ''}${s.duration_min ? ` · <span data-no-i18n>${Number(s.duration_min)} min</span>` : ''}</p></div>
        <div class="ins-head-actions">${demo ? V.demoChip() : ''}${genBtn}${canEdit() ? '' : `<span class="ins-ro"><span aria-hidden="true">👁</span> <span>${inViewAs() ? 'View as: read-only' : 'Read-only'}</span></span>`}</div></header>
      ${demo ? V.banner() : ''}
      <div class="lc-tabs" role="tablist" aria-label="${E(tr('Insights'))}">
        <button type="button" role="tab" class="lc-tab${IP.tab === 'report' ? ' active' : ''}" aria-selected="${IP.tab === 'report'}" data-lc="ins-tab" data-k="report" id="ins-tab-report">👩‍🏫 <span>Teacher report</span></button>
        <button type="button" role="tab" class="lc-tab${IP.tab === 'students' ? ' active' : ''}" aria-selected="${IP.tab === 'students'}" data-lc="ins-tab" data-k="students" id="ins-tab-students">🎒 <span>Students</span> <span class="lc-chip" data-no-i18n>${rows.length}</span></button>
      </div>
      <div class="lc-ins-body" role="tabpanel" id="ins-body">${IP.tab === 'students' ? studentsHtml(X) : reportHtml(X)}</div>
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
    const payload = V.buildDemoPayload({ title: meta && meta.title, group: meta && meta.group });
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
  async function loadMine() {
    const seq = ++IP.seq; const va = vaStudent();
    const { data, error } = await rpc('my_insights', va || {});
    if (seq !== IP.seq || IP.scope !== 'student' || IP.view !== 'list') return;
    IP.err = error || null; IP.mine = error ? null : (Array.isArray(data) ? data : []);
    paintMineList();
  }
  function paintMineList() {
    const root = rootEl(); if (!root) return;
    const list = IP.mine; const va = vaStudent();
    let body;
    if (IP.err) body = `<div class="lc-card ins-empty"><h2>We couldn't load your insights</h2><p>${E(errMsg(IP.err))}</p><button type="button" class="lc-btn" data-lc="ins-reload">Try again</button></div>`;
    else if (!list) body = '<div class="in-loading">Loading…</div>';
    else if (!list.length) body = `<div class="lc-card ins-empty" id="ins-empty">
        <div class="ins-empty-art" aria-hidden="true"><span>🗣️</span><span>📚</span><span>💬</span></div>
        <h2>Insights appear after your classes</h2>
        <p>${va && !va.p_enrollment ? 'Pick a student in View as to see their insights.' : 'After each class you’ll see a recap, your progress, feedback and a message from your teacher.'}</p></div>`;
    else body = `<ul class="ins-list" id="ins-list">${list.map(x => `<li><button type="button" class="ins-item" data-lc="ins-mine-open" data-id="${E(x.id)}">
        ${whenBox(x.starts_at)}
        <span class="ins-main"><span class="ins-title" data-no-i18n>${E(x.title || x.group_name || tr('Class'))}</span>
          <span class="ins-meta"><span data-no-i18n>${E(fDay(x.starts_at))}</span>${x.group_name ? ` · <span data-no-i18n>${E(x.group_name)}</span>` : ''}${x.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(x.teacher_name)}</span>` : ''}</span>
          ${x.summary ? `<span class="ins-summary" data-no-i18n>${E(x.summary)}</span>` : ''}</span>
        <span class="ins-chips">${x.is_demo ? V.demoChip() : ''}${x.has_message ? '<span class="lc-chip lc-chip-ok">💬 <span>Message from your teacher</span></span>' : ''}</span>
        <span class="ins-go" aria-hidden="true">›</span></button></li>`).join('')}</ul>`;
    root.innerHTML = `<div class="lc-wrap ins-wrap">
      <button type="button" class="lc-link" data-lc="ins-student-home">← <span>Back to my classes</span></button>
      <header class="lc-head"><div><h1><span aria-hidden="true">💡</span> <span>My insights</span></h1><p class="lc-sub">After each class: a recap, your progress, feedback and a message from your teacher.</p></div>${inViewAs() ? '<span class="ins-ro"><span aria-hidden="true">👁</span> <span>View as: read-only</span></span>' : ''}</header>
      ${list && list.some(x => x.is_demo) ? V.banner() : ''}
      ${body}
    </div>`;
  }
  async function openMine(id) {
    IP.view = 'mine-detail'; IP.mid = id; IP.mdetail = null; IP.sub = 'overview';
    const root = rootEl(); if (root) root.innerHTML = '<div class="lc-wrap"><div class="in-loading">Loading…</div></div>';
    const seq = ++IP.dseq; const va = vaStudent();
    const { data, error } = await rpc('my_insight', { p_id: id, p_enrollment: va ? va.p_enrollment : null });
    if (seq !== IP.dseq || IP.view !== 'mine-detail') return;
    if (error) { IP.view = 'list'; toast(errMsg(error), 'err'); paintMineList(); loadMine(); return; }
    IP.mdetail = data || {}; paintMineDetail();
  }
  function paintMineDetail() {
    const root = rootEl(); const d = IP.mdetail; if (!root || !d) return;
    const s = d.session || {}; const X = V.modelFromStudent(d);
    root.innerHTML = `<div class="lc-wrap ins-wrap ins-detail">
      <button type="button" class="lc-link" data-lc="ins-mine-back">← <span>My insights</span></button>
      <header class="lc-head ins-detail-head"><div><h1 data-no-i18n>${E(s.title || s.group_name || tr('Class'))}</h1>
        <p class="lc-sub"><span data-no-i18n>${E(fDay(s.starts_at))} · ${E(fTime(s.starts_at))}</span>${s.group_name ? ` · <span data-no-i18n>${E(s.group_name)}</span>` : ''}${s.teacher_name ? ` · <span>Teacher:</span> <span data-no-i18n>${E(s.teacher_name)}</span>` : ''}</p></div>
        <div class="ins-head-actions">${d.is_demo ? V.demoChip() : ''}</div></header>
      ${d.is_demo ? V.banner() : ''}
      <div class="lc-ins-body" id="ins-body">${V.studentTabsHtml(X, 0, IP.sub, { P: 'ins', picker: false, msg: { mode: 'student', published: d.message || '', publishedAt: d.published_at } })}</div>
    </div>`;
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
      case 'ins-back': IP.view = 'list'; IP.detail = null; paintList(); loadList(); break;
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
      case 'ins-mine-back': IP.view = 'list'; IP.mdetail = null; paintMineList(); loadMine(); break;
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
    'After each class: a recap, your progress, feedback and a message from your teacher.': 'Después de cada clase: un repaso, tu progreso, una devolución y un mensaje de tu docente.',
    'Demo insights can only be generated for today’s or past classes.': 'Los insights de demo se generan para clases de hoy o anteriores.',
    'A cancelled class has no insights.': 'Una clase cancelada no tiene insights.', 'Invalid demo data.': 'Datos de demo inválidos.',
    'This class has no insights yet.': 'Esta clase todavía no tiene insights.', 'Write a message before publishing it.': 'Escribí un mensaje antes de publicarlo.',
  });
})();
