-- Recording pipeline (001_base.sql "RECORDING PIPELINE"): writes only with the server key (service_role), consent re-checked
-- in the database, idempotent steps, real insights replace demo ones, reads follow the insights rules, retention.
-- Run after stub + 001_base.sql (alone or after the other suites: everything here uses its own "rp-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qr cascade;
create schema qr;
grant usage on schema qr to anon, authenticated, service_role;
create table qr.results(n serial, label text, ok boolean, detail text);
grant all on qr.results to anon, authenticated, service_role; grant all on sequence qr.results_n_seq to anon, authenticated, service_role;
create table qr.v(k text primary key, val text);
grant all on qr.v to anon, authenticated, service_role;
create function qr.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
create function qr.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qr.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qr.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qr.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qr.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qr.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
create function qr.put(k text, v text) returns text language sql as $$ insert into qr.v values (k, v) on conflict (k) do update set val = excluded.val returning val $$;
create function qr.get(k text) returns text language sql stable as $$ select val from qr.v where k = $1 $$;
grant execute on all functions in schema qr to anon, authenticated, service_role;
-- as in Supabase, the server key can read every table (the test queries check rows as service_role)
grant select on all tables in schema public to service_role;
create function qr.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qr.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qr.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qr.enr(e text) returns uuid language sql security definer as $$ select id from public.student_enrollments where lower(email) = lower(e) order by created_at limit 1 $$;
create function qr.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
create function qr.room(t text) returns text language sql security definer as $$ select 'sess-' || replace(qr.sess(t)::text, '-', '') $$;
create function qr.live(t text) returns uuid language sql security definer as $$ select id from public.live_sessions where class_session_id = qr.sess(t) $$;
create function qr.part(t text, e text) returns uuid language sql security definer as
$$ select id from public.session_participants where session_id = qr.live(t) and user_id = qr.uid(e) $$;
-- a teacher report as api/_lib/rec/analysis.js builds it (shape checked by the RPC: areas, metrics, recap)
create function qr.tdata(tag text) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'language', 'lang', 'en', 'subject', 'English', 'title', 'RP past', 'source', 'recording',
    'recap', jsonb_build_object('summary', 'Real recap ' || tag, 'topics', '[]'::jsonb), 'objective', 'Plans', 'observation_focus', 'STT',
    'metrics', jsonb_build_array(jsonb_build_object('label', 'Teacher talk time', 'value', '60%', 'sub', '3 of 45 min')),
    'areas', '[]'::jsonb, 'highlights', '[]'::jsonb, 'planVsActual', '[]'::jsonb, 'form', jsonb_build_object('evidence', tag)) $$;
create function qr.sdata(tag text) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'language', 'lang', 'en', 'subject', 'English', 'title', 'RP past', 'highlight', tag,
    'recap', jsonb_build_object('summary', 'Real recap', 'topics', '[]'::jsonb),
    'progress', jsonb_build_object('speakingMin', 1.2, 'teacherMin', 3, 'vocab', 40, 'vocabDelta', 0, 'level', 'B1', 'levelPrev', 'B1', 'wpm', 90, 'wpmDelta', 0, 'score', 70, 'scoreDelta', 0)) $$;
grant execute on function qr.inst(text), qr.uid(text), qr.grp(text), qr.enr(text), qr.sess(text), qr.room(text), qr.live(text), qr.part(text, text),
  qr.tdata(text), qr.sdata(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: RP Madre › RP Sede ; RP Otra. Group RP G1 (teacher + substitute) with Ana, Beto, Caro (accounts) =====
set role authenticated; select qr.as_user(:'OWNER');
select public.create_institution('RP Madre','rp-madre','rp-adm@x.com');
select public.create_institution('RP Sede','rp-sede','rp-sadm@x.com',null,qr.inst('rp-madre'));
select public.create_institution('RP Otra','rp-otra','rp-oadm@x.com');
reset role;
update public.institutions set open_registration = true where slug in ('rp-sede','rp-otra') and not open_registration;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'rp-adm@x.com','{"name":"RP Admin"}',now()),
  (gen_random_uuid(),'rp-sadm@x.com','{"name":"RP Admin Sede"}',now()),
  (gen_random_uuid(),'rp-oadm@x.com','{"name":"RP Admin Otra"}',now()),
  (gen_random_uuid(),'rp-t1@x.com','{"org_slug":"rp-sede","name":"RP Teacher"}',now()),
  (gen_random_uuid(),'rp-sub@x.com','{"org_slug":"rp-sede","name":"RP Sub"}',now()),
  (gen_random_uuid(),'rp-to@x.com','{"org_slug":"rp-otra","name":"RP Teacher Otra"}',now()),
  (gen_random_uuid(),'rp-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'rp-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  (gen_random_uuid(),'rp-st3@x.com','{"via":"student_link","name":"Caro"}',now());
set role authenticated; select qr.as_user(qr.uid('rp-adm@x.com')::text);
select public.create_group(qr.inst('rp-sede'), 'RP G1', qr.uid('rp-t1@x.com'), qr.uid('rp-sub@x.com'));
select public.add_student(null, 'rp-st1@x.com', 'Ana Alonso', qr.grp('RP G1'));
select public.add_student(null, 'rp-st2@x.com', 'Beto Barrios', qr.grp('RP G1'));
select public.add_student(null, 'rp-st3@x.com', 'Caro Castro', qr.grp('RP G1'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('rp-st1@x.com','rp-st2@x.com','rp-st3@x.com');
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, now() + x.d, now() + x.d + interval '45 minutes', 'America/Montevideo', x.st
  from (values ('RP past', interval '-1 hours', 'scheduled'), ('RP cancelled', interval '-3 days', 'cancelled')) x(t, d, st)
  join public.class_groups g on g.name = 'RP G1';
-- consent: teacher, Ana and Beto say yes (from the app, with their own session); Caro never answers
do $$ declare e text; begin
  foreach e in array array['rp-t1@x.com','rp-st1@x.com','rp-st2@x.com'] loop
    perform set_config('request.jwt.claim.sub', qr.uid(e)::text, false);
    perform public.grant_recording_consent(public.tc_consent_version());
  end loop;
end $$;
select qr.as_user('');

-- ===== writes: only the server key =====
set role authenticated; select qr.as_user(qr.uid('rp-t1@x.com')::text);
select qr.fails('R: a teacher cannot reserve a recording', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-t1@x.com'), 'TR_x1', 'x')$$, 'permission denied');
select qr.fails('R: … nor store insights', $$select public.rec_store_teacher_insights(gen_random_uuid(), qr.tdata('x'))$$, 'permission denied');
select qr.fails('R: … nor read the pipeline work list', $$select public.rec_work()$$, 'permission denied');
select qr.fails('R: … nor the analysis context (transcripts of everyone)', $$select public.rec_session_context(gen_random_uuid())$$, 'permission denied');
select qr.fails('R: … nor list audio to delete', $$select count(*) from public.recordings_due_for_deletion()$$, 'permission denied');
select qr.fails('R: … nor write recordings directly', $$insert into public.recordings (session_id, participant_id, storage_path) values (gen_random_uuid(), gen_random_uuid(), 'x')$$, '');
select qr.eq('R: … and reads no recordings directly before 002 (RLS, no policies)', $$select count(*)::text from public.recordings$$, '0');
reset role;
set role anon; select qr.as_user('');
select qr.fails('R: anon cannot call the pipeline', $$select public.rec_room_started('sess-0123')$$, 'permission denied');
select qr.fails('R: anon cannot ask a class status', $$select public.rec_session_status(qr.sess('RP past'))$$, 'permission denied');
reset role;

-- ===== the server (service_role) =====
set role service_role;
select qr.eq('R: ad-hoc rooms are never recorded', $$select public.rec_room_started('abcdef012345-x1')::jsonb->>'reason'$$, 'not_calendar');
select qr.eq('R: a cancelled class is never recorded', $$select public.rec_room_started(qr.room('RP cancelled'))::jsonb->>'reason'$$, 'not_calendar');
select qr.eq('R: room_started (calendar class)', $$select public.rec_room_started(qr.room('RP past'))::jsonb->>'ok'$$, 'true');
select qr.eq('R: … creates the call for the class (live, recording on)', $$select 'true'
  ||'/'||(select status||':'||rec_state||':'||(class_session_id = qr.sess('RP past'))::text||':'||(teacher_id = qr.uid('rp-t1@x.com'))::text from public.live_sessions where livekit_room = qr.room('RP past'))$$, 'true/live:on:true:true');
select qr.eq('R: room_started again: still one call', $$select (public.rec_room_started(qr.room('RP past'))::jsonb->>'ok')||'/'||(select count(*) from public.live_sessions where class_session_id = qr.sess('RP past'))$$, 'true/1');
-- teacher with consent → recorded
select qr.put('t', public.rec_track_published(qr.room('RP past'), qr.uid('rp-t1@x.com'), 'TR_teacher1', 'RP Teacher')::text);
select qr.eq('R: teacher with consent: recording reserved (path under the call / participant)', $$select (qr.get('t')::jsonb->>'record')||'/'||((qr.get('t')::jsonb->>'storage_path') like (qr.live('RP past')::text || '/%/%.ogg'))::text$$, 'true/true');
select qr.eq('R: the same track again (webhook retry): nothing new', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-t1@x.com'), 'TR_teacher1', 'RP Teacher')::jsonb->>'reason'$$, 'already');
select qr.eq('R: one recording row for that track', $$select count(*)::text from public.recordings where track_sid = 'TR_teacher1'$$, '1');
select qr.eq('R: egress accepted → id stored', $$select public.rec_egress_started((qr.get('t')::jsonb->>'recording_id')::uuid, 'EG_teacher1')::jsonb->>'stop'$$, 'false');
select qr.eq('R: … only once', $$select public.rec_egress_started((qr.get('t')::jsonb->>'recording_id')::uuid, 'EG_other')::jsonb->>'ok'$$, 'false');
-- students
select qr.put('a', public.rec_track_published(qr.room('RP past'), qr.uid('rp-st1@x.com'), 'TR_ana1', '<b>Ana</b>')::text);
select qr.eq('R: student with consent: recorded', $$select qr.get('a')::jsonb->>'record'$$, 'true');
select qr.eq('R: display name cleaned', $$select display_name from public.session_participants where id = qr.part('RP past', 'rp-st1@x.com')$$, '<b>Ana</b>');
select qr.eq('R: student WITHOUT consent (whatever the metadata says): not recorded', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-st3@x.com'), 'TR_caro1', 'Caro')::jsonb->>'reason'$$, 'no_consent');
select qr.eq('R: … participant stored as not recorded', $$select recorded::text from public.session_participants where id = qr.part('RP past', 'rp-st3@x.com')$$, 'false');
select qr.eq('R: someone who is not in the class: nothing', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-to@x.com'), 'TR_x9', 'X')::jsonb->>'reason'$$, 'not_member');
select qr.eq('R: invalid track id refused', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-st1@x.com'), 'bad track!', 'X')::jsonb->>'reason'$$, 'invalid');
-- the DB re-check: Beto revokes from his profile before publishing → not recorded
reset role; set role authenticated; select qr.as_user(qr.uid('rp-st2@x.com')::text);
select public.revoke_recording_consent();
reset role; set role service_role;
select qr.eq('R: consent revoked in the DB → not recorded (re-checked on every track)', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-st2@x.com'), 'TR_beto1', 'Beto')::jsonb->>'reason'$$, 'no_consent');
select qr.eq('R: a failed egress releases the reservation', $$select (public.rec_egress_failed((qr.get('a')::jsonb->>'recording_id')::uuid))::text$$, 'true');
select qr.eq('R: … (row gone)', $$select count(*)::text from public.recordings where track_sid = 'TR_ana1'$$, '0');
select qr.put('a', public.rec_track_published(qr.room('RP past'), qr.uid('rp-st1@x.com'), 'TR_ana1', 'Ana')::text);
select qr.eq('R: … so the retry records it', $$select (qr.get('a')::jsonb->>'record')||'/'||(public.rec_egress_started((qr.get('a')::jsonb->>'recording_id')::uuid, 'EG_ana1')::jsonb->>'stop')$$, 'true/false');
-- pause / resume
select qr.eq('R: pause → the active egresses to stop, with whose they are', $$select (select string_agg((x->>'egress_id')||'@'||((x->>'identity') = qr.uid('rp-st1@x.com')::text or (x->>'identity') = qr.uid('rp-t1@x.com')::text)::text, ',' order by x->>'egress_id')
  from json_array_elements(public.rec_set_state(qr.room('RP past'), 'paused')->'stop') x)$$, 'EG_ana1@true,EG_teacher1@true');
select qr.eq('R: while paused nothing new starts', $$select public.rec_track_published(qr.room('RP past'), qr.uid('rp-st1@x.com'), 'TR_ana2', 'Ana')::jsonb->>'reason'$$, 'paused');
select qr.fails('R: unknown state refused', $$select public.rec_set_state(qr.room('RP past'), 'off')$$, 'inválido');
select qr.eq('R: resume', $$select public.rec_set_state(qr.room('RP past'), 'on')::jsonb->>'state'$$, 'on');
select qr.put('a2', public.rec_track_published(qr.room('RP past'), qr.uid('rp-st1@x.com'), 'TR_ana1', 'Ana')::text);
select qr.eq('R: after resuming, the SAME track gets a new segment', $$select (qr.get('a2')::jsonb->>'record')||'/'||(select count(*) from public.recordings where track_sid = 'TR_ana1')$$, 'true/2');
select qr.eq('R: paused while the egress was starting → stop it', $$select (public.rec_set_state(qr.room('RP past'), 'paused')::jsonb->>'ok')||'/'||(public.rec_egress_started((qr.get('a2')::jsonb->>'recording_id')::uuid, 'EG_ana2')::jsonb->>'stop')$$, 'true/true');
select public.rec_set_state(qr.room('RP past'), 'on');
-- egress_ended
select qr.eq('R: egress_ended → uploaded; the participant has no other active segment', $$select (x->>'changed')||'/'||(x->>'status')||'/'||(x->>'participant_active')||'/'||((x->>'identity') = qr.uid('rp-t1@x.com')::text)::text
  from (select public.rec_egress_ended('EG_teacher1', true, now() - interval '30 minutes', now() - interval '5 minutes', 1500)::jsonb x) y$$, 'true/uploaded/0/true');
select qr.eq('R: … with its duration and 30-day retention', $$select duration_s||':'||(retention_until between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour')::text from public.recordings where egress_id = 'EG_teacher1'$$, '1500:true');
select qr.eq('R: egress_ended again (retry): no change', $$select public.rec_egress_ended('EG_teacher1', false, null, null, 0, 'late retry')::jsonb->>'changed'$$, 'false');
select qr.eq('R: … the stored state is kept', $$select status from public.recordings where egress_id = 'EG_teacher1'$$, 'uploaded');
select qr.eq('R: a failed egress → failed', $$select public.rec_egress_ended('EG_ana2', false, null, null, 0, 'boom')::jsonb->>'status'$$, 'failed');
select qr.eq('R: unknown egress → not found', $$select public.rec_egress_ended('EG_nope', true)::jsonb->>'found'$$, 'false');
-- room_finished
select qr.eq('R: room_finished → processing (Ana''s segment is closed too)', $$select (public.rec_room_finished(qr.room('RP past'))::jsonb->>'status')||'/'||(select count(*) from public.recordings where session_id = qr.live('RP past') and ended_at is null)$$, 'processing/0');
select qr.eq('R: room_finished again: idempotent', $$select public.rec_room_finished(qr.room('RP past'))::jsonb->>'status'$$, 'processing');
select qr.eq('R: Ana''s egress ends after the room', $$select public.rec_egress_ended('EG_ana1', true, now() - interval '28 minutes', now() - interval '5 minutes', 1380)::jsonb->>'live_status'$$, 'processing');
select qr.eq('R: the work list has the class with its recordings and language hints', $$select (select count(*) from json_array_elements(x->'recordings'))||'/'||(x->>'status')||'/'||coalesce(x->>'plan_language', '-')
  from (select json_array_elements(public.rec_work()) x) y where (x->>'id')::uuid = qr.live('RP past')$$, '3/processing/-');
select qr.eq('R: … also by class id', $$select (public.rec_work(null, 1, qr.sess('RP past'))->0->>'id')::uuid = qr.live('RP past')$$, 'true');
-- transcription
select qr.eq('R: speech job stored once', $$select public.rec_speech_submitted((select id from public.recordings where egress_id = 'EG_teacher1'), 'https://brazilsouth.api.cognitive.microsoft.com/speechtotext/transcriptions/1')::text
  ||'/'||public.rec_speech_submitted((select id from public.recordings where egress_id = 'EG_teacher1'), 'x')::text$$, 'true/false');
select qr.eq('R: a failed job is retried (attempts < 3)', $$select public.rec_speech_failed((select id from public.recordings where egress_id = 'EG_ana1'), 'oops')::jsonb->>'status'$$, 'uploaded');
select qr.fails('R: invalid transcript refused (end before start)', $$select public.rec_store_transcript((select id from public.recordings where egress_id = 'EG_teacher1'), '[{"start_ms": 5000, "end_ms": 10, "text": "x"}]')$$, 'inválida');
select qr.fails('R: invalid transcript refused (not an array)', $$select public.rec_store_transcript((select id from public.recordings where egress_id = 'EG_teacher1'), '{"a":1}')$$, 'inválida');
select qr.eq('R: transcript stored', $$select public.rec_store_transcript((select id from public.recordings where egress_id = 'EG_teacher1'),
  '[{"start_ms": 1000, "end_ms": 4000, "text": "What are you going to do this weekend?", "words": 8, "confidence": 0.93}, {"start_ms": 9000, "end_ms": 12000, "text": "Great, tell me more.", "words": 4}]')::jsonb->>'segments'$$, '2');
select qr.eq('R: storing it again replaces it (idempotent)', $$select (public.rec_store_transcript((select id from public.recordings where egress_id = 'EG_teacher1'),
  '[{"start_ms": 1000, "end_ms": 4000, "text": "What are you going to do this weekend?", "words": 8}, {"start_ms": 9000, "end_ms": 12000, "text": "Great, tell me more.", "words": 4}]')::jsonb->>'segments')
  ||'/'||(select count(*) from public.transcript_segments where session_id = qr.live('RP past'))||'/'||(select status||':'||speech_s from public.recordings where egress_id = 'EG_teacher1')$$, '2/2/transcribed:6');
select public.rec_store_transcript((select id from public.recordings where egress_id = 'EG_ana1'), '[{"start_ms": 4500, "end_ms": 8000, "text": "I am going to visit my grandmother.", "words": 7}]');
select qr.eq('R: analysis context: participants (enrollment of each student), transcript in order, nothing done yet', $$select
  (select string_agg((p->>'role')||':'||(p->>'recorded')||':'||coalesce((p->>'enrollment_id' = qr.enr('rp-st1@x.com')::text)::text, '-'), ',' order by p->>'role' desc, p->>'recorded') from json_array_elements(c->'participants') p)
  ||'/'||(select string_agg(s->>'start_ms', ',') from json_array_elements(c->'segments') s)||'/'||(c->'done'->>'teacher')||'/'||(c->'session'->>'students_total')
  from (select public.rec_session_context(qr.live('RP past')) c) x$$, 'teacher:true:-,student:false:false,student:false:false,student:true:true/1000,4500,9000/false/3');
-- analysis: one at a time
select qr.eq('R: analysis claimed once', $$select public.rec_claim_analysis(qr.live('RP past'))::text||'/'||public.rec_claim_analysis(qr.live('RP past'))::text$$, 'true/false');
select public.rec_release_analysis(qr.live('RP past'));
select qr.eq('R: … released → claimable again', $$select public.rec_claim_analysis(qr.live('RP past'))::text$$, 'true');
reset role;
-- the teacher had generated DEMO insights and written a reflection
set role authenticated; select qr.as_user(qr.uid('rp-t1@x.com')::text);
select public.generate_demo_insights(qr.sess('RP past'), jsonb_build_object('kind', 'language', 'lang', 'en', 'subject', 'x', 'title', 'x',
  'recap', jsonb_build_object('summary', 'demo', 'topics', '[]'::jsonb), 'teacher', jsonb_build_object('objective', 'demo'),
  'students', jsonb_build_array(jsonb_build_object('highlight', 'demo'))));
select public.save_teacher_reflection(qr.sess('RP past'), 'My reflection');
reset role; set role service_role;
select qr.fails('R: invalid report refused', $$select public.rec_store_teacher_insights(qr.live('RP past'), '{"recap": {}}'::jsonb)$$, 'inválidos');
select qr.eq('R: real report stored', $$select public.rec_store_teacher_insights(qr.live('RP past'), qr.tdata('one'), 'gpt-4o')::jsonb->>'stored'$$, 'true');
select qr.eq('R: … it replaced the demo one and kept the reflection', $$select 'true'
  ||'/'||(select is_demo::text||':'||(data->'form'->>'evidence')||':'||teacher_reflection||':'||model from public.teacher_insights where session_id = qr.sess('RP past'))$$, 'true/false:one:My reflection:gpt-4o');
select qr.eq('R: storing it again changes nothing (idempotent)', $$select public.rec_store_teacher_insights(qr.live('RP past'), qr.tdata('two'))::jsonb->>'stored'$$, 'false');
select qr.eq('R: … the first one stays', $$select data->'form'->>'evidence' from public.teacher_insights where session_id = qr.sess('RP past')$$, 'one');
select qr.eq('R: real student insight for Ana (consented, in the call)', $$select public.rec_store_student_insights(qr.live('RP past'), qr.enr('rp-st1@x.com'), qr.part('RP past', 'rp-st1@x.com'), qr.sdata('Ana real'), 'gpt-4o')::jsonb->>'stored'$$, 'true');
select qr.eq('R: … replaced her demo row', $$select 'true'
  ||'/'||(select is_demo::text||':'||(data->>'highlight')||':'||(participant_id = qr.part('RP past', 'rp-st1@x.com'))::text from public.student_insights where session_id = qr.sess('RP past') and enrollment_id = qr.enr('rp-st1@x.com'))$$, 'true/false:Ana real:true');
select qr.fails('R: never for a student who was not recorded (Caro)', $$select public.rec_store_student_insights(qr.live('RP past'), qr.enr('rp-st3@x.com'), qr.part('RP past', 'rp-st3@x.com'), qr.sdata('x'))$$, 'Estudiante inválido');
select qr.fails('R: never with someone else''s participant', $$select public.rec_store_student_insights(qr.live('RP past'), qr.enr('rp-st3@x.com'), qr.part('RP past', 'rp-st1@x.com'), qr.sdata('x'))$$, 'Estudiante inválido');
select qr.fails('R: invalid student data refused', $$select public.rec_store_student_insights(qr.live('RP past'), qr.enr('rp-st1@x.com'), qr.part('RP past', 'rp-st1@x.com'), '{"highlight": "x"}'::jsonb)$$, 'inválidos');
select qr.eq('R: context now says what is done (+ the report base for the student steps)', $$select (c->'done'->>'teacher')||'/'||(c->'done'->'teacher_base'->'recap'->>'summary')||'/'||(c->'done'->'students'->>0 = qr.enr('rp-st1@x.com')::text)::text
  from (select public.rec_session_context(qr.live('RP past')) c) x$$, 'true/Real recap one/true');
-- usage: ai_events (kind insights) + plan balance (ai_record_usage) + the class total (token cap)
select qr.eq('R: AI usage recorded (class total)', $$select public.rec_record_ai(qr.live('RP past'), 1200, 800, true, 'en-US')::jsonb->>'session_tokens'$$, '2000');
select qr.eq('R: … as an ai_events "insights" row and in the plan''s request log', $$select '2000'
  ||'/'||(select count(*) from public.ai_events where kind = 'insights' and user_id = qr.uid('rp-t1@x.com') and ok)
  ||'/'||(select total_tokens||':'||kind from public.ai_request_log where user_id = qr.uid('rp-t1@x.com') and kind = 'insights' order by id desc limit 1)$$, '2000/1/2000:insights');
select qr.eq('R: … adds up', $$select public.rec_record_ai(qr.live('RP past'), 100, 50, false)::jsonb->>'session_tokens'$$, '2150');
reset role;

-- ===== reads: same rules as the insights =====
set role authenticated; select qr.as_user(qr.uid('rp-t1@x.com')::text);
select qr.eq('R: teacher sees the class processing', $$select (x->>'state')||'/'||(x->>'recordings')||'/'||(x->>'transcribed')||'/'||(x->>'has_insights') from (select public.rec_session_status(qr.sess('RP past'))::jsonb x) y$$, 'processing/2/2/true');
select qr.eq('R: … and in the processing list', $$select (public.rec_processing_sessions()->0->>'id')::uuid = qr.sess('RP past')$$, 'true');
select qr.eq('R: the real report in Insights (not demo, reflection kept)', $$select (x->'teacher'->>'is_demo')||'/'||(x->'teacher'->>'reflection') from (select public.get_session_insights(qr.sess('RP past'))::jsonb x) y$$, 'false/My reflection');
select qr.as_user(qr.uid('rp-sub@x.com')::text);
select qr.eq('R: substitute sees it too', $$select public.rec_session_status(qr.sess('RP past'))::jsonb->>'state'$$, 'processing');
select qr.as_user(qr.uid('rp-sadm@x.com')::text);
select qr.eq('R: admin of the unit sees it', $$select public.rec_session_status(qr.sess('RP past'))::jsonb->>'state'$$, 'processing');
select qr.as_user(qr.uid('rp-st1@x.com')::text);
select qr.eq('R: a student of the class sees its state (has_insights = her own)', $$select (x->>'state')||'/'||(x->>'has_insights') from (select public.rec_session_status(qr.sess('RP past'))::jsonb x) y$$, 'processing/true');
select qr.eq('R: … but not the processing list of the staff', $$select json_array_length(public.rec_processing_sessions())::text$$, '0');
select qr.eq('R: … and only her own insight, now real', $$select string_agg((x->>'is_demo')||':'||(x->>'summary'), ',') from json_array_elements(public.my_insights()) x$$, 'false:Real recap');
select qr.as_user(qr.uid('rp-st3@x.com')::text);
select qr.eq('R: Caro (not recorded) has no real insight: her row stays the demo one', $$select string_agg(x->>'is_demo', ',') from json_array_elements(public.my_insights()) x$$, 'true');
select qr.as_user(qr.uid('rp-to@x.com')::text);
select qr.eq('R: someone outside the class reads no transcript / recording directly (RLS)', $$select (select count(*) from public.transcript_segments)||'/'||(select count(*) from public.recordings)$$, '0/0');
select qr.fails('R: a teacher of another institution cannot see the state', $$select public.rec_session_status(qr.sess('RP past'))$$, 'No autorizado');
select qr.eq('R: … nor the processing list', $$select json_array_length(public.rec_processing_sessions())::text$$, '0');
select qr.as_user(qr.uid('rp-oadm@x.com')::text);
select qr.fails('R: an admin of another institution cannot see the state', $$select public.rec_session_status(qr.sess('RP past'))$$, 'No autorizado');
reset role;

-- ===== finish, retention =====
set role service_role;
select qr.fails('R: unknown final state refused', $$select public.rec_finish(qr.live('RP past'), 'live')$$, 'inválido');
select qr.eq('R: ready', $$select public.rec_finish(qr.live('RP past'), 'ready')::text$$, 'true');
select qr.eq('R: … stored', $$select status from public.live_sessions where id = qr.live('RP past')$$, 'ready');
select qr.eq('R: … no longer in the work list', $$select count(*)::text from json_array_elements(public.rec_work()) x where (x->>'id')::uuid = qr.live('RP past')$$, '0');
reset role;
update public.recordings set retention_until = now() - interval '1 minute' where egress_id = 'EG_teacher1';
set role service_role;
select qr.eq('R: audio past 30 days is due for deletion', $$select string_agg((storage_path like (qr.live('RP past')::text || '/%'))::text, ',') from public.recordings_due_for_deletion()$$, 'true');
select qr.eq('R: marked deleted once', $$select public.rec_mark_deleted((select id from public.recordings where egress_id = 'EG_teacher1'))::text||'/'||public.rec_mark_deleted((select id from public.recordings where egress_id = 'EG_teacher1'))::text$$, 'true/false');
select qr.eq('R: nothing due any more; transcript and insights stay', $$select (select count(*) from public.recordings_due_for_deletion())||'/'||(select status from public.recordings where egress_id = 'EG_teacher1')
  ||'/'||(select count(*) from public.transcript_segments where session_id = qr.live('RP past'))||'/'||(select count(*) from public.teacher_insights where session_id = qr.sess('RP past') and not is_demo)$$, '0/deleted/3/1');
reset role;
set role authenticated; select qr.as_user(qr.uid('rp-t1@x.com')::text);
select qr.eq('R: the teacher sees it ready', $$select public.rec_session_status(qr.sess('RP past'))::jsonb->>'state'$$, 'ready');
select qr.fails('R: only the super admin chooses the insights model', $$select public.update_ai_model_default('{"insights":"mini"}')$$, 'No autorizado');
select qr.as_user(:'OWNER');
select qr.eq('R: super admin: insights model → mini', $$select public.update_ai_model_default('{"insights":"mini"}')::jsonb->>'insights'$$, 'mini');
select qr.fails('R: … validated', $$select public.update_ai_model_default('{"insights":"gpt-9"}')$$, 'inválido');
select public.update_ai_model_default('{"insights":"default"}');
reset role;

\echo '================ RECORDING PIPELINE RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qr.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qr.results;
