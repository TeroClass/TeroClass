// Live-room background per institution for the simulated Supabase (tests only). Same rules as 001_base.sql "ROOM BRANDING":
// set_room_background (only admins of that unit / above, superadmin), get_room_background (teacher / students of the class,
// members of the unit, admins; never another institution), inheritance down the chain, and a tiny Storage API for the
// room-backgrounds / logos buckets (multipart upload like supabase-js, public GET of what was uploaded).
const err = message => ({ status: 400, data: { code: 'P0001', message } });
const ok = data => ({ status: 200, data });
const NAME_RE = /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}\.(jpe?g|png|webp)$/i;

module.exports = function install(ctx) {
  const { db, instById, chainOf } = ctx;
  const storage = { files: {}, uploads: [] };
  const urlRe = inst => new RegExp('^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/storage/v1/object/public/room-backgrounds/' + inst + '/[A-Za-z0-9._-]{1,120}\\.(jpe?g|png|webp)$', 'i');
  const prof = me => me && db.profiles.find(p => p.id === me.id);
  const isAdminOf = (p, inst) => !!p && (p.role === 'superadmin' || (p.role === 'org_admin' && !!p.institution_id && chainOf(inst).some(c => c.id === p.institution_id)));
  const DEFAULT = { kind: 'default', color: null, image_url: null, from: null };
  function effective(id) {
    const c = chainOf(id).reverse().find(i => i.room_bg_kind);
    return c ? { kind: c.room_bg_kind, color: c.room_bg_kind === 'color' ? c.room_bg_color : null, image_url: c.room_bg_kind === 'image' ? c.room_bg_url : null, from: c.id } : { ...DEFAULT };
  }
  const adminView = i => ({ ...effective(i.id), own: { kind: i.room_bg_kind || null, color: i.room_bg_color || null, image_url: i.room_bg_url || null }, parent: i.parent_id ? effective(i.parent_id) : null });
  function handle(fn, body, me) {
    if (fn !== 'get_room_background' && fn !== 'set_room_background') return undefined;
    const p = prof(me); if (!p) return err('No autorizado');
    if (fn === 'set_room_background') {
      const inst = instById(body.p_inst); if (!inst || !isAdminOf(p, inst.id)) return err('No autorizado');
      let k = String(body.p_kind || '').trim().toLowerCase() || null; if (k === 'inherit') k = null;
      if (k && !['default', 'color', 'image'].includes(k)) return err('Fondo del aula inválido');
      if (k === 'color' && !/^#[0-9a-f]{6}$/i.test(String(body.p_color || '').trim())) return err('Color de fondo inválido (formato #RRGGBB)');
      if (k === 'image' && !urlRe(inst.id).test(String(body.p_url || '').trim())) return err('Imagen de fondo inválida: subila desde Marca (jpg, png o webp, hasta 3 MB)');
      Object.assign(inst, { room_bg_kind: k, room_bg_color: k === 'color' ? String(body.p_color).trim().toLowerCase() : null, room_bg_url: k === 'image' ? String(body.p_url).trim() : null });
      return ok(adminView(inst));
    }
    if (body.p_session) {
      const s = db.class_sessions.find(x => x.id === body.p_session); if (!s) return err('No autorizado');
      const g = s.group_id && db.class_groups.find(x => x.id === s.group_id);
      const teaches = (g && [g.teacher_id, g.substitute_id].includes(p.id)) || (!s.group_id && s.teacher_id === p.id);
      const attends = db.student_enrollments.some(e => e.user_id === p.id && (db.group_members.some(m => m.group_id === s.group_id && m.enrollment_id === e.id) || db.session_invitees.some(i => i.session_id === s.id && i.enrollment_id === e.id)));
      if (!teaches && !attends && !isAdminOf(p, s.institution_id)) return err('No autorizado');
      return ok(effective(s.institution_id));
    }
    if (body.p_inst) {
      const inst = instById(body.p_inst); if (!inst) return err('No autorizado');
      if (isAdminOf(p, inst.id)) return ok(adminView(inst));
      if (!p.institution_id || !chainOf(p.institution_id).some(c => c.id === inst.id)) return err('No autorizado');
      return ok(effective(inst.id));
    }
    return ok(p.institution_id ? effective(p.institution_id) : { ...DEFAULT });
  }
  // the file part of a multipart/form-data body (supabase-js uploads a Blob as FormData)
  function filePart(buf, ctype) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || ''); if (!m) return { body: buf, type: ctype };
    const b = Buffer.from('--' + (m[1] || m[2]));
    let pos = buf.indexOf(b); const parts = [];
    while (pos >= 0) { const next = buf.indexOf(b, pos + b.length); if (next < 0) break; parts.push(buf.slice(pos + b.length + 2, next - 2)); pos = next; }
    for (const part of parts) {
      const he = part.indexOf('\r\n\r\n'); if (he < 0) continue;
      const head = part.slice(0, he).toString(); if (!/filename=|content-type:/i.test(head) || /name="cacheControl"/.test(head)) continue;
      const t = /content-type:\s*([^\r\n]+)/i.exec(head);
      return { body: part.slice(he + 4), type: t ? t[1].trim() : 'application/octet-stream' };
    }
    return { body: buf, type: ctype };
  }
  // Storage REST: POST /storage/v1/object/<bucket>/<name> (upload), GET /storage/v1/object/public/<bucket>/<name>
  async function handleStorage(route, me) {
    const req = route.request(); const url = new URL(req.url());
    const m = /^\/storage\/v1\/object\/(public\/)?([^/]+)\/(.+)$/.exec(url.pathname); if (!m) return false;
    const bucket = m[2], name = decodeURIComponent(m[3]); const H = { 'access-control-allow-origin': '*' };
    if (m[1] && req.method() === 'GET') {
      const f = storage.files[bucket + '/' + name];
      await route.fulfill(f ? { status: 200, contentType: f.type, body: f.body, headers: H } : { status: 404, contentType: 'application/json', body: '{"message":"Object not found"}', headers: H });
      return true;
    }
    if (!m[1] && ['POST', 'PUT'].includes(req.method())) {
      const p = prof(me); const inst = name.split('/')[0];
      const allowed = ['logos', 'room-backgrounds'].includes(bucket) && isAdminOf(p, inst) && (bucket !== 'room-backgrounds' || NAME_RE.test(name));
      if (!allowed) { await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }), headers: H }); return true; }
      const f = filePart(req.postDataBuffer() || Buffer.alloc(0), req.headers()['content-type']);
      storage.files[bucket + '/' + name] = f; storage.uploads.push({ bucket, name, type: f.type, size: f.body.length });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: bucket + '/' + name, Id: name }), headers: H });
      return true;
    }
    return false;
  }
  return { handle, handleStorage, storage, effective };
};
