// Class document + attendance for the simulated Supabase (tests only). Same rules as the SQL functions in
// supabase/migrations/001_base.sql ("DOCUMENTO DE LA CLASE" and "ASISTENCIA"), simplified.
// Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns {status, data} or undefined; studentExtras(eids)
// adds {attendance, docs} to student_view; canRealtime(me, topic, send) is the realtime.messages policy (mock-realtime.cjs).
const MIN = 60000;
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });
const PALETTE = ['#7c5cbf', '#0891b2', '#d97706', '#059669', '#db2777', '#4f46e5', '#b45309', '#0f766e', '#9333ea', '#dc2626'];

module.exports = function install(ctx) {
  const { db, uid, chainOf, descendantsOf, instById } = ctx;
  let updSeq = 0;
  const prof = id => db.profiles.find(p => p.id === id);
  const isSA = me => prof(me?.id)?.role === 'superadmin';
  const isAdminOf = (me, inst) => { const p = prof(me?.id); if (!p) return false; if (p.role === 'superadmin') return true; return !!inst && p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id); };
  const group = id => db.class_groups.find(g => g.id === id);
  const sess = id => db.class_sessions.find(s => s.id === id);
  const enr = id => db.student_enrollments.find(e => e.id === id);
  const teachesGroup = (me, gid) => { const g = group(gid); return !!(g && me && (g.teacher_id === me.id || g.substitute_id === me.id)); };
  const teachesSession = (me, s) => !!s && !!me && (s.group_id ? teachesGroup(me, s.group_id) : s.teacher_id === me.id);
  const sessionStudents = s => {
    const ids = new Set([...(s.group_id ? db.group_members.filter(m => m.group_id === s.group_id).map(m => m.enrollment_id) : []), ...db.session_invitees.filter(i => i.session_id === s.id).map(i => i.enrollment_id)]);
    return [...ids].map(enr).filter(Boolean);
  };
  const enrollmentOf = (me, s) => me && sessionStudents(s).find(e => e.user_id === me.id) || null;
  const personName = (me, id) => { const p = prof(id); if (!p) return ''; if (p.role === 'superadmin' && !isSA(me)) return 'TeroClass team'; return p.name || ''; };
  const role = (me, s) => !me || !s ? null : teachesSession(me, s) ? 'teacher' : enrollmentOf(me, s) ? 'student' : isAdminOf(me, s.institution_id) ? 'admin' : null;
  const color = (sid, u) => PALETTE[[...String(sid) + String(u)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
  const docName = (me, s, r) => (r === 'student' ? (enrollmentOf(me, s)?.name || '').trim() : '') || personName(me, me.id) || 'Participante';
  const docOf = sid => db.class_docs.find(d => d.session_id === sid);
  const ensureDoc = sid => { let d = docOf(sid); if (!d) { d = { session_id: sid, state: null, state_upto: 0, generation: 1, locked: false, channel_key: [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''), updated_at: new Date().toISOString() }; db.class_docs.push(d); } return d; };
  const updatesOf = (sid, gen, after) => db.class_doc_updates.filter(u => u.session_id === sid && u.generation === gen && u.id > after).sort((a, b) => a.id - b.id);
  const b64ok = v => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(v);
  function addVersion(sid, label, me) {
    const d = docOf(sid); if (!d) return null;
    const parts = [...(d.state ? [d.state] : []), ...updatesOf(sid, d.generation, d.state_upto).map(u => u.d)];
    if (!parts.length) return null;
    const v = { id: uid(), session_id: sid, parts, label, created_by: ['manual', 'before_restore'].includes(label) ? me?.id : null, created_at: new Date().toISOString() };
    db.class_doc_versions.push(v);
    const mine = db.class_doc_versions.filter(x => x.session_id === sid).sort((a, b) => (b.label === 'class_end') - (a.label === 'class_end') || (b.created_at > a.created_at ? 1 : -1));
    mine.slice(20).forEach(x => { db.class_doc_versions = db.class_doc_versions.filter(y => y !== x); });
    return v.id;
  }
  // ── attendance helpers ──
  const lateMin = inst => { for (const i of chainOf(inst).reverse()) if (i.attendance_late_minutes != null) return i.attendance_late_minutes; return 10; };
  const effStatus = (a, s) => (a?.status) || (a?.first_join ? (a.auto_status || 'present') : (Date.now() > Date.parse(s.ends_at) ? 'absent' : 'pending'));
  const attRow = (sid, eid) => db.session_attendance.find(a => a.session_id === sid && a.enrollment_id === eid);
  function touch(me, s, mode) {
    if (!s || !me) return err('No autorizado');
    let kind, e = null;
    if (teachesSession(me, s)) kind = 'teacher'; else { e = enrollmentOf(me, s); if (!e) return err('No autorizado'); kind = 'student'; }
    const now = Date.now(); const a0 = Date.parse(s.starts_at); const b0 = Date.parse(s.ends_at);
    if (kind === 'student' && mode === 'join') {
      if (s.status === 'cancelled') return err('La clase está cancelada');
      if (now < a0 - 10 * MIN || now > b0) return err('La clase no está abierta ahora');
    }
    let r = kind === 'teacher' ? db.session_attendance.find(a => a.session_id === s.id && a.kind === 'teacher' && a.user_id === me.id) : attRow(s.id, e.id);
    if (!r) {
      if (mode === 'leave') return ok({ recorded: false, status: null });
      r = { id: uid(), session_id: s.id, enrollment_id: e?.id || null, user_id: me.id, kind, first_join: null, last_seen: null, last_leave: null, seconds_present: 0, in_room: false, joins: 0, auto_status: null, status: null, source: 'auto', note: '' };
      db.session_attendance.push(r);
    }
    if (r.in_room && r.last_seen && now - Date.parse(r.last_seen) <= 150000) r.seconds_present += Math.max(0, Math.floor((Math.min(now, b0) - Math.max(Date.parse(r.last_seen), a0)) / 1000));
    if (!r.first_join) r.first_join = new Date(now).toISOString();
    if (!r.auto_status && kind === 'student') r.auto_status = now > a0 + lateMin(s.institution_id) * MIN ? 'late' : 'present';
    if (mode === 'join') r.joins++;
    r.last_seen = new Date(now).toISOString(); r.in_room = mode !== 'leave'; if (mode === 'leave') r.last_leave = r.last_seen;
    return ok({ recorded: true, kind, minutes: Math.round(r.seconds_present / 60), status: kind === 'student' ? effStatus(r, s) : null });
  }
  function summary(eids) {
    const now = Date.now(); const rows = [];
    db.class_sessions.filter(s => s.status === 'scheduled' && Date.parse(s.ends_at) < now).forEach(s => {
      eids.forEach(eid => {
        const m = s.group_id && db.group_members.find(x => x.group_id === s.group_id && x.enrollment_id === eid);
        const memberOk = m && (!m.created_at || Date.parse(s.starts_at) >= new Date(new Date(m.created_at).setHours(0, 0, 0, 0)).getTime());
        const inv = db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === eid);
        if (memberOk || inv) rows.push({ s, st: effStatus(attRow(s.id, eid), s), g: group(s.group_id)?.name || '' });
      });
    });
    const c = k => rows.filter(r => r.st === k).length;
    const byG = {}; rows.forEach(r => { const x = byG[r.g] = byG[r.g] || { name: r.g, held: 0, attended: 0 }; x.held++; if (['present', 'late'].includes(r.st)) x.attended++; });
    return { held: rows.length, attended: c('present') + c('late'), present: c('present'), late: c('late'), absent: c('absent'), excused: c('excused'), groups: Object.values(byG) };
  }

  function handle(fn, b, me) {
    switch (fn) {
      // ═══════════ class document ═══════════
      case 'classdoc_open': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        const g = group(s.group_id); const d = docOf(s.id);
        return ok({ session: { id: s.id, title: s.title || g?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: g?.name || null, teacher_name: personName(me, g?.teacher_id || s.teacher_id), planning_id: r === 'teacher' ? (s.planning_id || null) : null },
          role: r, can_edit: r === 'teacher' || (r === 'student' && !d?.locked), can_lock: r === 'teacher', locked: !!d?.locked, generation: d?.generation || 1,
          state: d?.state || null, upto: d?.state_upto || 0, updates: d ? updatesOf(s.id, d.generation, d.state_upto).map(u => ({ id: u.id, d: u.d, c: u.c })) : [],
          channel: { topic: 'classdoc:' + s.id, key: d?.channel_key || null }, me: ['teacher', 'student'].includes(r) ? { name: docName(me, s, r), color: color(s.id, me.id) } : null,
          versions: db.class_doc_versions.filter(v => v.session_id === s.id).length, updated_at: d?.updated_at || null });
      }
      case 'classdoc_push': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        if (!['teacher', 'student'].includes(r)) return err('Solo lectura: no podés editar este documento');
        if (!b64ok(b.p_update)) return err('Cambio inválido');
        const d = ensureDoc(s.id);
        if (r === 'student' && d.locked) return err('El docente bloqueó el documento');
        if (b.p_generation !== d.generation) return err('Documento desactualizado: volvé a abrirlo');
        if (Date.now() > Date.parse(s.ends_at) && !db.class_doc_versions.some(v => v.session_id === s.id && v.label === 'class_end')) addVersion(s.id, 'class_end', me);
        const last = db.class_doc_versions.filter(v => v.session_id === s.id).map(v => Date.parse(v.created_at)).sort().pop();
        if (!last || last < Date.now() - 10 * MIN) addVersion(s.id, 'auto', me);
        const u = { id: ++updSeq, session_id: s.id, generation: d.generation, d: b.p_update, c: String(b.p_client || '').slice(0, 40), user_id: me.id };
        db.class_doc_updates.push(u); d.updated_at = new Date().toISOString();
        return ok({ id: u.id, generation: d.generation });
      }
      case 'classdoc_pull': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        const client = String(b.p_client || '').slice(0, 40);
        if (b.p_presence && ['teacher', 'student'].includes(r) && client) {
          let p = db.class_doc_presence.find(x => x.session_id === s.id && x.client_id === client);
          if (!p) { p = { session_id: s.id, client_id: client, user_id: me.id }; db.class_doc_presence.push(p); }
          if (p.user_id === me.id) Object.assign(p, { name: docName(me, s, r), color: color(s.id, me.id), role: r, state: typeof b.p_presence === 'object' ? b.p_presence : {}, seen_at: Date.now() });
        }
        const d = docOf(s.id);
        const reset = !!d && (b.p_generation !== d.generation || (b.p_after || 0) < d.state_upto);
        return ok({ generation: d?.generation || 1, locked: !!d?.locked, can_edit: r === 'teacher' || (r === 'student' && !d?.locked), reset,
          state: reset ? d.state : null, upto: d?.state_upto || 0,
          updates: d ? updatesOf(s.id, d.generation, reset ? d.state_upto : Math.max(b.p_after || 0, d.state_upto)).slice(0, 2000).map(u => ({ id: u.id, d: u.d, c: u.c })) : [],
          presence: db.class_doc_presence.filter(x => x.session_id === s.id && x.client_id !== client && Date.now() - x.seen_at < 45000).map(x => ({ client: x.client_id, name: x.name, color: x.color, role: x.role, state: x.state })) });
      }
      case 'classdoc_snapshot': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        if (!['teacher', 'student'].includes(r)) return err('Solo lectura: no podés editar este documento');
        if (!b64ok(b.p_state)) return err('Cambio inválido');
        const d = ensureDoc(s.id);
        if (r === 'student' && d.locked) return err('El docente bloqueó el documento');
        if (b.p_generation !== d.generation) return err('Documento desactualizado: volvé a abrirlo');
        if ((b.p_upto ?? -1) < d.state_upto) return ok({ ok: false, upto: d.state_upto });
        const max = Math.max(0, ...db.class_doc_updates.filter(u => u.session_id === s.id && u.generation === d.generation).map(u => u.id));
        if (b.p_upto > Math.max(max, d.state_upto)) return err('Cambio inválido');
        d.state = b.p_state; d.state_upto = b.p_upto;
        db.class_doc_updates = db.class_doc_updates.filter(u => !(u.session_id === s.id && u.id <= b.p_upto));
        return ok({ ok: true, upto: b.p_upto });
      }
      case 'classdoc_set_lock': {
        const s = sess(b.p_session); if (role(me, s) !== 'teacher') return err('No autorizado');
        const d = ensureDoc(s.id); d.locked = !!b.p_locked; return ok({ locked: d.locked });
      }
      case 'classdoc_versions': {
        const s = sess(b.p_session); if (!role(me, s)) return err('No autorizado');
        return ok(db.class_doc_versions.filter(v => v.session_id === s.id).sort((a, c) => (c.created_at > a.created_at ? 1 : -1)).map(v => ({ id: v.id, label: v.label, created_at: v.created_at, bytes: 0, by: v.created_by ? personName(me, v.created_by) : null })));
      }
      case 'classdoc_version': {
        const v = db.class_doc_versions.find(x => x.id === b.p_version); if (!v || !role(me, sess(v.session_id))) return err('No autorizado');
        return ok({ id: v.id, session_id: v.session_id, label: v.label, created_at: v.created_at, parts: v.parts });
      }
      case 'classdoc_add_version': {
        const s = sess(b.p_session); if (role(me, s) !== 'teacher') return err('No autorizado');
        if (!['manual', 'class_end'].includes(b.p_label)) return err('Versión inválida');
        if (!docOf(s.id)) return ok({ id: null, created: false });
        if (b.p_label === 'class_end' && db.class_doc_versions.some(v => v.session_id === s.id && v.label === 'class_end')) return ok({ id: null, created: false });
        const id = addVersion(s.id, b.p_label, me); return ok({ id, created: !!id });
      }
      case 'classdoc_restore': {
        const v = db.class_doc_versions.find(x => x.id === b.p_version); if (!v || role(me, sess(v.session_id)) !== 'teacher') return err('No autorizado');
        const d = ensureDoc(v.session_id); addVersion(v.session_id, 'before_restore', me);
        db.class_doc_updates = db.class_doc_updates.filter(u => u.session_id !== v.session_id);
        d.generation++; d.state = null; d.state_upto = 0;
        v.parts.forEach(p => db.class_doc_updates.push({ id: ++updSeq, session_id: v.session_id, generation: d.generation, d: p, c: 'restore', user_id: me.id }));
        return ok({ generation: d.generation, restored: v.id });
      }
      case 'group_sessions': {
        const g = group(b.p_group); if (!g || !(teachesGroup(me, g.id) || isAdminOf(me, g.institution_id))) return err('No autorizado');
        const now = Date.now(); const past = (b.p_past_days ?? 60) * 864e5; const fut = (b.p_future_days ?? 30) * 864e5;
        return ok({ group: { id: g.id, name: g.name, timezone: g.timezone, unit_name: instById(g.institution_id)?.name }, can_edit: teachesGroup(me, g.id),
          sessions: db.class_sessions.filter(s => s.group_id === g.id && Date.parse(s.starts_at) > now - past && Date.parse(s.starts_at) < now + fut).sort((a, c) => Date.parse(c.starts_at) - Date.parse(a.starts_at))
            .map(s => { const d = docOf(s.id); return { id: s.id, title: s.title || g.name, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, has_doc: !!d, doc_locked: !!d?.locked, doc_updated_at: d?.updated_at || null }; }) });
      }
      // ═══════════ attendance ═══════════
      case 'attendance_join': return touch(me, sess(b.p_session), 'join');
      case 'attendance_heartbeat': return touch(me, sess(b.p_session), 'beat');
      case 'attendance_leave': return touch(me, sess(b.p_session), 'leave');
      case 'session_attendance': {
        const s = sess(b.p_session); if (!s || !(teachesSession(me, s) || isAdminOf(me, s.institution_id))) return err('No autorizado');
        const g = group(s.group_id); const ended = Date.now() > Date.parse(s.ends_at);
        const people = [...sessionStudents(s)];
        db.session_attendance.filter(a => a.session_id === s.id && a.enrollment_id && !people.some(p => p.id === a.enrollment_id)).forEach(a => { const e = enr(a.enrollment_id); if (e) people.push(e); });
        const students = people.map(e => { const a = attRow(s.id, e.id); return { enrollment_id: e.id, name: (e.name || '').trim() || e.email.split('@')[0], email: e.email, status: effStatus(a, s), auto_status: a?.auto_status || null, override: a?.status || null,
          source: a?.source || 'auto', note: a?.note || '', minutes: Math.round((a?.seconds_present || 0) / 60), first_join: a?.first_join || null, last_leave: a?.last_leave || null, joins: a?.joins || 0,
          in_room: !!(a?.in_room && Date.now() - Date.parse(a.last_seen) < 150000) }; }).sort((x, y) => x.name.localeCompare(y.name));
        const cnt = k => students.filter(x => x.status === k).length;
        return ok({ session: { id: s.id, title: s.title || g?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: g?.name || null },
          can_edit: teachesSession(me, s), late_minutes: lateMin(s.institution_id), started: Date.now() >= Date.parse(s.starts_at), ended, students,
          counts: { present: cnt('present'), late: cnt('late'), absent: cnt('absent'), excused: cnt('excused'), pending: cnt('pending'), total: students.length },
          staff: db.session_attendance.filter(a => a.session_id === s.id && a.kind === 'teacher').map(a => ({ name: personName(me, a.user_id), first_join: a.first_join, minutes: Math.round(a.seconds_present / 60) })) });
      }
      case 'set_attendance': {
        const s = sess(b.p_session); if (!s || !teachesSession(me, s)) return err('No autorizado');
        const st = b.p_status || null; if (st && !['present', 'late', 'absent', 'excused'].includes(st)) return err('Estado de asistencia inválido');
        if (!sessionStudents(s).some(e => e.id === b.p_enrollment) && !attRow(s.id, b.p_enrollment)) return err('Ese estudiante no es de esta clase');
        let a = attRow(s.id, b.p_enrollment);
        if (!a) { a = { id: uid(), session_id: s.id, enrollment_id: b.p_enrollment, user_id: null, kind: 'student', first_join: null, last_seen: null, seconds_present: 0, in_room: false, joins: 0, auto_status: null, status: null, source: 'auto', note: '' }; db.session_attendance.push(a); }
        a.status = st; a.source = st ? 'teacher' : 'auto'; if (b.p_note != null) a.note = String(b.p_note).trim().slice(0, 500);
        return ok({ status: effStatus(a, s), override: a.status, source: a.source, note: a.note });
      }
      case 'attendance_report': {
        const g = group(b.p_group); if (!g || !(teachesGroup(me, g.id) || isAdminOf(me, g.institution_id))) return err('No autorizado');
        const day = ms => new Intl.DateTimeFormat('en-CA', { timeZone: g.timezone }).format(new Date(ms));
        const to = b.p_to || day(Date.now()); const from = b.p_from || day(Date.now() - 89 * 864e5);
        if (from > to) return err('Rango de fechas inválido');
        const ses = db.class_sessions.filter(s => s.group_id === g.id && s.status === 'scheduled' && Date.parse(s.starts_at) <= Date.now() && day(Date.parse(s.starts_at)) >= from && day(Date.parse(s.starts_at)) <= to).sort((a, c) => Date.parse(a.starts_at) - Date.parse(c.starts_at));
        const mem = db.group_members.filter(m => m.group_id === g.id).map(m => ({ e: enr(m.enrollment_id), since: m.created_at, member: true })).filter(x => x.e);
        db.session_attendance.filter(a => ses.some(s => s.id === a.session_id) && a.enrollment_id && !mem.some(x => x.e.id === a.enrollment_id)).forEach(a => { if (!mem.some(x => x.e.id === a.enrollment_id)) mem.push({ e: enr(a.enrollment_id), since: null, member: false }); });
        const all = [];
        const students = mem.filter(x => x.e).map(x => {
          const cells = ses.map(s => { const a = attRow(s.id, x.e.id); const before = x.since && Date.parse(s.starts_at) < new Date(new Date(x.since).setHours(0, 0, 0, 0)).getTime();
            const st = !a && (!x.member || before) ? null : effStatus(a, s); all.push(st); return { s: st, src: a?.source || null }; });
          const c = k => cells.filter(y => y.s === k).length; const n = c('present') + c('late') + c('absent');
          return { enrollment_id: x.e.id, name: (x.e.name || '').trim() || x.e.email.split('@')[0], email: x.e.email, member: x.member, present: c('present'), late: c('late'), absent: c('absent'), excused: c('excused'), pct: n ? Math.round(100 * (c('present') + c('late')) / n) : null, cells };
        }).sort((x, y) => (y.member - x.member) || x.name.localeCompare(y.name));
        const t = k => all.filter(y => y === k).length; const n = t('present') + t('late') + t('absent');
        return ok({ group: { id: g.id, name: g.name, timezone: g.timezone, unit_name: instById(g.institution_id)?.name }, from, to, can_edit: teachesGroup(me, g.id), late_minutes: lateMin(g.institution_id),
          sessions: ses.map(s => ({ id: s.id, title: s.title || g.name, starts_at: s.starts_at, ends_at: s.ends_at })), students,
          totals: { present: t('present'), late: t('late'), absent: t('absent'), excused: t('excused'), rate: n ? Math.round(100 * (t('present') + t('late')) / n) : null } });
      }
      case 'set_attendance_late_minutes': {
        const i = instById(b.p_unit); if (!i || !isAdminOf(me, i.id)) return err('No autorizado');
        i.attendance_late_minutes = b.p_minutes; return ok({ late_minutes: lateMin(i.id), own: b.p_minutes });
      }
      default: return undefined;
    }
  }
  // realtime.messages policy: listen = anyone with access; send = teacher / students
  function canRealtime(me, topic, send) {
    const m = /^classdoc:([0-9a-f-]{36})$/.exec(String(topic || '')); if (!m) return false;
    const r = role(me, sess(m[1])); return send ? ['teacher', 'student'].includes(r) : !!r;
  }
  const publicTopicOk = topic => { const m = /^classdoc-([0-9a-f]{64})$/.exec(String(topic || '')); return !!m && db.class_docs.some(d => d.channel_key === m[1]); };
  function studentExtras(eids) {
    const now = Date.now();
    const groups = new Set(db.group_members.filter(m => eids.includes(m.enrollment_id)).map(m => m.group_id));
    const docs = db.class_docs.map(d => sess(d.session_id)).filter(s => s && Date.parse(s.ends_at) <= now && Date.parse(s.ends_at) > now - 90 * 864e5
        && (groups.has(s.group_id) || db.session_invitees.some(i => i.session_id === s.id && eids.includes(i.enrollment_id))))
      .sort((a, c) => Date.parse(c.starts_at) - Date.parse(a.starts_at)).slice(0, 8)
      .map(s => ({ id: s.id, title: s.title || group(s.group_id)?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, group_name: group(s.group_id)?.name || null }));
    return { attendance: summary(eids), docs };
  }
  return { handle, studentExtras, summary, canRealtime, publicTopicOk, role };
};
