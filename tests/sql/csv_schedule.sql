-- CSV import with schedules: preview per group (teacher status, classes, conflicts), commit (groups → teacher /
-- substitute → enrollments → weekly series), idempotent re-import, schedule changes (only future, not individually
-- edited), pending teachers (invitation + auto-assign on registration), pending emails privacy, seats, the manual
-- "Edit group" pending path. Run after stub + 001_base.sql (alone or after the other suites; own slugs sc-*/sd-*).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qc cascade;
create schema qc;
grant usage on schema qc to anon, authenticated, service_role;
create table qc.results(n serial, label text, ok boolean, detail text);
grant all on qc.results to anon, authenticated, service_role; grant all on sequence qc.results_n_seq to anon, authenticated, service_role;
create function qc.as_user(u text, amr text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u, ''), false);
  perform set_config('request.jwt.claims', case when amr is null then '' else json_build_object('sub', u, 'amr', json_build_array(json_build_object('method', amr, 'timestamp', 1)))::text end, false);
end $$;
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
create function qc.d(n int) returns text language sql stable as $$ select ((now() at time zone 'America/Montevideo')::date + n)::text $$;
-- number of dates with these ISO weekdays in [today+a, today+b]
create function qc.ndays(days int[], a int, b int) returns text language sql stable as
$$ select count(*)::text from generate_series(qc.d(a)::date, qc.d(b)::date, interval '1 day') g where extract(isodow from g)::int = any(days) $$;
create function qc.pick(j text, gname text) returns jsonb language sql immutable as
$$ select g from jsonb_array_elements(j::jsonb->'groups') g where g->>'name' = gname limit 1 $$;
create function qc.rows(j text) returns text language sql immutable as
$$ select string_agg((x->>'line')||':'||(x->>'status')||coalesce(':'||(x->>'code'),'')||coalesce('('||(x->>'field')||')',''), ',' order by (x->>'line')::int) from jsonb_array_elements(j::jsonb->'rows') x $$;
create function qc.counts() returns text language sql security definer as
$$ select (select count(*) from public.class_groups g join public.institutions i on i.id = g.institution_id where i.slug like 'sc-%')||'/'
       || (select count(*) from public.student_enrollments e join public.institutions i on i.id = e.institution_id where i.slug like 'sc-%')||'/'
       || (select count(*) from public.group_members m join public.class_groups g on g.id = m.group_id join public.institutions i on i.id = g.institution_id where i.slug like 'sc-%')||'/'
       || (select count(*) from public.class_sessions s join public.institutions i on i.id = s.institution_id where i.slug like 'sc-%')||'/'
       || (select count(*) from public.session_series ss join public.class_groups g on g.id = ss.group_id join public.institutions i on i.id = g.institution_id where i.slug like 'sc-%')||'/'
       || (select count(*) from public.invitations iv join public.institutions i on i.id = iv.institution_id where i.slug like 'sc-%' and iv.role = 'teacher') $$;
grant execute on all functions in schema qc to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: C Madre › C Sede, C Sede 2 ; D Madre (another institution) =====
set role authenticated; select qc.as_user(:'OWNER');
select qc.eq('C: superadmin creates the tree', $$select (public.create_institution('C Madre','sc-madre','sc-adm@x.com') is not null
  and public.create_institution('C Sede','sc-sede','sc-sadm@x.com',null,qc.inst('sc-madre')) is not null
  and public.create_institution('C Sede 2','sc-sede2','sc-s2adm@x.com',null,qc.inst('sc-madre')) is not null
  and public.create_institution('D Madre','sd-madre','sd-adm@x.com') is not null)::text$$, 'true');
select public.set_institution_plan(qc.inst('sc-madre'), 20, 1000000);
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'sc-adm@x.com','{"name":"Admin C"}',now()),
  (gen_random_uuid(),'sc-sadm@x.com','{"name":"Admin Sede"}',now()),
  (gen_random_uuid(),'sc-s2adm@x.com','{"name":"Admin Sede 2"}',now()),
  (gen_random_uuid(),'sd-adm@x.com','{"name":"Admin D"}',now()),
  (gen_random_uuid(),'sc-t1@x.com','{"org_slug":"sc-sede","name":"Laura Docente"}',now()),
  (gen_random_uuid(),'sc-t2@x.com','{"org_slug":"sc-sede2","name":"Teacher Sede 2"}',now()),
  (gen_random_uuid(),'sd-t@x.com','{"org_slug":"sd-madre","name":"Teacher D"}',now()),
  (gen_random_uuid(),'sc-loner@x.com','{"name":"Loner"}',now());
select qc.eq('C: members placed', $$select string_agg(email||':'||role||':'||coalesce((select slug from public.institutions i where i.id=institution_id),'-'), ',' order by email)
  from public.profiles where email like 'sc-%' or email like 'sd-%'$$,
  'sc-adm@x.com:org_admin:sc-madre,sc-loner@x.com:teacher:-,sc-s2adm@x.com:org_admin:sc-sede2,sc-sadm@x.com:org_admin:sc-sede,sc-t1@x.com:teacher:sc-sede,sc-t2@x.com:teacher:sc-sede2,sd-adm@x.com:org_admin:sd-madre,sd-t@x.com:teacher:sd-madre');

-- ===== preview: groups, schedules, teachers, conflicts, browser errors =====
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.rows', format($j$[
  {"line":2,"email":"","group":"INEFOP A1.1 LMi 7:00","teacher_email":"sc-t1@x.com","substitute_email":"New.Sub@x.com","weekdays":[1,3],"start_time":"07:00","duration_min":60,"start_date":"%1$s","end_date":"%2$s","timezone":"America/Montevideo"},
  {"line":3,"email":"ana@mail.com","name":"Ana","group":"INEFOP A1.1 LMi 7:00"},
  {"line":4,"email":"bob@mail.com","name":"Bob","group":"inefop a1.1 lmi 7:00","start_time":"08:00"},
  {"line":5,"email":"cid@mail.com","name":"Cid","group":"Inglés B1","teacher_email":"pending.teacher@x.com","weekdays":[2,4],"start_time":"19:30","duration_min":90,"start_date":"%1$s","end_date":"%2$s"},
  {"line":6,"email":"dee@mail.com","name":"Dee","group":"Inglés B1","errors":["ambiguous_day"]},
  {"line":7,"email":"eli@mail.com","name":"Eli","group":"Inglés B1","errors":["bad_date"]},
  {"line":8,"email":"fox@mail.com","name":"Fox","group":"Francés","teacher_email":"sd-t@x.com"},
  {"line":9,"email":"gus@mail.com","name":"Gus","weekdays":[1]},
  {"line":10,"email":"hal@mail.com","name":"Hal","group":"Portugués","weekdays":[6],"start_time":"10:00"},
  {"line":11,"email":"ivy@mail.com","name":"Ivy","group":"Largo","weekdays":[1],"start_time":"10:00","duration_min":60,"start_date":"%1$s","end_date":"%3$s"},
  {"line":12,"email":"jo@mail.com","name":"Jo","group":"Sede 2 teacher","teacher_email":"sc-t2@x.com"},
  {"line":13,"email":"kim@mail.com","name":"Kim","group":"Inglés B1","weekdays":[9]}]$j$, qc.d(1), qc.d(28), qc.d(400)), false);
select set_config('qc.p1', public.import_students(qc.inst('sc-sede'), current_setting('qc.rows')::jsonb, true, false)::text, false);
select qc.eq('C: preview row statuses (group-only row, conflict, ambiguous day, bad date, other institution, missing group, bad weekday)',
  $$select qc.rows(current_setting('qc.p1'))$$,
  '2:group_only,3:new_group,4:error:conflict(start_time),5:new_group,6:error:ambiguous_day,7:error:bad_date,8:error:unknown_teacher,9:error:missing_group,10:new_group,11:new_group,12:error:unknown_teacher,13:error:bad_schedule');
select qc.eq('C: INEFOP: teacher registered, substitute will be invited, new schedule, classes = Mon/Wed in range, 1 student',
  $$select g->'teacher'->>'status'||'/'||(g->'teacher'->>'name')||'/'||(g->'substitute'->>'status')||'/'||(g->'substitute'->>'email')||'/'||(g->>'schedule_status')||'/'||(g->>'classes')||'/'||(g->>'students')
      from qc.pick(current_setting('qc.p1'), 'INEFOP A1.1 LMi 7:00') g$$,
  'registered/Laura Docente/invite/new.sub@x.com/new/'||qc.ndays(array[1,3],1,28)||'/1');
select qc.eq('C: INEFOP schedule normalized (days, time, duration, dates, tz)',
  $$select (g->'schedule'->>'weekdays')||' '||(g->'schedule'->>'start_time')||' '||(g->'schedule'->>'duration_min')||' '||(g->'schedule'->>'start_date')||' '||(g->'schedule'->>'end_date')||' '||(g->'schedule'->>'timezone')
      from qc.pick(current_setting('qc.p1'), 'INEFOP A1.1 LMi 7:00') g$$,
  '[1, 3] 07:00 60 '||qc.d(1)||' '||qc.d(28)||' America/Montevideo');
select qc.eq('C: Inglés B1: unregistered teacher → invite, classes Tue/Thu',
  $$select g->'teacher'->>'status'||'/'||(g->>'classes')||'/'||(g->>'students') from qc.pick(current_setting('qc.p1'), 'Inglés B1') g$$, 'invite/'||qc.ndays(array[2,4],1,28)||'/1');
select qc.eq('C: incomplete schedule reported per group (missing duration + end date)',
  $$select (g->>'schedule_status')||'/'||(g->>'schedule_error')||'/'||(g->'missing')::text from qc.pick(current_setting('qc.p1'), 'Portugués') g$$, 'error/schedule_incomplete/["duration_min", "end_date"]');
select qc.eq('C: more than a year refused per group', $$select (g->>'schedule_status')||'/'||(g->>'schedule_error') from qc.pick(current_setting('qc.p1'), 'Largo') g$$, 'error/range_too_long');
select qc.eq('C: total future classes to create', $$select current_setting('qc.p1')::jsonb->>'classes'$$, (qc.ndays(array[1,3],1,28)::int + qc.ndays(array[2,4],1,28)::int)::text);
reset role;
select qc.eq('C: preview writes nothing (groups/enrollments/members/sessions/series/invitations)', $$select qc.counts()$$, '0/0/0/0/0/0');

-- ===== commit =====
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select qc.eq('C: commit', $$select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows')::jsonb, true, true)->>'committed'$$, 'true');
reset role;
select qc.eq('C: INEFOP: teacher assigned, substitute pending (invited)', $$select (teacher_id = qc.uid('sc-t1@x.com'))::text||'/'||coalesce(substitute_id::text,'-')||'/'||pending_substitute_email from public.class_groups where id = qc.grp('INEFOP A1.1 LMi 7:00')$$, 'true/-/new.sub@x.com');
select qc.eq('C: Inglés B1: teacher pending', $$select coalesce(teacher_id::text,'-')||'/'||pending_teacher_email from public.class_groups where id = qc.grp('Inglés B1')$$, '-/pending.teacher@x.com');
select qc.eq('C: invitations created as teacher in the group''s unit (reusing invite_member)', $$select string_agg(email||':'||role||':'||(select slug from public.institutions i where i.id = institution_id), ',' order by email) from public.invitations where email in ('new.sub@x.com','pending.teacher@x.com') and accepted_at is null$$,
  'new.sub@x.com:teacher:sc-sede,pending.teacher@x.com:teacher:sc-sede');
select qc.eq('C: groups with an incomplete or too long schedule are created without classes', $$select string_agg(g.name||':'||(select count(*) from public.class_sessions s where s.group_id = g.id), ',' order by g.name) from public.class_groups g where g.name in ('Portugués','Largo')$$, 'Largo:0,Portugués:0');
select qc.eq('C: one csv series per scheduled group', $$select string_agg(g.name||':'||ss.origin||':'||array_to_string(ss.weekdays, ''), ',' order by g.name) from public.session_series ss join public.class_groups g on g.id = ss.group_id where g.name in ('INEFOP A1.1 LMi 7:00','Inglés B1')$$,
  'INEFOP A1.1 LMi 7:00:csv:13,Inglés B1:csv:24');
select qc.eq('C: INEFOP classes stored at 07:00–08:00 Montevideo, Mon/Wed', $$select count(*)||':'||string_agg(distinct to_char(starts_at at time zone 'America/Montevideo','HH24:MI')||'-'||to_char(ends_at at time zone 'America/Montevideo','HH24:MI'), ',')||':'||string_agg(distinct extract(isodow from starts_at at time zone 'America/Montevideo')::text, '' order by extract(isodow from starts_at at time zone 'America/Montevideo')::text) from public.class_sessions where group_id = qc.grp('INEFOP A1.1 LMi 7:00')$$,
  qc.ndays(array[1,3],1,28)||':07:00-08:00:13');
select qc.eq('C: students enrolled in their groups (error rows skipped)', $$select string_agg(e.email||'@'||g.name, ',' order by e.email) from public.group_members m join public.student_enrollments e on e.id = m.enrollment_id join public.class_groups g on g.id = m.group_id join public.institutions i on i.id = g.institution_id where i.slug = 'sc-sede'$$,
  'ana@mail.com@INEFOP A1.1 LMi 7:00,cid@mail.com@Inglés B1,hal@mail.com@Portugués,ivy@mail.com@Largo');
set role authenticated; select qc.as_user(qc.uid('sc-t1@x.com')::text);
select qc.eq('C: the teacher''s calendar shows the imported classes', $$select count(*)||':'||min(x->>'role') from json_array_elements(public.my_calendar(now(), now() + interval '40 days')) x where x->>'group_name' = 'INEFOP A1.1 LMi 7:00'$$, qc.ndays(array[1,3],1,28)||':teacher');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'ana@mail.com','{"via":"student_link"}',now());
set role authenticated; select qc.as_user(qc.uid('ana@mail.com')::text, 'otp');
select public.claim_enrollments();
select qc.eq('C: an enrolled student sees them too', $$select json_array_length(public.student_view()->'sessions')::text$$, qc.ndays(array[1,3],1,28));
reset role;

-- ===== re-import: idempotent =====
select set_config('qc.c1', qc.counts(), false);
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.p2', public.import_students(qc.inst('sc-sede'), current_setting('qc.rows')::jsonb, true, false)::text, false);
select qc.eq('C: re-import preview: nothing new, schedules unchanged, pending teacher already invited',
  $$select (j->>'ok')||'/'||(j->>'exists')||'/'||(j->>'classes')||'/'||(qc.pick(current_setting('qc.p2'), 'INEFOP A1.1 LMi 7:00')->>'schedule_status')||'/'||(qc.pick(current_setting('qc.p2'), 'Inglés B1')->>'schedule_status')||'/'||(qc.pick(current_setting('qc.p2'), 'Inglés B1')->'teacher'->>'status')
      from (select current_setting('qc.p2')::jsonb j) x$$, '0/4/0/unchanged/unchanged/invited');
select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows')::jsonb, true, true);
reset role;
select qc.eq('C: re-import commit creates no duplicate groups, enrollments, sessions, series or invitations', $$select qc.counts()$$, current_setting('qc.c1'));

-- ===== schedule changed: only future occurrences that were not edited one by one =====
set role authenticated; select qc.as_user(qc.uid('sc-t1@x.com')::text);
select set_config('qc.s1', (select x->>'id' from json_array_elements(public.my_calendar(now(), now() + interval '40 days')) x where x->>'group_name' = 'INEFOP A1.1 LMi 7:00' order by x->>'starts_at' limit 1), false);
reset role; select set_config('qc.s1at', (select (starts_at + interval '3 hours')::text from public.class_sessions where id = current_setting('qc.s1')::uuid), false);
set role authenticated; select qc.as_user(qc.uid('sc-t1@x.com')::text);
select public.update_session(current_setting('qc.s1')::uuid, 'Moved by hand', current_setting('qc.s1at')::timestamptz, 60);
reset role;
-- a past class of the same series (must never change)
insert into public.class_sessions (institution_id, group_id, series_id, title, starts_at, ends_at, timezone)
select g.institution_id, g.id, ss.id, 'Past one', now() - interval '7 days', now() - interval '7 days' + interval '1 hour', 'America/Montevideo'
  from public.class_groups g join public.session_series ss on ss.group_id = g.id where g.id = qc.grp('INEFOP A1.1 LMi 7:00');
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.rows2', replace(current_setting('qc.rows'), '"start_time":"07:00"', '"start_time":"08:30"'), false);
select set_config('qc.p3', public.import_students(qc.inst('sc-sede'), current_setting('qc.rows2')::jsonb, true, false)::text, false);
select qc.eq('C: preview shows "schedule changes" with the previous schedule', $$select (g->>'schedule_status')||'/'||(g->'previous'->>'start_time')||'→'||(g->'schedule'->>'start_time')||'/'||(current_setting('qc.p3')::jsonb->>'schedule_changes') from qc.pick(current_setting('qc.p3'), 'INEFOP A1.1 LMi 7:00') g$$, 'changed/07:00→08:30/1');
select qc.eq('C: line 4 (08:00) still conflicts with the new 08:30', $$select (x->>'status')||':'||(x->>'code') from jsonb_array_elements(current_setting('qc.p3')::jsonb->'rows') x where x->>'line' = '4'$$, 'error:conflict');
select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows2')::jsonb, true, true);
reset role;
select qc.eq('C: future non-edited classes moved to 08:30, the edited one and the past one untouched, none duplicated',
  $$select string_agg(distinct case when title = 'Moved by hand' then 'edited@'||to_char(starts_at at time zone 'America/Montevideo','HH24:MI')
                                   when title = 'Past one' then 'past'
                                   else to_char(starts_at at time zone 'America/Montevideo','HH24:MI') end, ',')||':'||count(*)
      from public.class_sessions where group_id = qc.grp('INEFOP A1.1 LMi 7:00')$$,
  '08:30,edited@10:00,past:'||(qc.ndays(array[1,3],1,28)::int + 1)::text);
select qc.eq('C: moved classes bumped their .ics SEQUENCE', $$select min(seq)::text from public.class_sessions where group_id = qc.grp('INEFOP A1.1 LMi 7:00') and title = ''$$, '1');
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.rows3', replace(current_setting('qc.rows2'), '"weekdays":[1,3]', '"weekdays":[2]'), false);
select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows3')::jsonb, true, true);
reset role;
select qc.eq('C: days changed → future non-edited classes only on Tuesdays (edited + past kept)',
  $$select string_agg(distinct case when title = '' then extract(isodow from starts_at at time zone 'America/Montevideo')::text else title end, ',')||':'||count(*) filter (where title = '')
      from public.class_sessions where group_id = qc.grp('INEFOP A1.1 LMi 7:00')$$,
  '2,Moved by hand,Past one:'||qc.ndays(array[2],1,28));
select qc.eq('C: series updated (Tuesdays 08:30)', $$select array_to_string(weekdays,'')||' '||to_char(start_time,'HH24:MI') from public.session_series where group_id = qc.grp('INEFOP A1.1 LMi 7:00')$$, '2 08:30');

-- ===== pending emails: privacy =====
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select qc.eq('C: the admin sees pending teachers (email + invited) and the schedule in list_groups',
  $$select (g->'pending_teacher'->>'email')||'/'||(g->'pending_teacher'->>'invited')||'/'||(g->'schedule'->>'start_time')||'/'||(g->'schedule'->>'origin') from json_array_elements(public.list_groups(qc.inst('sc-sede'))) g where g->>'name' = 'Inglés B1'$$,
  'pending.teacher@x.com/true/19:30/csv');
set role authenticated; select qc.as_user(qc.uid('sc-adm@x.com')::text);
select qc.eq('C: the main institution admin sees them too', $$select count(*)::text from json_array_elements(public.list_groups(qc.inst('sc-madre'))) g where g->'pending_substitute'->>'email' = 'new.sub@x.com'$$, '1');
set role authenticated; select qc.as_user(qc.uid('sc-s2adm@x.com')::text);
select qc.fails('C: a sibling unit admin cannot list them', $$select public.list_groups(qc.inst('sc-sede'))$$, 'No autorizado');
set role authenticated; select qc.as_user(qc.uid('sd-adm@x.com')::text);
select qc.fails('C: another institution''s admin cannot list them', $$select public.list_groups(qc.inst('sc-sede'))$$, 'No autorizado');
select qc.fails('C: ...nor import into that unit', $$select public.import_students(qc.inst('sc-sede'), '[]', false, false)$$, 'No autorizado');
set role authenticated; select qc.as_user(qc.uid('sc-t1@x.com')::text);
select qc.eq('C: the group''s teacher never gets the pending substitute email', $$select (position('new.sub' in public.my_groups()::text || public.my_calendar(now() - interval '10 days', now() + interval '40 days')::text) = 0)::text$$, 'true');
select qc.fails('C: ...and cannot call list_groups', $$select public.list_groups(qc.inst('sc-sede'))$$, 'No autorizado');
select qc.fails('C: no direct access to class_groups', $$select pending_teacher_email from public.class_groups limit 1$$, 'permission denied');
select qc.fails('C: internal helper tc_person_status not callable', $$select public.tc_person_status(qc.inst('sc-sede'), 'x@x.com')$$, 'permission denied');
select qc.fails('C: internal helper tc_assign_person not callable', $$select public.tc_assign_person(qc.grp('Inglés B1'), 'teacher', 'sc-t1@x.com')$$, 'permission denied');
select qc.fails('C: internal helper tc_series_apply not callable', $$select public.tc_series_apply(null, '', array[1], '10:00', 60, null, null, null)$$, 'permission denied');
set role authenticated; select qc.as_user(qc.uid('ana@mail.com')::text, 'otp');
select qc.eq('C: a student never gets pending emails', $$select (position('new.sub' in public.student_view()::text) = 0 and position('pending.teacher' in public.student_view()::text) = 0)::text$$, 'true');
reset role;

-- ===== the unregistered teacher / substitute register → assigned automatically =====
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'Pending.Teacher@x.com','{"name":"Paula Pendiente"}',now());
select qc.eq('C: registering with the invitation joins the unit as teacher', $$select role||':'||(select slug from public.institutions i where i.id = institution_id) from public.profiles where id = qc.uid('pending.teacher@x.com')$$, 'teacher:sc-sede');
select qc.eq('C: ...and is auto-assigned as the group''s teacher (pending cleared)', $$select (teacher_id = qc.uid('pending.teacher@x.com'))::text||'/'||coalesce(pending_teacher_email,'-') from public.class_groups where id = qc.grp('Inglés B1')$$, 'true/-');
set role authenticated; select qc.as_user(qc.uid('pending.teacher@x.com')::text);
select qc.eq('C: ...their calendar shows the group''s classes', $$select count(*)||':'||min(x->>'role') from json_array_elements(public.my_calendar(now(), now() + interval '40 days')) x where x->>'group_name' = 'Inglés B1'$$, qc.ndays(array[2,4],1,28)||':teacher');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'new.sub@x.com','{"name":"Sergio Suplente"}',now());
select qc.eq('C: the substitute too', $$select (substitute_id = qc.uid('new.sub@x.com'))::text||'/'||coalesce(pending_substitute_email,'-') from public.class_groups where id = qc.grp('INEFOP A1.1 LMi 7:00')$$, 'true/-');
set role authenticated; select qc.as_user(qc.uid('new.sub@x.com')::text);
select qc.eq('C: ...and sees the classes as substitute', $$select (count(*) > 0)::text||':'||min(x->>'role') from json_array_elements(public.my_calendar(now(), now() + interval '40 days')) x$$, 'true:substitute');
reset role;

-- ===== existing account without a unit: added through invite_member and assigned at once =====
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.rows4', $j$[{"line":2,"group":"Alemán","teacher_email":"sc-loner@x.com","weekdays":[5]}]$j$, false);
select qc.eq('C: preview: account without a unit → "add"', $$select qc.pick(public.import_students(qc.inst('sc-sede'), current_setting('qc.rows4')::jsonb, true, false)::text, 'Alemán')->'teacher'->>'status'$$, 'add');
select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows4')::jsonb, true, true);
reset role;
select qc.eq('C: ...added to the unit as teacher and assigned', $$select p.role||':'||(select slug from public.institutions i where i.id = p.institution_id)||':'||(g.teacher_id = p.id)::text from public.profiles p, public.class_groups g where p.id = qc.uid('sc-loner@x.com') and g.id = qc.grp('Alemán')$$, 'teacher:sc-sede:true');

-- ===== "Edit group": choose an invited / not-yet-registered email =====
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select qc.eq('C: create_group with a pending teacher email → invited', $$select (public.create_group(qc.inst('sc-sede'), 'Manual G', null, null, 'America/Montevideo', 'Later.T@x.com') is not null)::text$$, 'true');
select qc.eq('C: ...shown as pending (invited)', $$select (g->'pending_teacher'->>'email')||'/'||(g->'pending_teacher'->>'invited')||'/'||coalesce(g->>'teacher','-') from json_array_elements(public.list_groups(qc.inst('sc-sede'))) g where g->>'name' = 'Manual G'$$, 'later.t@x.com/true/-');
select set_config('qc.inv', (select string_agg(id::text, ',') from public.invitations where email = 'later.t@x.com'), false);
select qc.eq('C: saving the group again keeps the pending teacher without re-inviting', $$select (public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', 'later.t@x.com') is not null)::text$$, 'true');
reset role;
select qc.eq('C: ...same invitation', $$select string_agg(id::text, ',') from public.invitations where email = 'later.t@x.com'$$, current_setting('qc.inv'));
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select qc.fails('C: pending teacher = pending substitute refused', $$select public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', 'later.t@x.com', 'LATER.T@x.com')$$, 'otra persona');
select qc.fails('C: a teacher of another institution cannot be chosen by email', $$select public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', 'sd-t@x.com')$$, 'Docente no válido');
select qc.fails('C: ...nor a teacher of a sibling unit', $$select public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', 'sc-t2@x.com')$$, 'Docente no válido');
select qc.eq('C: a registered teacher chosen by email is assigned directly', $$select public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', 'sc-t1@x.com') = qc.grp('Manual G')$$, 'true');
reset role;
select qc.eq('C: ...teacher set, pending cleared', $$select (teacher_id = qc.uid('sc-t1@x.com'))::text||'/'||coalesce(pending_teacher_email,'-') from public.class_groups where id = qc.grp('Manual G')$$, 'true/-');
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select qc.eq('C: choosing "Not assigned" clears teacher and pending', $$select (public.update_group(qc.grp('Manual G'), 'Manual G', null, null, 'America/Montevideo', null, 'later2@x.com') is not null)::text$$, 'true');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'later2@x.com','{}',now());
select qc.eq('C: a pending substitute set from "Edit group" is assigned when they register', $$select coalesce(teacher_id::text,'-')||'/'||(substitute_id = qc.uid('later2@x.com'))::text from public.class_groups where id = qc.grp('Manual G')$$, '-/true');

-- ===== seats full: warned in the preview, pending kept, no invitation, the import does not fail =====
set role authenticated; select qc.as_user(:'OWNER');
reset role; select set_config('qc.used', public.seats_used(qc.inst('sc-madre'))::text, false);
set role authenticated; select qc.as_user(:'OWNER');
select public.set_institution_plan(qc.inst('sc-madre'), current_setting('qc.used')::int, 1000000);
set role authenticated; select qc.as_user(qc.uid('sc-sadm@x.com')::text);
select set_config('qc.rows5', $j$[{"line":2,"email":"zed@mail.com","group":"Ruso","teacher_email":"full.t@x.com"}]$j$, false);
select qc.eq('C: preview flags seats_full', $$select (g->'teacher'->>'status')||'/'||(g->'teacher'->>'seats_full') from qc.pick(public.import_students(qc.inst('sc-sede'), current_setting('qc.rows5')::jsonb, true, false)::text, 'Ruso') g$$, 'invite/true');
select qc.eq('C: commit still works', $$select public.import_students(qc.inst('sc-sede'), current_setting('qc.rows5')::jsonb, true, true)->>'committed'$$, 'true');
reset role;
select qc.eq('C: ...pending stored, no invitation created', $$select pending_teacher_email||'/'||(select count(*) from public.invitations where email = 'full.t@x.com') from public.class_groups where id = qc.grp('Ruso')$$, 'full.t@x.com/0');

\echo '================ CSV SCHEDULE RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qc.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qc.results;
