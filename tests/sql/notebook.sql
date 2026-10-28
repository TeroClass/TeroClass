-- Group notebook ("Cuaderno del grupo": one per group and school year, one section per class) + the group whiteboard pages:
-- access matrix (teacher, substitute, enrolled student, student of another group, invited guest of a one-off class, own admin
-- read-only, parent admin, sibling / other-institution admin, superadmin read-only, anon), sections idempotent, school year
-- boundaries with school_year_start_month (inherited), push / pull / snapshot per section, lock (whole notebook and past
-- classes only), 8 MB cap, versions / restore permission, teacher-only notes, Realtime policies, board pages, legacy class
-- documents and boards still readable. Run after stub + 001_base.sql (alone or after the other suites: own "nb-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qn cascade;
create schema qn;
grant usage on schema qn to anon, authenticated, service_role;
create table qn.results(n serial, label text, ok boolean, detail text);
grant all on qn.results to anon, authenticated, service_role; grant all on sequence qn.results_n_seq to anon, authenticated, service_role;
create function qn.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
create function qn.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qn.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qn.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qn.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qn.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qn.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qn to anon, authenticated, service_role;
create function qn.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qn.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qn.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qn.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
create function qn.nb(g text) returns uuid language sql security definer as
$$ select id from public.group_notebooks where group_id = qn.grp(g) and school_year = public.tc_school_year(qn.grp(g), now()) $$;
create function qn.sec(t text) returns uuid language sql security definer as $$ select id from public.group_notebook_sections where session_id = qn.sess(t) $$;
create function qn.nsec(g text) returns bigint language sql security definer as $$ select count(*) from public.group_notebook_sections where notebook_id = qn.nb(g) $$;
create function qn.gen(g text) returns integer language sql security definer as $$ select generation from public.group_notebooks where id = qn.nb(g) $$;
create function qn.ver(g text, l text) returns uuid language sql security definer as $$ select id from public.group_notebook_versions where notebook_id = qn.nb(g) and label = l order by created_at desc limit 1 $$;
create function qn.b(t text) returns text language sql immutable as $$ select translate(encode(convert_to(t, 'UTF8'), 'base64'), E'\n', '') $$;
create function qn.rt(t text) returns void language plpgsql as $$ begin perform set_config('realtime.topic', t, false); end $$;
grant execute on function qn.inst(text), qn.uid(text), qn.grp(text), qn.sess(text), qn.nb(text), qn.sec(text), qn.nsec(text), qn.gen(text),
  qn.ver(text,text), qn.b(text), qn.rt(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: NB Madre › NB Sede 1 ; NB Madre › NB Sede 2 ; NB Otra =====
set role authenticated; select qn.as_user(:'OWNER');
select qn.eq('S: superadmin creates the tree', $$select (public.create_institution('NB Madre','nb-madre','nb-adm@x.com') is not null
  and public.create_institution('NB Sede 1','nb-s1','nb-s1adm@x.com',null,qn.inst('nb-madre')) is not null
  and public.create_institution('NB Sede 2','nb-s2','nb-s2adm@x.com',null,qn.inst('nb-madre')) is not null
  and public.create_institution('NB Otra','nb-otra','nb-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('nb-otra','nb-s1','nb-s2') and not open_registration;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'nb-adm@x.com','{"name":"NB Admin"}',now()),
  (gen_random_uuid(),'nb-s1adm@x.com','{"name":"NB Admin S1"}',now()),
  (gen_random_uuid(),'nb-s2adm@x.com','{"name":"NB Admin S2"}',now()),
  (gen_random_uuid(),'nb-oadm@x.com','{"name":"NB Admin Otra"}',now()),
  (gen_random_uuid(),'nb-t1@x.com','{"org_slug":"nb-s1","name":"NB Teacher One"}',now()),
  (gen_random_uuid(),'nb-sub@x.com','{"org_slug":"nb-s1","name":"NB Sub"}',now()),
  (gen_random_uuid(),'nb-t2@x.com','{"org_slug":"nb-s2","name":"NB Teacher Two"}',now()),
  (gen_random_uuid(),'nb-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'nb-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  (gen_random_uuid(),'nb-st4@x.com','{"via":"student_link","name":"Dani"}',now()),
  (gen_random_uuid(),'nb-guest@x.com','{"via":"student_link","name":"Guest"}',now());
set role authenticated; select qn.as_user(qn.uid('nb-adm@x.com')::text);
select public.create_group(qn.inst('nb-s1'), 'NB G1', qn.uid('nb-t1@x.com'), qn.uid('nb-sub@x.com'));
select public.create_group(qn.inst('nb-s2'), 'NB G2', qn.uid('nb-t2@x.com'));
select public.add_student(null, 'nb-st1@x.com', 'Ana Alonso', qn.grp('NB G1'));
select public.add_student(null, 'nb-st2@x.com', 'Beto Ruiz', qn.grp('NB G1'));
select public.add_student(null, 'nb-st4@x.com', 'Dani Díaz', qn.grp('NB G2'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('nb-st1@x.com','nb-st2@x.com','nb-st4@x.com');
-- classes of NB G1 relative to now (same school year as long as today is not in the first days of January: the "past" one is
-- 2 days ago only when that is still this year) + one in the far future + one cancelled; NB G2 one class
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, x.d, x.d + interval '45 minutes', 'America/Montevideo', x.st
  from (values ('NB G1', 'NB past',   greatest(now() - interval '2 days', date_trunc('year', now() at time zone 'America/Montevideo') at time zone 'America/Montevideo' + interval '1 hour'), 'scheduled'),
               ('NB G1', 'NB now',    now() - interval '5 minutes', 'scheduled'),
               ('NB G1', 'NB later',  now() + interval '7 days', 'scheduled'),
               ('NB G1', 'NB cancel', now() - interval '3 hours', 'cancelled'),
               ('NB G2', 'NB G2 class', now() - interval '1 hour', 'scheduled')) x(g, t, d, st)
  join public.class_groups g on g.name = x.g;
set role authenticated; select qn.as_user(qn.uid('nb-t1@x.com')::text);
select public.create_session(null, 'NB one-off', now() - interval '10 minutes', 60, 'America/Montevideo', array['nb-guest@x.com']);
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u where lower(u.email) = lower(e.email) and lower(e.email) = 'nb-guest@x.com';
-- a class document and a whiteboard that existed BEFORE the notebook (legacy): they must stay readable
set role authenticated; select qn.as_user(qn.uid('nb-t1@x.com')::text);
select public.classdoc_push(qn.sess('NB past'), 1, qn.b('old doc'), 'old');
select public.classboard_push(qn.sess('NB past'), 1, jsonb_build_array(jsonb_build_object('id','old1','type','rectangle','version',1,'versionNonce',1,'x',0,'y',0)), 'old');

-- ===== find / resolve: who gets a notebook =====
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: admin find before anyone opened it: no notebook (admins never create)', $$select coalesce(public.notebook_find(qn.grp('NB G1'))->>'notebook_id', 'null')||'/'||(public.notebook_resolve(qn.grp('NB G1'))->>'role')$$, 'null/admin');
reset role;
select qn.eq('N: … and nothing was created', $$select count(*)::text from public.group_notebooks where group_id = qn.grp('NB G1')$$, '0');
set role authenticated; select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: enrolled student resolves the group notebook: created, role student, year = this school year', $$select (x->>'notebook_id' is not null)::text||'/'||(x->>'role')||'/'||(x->>'year' = extract(year from now() at time zone 'America/Montevideo')::text)::text from (select public.notebook_resolve(qn.grp('NB G1')) x) y$$, 'true/student/true');
reset role;
select qn.eq('N: sections were created for the classes that already started (not the future one, not the cancelled one), in date order', $$select string_agg(s.title, ',' order by s.starts_at) from public.group_notebook_sections sec join public.class_sessions s on s.id = sec.session_id where sec.notebook_id = qn.nb('NB G1')$$, 'NB past,NB now');
set role authenticated;
select qn.eq('N: resolving again creates nothing new (idempotent)', $$select (public.notebook_resolve(qn.grp('NB G1'))->>'notebook_id' = qn.nb('NB G1')::text)::text||'/'||qn.nsec('NB G1')$$, 'true/2');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: resolve by a future class (teacher) adds its section and returns it', $$select (x->>'section_id' = qn.sec('NB later')::text)::text||'/'||qn.nsec('NB G1') from (select public.notebook_resolve(null, qn.sess('NB later')) x) y$$, 'true/3');
select qn.eq('N: resolve by the same class again: same section, no duplicate', $$select (public.notebook_resolve(null, qn.sess('NB later'))->>'section_id' = qn.sec('NB later')::text)::text||'/'||qn.nsec('NB G1')$$, 'true/3');
select qn.eq('N: a cancelled class never gets a section', $$select coalesce(public.notebook_resolve(null, qn.sess('NB cancel'))->>'section_id', 'null')||'/'||qn.nsec('NB G1')$$, 'null/3');
select qn.eq('N: a one-off class (no group) has no notebook: adhoc (it keeps its class document)', $$select (x->>'adhoc')||'/'||coalesce(x->>'notebook_id','null') from (select public.notebook_resolve(null, qn.sess('NB one-off')) x) y$$, 'true/null');
select qn.fails('N: a group and a class of another group refused', $$select public.notebook_resolve(qn.grp('NB G2'), qn.sess('NB now'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-guest@x.com')::text);
select qn.fails('N: invited guest of a one-off class is not in the group: no notebook', $$select public.notebook_resolve(qn.grp('NB G1'))$$, 'No autorizado');
select qn.eq('N: … but still opens their one-off class (adhoc)', $$select public.notebook_resolve(null, qn.sess('NB one-off'))->>'adhoc'$$, 'true');
select qn.as_user(qn.uid('nb-st4@x.com')::text);
select qn.fails('N: student of another group cannot resolve', $$select public.notebook_resolve(qn.grp('NB G1'))$$, 'No autorizado');
select qn.fails('N: student of another group cannot resolve by class', $$select public.notebook_resolve(null, qn.sess('NB now'))$$, 'No autorizado');

-- ===== access matrix (open) =====
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher opens: role teacher, can edit + lock, private topic, title parts, 8 MB cap, name from the database', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->'channel'->>'topic' = 'notebook:'||qn.nb('NB G1'))::text||'/'||(x->'notebook'->>'group_name')||'/'||(x->>'max_bytes')||'/'||(x->'me'->>'name')||'/'||json_array_length(x->'sections')
  from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'teacher/true/true/true/NB G1/8388608/NB Teacher One/3');
select qn.eq('N: sections carry increasing "Clase N" numbers of the school year and the past flag', $$select string_agg(s->>'past', ',' order by s->>'starts_at')||'/'||(bool_and((s->>'number')::int >= 1))::text||'/'||(max((s->>'number')::int) - min((s->>'number')::int) = 2)::text from json_array_elements(public.notebook_open(qn.nb('NB G1'))->'sections') s$$, 'true,false,false/true/true');
select qn.eq('N: the class document that existed before is linked from its section (legacy_doc)', $$select string_agg(s->>'legacy_doc', ',' order by s->>'starts_at') from json_array_elements(public.notebook_open(qn.nb('NB G1'))->'sections') s$$, 'true,false,false');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: substitute = teacher', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'teacher/true/true');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: enrolled student edits, cannot lock; name = the name the school loaded; no notes count', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->'me'->>'name')||'/'||coalesce(x->>'notes','null') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'student/true/false/Ana Alonso/null');
select qn.as_user(qn.uid('nb-st4@x.com')::text);
select qn.fails('N: other student cannot open', $$select public.notebook_open(qn.nb('NB G1'))$$, 'No autorizado');
select qn.fails('N: other student cannot push', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('x'), 'c9')$$, 'No autorizado');
select qn.fails('N: other student cannot pull', $$select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c9', null)$$, 'No autorizado');
select qn.fails('N: other student cannot read versions', $$select public.notebook_versions(qn.nb('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-guest@x.com')::text);
select qn.fails('N: invited guest of a one-off class cannot open the group notebook', $$select public.notebook_open(qn.nb('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-t2@x.com')::text);
select qn.fails('N: teacher of another group cannot open', $$select public.notebook_open(qn.nb('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: own unit admin: read-only (role admin, no edit / lock, no identity, no notes)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||coalesce(x->>'me','null')||'/'||coalesce(x->>'notes','null') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'admin/false/false/null/null');
select qn.eq('N: admin find now returns the notebook', $$select (public.notebook_find(qn.grp('NB G1'))->>'notebook_id' = qn.nb('NB G1')::text)::text$$, 'true');
select qn.fails('N: own unit admin cannot push', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('x'), 'ca')$$, 'Solo lectura');
select qn.fails('N: own unit admin cannot add a section', $$select public.notebook_add_section(qn.nb('NB G1'), 'x')$$, 'No autorizado');
select qn.as_user(qn.uid('nb-adm@x.com')::text);
select qn.eq('N: parent unit admin reads too', $$select public.notebook_open(qn.nb('NB G1'))->>'role'$$, 'admin');
select qn.as_user(qn.uid('nb-s2adm@x.com')::text);
select qn.fails('N: sibling unit admin cannot open', $$select public.notebook_open(qn.nb('NB G1'))$$, 'No autorizado');
select qn.fails('N: sibling unit admin cannot find', $$select public.notebook_find(qn.grp('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-oadm@x.com')::text);
select qn.fails('N: other-institution admin cannot open', $$select public.notebook_open(qn.nb('NB G1'))$$, 'No autorizado');
select qn.fails('N: other-institution admin cannot pull', $$select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'cx', null)$$, 'No autorizado');
select qn.as_user(:'OWNER');
select qn.eq('N: superadmin: read-only', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'admin/false');
select qn.fails('N: superadmin cannot push', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('x'), 'c0')$$, 'Solo lectura');
select qn.fails('N: unknown notebook', $$select public.notebook_open(gen_random_uuid())$$, 'No autorizado');

-- ===== writing: push / pull / snapshot per section =====
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher writes in today''s section', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('t-1'), 'c1')->>'id' is not null)::text$$, 'true');
select qn.fails('N: a section of another notebook is refused', $$select public.notebook_push(qn.nb('NB G1'), gen_random_uuid(), 1, qn.b('x'), 'c1')$$, 'Sección inválida');
select qn.fails('N: invalid base64 refused', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, '<script>', 'c1')$$, 'Cambio inválido');
select qn.fails('N: an old generation refused', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 7, qn.b('x'), 'c1')$$, 'desactualizado');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: student writes in today''s section and in a past one (not locked)', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('a-1'), 'c2') is not null and public.notebook_push(qn.nb('NB G1'), qn.sec('NB past'), 1, qn.b('a-2'), 'c2') is not null)::text$$, 'true');
select qn.eq('N: student pull from 0: 3 updates, with their section; own client id kept', $$select json_array_length(x->'updates')||'/'||(select count(*) from json_array_elements(x->'updates') u where u->>'s' = qn.sec('NB now')::text)||'/'||(select count(*) from json_array_elements(x->'updates') u where u->>'c' = 'c2') from (select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c2', '{"s":"x","cursor":null}'::jsonb, 3) x) y$$, '3/2/2');
select qn.eq('N: pull with the known number of sections omits the section list', $$select (public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c2', null, 3)->'sections')::text$$, 'null');
select qn.eq('N: pull with an outdated number of sections returns the list (no photos)', $$select json_array_length(x->'sections')||'/'||(x->'sections'->0->>'state' is null)::text from (select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c2', null, 1) x) y$$, '3/true');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher sees the student in presence (name from the school), never an email', $$select string_agg((p->>'name')||'/'||(p->>'role'), ',')||'/'||(position('@' in min(x::text)) = 0)::text from (select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c1', '{}'::jsonb) x) y, json_array_elements(x->'presence') p$$, 'Ana Alonso/student/true');
select qn.eq('N: snapshot of today''s section compacts it (its updates are deleted, others kept)', $$select (public.notebook_snapshot(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('STATE-NOW'), (select max(id) from public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c1', null) x, json_array_elements(x->'updates') u, lateral (select (u->>'id')::bigint as id) z))->>'ok')$$, 'true');
reset role;
select qn.eq('N: … only the past section still has a pending update', $$select count(*)::text from public.group_notebook_updates where notebook_id = qn.nb('NB G1')$$, '1');
select qn.eq('N: notebook bytes = sum of its sections', $$select (n.bytes = (select sum(bytes) from public.group_notebook_sections s where s.notebook_id = n.id))::text from public.group_notebooks n where n.id = qn.nb('NB G1')$$, 'true');
set role authenticated; select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: a pull from before the snapshot gets that section''s photo', $$select (select count(*) from json_array_elements(x->'states') s where s->>'s' = qn.sec('NB now')::text)||'/'||(select convert_from(decode(s->>'d','base64'),'UTF8') from json_array_elements(x->'states') s where s->>'s' = qn.sec('NB now')::text) from (select public.notebook_pull(qn.nb('NB G1'), 1, 1, 'c2', null, 3) x) y$$, '1/STATE-NOW');
select qn.eq('N: open = photos + pending updates', $$select (select count(*) from json_array_elements(x->'sections') s where s->>'state' is not null)||'/'||json_array_length(x->'updates') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, '1/1');
select qn.fails('N: a snapshot beyond the last change refused', $$select public.notebook_snapshot(qn.nb('NB G1'), qn.sec('NB past'), 1, qn.b('S'), 999999999)$$, 'Cambio inválido');

-- ===== sections: "today" and free sections (teacher) =====
select qn.fails('N: student cannot add a section', $$select public.notebook_add_section(qn.nb('NB G1'), 'Mine')$$, 'No autorizado');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: "Agregar sección de hoy" = today''s class section (exists already: nothing new)', $$select (x->>'section_id' = qn.sec('NB now')::text)::text||'/'||(x->>'created') from (select public.notebook_add_section(qn.nb('NB G1'), null, null, true) x) y$$, 'true/false');
select qn.eq('N: a free section with a title (from the generator) is added', $$select public.notebook_add_section(qn.nb('NB G1'), 'Repaso: fotosíntesis')->>'created'$$, 'true');
select qn.fails('N: a free section needs a title', $$select public.notebook_add_section(qn.nb('NB G1'), '   ')$$, 'título');
select qn.fails('N: a class of another group is not a section of this notebook', $$select public.notebook_add_section(qn.nb('NB G1'), null, qn.sess('NB G2 class'))$$, 'no es de este cuaderno');
select qn.as_user(qn.uid('nb-t2@x.com')::text);
select public.notebook_resolve(qn.grp('NB G2'));
reset role;
update public.class_sessions set status = 'cancelled' where title = 'NB G2 class';
set role authenticated; select qn.as_user(qn.uid('nb-t2@x.com')::text);
select qn.eq('N: a group without a class today: "today" makes ONE day section (idempotent)', $$select (a->>'created')||'/'||(b->>'created')||'/'||(a->>'section_id' = b->>'section_id')::text
  from (select public.notebook_add_section((select (public.notebook_find(qn.grp('NB G2'))->>'notebook_id')::uuid), null, null, true) a) x,
       lateral (select public.notebook_add_section((select (public.notebook_find(qn.grp('NB G2'))->>'notebook_id')::uuid), null, null, true) b) z$$, 'true/false/true');
reset role;
update public.class_sessions set status = 'scheduled' where title = 'NB G2 class';
set role authenticated;

-- ===== lock: whole notebook, then past classes only =====
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.fails('N: student cannot lock', $$select public.notebook_set_lock(qn.nb('NB G1'), true)$$, 'No autorizado');
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.fails('N: admin cannot lock', $$select public.notebook_set_lock(qn.nb('NB G1'), true)$$, 'No autorizado');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher locks the whole notebook', $$select public.notebook_set_lock(qn.nb('NB G1'), true)::text$$, '{"locked" : true, "lock_past" : false}');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: locked: student opens read-only', $$select (x->>'locked')||'/'||(x->>'can_edit') from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'true/false');
select qn.fails('N: locked: student push refused', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('no'), 'c2')$$, 'bloqueó el cuaderno');
select qn.fails('N: locked: student snapshot refused', $$select public.notebook_snapshot(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('no'), 0)$$, 'bloqueó el cuaderno');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: locked: substitute still writes', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('sub'), 'c3')->>'id' is not null)::text$$, 'true');
select qn.eq('N: substitute switches to "past classes only"', $$select public.notebook_set_lock(qn.nb('NB G1'), false, true)::text$$, '{"locked" : false, "lock_past" : true}');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: past-only lock: student writes in today''s section', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('a-3'), 'c2')->>'id' is not null)::text$$, 'true');
select qn.fails('N: past-only lock: student push into a past class refused', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB past'), 1, qn.b('no'), 'c2')$$, 'clases anteriores');
select qn.eq('N: past-only lock: open says the notebook is editable but flags the past section', $$select (x->>'can_edit')||'/'||(x->>'lock_past')||'/'||(select s->>'past' from json_array_elements(x->'sections') s where s->>'id' = qn.sec('NB past')::text) from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'true/true/true');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: past-only lock: the teacher still writes in the past class', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB past'), 1, qn.b('t-past'), 'c1')->>'id' is not null)::text$$, 'true');
select public.notebook_set_lock(qn.nb('NB G1'), false, false);

-- ===== size cap (8 MB per notebook) =====
reset role;
update public.group_notebooks set bytes = 8388608 - 100 where id = qn.nb('NB G1');
set role authenticated; select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.fails('N: a large change past 8 MB refused with a clear message', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, translate(encode(convert_to(repeat('z', 6000), 'UTF8'), 'base64'), E'\n', ''), 'c2')$$, 'tamaño máximo (8 MB)');
select qn.eq('N: a small change (e.g. deleting) is still accepted near the cap', $$select (public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('del'), 'c2')->>'id' is not null)::text$$, 'true');
select qn.eq('N: open reports bytes near the cap (the app warns from 80 %)', $$select ((x->>'bytes')::bigint > 0.8 * (x->>'max_bytes')::bigint)::text from (select public.notebook_open(qn.nb('NB G1')) x) y$$, 'true');
select qn.fails('N: a snapshot that would grow the notebook past the cap refused', $$select public.notebook_snapshot(qn.nb('NB G1'), qn.sec('NB now'), 1, translate(encode(convert_to(repeat('y', 200000), 'UTF8'), 'base64'), E'\n', ''), (select max(id) from public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c2', null) x, json_array_elements(x->'updates') u, lateral (select (u->>'id')::bigint as id) z))$$, 'tamaño máximo');
select qn.eq('N: a snapshot that shrinks is accepted', $$select public.notebook_snapshot(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('SMALL'), (select max(id) from public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c2', null) x, json_array_elements(x->'updates') u, lateral (select (u->>'id')::bigint as id) z))->>'ok'$$, 'true');
select qn.eq('N: … and the real size is recomputed (sum of the sections)', $$select ((public.notebook_open(qn.nb('NB G1'))->>'bytes')::bigint < 1000)::text$$, 'true');

-- ===== versions + restore =====
select qn.fails('N: student cannot save a version', $$select public.notebook_add_version(qn.nb('NB G1'), 'manual')$$, 'No autorizado');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher saves a version of the whole notebook', $$select public.notebook_add_version(qn.nb('NB G1'), 'manual')->>'created'$$, 'true');
select qn.eq('N: … with every section that has content', $$select json_array_length(public.notebook_version(qn.ver('NB G1','manual'))->'sections')::text$$, '2');
select qn.fails('N: unknown version label refused', $$select public.notebook_add_version(qn.nb('NB G1'), 'hack')$$, 'Versión inválida');
select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('after-version'), 'c1');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: student sees the history and opens a version', $$select (json_array_length(public.notebook_versions(qn.nb('NB G1'))) >= 1)::text||'/'||(json_array_length(public.notebook_version(qn.ver('NB G1','manual'))->'sections') > 0)::text$$, 'true/true');
select qn.fails('N: student cannot restore', $$select public.notebook_restore(qn.ver('NB G1','manual'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: admin opens a version (read-only)', $$select public.notebook_version(qn.ver('NB G1','manual'))->>'label'$$, 'manual');
select qn.fails('N: admin cannot restore', $$select public.notebook_restore(qn.ver('NB G1','manual'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-oadm@x.com')::text);
select qn.fails('N: other-institution admin cannot open a version', $$select public.notebook_version(qn.ver('NB G1','manual'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: substitute restores: generation 2', $$select public.notebook_restore(qn.ver('NB G1','manual'))->>'generation'$$, '2');
select qn.eq('N: restored content = that version (the change made after it is gone); a "before restore" version keeps it', $$select (select string_agg(convert_from(decode(u->>'d','base64'),'UTF8'), ',' order by (u->>'id')::bigint) from json_array_elements(public.notebook_open(qn.nb('NB G1'))->'updates') u where u->>'s' = qn.sec('NB now')::text)||'/'||(qn.ver('NB G1','before_restore') is not null)::text$$, 'SMALL/true');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.fails('N: after restore, a change from the old generation is refused', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('stale'), 'c2')$$, 'desactualizado');
select qn.eq('N: after restore, a pull with the old generation resets (all sections)', $$select (x->>'reset')||'/'||(x->>'generation')||'/'||(json_array_length(x->'sections') = qn.nsec('NB G1'))::text from (select public.notebook_pull(qn.nb('NB G1'), 99999, 1, 'c2', null, 99) x) y$$, 'true/2/true');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select count(*) from (select public.notebook_add_version(qn.nb('NB G1'), 'manual') from generate_series(1, 25)) x;
reset role;
select qn.eq('N: at most 20 versions per notebook', $$select count(*)::text from public.group_notebook_versions where notebook_id = qn.nb('NB G1')$$, '20');
select qn.eq('N: version authors: never the owner', $$select count(*)::text from public.group_notebook_versions where created_by = '00000000-0000-0000-0000-000000000001'$$, '0');

-- ===== teacher-only notes (the teacher guide never enters the shared notebook) =====
set role authenticated; select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher adds a teacher-only note to a section', $$select (public.notebook_add_note(qn.nb('NB G1'), qn.sec('NB now'), 'Guía docente', 'Answer key: 1. am going')->>'id' is not null)::text$$, 'true');
select qn.eq('N: … and lists it', $$select json_array_length(public.notebook_notes(qn.nb('NB G1')))::text$$, '1');
select qn.fails('N: an empty note refused', $$select public.notebook_add_note(qn.nb('NB G1'), null, 'x', '  ')$$, 'Nota inválida');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: substitute sees the teacher notes', $$select json_array_length(public.notebook_notes(qn.nb('NB G1')))::text$$, '1');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.fails('N: student cannot read teacher notes', $$select public.notebook_notes(qn.nb('NB G1'))$$, 'No autorizado');
select qn.fails('N: student cannot add a teacher note', $$select public.notebook_add_note(qn.nb('NB G1'), null, 'x', 'y')$$, 'No autorizado');
select qn.eq('N: the note text appears nowhere a student can read', $$select (position('Answer key' in public.notebook_open(qn.nb('NB G1'))::text) = 0 and position('Answer key' in public.notebook_pull(qn.nb('NB G1'), 0, 2, 'c2', null)::text) = 0)::text$$, 'true');
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.fails('N: admin cannot read teacher notes', $$select public.notebook_notes(qn.nb('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: teacher deletes a note', $$select public.notebook_delete_note((select (n->>'id')::uuid from json_array_elements(public.notebook_notes(qn.nb('NB G1'))) n limit 1))->>'deleted'$$, 'true');
select qn.eq('N: … gone', $$select json_array_length(public.notebook_notes(qn.nb('NB G1')))::text$$, '0');

-- ===== "Enviar al cuaderno" targets =====
select qn.eq('N: targets: the teacher''s groups with this year''s classes, today''s and the next one', $$select string_agg((g->>'name')||':'||(g->>'today_session' = qn.sess('NB now')::text)::text||':'||(json_array_length(g->'sessions') >= 3)::text, ',') from json_array_elements(public.notebook_targets()) g$$, 'NB G1:true:true');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: targets: the substitute too', $$select string_agg(g->>'name', ',') from json_array_elements(public.notebook_targets()) g$$, 'NB G1');
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.eq('N: targets: a student has none', $$select json_array_length(public.notebook_targets())::text$$, '0');

-- ===== group whiteboard: one page per class (the existing class boards) =====
select qn.eq('N: board pages (student): the classes of the year, today flagged, the old board is the page of its class', $$select (json_array_length(x->'pages') >= 3)::text||'/'||(x->>'today_session' = qn.sess('NB now')::text)::text||'/'||(select p->>'has_board' from json_array_elements(x->'pages') p where p->>'session_id' = qn.sess('NB past')::text)||'/'||(select count(*) from json_array_elements(x->'pages') p where p->>'session_id' = qn.sess('NB cancel')::text)||'/'||(x->>'role')
  from (select public.groupboard_pages(qn.sess('NB now')) x) y$$, 'true/true/true/0/student');
select qn.eq('N: the old board of that class still opens with its drawing (legacy kept)', $$select json_array_length(public.classboard_open(qn.sess('NB past'))->'elements')::text$$, '1');
select qn.eq('N: the old class document still opens (legacy kept)', $$select json_array_length(public.classdoc_open(qn.sess('NB past'))->'updates')::text$$, '1');
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: board pages (own admin): read-only role', $$select public.groupboard_pages(null, qn.grp('NB G1'))->>'role'$$, 'admin');
select qn.as_user(qn.uid('nb-oadm@x.com')::text);
select qn.fails('N: board pages: other-institution admin refused', $$select public.groupboard_pages(null, qn.grp('NB G1'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-st4@x.com')::text);
select qn.fails('N: board pages: other student refused', $$select public.groupboard_pages(qn.sess('NB now'))$$, 'No autorizado');
select qn.as_user(qn.uid('nb-guest@x.com')::text);
select qn.eq('N: board pages of a one-off class: none (single board)', $$select coalesce(public.groupboard_pages(qn.sess('NB one-off'))::text, 'null')$$, 'null');

-- ===== school year: start month per unit (inherited), boundaries =====
select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.fails('N: a teacher cannot set the school year', $$select public.set_school_year_start(qn.inst('nb-s1'), 3)$$, 'No autorizado');
select qn.as_user(qn.uid('nb-s2adm@x.com')::text);
select qn.fails('N: a sibling admin cannot set it', $$select public.set_school_year_start(qn.inst('nb-s1'), 3)$$, 'No autorizado');
select qn.as_user(qn.uid('nb-adm@x.com')::text);
select qn.fails('N: invalid month refused', $$select public.set_school_year_start(qn.inst('nb-madre'), 13)$$, 'Mes inválido');
select qn.eq('N: parent admin sets March on the main institution', $$select public.set_school_year_start(qn.inst('nb-madre'), 3)->>'effective'$$, '3');
select qn.eq('N: … the campus inherits it', $$select (public.school_year_start(qn.inst('nb-s1'))->>'effective')||'/'||coalesce(public.school_year_start(qn.inst('nb-s1'))->>'own','null')||'/'||(public.school_year_start(qn.inst('nb-s1'))->>'inherited')$$, '3/null/3');
reset role;
select qn.eq('N: March start: 20 Feb 2026 belongs to school year 2025, 1 Mar 2026 to 2026, 31 Dec 2026 to 2026', $$select public.tc_school_year(qn.grp('NB G1'), '2026-02-20 12:00-03')||'/'||public.tc_school_year(qn.grp('NB G1'), '2026-03-01 00:30-03')||'/'||public.tc_school_year(qn.grp('NB G1'), '2026-12-31 23:00-03')$$, '2025/2026/2026');
select qn.eq('N: the boundary uses the group''s time zone (28 Feb 23:30 in Montevideo = 1 Mar UTC → still 2025)', $$select public.tc_school_year(qn.grp('NB G1'), '2026-03-01 02:30+00')::text$$, '2025');
select qn.eq('N: school year bounds (March → end of February, Montevideo)', $$select to_char(f at time zone 'UTC', 'YYYY-MM-DD HH24:MI')||' → '||to_char(t at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from public.tc_school_year_bounds(qn.grp('NB G1'), 2026)$$, '2026-03-01 03:00 → 2027-03-01 03:00');
select qn.eq('N: labels: "2026" (January–March starts), "2026–27" (later starts)', $$select public.tc_school_year_label(2026, 3)||' '||public.tc_school_year_label(2026, 9)||' '||public.tc_school_year_label(2099, 9)$$, '2026 2026–27 2099–00');
set role authenticated; select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: the campus admin overrides it (September)', $$select public.set_school_year_start(qn.inst('nb-s1'), 9)->>'effective'$$, '9');
select qn.eq('N: … and goes back to inheriting', $$select public.set_school_year_start(qn.inst('nb-s1'), null)->>'effective'$$, '3');
reset role;
-- a class in February (school year 2025 with a March start) and one in March: two different notebooks
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, x.d::timestamptz, x.d::timestamptz + interval '45 minutes', 'America/Montevideo', 'scheduled'
  from (values ('NB Feb', '2026-02-20 10:00-03'), ('NB Mar', '2026-03-02 10:00-03')) x(t, d), public.class_groups g where g.name = 'NB G1';
set role authenticated; select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.eq('N: a February class goes to the 2025 notebook, a March class to the 2026 one', $$select (public.notebook_resolve(null, qn.sess('NB Feb'))->>'year')||'/'||(public.notebook_resolve(null, qn.sess('NB Mar'))->>'year')||'/'||(public.notebook_resolve(null, qn.sess('NB Feb'))->>'notebook_id' <> public.notebook_resolve(null, qn.sess('NB Mar'))->>'notebook_id')::text$$, '2025/2026/true');
select qn.eq('N: the 2025 notebook only has its own year''s classes; the title label says 2025', $$select string_agg(s->>'title', ',')||'/'||(x->'notebook'->>'year_label') from (select public.notebook_open((public.notebook_resolve(null, qn.sess('NB Feb'))->>'notebook_id')::uuid) x) y, json_array_elements(x->'sections') s group by x->'notebook'->>'year_label'$$, 'NB Feb/2025');
select qn.eq('N: "years" lists the notebooks of the group', $$select (json_array_length(public.notebook_open((public.notebook_resolve(null, qn.sess('NB Feb'))->>'notebook_id')::uuid)->'notebook'->'years') >= 2)::text$$, 'true');
reset role;
update public.institutions set school_year_start_month = null where slug in ('nb-madre','nb-s1');
select qn.eq('N: calendar year by default (no unit sets a month)', $$select public.tc_school_year((select id from public.class_groups where name = 'NB G2'), '2026-02-20 12:00-03')::text$$, '2026');

-- ===== direct access =====
set role authenticated; select qn.as_user(qn.uid('nb-t1@x.com')::text);
select qn.fails('N: direct select on group_notebooks denied', $$select count(*) from public.group_notebooks$$, 'permission denied');
select qn.fails('N: direct select on group_notebook_sections denied', $$select count(*) from public.group_notebook_sections$$, 'permission denied');
select qn.fails('N: direct insert into group_notebook_updates denied', $$insert into public.group_notebook_updates(notebook_id, section_id, generation, data) values (qn.nb('NB G1'), qn.sec('NB now'), 1, 'x')$$, 'permission denied');
select qn.fails('N: direct select on group_notebook_notes denied', $$select count(*) from public.group_notebook_notes$$, 'permission denied');
select qn.fails('N: internal helpers are not callable', $$select public.tc_notebook_group_role(qn.grp('NB G1'))$$, 'permission denied');
select qn.fails('N: school year helper not callable', $$select public.tc_school_year(qn.grp('NB G1'), now())$$, 'permission denied');

-- ===== Realtime: private channel "notebook:<id>" =====
select qn.as_user(qn.uid('nb-st1@x.com')::text); select qn.rt('notebook:' || qn.nb('NB G1'));
select qn.eq('N: RT: enrolled student can send', $$with i as (insert into realtime.messages(topic, event, payload) values ('notebook:' || qn.nb('NB G1'), 'poke', '{}') returning 1) select count(*)::text from i$$, '1');
select qn.eq('N: RT: enrolled student can listen', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qn.as_user(qn.uid('nb-t1@x.com')::text); select public.notebook_set_lock(qn.nb('NB G1'), true);
select qn.as_user(qn.uid('nb-st1@x.com')::text);
select qn.fails('N: RT: locked: student cannot send', $$insert into realtime.messages(topic, event, payload) values ('notebook:' || qn.nb('NB G1'), 'poke', '{}')$$, 'row-level security');
select qn.eq('N: RT: locked: student still listens', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qn.as_user(qn.uid('nb-sub@x.com')::text);
select qn.eq('N: RT: locked: substitute still sends', $$with i as (insert into realtime.messages(topic, event, payload) values ('notebook:' || qn.nb('NB G1'), 'poke', '{}') returning 1) select count(*)::text from i$$, '1');
select qn.as_user(qn.uid('nb-t1@x.com')::text); select public.notebook_set_lock(qn.nb('NB G1'), false);
select qn.as_user(qn.uid('nb-s1adm@x.com')::text);
select qn.eq('N: RT: unit admin can listen', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qn.fails('N: RT: unit admin cannot send', $$insert into realtime.messages(topic, event, payload) values ('notebook:' || qn.nb('NB G1'), 'poke', '{}')$$, 'row-level security');
select qn.as_user(qn.uid('nb-st4@x.com')::text);
select qn.eq('N: RT: other student hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qn.fails('N: RT: other student cannot send', $$insert into realtime.messages(topic, event, payload) values ('notebook:' || qn.nb('NB G1'), 'poke', '{}')$$, 'row-level security');
select qn.as_user(qn.uid('nb-oadm@x.com')::text);
select qn.eq('N: RT: other-institution admin hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qn.as_user(qn.uid('nb-st1@x.com')::text); select qn.rt('notebook:not-a-uuid');
select qn.eq('N: RT: malformed topics are not opened', $$select count(*)::text from realtime.messages$$, '0');
select qn.rt('');
set role anon; select qn.as_user('');
select qn.fails('N: anon cannot resolve', $$select public.notebook_resolve(qn.grp('NB G1'))$$, 'permission denied');
select qn.fails('N: anon cannot open', $$select public.notebook_open(qn.nb('NB G1'))$$, 'permission denied');
select qn.fails('N: anon cannot push', $$select public.notebook_push(qn.nb('NB G1'), qn.sec('NB now'), 1, qn.b('x'), 'c')$$, 'permission denied');
select qn.fails('N: anon cannot pull', $$select public.notebook_pull(qn.nb('NB G1'), 0, 1, 'c', null)$$, 'permission denied');
select qn.fails('N: anon cannot restore', $$select public.notebook_restore(gen_random_uuid())$$, 'permission denied');
select qn.fails('N: anon cannot list board pages', $$select public.groupboard_pages(qn.sess('NB now'))$$, 'permission denied');
reset role;

\echo '================ GROUP NOTEBOOK RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qn.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qn.results;
