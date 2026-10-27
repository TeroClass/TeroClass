// Groups + students + calendar for the simulated Supabase (tests only). Same privacy rules as the SQL
// functions in supabase/migrations/001_base.sql ("GRUPOS, ESTUDIANTES Y CALENDARIO"), simplified.
// Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns {status, data} or undefined.
const MIN = 60000;
const EMAIL_RE = /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[A-Za-z]{2,24}$/;
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });

module.exports = function install(ctx) {
  const { db, uid, instById, chainOf, descendantsOf, rootOf, inviteMember, seatsFree } = ctx;
  const S = { notify: [] };
  const prof = id => db.profiles.find(p => p.id === id);
  const user = id => db.users[id];
  const isSA = me => prof(me?.id)?.role === 'superadmin';
  const isAdminOf = (me, inst) => { const p = prof(me?.id); if (!p) return false; if (p.role === 'superadmin') return true; return !!inst && p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id); };
  const scope = unit => [unit, ...descendantsOf(unit)];
  const group = id => db.class_groups.find(g => g.id === id);
  const enr = id => db.student_enrollments.find(e => e.id === id);
  const teachesGroup = (me, gid) => { const g = group(gid); return !!(g && me && (g.teacher_id === me.id || g.substitute_id === me.id)); };
  const teachesSession = (me, s) => !!s && (s.group_id ? teachesGroup(me, s.group_id) : s.teacher_id === me?.id);
  const personName = (me, id) => { const p = prof(id); if (!p) return ''; if (p.role === 'superadmin' && !isSA(me)) return 'TeroClass team'; return p.name || ''; };
  const personJson = (me, id) => { const p = prof(id); if (!p) return null; if (p.role === 'superadmin' && !isSA(me)) return { id: null, name: 'TeroClass team', email: null, masked: true };
    return { id: p.id, name: p.name || '', email: isSA(me) || (p.institution_id && isAdminOf(me, p.institution_id)) ? p.email : null, masked: false }; };
  const members = gid => db.group_members.filter(m => m.group_id === gid).map(m => enr(m.enrollment_id)).filter(Boolean);
  const invitees = sid => db.session_invitees.filter(i => i.session_id === sid).map(i => enr(i.enrollment_id)).filter(Boolean);
  const attends = (uidv, s) => !!uidv && db.student_enrollments.some(e => e.user_id === uidv && ((s.group_id && db.group_members.some(m => m.group_id === s.group_id && m.enrollment_id === e.id)) || db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === e.id)));
  const people = s => (s.group_id ? members(s.group_id).length : 0) + db.session_invitees.filter(i => i.session_id === s.id).length;
  function ensureEnrollment(me, unit, email, name, source) {
    email = String(email || '').trim(); name = String(name || '').trim().slice(0, 120);
    if (!EMAIL_RE.test(email)) return null;
    let e = db.student_enrollments.find(x => x.institution_id === unit && x.email.toLowerCase() === email.toLowerCase());
    if (!e) { e = { id: uid(), institution_id: unit, email, name, user_id: null, loaded_by: me?.id || null, source, created_at: new Date().toISOString() }; db.student_enrollments.push(e); }
    else if (name) e.name = name;
    return e;
  }
  const addMember = (gid, eid) => { if (!db.group_members.some(m => m.group_id === gid && m.enrollment_id === eid)) db.group_members.push({ group_id: gid, enrollment_id: eid }); };
  const assertTeacher = (me, unit, tid) => { if (!tid) return true; const p = prof(tid); return !!(p && ['teacher', 'org_admin'].includes(p.role) && p.institution_id && isAdminOf(me, p.institution_id) && rootOf(p.institution_id) === rootOf(unit)); };
  // time zones: local date + time in tz → Date (UTC)
  function tzOffsetMin(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = t => +parts.find(p => p.type === t).value;
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms) / MIN;
  }
  function localTs(dateStr, timeStr, tz) {
    const [y, m, d] = dateStr.split('-').map(Number); const [h, mi] = timeStr.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    let t = guess - tzOffsetMin(guess, tz) * MIN; t = guess - tzOffsetMin(t, tz) * MIN;
    return new Date(t);
  }
  const isoDow = dateStr => { const [y, m, d] = dateStr.split('-').map(Number); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; };
  const dates = (days, from, to) => { const out = []; const [y, m, d] = from.split('-').map(Number); for (let t = Date.UTC(y, m - 1, d); ; t += 864e5) { const s = new Date(t).toISOString().slice(0, 10); if (s > to) break; if (days.includes(isoDow(s))) out.push(s); if (out.length > 400) break; } return out; };
  const localDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  function calRows(me, uidv, from, to) {
    return db.class_sessions.filter(s => Date.parse(s.starts_at) < to && Date.parse(s.ends_at) > from).filter(s => {
      const g = s.group_id && group(s.group_id);
      return (g && (g.teacher_id === uidv || g.substitute_id === uidv)) || (!s.group_id && s.teacher_id === uidv) || attends(uidv, s);
    }).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).map(s => {
      const g = s.group_id && group(s.group_id);
      const role = g && g.teacher_id === uidv ? 'teacher' : g && g.substitute_id === uidv ? 'substitute' : !s.group_id && s.teacher_id === uidv ? 'teacher' : 'student';
      return { id: s.id, title: s.title || g?.name || '', raw_title: s.title, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, seq: s.seq, updated_at: s.updated_at,
        group_id: s.group_id, group_name: g?.name || null, unit_name: instById(s.institution_id)?.name, series_id: s.series_id, modified: !!s.modified, role,
        teacher_name: personName(me, g?.teacher_id || s.teacher_id), people: people(s), can_edit: role !== 'student',
        // P-06: the plan attached to the class, only for whoever teaches it (as tc_calendar_rows)
        planning_id: role !== 'student' ? (s.planning_id || null) : null,
        planning_title: role !== 'student' && s.planning_id ? (db.plannings.find(x => x.id === s.planning_id)?.title || null) : null };
    });
  }
  function newSession(fields) { const now = new Date().toISOString(); const s = { id: uid(), status: 'scheduled', seq: 0, modified: false, series_id: null, title: '', created_at: now, updated_at: now, ...fields }; db.class_sessions.push(s); return s; }
  // ── teacher / substitute by email (same rules as tc_person_status / tc_assign_person / tc_claim_pending_groups) ──
  const userEmail = id => String(user(id)?.email || prof(id)?.email || '').toLowerCase();
  function personStatus(me, unit, email) {
    email = String(email || '').trim().toLowerCase(); if (!email) return { status: 'none' }; if (!EMAIL_RE.test(email)) return { status: 'bad_email' };
    const p = db.profiles.find(x => userEmail(x.id) === email);
    if (p) {
      if (p.role === 'superadmin') return { status: 'not_allowed' };
      if (['teacher', 'org_admin'].includes(p.role) && p.institution_id) return isAdminOf(me, p.institution_id) && rootOf(p.institution_id) === rootOf(unit) ? { status: 'registered', id: p.id, name: p.name || '' } : { status: 'not_allowed' };
      return { status: 'add' };
    }
    return db.invitations.some(i => String(i.email).toLowerCase() === email && !i.accepted_at && rootOf(i.institution_id) === rootOf(unit)) ? { status: 'invited' } : { status: 'invite' };
  }
  const K = kind => kind === 'teacher' ? ['teacher_id', 'pending_teacher_email', 'substitute_id', 'pending_substitute_email'] : ['substitute_id', 'pending_substitute_email', 'teacher_id', 'pending_teacher_email'];
  function assignPerson(me, g, kind, email) { // → 'assigned' | 'invited' | 'seats_full' | 'none' | throws Error(message)
    email = String(email || '').trim().toLowerCase(); const [idk, pk, oid, opk] = K(kind);
    const st = personStatus(me, g.institution_id, email);
    if (st.status === 'none') return 'none';
    if (['not_allowed', 'bad_email'].includes(st.status)) throw new Error('Docente no válido para este grupo');
    if (st.status === 'registered') { if (g[oid] === st.id) throw new Error('El suplente tiene que ser otra persona'); g[idk] = st.id; g[pk] = null; return 'assigned'; }
    if (g[opk] === email) throw new Error('El suplente tiene que ser otra persona');
    g[idk] = null; g[pk] = email;
    if (st.status === 'invited') return 'invited';
    try { return inviteMember(g.institution_id, email, 'teacher') === 'added' ? 'assigned' : 'invited'; } catch (e) { if (e.seats) return 'seats_full'; throw e; }
  }
  function applyPending(p) {
    if (!p || !['teacher', 'org_admin'].includes(p.role) || !p.institution_id) return;
    const email = userEmail(p.id); if (!email) return;
    db.class_groups.forEach(g => {
      if (rootOf(g.institution_id) !== rootOf(p.institution_id)) return;
      if (g.pending_teacher_email === email && !g.teacher_id && g.substitute_id !== p.id) { g.teacher_id = p.id; g.pending_teacher_email = null; }
      if (g.pending_substitute_email === email && !g.substitute_id && g.teacher_id !== p.id) { g.substitute_id = p.id; g.pending_substitute_email = null; }
    });
  }
  const pendingJson = (g, k) => g[k] ? { email: g[k], invited: db.invitations.some(i => String(i.email).toLowerCase() === g[k] && !i.accepted_at && rootOf(i.institution_id) === rootOf(g.institution_id)) } : null;
  const scheduleJson = g => { const today = localDate(Date.now(), g.timezone); const ss = db.session_series.filter(x => x.group_id === g.id && x.end_date >= today).sort((a, b) => ((b.origin === 'csv') - (a.origin === 'csv')) || (b._n - a._n))[0];
    return ss ? { weekdays: ss.weekdays, start_time: ss.start_time, duration_min: ss.duration_min, start_date: ss.start_date, end_date: ss.end_date, timezone: ss.timezone, origin: ss.origin || 'manual' } : null; };
  let serN = 0;
  // same rule as tc_series_apply: future, not individually edited occurrences move; past never change
  function seriesApply(s, v, me) {
    const g = group(s.group_id); const oldTz = s.timezone; const tz = v.timezone || s.timezone; const sd = v.start_date || s.start_date;
    const today = localDate(Date.now(), tz); const want = dates(v.weekdays, sd > today ? sd : today, v.end_date);
    let removed = 0, updated = 0, created = 0;
    db.class_sessions.filter(c => c.series_id === s.id && Date.parse(c.starts_at) > Date.now() && !c.modified).forEach(c => {
      const d = localDate(Date.parse(c.starts_at), oldTz);
      if (!want.includes(d)) { db.class_sessions = db.class_sessions.filter(x => x !== c); removed++; }
      else { const a = localTs(d, v.start_time, tz); Object.assign(c, { title: v.title ?? s.title, starts_at: a.toISOString(), ends_at: new Date(a.getTime() + v.duration_min * MIN).toISOString(), timezone: tz, seq: c.seq + 1 }); updated++; }
    });
    want.forEach(d => { const a = localTs(d, v.start_time, tz); if (a.getTime() > Date.now() && !db.class_sessions.some(c => c.series_id === s.id && localDate(Date.parse(c.starts_at), tz) === d)) { newSession({ institution_id: g.institution_id, group_id: g.id, series_id: s.id, teacher_id: g.teacher_id || me?.id, title: v.title ?? s.title, starts_at: a.toISOString(), ends_at: new Date(a.getTime() + v.duration_min * MIN).toISOString(), timezone: tz }); created++; } });
    Object.assign(s, { weekdays: v.weekdays, start_time: v.start_time, duration_min: v.duration_min, start_date: sd, end_date: v.end_date, timezone: tz, title: v.title ?? s.title });
    return { updated, created, removed };
  }

  function handle(fn, body, me) {
    const b = body || {};
    switch (fn) {
      case 'claim_enrollments': {
        if (!me) return err('No autorizado');
        const email = String(user(me.id)?.email || '').toLowerCase(); let n = 0;
        db.student_enrollments.forEach(e => { if (!e.user_id && e.email.toLowerCase() === email) { e.user_id = me.id; n++; } });
        return ok({ linked: n, verified: true, role: prof(me.id)?.role, enrollments: db.student_enrollments.filter(e => e.user_id === me.id).length });
      }
      case 'list_groups': {
        if (!b.p_unit || !instById(b.p_unit) || !isAdminOf(me, b.p_unit)) return err('No autorizado');
        const ids = scope(b.p_unit);
        return ok(db.class_groups.filter(g => ids.includes(g.institution_id)).map(g => ({ id: g.id, name: g.name, institution_id: g.institution_id, unit_name: instById(g.institution_id)?.name, timezone: g.timezone,
          teacher: personJson(me, g.teacher_id), substitute: personJson(me, g.substitute_id), students: members(g.id).length, classes: db.class_sessions.filter(x => x.group_id === g.id).length,
          pending_teacher: pendingJson(g, 'pending_teacher_email'), pending_substitute: pendingJson(g, 'pending_substitute_email'), schedule: scheduleJson(g),
          next_session: db.class_sessions.filter(s => s.group_id === g.id && s.status === 'scheduled' && Date.parse(s.ends_at) > Date.now()).map(s => s.starts_at).sort()[0] || null }))
          .sort((x, y) => (x.unit_name + x.name).localeCompare(y.unit_name + y.name)));
      }
      case 'list_students': {
        if (!b.p_unit || !isAdminOf(me, b.p_unit)) return err('No autorizado');
        const ids = scope(b.p_unit);
        return ok(db.student_enrollments.filter(e => ids.includes(e.institution_id)).map(e => ({ id: e.id, email: e.email, name: e.name, institution_id: e.institution_id, unit_name: instById(e.institution_id)?.name,
          linked: !!e.user_id, source: e.source, created_at: e.created_at, groups: db.group_members.filter(m => m.enrollment_id === e.id).map(m => ({ id: m.group_id, name: group(m.group_id)?.name })) }))
          .sort((x, y) => (x.name || x.email).localeCompare(y.name || y.email)));
      }
      case 'list_group_members': {
        const g = group(b.p_group); if (!g || !(isAdminOf(me, g.institution_id) || teachesGroup(me, g.id))) return err('No autorizado');
        return ok(members(g.id).map(e => ({ enrollment_id: e.id, email: e.email, name: e.name, linked: !!e.user_id })).sort((x, y) => (x.name || '').localeCompare(y.name || '')));
      }
      case 'create_group': case 'update_group': {
        const g0 = fn === 'update_group' ? group(b.p_group) : null;
        const unit = g0 ? g0.institution_id : b.p_unit;
        if (!unit || !isAdminOf(me, unit) || (fn === 'update_group' && !g0)) return err('No autorizado');
        const name = String(b.p_name || '').trim().slice(0, 120); if (!name) return err('Nombre del grupo requerido');
        if (b.p_substitute && b.p_substitute === b.p_teacher) return err('El suplente tiene que ser otra persona');
        if ((!g0 || b.p_teacher !== g0.teacher_id) && !assertTeacher(me, unit, b.p_teacher)) return err('Docente no válido para este grupo');
        if ((!g0 || b.p_substitute !== g0.substitute_id) && !assertTeacher(me, unit, b.p_substitute)) return err('Docente no válido para este grupo');
        if (db.class_groups.some(x => x.institution_id === unit && x.id !== g0?.id && x.name.toLowerCase() === name.toLowerCase())) return err('Ya existe un grupo con ese nombre en esta unidad');
        const te = b.p_teacher ? '' : String(b.p_teacher_email || '').trim().toLowerCase(); const se = b.p_substitute ? '' : String(b.p_substitute_email || '').trim().toLowerCase();
        if (te && te === se) return err('El suplente tiene que ser otra persona');
        let g = g0; const prevT = g0?.pending_teacher_email || null; const prevS = g0?.pending_substitute_email || null;
        if (g0) Object.assign(g0, { name, teacher_id: b.p_teacher || null, substitute_id: b.p_substitute || null, timezone: b.p_timezone || g0.timezone, pending_teacher_email: te && te === prevT ? te : null, pending_substitute_email: se && se === prevS ? se : null });
        else { g = { id: uid(), institution_id: unit, name, teacher_id: b.p_teacher || null, substitute_id: b.p_substitute || null, timezone: b.p_timezone || 'America/Montevideo', pending_teacher_email: null, pending_substitute_email: null }; db.class_groups.push(g); }
        try { if (te && te !== prevT) assignPerson(me, g, 'teacher', te); if (se && se !== prevS) assignPerson(me, g, 'substitute', se); } catch (e) { return err(e.message); }
        return ok(g.id);
      }
      case 'delete_group': {
        const g = group(b.p_group); if (!g || !isAdminOf(me, g.institution_id)) return err('No autorizado');
        db.class_groups = db.class_groups.filter(x => x.id !== g.id); db.group_members = db.group_members.filter(m => m.group_id !== g.id);
        db.class_sessions = db.class_sessions.filter(s => s.group_id !== g.id); return ok('deleted');
      }
      case 'add_student': {
        const unit = b.p_group ? group(b.p_group)?.institution_id : b.p_unit;
        if (!unit || !isAdminOf(me, unit)) return err('No autorizado');
        if (!EMAIL_RE.test(String(b.p_email || '').trim())) return err('Email inválido: ' + String(b.p_email || '').trim());
        const existed = db.student_enrollments.some(x => x.institution_id === unit && x.email.toLowerCase() === String(b.p_email).trim().toLowerCase());
        const e = ensureEnrollment(me, unit, b.p_email, b.p_name, 'manual');
        if (b.p_group) addMember(b.p_group, e.id);
        return ok({ enrollment_id: e.id, created: !existed, in_group: !!b.p_group });
      }
      case 'group_add_student': case 'move_student': {
        const to = group(fn === 'move_student' ? b.p_to_group : b.p_group); const e = enr(b.p_enrollment);
        if (!to) return err(fn === 'move_student' ? 'Elegí el grupo de destino' : 'No autorizado');
        if (!e || !isAdminOf(me, to.institution_id) || !isAdminOf(me, e.institution_id)) return err('No autorizado');
        const use = e.institution_id === to.institution_id ? e : ensureEnrollment(me, to.institution_id, e.email, e.name, e.source);
        addMember(to.id, use.id);
        if (fn === 'move_student' && b.p_from_group && b.p_from_group !== to.id) db.group_members = db.group_members.filter(m => !(m.group_id === b.p_from_group && m.enrollment_id === e.id));
        return ok(use.id);
      }
      case 'group_remove_student': {
        const g = group(b.p_group); if (!g || !isAdminOf(me, g.institution_id)) return err('No autorizado');
        db.group_members = db.group_members.filter(m => !(m.group_id === g.id && m.enrollment_id === b.p_enrollment)); return ok('removed');
      }
      case 'remove_student': {
        const e = enr(b.p_enrollment); if (!e || !isAdminOf(me, e.institution_id)) return err('No autorizado');
        db.student_enrollments = db.student_enrollments.filter(x => x.id !== e.id); db.group_members = db.group_members.filter(m => m.enrollment_id !== e.id);
        db.session_invitees = db.session_invitees.filter(i => i.enrollment_id !== e.id); return ok('removed');
      }
      case 'import_students': {
        if (!b.p_unit || !isAdminOf(me, b.p_unit)) return err('No autorizado');
        const rows = Array.isArray(b.p_rows) ? b.p_rows : null; if (!rows) return err('Archivo inválido');
        if (rows.length > 2000) return err('Demasiadas filas (máximo 2000)');
        const CODES = ['ambiguous_day', 'bad_days', 'bad_time', 'bad_end_time', 'bad_duration', 'time_conflict', 'bad_date', 'bad_end_date', 'date_mdy', 'end_before_start', 'range_too_long', 'bad_tz', 'bad_teacher_email', 'bad_substitute_email', 'same_person'];
        const ids = scope(b.p_unit); const seen = new Set(); const groups = {}; const people = {}; const work = []; const out = []; let cOk = 0, cEx = 0, cErr = 0, cNewRows = 0, cG = 0;
        const findG = (unit, name) => db.class_groups.find(x => x.institution_id === unit && x.name.toLowerCase() === name.toLowerCase());
        const pst = (unit, e) => people[e] || (people[e] = personStatus(me, unit, e));
        rows.forEach((r, i) => {
          const line = Number.isInteger(r.line) ? r.line : i + 2; const email = String(r.email || '').trim(); const name = String(r.name || '').trim().slice(0, 120);
          const gname = String(r.group || '').trim().replace(/\s+/g, ' '); const temail = String(r.teacher_email || '').trim().toLowerCase(); const semail = String(r.substitute_email || '').trim().toLowerCase(); const uq = String(r.unit || '').trim();
          let status = 'ok', code = null, field = null, warning = null, unit = b.p_unit, G = null, tst = null;
          const vals = {};
          if (Array.isArray(r.weekdays) && r.weekdays.length) { if (r.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) { status = 'error'; code = 'bad_schedule'; } else vals.weekdays = [...new Set(r.weekdays)].sort(); }
          ['start_time', 'duration_min', 'start_date', 'end_date', 'timezone'].forEach(k => { if (r[k] != null && r[k] !== '') vals[k] = r[k]; });
          if (temail) vals.teacher_email = temail; if (semail) vals.substitute_email = semail;
          if (uq) { const m = db.institutions.filter(x => ids.includes(x.id) && (x.slug === uq.toLowerCase() || x.name.toLowerCase() === uq.toLowerCase())); if (m.length !== 1) { if (status === 'ok') { status = 'error'; code = m.length ? 'ambiguous_unit' : 'unknown_unit'; } unit = null; } else unit = m[0].id; }
          if (status === 'ok' && Array.isArray(r.errors) && r.errors.length) { status = 'error'; code = r.errors.find(c => CODES.includes(c)) || 'bad_schedule'; }
          const hasVals = Object.keys(vals).length > 0;
          if (status === 'ok') { if (!email) { if (gname && hasVals) status = 'group_only'; else { status = 'error'; code = 'missing_email'; } } else if (!EMAIL_RE.test(email)) { status = 'error'; code = 'bad_email'; } }
          if (status !== 'error' && gname.length > 120) { status = 'error'; code = 'bad_group'; }
          if (status !== 'error' && !gname && Object.keys(vals).some(k => k !== 'teacher_email')) { status = 'error'; code = 'missing_group'; }
          if (status === 'ok') { const k = email.toLowerCase() + '|' + unit + '|' + gname.toLowerCase(); if (seen.has(k)) { status = 'error'; code = 'duplicate'; } else seen.add(k); }
          if (status !== 'error' && gname && temail) { tst = pst(unit, temail); if (['not_allowed', 'bad_email'].includes(tst.status)) { status = 'error'; code = 'unknown_teacher'; } }
          if (status !== 'error' && gname && semail) { const x = pst(unit, semail); if (['not_allowed', 'bad_email'].includes(x.status)) { status = 'error'; code = 'unknown_substitute'; } }
          let def = null; const gkey = gname ? unit + '|' + gname.toLowerCase() : null;
          if (status !== 'error' && gname) {
            G = groups[gkey] || { key: gkey, unit_id: unit, unit: instById(unit)?.name, name: findG(unit, gname)?.name || gname, g: findG(unit, gname) || null, def: {}, students: 0, students_new: 0 };
            for (const k of Object.keys(vals)) if (k in G.def && JSON.stringify(G.def[k]) !== JSON.stringify(vals[k])) { status = 'error'; code = 'conflict'; field = k; break; }
            if (status !== 'error') { def = { ...G.def, ...vals }; if (def.teacher_email && def.teacher_email === def.substitute_email) { status = 'error'; code = 'same_person'; } }
            if (status !== 'error' && !G.g) { if (!b.p_commit || b.p_create_groups) { if (status === 'ok') status = 'new_group'; } else { status = 'error'; code = 'unknown_group'; } }
            if (status !== 'error' && G.g && temail && G.g.teacher_id && tst?.id !== G.g.teacher_id) warning = 'teacher_ignored';
          }
          if (status === 'ok' || status === 'new_group') { const e = db.student_enrollments.find(x => x.institution_id === unit && x.email.toLowerCase() === email.toLowerCase()); if (e && (!gname || (G?.g && db.group_members.some(m => m.group_id === G.g.id && m.enrollment_id === e.id)))) status = 'exists'; }
          if (G && status !== 'error') { G.def = def; if (['ok', 'new_group', 'exists'].includes(status)) G.students++; if (['ok', 'new_group'].includes(status)) G.students_new++; groups[gkey] = G; }
          if (status === 'error') cErr++; else if (status === 'exists') cEx++; else if (status === 'group_only') cG++; else { cOk++; if (status === 'new_group') cNewRows++; }
          if (['ok', 'new_group', 'exists'].includes(status)) work.push({ email, name, unit, gkey });
          out.push({ line, email, name, group: gname, unit: unit ? instById(unit)?.name : null, status, code, field, warning });
        });
        // per group
        let avail = seatsFree(rootOf(b.p_unit)); const newp = []; let cClasses = 0, cChanges = 0;
        const glist = Object.values(groups).map(G => {
          const g = G.g; const d = G.def; const tz = d.timezone || g?.timezone || 'America/Montevideo'; const today = localDate(Date.now(), tz);
          const who = k => { const e = d[k + '_email']; const cur = g?.[k === 'teacher' ? 'teacher_id' : 'substitute_id']; const pend = g?.[k === 'teacher' ? 'pending_teacher_email' : 'pending_substitute_email'];
            if (e) { let w = { ...people[e], email: e }; if (cur) w = { ...w, status: w.id === cur ? 'registered' : 'kept', current: personName(me, cur) };
              else if (w.status === 'registered') w.assign = true;
              else if (['invite', 'add'].includes(w.status)) { if (!newp.includes(e)) newp.push(e); if (newp.indexOf(e) + 1 > avail) w.seats_full = true; }
              return w; }
            if (cur) return { status: 'current', name: personName(me, cur) };
            if (pend) return { status: 'pending', email: pend };
            return null; };
          const teacher = who('teacher'); const substitute = who('substitute');
          const ser = g ? db.session_series.filter(x => x.group_id === g.id && x.origin === 'csv').sort((x, y) => y._n - x._n)[0] : null;
          let schedule = null, st = 'none', se = null, missing = [], classes = 0, past = 0, prev = null, other = 0;
          if (['weekdays', 'start_time', 'duration_min', 'start_date', 'end_date'].some(k => k in d)) {
            missing = ['weekdays', 'start_time', 'duration_min', 'end_date'].filter(k => !(k in d));
            if (missing.length) { st = 'error'; se = 'schedule_incomplete'; }
            else {
              const sd = d.start_date || ser?.start_date || today; const ed = d.end_date;
              if (ed < sd) { st = 'error'; se = 'end_before_start'; }
              else if ((Date.parse(ed) - Date.parse(sd)) / 864e5 > 366) { st = 'error'; se = 'range_too_long'; }
              else {
                const all = dates(d.weekdays, sd, ed); classes = all.filter(x => x >= today && localTs(x, d.start_time, tz).getTime() > Date.now()).length; past = all.length - classes;
                schedule = { weekdays: d.weekdays, start_time: d.start_time, duration_min: d.duration_min, start_date: sd, end_date: ed, timezone: tz };
                if (!ser) st = 'new';
                else if (JSON.stringify([ser.weekdays, ser.start_time, ser.duration_min, ser.start_date, ser.end_date, ser.timezone]) === JSON.stringify([d.weekdays, d.start_time, d.duration_min, sd, ed, tz])) st = 'unchanged';
                else { st = 'changed'; prev = { weekdays: ser.weekdays, start_time: ser.start_time, duration_min: ser.duration_min, start_date: ser.start_date, end_date: ser.end_date, timezone: ser.timezone }; }
                if (!classes && st !== 'unchanged') { st = 'error'; se = 'no_dates'; schedule = null; }
                if (g) other = db.class_sessions.filter(c => c.group_id === g.id && c.status === 'scheduled' && Date.parse(c.starts_at) > Date.now() && c.series_id !== ser?.id).length;
              }
            }
          }
          if (['new', 'changed'].includes(st)) cClasses += classes; if (st === 'changed') cChanges++;
          return { key: G.key, name: G.name, unit: G.unit, unit_id: G.unit_id, group_id: g?.id || null, exists: !!g, teacher, substitute, timezone: tz, schedule, schedule_status: st, schedule_error: se, missing, previous: prev, series_id: ser?.id || null, classes, past_skipped: past, other_classes: other, students: G.students, students_new: G.students_new };
        });
        if (b.p_commit) {
          const gids = {};
          glist.forEach(G => {
            let g = G.group_id ? group(G.group_id) : findG(G.unit_id, G.name);
            if (!g) { g = { id: uid(), institution_id: G.unit_id, name: G.name, teacher_id: null, substitute_id: null, timezone: G.timezone, pending_teacher_email: null, pending_substitute_email: null }; db.class_groups.push(g); }
            else g.timezone = G.timezone;
            gids[G.key] = g.id;
            ['teacher', 'substitute'].forEach(k => { const w = G[k]; if (w?.email && ['registered', 'invite', 'invited', 'add'].includes(w.status) && !g[k === 'teacher' ? 'teacher_id' : 'substitute_id']) { try { assignPerson(me, g, k, w.email); } catch (e) { /* kept */ } } });
          });
          work.forEach(w => { const e = ensureEnrollment(me, w.unit, w.email, w.name, 'csv'); if (w.gkey && gids[w.gkey]) addMember(gids[w.gkey], e.id); });
          glist.forEach(G => {
            if (!['new', 'changed'].includes(G.schedule_status)) return;
            const g = group(gids[G.key]); const sc = G.schedule;
            if (G.schedule_status === 'changed') seriesApply(db.session_series.find(x => x.id === G.series_id), sc, me);
            else {
              const ser = { id: uid(), _n: ++serN, origin: 'csv', group_id: g.id, title: '', ...sc }; db.session_series.push(ser);
              const today = localDate(Date.now(), sc.timezone);
              dates(sc.weekdays, sc.start_date > today ? sc.start_date : today, sc.end_date).forEach(d => { const a = localTs(d, sc.start_time, sc.timezone); if (a.getTime() > Date.now()) newSession({ institution_id: g.institution_id, group_id: g.id, series_id: ser.id, teacher_id: g.teacher_id || me.id, title: '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + sc.duration_min * MIN).toISOString(), timezone: sc.timezone }); });
            }
          });
        }
        return ok({ total: rows.length, ok: cOk, exists: cEx, errors: cErr, new_group_rows: cNewRows, group_rows: cG, new_groups: glist.filter(g => !g.exists).map(g => ({ unit: g.unit, name: g.name })),
          groups: glist, classes: cClasses, schedule_changes: cChanges, seats_available: avail, committed: !!b.p_commit, rows: out });
      }
      case 'my_groups': {
        if (!me) return err('No autorizado');
        return ok(db.class_groups.filter(g => g.teacher_id === me.id || g.substitute_id === me.id).map(g => ({ id: g.id, name: g.name, unit_name: instById(g.institution_id)?.name, institution_id: g.institution_id, timezone: g.timezone, role: g.teacher_id === me.id ? 'teacher' : 'substitute', students: members(g.id).length })));
      }
      case 'create_series': {
        const g = group(b.p_group); if (!g || !teachesGroup(me, g.id)) return err('No autorizado');
        const days = [...new Set(b.p_weekdays || [])].sort(); if (!days.length) return err('Elegí al menos un día de la semana');
        if (!(b.p_duration >= 5 && b.p_duration <= 720)) return err('Duración inválida (de 5 a 720 minutos)');
        if (b.p_end_date < b.p_start_date) return err('La fecha de fin es anterior a la de inicio');
        if ((Date.parse(b.p_end_date) - Date.parse(b.p_start_date)) / 864e5 > 366) return err('Una serie puede durar como máximo un año');
        const series = { id: uid(), _n: ++serN, origin: 'manual', group_id: g.id, weekdays: days, start_time: b.p_start_time, duration_min: b.p_duration, start_date: b.p_start_date, end_date: b.p_end_date, timezone: g.timezone, title: b.p_title || '' };
        db.session_series.push(series);
        const list = dates(days, b.p_start_date, b.p_end_date);
        if (!list.length) return err('Ninguna fecha coincide con los días elegidos');
        list.forEach(d => { const a = localTs(d, b.p_start_time, g.timezone); newSession({ institution_id: g.institution_id, group_id: g.id, series_id: series.id, teacher_id: me.id, title: b.p_title || '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + b.p_duration * MIN).toISOString(), timezone: g.timezone }); });
        return ok({ series_id: series.id, created: list.length });
      }
      case 'update_series': {
        const s = db.session_series.find(x => x.id === b.p_series); if (!s || !teachesGroup(me, s.group_id)) return err('No autorizado');
        const g = group(s.group_id); const days = [...new Set(b.p_weekdays || [])]; if (!days.length) return err('Elegí al menos un día de la semana');
        const today = localDate(Date.now(), s.timezone); const want = dates(days, s.start_date > today ? s.start_date : today, b.p_end_date);
        const fut = db.class_sessions.filter(c => c.series_id === s.id && Date.parse(c.starts_at) > Date.now() && !c.modified);
        let removed = 0, updated = 0, created = 0;
        fut.forEach(c => { const d = localDate(Date.parse(c.starts_at), s.timezone); if (!want.includes(d)) { db.class_sessions = db.class_sessions.filter(x => x !== c); removed++; } else { const a = localTs(d, b.p_start_time, s.timezone); Object.assign(c, { title: b.p_title || '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + b.p_duration * MIN).toISOString(), seq: c.seq + 1 }); updated++; } });
        want.forEach(d => { const a = localTs(d, b.p_start_time, s.timezone); if (a.getTime() > Date.now() && !db.class_sessions.some(c => c.series_id === s.id && localDate(Date.parse(c.starts_at), s.timezone) === d)) { newSession({ institution_id: g.institution_id, group_id: g.id, series_id: s.id, teacher_id: me.id, title: b.p_title || '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + b.p_duration * MIN).toISOString(), timezone: s.timezone }); created++; } });
        Object.assign(s, { weekdays: days, start_time: b.p_start_time, duration_min: b.p_duration, end_date: b.p_end_date, title: b.p_title || '' });
        return ok({ updated, created, removed });
      }
      case 'cancel_series': {
        const s = db.session_series.find(x => x.id === b.p_series); if (!s || !teachesGroup(me, s.group_id)) return err('No autorizado');
        let n = 0; db.class_sessions.forEach(c => { if (c.series_id === s.id && Date.parse(c.starts_at) > Date.now() && c.status !== 'cancelled') { c.status = 'cancelled'; c.seq++; n++; } }); return ok(n);
      }
      case 'create_session': {
        if (!me) return err('No autorizado');
        const emails = [...new Set((b.p_emails || []).map(x => String(x).trim()).filter(Boolean))];
        const bad = emails.find(e => !EMAIL_RE.test(e)); if (bad) return err('Email inválido: ' + bad);
        let inst, tz; const p = prof(me.id);
        if (b.p_group) { const g = group(b.p_group); if (!g || !teachesGroup(me, g.id)) return err('No autorizado'); inst = g.institution_id; tz = g.timezone; }
        else { if (!['teacher', 'org_admin'].includes(p?.role) || !p.institution_id) return err('Para crear una clase sin grupo necesitás pertenecer a una institución'); if (!emails.length) return err('Agregá al menos un email de estudiante'); inst = p.institution_id; tz = b.p_timezone || 'America/Montevideo'; }
        if (!(b.p_duration >= 5 && b.p_duration <= 720)) return err('Duración inválida (de 5 a 720 minutos)');
        const a = new Date(b.p_starts_at); if (Number.isNaN(a.getTime()) || a.getTime() < Date.now() - 864e5) return err('Fecha de la clase inválida');
        const s = newSession({ institution_id: inst, group_id: b.p_group || null, teacher_id: me.id, title: b.p_title || '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + b.p_duration * MIN).toISOString(), timezone: tz });
        emails.forEach(e => { const en = ensureEnrollment(me, inst, e, '', 'session'); if (!db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === en.id)) db.session_invitees.push({ session_id: s.id, enrollment_id: en.id }); });
        return ok({ id: s.id, invited: emails.length });
      }
      case 'update_session': {
        const s = db.class_sessions.find(x => x.id === b.p_session); if (!teachesSession(me, s)) return err('No autorizado');
        const a = new Date(b.p_starts_at); Object.assign(s, { title: b.p_title || '', starts_at: a.toISOString(), ends_at: new Date(a.getTime() + b.p_duration * MIN).toISOString(), seq: s.seq + 1, modified: !!s.series_id }); return ok(s.id);
      }
      case 'cancel_session': {
        const s = db.class_sessions.find(x => x.id === b.p_session); if (!teachesSession(me, s)) return err('No autorizado');
        s.status = b.p_cancel === false ? 'scheduled' : 'cancelled'; s.seq++; if (s.series_id) s.modified = true; return ok(s.status);
      }
      case 'my_calendar': {
        if (!me) return err('No autorizado');
        const from = Date.parse(b.p_from), to = Date.parse(b.p_to); if (!(to > from) || to - from > 200 * 864e5) return err('Rango de fechas inválido');
        return ok(calRows(me, me.id, from, to));
      }
      case 'unit_calendar': {
        if (!b.p_unit || !isAdminOf(me, b.p_unit)) return err('No autorizado');
        const ids = scope(b.p_unit); const from = Date.parse(b.p_from), to = Date.parse(b.p_to);
        return ok(db.class_sessions.filter(s => ids.includes(s.institution_id) && Date.parse(s.starts_at) < to && Date.parse(s.ends_at) > from).sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)).map(s => {
          const g = s.group_id && group(s.group_id);
          return { id: s.id, title: s.title || g?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: g?.name || null, unit_name: instById(s.institution_id)?.name, series_id: s.series_id, role: 'admin', can_edit: false, teacher_name: personName(me, g?.teacher_id || s.teacher_id), people: people(s) };
        }));
      }
      case 'session_people': {
        const s = db.class_sessions.find(x => x.id === b.p_session); if (!s || !(teachesSession(me, s) || isAdminOf(me, s.institution_id))) return err('No autorizado');
        const g = s.group_id ? members(s.group_id).map(e => ({ enrollment_id: e.id, name: e.name, email: e.email, via: 'group' })) : [];
        const inv = invitees(s.id).filter(e => !g.some(x => x.enrollment_id === e.id)).map(e => ({ enrollment_id: e.id, name: e.name, email: e.email, via: 'invite' }));
        return ok([...g, ...inv]);
      }
      case 'student_view': {
        let ens = [], groups = [], me2 = { name: '', email: '' };
        if (!b.p_group && !b.p_enrollment) { if (!me) return err('No autorizado'); ens = db.student_enrollments.filter(e => e.user_id === me.id); me2 = { name: (ens.find(e => e.name) || {}).name || prof(me.id)?.name || '', email: user(me.id)?.email || '' }; }
        else { if (!isSA(me)) return err('No autorizado'); if (b.p_enrollment) { const e = enr(b.p_enrollment); if (!e) return err('No autorizado'); ens = [e]; me2 = { name: e.name, email: e.email }; } else groups = [b.p_group]; }
        const eids = ens.map(e => e.id);
        groups = [...new Set([...groups, ...db.group_members.filter(m => eids.includes(m.enrollment_id)).map(m => m.group_id)])];
        const now = Date.now();
        const sessions = db.class_sessions.filter(s => (groups.includes(s.group_id) || db.session_invitees.some(i => i.session_id === s.id && eids.includes(i.enrollment_id))) && Date.parse(s.ends_at) > now - 864e5 && Date.parse(s.starts_at) < now + 120 * 864e5)
          .sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)).map(s => { const g = s.group_id && group(s.group_id); return { id: s.id, title: s.title || g?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_name: g?.name || null, teacher_name: personName(me, g?.teacher_id || s.teacher_id) }; });
        return ok({ me: me2, enrollments: ens.length, sessions, insights: ctx.insightSummaries ? ctx.insightSummaries(eids, me) : [],
          groups: groups.map(group).filter(Boolean).map(g => ({ id: g.id, name: g.name, unit_name: instById(g.institution_id)?.name, institution_name: instById(rootOf(g.institution_id))?.name, timezone: g.timezone, teacher_name: personName(me, g.teacher_id), substitute_name: personName(me, g.substitute_id), classmates: members(g.id).length })) });
      }
      case 'my_calendar_token': {
        if (!me) return err('No autorizado');
        let t = db.calendar_tokens.find(x => x.user_id === me.id);
        if (b.p_reset && t) { db.calendar_tokens = db.calendar_tokens.filter(x => x !== t); t = null; }
        if (!t) { t = { user_id: me.id, token: [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') }; db.calendar_tokens.push(t); }
        return ok(t.token);
      }
      case 'calendar_feed': {
        const t = db.calendar_tokens.find(x => x.token === b.p_token); if (!t) return ok([]);
        return ok(calRows(null, t.user_id, Date.now() - 60 * 864e5, Date.now() + 400 * 864e5).map(r => ({ id: r.id, title: r.title, group_name: r.group_name, starts_at: r.starts_at, ends_at: r.ends_at, status: r.status, seq: r.seq, updated_at: r.updated_at, teacher_name: r.teacher_name, role: r.role })));
      }
      default: return undefined;
    }
  }
  return { handle, state: S, localTs, applyPending };
};
