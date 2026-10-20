/* TeroClass · Attendance (Asistencia)
 * ------------------------------------------------------------------------------------------
 *  · Automatic today: entering the live room of a calendar class ("Enter class" → lobby → Join) calls
 *    attendance_join; a heartbeat every minute (attendance_heartbeat) while in the room; attendance_leave on exit /
 *    tab close (a fetch with keepalive). Late = joined more than N minutes after the start (N per institution, default 10).
 *    Students without a record count as absent once the class has ended (computed by the database when reading).
 *  · Teacher / substitute: list in the class detail (name, status, minutes, note) with corrections (source "teacher",
 *    they win over the automatic status). Admins: the same list read-only.
 *  · Group report (teacher, substitute; admins read-only): % per student, present / late / absent / excused, a
 *    classes × students matrix, date range and CSV export (name, email as loaded by the institution, status per class).
 *  · Student: own summary on the dashboard ("Attended 9 of 10 classes"), never classmates.
 *  · Group card (admins): the group's classes → class document (read-only) and attendance.
 *  · LATER (real video + AI): LiveKit room events and AI participation go to the same table through
 *    attendance_record_external (service key only; see README "Attendance").
 * Privacy is enforced in the database (001_base.sql, "ASISTENCIA"); this file only shows what the RPCs return.
 * Depends on globals from index.html (sb, viewAs, esc, showToast, trText, uiLang, uiLocale, I18N_ES, I18N_RULES_ES,
 * DB_ERRORS, vaBlocked, SUPABASE_URL, SUPABASE_KEY) and on window.GC (modal) / window.TCClassDoc.
 */
(function () {
  'use strict';

  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const $ = id => document.getElementById(id);
  const MIN = 60000;
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;
  const blocked = () => (typeof vaBlocked === 'function' ? vaBlocked() : false);
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const fmt = (d, o) => { try { return new Date(d).toLocaleString(loc(), o); } catch (e) { return ''; } };
  const fTime = d => fmt(d, typeof uiLang !== 'undefined' && uiLang === 'es' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit' });
  const fDay = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const fShort = d => fmt(d, { day: 'numeric', month: 'numeric' });
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const STATUS = { present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused', pending: 'Not joined yet' };
  const DOT_ES = { present: '✓', late: 'T', absent: '✕', excused: 'J', pending: '·' }; const DOT_EN = { ...DOT_ES, late: 'L', excused: 'E' };
  const DOT = new Proxy({}, { get: (_, k) => (typeof uiLang !== 'undefined' && uiLang === 'es' ? DOT_ES : DOT_EN)[k] });
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    let d = data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep */ } }
    return { data: d, error };
  }
  const errToast = e => showToast('Error: ' + (e?.message || e || ''), 'err');
  const chip = s => `<span class="att-st ${esc(s)}">${esc(tr(STATUS[s] || s))}</span>`;
  const modal = (html, o) => window.GC?.modal?.(html, o);
  const closeModal = () => window.GC?.close?.();

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ONE CLASS: list + corrections (teacher / substitute), read-only for admins
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const SES = { box: null, sid: null, data: null, seq: 0, timer: null };
  async function loadSession(box, sid) {
    SES.box = box; SES.sid = sid; const my = ++SES.seq;
    if (!box) return;
    if (!SES.data || SES.data.session?.id !== sid) box.innerHTML = `<div class="in-loading">${esc(tr('Loading…'))}</div>`;
    const { data, error } = await rpc('session_attendance', { p_session: sid });
    if (my !== SES.seq || !box.isConnected) return;
    if (error || !data) { box.innerHTML = `<div class="pb-empty">${esc(tr('Could not load the attendance.'))}</div>`; return; }
    SES.data = data; renderSession();
    clearInterval(SES.timer);
    if (!data.ended) SES.timer = setInterval(() => { if (!SES.box?.isConnected || SES.sid !== sid) { clearInterval(SES.timer); return; } if (!SES.box.contains(document.activeElement)) loadSession(SES.box, sid); }, 20000);
  }
  function renderSession() {
    const d = SES.data; const box = SES.box; if (!d || !box) return;
    const edit = !!d.can_edit && !inViewAs(); const c = d.counts || {};
    const rows = (d.students || []).map(s => {
      const auto = s.auto_status || (d.ended ? 'absent' : 'pending');
      const sel = edit ? `<select class="att-sel" data-att="set" data-e="${esc(s.enrollment_id)}" aria-label="${esc(tr('Attendance of'))} ${esc(s.name)}">
          <option value=""${s.override ? '' : ' selected'}>${esc(tr('Automatic status'))}: ${esc(tr(STATUS[auto]))}</option>
          ${['present', 'late', 'absent', 'excused'].map(k => `<option value="${k}"${s.override === k ? ' selected' : ''}>${esc(tr(STATUS[k]))}</option>`).join('')}</select>` : chip(s.status);
      return `<li class="att-row" data-e="${esc(s.enrollment_id)}">
        <span class="att-who"><b data-no-i18n>${esc(s.name)}</b><span class="att-mail" data-no-i18n>${esc(s.email || '')}</span></span>
        <span class="att-min">${s.in_room ? `<span class="att-in" title="${esc(tr('In the room now'))}">●</span> ` : ''}<span data-no-i18n>${Number(s.minutes) || 0}</span> <span>min</span>${s.first_join ? ` · <span data-no-i18n>${esc(fTime(s.first_join))}</span>` : ''}${s.source === 'teacher' ? ` · <span class="att-src">${esc(tr('corrected'))}</span>` : ''}</span>
        ${edit ? sel : chip(s.status)}
        ${edit ? `<span class="att-note"><input type="text" maxlength="500" data-att="note" data-e="${esc(s.enrollment_id)}" value="${esc(s.note || '')}" placeholder="${esc(tr('Note (optional)'))}" aria-label="${esc(tr('Note'))}" data-no-i18n></span>`
          : (s.note ? `<span class="att-note-ro" data-no-i18n>${esc(s.note)}</span>` : '')}
      </li>`;
    }).join('');
    const counts = ['present', 'late', 'absent', 'excused', 'pending'].filter(k => c[k]).map(k => `<span class="att-st ${k}" data-no-i18n>${esc(tr(STATUS[k]))}: <b>${c[k]}</b></span>`).join('');
    box.innerHTML = `<div class="att-box">
      <div class="att-head"><span class="att-counts">${counts || `<span class="gc-muted">${esc(tr('No students yet.'))}</span>`}</span>
        <button type="button" class="tree-btn" data-att="refresh" aria-label="${esc(tr('Refresh'))}">↻</button></div>
      ${rows ? `<ul class="att-list">${rows}</ul>` : ''}
    </div>
    <div class="gc-hint">${d.ended ? '' : `<span>${esc(tr('Students appear as present when they enter the room.'))}</span> `}<span>${esc(tr('Late = joined more than'))}</span> <b data-no-i18n>${Number(d.late_minutes) || 10}</b> <span>${esc(tr('min after the start.'))}</span>${edit ? ` <span>${esc(tr('Your corrections win over the automatic status.'))}</span>` : ` <span>${esc(tr('Read-only.'))}</span>`}</div>`;
  }
  async function setStatus(el) {
    if (blocked()) { renderSession(); return; }
    const e = el.dataset.e; const row = (SES.data?.students || []).find(s => s.enrollment_id === e); if (!row) return;
    const status = el.dataset.att === 'set' ? (el.value || null) : (row.override || null);
    const note = el.dataset.att === 'note' ? el.value : null;
    el.disabled = true;
    const { data, error } = await rpc('set_attendance', { p_session: SES.sid, p_enrollment: e, p_status: status, p_note: note });
    el.disabled = false;
    if (error) { errToast(error); renderSession(); return; }
    showToast(el.dataset.att === 'note' ? 'Note saved ✓' : 'Attendance updated ✓', 'ok');
    Object.assign(row, { override: data?.override || null, status: data?.status || row.status, source: data?.source || row.source, note: data?.note ?? row.note });
    loadSession(SES.box, SES.sid);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // GROUP REPORT
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const REP = { group: null, from: null, to: null, data: null, back: null };
  async function openReport(groupId, opts = {}) {
    if (!groupId) return;
    REP.group = groupId; REP.back = opts.back || null;
    if (!REP.from || opts.reset !== false) { const t = new Date(); REP.to = ymd(t); REP.from = ymd(addDays(t, -89)); }
    modal(`<div class="modal-title" id="gc-modal-title">${esc(tr('Attendance'))}</div><div class="in-loading">${esc(tr('Loading…'))}</div>`, { wide: true });
    await loadReport();
  }
  async function loadReport() {
    const { data, error } = await rpc('attendance_report', { p_group: REP.group, p_from: REP.from, p_to: REP.to });
    if (error) { errToast(error); return; }
    REP.data = data; renderReport();
  }
  function renderReport() {
    const d = REP.data || {}; const ses = d.sessions || []; const st = d.students || []; const t = d.totals || {};
    const head = ses.map(s => `<th title="${esc(s.title)} · ${esc(fDay(s.starts_at))} ${esc(fTime(s.starts_at))}" data-no-i18n>${esc(fShort(s.starts_at))}</th>`).join('');
    const body = st.map(s => `<tr>
        <td class="att-name"><span data-no-i18n>${esc(s.name)}</span><small data-no-i18n>${esc(s.email || '')}</small>${s.member ? '' : ` <span class="gc-chip">${esc(tr('Not in the group anymore'))}</span>`}</td>
        <td class="att-pct">${s.pct == null ? '—' : `<b data-no-i18n>${s.pct}%</b><span class="att-bar"><i style="width:${Math.max(0, Math.min(100, Number(s.pct) || 0))}%"></i></span>`}</td>
        <td data-no-i18n>${s.present}</td><td data-no-i18n>${s.late}</td><td data-no-i18n>${s.absent}</td><td data-no-i18n>${s.excused}</td>
        ${(s.cells || []).map((c, i) => `<td>${c.s ? `<span class="att-dot ${esc(c.s)}" title="${esc(tr(STATUS[c.s] || c.s))}${c.src === 'teacher' ? ' · ' + esc(tr('corrected')) : ''} · ${esc(ses[i]?.title || '')}" data-no-i18n>${DOT[c.s] || ''}</span>` : `<span class="att-dot none" title="${esc(tr('Not in the group yet'))}" data-no-i18n>–</span>`}</td>`).join('')}
      </tr>`).join('');
    const back = REP.back ? `<button type="button" class="btn-modal-cancel" data-att="rep-back">${esc(tr('← Back'))}</button>` : '';
    modal(`<div class="modal-title" id="gc-modal-title"><span>${esc(tr('Attendance'))}</span> · <span data-no-i18n>${esc(d.group?.name || '')}</span></div>
      <div class="modal-sub"><span data-no-i18n>${esc(d.group?.unit_name || '')}</span> · ${d.can_edit && !inViewAs() ? `<span>${esc(tr('To correct a status, open the class in the Calendar.'))}</span>` : `<span>${esc(tr('Read-only.'))}</span>`}</div>
      <div class="att-rep-tools">
        <label><span>${esc(tr('From'))}</span><input type="date" id="att-from" value="${esc(REP.from)}"></label>
        <label><span>${esc(tr('Until'))}</span><input type="date" id="att-to" value="${esc(REP.to)}"></label>
        <button type="button" class="tree-btn" data-att="rep-apply">${esc(tr('Apply'))}</button>
        <button type="button" class="tree-btn" data-att="rep-range" data-days="30">${esc(tr('Last 30 days'))}</button>
        <button type="button" class="tree-btn" data-att="rep-range" data-days="90">${esc(tr('Last 90 days'))}</button>
        <button type="button" class="tree-btn primary" data-att="rep-csv"${st.length && ses.length ? '' : ' disabled'}>⬇ <span>${esc(tr('Export CSV'))}</span></button>
      </div>
      <div class="att-sum">
        <div class="att-tile"><b data-no-i18n>${ses.length}</b><span>${esc(tr('Classes held'))}</span></div>
        <div class="att-tile"><b data-no-i18n>${t.rate == null ? '—' : t.rate + '%'}</b><span>${esc(tr('Group attendance'))}</span></div>
        <div class="att-tile"><b data-no-i18n>${t.present || 0}</b><span>${esc(tr('Present'))}</span></div>
        <div class="att-tile"><b data-no-i18n>${t.late || 0}</b><span>${esc(tr('Late'))}</span></div>
        <div class="att-tile"><b data-no-i18n>${t.absent || 0}</b><span>${esc(tr('Absent'))}</span></div>
        <div class="att-tile"><b data-no-i18n>${t.excused || 0}</b><span>${esc(tr('Excused'))}</span></div>
      </div>
      ${st.length && ses.length ? `<div class="att-table-wrap"><table class="att-table"><thead><tr><th class="att-name">${esc(tr('Student'))}</th><th>%</th>${(uiLang === 'es' ? ['P', 'T', 'A', 'J'] : ['P', 'L', 'A', 'E']).map((l, i) => `<th title="${esc(tr(STATUS[['present', 'late', 'absent', 'excused'][i]]))}" data-no-i18n>${l}</th>`).join('')}${head}</tr></thead><tbody>${body}</tbody></table></div>
        <div class="att-legend">${['present', 'late', 'absent', 'excused', 'pending'].map(k => `<span><span class="att-dot ${k}" data-no-i18n>${DOT[k]}</span> ${esc(tr(STATUS[k]))}</span>`).join('')}<span><span class="att-dot none" data-no-i18n>–</span> ${esc(tr('Not in the group yet'))}</span></div>
        <div class="gc-hint">${esc(tr('% = present + late over the classes counted (excused and classes in progress are not counted).'))} <span>${esc(tr('Late = joined more than'))}</span> <b data-no-i18n>${Number(d.late_minutes) || 10}</b> <span>${esc(tr('min after the start.'))}</span></div>`
        : `<div class="bl-empty">${esc(tr(ses.length ? 'This group has no students.' : 'No classes held in this period.'))}</div>`}
      <div class="modal-actions">${back}<button type="button" class="btn-modal-cancel" data-gc="close">${esc(tr('Close'))}</button></div>`, { wide: true });
  }
  function reportCsv() {
    const d = REP.data || {}; const es = typeof uiLang !== 'undefined' && uiLang === 'es'; const sep = es ? ';' : ',';
    const q = v => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + (/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
    const W = k => tr(STATUS[k] || k);
    const head = [tr('Name'), tr('Email'), ...(d.sessions || []).map(s => `${ymd(new Date(s.starts_at))} ${fTime(s.starts_at)} ${s.title}`), tr('Present'), tr('Late'), tr('Absent'), tr('Excused'), '%'];
    const rows = (d.students || []).map(s => [s.name, s.email || '', ...(s.cells || []).map(c => (c.s ? W(c.s) : '')), s.present, s.late, s.absent, s.excused, s.pct == null ? '' : s.pct]);
    const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(sep)).join('\r\n') + '\r\n';
    const name = (es ? 'asistencia-' : 'attendance-') + String(d.group?.name || 'grupo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + `-${d.from}-${d.to}.csv`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // GROUP CARD (admins; teachers too): the group's classes → document + attendance
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const GS = { group: null, data: null };
  async function openGroupSessions(groupId) {
    GS.group = groupId;
    modal(`<div class="modal-title" id="gc-modal-title">${esc(tr('Classes and documents'))}</div><div class="in-loading">${esc(tr('Loading…'))}</div>`, { wide: true });
    const { data, error } = await rpc('group_sessions', { p_group: groupId, p_past_days: 90, p_future_days: 30 });
    if (error) { errToast(error); closeModal(); return; }
    GS.data = data; renderGroupSessions();
  }
  function renderGroupSessions() {
    const d = GS.data || {}; const now = Date.now(); const edit = !!d.can_edit && !inViewAs();
    const all = d.sessions || [];
    const item = s => {
      const started = Date.parse(s.starts_at) - 10 * MIN <= now; const docOk = s.has_doc || edit;
      return `<li class="gcs-item${s.status === 'cancelled' ? ' cancelled' : ''}">
        <span class="gcs-when" data-no-i18n>${esc(fDay(s.starts_at))} · ${esc(fTime(s.starts_at))}</span>
        <span class="gcs-main"><b data-no-i18n>${esc(s.title)}</b><span>${s.status === 'cancelled' ? '<span class="gc-chip cancelled">Cancelled</span> ' : ''}${s.has_doc ? `<span class="gc-chip ok">📄 ${esc(tr('Document'))}</span>` : `<span class="gc-chip">${esc(tr('No document yet'))}</span>`} ${s.doc_locked ? `<span class="gc-chip warn">🔒 ${esc(tr('Locked'))}</span>` : ''}</span></span>
        <span class="gcs-act"><button type="button" class="tree-btn" data-att="gs-doc" data-id="${esc(s.id)}"${docOk ? '' : ' disabled'}>📄 <span>${esc(tr(edit ? 'Open document' : 'Read document'))}</span></button>
          ${started && s.status !== 'cancelled' ? `<button type="button" class="tree-btn" data-att="gs-att" data-id="${esc(s.id)}">✅ <span>${esc(tr('Attendance'))}</span></button>` : ''}</span>
      </li>`;
    };
    const past = all.filter(s => Date.parse(s.starts_at) <= now); const next = all.filter(s => Date.parse(s.starts_at) > now).reverse();
    modal(`<div class="modal-title" id="gc-modal-title"><span>${esc(tr('Classes and documents'))}</span> · <span data-no-i18n>${esc(d.group?.name || '')}</span></div>
      <div class="modal-sub">${edit ? esc(tr('The shared document of each class and its attendance.')) : esc(tr('Read-only: the shared document of each class (it stays as a record) and its attendance.'))}</div>
      <div class="gc-btn-row" style="margin-bottom:10px"><button type="button" class="tree-btn primary" data-att="gs-report">📊 <span>${esc(tr('Attendance report'))}</span></button></div>
      ${past.length ? `<div class="gc-sec-title">${esc(tr('Past classes'))}</div><ul class="gcs-list">${past.map(item).join('')}</ul>` : ''}
      ${next.length ? `<div class="gc-sec-title">${esc(tr('Next classes'))}</div><ul class="gcs-list">${next.slice(0, 10).map(item).join('')}</ul>` : ''}
      ${all.length ? '' : `<div class="bl-empty">${esc(tr('No classes in the last 90 days or the next 30.'))}</div>`}
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">${esc(tr('Close'))}</button></div>`, { wide: true });
  }
  function openSessionAttendance(sid) {
    const s = (GS.data?.sessions || []).find(x => x.id === sid);
    modal(`<div class="modal-title" id="gc-modal-title"><span>${esc(tr('Attendance'))}</span> · <span data-no-i18n>${esc(s?.title || '')}</span></div>
      <div class="modal-sub" data-no-i18n>${s ? esc(fDay(s.starts_at)) + ' · ' + esc(fTime(s.starts_at)) : ''}</div>
      <div id="att-session-box"></div>
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-att="gs-back">${esc(tr('← Back'))}</button><button type="button" class="btn-modal-cancel" data-gc="close">${esc(tr('Close'))}</button></div>`, { wide: true });
    loadSession($('att-session-box'), sid);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STUDENT DASHBOARD
  // ════════════════════════════════════════════════════════════════════════════════════════════
  function studentCardHtml(a) {
    if (!a || !Number(a.held)) return `<div class="gs-ins-empty"><div class="gs-ins-title">${esc(tr('Your attendance will appear here after your first classes.'))}</div><p class="gc-sub">${esc(tr('You are marked present when you enter the class room.'))}</p></div>`;
    const groups = (a.groups || []).filter(g => g.name);
    return `<div class="gs-att-big"><span>${esc(tr('Attended'))}</span> <b data-no-i18n>${Number(a.attended) || 0}</b> <span>${esc(tr('of'))}</span> <b data-no-i18n>${Number(a.held) || 0}</b> <span>${esc(tr(Number(a.held) === 1 ? 'class' : 'classes'))}</span></div>
      <div class="gc-chips">${['present', 'late', 'absent', 'excused'].filter(k => Number(a[k])).map(k => `<span class="att-st ${k}" data-no-i18n>${esc(tr(STATUS[k]))}: <b>${Number(a[k])}</b></span>`).join('')}</div>
      ${groups.length > 1 ? `<div class="gs-att-groups">${groups.map(g => { const p = g.held ? Math.round(100 * g.attended / g.held) : 0; return `<div class="gs-att-g"><b data-no-i18n>${esc(g.name)}</b><span data-no-i18n>${Number(g.attended)}/${Number(g.held)}</span><span class="att-bar"><i style="width:${p}%"></i></span></div>`; }).join('')}</div>` : ''}`;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE ROOM: join / heartbeat / leave (public/live-class.js calls these for calendar classes)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const ROOM = { sid: null, timer: null, token: '', status: null };
  async function refreshToken() { try { const { data } = await sb.auth.getSession(); ROOM.token = data?.session?.access_token || ROOM.token; } catch (e) { /* keep */ } }
  async function roomJoin(sid) {
    if (!sid || inViewAs()) return null;
    if (ROOM.sid && ROOM.sid !== sid) roomLeave();
    ROOM.sid = sid; refreshToken();
    const { data, error } = await rpc('attendance_join', { p_session: sid });
    if (error) { ROOM.status = null; if (ROOM.sid === sid) { ROOM.sid = null; } return null; } // outside the window / not in the class: nothing recorded
    ROOM.status = data?.status || null;
    clearInterval(ROOM.timer);
    ROOM.timer = setInterval(() => { if (!ROOM.sid) { clearInterval(ROOM.timer); return; } refreshToken(); rpc('attendance_heartbeat', { p_session: ROOM.sid }); }, 60000);
    return data;
  }
  function roomLeave(onUnload) {
    const sid = ROOM.sid; if (!sid) return;
    ROOM.sid = null; clearInterval(ROOM.timer); ROOM.timer = null;
    if (onUnload && typeof SUPABASE_URL !== 'undefined' && ROOM.token) {
      try { fetch(SUPABASE_URL + '/rest/v1/rpc/attendance_leave', { method: 'POST', keepalive: true, headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + ROOM.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_session: sid }) }); } catch (e) { /* the last heartbeat counts as the exit */ }
    } else rpc('attendance_leave', { p_session: sid });
  }
  window.addEventListener('pagehide', () => roomLeave(true));

  // ── events ──
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-att]'); if (!el) return;
    switch (el.dataset.att) {
      case 'refresh': if (SES.box && SES.sid) loadSession(SES.box, SES.sid); break;
      case 'rep-apply': { const f = $('att-from')?.value; const t = $('att-to')?.value; if (!f || !t || f > t) { showToast('Invalid date range.', 'err'); break; } REP.from = f; REP.to = t; loadReport(); break; }
      case 'rep-range': { const t = new Date(); REP.to = ymd(t); REP.from = ymd(addDays(t, -(Number(el.dataset.days) || 30) + 1)); loadReport(); break; }
      case 'rep-csv': reportCsv(); break;
      case 'rep-back': if (typeof REP.back === 'function') REP.back(); break;
      case 'gs-report': openReport(GS.group, { back: () => openGroupSessions(GS.group) }); break;
      case 'gs-doc': if (window.TCClassDoc) window.TCClassDoc.open(el.dataset.id); break;
      case 'gs-att': openSessionAttendance(el.dataset.id); break;
      case 'gs-back': renderGroupSessions(); break;
    }
  });
  document.addEventListener('change', e => { const el = e.target; if (el?.dataset?.att === 'set' || el?.dataset?.att === 'note') setStatus(el); });

  window.TCAttendance = { loadSession, openReport, openGroupSessions, studentCardHtml, roomJoin, roomLeave, get room() { return { ...ROOM, token: undefined }; }, _test: { REP, SES, GS } };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/La clase no está abierta ahora/, 'The class is not open right now.'], [/La clase está cancelada/, 'The class is cancelled.'],
    [/Estado de asistencia inválido/, 'Invalid attendance status.'], [/Ese estudiante no es de esta clase/, 'That student is not in this class.'],
    [/Minutos inválidos \(de 0 a 120\)/, 'Invalid minutes (0 to 120).']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Present': 'Presente', 'Late': 'Tarde', 'Absent': 'Ausente', 'Excused': 'Justificado', 'Not joined yet': 'Todavía no entró', 'Automatic status': 'Automático',
    'Attendance': 'Asistencia', 'Attendance of': 'Asistencia de', 'Could not load the attendance.': 'No se pudo cargar la asistencia.', 'In the room now': 'En la sala ahora',
    'corrected': 'corregido', 'Note (optional)': 'Nota (opcional)', 'PH:Note (optional)': 'Nota (opcional)', 'Note': 'Nota', 'Refresh': 'Actualizar', 'No students yet.': 'Todavía no hay estudiantes.',
    'Students appear as present when they enter the room.': 'Los estudiantes quedan presentes cuando entran a la sala.', 'Late = joined more than': 'Tarde = entró más de',
    'min after the start.': 'min después del inicio.', 'Your corrections win over the automatic status.': 'Tus correcciones ganan sobre el estado automático.', 'Read-only.': 'Solo lectura.',
    'Note saved ✓': 'Nota guardada ✓', 'Attendance updated ✓': 'Asistencia actualizada ✓', 'Not in the group anymore': 'Ya no está en el grupo',
    'Not in the group yet': 'Todavía no estaba en el grupo', '← Back': '← Volver', 'To correct a status, open the class in the Calendar.': 'Para corregir un estado, abrí la clase en el Calendario.',
    'From': 'Desde', 'Until': 'Hasta', 'Apply': 'Aplicar', 'Last 30 days': 'Últimos 30 días', 'Last 90 days': 'Últimos 90 días', 'Export CSV': 'Exportar CSV',
    'Classes held': 'Clases dadas', 'Group attendance': 'Asistencia del grupo', 'Student': 'Estudiante',
    '% = present + late over the classes counted (excused and classes in progress are not counted).': '% = presentes + tarde sobre las clases contadas (las justificadas y las clases en curso no cuentan).',
    'This group has no students.': 'Este grupo no tiene estudiantes.', 'No classes held in this period.': 'No hubo clases en este período.', 'Close': 'Cerrar', 'Loading…': 'Cargando…',
    'Name': 'Nombre', 'Email': 'Email', 'Classes and documents': 'Clases y documentos', 'Document': 'Documento', 'No document yet': 'Todavía sin documento', 'Locked': 'Bloqueado',
    'Open document': 'Abrir documento', 'Read document': 'Leer documento', 'The shared document of each class and its attendance.': 'El documento compartido de cada clase y su asistencia.',
    'Read-only: the shared document of each class (it stays as a record) and its attendance.': 'Solo lectura: el documento compartido de cada clase (queda como registro) y su asistencia.',
    'Attendance report': 'Informe de asistencia', 'Past classes': 'Clases pasadas', 'Next classes': 'Próximas clases', 'No classes in the last 90 days or the next 30.': 'No hay clases en los últimos 90 días ni en los próximos 30.',
    'Your attendance will appear here after your first classes.': 'Tu asistencia va a aparecer acá después de tus primeras clases.',
    'You are marked present when you enter the class room.': 'Quedás presente cuando entrás a la sala de la clase.', 'Attended': 'Asististe a', 'of': 'de', 'class': 'clase', 'classes': 'clases',
    'Invalid date range.': 'Rango de fechas inválido.', 'The class is not open right now.': 'La clase no está abierta ahora.', 'The class is cancelled.': 'La clase está cancelada.',
    'Invalid attendance status.': 'Estado de asistencia inválido.', 'That student is not in this class.': 'Ese estudiante no es de esta clase.', 'Invalid minutes (0 to 120).': 'Minutos inválidos (de 0 a 120).',
    'My attendance': 'Mi asistencia', 'Class documents': 'Documentos de clase', 'Open class document': 'Abrir documento de la clase',
    'The shared document of each class stays here as a record.': 'El documento compartido de cada clase queda acá como registro.', 'No class documents yet.': 'Todavía no hay documentos de clase.',
    'Group attendance report': 'Informe de asistencia del grupo', 'Attendance is recorded when students enter the room.': 'La asistencia se registra cuando los estudiantes entran a la sala.',
    'Everyone in the class can write in it at the same time; it stays as a record.': 'Todos en la clase pueden escribir a la vez; queda como registro.', 'Open': 'Abrir',
    'Students': 'Estudiantes', 'Classes & documents': 'Clases y documentos',
  });
})();
