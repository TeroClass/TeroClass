-- Class document (one per calendar class: access matrix, lock, live updates, snapshots, versions, restore, Realtime
-- policies) and attendance (join / heartbeat / leave idempotency, late rule, teacher overrides, privacy, group report,
-- student summary, external hook, Métricas). Run after stub + 001_base.sql (alone or after the other suites: own "ca-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qc cascade;
create schema qc;
grant usage on schema qc to anon, authenticated, service_role;
create table qc.results(n serial, label text, ok boolean, detail text);
grant all on qc.results to anon, authenticated, service_role; grant all on sequence qc.results_n_seq to anon, authenticated, service_role;
create function qc.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
create function qc.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qc.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qc.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qc.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qc.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qc.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qc to anon, authenticated, service_role;
create function qc.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qc.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qc.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qc.enr(e text) returns uuid language sql security definer as $$ select id from public.student_enrollments where lower(email) = lower(e) order by created_at limit 1 $$;
create function qc.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
create function qc.b64(t text) returns text language sql as $$ select encode(convert_to(t, 'UTF8'), 'base64') $$;
create function qc.gen(t text) returns integer language sql security definer as $$ select generation from public.class_docs where session_id = qc.sess(t) $$;
create function qc.maxid(t text) returns bigint language sql security definer as $$ select coalesce(max(id), 0) from public.class_doc_updates where session_id = qc.sess(t) $$;
create function qc.nver(t text) returns bigint language sql security definer as $$ select count(*) from public.class_doc_versions where session_id = qc.sess(t) $$;
create function qc.ver(t text, l text) returns uuid language sql security definer as $$ select id from public.class_doc_versions where session_id = qc.sess(t) and label = l order by created_at desc limit 1 $$;
create function qc.att(t text, e text) returns text language sql security definer as
$$ select coalesce(auto_status,'-')||'/'||coalesce(status,'-')||'/'||source||'/'||joins||'/'||in_room from public.session_attendance where session_id = qc.sess(t) and enrollment_id = qc.enr(e) $$;
create function qc.rt(t text) returns void language plpgsql as $$ begin perform set_config('realtime.topic', t, false); end $$;
grant execute on function qc.inst(text), qc.uid(text), qc.grp(text), qc.enr(text), qc.sess(text), qc.b64(text), qc.gen(text), qc.maxid(text),
  qc.nver(text), qc.ver(text,text), qc.att(text,text), qc.rt(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: CA Madre › CA Sede 1 ; CA Madre › CA Sede 2 ; CA Otra =====
set role authenticated; select qc.as_user(:'OWNER');
select qc.eq('S: superadmin creates the tree', $$select (public.create_institution('CA Madre','ca-madre','ca-adm@x.com') is not null
  and public.create_institution('CA Sede 1','ca-s1','ca-s1adm@x.com',null,qc.inst('ca-madre')) is not null
  and public.create_institution('CA Sede 2','ca-s2','ca-s2adm@x.com',null,qc.inst('ca-madre')) is not null
  and public.create_institution('CA Otra','ca-otra','ca-oadm@x.com') is not null)::text$$, 'true');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'ca-adm@x.com','{"name":"CA Admin"}',now()),
  (gen_random_uuid(),'ca-s1adm@x.com','{"name":"CA Admin S1"}',now()),
  (gen_random_uuid(),'ca-s2adm@x.com','{"name":"CA Admin S2"}',now()),
  (gen_random_uuid(),'ca-oadm@x.com','{"name":"CA Admin Otra"}',now()),
  (gen_random_uuid(),'ca-t1@x.com','{"org_slug":"ca-s1","name":"CA Teacher One"}',now()),
  (gen_random_uuid(),'ca-sub@x.com','{"org_slug":"ca-s1","name":"CA Sub"}',now()),
  (gen_random_uuid(),'ca-t2@x.com','{"org_slug":"ca-s2","name":"CA Teacher Two"}',now()),
  (gen_random_uuid(),'ca-to@x.com','{"org_slug":"ca-otra","name":"CA Teacher Otra"}',now()),
  (gen_random_uuid(),'ca-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'ca-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  (gen_random_uuid(),'ca-st4@x.com','{"via":"student_link","name":"Dani"}',now()),
  (gen_random_uuid(),'ca-guest@x.com','{"via":"student_link","name":"Guest"}',now());

set role authenticated; select qc.as_user(qc.uid('ca-adm@x.com')::text);
select public.create_group(qc.inst('ca-s1'), 'CA G1', qc.uid('ca-t1@x.com'), qc.uid('ca-sub@x.com'));
select public.create_group(qc.inst('ca-s2'), 'CA G2', qc.uid('ca-t2@x.com'));
select public.add_student(null, 'ca-st1@x.com', 'Ana Alonso', qc.grp('CA G1'));
select public.add_student(null, 'ca-st2@x.com', 'Beto Barrios', qc.grp('CA G1'));
select public.add_student(null, 'ca-st3@x.com', 'Caro Castro', qc.grp('CA G1'));
select public.add_student(null, 'ca-st4@x.com', 'Dani Díaz', qc.grp('CA G2'));
set role authenticated; select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select public.create_group(qc.inst('ca-otra'), 'CA GO', qc.uid('ca-to@x.com'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('ca-st1@x.com','ca-st2@x.com','ca-st4@x.com');
update public.group_members set created_at = now() - interval '60 days' where group_id in (qc.grp('CA G1'), qc.grp('CA G2'));
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, now() + x.d, now() + x.d + x.len, 'America/Montevideo', x.st
  from (values ('CA G1', 'CA now',      interval '-5 minutes',  interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA late',     interval '-20 minutes', interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA late2',    interval '-20 minutes', interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA soon',     interval '5 minutes',   interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA future',   interval '3 days',      interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA past',     interval '-2 days',     interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA past2',    interval '-9 days',     interval '45 minutes', 'scheduled'),
               ('CA G1', 'CA cancelled',interval '-3 minutes',  interval '45 minutes', 'cancelled'),
               ('CA G1', 'CA doc',      interval '-1 days',     interval '45 minutes', 'scheduled'),
               ('CA G2', 'CA G2 past',  interval '-1 days',     interval '45 minutes', 'scheduled'),
               ('CA GO', 'CA GO past',  interval '-1 days',     interval '45 minutes', 'scheduled')) x(g, t, d, len, st)
  join public.class_groups g on g.name = x.g;
set role authenticated; select qc.as_user(qc.uid('ca-t1@x.com')::text);
select public.create_session(null, 'CA one-off', now() - interval '10 minutes', 60, 'America/Montevideo', array['ca-guest@x.com']);
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u where lower(u.email) = lower(e.email) and lower(e.email) = 'ca-guest@x.com';

-- ═════════════════════════════ CLASS DOCUMENT ═════════════════════════════
-- ===== access matrix (open) =====
set role authenticated; select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('D: teacher opens: role teacher, can edit + lock, empty doc, private channel topic', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->>'locked')||'/'||coalesce(x->>'state','null')||'/'||json_array_length(x->'updates')||'/'||(x->'channel'->>'topic' = 'classdoc:'||qc.sess('CA doc'))::text||'/'||(x->'me'->>'name')
  from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'teacher/true/true/false/null/0/true/CA Teacher One');
select qc.as_user(qc.uid('ca-sub@x.com')::text);
select qc.eq('D: substitute = teacher (edit + lock)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock') from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'teacher/true/true');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: enrolled student: role student, can edit, cannot lock; name = the name the school loaded', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->'me'->>'name') from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'student/true/false/Ana Alonso');
select qc.as_user(qc.uid('ca-guest@x.com')::text);
select qc.eq('D: invited student of a one-off class can edit it', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.classdoc_open(qc.sess('CA one-off')) x) y$$, 'student/true');
select qc.fails('D: invited student cannot open a class of a group they are not in', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-st4@x.com')::text);
select qc.fails('D: non-enrolled student (other group) cannot open', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'No autorizado');
select qc.fails('D: non-enrolled student cannot push', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('x'), 'c9')$$, 'No autorizado');
select qc.fails('D: non-enrolled student cannot pull', $$select public.classdoc_pull(qc.sess('CA doc'), 0, 1, 'c9', null)$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t2@x.com')::text);
select qc.fails('D: teacher of another group cannot open', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('D: own unit admin: read-only (role admin, cannot edit/lock, no presence identity)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||coalesce(x->>'me','null') from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'admin/false/false/null');
select qc.as_user(qc.uid('ca-adm@x.com')::text);
select qc.eq('D: madre admin (parent unit) reads too', $$select public.classdoc_open(qc.sess('CA doc'))->>'role'$$, 'admin');
select qc.as_user(qc.uid('ca-s2adm@x.com')::text);
select qc.fails('D: sibling sede admin cannot open', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.fails('D: other-institution admin cannot open', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'No autorizado');
select qc.fails('D: other-institution admin cannot read versions', $$select public.classdoc_versions(qc.sess('CA doc'))$$, 'No autorizado');
select qc.as_user(:'OWNER');
select qc.eq('D: superadmin: read-only', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'admin/false');
select qc.fails('D: superadmin cannot push (read-only)', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('x'), 'c0')$$, 'Solo lectura');
select qc.fails('D: unknown class', $$select public.classdoc_open(gen_random_uuid())$$, 'No autorizado');

-- ===== editing: push / pull / presence =====
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('D: teacher pushes a change', $$select (public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('T1'), 'c1')->>'id' is not null)::text$$, 'true');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: student pushes a change', $$select (public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('S1'), 'c2')->>'generation')$$, '1');
select qc.eq('D: student pull (announcing presence) gets both changes in order', $$select string_agg(convert_from(decode(u->>'d','base64'),'UTF8'), ',' order by (u->>'id')::bigint) from json_array_elements(public.classdoc_pull(qc.sess('CA doc'), 0, 1, 'c2', '{"cursor":null}'::jsonb)->'updates') u$$, 'T1,S1');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('D: teacher sees the student in presence (name from the school, own color), never an email', $$select (p->>'name')||'/'||(p->>'role')||'/'||(p->>'color' ~ '^#[0-9a-f]{6}$')::text||'/'||(position('@' in x::text) = 0)::text
  from (select public.classdoc_pull(qc.sess('CA doc'), 0, 1, 'c1', '{}'::jsonb) x) y, json_array_elements(x->'presence') p$$, 'Ana Alonso/student/true/true');
select qc.eq('D: pull after the last id returns nothing new', $$select json_array_length(public.classdoc_pull(qc.sess('CA doc'), qc.maxid('CA doc'), 1, 'c1', null)->'updates')::text$$, '0');
select qc.fails('D: invalid base64 refused', $$select public.classdoc_push(qc.sess('CA doc'), 1, '%%not-base64%%', 'c1')$$, 'Cambio inválido');
select qc.fails('D: empty change refused', $$select public.classdoc_push(qc.sess('CA doc'), 1, '', 'c1')$$, 'Cambio inválido');
select qc.fails('D: change from an old generation refused', $$select public.classdoc_push(qc.sess('CA doc'), 7, qc.b64('x'), 'c1')$$, 'desactualizado');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.fails('D: unit admin cannot push', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('x'), 'ca')$$, 'Solo lectura');
select qc.fails('D: unit admin cannot snapshot', $$select public.classdoc_snapshot(qc.sess('CA doc'), 1, qc.b64('x'), 0)$$, 'Solo lectura');
select qc.eq('D: admin reads the changes', $$select json_array_length(public.classdoc_pull(qc.sess('CA doc'), 0, 1, 'ca', '{}'::jsonb)->'updates')::text$$, '2');
reset role;
select qc.eq('D: an admin reading never appears in presence', $$select count(*)::text from public.class_doc_presence where session_id = qc.sess('CA doc') and user_id = qc.uid('ca-s1adm@x.com')$$, '0');
select qc.eq('D: a push after the class ended stores the "class end" version first (state before the change)', $$select qc.nver('CA doc')::text||'/'||(qc.ver('CA doc','class_end') is not null)::text$$, '1/true');

-- ===== lock =====
set role authenticated; select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('D: student cannot lock', $$select public.classdoc_set_lock(qc.sess('CA doc'), true)$$, 'No autorizado');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.fails('D: admin cannot lock', $$select public.classdoc_set_lock(qc.sess('CA doc'), true)$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('D: teacher locks', $$select public.classdoc_set_lock(qc.sess('CA doc'), true)->>'locked'$$, 'true');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: locked: student opens read-only', $$select (x->>'locked')||'/'||(x->>'can_edit') from (select public.classdoc_open(qc.sess('CA doc')) x) y$$, 'true/false');
select qc.fails('D: locked: student push refused', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('S2'), 'c2')$$, 'bloqueó');
select qc.fails('D: locked: student snapshot refused', $$select public.classdoc_snapshot(qc.sess('CA doc'), 1, qc.b64('x'), 0)$$, 'bloqueó');
select qc.eq('D: locked: student still reads (pull says can_edit false)', $$select (x->>'can_edit')||'/'||json_array_length(x->'updates') from (select public.classdoc_pull(qc.sess('CA doc'), 0, 1, 'c2', null) x) y$$, 'false/2');
select qc.as_user(qc.uid('ca-sub@x.com')::text);
select qc.eq('D: locked: substitute still edits', $$select (public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('SUB'), 'c3')->>'id' is not null)::text$$, 'true');
select qc.eq('D: substitute unlocks', $$select public.classdoc_set_lock(qc.sess('CA doc'), false)->>'locked'$$, 'false');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: unlocked: student edits again', $$select (public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('S2'), 'c2')->>'id' is not null)::text$$, 'true');

-- ===== snapshot (compaction) =====
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.fails('D: snapshot beyond the last change refused', $$select public.classdoc_snapshot(qc.sess('CA doc'), 1, qc.b64('SNAP'), qc.maxid('CA doc') + 50)$$, 'Cambio inválido');
select qc.eq('D: teacher snapshot up to the last change', $$select public.classdoc_snapshot(qc.sess('CA doc'), 1, qc.b64('SNAP'), qc.maxid('CA doc'))->>'ok'$$, 'true');
reset role;
select qc.eq('D: compacted changes deleted', $$select count(*)::text from public.class_doc_updates where session_id = qc.sess('CA doc')$$, '0');
set role authenticated; select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: a client behind the snapshot gets reset + the full state', $$select (x->>'reset')||'/'||convert_from(decode(x->>'state','base64'),'UTF8') from (select public.classdoc_pull(qc.sess('CA doc'), 1, 1, 'c2', null) x) y$$, 'true/SNAP');
select qc.eq('D: open returns the snapshot', $$select convert_from(decode(public.classdoc_open(qc.sess('CA doc'))->>'state','base64'),'UTF8')$$, 'SNAP');
select qc.eq('D: an older snapshot is ignored (ok=false)', $$select public.classdoc_snapshot(qc.sess('CA doc'), 1, qc.b64('OLD'), 0)->>'ok'$$, 'false');

-- ===== versions + restore =====
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('D: student cannot save a manual version', $$select public.classdoc_add_version(qc.sess('CA doc'), 'manual')$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('D: teacher saves a version', $$select public.classdoc_add_version(qc.sess('CA doc'), 'manual')->>'created'$$, 'true');
select qc.eq('D: "class end" version only once', $$select public.classdoc_add_version(qc.sess('CA doc'), 'class_end')->>'created'$$, 'false');
select qc.fails('D: unknown version label refused', $$select public.classdoc_add_version(qc.sess('CA doc'), 'hack')$$, 'Versión inválida');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('D: student sees the history and opens a version', $$select (json_array_length(public.classdoc_versions(qc.sess('CA doc'))) >= 2)::text||'/'||convert_from(decode(public.classdoc_version(qc.ver('CA doc','manual'))->'parts'->>0,'base64'),'UTF8')$$, 'true/SNAP');
select qc.fails('D: student cannot restore', $$select public.classdoc_restore(qc.ver('CA doc','manual'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('D: admin opens a version (read-only)', $$select public.classdoc_version(qc.ver('CA doc','manual'))->>'label'$$, 'manual');
select qc.fails('D: admin cannot restore', $$select public.classdoc_restore(qc.ver('CA doc','manual'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.fails('D: other-institution admin cannot open a version', $$select public.classdoc_version(qc.ver('CA doc','manual'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('AFTER'), 'c1');
select qc.eq('D: teacher restores the class-end version: generation 2', $$select public.classdoc_restore(qc.ver('CA doc','class_end'))->>'generation'$$, '2');
select qc.eq('D: restored content = the class-end parts (T1: the state before the first change after the class); a "before restore" version keeps what was there', $$select string_agg(convert_from(decode(u->>'d','base64'),'UTF8'), ',' order by (u->>'id')::bigint)||'/'||(qc.ver('CA doc','before_restore') is not null)::text
  from json_array_elements(public.classdoc_open(qc.sess('CA doc'))->'updates') u$$, 'T1/true');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('D: after restore, a change from the old generation is refused', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('STALE'), 'c2')$$, 'desactualizado');
select qc.eq('D: after restore, a pull with the old generation resets', $$select (x->>'reset')||'/'||(x->>'generation') from (select public.classdoc_pull(qc.sess('CA doc'), 99999, 1, 'c2', null) x) y$$, 'true/2');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select count(*) from (select public.classdoc_add_version(qc.sess('CA doc'), 'manual') from generate_series(1, 25)) x;
reset role;
select qc.eq('D: at most 20 versions per document, the class-end one kept', $$select qc.nver('CA doc')::text||'/'||(qc.ver('CA doc','class_end') is not null)::text$$, '20/true');
select qc.eq('D: version authors: never the owner; manual ones by the teacher', $$select count(*) filter (where created_by = qc.uid('ca-t1@x.com'))::text from public.class_doc_versions where session_id = qc.sess('CA doc')$$, '19');

-- ===== direct access + group sessions =====
set role authenticated; select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.fails('D: direct select on class_docs denied', $$select count(*) from public.class_docs$$, 'permission denied');
select qc.fails('D: direct select on class_doc_updates denied', $$select count(*) from public.class_doc_updates$$, 'permission denied');
select qc.fails('D: direct insert into class_doc_updates denied', $$insert into public.class_doc_updates(session_id, generation, data) values (qc.sess('CA doc'), 1, 'x')$$, 'permission denied');
select qc.fails('D: direct select on class_doc_versions denied', $$select count(*) from public.class_doc_versions$$, 'permission denied');
select qc.eq('D: group sessions (teacher): the doc is flagged', $$select (s->>'has_doc')||'/'||(x->>'can_edit') from (select public.group_sessions(qc.grp('CA G1')) x) y, json_array_elements(x->'sessions') s where s->>'id' = qc.sess('CA doc')::text$$, 'true/true');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('D: group sessions (unit admin): read-only, same list', $$select (x->>'can_edit')||'/'||(json_array_length(x->'sessions') >= 8)::text from (select public.group_sessions(qc.grp('CA G1')) x) y$$, 'false/true');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.fails('D: group sessions: other-institution admin refused', $$select public.group_sessions(qc.grp('CA G1'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('D: group sessions: student refused', $$select public.group_sessions(qc.grp('CA G1'))$$, 'No autorizado');
select qc.eq('D: student dashboard lists the documents of their past classes', $$select (select count(*) from json_array_elements(public.student_view()->'docs') d where d->>'id' = qc.sess('CA doc')::text)::text$$, '1');

-- ===== Realtime: private channel "classdoc:<id>" (policies on realtime.messages) =====
select qc.as_user(qc.uid('ca-st1@x.com')::text); select qc.rt('classdoc:' || qc.sess('CA doc'));
select qc.eq('D: RT: enrolled student can send on the channel', $$with i as (insert into realtime.messages(topic, event, payload) values ('classdoc:' || qc.sess('CA doc'), 'poke', '{}') returning 1) select count(*)::text from i$$, '1');
select qc.eq('D: RT: enrolled student can listen', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('D: RT: unit admin can listen (read-only)', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qc.fails('D: RT: unit admin cannot send', $$insert into realtime.messages(topic, event, payload) values ('classdoc:' || qc.sess('CA doc'), 'poke', '{}')$$, 'row-level security');
select qc.as_user(qc.uid('ca-st4@x.com')::text);
select qc.eq('D: RT: non-enrolled student hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qc.fails('D: RT: non-enrolled student cannot send', $$insert into realtime.messages(topic, event, payload) values ('classdoc:' || qc.sess('CA doc'), 'poke', '{}')$$, 'row-level security');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.eq('D: RT: other-institution admin hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qc.as_user(qc.uid('ca-st1@x.com')::text); select qc.rt('other-topic');
select qc.eq('D: RT: other topics are not opened by these policies', $$select count(*)::text from realtime.messages$$, '0');
select qc.rt('');
set role anon; select qc.as_user('');
select qc.fails('D: anon cannot open', $$select public.classdoc_open(qc.sess('CA doc'))$$, 'permission denied');
select qc.fails('D: anon cannot push', $$select public.classdoc_push(qc.sess('CA doc'), 1, qc.b64('x'), 'c')$$, 'permission denied');
reset role;

-- ═════════════════════════════ ATTENDANCE ═════════════════════════════
set role authenticated; select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('A: student joins a class that started 5 min ago → present', $$select public.attendance_join(qc.sess('CA now'))->>'status'$$, 'present');
select qc.eq('A: joining again is idempotent (one row, same first join, joins = 2)', $$select (public.attendance_join(qc.sess('CA now'))->>'status')||'/'||qc.att('CA now','ca-st1@x.com')$$, 'present/present/-/auto/2/true');
reset role;
select qc.eq('A: one row per student and class', $$select count(*)::text from public.session_attendance where session_id = qc.sess('CA now') and enrollment_id = qc.enr('ca-st1@x.com')$$, '1');
-- a heartbeat 60 s after the last one adds ~60 s; a gap of more than 150 s adds nothing (the tab was closed)
update public.session_attendance set last_seen = now() - interval '60 seconds' where session_id = qc.sess('CA now') and enrollment_id = qc.enr('ca-st1@x.com');
set role authenticated; select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('A: heartbeat adds the minute', $$select public.attendance_heartbeat(qc.sess('CA now'))->>'minutes'$$, '1');
reset role;
update public.session_attendance set last_seen = now() - interval '10 minutes' where session_id = qc.sess('CA now') and enrollment_id = qc.enr('ca-st1@x.com');
set role authenticated; select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.eq('A: after a long gap nothing is added (left without saying)', $$select public.attendance_heartbeat(qc.sess('CA now'))->>'minutes'$$, '1');
select qc.eq('A: leave closes the stay', $$select (public.attendance_leave(qc.sess('CA now'))->>'recorded')||'/'||qc.att('CA now','ca-st1@x.com')$$, 'true/present/-/auto/2/false');
select qc.eq('A: late rule: joined 20 min after the start (limit 10) → late', $$select public.attendance_join(qc.sess('CA late'))->>'status'$$, 'late');
select qc.fails('A: before the 10-minute window → refused', $$select public.attendance_join(qc.sess('CA future'))$$, 'no está abierta');
select qc.eq('A: 5 min before the start → allowed (present)', $$select public.attendance_join(qc.sess('CA soon'))->>'status'$$, 'present');
select qc.fails('A: after the end → refused', $$select public.attendance_join(qc.sess('CA past'))$$, 'no está abierta');
select qc.fails('A: cancelled class → refused', $$select public.attendance_join(qc.sess('CA cancelled'))$$, 'cancelada');
select qc.eq('A: leave without a record records nothing', $$select public.attendance_leave(qc.sess('CA late2'))->>'recorded'$$, 'false');
select qc.fails('A: a student cannot change the late limit', $$select public.set_attendance_late_minutes(qc.inst('ca-s1'), 30)$$, 'No autorizado');
select qc.as_user(qc.uid('ca-st4@x.com')::text);
select qc.fails('A: a student of another group cannot join', $$select public.attendance_join(qc.sess('CA now'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-adm@x.com')::text);
select qc.eq('A: madre admin sets "late after 30 min"', $$select public.set_attendance_late_minutes(qc.inst('ca-madre'), 30)->>'late_minutes'$$, '30');
select qc.eq('A: sedes inherit the late limit', $$select public.session_attendance(qc.sess('CA late2'))->>'late_minutes'$$, '30');
select qc.fails('A: invalid late limit', $$select public.set_attendance_late_minutes(qc.inst('ca-madre'), 500)$$, 'Minutos inválidos');
select qc.as_user(qc.uid('ca-st2@x.com')::text);
select qc.eq('A: late limit 30 → joined 20 min after the start = present', $$select public.attendance_join(qc.sess('CA late2'))->>'status'$$, 'present');
select qc.as_user(qc.uid('ca-guest@x.com')::text);
select qc.eq('A: invited student of a one-off class joins', $$select public.attendance_join(qc.sess('CA one-off'))->>'status'$$, 'present');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('A: teacher presence is recorded too (kind teacher, no status)', $$select (x->>'kind')||'/'||coalesce(x->>'status','null') from (select public.attendance_join(qc.sess('CA now')) x) y$$, 'teacher/null');

-- ===== the session list (teacher) and overrides =====
select qc.eq('A: teacher list (ongoing class): Ana present (left), Beto + Caro pending; emails for the teacher', $$select (select string_agg((s->>'name')||':'||(s->>'status'), ',' order by s->>'name') from json_array_elements(x->'students') s)||'/'||(x->>'can_edit')||'/'||(x->'counts'->>'pending')||'/'||(position('ca-st2@x.com' in x::text) > 0)::text||'/'||json_array_length(x->'staff')
  from (select public.session_attendance(qc.sess('CA now')) x) y$$, 'Ana Alonso:present,Beto Barrios:pending,Caro Castro:pending/true/2/true/1');
select qc.eq('A: a finished class without records → everyone absent (computed when reading)', $$select string_agg(s->>'status', ',') from json_array_elements(public.session_attendance(qc.sess('CA past'))->'students') s$$, 'absent,absent,absent');
select qc.eq('A: teacher marks Beto excused with a note (source teacher)', $$select (x->>'status')||'/'||(x->>'source')||'/'||(x->>'note') from (select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st2@x.com'), 'excused', 'Médico') x) y$$, 'excused/teacher/Médico');
select qc.eq('A: teacher override wins over the automatic status (late → present)', $$select (public.set_attendance(qc.sess('CA late'), qc.enr('ca-st1@x.com'), 'present')->>'status')||'/'||qc.att('CA late','ca-st1@x.com')$$, 'present/late/present/teacher/1/true');
select qc.as_user(qc.uid('ca-sub@x.com')::text);
select qc.eq('A: substitute marks Caro present in the past class', $$select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st3@x.com'), 'present')->>'status'$$, 'present');
select qc.eq('A: null = back to automatic (Caro absent again), note kept when not given', $$select (x->>'status')||'/'||(x->>'source') from (select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st3@x.com'), null) x) y$$, 'absent/auto');
select qc.fails('A: invalid status refused', $$select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st3@x.com'), 'sleeping')$$, 'inválido');
select qc.fails('A: a student of another group cannot be marked', $$select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st4@x.com'), 'present')$$, 'no es de esta clase');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('A: student cannot read the class list', $$select public.session_attendance(qc.sess('CA now'))$$, 'No autorizado');
select qc.fails('A: student cannot correct', $$select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st1@x.com'), 'present')$$, 'No autorizado');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('A: unit admin reads the list (read-only)', $$select (x->>'can_edit')||'/'||json_array_length(x->'students') from (select public.session_attendance(qc.sess('CA past')) x) y$$, 'false/3');
select qc.fails('A: unit admin cannot correct', $$select public.set_attendance(qc.sess('CA past'), qc.enr('ca-st1@x.com'), 'present')$$, 'No autorizado');
select qc.as_user(qc.uid('ca-s2adm@x.com')::text);
select qc.fails('A: sibling sede admin cannot read the list', $$select public.session_attendance(qc.sess('CA past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.fails('A: other-institution admin cannot read the list', $$select public.session_attendance(qc.sess('CA past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t2@x.com')::text);
select qc.fails('A: teacher of another group cannot read the list', $$select public.session_attendance(qc.sess('CA past'))$$, 'No autorizado');

-- ===== group report =====
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.eq('A: report (teacher): students, counts and % (Ana: late→present + present + 3 absent; the ongoing class is still pending)', $$select (s->>'name')||':'||(s->>'present')||'/'||(s->>'late')||'/'||(s->>'absent')||'/'||(s->>'excused')||'/'||coalesce(s->>'pct','-')
  from json_array_elements(public.attendance_report(qc.grp('CA G1'))->'students') s where s->>'name' = 'Ana Alonso'$$, 'Ana Alonso:2/0/3/0/40');
select qc.eq('A: report: Beto excused in "CA past" (not counted against him)', $$select (s->>'excused')||'/'||(s->>'present') from json_array_elements(public.attendance_report(qc.grp('CA G1'))->'students') s where s->>'name' = 'Beto Barrios'$$, '1/1');
select qc.eq('A: report matrix: one cell per held class (not future or cancelled)', $$select (json_array_length(x->'sessions') = json_array_length(x->'students'->0->'cells'))::text||'/'||json_array_length(x->'sessions')
  from (select public.attendance_report(qc.grp('CA G1')) x) y$$, 'true/6');
select qc.eq('A: report date range (last 3 days only)', $$select json_array_length(public.attendance_report(qc.grp('CA G1'), (now() at time zone 'America/Montevideo')::date - 2, (now() at time zone 'America/Montevideo')::date)->'sessions')::text$$, '5');
select qc.fails('A: report: invalid range', $$select public.attendance_report(qc.grp('CA G1'), (now() at time zone 'America/Montevideo')::date, (now() at time zone 'America/Montevideo')::date - 5)$$, 'Rango de fechas inválido');
select qc.as_user(qc.uid('ca-s1adm@x.com')::text);
select qc.eq('A: report (unit admin): read-only, with the emails this institution loaded', $$select (x->>'can_edit')||'/'||(position('ca-st1@x.com' in x::text) > 0)::text from (select public.attendance_report(qc.grp('CA G1')) x) y$$, 'false/true');
select qc.as_user(qc.uid('ca-s2adm@x.com')::text);
select qc.fails('A: report: sibling sede admin refused', $$select public.attendance_report(qc.grp('CA G1'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-oadm@x.com')::text);
select qc.fails('A: report: other-institution admin refused', $$select public.attendance_report(qc.grp('CA G1'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-t2@x.com')::text);
select qc.fails('A: report: teacher of another group refused', $$select public.attendance_report(qc.grp('CA G1'))$$, 'No autorizado');
select qc.as_user(qc.uid('ca-st1@x.com')::text);
select qc.fails('A: report: student refused', $$select public.attendance_report(qc.grp('CA G1'))$$, 'No autorizado');

-- ===== the student's own summary =====
select qc.eq('A: student summary: own finished classes only (3 held: doc, past, past2 → 0 attended)', $$select (x->>'held')||'/'||(x->>'attended')||'/'||(x->>'absent') from (select public.student_view()->'attendance' x) y$$, '3/0/3');
select qc.eq('A: student summary has no classmates or emails', $$select (position('Beto' in x::text) = 0 and position('@' in x::text) = 0)::text from (select public.student_view()->'attendance' x) y$$, 'true');
select qc.as_user(qc.uid('ca-st2@x.com')::text);
select qc.eq('A: Beto: 1 excused, 2 absent', $$select (x->>'held')||'/'||(x->>'excused')||'/'||(x->>'absent') from (select public.student_view()->'attendance' x) y$$, '3/1/2');
reset role;
-- added to the group today: earlier classes don't count against them
update public.group_members set created_at = now() where enrollment_id = qc.enr('ca-st2@x.com') and group_id = qc.grp('CA G1');
set role authenticated; select qc.as_user(qc.uid('ca-st2@x.com')::text);
select qc.eq('A: classes before joining the group are not counted', $$select public.student_view()->'attendance'->>'held'$$, '0');
reset role;
update public.group_members set created_at = now() - interval '60 days' where enrollment_id = qc.enr('ca-st2@x.com') and group_id = qc.grp('CA G1');

-- ===== external hook (LiveKit / AI later): service key only; never overrides the teacher =====
set role authenticated; select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.fails('A: hook not callable by the app', $$select public.attendance_record_external(qc.sess('CA past'), qc.enr('ca-st1@x.com'), now(), now(), 60)$$, 'permission denied');
reset role;
set role service_role;
select qc.eq('A: hook (service key): AI participation recorded; the teacher''s "excused" stays', $$select (x->>'status')||'/'||(x->>'source') from (select public.attendance_record_external(qc.sess('CA past'), qc.enr('ca-st2@x.com'), now() - interval '2 days', now() - interval '2 days' + interval '40 minutes', 2400, 300, 'ai') x) y$$, 'excused/teacher');
select qc.eq('A: hook: LiveKit join for Caro → present (auto)', $$select (x->>'status')||'/'||(x->>'source') from (select public.attendance_record_external(qc.sess('CA past'), qc.enr('ca-st3@x.com'), now() - interval '2 days' + interval '2 minutes', null, 1800) x) y$$, 'present/auto');
reset role;

-- ===== Métricas (super admin): only the total rate =====
set role authenticated; select qc.as_user(:'OWNER');
select qc.eq('A: Métricas: attendance rate present, no names', $$select ((x->'students'->'attendance'->>'expected')::int > 0)::text||'/'||(position('Ana Alonso' in (x->'students'->'attendance')::text) = 0)::text from (select public.platform_insights(30, qc.inst('ca-madre'), false) x) y$$, 'true/true');
select qc.as_user(qc.uid('ca-t1@x.com')::text);
select qc.fails('A: direct select on session_attendance denied', $$select count(*) from public.session_attendance$$, 'permission denied');
select qc.fails('A: direct update on session_attendance denied', $$update public.session_attendance set status = 'present'$$, 'permission denied');
set role anon; select qc.as_user('');
select qc.fails('A: anon cannot join', $$select public.attendance_join(qc.sess('CA now'))$$, 'permission denied');
reset role;
-- removing a student from the unit removes their attendance with the enrollment
set role authenticated; select qc.as_user(qc.uid('ca-adm@x.com')::text);
select public.remove_student(qc.enr('ca-st3@x.com'));
reset role;
select qc.eq('A: removed student''s attendance deleted with the enrollment', $$select count(*)::text from public.session_attendance a join public.student_enrollments e on e.id = a.enrollment_id where lower(e.email) = 'ca-st3@x.com'$$, '0');

\echo '================ CLASS DOC + ATTENDANCE RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qc.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qc.results;
