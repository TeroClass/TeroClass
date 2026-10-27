-- Class insights (teacher report + per-student insights, demo generation): privacy rules and idempotency.
-- Run after stub + 001_base.sql (alone or after the other suites: everything here uses its own "ci-" units).
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
create function qc.ins(t text, e text) returns uuid language sql security definer as
$$ select si.id from public.student_insights si where si.session_id = (select id from public.class_sessions where title = t order by created_at limit 1) and si.enrollment_id = qc.enr(e) $$;
create function qc.cnt(t text) returns text language sql security definer as
$$ select (select count(*) from public.teacher_insights where session_id = qc.sess(t))||'/'||(select count(*) from public.student_insights where session_id = qc.sess(t)) $$;
-- demo payload as the app builds it (n student variants)
create function qc.payload(n int default 2, k text default 'language') returns jsonb language sql as $$
  select jsonb_build_object('kind', k, 'lang', 'en', 'subject', 'English · B1', 'title', 'Making plans',
    'recap', jsonb_build_object('summary', 'We practised future forms.', 'topics', '[]'::jsonb),
    'teacher', jsonb_build_object('objective', 'Talk about plans', 'observation_focus', 'Student talk time',
                                  'form', jsonb_build_object('evidence', 'Teacher talk 52% (23 min)')),
    'students', (select coalesce(jsonb_agg(jsonb_build_object('highlight', 'Variant ' || g)), '[]'::jsonb) from generate_series(1, n) g)) $$;
grant execute on function qc.inst(text), qc.uid(text), qc.grp(text), qc.enr(text), qc.sess(text), qc.ins(text,text), qc.cnt(text), qc.payload(int,text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: CI Madre › CI Sede 1 ; CI Madre › CI Sede 2 ; CI Otra =====
set role authenticated; select qc.as_user(:'OWNER');
select qc.eq('C: superadmin creates the tree', $$select (public.create_institution('CI Madre','ci-madre','ci-adm@x.com') is not null
  and public.create_institution('CI Sede 1','ci-s1','ci-s1adm@x.com',null,qc.inst('ci-madre')) is not null
  and public.create_institution('CI Sede 2','ci-s2','ci-s2adm@x.com',null,qc.inst('ci-madre')) is not null
  and public.create_institution('CI Otra','ci-otra','ci-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('ci-otra','ci-s1','ci-s2') and not open_registration; -- 2026-10: sign-up by link is off by default (TC-02); opened explicitly here
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'ci-adm@x.com','{"name":"CI Admin"}',now()),
  (gen_random_uuid(),'ci-s1adm@x.com','{"name":"CI Admin S1"}',now()),
  (gen_random_uuid(),'ci-s2adm@x.com','{"name":"CI Admin S2"}',now()),
  (gen_random_uuid(),'ci-oadm@x.com','{"name":"CI Admin Otra"}',now()),
  (gen_random_uuid(),'ci-t1@x.com','{"org_slug":"ci-s1","name":"CI Teacher One"}',now()),
  (gen_random_uuid(),'ci-sub@x.com','{"org_slug":"ci-s1","name":"CI Sub"}',now()),
  (gen_random_uuid(),'ci-t2@x.com','{"org_slug":"ci-s2","name":"CI Teacher Two"}',now()),
  (gen_random_uuid(),'ci-to@x.com','{"org_slug":"ci-otra","name":"CI Teacher Otra"}',now()),
  (gen_random_uuid(),'ci-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'ci-st2@x.com','{"via":"student_link","name":"Beto"}',now());

set role authenticated; select qc.as_user(qc.uid('ci-adm@x.com')::text);
select public.create_group(qc.inst('ci-s1'), 'CI G1', qc.uid('ci-t1@x.com'), qc.uid('ci-sub@x.com'));
select public.create_group(qc.inst('ci-s2'), 'CI G2', qc.uid('ci-t2@x.com'));
select public.add_student(null, 'ci-st1@x.com', 'Ana Alonso', qc.grp('CI G1'));
select public.add_student(null, 'ci-st2@x.com', 'Beto Barrios', qc.grp('CI G1'));
select public.add_student(null, 'ci-st3@x.com', 'Caro Castro', qc.grp('CI G1'));
select public.add_student(null, 'ci-st4@x.com', 'Dani Díaz', qc.grp('CI G2'));
set role authenticated; select qc.as_user(qc.uid('ci-oadm@x.com')::text);
select public.create_group(qc.inst('ci-otra'), 'CI GO', qc.uid('ci-to@x.com'));
select public.add_student(null, 'ci-st1@x.com', 'Ana (Otra)', qc.grp('CI GO'));
reset role;
-- student accounts linked to their enrollments (as claim_enrollments does after an email link)
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('ci-st1@x.com','ci-st2@x.com');
-- classes: past, future, cancelled (inserted directly: the RPCs only create current/future classes)
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, now() + x.d, now() + x.d + interval '45 minutes', 'America/Montevideo', x.st
  from (values ('CI G1', 'CI G1 past', interval '-2 days', 'scheduled'), ('CI G1', 'CI G1 future', interval '3 days', 'scheduled'),
               ('CI G1', 'CI G1 cancelled', interval '-3 days', 'cancelled'), ('CI G1', 'CI G1 older', interval '-20 days', 'scheduled'),
               ('CI G2', 'CI G2 past', interval '-1 days', 'scheduled'), ('CI GO', 'CI GO past', interval '-1 days', 'scheduled')) x(g, t, d, st)
  join public.class_groups g on g.name = x.g;
-- a one-off class today by teacher one, inviting a new email
set role authenticated; select qc.as_user(qc.uid('ci-t1@x.com')::text);
select public.create_session(null, 'CI one-off', now() - interval '2 hours', 60, 'America/Montevideo', array['ci-guest@x.com']);

-- ===== demo generation: who, when, idempotent =====
select qc.eq('C: teacher generates demo insights for a past class (1 report + 3 students)',
  $$select (x->>'teacher_created')||'/'||(x->>'students_created')||'/'||(x->>'students') from (select public.generate_demo_insights(qc.sess('CI G1 past'), qc.payload(2))::jsonb x) y$$, 'true/3/3');
select qc.eq('C: generating again creates nothing (idempotent)',
  $$select (x->>'teacher_created')||'/'||(x->>'students_created')||'/'||(x->>'students') from (select public.generate_demo_insights(qc.sess('CI G1 past'), qc.payload(5))::jsonb x) y$$, 'false/0/3');
select qc.eq('C: one-off class of today (invited guest)', $$select public.generate_demo_insights(qc.sess('CI one-off'), qc.payload(1))::jsonb->>'students_created'$$, '1');
select qc.fails('C: future class refused', $$select public.generate_demo_insights(qc.sess('CI G1 future'), qc.payload())$$, 'hoy o anteriores');
select qc.fails('C: cancelled class refused', $$select public.generate_demo_insights(qc.sess('CI G1 cancelled'), qc.payload())$$, 'cancelada');
select qc.fails('C: teacher cannot generate for another group (sede 2)', $$select public.generate_demo_insights(qc.sess('CI G2 past'), qc.payload())$$, 'No autorizado');
select qc.fails('C: invalid payload: no students', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload(0))$$, 'Datos de demo inválidos');
select qc.fails('C: invalid payload: too many variants', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload(30))$$, 'Datos de demo inválidos');
select qc.fails('C: invalid payload: unknown kind', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload(2, 'poetry'))$$, 'Datos de demo inválidos');
select qc.fails('C: invalid payload: not an object', $$select public.generate_demo_insights(qc.sess('CI G1 older'), '[1,2]'::jsonb)$$, 'Datos de demo inválidos');
select qc.fails('C: unknown class', $$select public.generate_demo_insights(gen_random_uuid(), qc.payload())$$, 'No autorizado');
reset role;
select qc.eq('C: rows are flagged demo; variants assigned in name order', $$select string_agg((si.is_demo)::text||':'||(si.data->>'highlight')||':'||(si.data->>'kind'), ',' order by e.name)
  from public.student_insights si join public.student_enrollments e on e.id = si.enrollment_id where si.session_id = qc.sess('CI G1 past')$$, 'true:Variant 1:language,true:Variant 2:language,true:Variant 1:language');
select qc.eq('C: report stored once, demo, with recap; no names or emails inside the data', $$select qc.cnt('CI G1 past')||'/'||(ti.is_demo)::text||'/'||(ti.data ? 'recap')::text||'/'||(position('@' in ti.data::text) = 0 and position('Ana' in ti.data::text) = 0)::text
  from public.teacher_insights ti where ti.session_id = qc.sess('CI G1 past')$$, '1/3/true/true/true');
set role authenticated; select qc.as_user(qc.uid('ci-sub@x.com')::text);
select qc.eq('C: substitute can generate (idempotent: nothing new)', $$select public.generate_demo_insights(qc.sess('CI G1 past'), qc.payload())::jsonb->>'students_created'$$, '0');
select qc.as_user(qc.uid('ci-s2adm@x.com')::text);
select qc.fails('C: sibling sede admin cannot generate for sede 1', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload())$$, 'No autorizado');
select qc.eq('C: sede admin generates for their own unit', $$select public.generate_demo_insights(qc.sess('CI G2 past'), qc.payload(3, 'discipline'))::jsonb->>'students_created'$$, '1');
select qc.as_user(qc.uid('ci-oadm@x.com')::text);
select qc.fails('C: admin of another institution cannot generate', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload())$$, 'No autorizado');
select qc.as_user(qc.uid('ci-st1@x.com')::text);
select qc.fails('C: a student cannot generate', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload())$$, 'No autorizado');
select qc.as_user(qc.uid('ci-to@x.com')::text);
select qc.fails('C: teacher of another institution cannot generate', $$select public.generate_demo_insights(qc.sess('CI G1 older'), qc.payload())$$, 'No autorizado');
-- a student who joins the group later gets their row on the next call
select qc.as_user(qc.uid('ci-adm@x.com')::text);
select public.add_student(null, 'ci-st5@x.com', 'Eli Estévez', qc.grp('CI G1'));
select qc.eq('C: madre admin regenerates: only the new student is added', $$select public.generate_demo_insights(qc.sess('CI G1 past'), qc.payload())::jsonb->>'students_created'$$, '1');
reset role;
select qc.eq('C: no duplicates after all calls (1 report, 4 students)', $$select qc.cnt('CI G1 past')$$, '1/4');

-- ===== who sees a class's insights =====
set role authenticated; select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.eq('C: teacher sees the report and the 4 students (names, never emails), can edit', $$select (x->'teacher'->>'is_demo')||'/'||json_array_length(x->'students')||'/'||(x->>'can_edit')||'/'||(x->>'role')||'/'||
  (select string_agg(s->>'name', ',') from json_array_elements(x->'students') s)||'/'||(position('@' in (x->'students')::text) = 0)::text
  from (select public.get_session_insights(qc.sess('CI G1 past')) x) y$$, 'true/4/true/teacher/Ana Alonso,Beto Barrios,Caro Castro,Eli Estévez/true');
select qc.eq('C: header: group, unit, teacher name, duration, students total', $$select (x->'session'->>'group_name')||'/'||(x->'session'->>'unit_name')||'/'||(x->'session'->>'teacher_name')||'/'||(x->'session'->>'duration_min')||'/'||(x->'session'->>'students_total')
  from (select public.get_session_insights(qc.sess('CI G1 past')) x) y$$, 'CI G1/CI Sede 1/CI Teacher One/45/4');
select qc.fails('C: teacher cannot open a class of another group', $$select public.get_session_insights(qc.sess('CI G2 past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ci-sub@x.com')::text);
select qc.eq('C: substitute sees it too (role substitute, can edit)', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.get_session_insights(qc.sess('CI G1 past')) x) y$$, 'substitute/true');
select qc.as_user(qc.uid('ci-t2@x.com')::text);
select qc.fails('C: teacher of a sibling sede cannot open it', $$select public.get_session_insights(qc.sess('CI G1 past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ci-s1adm@x.com')::text);
select qc.eq('C: unit admin sees it read-only (role admin)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||json_array_length(x->'students') from (select public.get_session_insights(qc.sess('CI G1 past')) x) y$$, 'admin/false/4');
select qc.fails('C: sede 1 admin cannot open sede 2', $$select public.get_session_insights(qc.sess('CI G2 past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ci-oadm@x.com')::text);
select qc.fails('C: admin of another institution cannot open it', $$select public.get_session_insights(qc.sess('CI G1 past'))$$, 'No autorizado');
select qc.as_user(qc.uid('ci-st1@x.com')::text);
select qc.fails('C: student cannot open the class view (other students + report)', $$select public.get_session_insights(qc.sess('CI G1 past'))$$, 'No autorizado');
select qc.as_user(:'OWNER');
select qc.eq('C: superadmin sees every class', $$select json_array_length(public.get_session_insights(qc.sess('CI G2 past'))->'students')::text$$, '1');
select qc.fails('C: direct select on student_insights denied', $$select count(*) from public.student_insights$$, 'permission denied');
select qc.fails('C: direct select on teacher_insights denied', $$select count(*) from public.teacher_insights$$, 'permission denied');
select qc.fails('C: direct update on student_insights denied', $$update public.student_insights set published_at = now()$$, 'permission denied');

-- ===== teacher reflection: teacher writes; admins read; students never =====
select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.eq('C: teacher saves the reflection', $$select public.save_teacher_reflection(qc.sess('CI G1 past'), E'Wait longer after questions.\nUse pair work.')::jsonb->>'reflection'$$, E'Wait longer after questions.\nUse pair work.');
select qc.fails('C: no report yet → clear error', $$select public.save_teacher_reflection(qc.sess('CI G1 older'), 'x')$$, 'Todavía no hay insights');
select qc.as_user(qc.uid('ci-sub@x.com')::text);
select qc.eq('C: substitute can edit the reflection too', $$select length(public.save_teacher_reflection(qc.sess('CI G1 past'), 'SECRET-REFLECTION by the substitute')::jsonb->>'reflection')::text$$, '35');
select qc.as_user(qc.uid('ci-s1adm@x.com')::text);
select qc.eq('C: unit admin reads the reflection', $$select public.get_session_insights(qc.sess('CI G1 past'))->'teacher'->>'reflection'$$, 'SECRET-REFLECTION by the substitute');
select qc.fails('C: admin cannot write the reflection', $$select public.save_teacher_reflection(qc.sess('CI G1 past'), 'x')$$, 'No autorizado');
select qc.as_user(qc.uid('ci-t2@x.com')::text);
select qc.fails('C: another teacher cannot write it', $$select public.save_teacher_reflection(qc.sess('CI G1 past'), 'x')$$, 'No autorizado');
select qc.as_user(qc.uid('ci-st1@x.com')::text);
select qc.fails('C: student cannot write it', $$select public.save_teacher_reflection(qc.sess('CI G1 past'), 'x')$$, 'No autorizado');

-- ===== message to the student: draft (private) → publish (the student sees it) =====
select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.eq('C: teacher saves a draft', $$select (x->>'teacher_message')||'/'||coalesce(x->>'published_at','null') from (select public.save_insight_message(qc.ins('CI G1 past','ci-st1@x.com'), 'DRAFT-1 for Ana', false)::jsonb x) y$$, 'DRAFT-1 for Ana/null');
select qc.as_user(qc.uid('ci-st1@x.com')::text);
select qc.eq('C: the student does not see an unpublished draft', $$select (x->>'message')||'/'||coalesce(x->>'published_at','null')||'/'||(position('DRAFT-1' in x::text) = 0)::text from (select public.my_insight(qc.ins('CI G1 past','ci-st1@x.com')) x) y$$, '/null/true');
select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.fails('C: publishing an empty message refused', $$select public.save_insight_message(qc.ins('CI G1 past','ci-st1@x.com'), '   ', true)$$, 'Escribí un mensaje');
select qc.eq('C: teacher publishes', $$select (x->>'published_message')||'/'||(x->>'published_at' is not null)::text from (select public.save_insight_message(qc.ins('CI G1 past','ci-st1@x.com'), 'Great work, Ana!', true)::jsonb x) y$$, 'Great work, Ana!/true');
select qc.eq('C: a later draft does not change what the student sees', $$select (x->>'teacher_message')||'/'||(x->>'published_message') from (select public.save_insight_message(qc.ins('CI G1 past','ci-st1@x.com'), 'DRAFT-2 unpublished', false)::jsonb x) y$$, 'DRAFT-2 unpublished/Great work, Ana!');
select qc.as_user(qc.uid('ci-s1adm@x.com')::text);
select qc.fails('C: admin cannot write messages (read-only)', $$select public.save_insight_message(qc.ins('CI G1 past','ci-st2@x.com'), 'x', true)$$, 'No autorizado');
select qc.as_user(qc.uid('ci-t2@x.com')::text);
select qc.fails('C: another teacher cannot write messages', $$select public.save_insight_message(qc.ins('CI G1 past','ci-st2@x.com'), 'x', true)$$, 'No autorizado');
select qc.as_user(qc.uid('ci-st2@x.com')::text);
select qc.fails('C: a student cannot write messages', $$select public.save_insight_message(qc.ins('CI G1 past','ci-st2@x.com'), 'x', true)$$, 'No autorizado');

-- ===== the student: only their own insights and their own published message =====
select qc.as_user(qc.uid('ci-st1@x.com')::text);
select qc.eq('C: student list = own insights only (1), message flag on', $$select json_array_length(x)||'/'||(x->0->>'title')||'/'||(x->0->>'has_message')||'/'||(x->0->>'is_demo') from (select public.my_insights() x) y$$, '1/CI G1 past/true/true');
select qc.eq('C: student sees the published message, never the draft nor the reflection', $$select (x->>'message')||'/'||(position('DRAFT-2' in x::text) = 0)::text||'/'||(position('SECRET-REFLECTION' in x::text) = 0)::text||'/'||(x ? 'teacher_message')::text
  from (select public.my_insight(qc.ins('CI G1 past','ci-st1@x.com'))::jsonb x) y$$, 'Great work, Ana!/true/true/false');
select qc.eq('C: student detail: own data + session header, no classmates, no emails', $$select (x->'data'->>'highlight')||'/'||(x->'session'->>'teacher_name')||'/'||(position('Beto' in x::text) = 0)::text||'/'||(position('@' in x::text) = 0)::text
  from (select public.my_insight(qc.ins('CI G1 past','ci-st1@x.com'))::jsonb x) y$$, 'Variant 1/CI Teacher One/true/true');
select qc.fails('C: student cannot open a classmate''s insight', $$select public.my_insight(qc.ins('CI G1 past','ci-st2@x.com'))$$, 'No autorizado');
select qc.fails('C: student cannot use the View-as parameter', $$select public.my_insights(null, qc.enr('ci-st2@x.com'))$$, 'No autorizado');
select qc.fails('C: student cannot list unit insights', $$select public.list_insight_sessions(qc.inst('ci-s1'), false)$$, 'No autorizado');
select qc.eq('C: student has no teaching sessions', $$select json_array_length(public.list_insight_sessions()->'sessions')::text$$, '0');
select qc.eq('C: student dashboard (student_view) lists own insights, without emails', $$select json_array_length(x->'insights')||'/'||(position('@' in (x->'insights')::text) = 0)::text from (select public.student_view() x) y$$, '1/true');
select qc.as_user(qc.uid('ci-st2@x.com')::text);
select qc.eq('C: classmate sees an empty message (not published to them)', $$select coalesce(public.my_insight(qc.ins('CI G1 past','ci-st2@x.com'))->>'message', 'null')$$, '');
select qc.fails('C: classmate cannot open Ana''s insight', $$select public.my_insight(qc.ins('CI G1 past','ci-st1@x.com'))$$, 'No autorizado');
select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.fails('C: a teacher cannot read through the student RPC', $$select public.my_insight(qc.ins('CI G1 past','ci-st1@x.com'))$$, 'No autorizado');
select qc.as_user(:'OWNER');
select qc.eq('C: superadmin View as Student (enrollment) sees exactly that student', $$select json_array_length(public.my_insights(null, qc.enr('ci-st1@x.com')))||'/'||(public.my_insight(qc.ins('CI G1 past','ci-st1@x.com'), qc.enr('ci-st1@x.com'))->>'message')$$, '1/Great work, Ana!');
select qc.fails('C: View as Student: another student''s insight refused', $$select public.my_insight(qc.ins('CI G1 past','ci-st2@x.com'), qc.enr('ci-st1@x.com'))$$, 'No autorizado');
select qc.eq('C: View as a generic student of a group: no own insights', $$select json_array_length(public.my_insights(qc.grp('CI G1'), null))::text$$, '0');

-- ===== lists: teacher (mine), admin (unit subtree), superadmin (all), filters =====
select qc.as_user(qc.uid('ci-t1@x.com')::text);
select qc.eq('C: teacher list: classes with insights, newest first', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions()->'sessions') s$$, 'CI one-off,CI G1 past');
select qc.eq('C: teacher pending: recent past/today classes without insights (no future, no cancelled)', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions()->'pending') s$$, 'CI G1 older');
select qc.eq('C: teacher list entry: counts, demo flag, reflection flag, role', $$select (s->>'students')||'/'||(s->>'published')||'/'||(s->>'is_demo')||'/'||(s->>'has_reflection')||'/'||(s->>'role') from json_array_elements(public.list_insight_sessions()->'sessions') s where s->>'title' = 'CI G1 past'$$, '4/1/true/true/teacher');
select qc.eq('C: teacher search by student name', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(null, true, null, null, null, null, 'beto')->'sessions') s$$, 'CI G1 past');
select qc.eq('C: teacher search by guest email', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(null, true, null, null, null, null, 'guest@')->'sessions') s$$, 'CI one-off');
select qc.eq('C: search with LIKE wildcards is literal', $$select json_array_length(public.list_insight_sessions(null, true, null, null, null, null, '%')->'sessions')::text$$, '0');
select qc.eq('C: date range filter', $$select json_array_length(public.list_insight_sessions(null, true, null, null, (now() at time zone 'America/Montevideo')::date - 30, (now() at time zone 'America/Montevideo')::date - 2)->'sessions')::text$$, '1');
select qc.eq('C: teacher groups for the filter = their groups; no teacher list', $$select (select string_agg(g->>'name', ',') from json_array_elements(x->'groups') g)||'/'||json_array_length(x->'teachers') from (select public.list_insight_sessions() x) y$$, 'CI G1/0');
select qc.fails('C: teacher cannot list a unit as admin', $$select public.list_insight_sessions(qc.inst('ci-s1'), false)$$, 'No autorizado');
select qc.fails('C: teacher cannot list everything', $$select public.list_insight_sessions(null, false)$$, 'No autorizado');
select qc.as_user(qc.uid('ci-t2@x.com')::text);
select qc.eq('C: teacher two sees only their class', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions()->'sessions') s$$, 'CI G2 past');
select qc.as_user(qc.uid('ci-s1adm@x.com')::text);
select qc.eq('C: sede 1 admin: only sede 1 classes', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(qc.inst('ci-s1'), false)->'sessions') s$$, 'CI one-off,CI G1 past');
select qc.fails('C: sede 1 admin cannot list sede 2', $$select public.list_insight_sessions(qc.inst('ci-s2'), false)$$, 'No autorizado');
select qc.fails('C: sede 1 admin cannot list the main institution', $$select public.list_insight_sessions(qc.inst('ci-madre'), false)$$, 'No autorizado');
select qc.fails('C: sede admin cannot list everything', $$select public.list_insight_sessions(null, false)$$, 'No autorizado');
select qc.as_user(qc.uid('ci-adm@x.com')::text);
select qc.eq('C: madre admin: whole subtree, newest first', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(qc.inst('ci-madre'), false)->'sessions') s$$, 'CI one-off,CI G2 past,CI G1 past');
select qc.eq('C: madre admin never sees the other institution', $$select (position('CI GO' in public.list_insight_sessions(qc.inst('ci-madre'), false)::text) = 0)::text$$, 'true');
select qc.eq('C: filter by group', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(qc.inst('ci-madre'), false, qc.grp('CI G2'))->'sessions') s$$, 'CI G2 past');
select qc.eq('C: filter by teacher (substitute counts)', $$select string_agg(s->>'title', ',') from json_array_elements(public.list_insight_sessions(qc.inst('ci-madre'), false, null, qc.uid('ci-sub@x.com'))->'sessions') s$$, 'CI G1 past');
select qc.eq('C: teachers for the filter (names, no emails)', $$select (select string_agg(t->>'name', ',') from json_array_elements(x->'teachers') t)||'/'||(position('@' in x::text) = 0)::text from (select public.list_insight_sessions(qc.inst('ci-madre'), false) x) y$$, 'CI Sub,CI Teacher One,CI Teacher Two/true');
select qc.eq('C: admin list entries are role admin', $$select string_agg(distinct s->>'role', ',') from json_array_elements(public.list_insight_sessions(qc.inst('ci-madre'), false)->'sessions') s$$, 'admin');
select qc.as_user(qc.uid('ci-oadm@x.com')::text);
select qc.eq('C: other institution admin: nothing of CI Madre', $$select (position('CI G1' in public.list_insight_sessions(qc.inst('ci-otra'), false)::text) = 0)::text$$, 'true');
select qc.as_user(:'OWNER');
select qc.eq('C: superadmin All: every institution', $$select (select count(*) from json_array_elements(public.list_insight_sessions(null, false)->'sessions') s where s->>'title' like 'CI %')::text$$, '3');
select qc.eq('C: Metrics (platform_insights) counts classes with insights, totals only', $$select public.platform_insights(30, qc.inst('ci-madre'))->'students'->>'insight_sessions'$$, '3');

-- ===== access follows the group: a teacher removed from the group loses access =====
reset role;
update public.class_groups set substitute_id = null where name = 'CI G1';
set role authenticated; select qc.as_user(qc.uid('ci-sub@x.com')::text);
select qc.fails('C: former substitute loses access', $$select public.get_session_insights(qc.sess('CI G1 past'))$$, 'No autorizado');
select qc.eq('C: ...and the class leaves their list', $$select json_array_length(public.list_insight_sessions()->'sessions')::text$$, '0');
reset role;
update public.class_groups set substitute_id = qc.uid('ci-sub@x.com') where name = 'CI G1';
-- removing a student from the unit removes their insights
set role authenticated; select qc.as_user(qc.uid('ci-adm@x.com')::text);
select public.remove_student(qc.enr('ci-st5@x.com'));
reset role;
select qc.eq('C: removed student''s insight deleted with the enrollment', $$select qc.cnt('CI G1 past')$$, '1/3');

-- ===== anon =====
set role anon; select qc.as_user('');
select qc.fails('C: anon cannot call generate', $$select public.generate_demo_insights(qc.sess('CI G1 past'), qc.payload())$$, 'permission denied');
select qc.fails('C: anon cannot list', $$select public.list_insight_sessions()$$, 'permission denied');
select qc.fails('C: anon cannot read a student insight', $$select public.my_insights()$$, 'permission denied');
reset role;

\echo '================ CLASS INSIGHTS RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qc.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qc.results;
