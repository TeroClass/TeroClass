/* TeroClass · Groups + Students + Calendar
 * ------------------------------------------------------------------------------------------
 *  · Institution admins: "Groups" panel (Institution group of the sidebar) for the unit chosen in the
 *    switcher and everything below it: groups (1 teacher + optional substitute), students (manual or CSV
 *    import with preview), move / remove, reassign teachers, read-only calendar of the unit, and
 *    "Consents" (recording consent of each person + the justifications of the ones who said no; filters, CSV;
 *    a badge on the Groups nav counts new justifications: consent_overview / consent_new_declines).
 *  · Teachers / substitutes: "Calendar" panel (Teaching group): week view + agenda (mobile), weekly series
 *    and one-off classes (for a group or ad hoc by email), edit / cancel one class or the whole series,
 *    "Join" → the live class demo (public/live-class.js) for that session.
 *  · Students (role "student", magic link by email): ONLY their dashboard — Calendar, Enter class, My insights
 *    (the full "My insights" screen is public/insights-panel.js).
 *  · Every class: "Add to Google Calendar" + .ics; personal subscription feed (/cal/<token>.ics);
 *    email notifications through /api/notify/session (no-op until RESEND_API_KEY exists → copy link).
 *  · View as → Student (super admin, read-only).
 *  · Class document per session (public/class-doc.js: "Open class document" in the detail, the student dashboard and
 *    the group card) and attendance (public/attendance.js: list in the detail, group report, student summary).
 * Privacy is enforced in the database (supabase/migrations/001_base.sql, "GRUPOS, ESTUDIANTES Y CALENDARIO");
 * this file only shows what the RPCs return. All user data is escaped with esc().
 * Depends on globals from index.html: sb, currentUser, currentOrgId, orgsCache, viewAs, esc, showToast, trText,
 * uiLang, uiLocale, I18N_ES, I18N_RULES_ES, DB_ERRORS, hierSubtreeIds, hierPath, showPanel, closeModal,
 * vaBlocked, VA_PICK, enterViewAs, switchTab, showAuthError, authErrorText, normTxt.
 */
(function () {
  'use strict';

  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const $ = id => document.getElementById(id);
  const MIN = 60000;
  const JOIN_EARLY = 10 * MIN;
  const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,190}\.[A-Za-z]{2,24}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  const TZ_LIST = ['America/Montevideo', 'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/Santiago', 'America/Asuncion',
    'America/La_Paz', 'America/Lima', 'America/Bogota', 'America/Caracas', 'America/Mexico_City', 'America/New_York', 'America/Los_Angeles',
    'Europe/Madrid', 'Europe/Lisbon', 'Europe/London', 'Europe/Paris', 'UTC'];
  const isNarrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    let d = data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep */ } }
    return { data: d, error };
  }
  const errToast = e => showToast('Error: ' + (e?.message || e || ''), 'err');
  const blocked = () => (typeof vaBlocked === 'function' ? vaBlocked() : false);

  // ── dates & time zones ─────────────────────────────────────────────────────────────────────
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const fmt = (d, o) => { try { return new Date(d).toLocaleString(loc(), o); } catch (e) { return ''; } };
  // Spanish (Uruguay): 24-hour clock; English: 2:00 PM
  const fTime = d => { try { return new Date(d).toLocaleTimeString(loc(), uiLang === 'es' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const fDay = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const fDayLong = d => fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  function tzOffset(tz, d = new Date()) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || ''; } catch (e) { return ''; }
  }
  const tzLabel = (tz = LOCAL_TZ) => { const o = tzOffset(tz); return String(tz).replace(/_/g, ' ') + (o ? ` (${o})` : ''); };
  const hmInTz = (d, tz) => { try { const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(d)); return `${p.find(x => x.type === 'hour').value}:${p.find(x => x.type === 'minute').value}`; } catch (e) { return hm(new Date(d)); } };
  const timeInTz = (d, tz) => { try { return new Date(d).toLocaleTimeString(loc(), uiLang === 'es' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz } : { hour: 'numeric', minute: '2-digit', timeZone: tz }); } catch (e) { return ''; } };
  function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const endOfToday = () => { const x = new Date(); x.setHours(23, 59, 59, 999); return x.getTime(); };
  function localDateTime(dateStr, timeStr) {   // "2026-10-20" + "18:00" in the viewer's time zone → Date
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || ''); const t = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
    if (!m || !t) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function dayWord(d) {
    const now = new Date();
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, addDays(now, 1))) return 'Tomorrow';
    return null;
  }
  const dayHtml = d => { const w = dayWord(new Date(d)); return w ? `<span>${w}</span>` : `<span data-no-i18n>${esc(fDay(d))}</span>`; };
  const rangeHtml = s => `<span data-no-i18n>${esc(fTime(s.starts_at))} – ${esc(fTime(s.ends_at))}</span>`;

  // Join window: from 10 minutes before the start until the end
  function joinState(s, now = Date.now()) {
    const a = Date.parse(s.starts_at); const b = Date.parse(s.ends_at);
    if (s.status === 'cancelled') return { k: 'cancelled' };
    if (now >= b) return { k: 'ended' };
    if (now >= a - JOIN_EARLY) return { k: 'open', live: now >= a };
    return { k: 'soon', ms: a - now };
  }
  function startsIn(ms) {
    const m = Math.max(1, Math.ceil(ms / MIN));
    if (m < 60) return `Starts in ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `Starts in ${h} h ${m % 60} min` : `Starts in ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'Starts in 1 day' : `Starts in ${d} days`;
  }
  // Teacher / substitute / whoever created a one-off class: can ALWAYS open the room of a class that is not
  // cancelled (to prepare or test). Students (and admins looking at the unit): only inside the join window.
  const isStaffRow = s => !!s && (s.role === 'teacher' || s.role === 'substitute');
  // "Opens at 06:50" (today) or "Opens Mon 20 Oct at 06:50"
  function opensAt(s) {
    const at = new Date(Date.parse(s.starts_at) - JOIN_EARLY);
    return sameDay(at, new Date()) ? `Opens at ${fTime(at)}` : `Opens ${fDay(at)} at ${fTime(at)}`;
  }
  function joinButtonHtml(s, { big = false, compact = false } = {}) {
    const j = joinState(s);
    const cls = 'gc-join' + (big ? ' big' : '') + (compact ? ' compact' : '');
    if (j.k === 'cancelled') return `<span class="gc-chip cancelled">Cancelled</span>`;
    if (isStaffRow(s)) {
      const btn = `<button type="button" class="${cls} staff" data-gc="join" data-id="${esc(s.id)}">▶ <span>Enter room</span></button>`;
      return compact || j.k === 'open' ? btn : `<span class="gc-join-wrap">${btn}<span class="gc-join-note">Students can join from 10 min before</span></span>`;
    }
    if (j.k === 'open') return `<button type="button" class="${cls}" data-gc="join" data-id="${esc(s.id)}">▶ <span>Join class</span></button>`;
    if (j.k === 'soon') return `<button type="button" class="${cls}" disabled aria-disabled="true" data-opens="1"><span data-no-i18n>${esc(tr(opensAt(s)))}</span></button>`;
    return `<span class="gc-chip">Ended</span>`;
  }

  // ── calendar files (same rules as api/_lib/ics.js) ─────────────────────────────────────────
  const enc = new TextEncoder();
  const icsEsc = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  const icsDate = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  function icsFold(line) {
    if (enc.encode(line).length <= 75) return line;
    const out = []; let cur = ''; let len = 0;
    for (const ch of line) { const n = enc.encode(ch).length; if (len + n > 75) { out.push(cur); cur = ' '; len = 1; } cur += ch; len += n; }
    out.push(cur); return out.join('\r\n');
  }
  const joinUrl = id => `${location.origin}/?session=${encodeURIComponent(id)}`;
  const sTitle = s => s.title || s.group_name || tr('Class');
  function sessionIcs(s) {
    const desc = [s.group_name ? `${tr('Group')}: ${s.group_name}` : '', s.teacher_name ? `${tr('Teacher')}: ${s.teacher_name}` : '', `${tr('Join')}: ${joinUrl(s.id)}`].filter(Boolean).join('\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeroClass//Calendar 1.0//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${s.id}@teroclass.com`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(s.starts_at)}`, `DTEND:${icsDate(s.ends_at)}`,
      `SEQUENCE:${Number(s.seq) || 0}`, `SUMMARY:${icsEsc(sTitle(s))}`, `DESCRIPTION:${icsEsc(desc)}`, `URL:${joinUrl(s.id)}`,
      `STATUS:${s.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR'];
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }
  function googleUrl(s) {
    const details = [s.group_name ? `${tr('Group')}: ${s.group_name}` : '', `${tr('Join')}: ${joinUrl(s.id)}`].filter(Boolean).join('\n');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(sTitle(s))}&dates=${icsDate(s.starts_at)}/${icsDate(s.ends_at)}`
      + `&details=${encodeURIComponent(details)}&location=${encodeURIComponent(joinUrl(s.id))}`;
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove(); return ok;
    }
  }
  function invitationText(s) {
    const when = `${fDayLong(s.starts_at)} · ${fTime(s.starts_at)}–${fTime(s.ends_at)} (${tzLabel()})`;
    return `${sTitle(s)}\n${when}\n${tr('Sign in with your email (no password) to see your classes and join:')} ${location.origin}/?student`;
  }

  // ── dialogs ────────────────────────────────────────────────────────────────────────────────
  function modal(html, { wide = false } = {}) {
    const box = $('gc-modal-box'); if (!box) return;
    box.className = 'modal gc-modal' + (wide ? ' wide' : '');
    box.innerHTML = html;
    $('modal-gc').classList.add('active');
    setTimeout(() => (box.querySelector('[data-autofocus]') || box.querySelector('input:not([type=hidden]),select,textarea,button'))?.focus(), 30);
  }
  const closeGc = () => { if (typeof closeModal === 'function') closeModal('modal-gc'); };
  const confirms = {};
  function twoClick(key, btn, confirmLabel) {
    if (confirms[key]) { clearTimeout(confirms[key].t); delete confirms[key]; return true; }
    const prev = btn.innerHTML;
    btn.classList.add('confirm'); btn.innerHTML = `<span>${esc(confirmLabel)}</span>`;
    confirms[key] = { t: setTimeout(() => { delete confirms[key]; btn.classList.remove('confirm'); btn.innerHTML = prev; }, 4000) };
    return false;
  }
  const busy = (btn, on) => { if (btn) { btn.disabled = !!on; btn.classList.toggle('busy', !!on); } };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STUDENT SIGN-IN (magic link, no password)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  async function handleStudentLink() {
    const input = $('student-email'); const btn = $('btn-student-link'); const sent = $('student-sent');
    const email = (input?.value || '').trim();
    if (!EMAIL_RE.test(email)) { showAuthError('Write a valid email.'); input?.focus(); return; }
    if (window.tcCaptcha && window.tcCaptcha.missing()) return; // TC-18: optional Turnstile (only with a site key)
    busy(btn, true);
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + '/', shouldCreateUser: true, data: { via: 'student_link' }, ...(window.tcCaptcha ? window.tcCaptcha.options() : {}) },
    });
    busy(btn, false); window.tcCaptcha?.reset();
    if (error) {
      const m = String(error.message || '');
      if (error.status === 429 || /rate limit|too many|security purposes|seconds/i.test(m)) showAuthError('Too many emails were requested. Wait a minute and try again.');
      else showAuthError(typeof authErrorText === 'function' ? authErrorText(error) : m);
      return;
    }
    const ae = $('auth-error'); if (ae) ae.style.display = 'none';
    sent.innerHTML = `<span aria-hidden="true">📬</span> <span>Check your inbox:</span> <b data-no-i18n>${esc(email)}</b><br><span>Open the link on this device to see your classes. It can take a minute; check spam too.</span>`;
    sent.style.display = 'block';
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ENTER / STUDENT MODE
  // ════════════════════════════════════════════════════════════════════════════════════════════
  let studentMode = false;
  const ST = { data: null, error: null, seq: 0, timer: null, loadedAt: 0, token: null };
  const isStudentMode = () => studentMode;

  async function onEnter() {
    if (!currentUser) return false;
    // Link enrollments loaded with my verified email (the database only links when this session was opened
    // from an email link; it never changes the role).
    try { await rpc('claim_enrollments'); } catch (e) { /* older database: ignore */ }
    if (!currentUser) return false;
    if (currentUser.isStudent) { await enterStudentMode(); return true; }
    leaveStudentMode();
    return false;
  }
  async function enterStudentMode() {
    studentMode = true; ST.data = null; ST.error = null; ST.token = null;
    document.body.classList.add('student-mode');
    $('screen-auth').style.display = 'none'; $('screen-app').classList.add('active');
    if (typeof renderUserMenu === 'function') renderUserMenu();
    showPanel('student');
  }
  function leaveStudentMode() {
    studentMode = false; ST.data = null; ST.error = null; ST.seq++;
    clearInterval(ST.timer); ST.timer = null;
    document.body.classList.remove('student-mode');
  }
  const backFromLive = () => showPanel('student');

  async function loadStudent() {
    const seq = ++ST.seq;
    const va = inViewAs() && viewAs.perspective === 'student';
    const args = va ? { p_group: viewAs.group?.id || null, p_enrollment: viewAs.person?.id || null } : {};
    const { data, error } = await rpc('student_view', args);
    if (seq !== ST.seq || !studentMode) return;
    ST.data = error ? null : data; ST.error = error || null; ST.loadedAt = Date.now();
    renderStudentHtml();
    handleDeepLink();
  }
  function renderStudent() {
    const root = $('gc-student-root'); if (!root) return;
    if (!ST.data && !ST.error) { root.innerHTML = '<div class="gc-wrap"><div class="in-loading">Loading your classes…</div></div>'; loadStudent(); }
    else renderStudentHtml();
    clearInterval(ST.timer);
    ST.timer = setInterval(() => {
      if (!studentMode) { clearInterval(ST.timer); return; }
      if (Date.now() - ST.loadedAt > 5 * MIN) loadStudent(); else if (isActive('student')) renderStudentHtml();
    }, 20000);
  }
  function upcoming(sessions) {
    const now = Date.now();
    return (sessions || []).filter(s => Date.parse(s.ends_at) > now).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  }
  function renderStudentHtml() {
    const root = $('gc-student-root'); if (!root) return;
    const scroll = root.querySelector('.gc-wrap')?.scrollTop || 0;
    if (ST.error) {
      root.innerHTML = `<div class="gc-wrap gs"><div class="gs-empty"><div class="gs-empty-ico" aria-hidden="true">🛠️</div><h1>We couldn't load your classes</h1><p class="gc-sub">Please try again in a moment.</p><button type="button" class="btn-create-inst" data-gc="st-reload">Try again</button></div></div>`;
      return;
    }
    const d = ST.data || {}; const groups = d.groups || []; const all = d.sessions || [];
    const me = d.me || {}; const va = inViewAs();
    if (!va && !groups.length && !all.length) {
      root.innerHTML = `<div class="gc-wrap gs"><div class="gs-empty">
        <div class="gs-empty-ico tero" aria-hidden="true">${typeof TERO_ERR_SVG === 'string' ? TERO_ERR_SVG : '🐦'}</div>
        <h1>You don't have assigned classes yet</h1>
        <p class="gc-sub">When your school or your teacher adds you with this email, your classes will appear here.</p>
        <p class="gs-empty-mail" data-no-i18n>${esc(me.email || currentUser?.email || '')}</p>
        <div class="gc-btn-row center"><button type="button" class="btn-create-inst" data-gc="st-reload">Check again</button><button type="button" class="tree-btn" data-gc="logout">Sign out</button></div>
      </div></div>`;
      return;
    }
    const up = upcoming(all);
    const next = up.find(s => s.status !== 'cancelled');
    const name = String(me.name || '').trim().split(/\s+/)[0] || '';
    const hello = name ? `<span>Hi</span>, <span data-no-i18n>${esc(name)}</span> 👋` : '<span>Hi!</span> 👋';
    const groupChips = groups.map(g => `<span class="gs-group"><b data-no-i18n>${esc(g.name)}</b>${g.teacher_name ? ` <span class="gs-dot">·</span> <span>Teacher:</span> <span data-no-i18n>${esc(g.teacher_name)}</span>` : ''} <span class="gs-dot">·</span> <span class="gs-count" title="${esc(tr('Classmates'))}">👥 <b>${Number(g.classmates) || 0}</b></span></span>`).join('');
    // ▶️ Enter class
    let enter;
    if (next) {
      const j = joinState(next);
      enter = `<div class="gs-next${j.k === 'open' ? ' open' : ''}">
        <div class="gs-next-when"><div class="gs-next-day">${dayHtml(next.starts_at)}</div><div class="gs-next-time">${rangeHtml(next)}</div>${j.k === 'open' && j.live ? '<span class="gc-chip live">● Live now</span>' : ''}</div>
        <div class="gs-next-info"><div class="gs-next-title" data-no-i18n>${esc(sTitle(next))}</div>
          <div class="gc-meta">${next.group_name ? `<span data-no-i18n>${esc(next.group_name)}</span>` : ''}${next.teacher_name ? ` <span class="gs-dot">·</span> <span>Teacher:</span> <span data-no-i18n>${esc(next.teacher_name)}</span>` : ''}</div></div>
        <div class="gs-next-act">${joinButtonHtml(next, { big: true })}<button type="button" class="tree-btn gs-doc-btn" data-gc="doc" data-id="${esc(next.id)}">📄 <span>Class document</span></button>${j.k === 'soon' ? `<div class="gc-hint"><span>${esc(startsIn(j.ms))}</span> · <span>The button turns on 10 minutes before the class.</span></div>` : ''}</div>
      </div>`;
    } else enter = '<div class="gs-none">No upcoming classes. When your teacher schedules one, it will appear here.</div>';
    // 📅 Calendar (agenda)
    const shown = up.slice(0, 40);
    const byDay = [];
    shown.forEach(s => { const k = ymd(new Date(s.starts_at)); let g = byDay.find(x => x.k === k); if (!g) { g = { k, d: s.starts_at, items: [] }; byDay.push(g); } g.items.push(s); });
    const cal = byDay.length ? byDay.map(g => `<div class="gs-day"><div class="gs-day-h">${dayHtml(g.d)}</div>${g.items.map(s => {
      const j = joinState(s);
      return `<div class="gs-item${s.status === 'cancelled' ? ' cancelled' : ''}" data-sid="${esc(s.id)}">
        <div class="gs-item-time">${rangeHtml(s)}</div>
        <div class="gs-item-main"><div class="gs-item-title" data-no-i18n>${esc(sTitle(s))}</div><div class="gc-meta">${s.group_name ? `<span data-no-i18n>${esc(s.group_name)}</span>` : ''}${s.teacher_name ? ` <span class="gs-dot">·</span> <span data-no-i18n>${esc(s.teacher_name)}</span>` : ''}</div></div>
        <div class="gs-item-act">${s.status === 'cancelled' ? '<span class="gc-chip cancelled">Cancelled</span>' : `${j.k === 'open' ? joinButtonHtml(s, { compact: true }) : ''}<button type="button" class="gc-icon-btn" data-gc="doc" data-id="${esc(s.id)}" title="${esc(tr('Class document'))}" aria-label="${esc(tr('Class document'))}">📄</button><a class="gc-icon-btn" href="${esc(googleUrl(s))}" target="_blank" rel="noopener" title="${esc(tr('Add to Google Calendar'))}" aria-label="${esc(tr('Add to Google Calendar'))}">G+</a><button type="button" class="gc-icon-btn" data-gc="ics" data-id="${esc(s.id)}" title="${esc(tr('Download .ics (Outlook, Apple)'))}" aria-label="${esc(tr('Download .ics (Outlook, Apple)'))}">⬇</button>`}</div>
      </div>`;
    }).join('')}</div>`).join('') + (up.length > shown.length ? `<div class="gc-hint"><span>And more:</span> <b>${up.length - shown.length}</b></div>` : '')
      : '<div class="gs-none">No classes scheduled yet.</div>';
    const docs = Array.isArray(d.docs) && d.docs.length ? `<ul class="gs-docs">${d.docs.map(x => `<li class="gs-doc"><span class="gs-doc-main"><b data-no-i18n>${esc(x.title || x.group_name || '')}</b><span class="gc-meta" data-no-i18n>${esc(fDay(x.starts_at))}${x.group_name && x.group_name !== x.title ? ' · ' + esc(x.group_name) : ''}</span></span>
        <button type="button" class="tree-btn" data-gc="doc" data-id="${esc(x.id)}">📄 <span>Open</span></button></li>`).join('')}</ul>` : '<div class="gs-none">No class documents yet.</div>';
    const feed = va ? '<div class="gc-hint">The calendar subscription is personal (not available in View as).</div>'
      : `<div class="gs-feed"><span>Add all my classes to my calendar:</span> <button type="button" class="tree-btn" data-gc="subscribe">🔗 Subscribe (Google, Outlook, Apple)</button></div>`;
    // 💡 My insights: the newest ones (own only; demo data until recording is active) → the full list in Insights
    const ins = Array.isArray(d.insights) && d.insights.length
      ? `<div class="gs-ins-list">${d.insights.map(x => `<button type="button" class="gs-ins-item" data-gc="ins-open" data-id="${esc(x.id)}">
          <span class="gs-ins-top"><b data-no-i18n>${esc(x.title || x.group_name || '')}</b>${x.is_demo ? ' <span class="gc-chip">Demo</span>' : ''}</span>
          <span class="gc-meta"><span data-no-i18n>${esc(fDay(x.starts_at))}</span>${x.teacher_name ? ` <span class="gs-dot">·</span> <span data-no-i18n>${esc(x.teacher_name)}</span>` : ''}</span>
          ${x.summary ? `<span class="gs-ins-sum" data-no-i18n>${esc(x.summary)}</span>` : ''}
          ${x.has_message ? '<span class="gc-chip ok">💬 <span>Message from your teacher</span></span>' : ''}</button>`).join('')}</div>
        <button type="button" class="tree-btn gs-ins-all" data-gc="ins-all">💡 <span>See all my insights</span> →</button>`
      : `<div class="gs-ins-empty">
          <div class="gs-ins-art" aria-hidden="true"><span>🗣️</span><span>📚</span><span>💬</span></div>
          <div class="gs-ins-title">Your insights will appear here after your classes</div>
          <p class="gc-sub">After each recorded class you'll see a recap, your progress and personal feedback from your teacher.</p>
          <div class="gs-ins-preview" aria-hidden="true">
            <div class="gs-tile"><span class="gs-tile-ico">🗣️</span><span class="gs-tile-l">Speaking time</span><span class="gs-tile-bar"><i style="width:62%"></i></span></div>
            <div class="gs-tile"><span class="gs-tile-ico">📚</span><span class="gs-tile-l">New words</span><span class="gs-tile-bar"><i style="width:45%"></i></span></div>
            <div class="gs-tile"><span class="gs-tile-ico">📈</span><span class="gs-tile-l">Progress</span><span class="gs-tile-bar"><i style="width:74%"></i></span></div>
          </div>
          <span class="gc-chip">Preview</span>
        </div>`;
    root.innerHTML = `<div class="gc-wrap gs">
      <header class="gs-hello"><div><h1>${hello}</h1><p class="gc-sub">Your classes, all in one place.</p></div>
        <span class="gc-tz" title="${esc(tr('All times are shown in your time zone'))}">🕒 <span>Your time zone:</span> <b data-no-i18n>${esc(tzLabel())}</b></span></header>
      ${groupChips ? `<div class="gs-groups">${groupChips}</div>` : ''}
      <section class="gs-card gs-enter" aria-labelledby="gs-enter-h"><h2 id="gs-enter-h"><span aria-hidden="true">▶️</span> <span>Enter class</span></h2>${enter}</section>
      <div class="gs-grid">
        <div class="gs-col">
          <section class="gs-card gs-cal" aria-labelledby="gs-cal-h"><h2 id="gs-cal-h"><span aria-hidden="true">📅</span> <span>Calendar</span></h2><div class="gs-agenda">${cal}</div>${feed}</section>
          <section class="gs-card gs-att" aria-labelledby="gs-att-h"><h2 id="gs-att-h"><span aria-hidden="true">✅</span> <span>My attendance</span></h2>${window.TCAttendance ? window.TCAttendance.studentCardHtml(d.attendance) : ''}</section>
        </div>
        <div class="gs-col">
          <section class="gs-card gs-ins" aria-labelledby="gs-ins-h"><h2 id="gs-ins-h"><span aria-hidden="true">💡</span> <span>My insights</span></h2>${ins}</section>
          <section class="gs-card gs-docs-card" aria-labelledby="gs-docs-h"><h2 id="gs-docs-h"><span aria-hidden="true">📄</span> <span>Class documents</span></h2>
            <p class="gc-sub">The shared document of each class stays here as a record.</p>${docs}</section>
        </div>
      </div>
    </div>`;
    const w = root.querySelector('.gc-wrap'); if (w && scroll) w.scrollTop = scroll;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CALENDAR (teachers / substitutes; read-only in View as)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const CAL = { view: null, anchor: startOfWeek(new Date()), rows: [], seq: 0, loaded: false, groups: null, next: null, nextSeq: 0, timer: null };
  const calRange = () => CAL.view === 'week' ? [CAL.anchor, addDays(CAL.anchor, 7)] : [CAL.anchor, addDays(CAL.anchor, 56)];

  function renderCalendar() {
    const root = $('gc-cal-root'); if (!root) return;
    if (!CAL.view) CAL.view = isNarrow() ? 'agenda' : 'week';
    const ro = inViewAs();
    root.innerHTML = `<div class="gc-wrap">
      <header class="gc-head">
        <div><h1><span aria-hidden="true">📅</span> <span>Calendar</span></h1>
          <p class="gc-sub"><span>Your classes and your groups' classes.</span> <span class="gc-tz">🕒 <span>Your time zone:</span> <b data-no-i18n>${esc(tzLabel())}</b></span></p></div>
        <div class="gc-head-actions">${ro ? '' : '<button type="button" class="tree-btn" data-gc="subscribe">🔗 Subscribe</button>'}<button type="button" class="btn-create-inst" data-gc="new-session">+ Schedule class</button></div>
      </header>
      <div id="gc-next-card" class="gc-next-slot"></div>
      <div class="gc-toolbar">
        <div class="in-seg" role="group" aria-label="${esc(tr('Calendar view'))}"><button type="button" data-gc="view" data-v="week" class="${CAL.view === 'week' ? 'active' : ''}" aria-pressed="${CAL.view === 'week'}">Week</button><button type="button" data-gc="view" data-v="agenda" class="${CAL.view === 'agenda' ? 'active' : ''}" aria-pressed="${CAL.view === 'agenda'}">Agenda</button></div>
        <div class="gc-nav"><button type="button" class="tree-btn" data-gc="prev" aria-label="${esc(tr('Previous'))}">‹</button><button type="button" class="tree-btn" data-gc="today">Today</button><button type="button" class="tree-btn" data-gc="next" aria-label="${esc(tr('Next'))}">›</button></div>
        <div class="gc-range" id="gc-range" data-no-i18n></div>
      </div>
      <div id="gc-cal-body" class="gc-cal-body"><div class="in-loading">Loading…</div></div>
    </div>`;
    loadCalendar();
    clearInterval(CAL.timer);
    CAL.timer = setInterval(() => { if (!isActive('calendar')) { clearInterval(CAL.timer); CAL.timer = null; return; } renderNext(); }, 30000);
  }
  // Today's / next class: a visible "Enter room" (teacher, substitute) or the join window (as a student)
  async function loadNext() {
    const seq = ++CAL.nextSeq; const now = new Date();
    const { data, error } = await calSource(new Date(now.getTime() - 12 * 60 * MIN), addDays(now, 60));
    if (seq !== CAL.nextSeq) return;
    CAL.next = error ? null : (upcoming(data || []).find(r => r.status !== 'cancelled') || null);
    renderNext();
  }
  function renderNext() {
    const box = $('gc-next-card'); if (!box) return;
    const s = CAL.next;
    if (!s || Date.parse(s.ends_at) <= Date.now()) { box.innerHTML = ''; return; }
    const j = joinState(s); const today = sameDay(new Date(s.starts_at), new Date());
    box.innerHTML = `<section class="gc-nextcard${j.k === 'open' ? ' open' : ''}" aria-label="${esc(tr(today ? "Today's class" : 'Next class'))}">
      <div class="gc-nc-when"><span class="gc-nc-label">${today ? "Today's class" : 'Next class'}</span><span class="gc-nc-day">${dayHtml(s.starts_at)}</span> <span class="gc-nc-time">${rangeHtml(s)}</span>${j.k === 'open' && j.live ? ' <span class="gc-chip live">● Live now</span>' : ''}</div>
      <div class="gc-nc-info"><button type="button" class="gc-nc-title" data-gc="open" data-id="${esc(s.id)}" data-no-i18n>${esc(sTitle(s))}</button>
        <div class="gc-meta">${s.group_name ? `<span data-no-i18n>${esc(s.group_name)}</span> <span class="gs-dot">·</span> ` : ''}<span>👥</span> <b>${Number(s.people) || 0}</b> ${roleChip(s)}</div></div>
      <div class="gc-nc-act">${joinButtonHtml(s)}</div>
    </section>`;
  }
  async function calSource(from, to) {
    if (inViewAs()) { // the owner's own session: show the viewed unit's classes (for a teacher: their groups)
      const { data, error } = await rpc('unit_calendar', { p_unit: viewAs.unitId, p_from: from.toISOString(), p_to: to.toISOString() });
      if (error) return { error };
      let rows = data || [];
      if (viewAs.person?.id) {
        const g = await rpc('list_groups', { p_unit: viewAs.unitId });
        const mine = new Set((g.data || []).filter(x => x.teacher?.id === viewAs.person.id || x.substitute?.id === viewAs.person.id).map(x => x.id));
        rows = rows.filter(r => mine.has(r.group_id));
      }
      return { data: rows.map(r => ({ ...r, can_edit: false })) };
    }
    return rpc('my_calendar', { p_from: from.toISOString(), p_to: to.toISOString() });
  }
  async function loadCalendar() {
    const seq = ++CAL.seq; const [from, to] = calRange();
    const rl = $('gc-range');
    if (rl) rl.textContent = CAL.view === 'week'
      ? `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(addDays(to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`
      : `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(addDays(to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const { data, error } = await calSource(from, to);
    if (seq !== CAL.seq) return;
    if (error) { errToast(error); CAL.rows = []; } else CAL.rows = Array.isArray(data) ? data : [];
    CAL.loaded = true;
    renderCalBody();
    loadNext();
    handleDeepLink();
  }
  function renderCalBody() {
    const body = $('gc-cal-body'); if (!body) return;
    body.innerHTML = CAL.view === 'week' ? weekHtml(CAL.rows, CAL.anchor) : agendaHtml(CAL.rows, { emptyText: 'No classes in this period.' });
    const sc = body.querySelector('.gc-week-scroll');
    if (sc && !sc.dataset.scrolled) { const first = body.querySelector('.gc-ev'); sc.scrollTop = first ? Math.max(0, first.offsetTop - 30) : 0; sc.dataset.scrolled = '1'; }
  }
  const HOUR_PX = 46;
  function weekHtml(rows, anchor) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
    let minH = 8; let maxH = 20;
    rows.forEach(r => { const a = new Date(r.starts_at); const b = new Date(r.ends_at); minH = Math.min(minH, a.getHours()); maxH = Math.max(maxH, b.getHours() + (b.getMinutes() ? 1 : 0) + (sameDay(a, b) ? 0 : 24)); });
    maxH = Math.min(Math.max(maxH, minH + 1), 24);
    const hours = Array.from({ length: maxH - minH }, (_, i) => minH + i);
    const today = new Date();
    const cols = days.map(day => {
      const items = rows.filter(r => sameDay(new Date(r.starts_at), day)).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
      // lanes for overlapping classes
      const lanes = []; items.forEach(it => { const a = Date.parse(it.starts_at); let l = lanes.findIndex(end => end <= a); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = Date.parse(it.ends_at); it._lane = l; });
      const n = Math.max(1, lanes.length);
      const evs = items.map(it => {
        const a = new Date(it.starts_at); const b = new Date(it.ends_at);
        const top = ((a.getHours() - minH) * 60 + a.getMinutes()) / 60 * HOUR_PX;
        const h = Math.max(24, (b - a) / MIN / 60 * HOUR_PX - 2);
        const cls = ['gc-ev', it.status === 'cancelled' ? 'cancelled' : '', it.role === 'student' ? 'as-student' : '', it.role === 'substitute' ? 'as-sub' : ''].join(' ');
        return `<button type="button" class="${cls}" data-gc="open" data-id="${esc(it.id)}" style="top:${top}px;height:${h}px;left:calc(${it._lane * 100 / n}% + 2px);width:calc(${100 / n}% - 4px)" title="${esc(fTime(it.starts_at) + ' ' + sTitle(it))}">
          <span class="gc-ev-t" data-no-i18n>${esc(fTime(it.starts_at))}</span> <span class="gc-ev-n" data-no-i18n>${esc(sTitle(it))}</span>${it.group_name && it.group_name !== sTitle(it) ? `<span class="gc-ev-g" data-no-i18n>${esc(it.group_name)}</span>` : ''}</button>`;
      }).join('');
      const nowLine = sameDay(day, today) && today.getHours() >= minH && today.getHours() < maxH
        ? `<div class="gc-now" style="top:${((today.getHours() - minH) * 60 + today.getMinutes()) / 60 * HOUR_PX}px"></div>` : '';
      return `<div class="gc-day${sameDay(day, today) ? ' today' : ''}" style="height:${hours.length * HOUR_PX}px">${hours.map(() => '<div class="gc-slot"></div>').join('')}${evs}${nowLine}</div>`;
    }).join('');
    const head = days.map(d => `<div class="gc-dh${sameDay(d, today) ? ' today' : ''}" data-no-i18n><span>${esc(fmt(d, { weekday: 'short' }))}</span><b>${d.getDate()}</b></div>`).join('');
    return `<div class="gc-week">
      <div class="gc-week-head"><div class="gc-corner"></div>${head}</div>
      <div class="gc-week-scroll"><div class="gc-week-grid"><div class="gc-hours">${hours.map(h => `<div class="gc-hour" data-no-i18n>${pad(h)}:00</div>`).join('')}</div>${cols}</div></div>
      ${rows.length ? '' : '<div class="gc-week-empty">No classes this week.</div>'}
    </div>`;
  }
  function roleChip(r) {
    if (r.status === 'cancelled') return '<span class="gc-chip cancelled">Cancelled</span>';
    if (r.role === 'student') return '<span class="gc-chip as-student">As a student</span>';
    if (r.role === 'substitute') return '<span class="gc-chip as-sub">Substitute</span>';
    return '';
  }
  function agendaHtml(rows, { emptyText = 'No classes in this period.' } = {}) {
    const list = rows.slice().sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    if (!list.length) return `<div class="bl-empty">${esc(emptyText)}</div>`;
    const byDay = [];
    list.forEach(s => { const k = ymd(new Date(s.starts_at)); let g = byDay.find(x => x.k === k); if (!g) { g = { k, d: s.starts_at, items: [] }; byDay.push(g); } g.items.push(s); });
    const today = new Date();
    const act = s => { if (s.status === 'cancelled') return ''; if (isStaffRow(s)) return joinButtonHtml(s, { compact: true }); return s.role === 'student' && joinState(s).k === 'open' ? joinButtonHtml(s, { compact: true }) : ''; };
    return `<div class="gc-agenda">${byDay.map(g => `<div class="gc-ag-day${sameDay(new Date(g.d), today) ? ' today' : ''}"><div class="gc-ag-date">${dayHtml(g.d)}</div><div class="gc-ag-items">${g.items.map(s => `
      <div class="gc-ag-item${s.status === 'cancelled' ? ' cancelled' : ''}" role="button" tabindex="0" data-gc="open" data-id="${esc(s.id)}">
        <span class="gc-ag-time">${rangeHtml(s)}</span>
        <span class="gc-ag-main"><span class="gc-ag-title" data-no-i18n>${esc(sTitle(s))}</span><span class="gc-meta">${s.group_name ? `<span data-no-i18n>${esc(s.group_name)}</span> <span class="gs-dot">·</span> ` : ''}<span>👥</span> <b>${Number(s.people) || 0}</b>${s.unit_name && s.role === 'admin' ? ` <span class="gs-dot">·</span> <span data-no-i18n>${esc(s.unit_name)}</span>` : ''}</span></span>
        ${roleChip(s)}<span class="gc-ag-act">${act(s)}</span>
      </div>`).join('')}</div></div>`).join('')}</div>`;
  }
  const findRow = id => CAL.rows.find(r => r.id === id) || (CAL.next && CAL.next.id === id ? CAL.next : null) || GR.cal.find(r => r.id === id) || (ST.data?.sessions || []).find(r => r.id === id) || null;

  // ── session detail ──
  async function openSessionDetail(id) {
    const s = findRow(id); if (!s) return;
    const canEdit = !!s.can_edit && !inViewAs();
    const staff = s.role && s.role !== 'student';
    const otherTz = s.timezone && s.timezone !== LOCAL_TZ;
    const attStarted = s.status !== 'cancelled' && Date.parse(s.starts_at) - JOIN_EARLY <= Date.now();
    modal(`<div class="modal-title" id="gc-modal-title" data-no-i18n>${esc(sTitle(s))}</div>
      <div class="modal-sub"><span data-no-i18n>${esc(fDayLong(s.starts_at))}</span> · ${rangeHtml(s)} <span class="gc-tz-chip" data-no-i18n>${esc(tzLabel())}</span>
        ${otherTz ? `<div class="gc-hint"><span>Group time:</span> <span data-no-i18n>${esc(timeInTz(s.starts_at, s.timezone))} (${esc(String(s.timezone).replace(/_/g, ' '))})</span></div>` : ''}</div>
      <div class="gc-chips">${s.group_name ? `<span class="gc-chip"><span>Group:</span> <b data-no-i18n>${esc(s.group_name)}</b></span>` : '<span class="gc-chip">Without a group</span>'}
        ${s.series_id ? '<span class="gc-chip">🔁 <span>Weekly</span></span>' : ''}${roleChip(s)}${s.teacher_name && s.role !== 'teacher' ? `<span class="gc-chip"><span>Teacher:</span> <b data-no-i18n>${esc(s.teacher_name)}</b></span>` : ''}</div>
      <div class="gc-join-row">${joinButtonHtml(s)}${isStaffRow(s) || s.status === 'cancelled' ? '' : '<span class="gc-hint">The class opens 10 minutes before it starts.</span>'}</div>
      <div class="gc-sec-title">Class document</div>
      <div class="gc-btn-row"><button type="button" class="tree-btn primary" data-gc="doc" data-id="${esc(s.id)}">📄 <span>Open class document</span></button><span class="gc-hint">Everyone in the class can write in it at the same time; it stays as a record.</span></div>
      <div class="gc-sec-title">Add to calendar</div>
      <div class="gc-btn-row"><a class="tree-btn" href="${esc(googleUrl(s))}" target="_blank" rel="noopener">Google Calendar</a><button type="button" class="tree-btn" data-gc="ics" data-id="${esc(s.id)}">⬇ <span>.ics (Outlook, Apple)</span></button></div>
      ${staff ? `<div class="gc-sec-title">Attendance</div>${attStarted ? '<div id="gc-att" class="gc-att"><div class="in-loading">Loading…</div></div>' : '<div class="gc-hint">Attendance is recorded when students enter the room.</div>'}
        ${s.group_id && window.TCAttendance ? `<div class="gc-btn-row gc-att-actions"><button type="button" class="tree-btn" data-gc="att-report" data-id="${esc(s.id)}" data-g="${esc(s.group_id)}">📊 <span>Group attendance report</span></button></div>` : ''}` : ''}
      ${staff && s.status !== 'cancelled' && Date.parse(s.starts_at) <= endOfToday() && window.TCInsightsPanel ? `<div class="gc-sec-title">Insights</div>
        <div class="gc-btn-row"><button type="button" class="tree-btn" data-gc="ins-view" data-id="${esc(s.id)}">💡 <span>View insights</span></button>${inViewAs() ? '' : `<button type="button" class="tree-btn" data-gc="ins-gen" data-id="${esc(s.id)}">✨ <span>Generate demo insights</span></button>`}</div>` : ''}
      ${staff ? `<div class="gc-sec-title"><span>Students</span> <span class="gc-count">(<b>${Number(s.people) || 0}</b>)</span></div><div id="gc-people" class="gc-people"><div class="in-loading">Loading…</div></div>` : ''}
      ${canEdit ? `<div class="gc-sec-title">Invite</div>
        <div class="gc-btn-row"><button type="button" class="tree-btn" data-gc="notify" data-id="${esc(s.id)}" data-kind="invite">✉️ <span>Email the students</span></button><button type="button" class="tree-btn" data-gc="copy-invite" data-id="${esc(s.id)}">🔗 <span>Copy invitation link</span></button></div>
        <div class="gc-note" id="gc-notify-note" role="status"></div>
        <div class="gc-sec-title">Edit</div>
        <div class="gc-btn-row"><button type="button" class="tree-btn" data-gc="edit-one" data-id="${esc(s.id)}">✏️ <span>Edit this class</span></button>
          ${s.status === 'cancelled' ? `<button type="button" class="tree-btn" data-gc="restore-one" data-id="${esc(s.id)}">↩ <span>Restore this class</span></button>` : `<button type="button" class="tree-btn danger" data-gc="cancel-one" data-id="${esc(s.id)}"><span>Cancel this class</span></button>`}
          ${s.series_id ? `<button type="button" class="tree-btn" data-gc="edit-series" data-id="${esc(s.id)}">🔁 <span>Edit the whole series</span></button><button type="button" class="tree-btn danger" data-gc="cancel-series" data-id="${esc(s.id)}"><span>Cancel the whole series</span></button>` : ''}</div>` : ''}
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Close</button></div>`);
    if (staff && attStarted && window.TCAttendance) window.TCAttendance.loadSession($('gc-att'), s.id);
    if (staff) {
      const { data, error } = await rpc('session_people', { p_session: s.id });
      const box = $('gc-people'); if (!box) return;
      if (error) { box.innerHTML = `<div class="pb-empty">${esc(tr('Could not load the students.'))}</div>`; return; }
      box.innerHTML = (data || []).length ? `<ul class="gc-people-list">${data.map(p => `<li><span class="gc-p-name" data-no-i18n>${esc(p.name || '—')}</span> <span class="gc-p-mail" data-no-i18n>${esc(p.email)}</span>${p.via === 'invite' ? ' <span class="gc-chip">Invited</span>' : ''}</li>`).join('')}</ul>`
        : '<div class="pb-empty">No students yet.</div>';
    }
  }
  function editOneForm(id) {
    const s = findRow(id); if (!s) return;
    const a = new Date(s.starts_at); const dur = Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / MIN);
    modal(`<div class="modal-title" id="gc-modal-title">Edit this class</div>
      <div class="modal-sub"><span>Only this date changes.</span> <span class="gc-tz-chip" data-no-i18n>${esc(tzLabel())}</span></div>
      <form data-gcf="edit-one" data-id="${esc(id)}">
        <div class="modal-field"><label class="modal-label" for="gc-e-title">Title (optional)</label><input id="gc-e-title" class="modal-input" maxlength="200" value="${esc(s.raw_title ?? s.title ?? '')}" placeholder="${esc(s.group_name || '')}"></div>
        <div class="gc-form-row">
          <div class="modal-field"><label class="modal-label" for="gc-e-date">Date</label><input id="gc-e-date" type="date" class="modal-input" required value="${ymd(a)}"></div>
          <div class="modal-field"><label class="modal-label" for="gc-e-time">Start time</label><input id="gc-e-time" type="time" class="modal-input" required value="${hm(a)}"></div>
          <div class="modal-field"><label class="modal-label" for="gc-e-dur">Duration (min)</label><input id="gc-e-dur" type="number" class="modal-input" min="5" max="720" step="5" required value="${dur}"></div>
        </div>
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="open" data-id="${esc(id)}">Back</button><button type="submit" class="btn-modal-save">Save this class</button></div>
      </form>`);
  }
  function weekdayPicker(sel) {
    const base = startOfWeek(new Date());
    return `<div class="gc-weekdays" role="group" aria-label="${esc(tr('Weekdays'))}">${[1, 2, 3, 4, 5, 6, 7].map(n => `<label class="gc-wd"><input type="checkbox" name="gc-wd" value="${n}"${sel.includes(n) ? ' checked' : ''}><span data-no-i18n>${esc(fmt(addDays(base, n - 1), { weekday: 'short' }))}</span></label>`).join('')}</div>`;
  }
  async function editSeriesForm(id) {
    const s = findRow(id); if (!s?.series_id) return;
    const sib = CAL.rows.filter(r => r.series_id === s.series_id);
    const days = [...new Set(sib.map(r => ((new Date(r.starts_at).getDay() + 6) % 7) + 1))].sort();
    const a = new Date(s.starts_at); const dur = Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / MIN);
    const last = sib.reduce((m, r) => Math.max(m, Date.parse(r.starts_at)), Date.parse(s.starts_at));
    modal(`<div class="modal-title" id="gc-modal-title">Edit the whole series</div>
      <div class="modal-sub">From today on. Past classes and classes you edited one by one stay as they are.</div>
      <form data-gcf="edit-series" data-id="${esc(id)}">
        <div class="modal-field"><label class="modal-label" for="gc-s-title">Title (optional)</label><input id="gc-s-title" class="modal-input" maxlength="200" value="${esc(s.raw_title ?? '')}" placeholder="${esc(s.group_name || '')}"></div>
        <div class="modal-field"><span class="modal-label">Weekdays</span>${weekdayPicker(days.length ? days : [((a.getDay() + 6) % 7) + 1])}</div>
        <div class="gc-form-row">
          <div class="modal-field"><label class="modal-label" for="gc-s-time">Start time</label><input id="gc-s-time" type="time" class="modal-input" required value="${hmInTz(s.starts_at, s.timezone || LOCAL_TZ)}"></div>
          <div class="modal-field"><label class="modal-label" for="gc-s-dur">Duration (min)</label><input id="gc-s-dur" type="number" class="modal-input" min="5" max="720" step="5" required value="${dur}"></div>
          <div class="modal-field"><label class="modal-label" for="gc-s-end">Until</label><input id="gc-s-end" type="date" class="modal-input" required value="${ymd(new Date(last))}"></div>
        </div>
        <div class="gc-hint"><span>Times use the group's time zone:</span> <b data-no-i18n>${esc(tzLabel(s.timezone || LOCAL_TZ))}</b></div>
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="open" data-id="${esc(id)}">Back</button><button type="submit" class="btn-modal-save">Save the series</button></div>
      </form>`);
  }
  async function myGroups(force) {
    if (CAL.groups && !force) return CAL.groups;
    const { data, error } = await rpc('my_groups');
    CAL.groups = error ? [] : (data || []);
    return CAL.groups;
  }
  async function newSessionForm(kind = 'series') {
    if (blocked()) return;
    const groups = await myGroups(true);
    const canAdhoc = !!currentUser?.orgId && ['teacher', 'org_admin'].includes(currentUser?.role);
    if (!groups.length && !canAdhoc) {
      modal(`<div class="modal-title" id="gc-modal-title">Schedule a class</div>
        <div class="notice-card">You don't have groups yet. Your institution's admin creates the groups and assigns their teacher in <b>Groups</b>.</div>
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Close</button></div>`);
      return;
    }
    if (!groups.length) kind = 'one';
    const today = new Date(); const nextHour = new Date(); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
    const until = addDays(today, 90);
    const gOpts = groups.map(g => `<option value="${esc(g.id)}" data-tz="${esc(g.timezone)}" data-no-i18n>${esc(g.name)}${g.unit_name ? ' · ' + esc(g.unit_name) : ''}</option>`).join('');
    const tzNote = g => { const tz = g?.timezone || LOCAL_TZ; return `<span>Times use the group's time zone:</span> <b data-no-i18n>${esc(tzLabel(tz))}</b>`; };
    modal(`<div class="modal-title" id="gc-modal-title">Schedule a class</div>
      <div class="in-seg gc-kind" role="group" aria-label="${esc(tr('Type'))}">
        <button type="button" data-gc="kind" data-k="series" class="${kind === 'series' ? 'active' : ''}"${groups.length ? '' : ' disabled'}>🔁 <span>Weekly series</span></button>
        <button type="button" data-gc="kind" data-k="one" class="${kind === 'one' ? 'active' : ''}">📌 <span>One class</span></button>
      </div>
      <form data-gcf="new" data-kind="${kind}">
        <div class="modal-field"><label class="modal-label" for="gc-n-group">Group</label>
          <select id="gc-n-group" class="modal-input">${kind === 'one' && canAdhoc ? `<option value="">${esc(tr('— No group: invite students by email —'))}</option>` : ''}${gOpts}</select></div>
        <div class="modal-field"><label class="modal-label" for="gc-n-title">Title (optional)</label><input id="gc-n-title" class="modal-input" maxlength="200" placeholder="${esc(tr('e.g. Unit 3: making plans'))}"></div>
        ${kind === 'series' ? `
          <div class="modal-field"><span class="modal-label">Weekdays</span>${weekdayPicker([2, 4])}</div>
          <div class="gc-form-row">
            <div class="modal-field"><label class="modal-label" for="gc-n-time">Start time</label><input id="gc-n-time" type="time" class="modal-input" required value="18:00"></div>
            <div class="modal-field"><label class="modal-label" for="gc-n-dur">Duration (min)</label><input id="gc-n-dur" type="number" class="modal-input" min="5" max="720" step="5" required value="60"></div>
          </div>
          <div class="gc-form-row">
            <div class="modal-field"><label class="modal-label" for="gc-n-from">From</label><input id="gc-n-from" type="date" class="modal-input" required value="${ymd(today)}"></div>
            <div class="modal-field"><label class="modal-label" for="gc-n-until">Until</label><input id="gc-n-until" type="date" class="modal-input" required value="${ymd(until)}" max="${ymd(addDays(today, 366))}"></div>
          </div>
          <div class="gc-hint" id="gc-n-tz">${tzNote(groups[0])} · <span>Up to one year.</span></div>` : `
          <div class="gc-form-row">
            <div class="modal-field"><label class="modal-label" for="gc-n-date">Date</label><input id="gc-n-date" type="date" class="modal-input" required value="${ymd(nextHour)}"></div>
            <div class="modal-field"><label class="modal-label" for="gc-n-time">Start time</label><input id="gc-n-time" type="time" class="modal-input" required value="${hm(nextHour)}"></div>
            <div class="modal-field"><label class="modal-label" for="gc-n-dur">Duration (min)</label><input id="gc-n-dur" type="number" class="modal-input" min="5" max="720" step="5" required value="60"></div>
          </div>
          <div class="modal-field"><label class="modal-label" for="gc-n-emails">Invite students by email</label><textarea id="gc-n-emails" class="modal-input gc-emails" rows="3" placeholder="${esc(tr('One email per line (or separated by commas)'))}"></textarea>
            <div class="gc-hint">Required for a class without a group; optional extra guests for a group. A new email is loaded as a student of your institution.</div></div>
          <div class="gc-hint"><span>Times in your time zone:</span> <b data-no-i18n>${esc(tzLabel())}</b></div>`}
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Cancel</button><button type="submit" class="btn-modal-save">Create</button></div>
      </form>`);
    const sel = $('gc-n-group');
    sel?.addEventListener('change', () => { const n = $('gc-n-tz'); const g = groups.find(x => x.id === sel.value); if (n && g) n.innerHTML = `${tzNote(g)} · <span>Up to one year.</span>`; });
  }
  const parseEmails = t => String(t || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  async function submitNew(form) {
    if (blocked()) return;
    const kind = form.dataset.kind; const btn = form.querySelector('[type=submit]');
    const group = $('gc-n-group')?.value || null; const title = $('gc-n-title')?.value || '';
    const dur = parseInt($('gc-n-dur')?.value, 10);
    if (kind === 'series') {
      const days = [...form.querySelectorAll('input[name=gc-wd]:checked')].map(i => +i.value);
      if (!days.length) { showToast('Choose at least one weekday.', 'err'); return; }
      busy(btn, true);
      const { data, error } = await rpc('create_series', { p_group: group, p_title: title, p_weekdays: days, p_start_time: $('gc-n-time').value,
        p_duration: dur, p_start_date: $('gc-n-from').value, p_end_date: $('gc-n-until').value });
      busy(btn, false);
      if (error) { errToast(error); return; }
      closeGc(); showToast(`${data?.created || 0} classes scheduled ✓`, 'ok');
    } else {
      const emails = parseEmails($('gc-n-emails')?.value);
      const bad = emails.filter(e => !EMAIL_RE.test(e));
      if (bad.length) { showToast(`Invalid email: ${bad[0]}`, 'err'); return; }
      if (!group && !emails.length) { showToast('Add at least one student email.', 'err'); return; }
      const at = localDateTime($('gc-n-date').value, $('gc-n-time').value);
      if (!at) { showToast('Invalid class date.', 'err'); return; }
      busy(btn, true);
      const { data, error } = await rpc('create_session', { p_group: group, p_title: title, p_starts_at: at.toISOString(), p_duration: dur, p_timezone: LOCAL_TZ, p_emails: emails.length ? emails : null });
      busy(btn, false);
      if (error) { errToast(error); return; }
      closeGc(); showToast('Class scheduled ✓', 'ok');
      if (data?.id) notify(data.id, 'invite', { quiet: true });
    }
    CAL.anchor = startOfWeek(new Date()); loadCalendar();
  }
  async function submitEditOne(form) {
    if (blocked()) return;
    const id = form.dataset.id; const at = localDateTime($('gc-e-date').value, $('gc-e-time').value);
    if (!at) { showToast('Invalid class date.', 'err'); return; }
    const btn = form.querySelector('[type=submit]'); busy(btn, true);
    const { error } = await rpc('update_session', { p_session: id, p_title: $('gc-e-title').value, p_starts_at: at.toISOString(), p_duration: parseInt($('gc-e-dur').value, 10) });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); showToast('Class updated ✓', 'ok'); notify(id, 'update', { quiet: true }); await loadCalendar();
  }
  async function submitEditSeries(form) {
    if (blocked()) return;
    const s = findRow(form.dataset.id); if (!s) return;
    const days = [...form.querySelectorAll('input[name=gc-wd]:checked')].map(i => +i.value);
    if (!days.length) { showToast('Choose at least one weekday.', 'err'); return; }
    const btn = form.querySelector('[type=submit]'); busy(btn, true);
    const { error } = await rpc('update_series', { p_series: s.series_id, p_title: $('gc-s-title').value, p_weekdays: days, p_start_time: $('gc-s-time').value,
      p_duration: parseInt($('gc-s-dur').value, 10), p_end_date: $('gc-s-end').value });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); showToast('Series updated ✓', 'ok'); await loadCalendar();
  }
  async function cancelOne(id, btn, restore) {
    if (blocked()) return;
    if (!restore && !twoClick('c1' + id, btn, tr('Click again to cancel'))) return;
    busy(btn, true);
    const { error } = await rpc('cancel_session', { p_session: id, p_cancel: !restore });
    busy(btn, false);
    if (error) { errToast(error); return; }
    showToast(restore ? 'Class restored ✓' : 'Class cancelled', 'ok'); notify(id, restore ? 'update' : 'cancel', { quiet: true });
    await loadCalendar(); openSessionDetail(id);
  }
  async function cancelSeries(id, btn) {
    if (blocked()) return;
    const s = findRow(id); if (!s?.series_id) return;
    if (!twoClick('cs' + id, btn, tr('Click again to cancel the series'))) return;
    busy(btn, true);
    const { error } = await rpc('cancel_series', { p_series: s.series_id });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); showToast('Series cancelled', 'ok'); await loadCalendar();
  }
  // Email the students (api/notify/session). Without RESEND_API_KEY: "copy invitation link" instead.
  async function notify(id, kind, { quiet = false, btn = null } = {}) {
    if (inViewAs()) { if (!quiet) blocked(); return; }
    try {
      busy(btn, true);
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch('/api/notify/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ session_id: id, kind, lang: uiLang === 'es' ? 'es' : 'en' }) });
      const j = await r.json().catch(() => ({}));
      const note = $('gc-notify-note');
      if (j.configured === false) {
        if (note) { note.innerHTML = '<span>Email is not configured yet. Use "Copy invitation link" and send it yourself.</span>'; note.className = 'gc-note warn'; }
        if (!quiet) showToast('Email is not configured yet: copy the invitation link instead.', 'err');
        return;
      }
      if (!r.ok) { if (!quiet) showToast('Error: ' + (j.error || r.status), 'err'); return; }
      if (j.sent > 0) { showToast(`Emails sent to ${j.sent} students ✓`, 'ok'); if (note) { note.textContent = tr('Emails sent ✓'); note.className = 'gc-note ok'; } }
      else if (!quiet) showToast('There are no students to email.', 'err');
    } catch (e) { if (!quiet) showToast('Error: ' + (e?.message || e), 'err'); } finally { busy(btn, false); }
  }

  // ── personal subscription feed ──
  async function subscribeDialog() {
    if (inViewAs()) { blocked(); return; }
    modal(`<div class="modal-title" id="gc-modal-title">Subscribe to my calendar</div><div class="in-loading">Loading…</div>`);
    const { data, error } = await rpc('my_calendar_token', { p_reset: false });
    if (error || !data) { closeGc(); errToast(error || 'no token'); return; }
    ST.token = data; renderSubscribe();
  }
  function renderSubscribe() {
    const t = ST.token; const host = location.host;
    const https = `${location.origin}/cal/${t}.ics`; const webcal = `webcal://${host}/cal/${t}.ics`;
    const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
    modal(`<div class="modal-title" id="gc-modal-title">Subscribe to my calendar</div>
      <div class="modal-sub">Your classes appear in Google Calendar, Outlook or Apple Calendar and update by themselves. This link is personal: don't share it.</div>
      <div class="modal-field"><label class="modal-label" for="gc-feed-url">Feed URL</label><input id="gc-feed-url" class="modal-input" readonly value="${esc(https)}" data-no-i18n onfocus="this.select()"></div>
      <div class="gc-btn-row"><a class="tree-btn primary" href="${esc(google)}" target="_blank" rel="noopener">📅 <span>Subscribe in Google Calendar</span></a>
        <button type="button" class="tree-btn" data-gc="copy-feed">📋 <span>Copy feed URL</span></button>
        <a class="tree-btn" href="${esc(webcal)}">🍎 <span>Outlook / Apple Calendar</span></a></div>
      <div class="gc-hint">Calendar apps refresh subscriptions every few hours. In Outlook: Add calendar → From the internet → paste the URL.</div>
      <div class="gc-sec-title">Lost control of the link?</div>
      <div class="gc-btn-row"><button type="button" class="tree-btn danger" data-gc="reset-feed">↻ <span>Reset link</span></button><span class="gc-hint">The old link stops working.</span></div>
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Close</button></div>`);
  }
  async function resetFeed(btn) {
    if (!twoClick('feed', btn, tr('Click again to reset'))) return;
    busy(btn, true);
    const { data, error } = await rpc('my_calendar_token', { p_reset: true });
    busy(btn, false);
    if (error || !data) { errToast(error || 'no token'); return; }
    ST.token = data; renderSubscribe(); showToast('New link ready ✓ The old one no longer works.', 'ok');
  }

  // ── join → live class demo ──
  function join(id) {
    const s = findRow(id); if (!s) return;
    const j = joinState(s); const staff = isStaffRow(s);
    if (j.k === 'cancelled' || (!staff && j.k !== 'open')) { showToast(j.k === 'soon' ? opensAt(s) : 'This class is not available.', 'err'); return; }
    closeGc();
    if (window.LiveClass?.openSession) window.LiveClass.openSession({ id: s.id, title: sTitle(s), group: s.group_name || '', role: staff ? 'teacher' : 'student' });
    else showToast('The live class is not available.', 'err');
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // GROUPS (institution admins, unit chosen in the switcher + subtree)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const GR = { unit: null, tab: 'groups', groups: [], students: [], open: {}, members: {}, teachers: null, q: '', seq: 0, cal: [], imp: null,
    cons: null, cf: { status: 'all', kind: 'all', q: '' }, badge: 0 };
  const grUnit = () => (inViewAs() ? viewAs.unitId : (typeof currentOrgId !== 'undefined' && currentOrgId) || currentUser?.orgId || null);
  const unitName = id => (typeof orgsCache !== 'undefined' && orgsCache[id]?.name) || '';

  function renderGroups() {
    const root = $('gc-groups-root'); if (!root) return;
    const unit = grUnit();
    if (GR.unit !== unit) { GR.unit = unit; GR.open = {}; GR.members = {}; GR.teachers = null; GR.groups = []; GR.students = []; GR.cal = []; GR.cons = null; }
    if (!unit) { root.innerHTML = '<div class="gc-wrap"><div class="notice-card">Choose a unit in the switcher at the top.</div></div>'; return; }
    root.innerHTML = `<div class="gc-wrap">
      <header class="gc-head">
        <div><h1><span aria-hidden="true">👥</span> <span>Groups</span></h1>
          <p class="gc-sub"><span class="ctx-badge"><span>Unit:</span> <b data-no-i18n>${esc(unitName(unit))}</b></span> <span>Groups, their teacher and students. Students are free: they don't use seats.</span></p></div>
        <div class="gc-head-actions">
          <button type="button" class="tree-btn" data-gc="template">⬇ <span>CSV template</span></button>
          <button type="button" class="tree-btn" data-gc="import">⬆ <span>Import CSV</span></button>
          <button type="button" class="tree-btn" data-gc="add-student">+ <span>Add student</span></button>
          <button type="button" class="btn-create-inst" data-gc="new-group">+ New group</button>
        </div>
      </header>
      <div class="gc-toolbar"><div class="in-seg" role="tablist" aria-label="${esc(tr('Sections'))}">
        ${[['groups', 'Groups'], ['students', 'Students'], ['calendar', 'Calendar'], ['consents', 'Consents']].map(([k, l]) => `<button type="button" role="tab" data-gc="gtab" data-t="${k}" id="gc-tab-${k}" class="${GR.tab === k ? 'active' : ''}" aria-selected="${GR.tab === k}"><span>${l}</span>${k === 'consents' && GR.badge ? ` <span class="gc-tab-badge" data-no-i18n>${GR.badge > 99 ? '99+' : GR.badge}</span>` : ''}</button>`).join('')}
      </div>${GR.tab === 'students' ? `<input type="search" class="settings-input gc-search" id="gc-st-search" placeholder="Search by name, email or group" value="${esc(GR.q)}" autocomplete="off">` : ''}</div>
      <div id="gc-groups-body"><div class="in-loading">Loading…</div></div>
    </div>`;
    loadGroups();
    refreshConsentBadge();
  }
  async function loadGroups() {
    const unit = GR.unit; const seq = ++GR.seq;
    if (GR.tab === 'consents') {
      const c = await rpc('consent_overview', { p_unit: unit });
      if (seq !== GR.seq) return;
      if (c.error) { errToast(c.error); GR.cons = { people: [], declines: [] }; } else GR.cons = c.data || { people: [], declines: [] };
      markConsentsSeen(unit);
      renderGroupsBody();
      return;
    }
    const [g, s] = await Promise.all([rpc('list_groups', { p_unit: unit }), rpc('list_students', { p_unit: unit })]);
    if (seq !== GR.seq) return;
    if (g.error || s.error) { errToast(g.error || s.error); GR.groups = []; GR.students = []; }
    else { GR.groups = g.data || []; GR.students = s.data || []; }
    if (GR.tab === 'calendar') {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const c = await rpc('unit_calendar', { p_unit: unit, p_from: from.toISOString(), p_to: addDays(from, 28).toISOString() });
      if (seq !== GR.seq) return;
      GR.cal = c.error ? [] : (c.data || []);
    }
    await Promise.all(Object.keys(GR.open).filter(id => GR.open[id]).map(loadMembers));
    if (seq !== GR.seq) return;
    renderGroupsBody();
  }
  async function loadMembers(id) {
    const { data, error } = await rpc('list_group_members', { p_group: id });
    GR.members[id] = error ? [] : (data || []);
  }
  function renderGroupsBody() {
    const body = $('gc-groups-body'); if (!body) return;
    if (GR.tab === 'students') { body.innerHTML = studentsHtml(); return; }
    if (GR.tab === 'consents') { body.innerHTML = consentsHtml(); return; }
    if (GR.tab === 'calendar') { body.innerHTML = `<div class="gc-hint gc-ro">👁 <span>Read-only: the classes of this unit's groups for the next 4 weeks. Teachers schedule them in their Calendar.</span></div>${agendaHtml(GR.cal, { emptyText: 'No classes scheduled in the next 4 weeks.' })}`; return; }
    if (!GR.groups.length) {
      body.innerHTML = `<div class="bl-empty gc-empty-big"><div class="gs-empty-ico" aria-hidden="true">👥</div><b>No groups yet</b><p>Create a group (for example "English B1 – Tue/Thu"), assign its teacher and add students — one by one or from a CSV file.</p>
        <div class="gc-btn-row center"><button type="button" class="btn-create-inst" data-gc="new-group">+ New group</button><button type="button" class="tree-btn" data-gc="import">⬆ <span>Import CSV</span></button></div></div>`;
      return;
    }
    const other = GR.groups.filter(x => x.id);
    body.innerHTML = `<div class="gc-glist">${other.map(g => groupCardHtml(g)).join('')}</div>`;
  }
  const personHtml = p => p ? `<b data-no-i18n>${esc(p.name || p.email || '—')}</b>` : '<span class="gc-warn">Not assigned</span>';
  // invited, not registered yet: assigned by itself when they sign up (only admins get this email)
  const pendingHtml = p => `<span class="gc-pending"><span>Pending:</span> <b data-no-i18n>${esc(p.email)}</b> <span class="gc-muted">${p.invited ? '<span>(invited)</span>' : '<span>(not invited yet: no free seats)</span>'}</span></span>`;
  const IMP = () => window.TCImport;
  const humanSched = sch => (IMP() && sch ? IMP().humanSchedule(sch, uiLang === 'es' ? 'es' : 'en') : '');
  function groupCardHtml(g) {
    const open = !!GR.open[g.id]; const mem = GR.members[g.id];
    const moveOpts = GR.groups.filter(x => x.id !== g.id).map(x => `<option value="${esc(x.id)}" data-no-i18n>${esc(x.name)}${x.institution_id !== g.institution_id ? ' · ' + esc(x.unit_name) : ''}</option>`).join('');
    const members = !open ? '' : !mem ? '<div class="in-loading">Loading…</div>' : !mem.length ? '<div class="pb-empty">No students in this group yet.</div>'
      : `<table class="teachers-table gc-mtable"><thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${mem.map(m => `<tr>
          <td data-no-i18n>${esc(m.name || '—')}</td><td data-no-i18n class="gc-mail">${esc(m.email)}</td>
          <td>${m.linked ? '<span class="gc-chip ok">Signed in ✓</span>' : '<span class="gc-chip">Not yet</span>'}</td>
          <td class="gc-mact">${moveOpts ? `<select class="member-role gc-move-sel" aria-label="${esc(tr('Move to group'))}"><option value="">${esc(tr('Move to…'))}</option>${moveOpts}</select> <button type="button" class="tree-btn" data-gc="m-move" data-g="${esc(g.id)}" data-e="${esc(m.enrollment_id)}">Move</button>` : ''}
            <button type="button" class="tree-btn danger" data-gc="m-remove" data-g="${esc(g.id)}" data-e="${esc(m.enrollment_id)}">Remove</button></td></tr>`).join('')}</tbody></table>`;
    return `<div class="gc-gcard${open ? ' open' : ''}">
      <div class="gc-gtop">
        <div class="gc-gmain">
          <div class="gc-gname" data-no-i18n>${esc(g.name)}</div>
          <div class="gc-meta">${g.institution_id !== GR.unit ? `<span class="lvl-badge lvl-3" data-no-i18n>${esc(g.unit_name)}</span> ` : ''}<span>🕒</span> <span data-no-i18n>${esc(String(g.timezone).replace(/_/g, ' '))}</span>
            <span class="gs-dot">·</span> ${g.next_session ? `<span>Next class:</span> <span data-no-i18n>${esc(fDay(g.next_session))} ${esc(fTime(g.next_session))}</span>` : '<span>No classes scheduled</span>'}</div>
          <div class="gc-gpeople"><span>Teacher:</span> ${g.teacher ? personHtml(g.teacher) : g.pending_teacher ? pendingHtml(g.pending_teacher) : personHtml(null)} <span class="gs-dot">·</span> <span>Substitute:</span> ${g.substitute ? personHtml(g.substitute) : g.pending_substitute ? pendingHtml(g.pending_substitute) : '<span class="gc-muted">None</span>'}</div>
          ${g.schedule ? `<div class="gc-gsched"><span aria-hidden="true">🔁</span> <span data-no-i18n>${esc(humanSched(g.schedule))}</span>${g.schedule.timezone && g.schedule.timezone !== LOCAL_TZ ? ` <span class="gc-muted" data-no-i18n>(${esc(String(g.schedule.timezone).replace(/_/g, ' '))})</span>` : ''}</div>` : ''}
        </div>
        <div class="gc-gstat"><b>${Number(g.students) || 0}</b><span>students</span></div>
      </div>
      <div class="gc-gactions">
        <button type="button" class="tree-btn${open ? ' primary' : ''}" data-gc="g-members" data-id="${esc(g.id)}" aria-expanded="${open}">👥 <span>Students</span></button>
        <button type="button" class="tree-btn" data-gc="g-sessions" data-id="${esc(g.id)}">📄 <span>Classes &amp; documents</span></button>
        <button type="button" class="tree-btn" data-gc="g-att" data-id="${esc(g.id)}">✅ <span>Attendance</span></button>
        <button type="button" class="tree-btn" data-gc="add-student" data-g="${esc(g.id)}">+ <span>Add student</span></button>
        <button type="button" class="tree-btn" data-gc="g-edit" data-id="${esc(g.id)}">✏️ <span>Edit</span></button>
        <button type="button" class="tree-btn danger" data-gc="g-del" data-id="${esc(g.id)}">Delete</button>
      </div>
      ${open ? `<div class="gc-members">${members}</div>` : ''}
    </div>`;
  }
  function studentsHtml() {
    const q = normTxt(GR.q || '').trim();
    const list = GR.students.filter(s => !q || normTxt([s.name, s.email, s.unit_name, ...(s.groups || []).map(g => g.name)].join(' ')).includes(q));
    const gOpts = GR.groups.map(x => `<option value="${esc(x.id)}" data-no-i18n>${esc(x.name)}</option>`).join('');
    if (!GR.students.length) return '<div class="bl-empty">No students loaded in this unit yet.</div>';
    return `<div class="gc-hint"><b>${GR.students.length}</b> <span>students</span> <span class="gs-dot">·</span> <span>Only this institution sees the emails it loaded.</span></div>
      <div class="admin-card gc-tablecard"><table class="teachers-table gc-stable"><thead><tr><th>Name</th><th>Email</th><th>Groups</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr>
        <td data-no-i18n>${esc(s.name || '—')}</td><td data-no-i18n class="gc-mail">${esc(s.email)}</td>
        <td>${(s.groups || []).length ? s.groups.map(g => `<span class="gc-chip" data-no-i18n>${esc(g.name)}</span>`).join(' ') : '<span class="gc-muted">No group</span>'}${s.institution_id !== GR.unit ? ` <span class="lvl-badge lvl-3" data-no-i18n>${esc(s.unit_name)}</span>` : ''}</td>
        <td>${s.linked ? '<span class="gc-chip ok">Signed in ✓</span>' : '<span class="gc-chip">Not yet</span>'}</td>
        <td class="gc-mact">${gOpts ? `<select class="member-role gc-add-sel" aria-label="${esc(tr('Add to group'))}"><option value="">${esc(tr('Add to group…'))}</option>${gOpts}</select> <button type="button" class="tree-btn" data-gc="s-add" data-e="${esc(s.id)}">Add</button>` : ''}
          <button type="button" class="tree-btn danger" data-gc="s-remove" data-e="${esc(s.id)}">Remove</button></td></tr>`).join('') || `<tr><td colspan="5" class="muted-cell">${esc(tr('No students match your search.'))}</td></tr>`}
      </tbody></table></div>`;
  }
  // ── Consents (recording consent: one checkbox per person; 001_base.sql consent_overview) ──
  const CST = { granted: ['Granted', 'ok'], declined: ['Declined', 'err'], revoked: ['Revoked', 'warn'], pending: ['Pending', ''] };
  const seenKey = unit => 'tc-cons-seen:' + unit;
  function markConsentsSeen(unit) {
    try { localStorage.setItem(seenKey(unit), new Date().toISOString()); } catch (e) { /* private mode: the badge just stays */ }
    GR.badge = 0; setNavBadge(0);
    const t = $('gc-tab-consents')?.querySelector('.gc-tab-badge'); if (t) t.remove();
  }
  function setNavBadge(n) {
    const nav = $('nav-groups'); if (!nav) return;
    let b = nav.querySelector('.sib-badge');
    if (n > 0) {
      if (!b) { b = document.createElement('span'); b.className = 'sib-badge'; b.setAttribute('data-no-i18n', ''); nav.appendChild(b); }
      b.textContent = n > 99 ? '99+' : String(n);
      b.title = `${n} ${tr(n === 1 ? 'new justification (recording consent)' : 'new justifications (recording consent)')}`;
    } else if (b) b.remove();
  }
  // new "no" justifications since the admin last opened Consents (per unit, remembered in this browser)
  let badgeSeq = 0;
  async function refreshConsentBadge() {
    const nav = $('nav-groups'); if (!nav) return;
    const u = typeof currentUser !== 'undefined' ? currentUser : null;
    const unit = grUnit(); const seq = ++badgeSeq;
    if (!u || !(u.isOrgAdmin || u.isSuperAdmin) || !unit || nav.style.display === 'none') { GR.badge = 0; setNavBadge(0); return; }
    let since = null; try { since = localStorage.getItem(seenKey(unit)); } catch (e) { since = null; }
    const r = await rpc('consent_new_declines', { p_unit: unit, p_since: since });
    if (seq !== badgeSeq) return;
    const n = r.error ? 0 : Number(r.data) || 0;
    if (isActive('groups') && GR.tab === 'consents' && GR.unit === unit) { markConsentsSeen(unit); return; }
    GR.badge = n; setNavBadge(n);
    const tab = $('gc-tab-consents');
    if (tab) { let t = tab.querySelector('.gc-tab-badge'); if (n > 0) { if (!t) { t = document.createElement('span'); t.className = 'gc-tab-badge'; t.setAttribute('data-no-i18n', ''); tab.append(' ', t); } t.textContent = n > 99 ? '99+' : String(n); } else if (t) t.remove(); }
  }
  function consFiltered() {
    const d = GR.cons || { people: [], declines: [] }; const f = GR.cf; const q = normTxt(f.q || '').trim();
    const people = (d.people || []).filter(p => (f.status === 'all' || p.status === f.status) && (f.kind === 'all' || p.kind === f.kind)
      && (!q || normTxt([p.name, p.email, p.unit_name].join(' ')).includes(q)));
    const declines = (d.declines || []).filter(x => (f.kind === 'all' || x.role === f.kind) && (f.status === 'all' || f.status === 'declined')
      && (!q || normTxt([x.name, x.email, x.reason, x.class_title, x.unit_name].join(' ')).includes(q)));
    return { people, declines };
  }
  const consDate = d => (d ? `${fDay(d)} ${fTime(d)}` : '');
  const unitBadge = x => (x.unit_id && x.unit_id !== GR.unit && x.unit_name ? ` <span class="lvl-badge lvl-3" data-no-i18n>${esc(x.unit_name)}</span>` : '');
  function consentsHtml() {
    const d = GR.cons; if (!d) return '<div class="in-loading">Loading…</div>';
    const f = GR.cf;
    const opt = (v, l, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(tr(l))}</option>`;
    return `<div class="gc-hint">🎙️ <span>One consent per person: recording (audio only), AI analysis and storage. Each person is asked once; a "no" is asked again at their next class. Only this institution sees the people it loaded and the justifications addressed to it.</span></div>
      <div class="gc-cons-filters" role="group" aria-label="${esc(tr('Filters'))}">
        <label class="gc-cons-f"><span>Status</span><select id="gc-cons-status" class="member-role">${opt('all', 'All statuses', f.status)}${opt('granted', 'Granted', f.status)}${opt('declined', 'Declined', f.status)}${opt('revoked', 'Revoked', f.status)}${opt('pending', 'Pending', f.status)}</select></label>
        <label class="gc-cons-f"><span>Role</span><select id="gc-cons-kind" class="member-role">${opt('all', 'Everyone', f.kind)}${opt('student', 'Students', f.kind)}${opt('teacher', 'Teachers', f.kind)}</select></label>
        <input type="search" class="settings-input gc-search" id="gc-cons-search" placeholder="Search by name, email or class" value="${esc(f.q)}" autocomplete="off" aria-label="${esc(tr('Search by name, email or class'))}">
        <button type="button" class="tree-btn" data-gc="cons-csv">⬇ <span>Export CSV</span></button>
      </div>
      <div id="gc-cons-results">${consResultsHtml()}</div>`;
  }
  function consResultsHtml() {
    const d = GR.cons || { people: [] }; const f = GR.cf; const { people, declines } = consFiltered();
    const counts = { granted: 0, declined: 0, revoked: 0, pending: 0 }; (d.people || []).forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    const stats = `<div class="gc-cons-sum">${Object.keys(CST).map(k => `<button type="button" class="gc-cons-stat ${k}${f.status === k ? ' active' : ''}" data-gc="cons-stat" data-s="${k}" aria-pressed="${f.status === k}"><b data-no-i18n>${counts[k] || 0}</b><span>${CST[k][0]}</span></button>`).join('')}</div>`;
    const rows = people.map(p => `<tr>
        <td><span data-no-i18n>${esc(p.name || '—')}</span>${unitBadge(p)}</td><td data-no-i18n class="gc-mail">${esc(p.email || '')}</td>
        <td><span class="gc-chip">${p.kind === 'teacher' ? 'Teacher' : 'Student'}</span></td>
        <td><span class="gc-chip ${CST[p.status]?.[1] || ''}">${CST[p.status]?.[0] || 'Pending'}</span>${p.minor ? ` <span class="gc-chip" title="${esc(tr('Under 18: the guardian gave consent'))}">👪 <span>Under 18 · guardian ✓</span></span>` : ''}${!p.linked ? ' <span class="gc-muted">(<span>not signed in yet</span>)</span>' : ''}</td>
        <td data-no-i18n class="gc-cons-date">${esc(consDate(p.status_at))}</td></tr>`).join('');
    const people_ = `<h2 class="gc-cons-h"><span>People</span> <span class="gc-muted" data-no-i18n>(${people.length})</span></h2>
      ${(d.people || []).length ? `<div class="admin-card gc-tablecard"><table class="teachers-table gc-cons-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Date</th></tr></thead><tbody>
        ${rows || `<tr><td colspan="5" class="muted-cell">${esc(tr('No one matches these filters.'))}</td></tr>`}</tbody></table></div>` : '<div class="bl-empty">No people loaded in this unit yet.</div>'}`;
    const decl = `<h2 class="gc-cons-h"><span>Justifications</span> <span class="gc-muted" data-no-i18n>(${declines.length})</span></h2>
      ${declines.length ? `<ul class="gc-cons-decl">${declines.map(x => `<li class="gc-cons-item">
          <div class="gc-cons-top"><b data-no-i18n>${esc(x.name || '—')}</b> <span class="gc-chip">${x.role === 'teacher' ? 'Teacher' : 'Student'}</span>${unitBadge(x)} <span class="gc-muted gc-cons-when" data-no-i18n>${esc(consDate(x.created_at))}</span></div>
          ${x.class_title ? `<div class="gc-cons-class"><span>Class:</span> <span data-no-i18n>${esc(x.class_title)}${x.class_starts_at ? ' · ' + esc(fDay(x.class_starts_at)) : ''}</span></div>` : ''}
          <blockquote class="gc-cons-reason" data-no-i18n>${esc(x.reason)}</blockquote></li>`).join('')}</ul>`
        : `<div class="bl-empty">${esc(tr('No justifications yet.'))}</div>`}`;
    return stats + people_ + decl;
  }
  function consentsCsv() {
    const d = GR.cons; if (!d) return;
    const es = uiLang === 'es'; const sep = es ? ';' : ',';
    const q = v => { const x = String(v ?? ''); return /[",;\n\r]/.test(x) || /^[=+\-@\t]/.test(x) ? '"' + (/^[=+\-@\t]/.test(x) ? "'" : '') + x.replace(/"/g, '""') + '"' : x; };
    const { people } = consFiltered();
    const latest = p => (d.declines || []).filter(x => x.unit_id === p.unit_id && String(x.email || '').toLowerCase() === String(p.email || '').toLowerCase())[0];
    const head = ['Name', 'Email', 'Role', 'Unit', 'Status', 'Date', 'Under 18', 'Latest justification', 'Class'].map(tr);
    const rows = people.map(p => { const l = latest(p); return [p.name, p.email, tr(p.kind === 'teacher' ? 'Teacher' : 'Student'), p.unit_name, tr(CST[p.status]?.[0] || 'Pending'),
      p.status_at ? new Date(p.status_at).toISOString().slice(0, 16).replace('T', ' ') : '', p.minor ? tr('Yes') : '', l ? l.reason : '', l ? (l.class_title || '') : '']; });
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(q).join(sep)).join('\r\n') + '\r\n';
    download((es ? 'consentimientos-' : 'consents-') + String(unitName(GR.unit) || 'unidad').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + ymd(new Date()) + '.csv', csv, 'text/csv;charset=utf-8');
  }
  function rerenderConsResults() { const r = $('gc-cons-results'); if (r) r.innerHTML = consResultsHtml(); }

  // teachers this admin can assign (teachers + admins of the same main institution that they manage)
  async function loadTeachers(unit) {
    if (GR.teachers) return GR.teachers;
    const root = (typeof hierPath === 'function' ? hierPath(unit)[0]?.id : null) || unit;
    const ids = Object.keys(orgsCache || {}).filter(id => ((typeof hierPath === 'function' ? hierPath(id)[0]?.id : null) || id) === root);
    if (!ids.length) { GR.teachers = []; return GR.teachers; }
    const { data } = await sb.from('profiles').select('id,name,email,role,institution_id').in('institution_id', ids);
    GR.teachers = (data || []).filter(p => p.role === 'teacher' || p.role === 'org_admin').sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    return GR.teachers;
  }
  async function groupForm(id) {
    if (blocked()) return;
    const g = id ? GR.groups.find(x => x.id === id) : null;
    const unit = GR.unit; const units = (typeof hierSubtreeIds === 'function' ? hierSubtreeIds(unit) : [unit]).filter(u => orgsCache[u]);
    GR.teachers = null; // always fresh: someone may have just registered
    const teachers = await loadTeachers(unit);
    // invited but not registered yet: can be chosen now; assigned by itself when they sign up
    let pending = [];
    try {
      const root = (typeof hierPath === 'function' ? hierPath(unit)[0]?.id : null) || unit;
      const ids = Object.keys(orgsCache || {}).filter(x => ((typeof hierPath === 'function' ? hierPath(x)[0]?.id : null) || x) === root);
      if (ids.length) { const r = await sb.from('invitations').select('email,role').in('institution_id', ids).is('accepted_at', null); pending = (r.data || []).map(x => String(x.email || '').toLowerCase()).filter(Boolean); }
    } catch (e) { pending = []; }
    const known = new Set(teachers.map(t => String(t.email || '').toLowerCase()));
    pending = [...new Set(pending)].filter(e => !known.has(e)).sort();
    const pendingHint = '';
    // value: a profile id · "email:<address>" (invited, pending) · "__new" (invite someone by email)
    const tOpts = (sel, selPending, none) => {
      const pend = [...new Set([...(selPending ? [selPending] : []), ...pending])];
      return `<option value="">${esc(tr(none))}</option>`
        + (teachers.length ? `<optgroup label="${esc(tr('Registered'))}">` + teachers.map(t => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''} data-no-i18n>${esc(t.name || t.email)}${t.name ? ' · ' + esc(t.email) : ''}</option>`).join('') + '</optgroup>' : '')
        + (sel && !teachers.some(t => t.id === sel) ? `<option value="${esc(sel)}" selected data-no-i18n>${esc((g?.teacher?.id === sel ? g.teacher : g?.substitute)?.name || '—')}</option>` : '')
        + (pend.length ? `<optgroup label="${esc(tr('Invited (not registered yet)'))}">` + pend.map(e => `<option value="email:${esc(e)}"${e === selPending ? ' selected' : ''} data-no-i18n>${esc(e)} ${esc(tr('(invited)'))}</option>`).join('') + '</optgroup>' : '')
        + `<option value="__new">${esc(tr('Invite someone by email…'))}</option>`;
    };
    const tz = g?.timezone || 'America/Montevideo';
    const tzs = [...new Set([tz, ...TZ_LIST, LOCAL_TZ])];
    modal(`<div class="modal-title" id="gc-modal-title">${g ? 'Edit group' : 'New group'}</div>
      <div class="modal-sub">${g ? '' : '<span>A group has one teacher and, optionally, one substitute with the same access to its classes.</span>'}</div>
      <form data-gcf="group" data-id="${esc(id || '')}">
        <div class="modal-field"><label class="modal-label" for="gc-g-name">Group name</label><input id="gc-g-name" class="modal-input" maxlength="120" required value="${esc(g?.name || '')}" placeholder="${esc(tr('e.g. English B1 – Tue/Thu'))}" data-autofocus></div>
        ${g ? '' : `<div class="modal-field"><label class="modal-label" for="gc-g-unit">Unit</label><select id="gc-g-unit" class="modal-input">${units.map(u => `<option value="${esc(u)}" data-no-i18n${u === unit ? ' selected' : ''}>${esc(hierPathLabel(u) || unitName(u))}</option>`).join('')}</select></div>`}
        <div class="gc-form-row">
          <div class="modal-field"><label class="modal-label" for="gc-g-teacher">Teacher</label><select id="gc-g-teacher" class="modal-input" data-newfor="gc-g-teacher-new">${tOpts(g?.teacher?.id || '', g?.pending_teacher?.email || '', 'Not assigned yet')}</select>
            <input id="gc-g-teacher-new" type="email" class="modal-input gc-newmail" placeholder="${esc(tr('teacher@school.edu'))}" hidden></div>
          <div class="modal-field"><label class="modal-label" for="gc-g-sub">Substitute (optional)</label><select id="gc-g-sub" class="modal-input" data-newfor="gc-g-sub-new">${tOpts(g?.substitute?.id || '', g?.pending_substitute?.email || '', 'No substitute')}</select>
            <input id="gc-g-sub-new" type="email" class="modal-input gc-newmail" placeholder="${esc(tr('teacher@school.edu'))}" hidden></div>
        </div>
        <div class="gc-hint gc-hint-block">Someone who is not registered yet gets an invitation as teacher of this unit and stays as "Pending" until they sign up.</div>
        <div class="modal-field"><label class="modal-label" for="gc-g-tz">Time zone</label><select id="gc-g-tz" class="modal-input">${tzs.map(z => `<option value="${esc(z)}"${z === tz ? ' selected' : ''} data-no-i18n>${esc(tzLabel(z))}</option>`).join('')}</select></div>
        ${teachers.length || pending.length ? '' : '<div class="gc-hint">No teachers registered yet: choose "Invite someone by email…".</div>'}${pendingHint}
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Cancel</button><button type="submit" class="btn-modal-save">${g ? 'Save' : 'Create group'}</button></div>
      </form>`);
  }
  async function submitGroup(form) {
    if (blocked()) return;
    const id = form.dataset.id || null; const btn = form.querySelector('[type=submit]');
    const name = $('gc-g-name').value.trim(); const tz = $('gc-g-tz').value;
    const pick = (selId, newId) => { // → {id} | {email} | {} | {bad}
      const v = $(selId).value || '';
      if (!v) return {};
      if (v === '__new') { const e = ($(newId).value || '').trim().toLowerCase(); return EMAIL_RE.test(e) ? { email: e } : { bad: e || '—' }; }
      if (v.startsWith('email:')) return { email: v.slice(6) };
      return { id: v };
    };
    const t = pick('gc-g-teacher', 'gc-g-teacher-new'); const sb2 = pick('gc-g-sub', 'gc-g-sub-new');
    if (!name) { showToast('The group needs a name.', 'err'); return; }
    if (t.bad || sb2.bad) { showToast(`Invalid email: ${t.bad || sb2.bad}`, 'err'); return; }
    if ((t.id && t.id === sb2.id) || (t.email && t.email === sb2.email)) { showToast('The substitute must be a different person.', 'err'); return; }
    const args = { p_name: name, p_teacher: t.id || null, p_substitute: sb2.id || null, p_timezone: tz, p_teacher_email: t.email || null, p_substitute_email: sb2.email || null };
    busy(btn, true);
    const { error } = id ? await rpc('update_group', { p_group: id, ...args }) : await rpc('create_group', { p_unit: $('gc-g-unit').value, ...args });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); showToast(t.email || sb2.email ? 'Group saved ✓ The invited person is assigned when they register.' : (id ? 'Group saved ✓' : 'Group created ✓'), 'ok', 5000); loadGroups();
  }
  function addStudentForm(groupId) {
    if (blocked()) return;
    modal(`<div class="modal-title" id="gc-modal-title">Add student</div>
      <div class="modal-sub">Students sign in with this email (a link, no password). They are free: they don't use seats.</div>
      <form data-gcf="student">
        <div class="modal-field"><label class="modal-label" for="gc-a-email">Email</label><input id="gc-a-email" type="email" class="modal-input" required placeholder="student@email.com" data-autofocus></div>
        <div class="modal-field"><label class="modal-label" for="gc-a-name">Full name</label><input id="gc-a-name" class="modal-input" maxlength="120" placeholder="${esc(tr('e.g. Ana Pérez'))}"></div>
        <div class="modal-field"><label class="modal-label" for="gc-a-group">Group (optional)</label><select id="gc-a-group" class="modal-input"><option value="">${esc(tr('— No group for now —'))}</option>${GR.groups.map(x => `<option value="${esc(x.id)}"${x.id === groupId ? ' selected' : ''} data-no-i18n>${esc(x.name)}</option>`).join('')}</select></div>
        <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Cancel</button><button type="submit" class="btn-modal-save">Add</button></div>
      </form>`);
  }
  async function submitStudent(form) {
    if (blocked()) return;
    const email = $('gc-a-email').value.trim(); const name = $('gc-a-name').value.trim(); const group = $('gc-a-group').value || null;
    if (!EMAIL_RE.test(email)) { showToast(`Invalid email: ${email || '—'}`, 'err'); return; }
    const btn = form.querySelector('[type=submit]'); busy(btn, true);
    const { data, error } = await rpc('add_student', { p_unit: GR.unit, p_email: email, p_name: name, p_group: group });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); showToast(data?.created ? 'Student added ✓' : 'That student was already loaded: updated ✓', 'ok');
    if (group) GR.open[group] = true;
    loadGroups();
  }
  async function memberAction(kind, el) {
    if (blocked()) return;
    const g = el.dataset.g; const e = el.dataset.e;
    if (kind === 'm-move') {
      const to = el.parentElement.querySelector('.gc-move-sel')?.value;
      if (!to) { showToast('Choose the destination group.', 'err'); return; }
      busy(el, true); const { error } = await rpc('move_student', { p_enrollment: e, p_from_group: g, p_to_group: to }); busy(el, false);
      if (error) { errToast(error); return; }
      GR.open[to] = true; showToast('Student moved ✓', 'ok');
    } else if (kind === 'm-remove') {
      if (!twoClick('mr' + g + e, el, tr('Click again to remove'))) return;
      busy(el, true); const { error } = await rpc('group_remove_student', { p_group: g, p_enrollment: e }); busy(el, false);
      if (error) { errToast(error); return; }
      showToast('Removed from the group', 'ok');
    } else if (kind === 's-add') {
      const to = el.parentElement.querySelector('.gc-add-sel')?.value;
      if (!to) { showToast('Choose the destination group.', 'err'); return; }
      busy(el, true); const { error } = await rpc('group_add_student', { p_group: to, p_enrollment: e }); busy(el, false);
      if (error) { errToast(error); return; }
      showToast('Added to the group ✓', 'ok');
    } else if (kind === 's-remove') {
      if (!twoClick('sr' + e, el, tr('Click again: removes them from this unit'))) return;
      busy(el, true); const { error } = await rpc('remove_student', { p_enrollment: e }); busy(el, false);
      if (error) { errToast(error); return; }
      showToast('Student removed', 'ok');
    }
    loadGroups();
  }
  async function deleteGroup(id, btn) {
    if (blocked()) return;
    if (!twoClick('gd' + id, btn, tr('Click again: deletes the group and its classes'))) return;
    busy(btn, true); const { error } = await rpc('delete_group', { p_group: id }); busy(btn, false);
    if (error) { errToast(error); return; }
    delete GR.open[id]; showToast('Group deleted', 'ok'); loadGroups();
  }

  // ── CSV import (parser: public/csv-import.js → window.TCImport) ──
  const csvToRows = (text, opts) => IMP().csvToRows(text, opts);
  const parseCsv = text => IMP().parseCsv(text);
  function importDialog() {
    if (blocked()) return;
    GR.imp = null;
    modal(`<div class="modal-title" id="gc-modal-title">Import groups and students (CSV)</div>
      <div class="modal-sub"><span>One row per student. The group's schedule, teacher and substitute can go on any row of the group (or on a row without a student). We create the groups, enroll the students and put the classes in each teacher's calendar.</span></div>
      <div class="gc-import-drop">
        <label class="tree-btn primary gc-file"><input type="file" id="gc-imp-file" accept=".csv,text/csv,text/plain" hidden>📄 <span>Choose a CSV file</span></label>
        <span class="gc-imp-file-name" id="gc-imp-file-name" data-no-i18n></span>
        <button type="button" class="tree-btn" data-gc="template">⬇ <span>Download the template</span></button>
      </div>
      <details class="gc-imp-help" open><summary>Accepted columns</summary>
        <ul>
          <li><b data-no-i18n>email</b> · <b data-no-i18n>nombre / name</b> · <b data-no-i18n>grupo / group</b> — <span>the student (email can be empty on a row that only defines a group)</span></li>
          <li><b data-no-i18n>docente / teacher_email</b> · <b data-no-i18n>suplente / substitute</b> — <span>if they are not registered yet, we invite them and assign them when they sign up</span></li>
          <li><b data-no-i18n>días / days</b> — <span>e.g. "Lun;Mié", "L,Mi", "lunes y miércoles", "Mon/Wed", "LMi" ("Mi" = Wednesday, "Ma" = Tuesday)</span></li>
          <li><b data-no-i18n>hora_inicio / start_time</b> · <b data-no-i18n>hora_fin / end_time</b> <span>or</span> <b data-no-i18n>duración / duration</b> — <span>e.g. 07:00, 7am, 19:30; minutes</span></li>
          <li><b data-no-i18n>desde / start_date</b> · <b data-no-i18n>hasta / end_date</b> — <span>day/month/year (3/3/2027) or 2027-03-03; up to one year</span></li>
          <li><b data-no-i18n>zona / timezone</b> · <b data-no-i18n>unidad / unit</b> — <span>optional (default: the group's time zone, America/Montevideo)</span></li>
        </ul>
        <div class="gc-hint">Headers in Spanish or English, any order; capitals and accents don't matter. Up to 2,000 rows. Importing the same file again doesn't duplicate anything.</div>
      </details>
      <div class="modal-field"><label class="modal-label" for="gc-imp-text">…or paste the rows here</label><textarea id="gc-imp-text" class="modal-input gc-imp-text" rows="6" placeholder="email,nombre,grupo,docente,dias,hora_inicio,hora_fin,desde,hasta&#10;ana@example.com,Ana Pérez,INEFOP A1.1,docente@escuela.edu.uy,Lun;Mié,07:00,08:00,3/3/2027,30/11/2027" data-no-i18n></textarea></div>
      <div class="gc-hint">Excel: File → Save as → CSV UTF-8. Comma or semicolon both work.</div>
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="close">Cancel</button><button type="button" class="btn-modal-save" data-gc="imp-check">Check file →</button></div>`, { wide: true });
  }
  const IMP_CODES = { missing_email: 'Missing email', bad_email: 'Invalid email', duplicate: 'Repeated in the file', unknown_unit: 'Unknown unit',
    ambiguous_unit: 'More than one unit with that name: use its slug', unknown_teacher: 'Teacher not found in your institution', unknown_group: 'Unknown group', bad_group: 'Group name too long',
    unknown_substitute: 'Substitute not found in your institution', missing_group: 'Schedule or substitute without a group', same_person: 'Teacher and substitute are the same person',
    bad_schedule: 'Invalid schedule', ambiguous_day: 'Ambiguous day: "M" can be Tuesday or Wednesday (use Ma / Mi)', bad_days: 'Unknown days', bad_time: 'Invalid start time',
    bad_end_time: 'Invalid end time', bad_duration: 'Invalid duration (5 to 720 minutes)', time_conflict: 'End time and duration don\'t match', bad_date: 'Invalid start date',
    bad_end_date: 'Invalid end date', date_mdy: 'Looks like month/day: write day/month (e.g. 25/04/2027)', end_before_start: 'The end date is before the start date',
    range_too_long: 'More than one year', bad_tz: 'Unknown time zone', bad_teacher_email: 'Invalid teacher email', bad_substitute_email: 'Invalid substitute email' };
  const FIELD_LABEL = { teacher_email: 'teacher', substitute_email: 'substitute', weekdays: 'days', start_time: 'start time', duration_min: 'duration / end time',
    start_date: 'start date', end_date: 'end date', timezone: 'time zone' };
  async function importCheck(btn) {
    const text = $('gc-imp-text')?.value || '';
    if (!IMP()) { showToast('Error', 'err'); return; }
    const parsed = csvToRows(text);
    if (parsed.error) { showToast(parsed.error, 'err'); return; }
    busy(btn, true);
    const { data, error } = await rpc('import_students', { p_unit: GR.unit, p_rows: IMP().toRpcRows(parsed.rows), p_create_groups: true, p_commit: false });
    busy(btn, false);
    if (error) { errToast(error); return; }
    GR.imp = { rows: parsed.rows, ignored: parsed.ignored || [], preview: data, create: true, text };
    renderImportPreview();
  }
  function personChip(p, kind) {
    if (!p) return kind === 'teacher' ? '<span class="gc-warn">Not assigned</span>' : '<span class="gc-muted">None</span>';
    const who = p.email ? `<b data-no-i18n>${esc(p.name || p.email)}</b>${p.name && p.email ? ` <span class="gc-muted" data-no-i18n>${esc(p.email)}</span>` : ''}` : `<b data-no-i18n>${esc(p.name || '—')}</b>`;
    const st = {
      registered: '<span class="gc-chip ok">Registered ✓</span>', current: '<span class="gc-chip">Already assigned</span>',
      invite: '<span class="gc-chip warn">Not registered: will be invited</span>', invited: '<span class="gc-chip warn">Invited, not registered yet</span>',
      add: '<span class="gc-chip new">Has an account: will be added as teacher</span>', pending: '<span class="gc-chip warn">Pending (invited)</span>',
      kept: `<span class="gc-chip warn">The group already has another teacher (kept)</span> <span class="gc-muted" data-no-i18n>${esc(p.current || '')}</span>`,
    }[p.status] || '';
    return `${who} ${st}${p.seats_full ? ' <span class="gc-chip err">No free seats: stays pending, not invited</span>' : ''}`;
  }
  function scheduleHtml(g) {
    const tzNote = g.timezone && g.timezone !== LOCAL_TZ ? ` <span class="gc-muted" data-no-i18n>(${esc(String(g.timezone).replace(/_/g, ' '))})</span>` : '';
    const sched = g.schedule ? `<span class="gc-imp-when" data-no-i18n>${esc(humanSched(g.schedule))}</span>${tzNote}` : '';
    switch (g.schedule_status) {
      case 'new': return `${sched} <span class="gc-chip new">New schedule</span>`;
      case 'unchanged': return `${sched} <span class="gc-chip">Same schedule: nothing changes</span>`;
      case 'changed': return `<span class="gc-chip warn">Schedule changes</span> <span class="gc-muted"><span>Before:</span> <s data-no-i18n>${esc(humanSched(g.previous))}</s></span> → ${sched}
        <div class="gc-hint">Only future classes that weren't edited one by one move. Past classes never change.</div>`;
      case 'error': {
        const msg = g.schedule_error === 'schedule_incomplete' ? `<span>Incomplete schedule, missing:</span> <b>${(g.missing || []).map(m => `<span>${esc(tr(FIELD_LABEL[m] || m))}</span>`).join(', ')}</b>`
          : `<span>${esc(tr({ end_before_start: 'The end date is before the start date', range_too_long: 'More than one year', no_dates: 'No future class in that range' }[g.schedule_error] || 'Invalid schedule'))}</span>`;
        return `<span class="gc-chip err">No classes</span> ${msg}`;
      }
      default: return '<span class="gc-muted">No schedule in the file</span>';
    }
  }
  function renderImportPreview() {
    const p = GR.imp.preview || {}; const newG = p.new_groups || []; const groups = p.groups || [];
    const create = GR.imp.create;
    const willAdd = (create ? (p.ok || 0) : (p.ok || 0) - (p.new_group_rows || 0));
    const live = groups.filter(g => g.exists || create);
    const classes = live.reduce((n, g) => n + (['new', 'changed'].includes(g.schedule_status) ? Number(g.classes) || 0 : 0), 0);
    const work = willAdd > 0 || live.some(g => (!g.exists) || ['new', 'changed'].includes(g.schedule_status)
      || ['invite', 'add'].includes(g.teacher?.status) || ['invite', 'add'].includes(g.substitute?.status) || g.teacher?.assign || g.substitute?.assign);
    // classes per teacher (the end of the funnel)
    const per = {};
    live.forEach(g => { const t = g.teacher; const key = t ? (t.email || t.name || '?') : ''; const label = t ? (t.name || t.email || '—') : '';
      const n = ['new', 'changed', 'unchanged'].includes(g.schedule_status) ? Number(g.classes) || 0 : 0;
      per[key] = per[key] || { label, pending: t && ['invite', 'invited', 'pending', 'add'].includes(t.status), classes: 0, groups: 0 }; per[key].classes += n; per[key].groups++; });
    const n = (k, one, many) => `<b>${k}</b> <span>${k === 1 ? one : many}</span>`;
    const perHtml = Object.entries(per).map(([k, v]) => `<li>${k ? `<b data-no-i18n>${esc(v.label)}</b>${v.pending ? ' <span class="gc-chip warn">Pending</span>' : ''}` : '<span class="gc-warn">Not assigned</span>'}: ${n(v.classes, 'class', 'classes')} · ${n(v.groups, 'group', 'groups')}</li>`).join('');
    const stChip = r => r.status === 'error' ? `<span class="gc-chip err">${r.code === 'conflict' ? `<span>${esc(tr('Conflicts with another row of the same group:'))}</span> <span>${esc(tr(FIELD_LABEL[r.field] || r.field || ''))}</span>` : esc(tr(IMP_CODES[r.code] || 'Error'))}</span>`
      : r.status === 'exists' ? '<span class="gc-chip">Already loaded</span>'
      : r.status === 'group_only' ? '<span class="gc-chip new">Group details (no student)</span>'
      : r.status === 'new_group' ? (create ? '<span class="gc-chip new">Group to create</span>' : '<span class="gc-chip err">Skipped: unknown group</span>')
      : '<span class="gc-chip ok">Will be added</span>';
    const clientWarn = line => { const r = GR.imp.rows.find(x => x.line === line); return r?.warnings?.includes('date_no_year') ? ' <span class="gc-chip warn">Date without year: this year</span>' : ''; };
    modal(`<div class="modal-title" id="gc-modal-title">Check before importing</div>
      <div class="gc-funnel" aria-label="${esc(tr('Summary'))}">
        <div class="gc-fstep"><b>${p.total || 0}</b><span>rows</span></div><span class="gc-farrow" aria-hidden="true">→</span>
        <div class="gc-fstep"><b>${live.length}</b><span>groups</span></div><span class="gc-farrow" aria-hidden="true">→</span>
        <div class="gc-fstep"><b>${classes}</b><span>classes to create</span></div><span class="gc-farrow" aria-hidden="true">→</span>
        <div class="gc-fstep wide"><span class="gc-fhead">Classes per teacher</span><ul class="gc-fper">${perHtml || '<li class="gc-muted">—</li>'}</ul></div>
      </div>
      <div class="gc-imp-sum">
        <div class="metric-card"><div class="metric-label">Rows</div><div class="metric-value">${p.total || 0}</div></div>
        <div class="metric-card ok"><div class="metric-label">To add</div><div class="metric-value">${Math.max(willAdd, 0)}</div></div>
        <div class="metric-card"><div class="metric-label">Already loaded</div><div class="metric-value">${p.exists || 0}</div></div>
        <div class="metric-card${p.errors ? ' err' : ''}"><div class="metric-label">With errors</div><div class="metric-value">${p.errors || 0}</div></div>
      </div>
      ${newG.length ? `<label class="switch-row gc-imp-newg"><input type="checkbox" id="gc-imp-create"${create ? ' checked' : ''}> <span>Create the new groups:</span> <b data-no-i18n>${esc(newG.map(g => g.name + (g.unit && g.unit !== unitName(GR.unit) ? ' (' + g.unit + ')' : '')).join(', '))}</b></label>` : ''}
      ${GR.imp.ignored.length ? `<div class="gc-hint"><span>Columns we don't use (ignored):</span> <span data-no-i18n>${esc(GR.imp.ignored.join(', '))}</span></div>` : ''}
      ${groups.length ? `<div class="gc-sec-title">Groups</div><div class="gc-imp-groups">${groups.map(g => `
        <div class="gc-imp-g${g.exists || create ? '' : ' skipped'}" data-key="${esc(g.key)}">
          <div class="gc-imp-ghead"><b class="gc-imp-gname" data-no-i18n>${esc(g.name)}</b>${g.unit && g.unit !== unitName(GR.unit) ? ` <span class="lvl-badge lvl-3" data-no-i18n>${esc(g.unit)}</span>` : ''}
            ${g.exists ? '<span class="gc-chip">Existing group</span>' : (create ? '<span class="gc-chip new">New group</span>' : '<span class="gc-chip err">Skipped: unknown group</span>')}
            <span class="gc-imp-gnums">${(c => `<b class="gc-imp-classes">${c}</b> <span>${c === 1 ? 'class' : 'classes'}</span>`)(['new', 'changed', 'unchanged'].includes(g.schedule_status) ? Number(g.classes) || 0 : 0)} · ${(c => `<b class="gc-imp-students">${c}</b> <span>${c === 1 ? 'student' : 'students'}</span>`)(Number(g.students) || 0)}</span></div>
          <div class="gc-imp-gline"><span class="gc-imp-k">Teacher:</span> ${personChip(g.teacher, 'teacher')}</div>
          <div class="gc-imp-gline"><span class="gc-imp-k">Substitute:</span> ${personChip(g.substitute, 'substitute')}</div>
          <div class="gc-imp-gline gc-imp-sched"><span class="gc-imp-k">Schedule:</span> ${scheduleHtml(g)}</div>
          ${Number(g.past_skipped) > 0 && ['new', 'changed'].includes(g.schedule_status) ? `<div class="gc-hint"><b>${Number(g.past_skipped)}</b> <span>dates already passed are skipped: only future classes are created.</span></div>` : ''}
          ${Number(g.other_classes) > 0 ? `<div class="gc-hint"><span>This group already has other scheduled classes:</span> <b>${Number(g.other_classes)}</b></div>` : ''}
        </div>`).join('')}</div>` : ''}
      ${p.errors ? '<div class="gc-hint">Rows with errors are skipped. Fix them in the file and import it again whenever you want.</div>' : ''}
      <div class="gc-sec-title">Rows</div>
      <div class="gc-imp-table"><table class="teachers-table"><thead><tr><th>Line</th><th>Email</th><th>Name</th><th>Group</th><th>Status</th></tr></thead><tbody>
        ${(p.rows || []).map(r => `<tr class="${r.status === 'error' ? 'err' : ''}"><td>${Number(r.line) || ''}</td><td data-no-i18n class="gc-mail">${esc(r.email || '—')}</td><td data-no-i18n>${esc(r.name || '')}</td><td data-no-i18n>${esc(r.group || '')}${r.unit && r.unit !== unitName(GR.unit) ? ` <span class="gc-muted">${r.group ? '· ' : ''}${esc(r.unit)}</span>` : ''}</td>
          <td>${stChip(r)}${r.warning === 'teacher_ignored' ? ' <span class="gc-chip warn">The group already has another teacher (kept)</span>' : ''}${clientWarn(r.line)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="modal-actions"><button type="button" class="btn-modal-cancel" data-gc="import">← Back</button><button type="button" class="btn-modal-save" data-gc="imp-commit"${work ? '' : ' disabled'}><span>Import</span> <b>${Math.max(willAdd, 0)}</b></button></div>`, { wide: true });
  }
  async function importCommit(btn) {
    if (blocked() || !GR.imp) return;
    busy(btn, true);
    const { data, error } = await rpc('import_students', { p_unit: GR.unit, p_rows: IMP().toRpcRows(GR.imp.rows), p_create_groups: !!GR.imp.create, p_commit: true });
    busy(btn, false);
    if (error) { errToast(error); return; }
    closeGc(); GR.imp = null;
    const base = `Imported ✓ ${data?.ok || 0} added, ${data?.exists || 0} already there, ${data?.errors || 0} skipped`;
    showToast(Number(data?.classes) > 0 ? `${base} · ${data.classes} classes scheduled` : base, 'ok', 7000);
    loadGroups();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // VIEW AS → STUDENT (super admin): unit → group → (optional) student
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const VA = { groups: [], members: [], seq: 0 };
  async function vaLoadStudentPick(unit) {
    const gsel = $('va-group'); const psel = $('va-person'); const seq = ++VA.seq;
    gsel.innerHTML = `<option value="">${esc(tr('Choose a group'))}</option>`;
    psel.innerHTML = `<option value="">${esc(tr('Generic student of this group'))}</option>`;
    VA.groups = []; VA.members = [];
    if (!unit) return;
    const { data } = await rpc('list_groups', { p_unit: unit });
    if (seq !== VA.seq) return;
    VA.groups = data || [];
    gsel.innerHTML = `<option value="">${esc(tr(VA.groups.length ? 'Choose a group' : 'This unit has no groups yet'))}</option>` + VA.groups.map(g => `<option value="${esc(g.id)}" data-no-i18n>${esc(g.name)}${g.institution_id !== unit ? ' · ' + esc(g.unit_name) : ''}</option>`).join('');
  }
  async function vaLoadStudents() {
    const gid = $('va-group')?.value || ''; const psel = $('va-person'); const seq = ++VA.seq;
    psel.innerHTML = `<option value="">${esc(tr('Generic student of this group'))}</option>`; VA.members = [];
    if (!gid) return;
    const { data } = await rpc('list_group_members', { p_group: gid });
    if (seq !== VA.seq) return;
    VA.members = data || [];
    psel.innerHTML += VA.members.map(m => `<option value="${esc(m.enrollment_id)}" data-no-i18n>${esc(m.name || m.email)}${m.name ? ' · ' + esc(m.email) : ''}</option>`).join('');
  }
  async function vaStartStudent(unit) {
    const gid = $('va-group')?.value || '';
    if (!gid) { showToast('Choose a group first.', 'err'); return; }
    const g = VA.groups.find(x => x.id === gid);
    const pid = $('va-person')?.value || '';
    const m = pid ? VA.members.find(x => x.enrollment_id === pid) : null;
    await enterViewAs({ unitId: unit, perspective: 'student', group: g ? { id: g.id, name: g.name } : { id: gid, name: '' },
      person: m ? { id: m.enrollment_id, name: m.name || '', email: m.email || '' } : null });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ROUTING, DEEP LINKS, EVENTS
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const isActive = n => !!document.getElementById('panel-' + n)?.classList.contains('active');
  function render(name) {
    if (name === 'calendar') renderCalendar();
    else if (name === 'groups') renderGroups();
    else if (name === 'student') renderStudent();
  }
  function onLang() {
    if (isActive('calendar')) renderCalendar();
    if (isActive('groups')) renderGroupsBody();
    if (isActive('student') && ST.data) renderStudentHtml();
  }
  let pendingSession = (() => { const m = /[?&]session=([0-9a-f-]{36})/i.exec(location.search); return m && UUID_RE.test(m[1]) ? m[1] : null; })();
  function clearDeepLink() {
    pendingSession = null;
    try { const u = new URL(location.href); u.searchParams.delete('session'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); } catch (e) { /* ignore */ }
  }
  function afterEnter() {
    if (!pendingSession || inViewAs()) return;
    const isAdminMode = typeof appMode !== 'undefined' && appMode === 'admin';
    if (isAdminMode && typeof setAppMode === 'function') setAppMode('teacher', { stay: true });
    showPanel('calendar');
  }
  function handleDeepLink() {
    if (!pendingSession) return;
    const id = pendingSession;
    if (studentMode && ST.data) {
      clearDeepLink();
      const row = document.querySelector(`.gs-item[data-sid="${CSS.escape(id)}"]`);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2500); }
      return;
    }
    if (CAL.loaded && isActive('calendar')) {
      if (CAL.rows.some(r => r.id === id)) { clearDeepLink(); openSessionDetail(id); }
      else if (!CAL._deepTried) { // the class may be in another week: show the agenda from today
        CAL._deepTried = true; CAL.view = 'agenda'; CAL.anchor = startOfWeek(new Date()); renderCalendar();
      } else clearDeepLink();
    }
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-gc]');
    if (!el) { if (e.target.id === 'modal-gc') closeGc(); return; }
    const a = el.dataset.gc; const id = el.dataset.id;
    switch (a) {
      case 'close': closeGc(); break;
      case 'logout': if (typeof handleLogout === 'function') handleLogout(); break;
      case 'st-reload': ST.data = null; ST.error = null; renderStudent(); break;
      case 'join': join(id); break;
      case 'doc': if (window.TCClassDoc) window.TCClassDoc.open(id); else showToast('Error', 'err'); break;
      case 'g-sessions': if (window.TCAttendance) window.TCAttendance.openGroupSessions(id); break;
      case 'g-att': if (window.TCAttendance) window.TCAttendance.openReport(id); break;
      case 'att-report': if (window.TCAttendance) window.TCAttendance.openReport(el.dataset.g, { back: () => openSessionDetail(id) }); break;
      case 'ins-open': if (window.TCInsightsPanel) window.TCInsightsPanel.openMine(id); break;
      case 'ins-all': showPanel('insights'); break;
      case 'ins-view': { const s = findRow(id); closeGc(); if (window.TCInsightsPanel) window.TCInsightsPanel.openSession(id, { unit: s?.role === 'admin' }); break; }
      case 'ins-gen': {
        const s = findRow(id); if (!s || !window.TCInsightsPanel) break;
        window.TCInsightsPanel.generate(id, { title: sTitle(s), group: s.group_name || '' }, el).then(ok => { if (ok) { closeGc(); window.TCInsightsPanel.openSession(id, { unit: s.role === 'admin' }); } });
        break;
      }
      case 'ics': { const s = findRow(id); if (s) download(`teroclass-${ymd(new Date(s.starts_at))}.ics`, sessionIcs(s), 'text/calendar;charset=utf-8'); break; }
      case 'subscribe': subscribeDialog(); break;
      case 'copy-feed': copyText($('gc-feed-url')?.value || '').then(ok => showToast(ok ? 'Link copied ✓' : 'Could not copy: select the link and copy it.', ok ? 'ok' : 'err')); break;
      case 'reset-feed': resetFeed(el); break;
      case 'view': CAL.view = el.dataset.v === 'agenda' ? 'agenda' : 'week'; renderCalendar(); break;
      case 'prev': CAL.anchor = addDays(CAL.anchor, CAL.view === 'week' ? -7 : -28); loadCalendar(); break;
      case 'next': CAL.anchor = addDays(CAL.anchor, CAL.view === 'week' ? 7 : 28); loadCalendar(); break;
      case 'today': CAL.anchor = startOfWeek(new Date()); loadCalendar(); break;
      case 'open': openSessionDetail(id); break;
      case 'new-session': newSessionForm(); break;
      case 'kind': newSessionForm(el.dataset.k === 'one' ? 'one' : 'series'); break;
      case 'edit-one': if (!blocked()) editOneForm(id); break;
      case 'edit-series': if (!blocked()) editSeriesForm(id); break;
      case 'cancel-one': cancelOne(id, el, false); break;
      case 'restore-one': cancelOne(id, el, true); break;
      case 'cancel-series': cancelSeries(id, el); break;
      case 'notify': notify(id, el.dataset.kind || 'invite', { btn: el }); break;
      case 'copy-invite': { const s = findRow(id); if (s) copyText(invitationText(s)).then(ok => showToast(ok ? 'Invitation copied ✓ Paste it in an email or WhatsApp.' : 'Could not copy.', ok ? 'ok' : 'err')); break; }
      // groups
      case 'gtab': GR.tab = el.dataset.t; renderGroups(); break;
      case 'cons-stat': GR.cf.status = GR.cf.status === el.dataset.s ? 'all' : el.dataset.s; { const sel = $('gc-cons-status'); if (sel) sel.value = GR.cf.status; } rerenderConsResults(); break;
      case 'cons-csv': consentsCsv(); break;
      case 'new-group': groupForm(null); break;
      case 'g-edit': groupForm(id); break;
      case 'g-del': deleteGroup(id, el); break;
      case 'g-members': GR.open[id] = !GR.open[id]; renderGroupsBody(); if (GR.open[id]) loadMembers(id).then(renderGroupsBody); break;
      case 'add-student': addStudentForm(el.dataset.g || null); break;
      case 'm-move': case 'm-remove': case 's-add': case 's-remove': memberAction(a, el); break;
      case 'template': download(uiLang === 'es' ? 'teroclass-plantilla-grupos.csv' : 'teroclass-groups-template.csv', IMP().templateCsv(uiLang === 'es' ? 'es' : 'en'), 'text/csv;charset=utf-8'); break;
      case 'import': if (GR.imp && el.closest('#gc-modal-box')) { const keep = GR.imp; importDialog(); const t = $('gc-imp-text'); if (t) t.value = keep.text || ''; } else importDialog(); break;
      case 'imp-check': importCheck(el); break;
      case 'imp-commit': importCommit(el); break;
    }
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-gcf]'); if (!f) return;
    e.preventDefault();
    switch (f.dataset.gcf) {
      case 'new': submitNew(f); break;
      case 'edit-one': submitEditOne(f); break;
      case 'edit-series': submitEditSeries(f); break;
      case 'group': submitGroup(f); break;
      case 'student': submitStudent(f); break;
    }
  });
  document.addEventListener('change', e => {
    if (e.target?.id === 'gc-imp-file') {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { showToast('The file is too big (max. 5 MB).', 'err'); return; }
      const r = new FileReader();
      r.onload = () => { const t = $('gc-imp-text'); if (t) t.value = String(r.result || ''); const n = $('gc-imp-file-name'); if (n) n.textContent = file.name; };
      r.readAsText(file, 'utf-8');
    }
    if (e.target?.id === 'gc-imp-create' && GR.imp) { GR.imp.create = e.target.checked; renderImportPreview(); }
    if (e.target?.id === 'gc-cons-status') { GR.cf.status = e.target.value; rerenderConsResults(); }
    if (e.target?.id === 'gc-cons-kind') { GR.cf.kind = e.target.value; rerenderConsResults(); }
    if (e.target?.dataset?.newfor) { const inp = $(e.target.dataset.newfor); if (inp) { inp.hidden = e.target.value !== '__new'; if (!inp.hidden) inp.focus(); } }
  });
  document.addEventListener('input', e => {
    if (e.target?.id === 'gc-st-search') { GR.q = e.target.value; const body = $('gc-groups-body'); if (body) body.innerHTML = studentsHtml(); }
    if (e.target?.id === 'gc-cons-search') { GR.cf.q = e.target.value; rerenderConsResults(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('modal-gc')?.classList.contains('active')) closeGc();
    // agenda rows are div[role=button] (they contain an "Enter room" button): Enter / Space open them
    if ((e.key === 'Enter' || e.key === ' ') && e.target?.matches?.('div[role="button"][data-gc]')) { e.preventDefault(); e.target.click(); }
  });

  // badge on the Groups nav (admins): when the nav shows / the unit changes, and every minute
  { const nav = $('nav-groups'); let t = 0;
    const kick = () => { clearTimeout(t); t = setTimeout(refreshConsentBadge, 300); };
    if (nav && window.MutationObserver) new MutationObserver(kick).observe(nav, { attributes: true, attributeFilter: ['style'] });
    setInterval(() => { if (!document.hidden) refreshConsentBadge(); }, 60000); }

  window.GC = { onEnter, afterEnter, render, onLang, refreshConsentBadge, enterStudentMode, leaveStudentMode, isStudentMode, backFromLive, modal, close: closeGc,
    vaLoadStudentPick, vaLoadStudents, vaStartStudent, _test: { csvToRows, parseCsv, joinState, startsIn, opensAt, isStaffRow, sessionIcs, googleUrl, CAL, GR, ST } };
  window.handleStudentLink = handleStudentLink;

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ERRORS + SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/Docente no válido para este grupo/, 'That teacher cannot be assigned to this group.'],
    [/Ya existe un grupo con ese nombre en esta unidad/, 'There is already a group with that name in this unit.'],
    [/Nombre del grupo requerido/, 'The group needs a name.'], [/Zona horaria inválida/, 'Invalid time zone.'],
    [/El suplente tiene que ser otra persona/, 'The substitute must be a different person.'],
    [/Email inválido: (.+)$/, 'Invalid email: $1'], [/Demasiadas filas \(máximo 2000\)/, 'Too many rows: the limit is 2,000.'], [/Archivo inválido/, 'Invalid file.'],
    [/Elegí al menos un día de la semana/, 'Choose at least one weekday.'], [/Días de la semana inválidos/, 'Invalid weekdays.'],
    [/Duración inválida \(de 5 a 720 minutos\)/, 'Invalid duration (5 to 720 minutes).'], [/Faltan datos de la serie/, 'Some series details are missing.'],
    [/La fecha de fin es anterior a la de inicio/, 'The end date is before the start date.'], [/Una serie puede durar como máximo un año/, 'A series can last up to one year.'],
    [/La serie no puede empezar en el pasado/, 'The series cannot start in the past.'], [/Ninguna fecha coincide con los días elegidos/, 'No date in that range falls on the chosen weekdays.'],
    [/Demasiados invitados \(máximo 200\)/, 'Too many guests (up to 200).'],
    [/Para crear una clase sin grupo necesitás pertenecer a una institución/, 'To schedule a class without a group you need to belong to an institution.'],
    [/Agregá al menos un email de estudiante/, 'Add at least one student email.'], [/Fecha de la clase inválida/, 'Invalid class date.'],
    [/Rango de fechas inválido/, 'Invalid date range.'], [/Elegí el grupo de destino/, 'Choose the destination group.'],
    [/Los estudiantes no pertenecen a una unidad[^]*$/, 'Students do not belong to a unit: they are loaded into groups.'],
    [/Primero borrá los grupos, estudiantes y clases de esta unidad/, 'First delete the groups, students and classes of this unit.']
  );
  if (typeof I18N_RULES_ES !== 'undefined') I18N_RULES_ES.push(
    [/^Starts in (\d+) min$/, 'Empieza en $1 min'], [/^Starts in (\d+) h (\d+) min$/, 'Empieza en $1 h $2 min'],
    [/^Starts in 1 day$/, 'Empieza en 1 día'], [/^Starts in (\d+) h$/, 'Empieza en $1 h'], [/^Starts in (\d+) days$/, 'Empieza en $1 días'],
    [/^(\d+) classes scheduled ✓$/, '$1 clases programadas ✓'], [/^Emails sent to (\d+) students ✓$/, 'Emails enviados a $1 estudiantes ✓'],
    [/^Invalid email: (.+)$/, 'Email inválido: $1'],
    [/^Imported ✓ (\d+) added, (\d+) already there, (\d+) skipped$/, 'Importado ✓ $1 agregados, $2 ya estaban, $3 salteados'],
    [/^Imported ✓ (\d+) added, (\d+) already there, (\d+) skipped · (\d+) classes scheduled$/, 'Importado ✓ $1 agregados, $2 ya estaban, $3 salteados · $4 clases programadas'],
    [/^Opens at (.+)$/, 'Abre a las $1'], [/^Opens (.+) at (.+)$/, 'Abre el $1 a las $2']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    // Consents (recording consent)
    'Consents': 'Consentimientos', 'Status': 'Estado', 'Role': 'Rol', 'All statuses': 'Todos los estados', 'Granted': 'Aceptó', 'Declined': 'No aceptó',
    'Revoked': 'Lo revocó', 'Pending': 'Pendiente', 'Everyone': 'Todos', 'Teachers': 'Docentes', 'Filters': 'Filtros',
    'PH:Search by name, email or class': 'Buscar por nombre, email o clase', 'Search by name, email or class': 'Buscar por nombre, email o clase',
    'Export CSV': 'Exportar CSV', 'People': 'Personas', 'Justifications': 'Justificaciones', 'Name': 'Nombre', 'Email': 'Email', 'Date': 'Fecha',
    'Under 18 · guardian ✓': 'Menor de 18 · tutor/a ✓', 'Under 18: the guardian gave consent': 'Menor de 18: el tutor/a dio su consentimiento',
    'not signed in yet': 'todavía no entró', 'No one matches these filters.': 'Nadie coincide con estos filtros.',
    'No people loaded in this unit yet.': 'Todavía no hay personas cargadas en esta unidad.', 'No justifications yet.': 'Todavía no hay justificaciones.',
    'Class:': 'Clase:', 'Unit': 'Unidad', 'Under 18': 'Menor de 18', 'Latest justification': 'Última justificación', 'Yes': 'Sí',
    'One consent per person: recording (audio only), AI analysis and storage. Each person is asked once; a "no" is asked again at their next class. Only this institution sees the people it loaded and the justifications addressed to it.':
      'Un solo consentimiento por persona: grabación (solo audio), análisis con IA y almacenamiento. A cada persona se le pregunta una vez; si dice que no, se le vuelve a preguntar en su próxima clase. Solo esta institución ve a las personas que cargó y las justificaciones dirigidas a ella.',
    'new justification (recording consent)': 'justificación nueva (consentimiento de grabación)', 'new justifications (recording consent)': 'justificaciones nuevas (consentimiento de grabación)',
    // login (students)
    "I'm a student → get a link by email": 'Soy estudiante → recibí un link por email', 'Student access': 'Acceso para estudiantes',
    "Write the email your school or teacher loaded. We'll send you a link to sign in — no password needed.": 'Escribí el email que cargó tu institución o tu docente. Te mandamos un link para entrar, sin contraseña.',
    'Send me a link': 'Mandame el link', '← I\'m a teacher: sign in with password': '← Soy docente: entrar con contraseña',
    'Write a valid email.': 'Escribí un email válido.', 'Too many emails were requested. Wait a minute and try again.': 'Se pidieron demasiados emails. Esperá un minuto y probá de nuevo.',
    'Check your inbox:': 'Revisá tu bandeja de entrada:', 'Open the link on this device to see your classes. It can take a minute; check spam too.': 'Abrí el link en este dispositivo para ver tus clases. Puede tardar un minuto; fijate también en spam.',
    // navigation
    'Calendar': 'Calendario', 'Groups': 'Grupos', 'Student': 'Estudiante', 'Students': 'Estudiantes',
    // student dashboard
    'Loading your classes…': 'Cargando tus clases…', "We couldn't load your classes": 'No pudimos cargar tus clases', 'Please try again in a moment.': 'Probá de nuevo en un momento.',
    'Try again': 'Reintentar', "You don't have assigned classes yet": 'Todavía no tenés clases asignadas',
    'When your school or your teacher adds you with this email, your classes will appear here.': 'Cuando tu institución o tu docente te sume con este email, tus clases van a aparecer acá.',
    'Check again': 'Volver a revisar', 'Hi': 'Hola', 'Hi!': '¡Hola!', 'Your classes, all in one place.': 'Tus clases, todas en un mismo lugar.',
    'Your time zone:': 'Tu zona horaria:', 'All times are shown in your time zone': 'Todos los horarios se muestran en tu zona horaria', 'Classmates': 'Compañeros',
    'Teacher:': 'Docente:', 'Enter class': 'Entrar a clase', '● Live now': '● En vivo ahora', 'Join class': 'Entrar a la clase',
    'The button turns on 10 minutes before the class.': 'El botón se activa 10 minutos antes de la clase.',
    'No upcoming classes. When your teacher schedules one, it will appear here.': 'No tenés próximas clases. Cuando tu docente programe una, va a aparecer acá.',
    'No classes scheduled yet.': 'Todavía no hay clases programadas.', 'And more:': 'Y más:', 'Today': 'Hoy', 'Tomorrow': 'Mañana',
    'Cancelled': 'Cancelada', 'Ended': 'Terminó', 'Add to Google Calendar': 'Agregar a Google Calendar', 'Download .ics (Outlook, Apple)': 'Descargar .ics (Outlook, Apple)',
    'The calendar subscription is personal (not available in View as).': 'La suscripción al calendario es personal (no disponible en "Ver como").',
    'Add all my classes to my calendar:': 'Sumar todas mis clases a mi calendario:', '🔗 Subscribe (Google, Outlook, Apple)': '🔗 Suscribirme (Google, Outlook, Apple)',
    'My insights': 'Mis insights', 'Your insights will appear here after your classes': 'Tus insights van a aparecer acá después de tus clases',
    'See all my insights': 'Ver todos mis insights', 'Message from your teacher': 'Mensaje de tu docente', 'Insights': 'Insights', 'View insights': 'Ver insights',
    'Generate demo insights': 'Generar insights de demo', 'Demo': 'Demo',
    "After each recorded class you'll see a recap, your progress and personal feedback from your teacher.": 'Después de cada clase grabada vas a ver un repaso, tu progreso y una devolución personal de tu docente.',
    'Speaking time': 'Tiempo de habla', 'New words': 'Palabras nuevas', 'Progress': 'Progreso', 'Preview': 'Vista previa',
    // calendar
    "Your classes and your groups' classes.": 'Tus clases y las de tus grupos.', '🔗 Subscribe': '🔗 Suscribirme', '+ Schedule class': '+ Programar clase',
    'Calendar view': 'Vista del calendario', 'Week': 'Semana', 'Agenda': 'Agenda', 'Previous': 'Anterior', 'Next': 'Siguiente', 'Loading…': 'Cargando…',
    'No classes in this period.': 'No hay clases en este período.', 'No classes this week.': 'No hay clases esta semana.',
    'As a student': 'Como estudiante', 'Substitute': 'Suplente', 'Class': 'Clase', 'Group': 'Grupo', 'Teacher': 'Docente', 'Join': 'Entrar',
    'Group time:': 'Hora del grupo:', 'Group:': 'Grupo:', 'Without a group': 'Sin grupo', 'Weekly': 'Semanal', 'The class opens 10 minutes before it starts.': 'La clase se abre 10 minutos antes de empezar.',
    'Add to calendar': 'Agregar al calendario', 'Google Calendar': 'Google Calendar', '.ics (Outlook, Apple)': '.ics (Outlook, Apple)',
    'Could not load the students.': 'No se pudieron cargar los estudiantes.', 'No students yet.': 'Todavía no hay estudiantes.', 'Invited': 'Invitado/a',
    'Invite': 'Invitar', 'Email the students': 'Mandar email a los estudiantes', 'Copy invitation link': 'Copiar link de invitación', 'Edit': 'Editar',
    'Edit this class': 'Editar esta clase', 'Restore this class': 'Reactivar esta clase', 'Cancel this class': 'Cancelar esta clase',
    'Edit the whole series': 'Editar toda la serie', 'Cancel the whole series': 'Cancelar toda la serie', 'Close': 'Cerrar',
    'Only this date changes.': 'Solo cambia esta fecha.', 'Title (optional)': 'Título (opcional)', 'Date': 'Fecha', 'Start time': 'Hora de inicio',
    'Duration (min)': 'Duración (min)', 'Back': 'Volver', 'Save this class': 'Guardar esta clase', 'Weekdays': 'Días de la semana',
    'From today on. Past classes and classes you edited one by one stay as they are.': 'Desde hoy. Las clases pasadas y las que editaste una por una quedan como están.',
    'Until': 'Hasta', "Times use the group's time zone:": 'Los horarios usan la zona horaria del grupo:', 'Save the series': 'Guardar la serie',
    'Schedule a class': 'Programar una clase', "You don't have groups yet. Your institution's admin creates the groups and assigns their teacher in": 'Todavía no tenés grupos. El admin de tu institución crea los grupos y les asigna docente en',
    'Type': 'Tipo', 'Weekly series': 'Serie semanal', 'One class': 'Una clase', '— No group: invite students by email —': '— Sin grupo: invitar estudiantes por email —',
    'e.g. Unit 3: making plans': 'ej. Unidad 3: hacer planes', 'From': 'Desde', 'Up to one year.': 'Hasta un año.', 'Invite students by email': 'Invitar estudiantes por email',
    'One email per line (or separated by commas)': 'Un email por línea (o separados por comas)',
    'Required for a class without a group; optional extra guests for a group. A new email is loaded as a student of your institution.': 'Obligatorio para una clase sin grupo; invitados extra opcionales para un grupo. Un email nuevo queda cargado como estudiante de tu institución.',
    'Times in your time zone:': 'Horarios en tu zona horaria:', 'Cancel': 'Cancelar', 'Create': 'Crear',
    'Choose at least one weekday.': 'Elegí al menos un día de la semana.', 'Add at least one student email.': 'Agregá al menos un email de estudiante.',
    'Invalid class date.': 'Fecha de la clase inválida.', 'Class scheduled ✓': 'Clase programada ✓', 'Class updated ✓': 'Clase actualizada ✓', 'Series updated ✓': 'Serie actualizada ✓',
    'Click again to cancel': 'Hacé clic de nuevo para cancelar', 'Class restored ✓': 'Clase reactivada ✓', 'Class cancelled': 'Clase cancelada',
    'Click again to cancel the series': 'Hacé clic de nuevo para cancelar la serie', 'Series cancelled': 'Serie cancelada',
    'Email is not configured yet. Use "Copy invitation link" and send it yourself.': 'El email todavía no está configurado. Usá "Copiar link de invitación" y mandalo vos.',
    'Email is not configured yet: copy the invitation link instead.': 'El email todavía no está configurado: copiá el link de invitación.',
    'Emails sent ✓': 'Emails enviados ✓', 'There are no students to email.': 'No hay estudiantes a quienes mandar el email.',
    'Subscribe to my calendar': 'Suscribirme a mi calendario',
    "Your classes appear in Google Calendar, Outlook or Apple Calendar and update by themselves. This link is personal: don't share it.": 'Tus clases aparecen en Google Calendar, Outlook o Apple Calendar y se actualizan solas. Este link es personal: no lo compartas.',
    'Feed URL': 'URL del calendario', 'Subscribe in Google Calendar': 'Suscribirme en Google Calendar', 'Copy feed URL': 'Copiar URL del calendario', 'Outlook / Apple Calendar': 'Outlook / Apple Calendar',
    'Calendar apps refresh subscriptions every few hours. In Outlook: Add calendar → From the internet → paste the URL.': 'Las apps de calendario actualizan las suscripciones cada algunas horas. En Outlook: Agregar calendario → Desde Internet → pegá la URL.',
    'Lost control of the link?': '¿Perdiste el control del link?', 'Reset link': 'Generar un link nuevo', 'The old link stops working.': 'El link anterior deja de funcionar.',
    'Click again to reset': 'Hacé clic de nuevo para generarlo', 'New link ready ✓ The old one no longer works.': 'Link nuevo listo ✓ El anterior ya no funciona.',
    'Link copied ✓': 'Link copiado ✓', 'Could not copy: select the link and copy it.': 'No se pudo copiar: seleccioná el link y copialo.',
    'Invitation copied ✓ Paste it in an email or WhatsApp.': 'Invitación copiada ✓ Pegala en un email o en WhatsApp.', 'Could not copy.': 'No se pudo copiar.',
    'Sign in with your email (no password) to see your classes and join:': 'Entrá con tu email (sin contraseña) para ver tus clases y conectarte:',
    'This class is not available.': 'Esta clase no está disponible.', 'The live class is not available.': 'El aula en vivo no está disponible.',
    // groups (admin)
    'Choose a unit in the switcher at the top.': 'Elegí una unidad en el selector de arriba.', 'Unit:': 'Unidad:',
    "Groups, their teacher and students. Students are free: they don't use seats.": 'Grupos, su docente y sus estudiantes. Los estudiantes son gratis: no ocupan asientos.',
    'CSV template': 'Plantilla CSV', 'Import CSV': 'Importar CSV', 'Add student': 'Agregar estudiante', '+ New group': '+ Nuevo grupo', 'Sections': 'Secciones',
    'Search by name, email or group': 'Buscar por nombre, email o grupo', 'PH:Search by name, email or group': 'Buscar por nombre, email o grupo',
    "Read-only: the classes of this unit's groups for the next 4 weeks. Teachers schedule them in their Calendar.": 'Solo lectura: las clases de los grupos de esta unidad en las próximas 4 semanas. Los docentes las programan en su Calendario.',
    'No classes scheduled in the next 4 weeks.': 'No hay clases programadas en las próximas 4 semanas.', 'No groups yet': 'Todavía no hay grupos',
    'Create a group (for example "English B1 – Tue/Thu"), assign its teacher and add students — one by one or from a CSV file.': 'Creá un grupo (por ejemplo "English B1 – Mar/Jue"), asignale docente y sumá estudiantes: de a uno o desde un archivo CSV.',
    'Not assigned': 'Sin asignar', 'No students in this group yet.': 'Todavía no hay estudiantes en este grupo.', 'Name': 'Nombre', 'Email': 'Email', 'Status': 'Estado',
    'Signed in ✓': 'Ya entró ✓', 'Not yet': 'Todavía no', 'Move to group': 'Mover a un grupo', 'Move to…': 'Mover a…', 'Move': 'Mover', 'Remove': 'Quitar',
    'Next class:': 'Próxima clase:', 'No classes scheduled': 'Sin clases programadas', 'Substitute:': 'Suplente:', 'None': 'Ninguno', 'students': 'estudiantes',
    'Delete': 'Borrar', 'No students loaded in this unit yet.': 'Todavía no hay estudiantes cargados en esta unidad.',
    'Only this institution sees the emails it loaded.': 'Solo esta institución ve los emails que cargó.', 'No group': 'Sin grupo',
    'Add to group': 'Agregar a un grupo', 'Add to group…': 'Agregar a un grupo…', 'Add': 'Agregar', 'No students match your search.': 'Ningún estudiante coincide con la búsqueda.',
    'Not assigned yet': 'Sin asignar todavía', 'No substitute': 'Sin suplente', 'Edit group': 'Editar grupo', 'New group': 'Nuevo grupo',
    'A group has one teacher and, optionally, one substitute with the same access to its classes.': 'Un grupo tiene un docente y, si querés, un suplente con el mismo acceso a sus clases.',
    'Group name': 'Nombre del grupo', 'e.g. English B1 – Tue/Thu': 'ej. English B1 – Mar/Jue', 'PH:e.g. English B1 – Tue/Thu': 'ej. English B1 – Mar/Jue', 'Unit': 'Unidad',
    'Substitute (optional)': 'Suplente (opcional)', 'Time zone': 'Zona horaria', 'No teachers in this institution yet: invite them first (👤+ Invite).': 'Todavía no hay docentes en esta institución: invitalos primero (👤+ Invitar).', 'Invited, waiting for them to register:': 'Invitados que todavía no se registraron:', 'They will appear here once they sign up with the institution link.': 'Van a aparecer acá cuando se registren con el link de la institución.',
    'Save': 'Guardar', 'Create group': 'Crear grupo', 'The group needs a name.': 'El grupo necesita un nombre.', 'The substitute must be a different person.': 'El suplente tiene que ser otra persona.',
    'Group saved ✓': 'Grupo guardado ✓', 'Group created ✓': 'Grupo creado ✓',
    "Students sign in with this email (a link, no password). They are free: they don't use seats.": 'Los estudiantes entran con este email (un link, sin contraseña). Son gratis: no ocupan asientos.',
    'Full name': 'Nombre completo', 'e.g. Ana Pérez': 'ej. Ana Pérez', 'PH:e.g. Ana Pérez': 'ej. Ana Pérez', 'Group (optional)': 'Grupo (opcional)', '— No group for now —': '— Sin grupo por ahora —',
    'Student added ✓': 'Estudiante agregado ✓', 'That student was already loaded: updated ✓': 'Ese estudiante ya estaba cargado: actualizado ✓',
    'Choose the destination group.': 'Elegí el grupo de destino.', 'Student moved ✓': 'Estudiante movido ✓', 'Click again to remove': 'Hacé clic de nuevo para quitar',
    'Removed from the group': 'Quitado del grupo', 'Added to the group ✓': 'Agregado al grupo ✓', 'Click again: removes them from this unit': 'Hacé clic de nuevo: lo quita de esta unidad',
    'Student removed': 'Estudiante quitado', 'Click again: deletes the group and its classes': 'Hacé clic de nuevo: borra el grupo y sus clases', 'Group deleted': 'Grupo borrado',
    // import
    'Import students (CSV)': 'Importar estudiantes (CSV)', 'Columns:': 'Columnas:', '— optional': '— opcionales',
    "(name or slug). The order doesn't matter: we read the header. Up to 2,000 rows. Importing the same file again doesn't duplicate anyone.": '(nombre o slug). El orden no importa: leemos el encabezado. Hasta 2.000 filas. Importar el mismo archivo otra vez no duplica a nadie.',
    'Choose a CSV file': 'Elegir un archivo CSV', 'Download the template': 'Descargar la plantilla', '…or paste the rows here': '…o pegá las filas acá',
    'Excel: File → Save as → CSV UTF-8. Comma or semicolon both work.': 'Excel: Archivo → Guardar como → CSV UTF-8. Sirve con coma o con punto y coma.',
    'Check file →': 'Revisar archivo →', 'The file has no rows.': 'El archivo no tiene filas.',
    'The file needs an "email" column (header in the first row).': 'El archivo necesita una columna "email" (encabezado en la primera fila).',
    'Too many rows: the limit is 2,000.': 'Demasiadas filas: el máximo es 2.000.', 'The file is too big (max. 5 MB).': 'El archivo es demasiado grande (máx. 5 MB).',
    'Missing email': 'Falta el email', 'Invalid email': 'Email inválido', 'Repeated in the file': 'Repetido en el archivo', 'Unknown unit': 'Unidad desconocida',
    'More than one unit with that name: use its slug': 'Hay más de una unidad con ese nombre: usá su slug', 'Teacher not found in your institution': 'No encontramos ese docente en tu institución',
    'Unknown group': 'Grupo desconocido', 'Group name too long': 'Nombre de grupo demasiado largo', 'Error': 'Error', 'Already loaded': 'Ya estaba cargado', 'Group to create': 'Grupo a crear',
    'Skipped: unknown group': 'Salteado: grupo desconocido', 'Will be added': 'Se agrega', 'Check before importing': 'Revisá antes de importar', 'Rows': 'Filas', 'To add': 'Para agregar',
    'With errors': 'Con errores', 'Create the new groups:': 'Crear los grupos nuevos:',
    'Rows with errors are skipped. Fix them in the file and import it again whenever you want.': 'Las filas con errores se saltean. Corregilas en el archivo y volvé a importarlo cuando quieras.',
    'Line': 'Línea', 'The group already has another teacher (kept)': 'El grupo ya tiene otro docente (se mantiene)', '← Back': '← Volver', 'Import': 'Importar',
    // view as
    "Students see their group's classes, the teacher's name and how many classmates — never their emails.": 'Los estudiantes ven las clases de su grupo, el nombre del docente y cuántos compañeros son, nunca sus emails.',
    'Choose a group': 'Elegí un grupo', 'This unit has no groups yet': 'Esta unidad todavía no tiene grupos', 'Generic student of this group': 'Estudiante genérico de este grupo',
    'Choose a group first.': 'Primero elegí un grupo.', 'Pick a student to see exactly their dashboard.': 'Elegí un estudiante para ver exactamente su panel.', 'Groups (no unit)': 'Grupos (sin unidad)',
    // errors (database → English → Spanish)
    'That teacher cannot be assigned to this group.': 'Ese docente no se puede asignar a este grupo.', 'There is already a group with that name in this unit.': 'Ya existe un grupo con ese nombre en esta unidad.',
    'Invalid time zone.': 'Zona horaria inválida.', 'Invalid file.': 'Archivo inválido.', 'Invalid weekdays.': 'Días de la semana inválidos.',
    'Invalid duration (5 to 720 minutes).': 'Duración inválida (de 5 a 720 minutos).', 'Some series details are missing.': 'Faltan datos de la serie.',
    'The end date is before the start date.': 'La fecha de fin es anterior a la de inicio.', 'A series can last up to one year.': 'Una serie puede durar como máximo un año.',
    'The series cannot start in the past.': 'La serie no puede empezar en el pasado.', 'No date in that range falls on the chosen weekdays.': 'Ninguna fecha de ese rango cae en los días elegidos.',
    'Too many guests (up to 200).': 'Demasiados invitados (máximo 200).', 'To schedule a class without a group you need to belong to an institution.': 'Para programar una clase sin grupo necesitás pertenecer a una institución.',
    'Invalid date range.': 'Rango de fechas inválido.', 'Students do not belong to a unit: they are loaded into groups.': 'Los estudiantes no pertenecen a una unidad: se cargan en los grupos.',
    'First delete the groups, students and classes of this unit.': 'Primero borrá los grupos, estudiantes y clases de esta unidad.',
    // enter the room (teacher always; students 10 min before)
    'Enter room': 'Entrar a la sala', 'Students can join from 10 min before': 'Los estudiantes pueden entrar desde 10 min antes',
    "Today's class": 'Clase de hoy', 'Next class': 'Próxima clase',
    // pending teachers
    'class': 'clase', 'group': 'grupo', 'student': 'estudiante', 'Pending:': 'Pendiente:', '(invited)': '(invitado/a)', '(not invited yet: no free seats)': '(sin invitar todavía: no hay asientos libres)',
    'Invited people who have not registered yet can be chosen now: they are assigned by themselves when they sign up.': 'Podés elegir a personas invitadas que todavía no se registraron: quedan asignadas solas cuando se registran.',
    'Registered': 'Registrados', 'Invited (not registered yet)': 'Invitados (todavía sin registrarse)', 'Invite someone by email…': 'Invitar a alguien por email…',
    'teacher@school.edu': 'docente@escuela.edu.uy', 'PH:teacher@school.edu': 'docente@escuela.edu.uy',
    'Someone who is not registered yet gets an invitation as teacher of this unit and stays as "Pending" until they sign up.': 'Si la persona todavía no está registrada, le llega una invitación como docente de esta unidad y queda "Pendiente" hasta que se registre.',
    'No teachers registered yet: choose "Invite someone by email…".': 'Todavía no hay docentes registrados: elegí "Invitar a alguien por email…".',
    'Group saved ✓ The invited person is assigned when they register.': 'Grupo guardado ✓ La persona invitada queda asignada cuando se registre.',
    // CSV import with schedules
    'Import groups and students (CSV)': 'Importar grupos y estudiantes (CSV)',
    "One row per student. The group's schedule, teacher and substitute can go on any row of the group (or on a row without a student). We create the groups, enroll the students and put the classes in each teacher's calendar.": 'Una fila por estudiante. El horario, el docente y el suplente del grupo pueden ir en cualquier fila del grupo (o en una fila sin estudiante). Creamos los grupos, inscribimos a los estudiantes y ponemos las clases en el calendario de cada docente.',
    'Accepted columns': 'Columnas aceptadas',
    'the student (email can be empty on a row that only defines a group)': 'el estudiante (el email puede quedar vacío en una fila que solo define un grupo)',
    'if they are not registered yet, we invite them and assign them when they sign up': 'si todavía no están registrados, los invitamos y quedan asignados cuando se registran',
    'e.g. "Lun;Mié", "L,Mi", "lunes y miércoles", "Mon/Wed", "LMi" ("Mi" = Wednesday, "Ma" = Tuesday)': 'ej. "Lun;Mié", "L,Mi", "lunes y miércoles", "Mon/Wed", "LMi" ("Mi" = miércoles, "Ma" = martes)',
    'or': 'o', 'e.g. 07:00, 7am, 19:30; minutes': 'ej. 07:00, 7am, 19:30; en minutos',
    'day/month/year (3/3/2027) or 2027-03-03; up to one year': 'día/mes/año (3/3/2027) o 2027-03-03; hasta un año',
    "optional (default: the group's time zone, America/Montevideo)": 'opcionales (por defecto: la zona horaria del grupo, America/Montevideo)',
    "Headers in Spanish or English, any order; capitals and accents don't matter. Up to 2,000 rows. Importing the same file again doesn't duplicate anything.": 'Encabezados en español o inglés, en cualquier orden; no importan mayúsculas ni tildes. Hasta 2.000 filas. Importar el mismo archivo otra vez no duplica nada.',
    'The file needs an "email" or a "group" column (header in the first row).': 'El archivo necesita una columna "email" o "grupo" (encabezado en la primera fila).',
    'Substitute not found in your institution': 'No encontramos ese suplente en tu institución', 'Schedule or substitute without a group': 'Horario o suplente sin grupo',
    'Teacher and substitute are the same person': 'Docente y suplente son la misma persona', 'Invalid schedule': 'Horario inválido',
    'Ambiguous day: "M" can be Tuesday or Wednesday (use Ma / Mi)': 'Día ambiguo: "M" puede ser martes o miércoles (usá Ma / Mi)', 'Unknown days': 'Días desconocidos',
    'Invalid start time': 'Hora de inicio inválida', 'Invalid end time': 'Hora de fin inválida', "End time and duration don't match": 'La hora de fin y la duración no coinciden',
    'Invalid start date': 'Fecha de inicio inválida', 'Invalid end date': 'Fecha de fin inválida', 'Looks like month/day: write day/month (e.g. 25/04/2027)': 'Parece mes/día: escribí día/mes (ej. 25/04/2027)',
    'More than one year': 'Más de un año', 'Unknown time zone': 'Zona horaria desconocida', 'Invalid teacher email': 'Email del docente inválido', 'Invalid substitute email': 'Email del suplente inválido',
    'teacher': 'docente', 'substitute': 'suplente', 'days': 'días', 'start time': 'hora de inicio', 'duration / end time': 'duración / hora de fin', 'start date': 'fecha de inicio', 'end date': 'fecha de fin', 'time zone': 'zona horaria',
    'Registered ✓': 'Registrado ✓', 'Already assigned': 'Ya asignado', 'Not registered: will be invited': 'Sin registrarse: lo invitamos', 'Invited, not registered yet': 'Invitado, todavía sin registrarse',
    'Has an account: will be added as teacher': 'Ya tiene cuenta: se suma como docente', 'Pending (invited)': 'Pendiente (invitado)', 'No free seats: stays pending, not invited': 'Sin asientos libres: queda pendiente, sin invitar',
    'New schedule': 'Horario nuevo', 'Same schedule: nothing changes': 'Mismo horario: no cambia nada', 'Schedule changes': 'Cambia el horario', 'Before:': 'Antes:',
    "Only future classes that weren't edited one by one move. Past classes never change.": 'Solo se mueven las clases futuras que no editaste una por una. Las pasadas no cambian nunca.',
    'Incomplete schedule, missing:': 'Horario incompleto, falta:', 'No future class in that range': 'No hay clases futuras en ese rango', 'No classes': 'Sin clases', 'No schedule in the file': 'Sin horario en el archivo',
    'Summary': 'Resumen', 'rows': 'filas', 'groups': 'grupos', 'classes to create': 'clases a crear', 'Classes per teacher': 'Clases por docente', 'classes': 'clases', 'Pending': 'Pendiente',
    'Conflicts with another row of the same group:': 'No coincide con otra fila del mismo grupo:', 'Group details (no student)': 'Datos del grupo (sin estudiante)',
    'Date without year: this year': 'Fecha sin año: este año', "Columns we don't use (ignored):": 'Columnas que no usamos (se ignoran):', 'Existing group': 'Grupo existente',
    'Schedule:': 'Horario:', 'dates already passed are skipped: only future classes are created.': 'fechas que ya pasaron se saltean: solo se crean clases futuras.',
    'This group already has other scheduled classes:': 'Este grupo ya tiene otras clases programadas:',
    // insights / platform
    'Students (accounts)': 'Estudiantes (cuentas)', 'Loaded students': 'Estudiantes cargados', 'Signed in with their link': 'Entraron con su link',
    'Had classes in the period': 'Tuvieron clases en el período', 'Groups · classes held': 'Grupos · clases dadas', 'Totals only: no names or emails.': 'Solo totales: sin nombres ni emails.',
  });
})();
