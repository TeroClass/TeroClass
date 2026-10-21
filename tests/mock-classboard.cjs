// Class whiteboard ("Pizarra") for the simulated Supabase (tests only). Same rules as the SQL functions in
// supabase/migrations/001_base.sql ("PIZARRA DE LA CLASE"), simplified: access = the class document's role, element validation
// (allowed types, images refused, id / version / versionNonce), last-writer-wins per element, rev deltas, lock, 2 MB cap,
// versions / restore, presence names from the "database". Plugged into tests/mock-supabase.cjs: handle(fn, body, me) returns
// {status, data} or undefined; studentBoards(eids) → student_view.boards; canRealtime / publicTopicOk for mock-realtime.cjs.
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });
const ALLOWED = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'frame']);
const CAP = 2097152;

module.exports = function install(ctx) {
  const { db, uid, classDoc } = ctx;
  const role = (me, s) => classDoc.role(me, s);
  const sess = id => db.class_sessions.find(s => s.id === id);
  const group = id => db.class_groups.find(g => g.id === id);
  const boardOf = sid => db.class_boards.find(b => b.session_id === sid);
  const ensure = sid => { let b = boardOf(sid); if (!b) { b = { session_id: sid, rev: 0, generation: 1, locked: false, bytes: 0, channel_key: [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''), updated_at: new Date().toISOString() }; db.class_boards.push(b); } return b; };
  const elsOf = sid => db.class_board_elements.filter(e => e.session_id === sid);
  const size = o => Buffer.byteLength(JSON.stringify(o));
  const PALETTE = ['#7c5cbf', '#0891b2', '#d97706', '#059669', '#db2777', '#4f46e5', '#b45309', '#0f766e', '#9333ea', '#dc2626'];
  const color = (sid, u) => PALETTE[[...String(sid) + String(u)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
  const name = (me, s, r) => {
    if (r === 'student') { const e = db.student_enrollments.find(x => x.user_id === me.id && ((s.group_id && db.group_members.some(m => m.group_id === s.group_id && m.enrollment_id === x.id)) || db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === x.id))); if (e && (e.name || '').trim()) return e.name.trim(); }
    return db.profiles.find(p => p.id === me.id)?.name || 'Participante';
  };
  function clean(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('Cambio inválido');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(e.id || ''))) throw new Error('Cambio inválido');
    if (!Number.isInteger(e.version) || e.version < 1 || !Number.isInteger(e.versionNonce)) throw new Error('Cambio inválido');
    if (['image', 'embeddable', 'iframe'].includes(e.type)) throw new Error('Las imágenes no están disponibles en la pizarra');
    if (!ALLOWED.has(e.type)) throw new Error('Elemento no permitido en la pizarra');
    if (size(e) > 262144) throw new Error('Cambio demasiado grande');
    const v = { ...e }; delete v.customData; delete v.fileId;
    if (typeof v.link === 'string' && !/^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(v.link)) v.link = null;
    if (v.isDeleted) { delete v.points; delete v.pressures; delete v.text; delete v.originalText; delete v.link; }
    return v;
  }
  function addVersion(sid, label, me) {
    const els = elsOf(sid).filter(e => !e.deleted).sort((a, b) => a.rev - b.rev).map(e => e.data);
    if (!els.length) return null;
    const v = { id: uid(), session_id: sid, elements: els, label, created_by: ['manual', 'before_restore'].includes(label) ? me?.id : null, created_at: new Date().toISOString() };
    db.class_board_versions.push(v);
    const mine = db.class_board_versions.filter(x => x.session_id === sid).sort((a, b) => (b.label === 'class_end') - (a.label === 'class_end') || (b.created_at > a.created_at ? 1 : -1));
    mine.slice(20).forEach(x => { db.class_board_versions = db.class_board_versions.filter(y => y !== x); });
    return v.id;
  }
  const personName = id => { const p = db.profiles.find(x => x.id === id); return p ? (p.role === 'superadmin' ? 'TeroClass team' : p.name || '') : ''; };

  function handle(fn, b, me) {
    switch (fn) {
      case 'classboard_open': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        const g = group(s.group_id); const bd = boardOf(s.id);
        return ok({ session: { id: s.id, title: s.title || g?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status, group_id: s.group_id, group_name: g?.name || null },
          role: r, can_edit: r === 'teacher' || (r === 'student' && !bd?.locked), can_lock: r === 'teacher', locked: !!bd?.locked, generation: bd?.generation || 1, rev: bd?.rev || 0,
          bytes: bd?.bytes || 0, max_bytes: CAP, elements: elsOf(s.id).sort((x, y) => x.rev - y.rev).map(e => e.data),
          channel: { topic: 'classboard:' + s.id, key: bd?.channel_key || null }, me: ['teacher', 'student'].includes(r) ? { name: name(me, s, r), color: color(s.id, me.id) } : null,
          versions: db.class_board_versions.filter(v => v.session_id === s.id).length, updated_at: bd?.updated_at || null });
      }
      case 'classboard_push': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        if (!['teacher', 'student'].includes(r)) return err('Solo lectura: no podés dibujar en esta pizarra');
        const list = b.p_elements;
        if (!Array.isArray(list) || !list.length) return err('Cambio inválido');
        if (list.length > 2000 || size(list) > 1048576) return err('Cambio demasiado grande');
        const bd = ensure(s.id);
        if (r === 'student' && bd.locked) return err('El docente bloqueó la pizarra');
        if (b.p_generation !== bd.generation) return err('Pizarra desactualizada: volvé a abrirla');
        let cleaned; try { cleaned = list.map(clean); } catch (e) { return err(e.message); }
        if (Date.now() > Date.parse(s.ends_at) && !db.class_board_versions.some(v => v.session_id === s.id && v.label === 'class_end')) addVersion(s.id, 'class_end', me);
        const last = db.class_board_versions.filter(v => v.session_id === s.id).map(v => Date.parse(v.created_at)).sort().pop();
        if (!last || last < Date.now() - 10 * 60000) addVersion(s.id, 'auto', me);
        const rev = bd.rev + 1; const snapshot = db.class_board_elements.slice(); let n = 0;
        cleaned.forEach(v => {
          const cur = db.class_board_elements.find(e => e.session_id === s.id && e.element_id === v.id);
          if (cur && !(v.version > cur.version || (v.version === cur.version && v.versionNonce < cur.nonce))) return;
          const row = { session_id: s.id, element_id: v.id, version: v.version, nonce: v.versionNonce, deleted: !!v.isDeleted, rev, data: v, bytes: size(v) };
          if (cur) Object.assign(cur, row); else db.class_board_elements.push(row); n++;
        });
        if (!n) return ok({ rev: bd.rev, applied: 0, generation: bd.generation });
        const total = elsOf(s.id).reduce((a, e) => a + e.bytes, 0);
        if (total > CAP && total > bd.bytes) { db.class_board_elements = snapshot; return err('La pizarra llegó a su tamaño máximo (2 MB): borrá dibujos que ya no uses para seguir dibujando'); }
        Object.assign(bd, { rev, bytes: total, updated_at: new Date().toISOString() });
        return ok({ rev, applied: n, generation: bd.generation });
      }
      case 'classboard_pull': {
        const s = sess(b.p_session); const r = role(me, s); if (!r) return err('No autorizado');
        const client = String(b.p_client || '').slice(0, 40);
        if (b.p_presence && ['teacher', 'student'].includes(r) && client) {
          let p = db.class_board_presence.find(x => x.session_id === s.id && x.client_id === client);
          if (!p) { p = { session_id: s.id, client_id: client, user_id: me.id }; db.class_board_presence.push(p); }
          if (p.user_id === me.id) Object.assign(p, { name: name(me, s, r), color: color(s.id, me.id), role: r, state: typeof b.p_presence === 'object' ? b.p_presence : {}, seen_at: Date.now() });
        }
        const bd = boardOf(s.id); const reset = !!bd && b.p_generation !== bd.generation;
        return ok({ generation: bd?.generation || 1, locked: !!bd?.locked, can_edit: r === 'teacher' || (r === 'student' && !bd?.locked), reset, rev: bd?.rev || 0, bytes: bd?.bytes || 0,
          elements: elsOf(s.id).filter(e => reset || e.rev > (b.p_since || 0)).sort((x, y) => x.rev - y.rev).map(e => e.data),
          presence: db.class_board_presence.filter(x => x.session_id === s.id && x.client_id !== client && Date.now() - x.seen_at < 45000).map(x => ({ client: x.client_id, name: x.name, color: x.color, role: x.role, state: x.state })) });
      }
      case 'classboard_set_lock': {
        const s = sess(b.p_session); if (role(me, s) !== 'teacher') return err('No autorizado');
        const bd = ensure(s.id); bd.locked = !!b.p_locked; return ok({ locked: bd.locked });
      }
      case 'classboard_versions': {
        const s = sess(b.p_session); if (!role(me, s)) return err('No autorizado');
        return ok(db.class_board_versions.filter(v => v.session_id === s.id).sort((a, c) => (c.created_at > a.created_at ? 1 : -1))
          .map(v => ({ id: v.id, label: v.label, created_at: v.created_at, bytes: 0, count: v.elements.length, by: v.created_by ? personName(v.created_by) : null })));
      }
      case 'classboard_version': {
        const v = db.class_board_versions.find(x => x.id === b.p_version); if (!v || !role(me, sess(v.session_id))) return err('No autorizado');
        return ok({ id: v.id, session_id: v.session_id, label: v.label, created_at: v.created_at, elements: v.elements });
      }
      case 'classboard_add_version': {
        const s = sess(b.p_session); if (role(me, s) !== 'teacher') return err('No autorizado');
        if (!['manual', 'class_end'].includes(b.p_label)) return err('Versión inválida');
        if (!boardOf(s.id)) return ok({ id: null, created: false });
        if (b.p_label === 'class_end' && db.class_board_versions.some(v => v.session_id === s.id && v.label === 'class_end')) return ok({ id: null, created: false });
        const id = addVersion(s.id, b.p_label, me); return ok({ id, created: !!id });
      }
      case 'classboard_restore': {
        const v = db.class_board_versions.find(x => x.id === b.p_version); if (!v || role(me, sess(v.session_id)) !== 'teacher') return err('No autorizado');
        const bd = ensure(v.session_id); addVersion(v.session_id, 'before_restore', me);
        db.class_board_elements = db.class_board_elements.filter(e => e.session_id !== v.session_id);
        const rev = bd.rev + 1;
        v.elements.forEach(x => db.class_board_elements.push({ session_id: v.session_id, element_id: x.id, version: x.version, nonce: x.versionNonce, deleted: false, rev, data: x, bytes: size(x) }));
        Object.assign(bd, { generation: bd.generation + 1, rev, bytes: elsOf(v.session_id).reduce((a, e) => a + e.bytes, 0) });
        return ok({ generation: bd.generation, restored: v.id, rev });
      }
      default: return undefined;
    }
  }
  // realtime.messages policy for "classboard:<id>": listen = anyone with access; send = teacher, or a student if not locked
  function canRealtime(me, topic, send) {
    const m = /^classboard:([0-9a-f-]{36})$/.exec(String(topic || '')); if (!m) return false;
    const r = role(me, sess(m[1])); if (!send) return !!r;
    return r === 'teacher' || (r === 'student' && !boardOf(m[1])?.locked);
  }
  const publicTopicOk = topic => { const m = /^classboard-([0-9a-f]{64})$/.exec(String(topic || '')); return !!m && db.class_boards.some(b => b.channel_key === m[1]); };
  function studentBoards(eids) {
    const now = Date.now();
    const groups = new Set(db.group_members.filter(m => eids.includes(m.enrollment_id)).map(m => m.group_id));
    return db.class_boards.filter(b => b.rev > 0).map(b => sess(b.session_id)).filter(s => s && Date.parse(s.ends_at) <= now && Date.parse(s.ends_at) > now - 90 * 864e5
        && (groups.has(s.group_id) || db.session_invitees.some(i => i.session_id === s.id && eids.includes(i.enrollment_id))))
      .sort((a, c) => Date.parse(c.starts_at) - Date.parse(a.starts_at)).slice(0, 8)
      .map(s => ({ id: s.id, title: s.title || group(s.group_id)?.name || '', starts_at: s.starts_at, ends_at: s.ends_at, group_name: group(s.group_id)?.name || null }));
  }
  const flags = sid => { const b = boardOf(sid); return { has_board: !!b && b.rev > 0, board_locked: !!b?.locked }; };
  return { handle, canRealtime, publicTopicOk, studentBoards, flags };
};
