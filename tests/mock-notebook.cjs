// Group notebook + group board pages for the simulated Supabase (tests only). Same rules as the SQL functions in
// supabase/migrations/001_base.sql ("CUADERNO DEL GRUPO"), simplified. Plugged into tests/mock-supabase.cjs:
// handle(fn, body, me) returns {status, data} or undefined; canRealtime(me, topic, send) / publicTopicOk(topic) for mock-realtime.cjs.
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });
const PALETTE = ['#7c5cbf', '#0891b2', '#d97706', '#059669', '#db2777', '#4f46e5', '#b45309', '#0f766e', '#9333ea', '#dc2626'];
const MAX = 8388608;

module.exports = function install(ctx) {
  const { db, uid, chainOf, classDoc } = ctx;
  let seq = 0;
  const prof = id => db.profiles.find(p => p.id === id);
  const isAdminOf = (me, inst) => { const p = prof(me?.id); if (!p) return false; if (p.role === 'superadmin') return true; return !!inst && p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id); };
  const group = id => db.class_groups.find(g => g.id === id);
  const sess = id => db.class_sessions.find(s => s.id === id);
  const nbOf = id => db.group_notebooks.find(n => n.id === id);
  const member = (me, g) => !!me && db.group_members.some(m => m.group_id === g.id && db.student_enrollments.some(e => e.id === m.enrollment_id && e.user_id === me.id));
  const groupRole = (me, gid) => { const g = group(gid); if (!g || !me) return null; if (g.teacher_id === me.id || g.substitute_id === me.id) return 'teacher'; if (member(me, g)) return 'student'; if (isAdminOf(me, g.institution_id)) return 'admin'; return null; };
  const role = (me, nbid) => { const n = nbOf(nbid); return n ? groupRole(me, n.group_id) : null; };
  const startMonth = inst => { for (const i of chainOf(inst).reverse()) if (i.school_year_start_month) return i.school_year_start_month; return 1; };
  const local = (ms, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { y: +p.year, m: +p.month, d: `${p.year}-${p.month}-${p.day}` }; };
  const schoolYear = (g, ms) => { const l = local(ms, g.timezone); const m = startMonth(g.institution_id); return l.m >= m ? l.y : l.y - 1; };
  const label = (y, m) => (m <= 3 ? String(y) : `${y}–${String((y + 1) % 100).padStart(2, '0')}`);
  const yearSessions = (g, y) => db.class_sessions.filter(s => s.group_id === g.id && s.status === 'scheduled' && schoolYear(g, Date.parse(s.starts_at)) === y).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const today = g => local(Date.now(), g.timezone).d;
  const name = (me, g, r) => (r === 'student' ? (db.student_enrollments.find(e => e.user_id === me.id && db.group_members.some(m => m.group_id === g.id && m.enrollment_id === e.id))?.name || '').trim() : '') || prof(me.id)?.name || 'Participante';
  const color = (id, u) => PALETTE[[...String(id) + String(u)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
  const b64ok = v => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(v);
  const len = b => Math.floor(String(b).length * 3 / 4);
  const ensureNb = (g, y) => { let n = db.group_notebooks.find(x => x.group_id === g.id && x.school_year === y); if (!n) { n = { id: uid(), group_id: g.id, school_year: y, generation: 1, locked: false, lock_past: false, channel_key: [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''), bytes: 0, updated_at: new Date().toISOString() }; db.group_notebooks.push(n); } return n; };
  const ensureSec = (n, s) => { let x = db.group_notebook_sections.find(q => q.notebook_id === n.id && q.session_id === s.id); if (!x) { x = { id: uid(), notebook_id: n.id, session_id: s.id, day: null, title: s.title || '', sort_at: s.starts_at, state: null, state_upto: 0, bytes: 0, created_at: new Date().toISOString() }; db.group_notebook_sections.push(x); } return x; };
  const secsOf = nid => db.group_notebook_sections.filter(x => x.notebook_id === nid);
  function sectionsJson(n, withState) {
    const g = group(n.group_id); const ys = yearSessions(g, n.school_year); const t = today(g);
    return secsOf(n.id).map(x => {
      const s = x.session_id ? sess(x.session_id) : null; const at = s ? s.starts_at : x.sort_at; const day = s ? local(Date.parse(s.starts_at), g.timezone).d : (x.day || local(Date.parse(x.sort_at), g.timezone).d);
      const d = s && db.class_docs.find(q => q.session_id === s.id);
      return { id: x.id, session_id: x.session_id, kind: x.session_id ? 'session' : 'free', number: s ? (ys.findIndex(q => q.id === s.id) + 1 || null) : null, title: (s && s.title) || x.title || '',
        starts_at: at, ends_at: s ? s.ends_at : null, timezone: s ? s.timezone : g.timezone, status: s ? s.status : null, day, past: day < t,
        legacy_doc: !!(d && (d.state || db.class_doc_updates.some(u => u.session_id === s.id))), bytes: x.bytes, state: withState ? x.state : null, upto: x.state_upto, _at: Date.parse(at), _c: x.created_at };
    }).sort((a, b) => a._at - b._at || String(a._c).localeCompare(String(b._c))).map(({ _at, _c, ...r }) => r);
  }
  const upd = (n, filter) => db.group_notebook_updates.filter(u => u.notebook_id === n.id && u.generation === n.generation && filter(u)).sort((a, b) => a.id - b.id).map(u => ({ id: u.id, s: u.section_id, d: u.d, c: u.c }));
  const past = x => { const n = nbOf(x.notebook_id); const g = group(n.group_id); const s = x.session_id ? sess(x.session_id) : null; const day = s ? local(Date.parse(s.starts_at), g.timezone).d : (x.day || local(Date.parse(x.sort_at), g.timezone).d); return day < today(g); };
  function addVersion(n, label, me) {
    const parts = secsOf(n.id).map(x => ({ s: x.id, parts: [...(x.state ? [x.state] : []), ...db.group_notebook_updates.filter(u => u.section_id === x.id && u.generation === n.generation && u.id > x.state_upto).sort((a, b) => a.id - b.id).map(u => u.d)] })).filter(p => p.parts.length);
    if (!parts.length) return null;
    const v = { id: uid(), notebook_id: n.id, label, sections: parts, created_by: ['manual', 'before_restore'].includes(label) ? me?.id : null, created_at: new Date().toISOString() };
    db.group_notebook_versions.push(v);
    db.group_notebook_versions.filter(x => x.notebook_id === n.id).sort((a, b) => (b.created_at > a.created_at ? 1 : -1)).slice(20).forEach(x => { db.group_notebook_versions = db.group_notebook_versions.filter(y => y !== x); });
    return v.id;
  }
  function resolve(me, b, create) {
    let gid = b.p_group || null; let s = null;
    if (b.p_session) {
      s = sess(b.p_session); if (!s) return err('No autorizado');
      if (!s.group_id) { if (!classDoc.role(me, s)) return err('No autorizado'); return ok({ notebook_id: null, adhoc: true, session_id: s.id }); }
      if (gid && gid !== s.group_id) return err('No autorizado'); gid = s.group_id;
    }
    const r = groupRole(me, gid); if (!r) return err('No autorizado');
    const g = group(gid); const y = b.p_year || schoolYear(g, s ? Date.parse(s.starts_at) : Date.now());
    let n = db.group_notebooks.find(x => x.group_id === gid && x.school_year === y) || null; let sec = null;
    if (create && ['teacher', 'student'].includes(r)) {
      n = ensureNb(g, y);
      yearSessions(g, y).filter(x => Date.parse(x.starts_at) <= Date.now()).forEach(x => ensureSec(n, x));
      if (s && s.status === 'scheduled' && schoolYear(g, Date.parse(s.starts_at)) === y) sec = ensureSec(n, s).id;
    } else if (n && s) sec = db.group_notebook_sections.find(x => x.notebook_id === n.id && x.session_id === s.id)?.id || null;
    return ok({ notebook_id: n ? n.id : null, group_id: gid, year: y, section_id: sec, role: r, adhoc: false, session_id: b.p_session || null });
  }
  function handle(fn, b, me) {
    switch (fn) {
      case 'notebook_resolve': return resolve(me, b, true);
      case 'notebook_find': return resolve(me, b, false);
      case 'notebook_open': {
        const r = role(me, b.p_notebook); if (!r) return err('No autorizado');
        const n = nbOf(b.p_notebook); const g = group(n.group_id); const m = startMonth(g.institution_id);
        const secs = sectionsJson(n, true);
        return ok({ notebook: { id: n.id, group_id: g.id, group_name: g.name, timezone: g.timezone, year: n.school_year, year_label: label(n.school_year, m), start_month: m, teacher_name: prof(g.teacher_id)?.name || '',
            years: db.group_notebooks.filter(x => x.group_id === g.id).map(x => x.school_year).sort((a, c) => c - a) },
          role: r, can_edit: r === 'teacher' || (r === 'student' && !n.locked), can_lock: r === 'teacher', locked: n.locked, lock_past: n.lock_past, generation: n.generation, today: today(g),
          sections: secs, updates: upd(n, u => u.id > (db.group_notebook_sections.find(x => x.id === u.section_id)?.state_upto || 0)),
          channel: { topic: 'notebook:' + n.id, key: n.channel_key }, me: ['teacher', 'student'].includes(r) ? { name: name(me, g, r), color: color(n.id, me.id) } : null,
          versions: db.group_notebook_versions.filter(v => v.notebook_id === n.id).length, notes: r === 'teacher' ? db.group_notebook_notes.filter(x => x.notebook_id === n.id).length : null,
          bytes: n.bytes, max_bytes: MAX, updated_at: n.updated_at });
      }
      case 'notebook_push': {
        const r = role(me, b.p_notebook); if (!r) return err('No autorizado');
        if (!['teacher', 'student'].includes(r)) return err('Solo lectura: no podés editar este cuaderno');
        if (!b64ok(b.p_update)) return err('Cambio inválido');
        const n = nbOf(b.p_notebook); const x = db.group_notebook_sections.find(q => q.id === b.p_section && q.notebook_id === n.id); if (!x) return err('Sección inválida');
        if (r === 'student' && n.locked) return err('El docente bloqueó el cuaderno');
        if (r === 'student' && n.lock_past && past(x)) return err('El docente bloqueó las clases anteriores del cuaderno');
        if (b.p_generation !== n.generation) return err('Cuaderno desactualizado: volvé a abrirlo');
        const l = len(b.p_update);
        if (n.bytes + l > MAX && (l > 4096 || n.bytes + l > 9437184)) return err('El cuaderno llegó a su tamaño máximo (8 MB): borrá contenido que ya no uses para seguir escribiendo');
        const last = db.group_notebook_versions.filter(v => v.notebook_id === n.id).map(v => Date.parse(v.created_at)).sort().pop();
        if (!last || last < Date.now() - 600000) addVersion(n, 'auto', me);
        const u = { id: ++seq, notebook_id: n.id, section_id: x.id, generation: n.generation, d: b.p_update, c: String(b.p_client || '').slice(0, 40), user_id: me.id };
        db.group_notebook_updates.push(u); x.bytes += l; n.bytes += l; n.updated_at = new Date().toISOString();
        return ok({ id: u.id, generation: n.generation });
      }
      case 'notebook_pull': {
        const r = role(me, b.p_notebook); if (!r) return err('No autorizado');
        const n = nbOf(b.p_notebook); const g = group(n.group_id); const client = String(b.p_client || '').slice(0, 40);
        if (b.p_presence && ['teacher', 'student'].includes(r) && client) {
          let p = db.group_notebook_presence.find(x => x.notebook_id === n.id && x.client_id === client);
          if (!p) { p = { notebook_id: n.id, client_id: client, user_id: me.id }; db.group_notebook_presence.push(p); }
          if (p.user_id === me.id) Object.assign(p, { name: name(me, g, r), color: color(n.id, me.id), role: r, state: typeof b.p_presence === 'object' ? b.p_presence : {}, seen_at: Date.now() });
        }
        const reset = b.p_generation !== n.generation; const after = b.p_after || 0; const count = secsOf(n.id).length;
        return ok({ generation: n.generation, locked: n.locked, lock_past: n.lock_past, can_edit: r === 'teacher' || (r === 'student' && !n.locked), today: today(g), bytes: n.bytes, reset, count,
          sections: reset || b.p_known !== count ? sectionsJson(n, false) : null,
          states: secsOf(n.id).filter(x => x.state && (reset || x.state_upto > after)).map(x => ({ s: x.id, d: x.state, upto: x.state_upto })),
          updates: upd(n, u => { const x = db.group_notebook_sections.find(q => q.id === u.section_id); return u.id > (reset ? x.state_upto : Math.max(after, x.state_upto)); }).slice(0, 2000),
          presence: db.group_notebook_presence.filter(x => x.notebook_id === n.id && x.client_id !== client && Date.now() - x.seen_at < 45000).map(x => ({ client: x.client_id, name: x.name, color: x.color, role: x.role, state: x.state })) });
      }
      case 'notebook_snapshot': {
        const r = role(me, b.p_notebook); if (!r) return err('No autorizado');
        if (!['teacher', 'student'].includes(r)) return err('Solo lectura: no podés editar este cuaderno');
        if (!b64ok(b.p_state)) return err('Cambio inválido');
        const n = nbOf(b.p_notebook); const x = db.group_notebook_sections.find(q => q.id === b.p_section && q.notebook_id === n.id); if (!x) return err('Sección inválida');
        if (r === 'student' && n.locked) return err('El docente bloqueó el cuaderno');
        if (r === 'student' && n.lock_past && past(x)) return err('El docente bloqueó las clases anteriores del cuaderno');
        if (b.p_generation !== n.generation) return err('Cuaderno desactualizado: volvé a abrirlo');
        if ((b.p_upto ?? -1) < x.state_upto) return ok({ ok: false, upto: x.state_upto });
        const mx = Math.max(0, ...db.group_notebook_updates.filter(u => u.notebook_id === n.id).map(u => u.id), ...secsOf(n.id).map(q => q.state_upto));
        if (b.p_upto > mx) return err('Cambio inválido');
        const nb = len(b.p_state) + db.group_notebook_updates.filter(u => u.section_id === x.id && u.id > b.p_upto).reduce((a, u) => a + len(u.d), 0);
        const total = n.bytes - x.bytes + nb;
        if (total > MAX && total > n.bytes) return err('El cuaderno llegó a su tamaño máximo (8 MB): borrá contenido que ya no uses para seguir escribiendo');
        x.state = b.p_state; x.state_upto = b.p_upto; x.bytes = nb;
        db.group_notebook_updates = db.group_notebook_updates.filter(u => !(u.section_id === x.id && u.id <= b.p_upto));
        n.bytes = secsOf(n.id).reduce((a, q) => a + q.bytes, 0);
        return ok({ ok: true, upto: b.p_upto });
      }
      case 'notebook_set_lock': {
        if (role(me, b.p_notebook) !== 'teacher') return err('No autorizado');
        const n = nbOf(b.p_notebook); if (b.p_locked != null) n.locked = !!b.p_locked; if (b.p_lock_past != null) n.lock_past = !!b.p_lock_past;
        return ok({ locked: n.locked, lock_past: n.lock_past });
      }
      case 'notebook_add_section': {
        if (role(me, b.p_notebook) !== 'teacher') return err('No autorizado');
        const n = nbOf(b.p_notebook); const g = group(n.group_id); const before = secsOf(n.id).length; let sec;
        if (b.p_session) { const s = sess(b.p_session); if (!s || s.group_id !== g.id || s.status !== 'scheduled' || schoolYear(g, Date.parse(s.starts_at)) !== n.school_year) return err('Esa clase no es de este cuaderno'); sec = ensureSec(n, s).id; }
        else if (b.p_today) {
          const t = today(g); const s = db.class_sessions.filter(q => q.group_id === g.id && q.status === 'scheduled' && local(Date.parse(q.starts_at), g.timezone).d === t).sort((a, c) => Date.parse(a.starts_at) - Date.parse(c.starts_at))[0];
          if (s) sec = ensureSec(n, s).id;
          else { let x = db.group_notebook_sections.find(q => q.notebook_id === n.id && q.day === t); if (!x) { x = { id: uid(), notebook_id: n.id, session_id: null, day: t, title: String(b.p_title || '').trim(), sort_at: new Date().toISOString(), state: null, state_upto: 0, bytes: 0, created_at: new Date().toISOString() }; db.group_notebook_sections.push(x); } sec = x.id; }
        } else {
          const t = String(b.p_title || '').trim(); if (!t) return err('Escribí un título para la sección');
          const x = { id: uid(), notebook_id: n.id, session_id: null, day: null, title: t.slice(0, 200), sort_at: new Date().toISOString(), state: null, state_upto: 0, bytes: 0, created_at: new Date().toISOString() };
          db.group_notebook_sections.push(x); sec = x.id;
        }
        return ok({ section_id: sec, created: secsOf(n.id).length > before });
      }
      case 'notebook_versions': {
        if (!role(me, b.p_notebook)) return err('No autorizado');
        return ok(db.group_notebook_versions.filter(v => v.notebook_id === b.p_notebook).sort((a, c) => (c.created_at > a.created_at ? 1 : -1)).map(v => ({ id: v.id, label: v.label, created_at: v.created_at, bytes: 0, sections: v.sections.length, by: v.created_by ? prof(v.created_by)?.name || null : null })));
      }
      case 'notebook_version': {
        const v = db.group_notebook_versions.find(x => x.id === b.p_version); if (!v || !role(me, v.notebook_id)) return err('No autorizado');
        return ok({ id: v.id, notebook_id: v.notebook_id, label: v.label, created_at: v.created_at, sections: v.sections });
      }
      case 'notebook_add_version': {
        if (role(me, b.p_notebook) !== 'teacher') return err('No autorizado');
        if (!['manual', 'class_end'].includes(b.p_label)) return err('Versión inválida');
        const id = addVersion(nbOf(b.p_notebook), b.p_label, me); return ok({ id, created: !!id });
      }
      case 'notebook_restore': {
        const v = db.group_notebook_versions.find(x => x.id === b.p_version); if (!v || role(me, v.notebook_id) !== 'teacher') return err('No autorizado');
        const n = nbOf(v.notebook_id); addVersion(n, 'before_restore', me);
        db.group_notebook_updates = db.group_notebook_updates.filter(u => u.notebook_id !== n.id);
        secsOf(n.id).forEach(x => { x.state = null; x.state_upto = 0; x.bytes = 0; });
        n.generation++;
        v.sections.forEach(p => p.parts.forEach(d => { db.group_notebook_updates.push({ id: ++seq, notebook_id: n.id, section_id: p.s, generation: n.generation, d, c: 'restore', user_id: me.id }); const x = db.group_notebook_sections.find(q => q.id === p.s); if (x) x.bytes += len(d); }));
        n.bytes = secsOf(n.id).reduce((a, q) => a + q.bytes, 0);
        return ok({ generation: n.generation, restored: v.id });
      }
      case 'notebook_add_note': {
        if (role(me, b.p_notebook) !== 'teacher') return err('No autorizado');
        if (!String(b.p_body || '').trim()) return err('Nota inválida');
        const x = { id: uid(), notebook_id: b.p_notebook, section_id: b.p_section || null, kind: b.p_kind || 'teacher_guide', title: String(b.p_title || '').slice(0, 200), body: String(b.p_body), created_by: me.id, created_at: new Date().toISOString() };
        db.group_notebook_notes.push(x); return ok({ id: x.id });
      }
      case 'notebook_notes': {
        if (role(me, b.p_notebook) !== 'teacher') return err('No autorizado');
        return ok(db.group_notebook_notes.filter(x => x.notebook_id === b.p_notebook).map(x => ({ id: x.id, section_id: x.section_id, kind: x.kind, title: x.title, body: x.body, created_at: x.created_at, by: prof(x.created_by)?.name || '' })));
      }
      case 'notebook_delete_note': {
        const x = db.group_notebook_notes.find(q => q.id === b.p_note); if (!x || role(me, x.notebook_id) !== 'teacher') return err('No autorizado');
        db.group_notebook_notes = db.group_notebook_notes.filter(q => q !== x); return ok({ deleted: true });
      }
      case 'notebook_targets': {
        if (!me) return err('No autorizado');
        return ok(db.class_groups.filter(g => g.teacher_id === me.id || g.substitute_id === me.id).sort((a, c) => a.name.localeCompare(c.name)).map(g => {
          const y = schoolYear(g, Date.now()); const all = yearSessions(g, y); const t = today(g);
          return { id: g.id, name: g.name, timezone: g.timezone, year: y,
            today_session: all.find(s => local(Date.parse(s.starts_at), g.timezone).d === t)?.id || null,
            next_session: all.find(s => Date.parse(s.ends_at) > Date.now())?.id || null,
            sessions: all.map((s, i) => ({ id: s.id, n: i + 1, title: s.title || g.name, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone })).filter(s => Date.parse(s.starts_at) > Date.now() - 60 * 864e5 && Date.parse(s.starts_at) < Date.now() + 120 * 864e5) };
        }));
      }
      case 'groupboard_pages': {
        let gid = b.p_group || null; let s = null;
        if (b.p_session) { s = sess(b.p_session); if (!s) return err('No autorizado'); if (!s.group_id) { if (!classDoc.role(me, s)) return err('No autorizado'); return ok(null); } gid = s.group_id; }
        const r = groupRole(me, gid); if (!r) return err('No autorizado');
        const g = group(gid); const y = b.p_year || schoolYear(g, s ? Date.parse(s.starts_at) : Date.now()); const t = today(g); const all = yearSessions(g, y);
        return ok({ group_id: g.id, group_name: g.name, timezone: g.timezone, year: y, year_label: label(y, startMonth(g.institution_id)), role: r, today: t,
          today_session: all.find(x => local(Date.parse(x.starts_at), g.timezone).d === t)?.id || null,
          pages: all.map((x, i) => { const bd = db.class_boards.find(q => q.session_id === x.id); return { session_id: x.id, n: i + 1, title: x.title || g.name, starts_at: x.starts_at, ends_at: x.ends_at, timezone: x.timezone,
            day: local(Date.parse(x.starts_at), g.timezone).d, today: local(Date.parse(x.starts_at), g.timezone).d === t, has_board: !!(bd && (bd.rev || 0) > 0), locked: !!bd?.locked }; }) });
      }
      case 'school_year_start': case 'set_school_year_start': {
        const i = db.institutions.find(x => x.id === b.p_unit); if (!i || !isAdminOf(me, i.id)) return err('No autorizado');
        if (fn === 'set_school_year_start') { if (b.p_month != null && !(b.p_month >= 1 && b.p_month <= 12)) return err('Mes inválido (de 1 a 12)'); i.school_year_start_month = b.p_month ?? null; }
        return ok({ own: i.school_year_start_month ?? null, effective: startMonth(i.id), inherited: i.parent_id ? startMonth(i.parent_id) : null });
      }
      default: return undefined;
    }
  }
  function canRealtime(me, topic, send) {
    const m = /^notebook:([0-9a-f-]{36})$/.exec(String(topic || '')); if (!m) return false;
    const r = role(me, m[1]); if (!send) return !!r;
    return r === 'teacher' || (r === 'student' && !nbOf(m[1])?.locked);
  }
  const publicTopicOk = topic => { const m = /^notebook-([0-9a-f]{64})$/.exec(String(topic || '')); return !!m && db.group_notebooks.some(n => n.channel_key === m[1]); };
  return { handle, canRealtime, publicTopicOk, schoolYear };
};
