// Recording consent for the simulated Supabase (tests only). Same rules as the SQL functions in
// supabase/migrations/001_base.sql ("CONSENTIMIENTO DE GRABACIÓN"), simplified: my_consent, grant_recording_consent,
// revoke_recording_consent, decline_recording_consent, consent_overview, consent_new_declines, platform_consent_counts.
// Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns {status, data} or undefined.
const VERSION = '2026-10';
const EMAIL_RE = /^[^@\s<>"',;()]+@[^@\s<>"',;()]+\.[A-Za-z]{2,24}$/;
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });

module.exports = function install(ctx) {
  const { db, uid, chainOf, descendantsOf, instById } = ctx;
  const calls = { grant: [], revoke: [], decline: [] };
  const now = () => new Date().toISOString();
  const prof = id => db.profiles.find(p => p.id === id);
  const isSA = me => prof(me?.id)?.role === 'superadmin';
  const isAdminOf = (me, inst) => { const p = prof(me?.id); if (!p) return false; if (p.role === 'superadmin') return true; return !!inst && p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id); };
  const scope = unit => [unit, ...descendantsOf(unit)];
  const active = userId => db.user_consents.find(c => c.user_id === userId && !c.revoked_at);
  const lastUserRevoke = userId => db.user_consents.filter(c => c.user_id === userId && c.revoked_reason === 'user').map(c => c.revoked_at).sort().pop() || null;
  function myConsent(userId) {
    const c = active(userId); const rev = lastUserRevoke(userId);
    return { current_version: VERSION, status: !c ? (rev ? 'revoked' : 'none') : c.version !== VERSION ? 'outdated' : 'granted',
      granted: !!c && c.version === VERSION, recorded: !!c && c.version === VERSION && (!c.is_minor || c.guardian_consent),
      version: c ? c.version : null, granted_at: c ? c.granted_at : null, revoked_at: c ? null : rev, minor: !!c?.is_minor, guardian_consent: c?.is_minor ? c.guardian_consent : null };
  }
  const sess = id => db.class_sessions.find(s => s.id === id);
  const group = id => db.class_groups.find(g => g.id === id);
  const teaches = (me, s) => { if (s.group_id) { const g = group(s.group_id); return !!g && (g.teacher_id === me.id || g.substitute_id === me.id); } return s.teacher_id === me.id; };
  const enrollmentsFor = (userId, s) => db.student_enrollments.filter(e => e.user_id === userId && (!s
    || (s.group_id && db.group_members.some(m => m.group_id === s.group_id && m.enrollment_id === e.id))
    || db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === e.id)));
  function personStatus(userId, units) {
    if (!userId) return { status: 'pending', at: null };
    const c = active(userId);
    if (c && c.version === VERSION) return { status: 'granted', at: c.granted_at, c };
    const d = db.consent_declines.filter(x => x.user_id === userId && (!units || units.includes(x.institution_id))).map(x => x.created_at).sort().pop() || null;
    const r = lastUserRevoke(userId);
    if (d && (!r || d >= r)) return { status: 'declined', at: d };
    if (r) return { status: 'revoked', at: r };
    return { status: 'pending', at: null };
  }

  function handle(fn, body, me) {
    const b = body || {};
    if (fn === 'my_consent') { if (!me) return err('No autorizado'); return ok(myConsent(me.id)); }
    if (fn === 'grant_recording_consent') {
      if (!me) return err('No autorizado');
      if (b.p_version !== VERSION) return err('El texto del consentimiento cambió: recargá la página');
      const minor = !!b.p_minor; const name = String(b.p_guardian_name || '').trim(); const email = String(b.p_guardian_email || '').trim();
      if (minor && !name) return err('Menores de 18: falta el nombre del tutor/a');
      if (minor && !EMAIL_RE.test(email)) return err('Menores de 18: email del tutor/a inválido');
      if (minor && !b.p_guardian_consent) return err('Menores de 18: el tutor/a tiene que confirmar el consentimiento');
      db.user_consents.filter(c => c.user_id === me.id && !c.revoked_at).forEach(c => { c.revoked_at = now(); c.revoked_reason = 'superseded'; });
      db.user_consents.push({ id: uid(), user_id: me.id, version: VERSION, granted_at: now(), revoked_at: null, revoked_reason: null, is_minor: minor,
        guardian_name: minor ? name : null, guardian_email: minor ? email : null, guardian_consent: minor });
      calls.grant.push({ user: me.id, minor });
      return ok(myConsent(me.id));
    }
    if (fn === 'revoke_recording_consent') {
      if (!me) return err('No autorizado');
      db.user_consents.filter(c => c.user_id === me.id && !c.revoked_at).forEach(c => { c.revoked_at = now(); c.revoked_reason = 'user'; });
      calls.revoke.push(me.id);
      return ok(myConsent(me.id));
    }
    if (fn === 'decline_recording_consent') {
      if (!me) return err('No autorizado');
      const reason = String(b.p_reason || '').trim();
      if (reason.length < 10) return err('La justificación es obligatoria (mínimo 10 caracteres)');
      if (myConsent(me.id).granted) return err('Ya diste tu consentimiento');
      const s = b.p_session ? sess(b.p_session) : null;
      if (b.p_session && !s) return err('No autorizado');
      const p = prof(me.id);
      const role = s ? (teaches(me, s) ? 'teacher' : enrollmentsFor(me.id, s).length ? 'student' : null) : (['teacher', 'org_admin', 'superadmin'].includes(p?.role) ? 'teacher' : 'student');
      if (!role) return err('No autorizado');
      db.user_consents.filter(c => c.user_id === me.id && !c.revoked_at).forEach(c => { c.revoked_at = now(); c.revoked_reason = 'superseded'; });
      let insts = role === 'teacher' ? (p?.institution_id ? [p.institution_id] : []) : [...new Set(enrollmentsFor(me.id, s).map(e => e.institution_id))];
      if (!insts.length) insts = [null];
      const ids = insts.map(inst => { const id = uid(); db.consent_declines.push({ id, user_id: me.id, institution_id: inst, session_id: s ? s.id : null, role, version: VERSION, reason: reason.slice(0, 1000), created_at: now() }); return id; });
      calls.decline.push({ user: me.id, session: s ? s.id : null, reason });
      return ok({ ids, recorded: false, institutions: insts.filter(Boolean).length });
    }
    if (fn === 'consent_overview' || fn === 'consent_new_declines') {
      if (!b.p_unit || !instById(b.p_unit) || !isAdminOf(me, b.p_unit)) return err('No autorizado');
      const units = scope(b.p_unit);
      const decl = db.consent_declines.filter(d => units.includes(d.institution_id));
      if (fn === 'consent_new_declines') return ok(decl.filter(d => !b.p_since || d.created_at > b.p_since).length);
      const staff = db.profiles.filter(p => units.includes(p.institution_id) && ['teacher', 'org_admin'].includes(p.role))
        .map(p => ({ kind: 'teacher', name: p.name || p.email, email: p.email, unit_id: p.institution_id, user_id: p.id }));
      const studs = db.student_enrollments.filter(e => units.includes(e.institution_id))
        .map(e => ({ kind: 'student', name: e.name || e.email, email: e.email, unit_id: e.institution_id, user_id: e.user_id || null }));
      const people = [...staff, ...studs].map(x => { const st = personStatus(x.user_id, units); const minor = st.status === 'granted' && !!st.c?.is_minor;
        return { kind: x.kind, name: x.name, email: x.email, unit_id: x.unit_id, unit_name: instById(x.unit_id)?.name || '', linked: !!x.user_id, status: st.status, status_at: st.at,
          minor, guardian_consent: minor ? st.c.guardian_consent : null, declines: x.user_id ? decl.filter(d => d.user_id === x.user_id).length : 0 }; })
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const declines = decl.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(d => {
        const e = db.student_enrollments.find(x => x.user_id === d.user_id && x.institution_id === d.institution_id); const p = prof(d.user_id); const s = d.session_id ? sess(d.session_id) : null;
        return { id: d.id, role: d.role, reason: d.reason, created_at: d.created_at, unit_id: d.institution_id, unit_name: instById(d.institution_id)?.name || '',
          name: d.role === 'student' ? (e?.name || e?.email || '') : (p?.role === 'superadmin' && !isSA(me) ? 'TeroClass team' : p?.name || ''),
          email: d.role === 'student' ? e?.email || null : (p?.role === 'superadmin' && !isSA(me) ? null : p?.email || null),
          session_id: d.session_id, class_title: s ? (s.title || group(s.group_id)?.name || '') : null, class_starts_at: s ? s.starts_at : null };
      });
      return ok({ version: VERSION, people, declines });
    }
    if (fn === 'platform_consent_counts') {
      if (!isSA(me)) return err('No autorizado');
      const units = b.p_unit ? scope(b.p_unit) : null;
      const keys = new Map();
      db.profiles.filter(p => ['teacher', 'org_admin'].includes(p.role) && p.institution_id && (!units || units.includes(p.institution_id))).forEach(p => keys.set(p.id, p.id));
      db.student_enrollments.filter(e => !units || units.includes(e.institution_id)).forEach(e => keys.set(e.user_id || 'e:' + e.id, e.user_id || null));
      const st = [...keys.values()].map(u => personStatus(u, null).status).map(x => (x === 'revoked' ? 'pending' : x));
      return ok({ version: VERSION, people: st.length, granted: st.filter(x => x === 'granted').length, declined: st.filter(x => x === 'declined').length, pending: st.filter(x => x === 'pending').length });
    }
    return undefined;
  }
  return { handle, calls, VERSION };
};
