// Class insights for the simulated Supabase (tests only). Same rules as the SQL functions in
// supabase/migrations/001_base.sql ("INSIGHTS DE CLASE"), simplified: generate_demo_insights,
// list_insight_sessions, get_session_insights, save_teacher_reflection, save_insight_message, my_insights, my_insight.
// Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns {status, data} or undefined.
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });

module.exports = function install(ctx) {
  const { db, uid, instById, chainOf, descendantsOf, rootOf } = ctx;
  const prof = id => db.profiles.find(p => p.id === id);
  const isSA = me => prof(me?.id)?.role === 'superadmin';
  const isAdminOf = (me, inst) => { const p = prof(me?.id); if (!p) return false; if (p.role === 'superadmin') return true; return !!inst && p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id); };
  const group = id => db.class_groups.find(g => g.id === id);
  const sess = id => db.class_sessions.find(s => s.id === id);
  const enr = id => db.student_enrollments.find(e => e.id === id);
  const teachesSession = (me, s) => { if (!me || !s) return false; if (s.group_id) { const g = group(s.group_id); return !!g && (g.teacher_id === me.id || g.substitute_id === me.id); } return s.teacher_id === me.id; };
  const canView = (me, s) => !!s && (teachesSession(me, s) || isAdminOf(me, s.institution_id));
  const personName = (me, id) => { const p = prof(id); if (!p) return ''; if (p.role === 'superadmin' && !isSA(me)) return 'TeroClass team'; return p.name || ''; };
  const students = s => {
    const ids = new Set();
    if (s.group_id) db.group_members.filter(m => m.group_id === s.group_id).forEach(m => ids.add(m.enrollment_id));
    db.session_invitees.filter(i => i.session_id === s.id).forEach(i => ids.add(i.enrollment_id));
    return [...ids].map(enr).filter(Boolean);
  };
  const localDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const title = s => s.title || group(s.group_id)?.name || '';
  const teacherOf = s => (s.group_id ? group(s.group_id)?.teacher_id : null) || s.teacher_id;
  const dur = s => Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000);
  const nameOf = e => (e.name || '').trim() || e.email.split('@')[0];
  const calls = { generate: [] };

  function summaries(eids, limit = 200, me = null) {
    return db.student_insights.filter(si => eids.includes(si.enrollment_id)).map(si => ({ si, s: sess(si.session_id) })).filter(x => x.s)
      .sort((a, b) => Date.parse(b.s.starts_at) - Date.parse(a.s.starts_at)).slice(0, limit)
      .map(({ si, s }) => ({ id: si.id, session_id: s.id, title: title(s), starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, group_name: group(s.group_id)?.name || null,
        teacher_name: personName(me, teacherOf(s)), summary: String(si.data?.recap?.summary || '').slice(0, 280), kind: si.data?.kind || '', has_message: !!si.published_at, is_demo: !!si.is_demo }));
  }

  function handle(fn, body, me) {
    const b = body || {};
    switch (fn) {
      case 'generate_demo_insights': {
        const s = sess(b.p_session); if (!s || !canView(me, s)) return err('No autorizado');
        if (s.status === 'cancelled') return err('Una clase cancelada no tiene insights');
        if (localDate(Date.parse(s.starts_at), s.timezone) > localDate(Date.now(), s.timezone)) return err('Los insights de demo se generan para clases de hoy o anteriores');
        const p = b.p_payload;
        if (!p || typeof p !== 'object' || Array.isArray(p) || !['language', 'discipline'].includes(p.kind) || !/^[a-z]{2}$/.test(p.lang || '') || !p.teacher || !p.recap
          || !Array.isArray(p.students) || p.students.length < 1 || p.students.length > 24 || JSON.stringify(p).length > 262144) return err('Datos de demo inválidos');
        calls.generate.push({ session: s.id, by: me?.id, payload: p });
        const base = { kind: p.kind, lang: p.lang, subject: p.subject || '', title: p.title || '', recap: p.recap };
        const now = new Date().toISOString();
        let teacherCreated = false;
        if (!db.teacher_insights.some(t => t.session_id === s.id)) { db.teacher_insights.push({ id: uid(), session_id: s.id, data: { ...p.teacher, ...base }, is_demo: true, teacher_reflection: '', reflection_at: null, created_at: now }); teacherCreated = true; }
        let n = 0;
        students(s).sort((x, y) => nameOf(x).toLowerCase().localeCompare(nameOf(y).toLowerCase()) || x.id.localeCompare(y.id)).forEach((e, i) => {
          if (db.student_insights.some(si => si.session_id === s.id && si.enrollment_id === e.id)) return;
          db.student_insights.push({ id: uid(), session_id: s.id, enrollment_id: e.id, data: { ...p.students[i % p.students.length], ...base }, is_demo: true, teacher_message: '', published_message: '', published_at: null, created_at: now });
          n++;
        });
        return ok({ session_id: s.id, teacher_created: teacherCreated, students_created: n, students: db.student_insights.filter(si => si.session_id === s.id).length });
      }
      case 'list_insight_sessions': {
        if (!me) return err('No autorizado');
        const mine = b.p_mine !== false; let units = null;
        if (!mine) {
          if (!b.p_unit) { if (!isSA(me)) return err('No autorizado'); }
          else { if (!instById(b.p_unit) || !isAdminOf(me, b.p_unit)) return err('No autorizado'); units = [b.p_unit, ...descendantsOf(b.p_unit)]; }
        }
        const myRoot = rootOf(prof(me.id)?.institution_id);
        const q = String(b.p_q || '').trim().toLowerCase();
        const sc = db.class_sessions.filter(s => {
          const g = s.group_id ? group(s.group_id) : null;
          if (mine ? !((g && (g.teacher_id === me.id || g.substitute_id === me.id)) || (!g && s.teacher_id === me.id && myRoot === rootOf(s.institution_id))) : !(units === null || units.includes(s.institution_id))) return false;
          if (b.p_group && s.group_id !== b.p_group) return false;
          if (b.p_teacher && !(g ? [g.teacher_id, g.substitute_id].includes(b.p_teacher) : s.teacher_id === b.p_teacher)) return false;
          const d = localDate(Date.parse(s.starts_at), s.timezone);
          if (b.p_from && d < b.p_from) return false;
          if (b.p_to && d > b.p_to) return false;
          return true;
        });
        const role = s => { if (!mine) return 'admin'; const g = group(s.group_id); return g && g.substitute_id === me.id ? 'substitute' : 'teacher'; };
        const row = s => ({ id: s.id, title: title(s), starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: group(s.group_id)?.name || null,
          unit_name: instById(s.institution_id)?.name, teacher_name: personName(me, teacherOf(s)), role: role(s) });
        const withIns = sc.filter(s => db.teacher_insights.some(t => t.session_id === s.id) || db.student_insights.some(si => si.session_id === s.id))
          .filter(s => !q || db.student_insights.some(si => si.session_id === s.id && (() => { const e = enr(si.enrollment_id); return e && (e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q)); })()))
          .sort((x, y) => Date.parse(y.starts_at) - Date.parse(x.starts_at)).slice(0, 300)
          .map(s => { const t = db.teacher_insights.find(x => x.session_id === s.id); const rows = db.student_insights.filter(si => si.session_id === s.id);
            return { ...row(s), has_report: !!t, has_reflection: !!(t && t.teacher_reflection), students: rows.length, published: rows.filter(r => r.published_at).length, is_demo: !!(t?.is_demo || rows.some(r => r.is_demo)) }; });
        const pending = q ? [] : sc.filter(s => s.status === 'scheduled' && Date.parse(s.starts_at) > Date.now() - 30 * 864e5 && localDate(Date.parse(s.starts_at), s.timezone) <= localDate(Date.now(), s.timezone) && !db.teacher_insights.some(t => t.session_id === s.id))
          .sort((x, y) => Date.parse(y.starts_at) - Date.parse(x.starts_at)).slice(0, 8).map(s => ({ ...row(s), students: students(s).length }));
        const grp = db.class_groups.filter(g => mine ? (g.teacher_id === me.id || g.substitute_id === me.id) : (units === null || units.includes(g.institution_id)));
        const tids = [...new Set(grp.flatMap(g => [g.teacher_id, g.substitute_id]).filter(Boolean))].filter(id => !(prof(id)?.role === 'superadmin' && !isSA(me)));
        return ok({ scope: mine ? 'mine' : 'unit', unit: !mine && b.p_unit ? { id: b.p_unit, name: instById(b.p_unit)?.name } : null, sessions: withIns, pending,
          groups: grp.map(g => ({ id: g.id, name: g.name, unit_name: instById(g.institution_id)?.name })).sort((x, y) => x.name.localeCompare(y.name)),
          teachers: mine ? [] : tids.map(id => ({ id, name: personName(me, id) })).sort((x, y) => x.name.localeCompare(y.name)) });
      }
      case 'get_session_insights': {
        const s = sess(b.p_session); if (!s || !canView(me, s)) return err('No autorizado');
        const g = group(s.group_id); const teach = teachesSession(me, s); const t = db.teacher_insights.find(x => x.session_id === s.id);
        return ok({
          session: { id: s.id, title: title(s), starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: g?.name || null,
            unit_name: instById(s.institution_id)?.name, teacher_name: personName(me, teacherOf(s)), duration_min: dur(s), students_total: students(s).length },
          can_edit: teach, role: !teach ? 'admin' : g && g.substitute_id === me.id ? 'substitute' : 'teacher',
          teacher: t ? { id: t.id, data: t.data, is_demo: t.is_demo, reflection: t.teacher_reflection, reflection_at: t.reflection_at, created_at: t.created_at } : null,
          students: db.student_insights.filter(si => si.session_id === s.id).map(si => ({ si, e: enr(si.enrollment_id) })).filter(x => x.e)
            .sort((x, y) => nameOf(x.e).toLowerCase().localeCompare(nameOf(y.e).toLowerCase()))
            .map(({ si, e }) => ({ id: si.id, enrollment_id: e.id, name: nameOf(e), data: si.data, is_demo: si.is_demo, teacher_message: si.teacher_message, published_message: si.published_message, published_at: si.published_at })),
        });
      }
      case 'save_teacher_reflection': {
        const s = sess(b.p_session); if (!s || !teachesSession(me, s)) return err('No autorizado');
        const t = db.teacher_insights.find(x => x.session_id === s.id); if (!t) return err('Todavía no hay insights para esta clase');
        t.teacher_reflection = String(b.p_reflection || '').trim().slice(0, 8000); t.reflection_at = new Date().toISOString();
        return ok({ reflection: t.teacher_reflection, reflection_at: t.reflection_at });
      }
      case 'save_insight_message': {
        const si = db.student_insights.find(x => x.id === b.p_insight); const s = si && sess(si.session_id);
        if (!si || !teachesSession(me, s)) return err('No autorizado');
        const msg = String(b.p_message || '').trim().slice(0, 4000);
        if (b.p_publish && !msg) return err('Escribí un mensaje antes de publicarlo');
        si.teacher_message = msg; if (b.p_publish) { si.published_message = msg; si.published_at = new Date().toISOString(); }
        return ok({ teacher_message: si.teacher_message, published_message: si.published_message, published_at: si.published_at });
      }
      case 'my_insights': {
        let eids = [];
        if (!b.p_group && !b.p_enrollment) { if (!me) return err('No autorizado'); eids = db.student_enrollments.filter(e => e.user_id === me.id).map(e => e.id); }
        else { if (!isSA(me)) return err('No autorizado'); if (b.p_enrollment) { if (!enr(b.p_enrollment)) return err('No autorizado'); eids = [b.p_enrollment]; } }
        return ok(summaries(eids, 200, me));
      }
      case 'my_insight': {
        const si = db.student_insights.find(x => x.id === b.p_id); const e = si && enr(si.enrollment_id);
        if (!si || !e) return err('No autorizado');
        if (!b.p_enrollment) { if (!me || e.user_id !== me.id) return err('No autorizado'); }
        else if (!isSA(me) || si.enrollment_id !== b.p_enrollment) return err('No autorizado');
        const s = sess(si.session_id); const g = group(s.group_id);
        return ok({ id: si.id, session_id: s.id, session: { title: title(s), starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, group_name: g?.name || null, teacher_name: personName(me, teacherOf(s)), duration_min: dur(s) },
          student_name: e.name, data: si.data, is_demo: si.is_demo, message: si.published_at ? si.published_message : '', published_at: si.published_at });
      }
      default: return undefined;
    }
  }
  return { handle, summaries, calls };
};
