-- Students (automatic student role) + monthly insight reports (001_base.sql "ALUMNOS + REPORTE MENSUAL").
-- Run after stub + 001_base.sql (alone or after the other suites: everything here uses its own "mr-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qm cascade;
create schema qm;
grant usage on schema qm to anon, authenticated, service_role;
create table qm.results(n serial, label text, ok boolean, detail text);
grant all on qm.results to anon, authenticated, service_role; grant all on sequence qm.results_n_seq to anon, authenticated, service_role;
create function qm.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
create function qm.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qm.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qm.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qm.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qm.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qm.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qm to anon, authenticated, service_role;
create function qm.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qm.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qm.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qm.enr(e text) returns uuid language sql security definer as $$ select id from public.student_enrollments where lower(email) = lower(e) order by created_at limit 1 $$;
create function qm.role(e text) returns text language sql security definer as $$ select role from public.profiles where id = qm.uid(e) $$;
create function qm.rep(e text) returns uuid language sql security definer as $$ select id from public.student_monthly_reports where enrollment_id = qm.enr(e) order by month desc limit 1 $$;
grant execute on function qm.inst(text), qm.uid(text), qm.grp(text), qm.enr(text), qm.role(text), qm.rep(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

set role authenticated; select qm.as_user(:'OWNER');
select qm.eq('M: superadmin creates two institutions', $$select (public.create_institution('MR Escuela','mr-esc','mr-adm@x.com') is not null
  and public.create_institution('MR Otra','mr-otra','mr-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('mr-esc','mr-otra') and not open_registration;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'mr-adm@x.com','{"name":"MR Admin"}',now()),
  (gen_random_uuid(),'mr-oadm@x.com','{"name":"MR Admin Otra"}',now()),
  (gen_random_uuid(),'mr-t1@x.com','{"org_slug":"mr-esc","name":"MR Teacher"}',now()),
  (gen_random_uuid(),'mr-t2@x.com','{"org_slug":"mr-esc","name":"MR Teacher Two"}',now()),
  (gen_random_uuid(),'mr-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'mr-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  -- signed up with email + password (no link): personal teacher accounts
  (gen_random_uuid(),'mr-self@x.com','{"name":"Self Student"}',now()),
  (gen_random_uuid(),'mr-selfplan@x.com','{"name":"Self Planner"}',now()),
  (gen_random_uuid(),'mr-real@x.com','{"name":"Real Teacher"}',now());

set role authenticated; select qm.as_user(qm.uid('mr-adm@x.com')::text);
select public.create_group(qm.inst('mr-esc'), 'MR G1', qm.uid('mr-t1@x.com'));
select public.create_group(qm.inst('mr-esc'), 'MR G2', qm.uid('mr-t2@x.com'));
select public.add_student(null, 'mr-st1@x.com', 'Ana Alonso', qm.grp('MR G1'));
select public.add_student(null, 'mr-st2@x.com', 'Beto Barrios', qm.grp('MR G1'));
select public.add_student(null, 'mr-self@x.com', 'Self Student', qm.grp('MR G1'));
select public.add_student(null, 'mr-selfplan@x.com', 'Self Planner', qm.grp('MR G2'));
select public.add_student(null, 'mr-t2@x.com', 'Teacher studying', qm.grp('MR G1'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and e.institution_id = qm.inst('mr-esc');
insert into public.plannings (owner_id, title) values (qm.uid('mr-selfplan@x.com'), 'Mine');
insert into public.individual_plans (user_id) values (qm.uid('mr-real@x.com'));

-- ===== automatic student role =====
select qm.eq('M: self sign-up starts as a personal teacher', $$select qm.role('mr-self@x.com')||'/'||coalesce((select institution_id::text from public.profiles where id = qm.uid('mr-self@x.com')), 'none')$$, 'teacher/none');
set role authenticated; select qm.as_user(qm.uid('mr-self@x.com')::text);
select qm.eq('M: claim_enrollments turns an unused personal teacher with enrollments into a student', $$select (public.claim_enrollments()::jsonb->>'became_student')||'/'||qm.role('mr-self@x.com')$$, 'true/student');
select qm.eq('M: running it again changes nothing', $$select (public.claim_enrollments()::jsonb->>'became_student')||'/'||(public.claim_enrollments()::jsonb->>'role')$$, 'false/student');
select qm.as_user(qm.uid('mr-selfplan@x.com')::text);
select qm.eq('M: a personal teacher who generated a class stays teacher', $$select (public.claim_enrollments()::jsonb->>'became_student')||'/'||qm.role('mr-selfplan@x.com')$$, 'false/teacher');
select qm.as_user(qm.uid('mr-real@x.com')::text);
select qm.eq('M: a personal teacher with an individual plan and no enrollments stays teacher', $$select (public.claim_enrollments()::jsonb->>'became_student')||'/'||qm.role('mr-real@x.com')$$, 'false/teacher');
select qm.as_user(qm.uid('mr-t2@x.com')::text);
select qm.eq('M: an institution teacher enrolled as a student stays teacher', $$select (public.claim_enrollments()::jsonb->>'became_student')||'/'||qm.role('mr-t2@x.com')$$, 'false/teacher');
reset role;

-- ===== classes + real / demo insights in October 2026 =====
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, x.d, x.d + interval '50 minutes', 'America/Montevideo', x.st
  from (values ('MR G1', 'MR oct 1', timestamptz '2026-10-06 18:00+00', 'scheduled'), ('MR G1', 'MR oct 2', timestamptz '2026-10-20 18:00+00', 'scheduled'),
               ('MR G1', 'MR oct 3', timestamptz '2026-10-27 18:00+00', 'scheduled'), ('MR G1', 'MR oct x', timestamptz '2026-10-13 18:00+00', 'cancelled'),
               ('MR G1', 'MR nov 1', timestamptz '2026-11-03 18:00+00', 'scheduled'),
               -- 31/10 21:30 in Montevideo = 1/11 00:30 UTC: belongs to OCTOBER (the class's own time zone)
               ('MR G1', 'MR oct late', timestamptz '2026-11-01 00:30+00', 'scheduled')) x(g, t, d, st)
  join public.class_groups g on g.name = x.g;
insert into public.student_insights (session_id, enrollment_id, data, is_demo)
select s.id, qm.enr(x.e), jsonb_build_object('kind','language','progress', jsonb_build_object('level', x.lv, 'score', x.sc, 'speakingMin', x.mn)), x.demo
  from (values ('MR oct 1','mr-st1@x.com','B1',70,20,false), ('MR oct 2','mr-st1@x.com','B1+',74,25,false), ('MR oct late','mr-st1@x.com','B1+',75,22,false),
               ('MR nov 1','mr-st1@x.com','B2',78,21,false), ('MR oct 1','mr-st2@x.com','A2',60,10,true)) x(t, e, lv, sc, mn, demo)
  join public.class_sessions s on s.title = x.t;
insert into public.session_attendance (session_id, enrollment_id, kind, auto_status)
select s.id, qm.enr('mr-st1@x.com'), 'student', 'present' from public.class_sessions s where s.title = 'MR oct 3';

-- ===== server only =====
set role authenticated; select qm.as_user(qm.uid('mr-st1@x.com')::text);
select qm.fails('M: a user cannot call monthly_report_work', $$select public.monthly_report_work('2026-10-01')$$, 'permission denied');
select qm.fails('M: a user cannot store a report', $$select public.monthly_report_store(qm.enr('mr-st1@x.com'), '2026-10-01', '{}'::jsonb)$$, 'permission denied');
reset role; set role service_role;
select qm.eq('M: work lists only students with REAL insights that month (demo-only excluded)',
  $$select string_agg(x->>'name', ',') from json_array_elements(public.monthly_report_work('2026-10-15')) x where (x->>'name') like '%Alonso%' or (x->>'name') like '%Barrios%'$$, 'Ana Alonso');
select qm.eq('M: the month uses the class time zone (31/10 21:30 Montevideo is October); November excluded',
  $$select json_array_length(x->'insights')::text||'/'||(x->'insights'->2->>'title') from json_array_elements(public.monthly_report_work('2026-10-01')) x where x->>'name' = 'Ana Alonso'$$, '3/MR oct late');
select qm.eq('M: scheduled (ended, not cancelled) and attended (attendance or insights)',
  $$select (x->>'scheduled')||'/'||(x->>'attended') from json_array_elements(public.monthly_report_work('2026-10-01')) x where x->>'name' = 'Ana Alonso'$$, '4/4');
select qm.eq('M: store creates the report', $$select public.monthly_report_store(qm.enr('mr-st1@x.com'), '2026-10-09', '{"summary":"Good month","classes":3,"attended":4,"scheduled":4,"levelStart":"B1","levelEnd":"B1+","speakingMin":67,"vocab":[{"word":"budget"}]}'::jsonb, 'gpt-4o')::jsonb->>'created'$$, 'true');
select qm.eq('M: storing again keeps the first one (idempotent)', $$select (public.monthly_report_store(qm.enr('mr-st1@x.com'), '2026-10-01', '{"summary":"Other"}'::jsonb)::jsonb->>'created')$$, 'false');
reset role;
select qm.eq('M: ... and the first data stays', $$select data->>'summary' from public.student_monthly_reports where enrollment_id = qm.enr('mr-st1@x.com')$$, 'Good month');
set role service_role;
select qm.eq('M: once stored, the student leaves the work list', $$select count(*)::text from json_array_elements(public.monthly_report_work('2026-10-01')) x where x->>'name' = 'Ana Alonso'$$, '0');
select qm.fails('M: invalid data refused', $$select public.monthly_report_store(qm.enr('mr-st2@x.com'), '2026-10-01', '[1]'::jsonb)$$, 'Reporte inválido');
reset role;

-- ===== who sees it =====
set role authenticated; select qm.as_user(qm.uid('mr-st1@x.com')::text);
select qm.eq('M: the student lists their report (summary, month, counts)', $$select (x->>'month')||'/'||(x->>'summary')||'/'||(x->>'classes')||'/'||(x->>'words')||'/'||(x->>'has_message') from json_array_elements(public.my_monthly_reports()) x$$, '2026-10-01/Good month/3/1/false');
select qm.eq('M: the student opens it', $$select (public.monthly_report(qm.rep('mr-st1@x.com'))::jsonb->>'can_edit')$$, 'false');
select qm.fails('M: the student cannot write the teacher message', $$select public.save_monthly_message(qm.rep('mr-st1@x.com'), 'hi')$$, 'No autorizado');
select qm.fails('M: View-as argument only for the super admin', $$select public.my_monthly_reports(qm.enr('mr-st1@x.com'))$$, 'No autorizado');
select qm.as_user(qm.uid('mr-st2@x.com')::text);
select qm.eq('M: another student sees none', $$select json_array_length(public.my_monthly_reports())::text$$, '0');
select qm.fails('M: another student cannot open it', $$select public.monthly_report(qm.rep('mr-st1@x.com'))$$, 'No autorizado');
select qm.as_user(qm.uid('mr-t1@x.com')::text);
select qm.eq('M: the group teacher lists it and can edit', $$select (select count(*) from json_array_elements(public.teacher_monthly_reports('2026-10-20')))::text||'/'||(public.monthly_report(qm.rep('mr-st1@x.com'))::jsonb->>'can_edit')$$, '1/true');
select qm.eq('M: the teacher adds a message', $$select public.save_monthly_message(qm.rep('mr-st1@x.com'), '  Great work!  ')::jsonb->>'message'$$, 'Great work!');
select qm.fails('M: message over 4000 characters refused', $$select public.save_monthly_message(qm.rep('mr-st1@x.com'), repeat('x', 4001))$$, 'demasiado largo');
select qm.as_user(qm.uid('mr-t2@x.com')::text);
select qm.eq('M: a teacher of another group sees none', $$select json_array_length(public.teacher_monthly_reports())::text$$, '0');
select qm.fails('M: and cannot open it', $$select public.monthly_report(qm.rep('mr-st1@x.com'))$$, 'No autorizado');
select qm.as_user(qm.uid('mr-adm@x.com')::text);
select qm.fails('M: the institution admin does not see it (student + teacher only)', $$select public.monthly_report(qm.rep('mr-st1@x.com'))$$, 'No autorizado');
select qm.as_user(qm.uid('mr-st1@x.com')::text);
select qm.eq('M: the student sees the teacher message', $$select (x->>'message')||'/'||(x->>'message_by') from (select public.monthly_report(qm.rep('mr-st1@x.com'))::jsonb x) y$$, 'Great work!/MR Teacher');
select qm.as_user(qm.uid('mr-t1@x.com')::text);
select qm.eq('M: an empty message removes it', $$select public.save_monthly_message(qm.rep('mr-st1@x.com'), '')::jsonb->>'message'$$, '');
select qm.eq('M: ... and the list says no message', $$select (x->>'has_message') from json_array_elements(public.teacher_monthly_reports()) x limit 1$$, 'false');
select qm.as_user(:'OWNER');
select qm.eq('M: super admin (View as) reads the student list', $$select json_array_length(public.my_monthly_reports(qm.enr('mr-st1@x.com')))::text$$, '1');
reset role;
set role anon; select qm.as_user('');
select qm.fails('M: anon cannot list', $$select public.my_monthly_reports()$$, 'permission denied');
reset role;

\echo '================ MONTHLY REPORT RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qm.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qm.results;
