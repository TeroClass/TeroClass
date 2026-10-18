// Groups + students + calendar for the simulated Supabase (tests only). Same privacy rules as the SQL
// functions in supabase/migrations/001_base.sql ("GRUPOS, ESTUDIANTES Y CALENDARIO"), simplified.
// Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns {status, data} or undefined.
const MIN = 60000;
const EMAIL_RE = /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[A-Za-z]{2,24}$/;
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });

module.exports = function install(ctx) {
  const { db, uid, instById, chainOf, descendantsOf, rootOf } = ctx;
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
        teacher_name: personName(me, g?.teacher_id || s.teacher_id), people: people(s), can_edit: role !== 'student' };
    });
  }
  function newSession(fields) { const now = new Date().toISOString(); const s = { id: uid(), status: 'scheduled', seq: 0, modified: false, series_id: null, title: '', created_at: now, updated_at: now, ...fields }; db.class_sessions.push(s); return s; }

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
          teacher: personJson(me, g.teacher_id), substitute: personJson(me, g.substitute_id), students: members(g.id).length,
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
        if (g0) { Object.assign(g0, { name, teacher_id: b.p_teacher || null, substitute_id: b.p_substitute || null, timezone: b.p_timezone || g0.timezone }); return ok(g0.id); }
        const g = { id: uid(), institution_id: unit, name, teacher_id: b.p_teacher || null, substitute_id: b.p_substitute || null, timezone: b.p_timezone || 'America/Montevideo' };
        db.class_groups.push(g); return ok(g.id);
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
        const ids = scope(b.p_unit); const root = rootOf(b.p_unit); const seen = new Set(); const newG = {}; const out = []; let cOk = 0, cEx = 0, cErr = 0, cNewRows = 0;
        rows.forEach((r, i) => {
          const line = Number.isInteger(r.line) ? r.line : i + 2; const email = String(r.email || '').trim(); const name = String(r.name || '').trim().slice(0, 120);
          const gname = String(r.group || '').trim(); const temail = String(r.teacher_email || '').trim().toLowerCase(); const uq = String(r.unit || '').trim();
          let status = 'ok', code = null, warning = null, unit = b.p_unit, g = null, teacher = null;
          if (uq) { const m = db.institutions.filter(x => ids.includes(x.id) && (x.slug === uq.toLowerCase() || x.name.toLowerCase() === uq.toLowerCase())); if (!m.length) { status = 'error'; code = 'unknown_unit'; unit = null; } else if (m.length > 1) { status = 'error'; code = 'ambiguous_unit'; unit = null; } else unit = m[0].id; }
          if (status === 'ok') { if (!email) { status = 'error'; code = 'missing_email'; } else if (!EMAIL_RE.test(email)) { status = 'error'; code = 'bad_email'; } else if (gname.length > 120) { status = 'error'; code = 'bad_group'; } }
          if (status === 'ok') { const k = email.toLowerCase() + '|' + unit + '|' + gname.toLowerCase(); if (seen.has(k)) { status = 'error'; code = 'duplicate'; } else seen.add(k); }
          if (status === 'ok' && temail) { const p = db.profiles.find(x => x.email.toLowerCase() === temail && ['teacher', 'org_admin'].includes(x.role) && x.institution_id && isAdminOf(me, x.institution_id) && rootOf(x.institution_id) === root); if (!p) { status = 'error'; code = 'unknown_teacher'; } else teacher = p.id; }
          if (status === 'ok' && gname) {
            g = db.class_groups.find(x => x.institution_id === unit && x.name.toLowerCase() === gname.toLowerCase());
            if (!g) { if (!b.p_commit || b.p_create_groups) { status = 'new_group'; newG[unit + '|' + gname.toLowerCase()] = { unit: instById(unit)?.name, name: gname }; } else { status = 'error'; code = 'unknown_group'; } }
            else if (teacher && g.teacher_id && g.teacher_id !== teacher) warning = 'teacher_ignored';
          }
          if (status === 'ok' || status === 'new_group') {
            const e = db.student_enrollments.find(x => x.institution_id === unit && x.email.toLowerCase() === email.toLowerCase());
            if (e && (!gname || (g && db.group_members.some(m => m.group_id === g.id && m.enrollment_id === e.id)))) status = 'exists';
          }
          if (b.p_commit && ['ok', 'new_group', 'exists'].includes(status)) {
            if (gname && !g) { g = db.class_groups.find(x => x.institution_id === unit && x.name.toLowerCase() === gname.toLowerCase()); if (!g) { g = { id: uid(), institution_id: unit, name: gname, teacher_id: teacher, substitute_id: null, timezone: 'America/Montevideo' }; db.class_groups.push(g); } }
            if (g && !g.teacher_id && teacher) g.teacher_id = teacher;
            const e = ensureEnrollment(me, unit, email, name, 'csv'); if (g) addMember(g.id, e.id);
          }
          if (status === 'error') cErr++; else if (status === 'exists') cEx++; else { cOk++; if (status === 'new_group') cNewRows++; }
          out.push({ line, email, name, group: gname, unit: unit ? instById(unit)?.name : null, status, code, warning });
        });
        return ok({ total: rows.length, ok: cOk, exists: cEx, errors: cErr, new_group_rows: cNewRows, new_groups: Object.values(newG), committed: !!b.p_commit, rows: out });
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
        const series = { id: uid(), group_id: g.id, weekdays: days, start_time: b.p_start_time, duration_min: b.p_duration, start_date: b.p_start_date, end_date: b.p_end_date, timezone: g.timezone, title: b.p_title || '' };
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
        return ok({ me: me2, enrollments: ens.length, sessions, insights: [],
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
  return { handle, state: S, localTs };
};
