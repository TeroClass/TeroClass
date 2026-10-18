-- Groups + students + calendar: privacy rules (RLS / security-definer RPCs), seats, claim by verified email,
-- calendar feed, CSV import. Run after stub + 001_base.sql (alone or after the other suites).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qs cascade;
create schema qs;
grant usage on schema qs to anon, authenticated, service_role;
create table qs.results(n serial, label text, ok boolean, detail text);
grant all on qs.results to anon, authenticated, service_role; grant all on sequence qs.results_n_seq to anon, authenticated, service_role;
-- as_user(id, amr): amr = how this session was opened ('otp' = email link/code, 'password', null = no claims)
create function qs.as_user(u text, amr text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u, ''), false);
  perform set_config('request.jwt.claims', case when amr is null then '' else json_build_object('sub', u, 'amr', json_build_array(json_build_object('method', amr, 'timestamp', 1)))::text end, false);
end $$;
create function qs.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qs.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qs.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qs.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qs.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qs.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qs to anon, authenticated, service_role;
create function qs.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qs.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qs.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qs.enr(p_slug text, e text) returns uuid language sql security definer as
$$ select id from public.student_enrollments where institution_id = (select i.id from public.institutions i where i.slug = p_slug) and lower(email) = lower(e) $$;
create function qs.seats(p_slug text) returns int language sql security definer as $$ select public.seats_used(public.billing_root((select i.id from public.institutions i where i.slug = p_slug))) $$;
create function qs.d(n int) returns date language sql stable as $$ select (now() at time zone 'America/Montevideo')::date + n $$;
grant execute on function qs.inst(text), qs.uid(text), qs.grp(text), qs.enr(text,text), qs.seats(text), qs.d(int) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: A Madre › A Sede 1 › A Cát ; A Madre › A Sede 2 ; B Madre (another institution) =====
set role authenticated; select qs.as_user(:'OWNER');
select qs.eq('S: superadmin creates the tree', $$select (public.create_institution('A Madre','sa-madre','sa-adm@x.com') is not null
  and public.create_institution('A Sede 1','sa-sede1','sa-s1adm@x.com',null,qs.inst('sa-madre')) is not null
  and public.create_institution('A Sede 2','sa-sede2','sa-s2adm@x.com',null,qs.inst('sa-madre')) is not null
  and public.create_institution('A Cát','sa-cat','',null,qs.inst('sa-sede1')) is not null
  and public.create_institution('B Madre','sb-madre','sb-adm@x.com') is not null)::text$$, 'true');
select public.set_institution_plan(qs.inst('sa-madre'), 8, 1000000);
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'sa-adm@x.com','{"name":"Admin A"}',now()),
  (gen_random_uuid(),'sa-s1adm@x.com','{"name":"Admin Sede 1"}',now()),
  (gen_random_uuid(),'sa-s2adm@x.com','{"name":"Admin Sede 2"}',now()),
  (gen_random_uuid(),'sb-adm@x.com','{"name":"Admin B"}',now()),
  (gen_random_uuid(),'sa-t1@x.com','{"org_slug":"sa-cat","name":"Teacher One"}',now()),
  (gen_random_uuid(),'sa-sub@x.com','{"org_slug":"sa-sede1","name":"Sub Teacher"}',now()),
  (gen_random_uuid(),'sa-t2@x.com','{"org_slug":"sa-sede2","name":"Teacher Two"}',now()),
  (gen_random_uuid(),'sb-t@x.com','{"org_slug":"sb-madre","name":"Teacher B"}',now()),
  (gen_random_uuid(),'loner@x.com','{"name":"Loner"}',now());
select qs.eq('S: members placed', $$select string_agg(email||':'||role||':'||coalesce((select slug from public.institutions i where i.id=institution_id),'-'), ',' order by email)
  from public.profiles where email like 'sa-%' or email like 'sb-%' or email = 'loner@x.com'$$,
  'loner@x.com:teacher:-,sa-adm@x.com:org_admin:sa-madre,sa-s1adm@x.com:org_admin:sa-sede1,sa-s2adm@x.com:org_admin:sa-sede2,sa-sub@x.com:teacher:sa-sede1,sa-t1@x.com:teacher:sa-cat,sa-t2@x.com:teacher:sa-sede2,sb-adm@x.com:org_admin:sb-madre,sb-t@x.com:teacher:sb-madre');
select set_config('qs.seats0', qs.seats('sa-madre')::text, false);
select qs.eq('S: seats used before students (3 admins + 3 teachers)', $$select current_setting('qs.seats0')$$, '6');

-- ===== groups (admin of the unit's subtree) =====
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.eq('S: sede admin creates a group in the cátedra below (teacher + substitute)',
  $$select (public.create_group(qs.inst('sa-cat'), 'English B1 – Tue/Thu', qs.uid('sa-t1@x.com'), qs.uid('sa-sub@x.com')) is not null)::text$$, 'true');
select qs.eq('S: group without teacher yet (allowed, ≤ 1)', $$select (public.create_group(qs.inst('sa-sede1'), 'Spare group') is not null)::text$$, 'true');
select qs.fails('S: same name in the same unit refused', $$select public.create_group(qs.inst('sa-cat'), ' english b1 – tue/thu ')$$, 'Ya existe un grupo');
select qs.fails('S: teacher from another institution refused', $$select public.create_group(qs.inst('sa-cat'), 'X', qs.uid('sb-t@x.com'))$$, 'Docente no válido');
select qs.fails('S: teacher outside my subtree refused (sede 2)', $$select public.create_group(qs.inst('sa-cat'), 'X', qs.uid('sa-t2@x.com'))$$, 'Docente no válido');
select qs.fails('S: substitute = teacher refused', $$select public.create_group(qs.inst('sa-cat'), 'X', qs.uid('sa-t1@x.com'), qs.uid('sa-t1@x.com'))$$, 'otra persona');
select qs.fails('S: invalid timezone refused', $$select public.create_group(qs.inst('sa-cat'), 'X', null, null, 'Mars/Olympus')$$, 'Zona horaria');
select qs.fails('S: sede admin cannot create in a sibling sede', $$select public.create_group(qs.inst('sa-sede2'), 'X')$$, 'No autorizado');
select qs.eq('S: default timezone America/Montevideo', $$select (public.list_groups(qs.inst('sa-sede1'))::jsonb -> 0 ->> 'timezone')$$, 'America/Montevideo');
select qs.eq('S: list_groups covers the subtree (2 groups)', $$select json_array_length(public.list_groups(qs.inst('sa-sede1')))::text$$, '2');
select qs.eq('S: teacher + substitute shown to the admin', $$select string_agg((g->'teacher'->>'name')||'/'||(g->'substitute'->>'name'), ',') from json_array_elements(public.list_groups(qs.inst('sa-cat'))) g$$, 'Teacher One/Sub Teacher');
select qs.fails('S: sede admin cannot list a sibling sede', $$select public.list_groups(qs.inst('sa-sede2'))$$, 'No autorizado');
select qs.fails('S: sede admin cannot list the main institution', $$select public.list_groups(qs.inst('sa-madre'))$$, 'No autorizado');
-- students (email exactly as loaded)
select qs.eq('S: add student with group', $$select (public.add_student(null, ' Ana.Perez@Mail.com ', 'Ana Pérez', qs.grp('English B1 – Tue/Thu'))::jsonb->>'created')$$, 'true');
select qs.eq('S: add same email again (other case) → same enrollment (idempotent)', $$select (public.add_student(null, 'ana.perez@mail.com', '', qs.grp('English B1 – Tue/Thu'))::jsonb->>'created')$$, 'false');
select public.add_student(null, 'Bruno@mail.com', 'Bruno', qs.grp('English B1 – Tue/Thu'));
select public.add_student(null, 'carla@mail.com', 'Carla', qs.grp('English B1 – Tue/Thu'));
select qs.eq('S: student without group (in the selected unit)', $$select (public.add_student(qs.inst('sa-sede1'), 'solo@mail.com', 'Solo')::jsonb->>'in_group')$$, 'false');
select qs.fails('S: bad email refused', $$select public.add_student(qs.inst('sa-sede1'), 'not-an-email', 'X')$$, 'Email inválido');
select qs.fails('S: cannot load students into a sibling sede', $$select public.add_student(qs.inst('sa-sede2'), 'z@mail.com', 'Z')$$, 'No autorizado');
select qs.eq('S: email stored exactly as loaded (trimmed, case kept)', $$select string_agg(x->>'email', ',' order by x->>'email') from json_array_elements(public.list_students(qs.inst('sa-cat'))) x$$, 'Ana.Perez@Mail.com,Bruno@mail.com,carla@mail.com');
reset role;
select qs.eq('S: seats NOT consumed by loaded students', $$select qs.seats('sa-madre')::text$$, current_setting('qs.seats0'));

-- ===== the same person loaded by another institution =====
set role authenticated; select qs.as_user(qs.uid('sb-adm@x.com')::text);
select qs.eq('S: institution B creates its group', $$select (public.create_group(qs.inst('sb-madre'), 'B Group', qs.uid('sb-t@x.com')) is not null)::text$$, 'true');
select public.add_student(null, 'ANA.PEREZ@mail.com', 'Ana P. (B)', qs.grp('B Group'));
select public.add_student(null, 'bea@mail.com', 'Bea', qs.grp('B Group'));
select qs.eq('S: B sees only what B loaded (its own spelling and name)', $$select string_agg((x->>'email')||'|'||(x->>'name'), ',' order by x->>'email') from json_array_elements(public.list_students(qs.inst('sb-madre'))) x$$, 'ANA.PEREZ@mail.com|Ana P. (B),bea@mail.com|Bea');
select qs.fails('S: B cannot list A''s students', $$select public.list_students(qs.inst('sa-madre'))$$, 'No autorizado');
select qs.fails('S: B cannot list A''s group members', $$select public.list_group_members(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
select qs.fails('S: B cannot add itself to A''s group', $$select public.group_add_student(qs.grp('English B1 – Tue/Thu'), qs.enr('sb-madre','bea@mail.com'))$$, 'No autorizado');
select qs.fails('S: B cannot remove A''s enrollment', $$select public.remove_student(qs.enr('sa-cat','ana.perez@mail.com'))$$, 'No autorizado');
select qs.fails('S: direct select on enrollments denied', $$select count(*) from public.student_enrollments$$, 'permission denied');
select qs.fails('S: direct select on groups denied', $$select count(*) from public.class_groups$$, 'permission denied');
select qs.fails('S: direct select on members denied', $$select count(*) from public.group_members$$, 'permission denied');
select qs.fails('S: direct insert on enrollments denied', $$insert into public.student_enrollments(institution_id,email) values (qs.inst('sa-cat'),'x@x.com')$$, 'permission denied');
select qs.fails('S: direct update on groups denied', $$update public.class_groups set teacher_id = auth.uid()$$, 'permission denied');
set role authenticated; select qs.as_user(qs.uid('sa-adm@x.com')::text);
select qs.eq('S: A (main) sees A''s record only (not B''s)', $$select string_agg((x->>'email')||'|'||(x->>'name'), ',' order by x->>'email') from json_array_elements(public.list_students(qs.inst('sa-madre'))) x where lower(x->>'email') like 'ana%'$$, 'Ana.Perez@Mail.com|Ana Pérez');
select qs.eq('S: A sees 4 students in its tree', $$select json_array_length(public.list_students(qs.inst('sa-madre')))::text$$, '4');
select qs.fails('S: A cannot list B', $$select public.list_students(qs.inst('sb-madre'))$$, 'No autorizado');
set role authenticated; select qs.as_user(qs.uid('sa-s2adm@x.com')::text);
select qs.fails('S: sibling sede admin cannot see sede 1 students', $$select public.list_students(qs.inst('sa-sede1'))$$, 'No autorizado');
select qs.fails('S: sibling sede admin cannot read group members', $$select public.list_group_members(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
reset role;

-- ===== teachers =====
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.eq('S: teacher sees names + emails of their group', $$select string_agg(x->>'email', ',' order by x->>'email') from json_array_elements(public.list_group_members(qs.grp('English B1 – Tue/Thu'))) x$$, 'Ana.Perez@Mail.com,Bruno@mail.com,carla@mail.com');
select qs.eq('S: my_groups = only my group (role teacher)', $$select string_agg((x->>'name')||':'||(x->>'role')||':'||(x->>'students'), ',') from json_array_elements(public.my_groups()) x$$, 'English B1 – Tue/Thu:teacher:3');
select qs.fails('S: teacher cannot read another group (spare)', $$select public.list_group_members(qs.grp('Spare group'))$$, 'No autorizado');
select qs.fails('S: teacher cannot read B''s group', $$select public.list_group_members(qs.grp('B Group'))$$, 'No autorizado');
select qs.fails('S: teacher cannot list the unit''s students', $$select public.list_students(qs.inst('sa-cat'))$$, 'No autorizado');
select qs.fails('S: teacher cannot create groups', $$select public.create_group(qs.inst('sa-cat'), 'Mine')$$, 'No autorizado');
select qs.fails('S: teacher cannot add students via admin RPC', $$select public.add_student(qs.inst('sa-cat'), 'q@mail.com', 'Q')$$, 'No autorizado');
-- recurring series Tue/Thu 18:00, 90 min, 4 weeks
select set_config('qs.ser', public.create_series(qs.grp('English B1 – Tue/Thu'), 'B1 class', array[2,4,4], '18:00', 90, qs.d(1), qs.d(28))::jsonb->>'series_id', false);
reset role;
select qs.eq('S: series materialized: one row per Tue/Thu in the range', $$select (select count(*) from public.class_sessions where series_id = current_setting('qs.ser')::uuid)::text$$,
  (select count(*)::text from generate_series(qs.d(1), qs.d(28), interval '1 day') g where extract(isodow from g) in (2,4)));
select qs.eq('S: stored as timestamptz at 18:00 Montevideo, 90 min, tz labelled', $$select string_agg(distinct to_char(starts_at at time zone 'America/Montevideo','HH24:MI')||'-'||to_char(ends_at at time zone 'America/Montevideo','HH24:MI')||'-'||timezone, ',') from public.class_sessions where series_id = current_setting('qs.ser')::uuid$$, '18:00-19:30-America/Montevideo');
select qs.eq('S: weekdays deduplicated and stored', $$select weekdays::text from public.session_series where id = current_setting('qs.ser')::uuid$$, '{2,4}');
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.fails('S: series longer than a year refused', $$select public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[1], '10:00', 60, qs.d(1), qs.d(400))$$, 'máximo un año');
select qs.fails('S: series without weekdays refused', $$select public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[]::int[], '10:00', 60, qs.d(1), qs.d(10))$$, 'al menos un día');
select qs.fails('S: invalid weekday refused', $$select public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[8], '10:00', 60, qs.d(1), qs.d(10))$$, 'inválidos');
select qs.fails('S: invalid duration refused', $$select public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[1], '10:00', 2, qs.d(1), qs.d(10))$$, 'Duración');
select qs.fails('S: series in the past refused', $$select public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[1,2,3,4,5,6,7], '10:00', 60, qs.d(-30), qs.d(-2))$$, 'pasado');
select qs.fails('S: teacher cannot schedule another group', $$select public.create_series(qs.grp('Spare group'), '', array[1], '10:00', 60, qs.d(1), qs.d(10))$$, 'No autorizado');
select qs.eq('S: teacher calendar shows the series (role teacher, can_edit)', $$select count(*)||':'||bool_and((x->>'can_edit')::boolean)||':'||min(x->>'role') from json_array_elements(public.my_calendar(now(), now() + interval '30 days')) x$$,
  (select count(*)::text from generate_series(qs.d(1), qs.d(28), interval '1 day') g where extract(isodow from g) in (2,4))||':true:teacher');
select qs.fails('S: calendar range capped (200 days)', $$select public.my_calendar(now(), now() + interval '300 days')$$, 'Rango');
-- one occurrence edited, one cancelled
select set_config('qs.s1', (select x->>'id' from json_array_elements(public.my_calendar(now(), now() + interval '30 days')) x order by x->>'starts_at' limit 1), false);
select set_config('qs.s2', (select x->>'id' from json_array_elements(public.my_calendar(now(), now() + interval '30 days')) x order by x->>'starts_at' offset 1 limit 1), false);
reset role; select set_config('qs.s1at', (select (starts_at + interval '1 hour')::text from public.class_sessions where id = current_setting('qs.s1')::uuid), false);
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.eq('S: edit one occurrence', $$select (public.update_session(current_setting('qs.s1')::uuid, 'Exam day', current_setting('qs.s1at')::timestamptz, 60) is not null)::text$$, 'true');
select qs.eq('S: cancel one occurrence', $$select public.cancel_session(current_setting('qs.s2')::uuid)$$, 'cancelled');
reset role;
select qs.eq('S: edited occurrence marked + SEQUENCE bumped', $$select title||':'||modified||':'||seq from public.class_sessions where id = current_setting('qs.s1')::uuid$$, 'Exam day:true:1');
select qs.eq('S: cancelled occurrence kept as cancelled', $$select status||':'||seq from public.class_sessions where id = current_setting('qs.s2')::uuid$$, 'cancelled:1');
-- substitute: same access to the group's calendar and sessions
set role authenticated; select qs.as_user(qs.uid('sa-sub@x.com')::text);
select qs.eq('S: substitute sees the group (role substitute)', $$select string_agg((x->>'name')||':'||(x->>'role'), ',') from json_array_elements(public.my_groups()) x$$, 'English B1 – Tue/Thu:substitute');
select qs.eq('S: substitute sees the students'' emails', $$select json_array_length(public.list_group_members(qs.grp('English B1 – Tue/Thu')))::text$$, '3');
select qs.eq('S: substitute sees the sessions and can edit', $$select bool_and((x->>'can_edit')::boolean)::text||':'||min(x->>'role') from json_array_elements(public.my_calendar(now(), now() + interval '30 days')) x$$, 'true:substitute');
select qs.eq('S: substitute edits the whole series (Mondays only) → old days removed, new added, edited kept',
  $$select (public.update_series(current_setting('qs.ser')::uuid, 'B1 class', array[1], '19:00', 60, qs.d(28))::jsonb->>'created')::int > 0$$, 'true');
reset role;
select qs.eq('S: after series edit only Mondays (plus the individually edited one) remain in the future',
  $$select string_agg(distinct case when modified then 'edited' else extract(isodow from starts_at at time zone 'America/Montevideo')::text||'@'||to_char(starts_at at time zone 'America/Montevideo','HH24:MI') end, ',')
      from public.class_sessions where series_id = current_setting('qs.ser')::uuid and starts_at > now()$$, '1@19:00,edited');
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.eq('S: cancel the whole series → future occurrences cancelled', $$select (public.cancel_series(current_setting('qs.ser')::uuid) > 0)::text$$, 'true');
reset role;
select qs.eq('S: ...none left scheduled', $$select count(*)::text from public.class_sessions where series_id = current_setting('qs.ser')::uuid and starts_at > now() and status = 'scheduled'$$, '0');
-- a new weekly series for the rest of the tests (Wednesdays 10:00) + an imminent one-off group class
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select set_config('qs.ser2', public.create_series(qs.grp('English B1 – Tue/Thu'), '', array[3], '10:00', 60, qs.d(0), qs.d(60))::jsonb->>'series_id', false);
select set_config('qs.now', public.create_session(qs.grp('English B1 – Tue/Thu'), 'Now class', now() + interval '5 minutes', 45)::jsonb->>'id', false);
-- ad hoc class inviting by email: a new email is loaded by this teacher into the teacher's unit
select set_config('qs.adhoc', public.create_session(null, 'Office hours', now() + interval '2 days', 30, 'America/Montevideo', array['New.Kid@mail.com',' carla@mail.com '])::jsonb->>'id', false);
select qs.fails('S: ad hoc without emails refused', $$select public.create_session(null, 'X', now() + interval '1 day', 30, 'America/Montevideo', array[]::text[])$$, 'al menos un email');
select qs.fails('S: ad hoc with a bad email refused', $$select public.create_session(null, 'X', now() + interval '1 day', 30, 'America/Montevideo', array['ok@mail.com','bad@'])$$, 'Email inválido');
select qs.fails('S: class date out of range refused', $$select public.create_session(qs.grp('English B1 – Tue/Thu'), 'X', now() - interval '3 days', 30)$$, 'Fecha');
select qs.eq('S: teacher sees ad hoc invitees (name/email)', $$select string_agg((x->>'email')||':'||(x->>'via'), ',' order by x->>'email') from json_array_elements(public.session_people(current_setting('qs.adhoc')::uuid)) x$$, 'New.Kid@mail.com:invite,carla@mail.com:invite');
reset role;
select qs.eq('S: invited email recorded with who loaded it (teacher, source session) in the teacher''s unit',
  $$select (loaded_by = qs.uid('sa-t1@x.com'))::text||':'||source||':'||(institution_id = qs.inst('sa-cat'))::text from public.student_enrollments where email = 'New.Kid@mail.com'$$, 'true:session:true');
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.eq('S: the institution''s admin now sees the invited email (loaded by the institution)', $$select count(*)::text from json_array_elements(public.list_students(qs.inst('sa-sede1'))) x where x->>'email' = 'New.Kid@mail.com'$$, '1');
select qs.eq('S: admin read-only calendar of the unit', $$select (json_array_length(public.unit_calendar(qs.inst('sa-sede1'), now(), now() + interval '30 days')) > 0)::text$$, 'true');
select qs.fails('S: admin (not teacher) cannot edit a session', $$select public.cancel_session(current_setting('qs.adhoc')::uuid)$$, 'No autorizado');
set role authenticated; select qs.as_user(qs.uid('sb-adm@x.com')::text);
select qs.fails('S: B admin cannot see A''s session people', $$select public.session_people(current_setting('qs.adhoc')::uuid)$$, 'No autorizado');
select qs.fails('S: B admin cannot read A''s unit calendar', $$select public.unit_calendar(qs.inst('sa-cat'), now(), now() + interval '30 days')$$, 'No autorizado');
set role authenticated; select qs.as_user(qs.uid('sa-t2@x.com')::text);
select qs.fails('S: other teacher cannot see the ad hoc invitees', $$select public.session_people(current_setting('qs.adhoc')::uuid)$$, 'No autorizado');
select qs.fails('S: other teacher cannot edit the ad hoc class', $$select public.update_session(current_setting('qs.adhoc')::uuid, 'x', now() + interval '1 day', 30)$$, 'No autorizado');
select qs.eq('S: other teacher calendar is empty', $$select json_array_length(public.my_calendar(now() - interval '1 day', now() + interval '60 days'))::text$$, '0');
set role authenticated; select qs.as_user(qs.uid('loner@x.com')::text);
select qs.fails('S: teacher without institution cannot create ad hoc classes', $$select public.create_session(null, 'X', now() + interval '1 day', 30, 'America/Montevideo', array['a@mail.com'])$$, 'pertenecer a una institución');
reset role;

-- ===== students: magic link sign-in, claim by verified email =====
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'ana.perez@mail.com','{"via":"student_link"}',now()),
  (gen_random_uuid(),'bruno@mail.com','{"via":"student_link"}',null),           -- link not confirmed yet
  (gen_random_uuid(),'carla@mail.com','{"name":"Carla","org_slug":"sa-cat"}',now()); -- password sign-up with a student's email
select qs.eq('S: magic-link account → role student, no unit', $$select role||':'||coalesce(institution_id::text,'-') from public.profiles where email = 'ana.perez@mail.com'$$, 'student:-');
select qs.eq('S: seats unchanged by a student account', $$select qs.seats('sa-madre')::text$$, (current_setting('qs.seats0')::int + 1)::text);
-- (+1 = carla registered through /org/sa-cat as a teacher — a seat, as before)
set role authenticated;
select qs.as_user(qs.uid('ana.perez@mail.com')::text, null);
select qs.eq('S: claim without email-link session → nothing linked', $$select (public.claim_enrollments()::jsonb->>'linked')||':'||(public.claim_enrollments()::jsonb->>'verified')$$, '0:false');
select qs.as_user(qs.uid('ana.perez@mail.com')::text, 'password');
select qs.eq('S: claim from a password session → nothing linked', $$select public.claim_enrollments()::jsonb->>'linked'$$, '0');
select qs.as_user(qs.uid('bruno@mail.com')::text, 'otp');
select qs.eq('S: unconfirmed email → nothing linked', $$select public.claim_enrollments()::jsonb->>'verified'$$, 'false');
select qs.as_user(qs.uid('carla@mail.com')::text, 'password');
select qs.eq('S: password sign-up with a student''s email cannot claim', $$select public.claim_enrollments()::jsonb->>'linked'$$, '0');
select qs.as_user(qs.uid('ana.perez@mail.com')::text, 'otp');
select qs.eq('S: email-link session + confirmed email → links A''s and B''s enrollments (case-insensitive)', $$select public.claim_enrollments()::jsonb->>'linked'$$, '2');
select qs.eq('S: claiming again links nothing new', $$select (public.claim_enrollments()::jsonb->>'linked')||':'||(public.claim_enrollments()::jsonb->>'enrollments')$$, '0:2');
select qs.eq('S: role stays student', $$select public.my_role()$$, 'student');
-- what the student sees
select qs.eq('S: student sees both groups with teacher display name and classmate COUNT', $$select string_agg((x->>'name')||':'||(x->>'teacher_name')||':'||(x->>'classmates'), ',' order by x->>'name') from json_array_elements(public.student_view()->'groups') x$$, 'B Group:Teacher B:2,English B1 – Tue/Thu:Teacher One:3');
select qs.eq('S: student never sees classmates'' emails', $$select (position('bruno@' in lower(public.student_view()::text)) = 0 and position('carla@' in lower(public.student_view()::text)) = 0 and position('bea@' in lower(public.student_view()::text)) = 0)::text$$, 'true');
select qs.eq('S: student sees their own email', $$select public.student_view()->'me'->>'email'$$, 'ana.perez@mail.com');
select qs.eq('S: student sees upcoming sessions (incl. the imminent one)', $$select (json_array_length(public.student_view()->'sessions') > 3 and exists (select 1 from json_array_elements(public.student_view()->'sessions') x where x->>'title' = 'Now class'))::text$$, 'true');
select qs.eq('S: student calendar rows: role student, cannot edit', $$select bool_and(x->>'role' = 'student' and not (x->>'can_edit')::boolean)::text from json_array_elements(public.my_calendar(now() - interval '1 day', now() + interval '60 days')) x$$, 'true');
select qs.fails('S: student cannot list group members', $$select public.list_group_members(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
select qs.fails('S: student cannot list session people', $$select public.session_people(current_setting('qs.now')::uuid)$$, 'No autorizado');
select qs.fails('S: student cannot list students', $$select public.list_students(qs.inst('sa-cat'))$$, 'No autorizado');
select qs.fails('S: student cannot view as someone else', $$select public.student_view(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
select qs.fails('S: student cannot edit sessions', $$select public.cancel_session(current_setting('qs.now')::uuid)$$, 'No autorizado');
select qs.fails('S: student cannot read enrollments directly', $$select email from public.student_enrollments$$, 'permission denied');
select qs.eq('S: student profile sees only itself', $$select count(*)::text from public.profiles$$, '1');
select qs.eq('S: student gets no AI generator', $$select public.consume_ai_quota('{"kind":"generate"}')::jsonb->>'allowed'$$, 'false');
select qs.fails('S: student cannot save classes', $$insert into public.plannings(owner_id, title) values (auth.uid(), 'x')$$, 'row-level security');
reset role;
select qs.eq('S: student AI attempt not recorded in ai_events', $$select count(*)::text from public.ai_events where user_id = qs.uid('ana.perez@mail.com')$$, '0');
-- admins never see student profiles
set role authenticated; select qs.as_user(qs.uid('sa-adm@x.com')::text);
select qs.eq('S: admin cannot select student profiles', $$select count(*)::text from public.profiles where role = 'student'$$, '0');
select qs.eq('S: ...but sees the enrollment as linked', $$select (x->>'linked') from json_array_elements(public.list_students(qs.inst('sa-madre'))) x where lower(x->>'email') = 'ana.perez@mail.com'$$, 'true');
set role authenticated; select qs.as_user(:'OWNER');
select qs.eq('S: superadmin sees everything (student profile)', $$select count(*)::text from public.profiles where role = 'student'$$, '2');
select qs.eq('S: superadmin View as: generic student of a group (no emails)', $$select json_array_length(public.student_view(qs.grp('English B1 – Tue/Thu'))->'groups')::text||':'||(position('@' in (public.student_view(qs.grp('English B1 – Tue/Thu'))->'groups')::text) = 0)::text$$, '1:true');
select qs.eq('S: superadmin View as: a specific student', $$select public.student_view(null, qs.enr('sa-cat','bruno@mail.com'))->'me'->>'name'$$, 'Bruno');
select qs.fails('S: superadmin cannot move a student into a unit', $$select public.admin_move_member(qs.uid('ana.perez@mail.com'), qs.inst('sa-cat'))$$, 'Los estudiantes');
reset role;

-- ===== a teacher who is also a student keeps the teacher role =====
set role authenticated; select qs.as_user(qs.uid('sb-adm@x.com')::text);
select public.add_student(null, 'Sa-T2@x.com', 'Teacher Two as student', qs.grp('B Group'));
set role authenticated; select qs.as_user(qs.uid('sb-t@x.com')::text);
select public.create_session(qs.grp('B Group'), 'B class', now() + interval '3 days', 60);
set role authenticated; select qs.as_user(qs.uid('sa-t2@x.com')::text, 'otp');
select qs.eq('S: teacher claims their student enrollment', $$select public.claim_enrollments()::jsonb->>'linked'$$, '1');
select qs.eq('S: ...keeps the teacher role', $$select public.my_role()$$, 'teacher');
select qs.eq('S: ...and sees that class in their calendar as a student', $$select string_agg((x->>'title')||':'||(x->>'role'), ',') from json_array_elements(public.my_calendar(now(), now() + interval '30 days')) x$$, 'B class:student');
reset role;

-- ===== calendar feed (token, publishable key) =====
set role authenticated; select qs.as_user(qs.uid('ana.perez@mail.com')::text);
select set_config('qs.tok', public.my_calendar_token(), false);
select qs.eq('S: token is 64 hex chars and stable', $$select (current_setting('qs.tok') ~ '^[0-9a-f]{64}$' and public.my_calendar_token() = current_setting('qs.tok'))::text$$, 'true');
reset role;
select set_config('qs.feedn', (select count(*)::text from public.class_sessions s where s.starts_at > now() - interval '60 days' and s.starts_at < now() + interval '400 days' and public.tc_attends(s.id, qs.uid('ana.perez@mail.com'))), false);
set role anon; select qs.as_user(null);
select qs.eq('S: feed returns only that user''s sessions', $$select json_array_length(public.calendar_feed(current_setting('qs.tok')))::text$$, current_setting('qs.feedn'));
select qs.eq('S: feed has no emails and no extra fields', $$select (position('@' in public.calendar_feed(current_setting('qs.tok'))::text) = 0)::text||':'||(select string_agg(k, ',' order by k) from json_object_keys(public.calendar_feed(current_setting('qs.tok'))->0) k)$$, 'true:ends_at,group_name,id,role,seq,starts_at,status,teacher_name,title,updated_at');
select qs.eq('S: feed includes cancelled sessions as cancelled (for calendar apps)', $$select (count(*) > 0)::text from json_array_elements(public.calendar_feed(current_setting('qs.tok'))) x where x->>'status' = 'cancelled'$$, 'true');
select qs.eq('S: bad token → nothing', $$select json_array_length(public.calendar_feed('abc'))::text||json_array_length(public.calendar_feed(null))::text||json_array_length(public.calendar_feed(repeat('0',64)))::text||json_array_length(public.calendar_feed(upper(current_setting('qs.tok'))))::text$$, '0000');
select qs.fails('S: anon cannot read tokens', $$select token from public.calendar_tokens$$, 'permission denied');
select qs.fails('S: anon cannot create a token', $$select public.my_calendar_token()$$, 'permission denied');
reset role;
set role authenticated; select qs.as_user(qs.uid('ana.perez@mail.com')::text);
select set_config('qs.tok2', public.my_calendar_token(true), false);
reset role; set role anon; select qs.as_user(null);
select qs.eq('S: reset link: old token dead, new token works', $$select json_array_length(public.calendar_feed(current_setting('qs.tok')))::text||':'||(json_array_length(public.calendar_feed(current_setting('qs.tok2'))) > 0)::text$$, '0:true');
-- anon is denied everything else
select qs.fails('S: anon list_groups', $$select public.list_groups(qs.inst('sa-cat'))$$, 'permission denied');
select qs.fails('S: anon list_students', $$select public.list_students(qs.inst('sa-cat'))$$, 'permission denied');
select qs.fails('S: anon list_group_members', $$select public.list_group_members(qs.grp('B Group'))$$, 'permission denied');
select qs.fails('S: anon my_calendar', $$select public.my_calendar(now(), now() + interval '1 day')$$, 'permission denied');
select qs.fails('S: anon student_view', $$select public.student_view()$$, 'permission denied');
select qs.fails('S: anon claim_enrollments', $$select public.claim_enrollments()$$, 'permission denied');
select qs.fails('S: anon import_students', $$select public.import_students(qs.inst('sa-cat'), '[]', false, false)$$, 'permission denied');
select qs.fails('S: anon create_session', $$select public.create_session(null, 'x', now(), 30, null, null)$$, 'permission denied');
select qs.fails('S: anon session_notify_payload', $$select public.session_notify_payload(current_setting('qs.now')::uuid)$$, 'permission denied');
select qs.fails('S: anon unit_calendar', $$select public.unit_calendar(qs.inst('sa-cat'), now(), now() + interval '1 day')$$, 'permission denied');
select qs.fails('S: anon tables', $$select count(*) from public.class_sessions$$, 'permission denied');
select qs.fails('S: anon internal helper', $$select public.tc_calendar_rows(null, now(), now(), 1)$$, 'permission denied');
reset role;
set role authenticated; select qs.as_user(qs.uid('sa-t2@x.com')::text);
select qs.fails('S: authenticated cannot call internal helpers', $$select public.tc_ensure_enrollment(qs.inst('sa-cat'), 'x@mail.com', '', 'manual')$$, 'permission denied');
select qs.fails('S: notify payload only for the session''s teacher', $$select public.session_notify_payload(current_setting('qs.now')::uuid)$$, 'No autorizado');
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.eq('S: notify payload for the teacher: recipients'' emails', $$select json_array_length(public.session_notify_payload(current_setting('qs.now')::uuid)->'recipients')::text$$, '3');
reset role;

-- ===== CSV import (preview + commit, idempotent) =====
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select set_config('qs.rows', $j$[
  {"line":2,"email":"dan@mail.com","name":"Dan","group":"English B1 – Tue/Thu","unit":"sa-cat"},
  {"line":3,"email":"bad-email","name":"Bad","group":"English B1 – Tue/Thu","unit":"sa-cat"},
  {"line":4,"email":"DAN@mail.com","name":"Dan again","group":"english b1 – tue/thu","unit":"a Cát"},
  {"line":5,"email":"eve@mail.com","name":"Eve","group":"Math 2","teacher_email":"sa-sub@x.com","unit":"sa-cat"},
  {"line":6,"email":"fay@mail.com","name":"Fay","group":"Math 2","unit":"A Cát"},
  {"line":7,"email":"gus@mail.com","name":"Gus","group":"French","teacher_email":"sb-t@x.com"},
  {"line":8,"email":"hal@mail.com","name":"Hal","unit":"No Such Unit"},
  {"line":9,"email":"bruno@mail.com","name":"Bruno","group":"English B1 – Tue/Thu","unit":"sa-cat"},
  {"line":10,"email":"","name":"Nobody"},
  {"line":11,"email":"ivy@mail.com","name":"Ivy","group":"English B1 – Tue/Thu","teacher_email":"sa-sub@x.com","unit":"sa-cat"},
  {"line":12,"email":"jo@mail.com","name":"Jo","unit":"sa-sede2"}]$j$, false);
select set_config('qs.prev', public.import_students(qs.inst('sa-sede1'), current_setting('qs.rows')::jsonb, false, false)::text, false);
select qs.eq('S: preview statuses per row', $$select string_agg((x->>'line')||':'||(x->>'status')||coalesce(':'||(x->>'code'),'')||coalesce('!'||(x->>'warning'),''), ',' order by (x->>'line')::int) from json_array_elements(current_setting('qs.prev')::json->'rows') x$$,
  '2:ok,3:error:bad_email,4:error:duplicate,5:new_group,6:new_group,7:error:unknown_teacher,8:error:unknown_unit,9:exists,10:error:missing_email,11:ok!teacher_ignored,12:error:unknown_unit');
select qs.eq('S: preview summary + the new group to create', $$select (current_setting('qs.prev')::json->>'ok')||'/'||(current_setting('qs.prev')::json->>'exists')||'/'||(current_setting('qs.prev')::json->>'errors')||'/'||(current_setting('qs.prev')::json->'new_groups')::text$$, '4/1/6/[{"name": "Math 2", "unit": "A Cát"}]');
reset role;
select qs.eq('S: preview writes nothing', $$select (select count(*) from public.student_enrollments where email in ('dan@mail.com','eve@mail.com'))::text||(select count(*) from public.class_groups where name = 'Math 2')::text$$, '00');
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.eq('S: commit without creating groups skips unknown-group rows', $$select string_agg((x->>'line')||':'||(x->>'status'), ',' order by (x->>'line')::int) from json_array_elements(public.import_students(qs.inst('sa-sede1'), current_setting('qs.rows')::jsonb, false, true)->'rows') x where (x->>'line')::int in (2,5,6)$$, '2:ok,5:error,6:error');
select qs.eq('S: commit creating groups', $$select public.import_students(qs.inst('sa-sede1'), current_setting('qs.rows')::jsonb, true, true)->>'committed'$$, 'true');
reset role;
select qs.eq('S: group created once with the teacher from the file', $$select count(*)||':'||max((teacher_id = qs.uid('sa-sub@x.com'))::text) from public.class_groups where name = 'Math 2'$$, '1:true');
select qs.eq('S: rows loaded (Dan, Ivy in B1; Eve, Fay in Math 2)', $$select string_agg(e.email||'@'||g.name, ',' order by e.email) from public.group_members m join public.student_enrollments e on e.id = m.enrollment_id join public.class_groups g on g.id = m.group_id where e.email in ('dan@mail.com','eve@mail.com','fay@mail.com','ivy@mail.com')$$,
  'dan@mail.com@English B1 – Tue/Thu,eve@mail.com@Math 2,fay@mail.com@Math 2,ivy@mail.com@English B1 – Tue/Thu');
select set_config('qs.cnt', (select (select count(*) from public.student_enrollments)||'/'||(select count(*) from public.group_members)||'/'||(select count(*) from public.class_groups)), false);
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.eq('S: re-import the same file → everything already there', $$select (x->>'ok')||'/'||(x->>'exists') from (select public.import_students(qs.inst('sa-sede1'), current_setting('qs.rows')::jsonb, true, true)::json as x) y$$, '0/5');
reset role;
select qs.eq('S: ...no duplicates created (idempotent)', $$select (select count(*) from public.student_enrollments)||'/'||(select count(*) from public.group_members)||'/'||(select count(*) from public.class_groups)$$, current_setting('qs.cnt'));
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.fails('S: more than 2000 rows refused', $$select public.import_students(qs.inst('sa-sede1'), (select jsonb_agg(jsonb_build_object('email', 'u'||g||'@mail.com')) from generate_series(1,2001) g), false, false)$$, 'máximo 2000');
select qs.fails('S: import into a sibling sede refused', $$select public.import_students(qs.inst('sa-sede2'), '[]', false, false)$$, 'No autorizado');
-- move / remove
select qs.eq('S: move a student between groups (other unit → copied into that unit)', $$select (public.move_student(qs.enr('sa-cat','dan@mail.com'), qs.grp('English B1 – Tue/Thu'), qs.grp('Spare group')) = qs.enr('sa-sede1','dan@mail.com'))::text$$, 'true');
select qs.eq('S: ...no longer in the old group', $$select count(*)::text from json_array_elements(public.list_group_members(qs.grp('English B1 – Tue/Thu'))) x where x->>'email' = 'dan@mail.com'$$, '0');
select qs.eq('S: remove from a group', $$select public.group_remove_student(qs.grp('Math 2'), qs.enr('sa-cat','fay@mail.com'))$$, 'removed');
select qs.eq('S: remove a student from the unit', $$select public.remove_student(qs.enr('sa-cat','fay@mail.com'))$$, 'removed');
reset role;
select qs.eq('S: seats still not consumed after importing', $$select qs.seats('sa-madre')::text$$, (current_setting('qs.seats0')::int + 1)::text);

-- ===== reassigning the teacher / a teacher leaving =====
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.fails('S: sede admin cannot assign a teacher from a sibling sede', $$select public.update_group(qs.grp('English B1 – Tue/Thu'), 'English B1 – Tue/Thu', qs.uid('sa-t2@x.com'), qs.uid('sa-sub@x.com'), 'America/Montevideo')$$, 'Docente no válido');
set role authenticated; select qs.as_user(qs.uid('sa-adm@x.com')::text);
select qs.eq('S: main admin reassigns the teacher', $$select (public.update_group(qs.grp('English B1 – Tue/Thu'), 'English B1 – Tue/Thu', qs.uid('sa-t2@x.com'), qs.uid('sa-sub@x.com'), 'America/Montevideo') is not null)::text$$, 'true');
set role authenticated; select qs.as_user(qs.uid('sa-t1@x.com')::text);
select qs.fails('S: the previous teacher loses access to the students', $$select public.list_group_members(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
select qs.fails('S: ...and to editing the group''s sessions', $$select public.cancel_session(current_setting('qs.now')::uuid)$$, 'No autorizado');
set role authenticated; select qs.as_user(qs.uid('sa-t2@x.com')::text);
select qs.eq('S: the new teacher has access', $$select (json_array_length(public.list_group_members(qs.grp('English B1 – Tue/Thu'))) > 0)::text$$, 'true');
set role authenticated; select qs.as_user(qs.uid('sa-s1adm@x.com')::text);
select qs.eq('S: substitute removed from the institution', $$select public.remove_member(qs.uid('sa-sub@x.com'))$$, 'removed');
set role authenticated; select qs.as_user(qs.uid('sa-sub@x.com')::text);
select qs.fails('S: ...no longer substitute: no access to the students', $$select public.list_group_members(qs.grp('English B1 – Tue/Thu'))$$, 'No autorizado');
select qs.eq('S: ...my_groups empty', $$select json_array_length(public.my_groups())::text$$, '0');
reset role;

-- ===== units with groups can't be deleted; insights only aggregate =====
set role authenticated; select qs.as_user(:'OWNER');
select public.create_institution('A Empty','sa-empty','',null,qs.inst('sa-sede2'));
select public.create_group(qs.inst('sa-empty'), 'Lonely group');
select qs.fails('S: unit with groups cannot be deleted', $$select public.delete_institution(qs.inst('sa-empty'))$$, 'grupos, estudiantes');
select public.delete_group(qs.grp('Lonely group'));
select qs.eq('S: ...after deleting the group it can', $$select public.delete_institution(qs.inst('sa-empty'))$$, 'deleted');
select qs.eq('S: insights: student totals (no names/emails)', $$select (x->>'total')||'/'||(x->>'linked')||'/'||(position('@' in x::text) = 0)::text from (select public.platform_insights(30, qs.inst('sa-madre'))->'students' as x) y$$, '8/1/true');
select qs.eq('S: platform stats count student accounts', $$select public.platform_stats()::jsonb->>'students'$$, '2');
reset role;

\echo '================ STUDENTS RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qs.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qs.results;
