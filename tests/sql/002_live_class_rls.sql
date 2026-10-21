-- RLS tests for supabase/migrations/002_live_class.sql on a local Postgres 16 with Supabase stubs.
-- Usage (fresh database): psql -v ON_ERROR_STOP=1 -f stub.sql -f 001_base.sql -f 002_live_class.sql -f tests/sql/002_live_class_rls.sql
-- Any failed expectation raises an exception (non-zero exit with ON_ERROR_STOP=1).
-- Insights (student_insights / teacher_insights) live in 001_base.sql, per CALENDAR class: the call is linked
-- with live_sessions.class_session_id and each student's row with student_insights.participant_id.
\set QUIET 1
\pset footer off

create or replace function as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
create or replace function expect(ok boolean, msg text) returns void language plpgsql as
$$ begin if ok is not true then raise exception 'FAIL: %', msg; end if; raise notice 'ok - %', msg; end $$;
-- runs a statement that must fail (any error) or must affect 0 rows
create or replace function expect_denied(stmt text, msg text) returns void language plpgsql as
$$ declare n int; begin
  begin execute stmt; get diagnostics n = row_count;
  exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end;
  if n > 0 then raise exception 'FAIL: % (statement succeeded on % rows)', msg, n; end if;
  raise notice 'ok - % (0 rows)', msg;
end $$;
grant execute on function as_user(text), expect(boolean, text), expect_denied(text, text) to anon, authenticated;

-- ── seed (as postgres: bypasses RLS) ──
insert into public.institutions(id, name, slug) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Inst A', 'inst-a'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Inst B', 'inst-b');
update public.institutions set open_registration = true where slug in ('inst-a','inst-b') and not open_registration; -- 2026-10: sign-up by link is off by default (TC-02); opened explicitly here
insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 't1@a.com', '{"org_slug":"inst-a"}'),
  ('00000000-0000-4000-8000-0000000000a2', 't2@a.com', '{"org_slug":"inst-a"}'),
  ('00000000-0000-4000-8000-0000000000ad', 'adm@a.com', '{"org_slug":"inst-a"}'),
  ('00000000-0000-4000-8000-0000000000bd', 'adm@b.com', '{"org_slug":"inst-b"}'),
  ('00000000-0000-4000-8000-000000000051', 's1@a.com', '{}'),
  ('00000000-0000-4000-8000-000000000052', 's2@a.com', '{}'),
  ('00000000-0000-4000-8000-000000000062', 'guardian@x.com', '{}'),
  ('00000000-0000-4000-8000-0000000000ee', 'stranger@x.com', '{}');
update public.profiles set role = 'org_admin' where email in ('adm@a.com', 'adm@b.com');
-- the calendar class (001_base.sql) taught in this call: group of t1 with students s1 and s2
insert into public.class_groups(id, institution_id, name, teacher_id) values
  ('ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Chem 3B', '00000000-0000-4000-8000-0000000000a1');
insert into public.student_enrollments(id, institution_id, email, name, user_id) values
  ('ffffffff-0000-4000-8000-000000000051', 'aaaaaaaa-0000-4000-8000-000000000001', 's1@a.com', 'Sofía', '00000000-0000-4000-8000-000000000051'),
  ('ffffffff-0000-4000-8000-000000000052', 'aaaaaaaa-0000-4000-8000-000000000001', 's2@a.com', 'Mateo', '00000000-0000-4000-8000-000000000052');
insert into public.group_members(group_id, enrollment_id) values
  ('ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000051'),
  ('ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000052');
insert into public.class_sessions(id, institution_id, group_id, teacher_id, title, starts_at, ends_at) values
  ('99999999-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000a1', 'Chemistry 3B', now() - interval '1 hour', now());
insert into public.plannings(id, owner_id, institution_id, title) values
  ('cccccccc-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'T1 plan'),
  ('cccccccc-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'T2 plan');

-- ── teacher t1 creates a session ──
set role authenticated;
select as_user('00000000-0000-4000-8000-0000000000a1');
insert into public.live_sessions(id, teacher_id, institution_id, planning_id, title, livekit_room, class_session_id)
  values ('dddddddd-0000-4000-8000-000000000001', auth.uid(), 'bbbbbbbb-0000-4000-8000-000000000001',
          'cccccccc-0000-4000-8000-0000000000a1', 'Chemistry 3B', 'room-t1-a', '99999999-0000-4000-8000-000000000001');
select expect((select institution_id from public.live_sessions where id = 'dddddddd-0000-4000-8000-000000000001')
              = 'aaaaaaaa-0000-4000-8000-000000000001', 'institution forced to the teacher''s own');
select expect_denied($$insert into public.live_sessions(teacher_id, title, livekit_room)
  values ('00000000-0000-4000-8000-0000000000a2', 'x', 'room-fake')$$, 'cannot create a session for another teacher');
select expect_denied($$insert into public.live_sessions(teacher_id, planning_id, title, livekit_room)
  values (auth.uid(), 'cccccccc-0000-4000-8000-0000000000a2', 'x', 'room-x2')$$, 'cannot link another teacher''s planning');
select expect_denied($$insert into public.live_sessions(teacher_id, title, livekit_room) values (auth.uid(), 'x', 'bad room!')$$, 'room name format enforced');

insert into public.session_participants(id, session_id, user_id, display_name, role, livekit_identity) values
  ('eeeeeeee-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'T1', 'teacher', 'id-t1'),
  ('eeeeeeee-0000-4000-8000-000000000051', 'dddddddd-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000051', 'Sofía', 'student', 'id-s1');
insert into public.session_participants(id, session_id, user_id, guardian_user_id, display_name, role, is_minor, livekit_identity) values
  ('eeeeeeee-0000-4000-8000-000000000052', 'dddddddd-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000052',
   '00000000-0000-4000-8000-000000000062', 'Mateo', 'student', true, 'id-s2');
select expect_denied($$update public.session_participants set recorded = true where id = 'eeeeeeee-0000-4000-8000-000000000051'$$,
  'teacher cannot flip "recorded" (server only)');

-- ── server (postgres/service role) writes recordings, transcripts and insights ──
reset role;
insert into public.recordings(session_id, participant_id, storage_path, duration_s, speech_s) values
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'live/d1/s1.ogg', 2700, 410),
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'live/d1/s2.ogg', 2700, 300);
insert into public.transcript_segments(session_id, participant_id, start_ms, end_ms, text) values
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 1000, 4000, 'Hola'),
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 5000, 9000, 'Buenas');
-- real (non-demo) insights for the calendar class of this call, linked to the call's participants
insert into public.student_insights(session_id, enrollment_id, participant_id, data, published_message, published_at) values
  ('99999999-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000051', 'eeeeeeee-0000-4000-8000-000000000051', '{"recap":{"summary":"s1"}}', 'Bien, Sofía', now()),
  ('99999999-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000052', 'eeeeeeee-0000-4000-8000-000000000052', '{"recap":{"summary":"s2"}}', '', null);
insert into public.teacher_insights(session_id, data) values ('99999999-0000-4000-8000-000000000001', '{"areas":13}');
select expect((select count(*) from public.student_insights where participant_id is not null) = 2, 'student insights linked to the call participants');
select expect_denied($$insert into public.student_insights(session_id, enrollment_id, participant_id) values
  ('99999999-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000051', gen_random_uuid())$$, 'participant_id must be a real participant (FK)');
select expect((select retention_until::date from public.recordings limit 1) = (now() + interval '30 days')::date, 'raw audio retention defaults to 30 days');

-- ── consents: per-call AUDIT rows written by the server from the single per-person consent (001: user_consents) ──
set role authenticated;
select as_user('00000000-0000-4000-8000-000000000051');
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'recording', true, '2026-10', auth.uid())$$,
  'the browser cannot insert consents any more (server only, from user_consents)');
select expect((public.grant_recording_consent(public.tc_consent_version())->>'recorded')::boolean, 'student gives the single consent (001)');
select as_user('00000000-0000-4000-8000-000000000052');
select expect((public.grant_recording_consent(public.tc_consent_version(), true, 'Laura Pérez', 'guardian@x.com', true)->>'recorded')::boolean, 'minor gives it with guardian name + email + the declaration that the guardian agrees (P-10: declared by the student)');
reset role;
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id, user_consent_id)
  select 'dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'recording', true, c.version, c.user_id, c.id
    from public.user_consents c where c.user_id = '00000000-0000-4000-8000-000000000051' and c.revoked_at is null;
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', '00000000-0000-4000-8000-000000000052')$$,
  'server cannot record a minor''s "yes" as self-given');
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', 'guardian', '00000000-0000-4000-8000-000000000062')$$,
  'guardian consent requires guardian name and email');
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', false, '2026-10', '00000000-0000-4000-8000-000000000052');
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by, given_by_user_id, guardian_name, guardian_email, user_consent_id)
  select 'dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, c.version, 'guardian',
         '00000000-0000-4000-8000-000000000062', c.guardian_name, c.guardian_email, c.id
    from public.user_consents c where c.user_id = '00000000-0000-4000-8000-000000000052' and c.revoked_at is null;
select expect((select count(*) from public.consents where user_consent_id is not null) = 2, 'audit rows point to the single consent they come from');

set role authenticated;
select as_user('00000000-0000-4000-8000-000000000051');
select expect_denied($$update public.consents set granted = false$$, 'consents are append-only (no update)');
select expect_denied($$delete from public.consents$$, 'consents are append-only (no delete)');
select expect((select count(*) from public.consents) = 1, 'student sees only their own audit row');

select as_user('00000000-0000-4000-8000-000000000062');
select expect_denied($$select count(*) from public.student_insights$$, 'guardian: no direct access to insights');
select expect((select count(*) from public.transcript_segments) = 1, 'guardian sees only the minor''s transcript');
select public.revoke_consent((select id from public.consents where given_by = 'guardian'));
select expect((select revoked_at is not null from public.consents where given_by = 'guardian'), 'guardian can revoke via revoke_consent()');
select as_user('00000000-0000-4000-8000-000000000052');
select expect(public.my_consent()->>'status' = 'revoked', 'revoking in a call also revokes the person''s single consent (asked again next class)');

-- ── visibility ──
select as_user('00000000-0000-4000-8000-000000000051');
select expect((select count(*) from public.live_sessions) = 1, 'student sees the session they are in');
select expect((select count(*) from public.session_participants) = 1, 'student sees only own participant row');
select expect_denied($$select count(*) from public.student_insights$$, 'student: no direct access to insights (RPCs only)');
select expect_denied($$select count(*) from public.teacher_insights$$, 'student never reads teacher insights');
select expect(json_array_length(public.my_insights()) = 1, 'student sees own insight (my_insights)');
select expect(public.my_insights()::text not like '%s2%', 'student does not see the classmate''s insight');
select expect(public.my_insight((select (public.my_insights()->0->>'id')::uuid))->>'message' = 'Bien, Sofía', 'student sees the published message');
select expect((select count(*) from public.recordings) = 1 and (select count(*) from public.transcript_segments) = 1, 'student sees only own recording/transcript');
select expect_denied($$insert into public.recordings(session_id, participant_id, storage_path)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'x')$$, 'browser cannot insert recordings');
select expect_denied($$update public.student_insights set teacher_message = 'hack'$$, 'student cannot edit insights');
select expect_denied($$select public.get_session_insights('99999999-0000-4000-8000-000000000001')$$, 'student cannot open the class view');

select as_user('00000000-0000-4000-8000-0000000000a1');
select expect((select count(*) from public.session_participants) = 3, 'teacher sees whole roster');
select expect(json_array_length(public.get_session_insights('99999999-0000-4000-8000-000000000001')->'students') = 2, 'teacher sees all student insights (RPC)');
select expect((select count(*) from public.consents) = 3, 'teacher sees consents of the session');
select public.save_insight_message((select (s->>'id')::uuid from json_array_elements(public.get_session_insights('99999999-0000-4000-8000-000000000001')->'students') s where s->>'name' = 'Mateo'), 'Great job!', true);
select public.save_teacher_reflection('99999999-0000-4000-8000-000000000001', 'I will wait longer after questions.');
select expect((public.get_session_insights('99999999-0000-4000-8000-000000000001')->'teacher'->>'reflection') like 'I will%', 'teacher edits own reflection');
select expect_denied($$update public.teacher_insights set data = '{}'$$, 'teacher cannot rewrite AI data');
select expect_denied($$update public.live_sessions set teacher_id = '00000000-0000-4000-8000-0000000000a2'$$, 'cannot hand the session to another teacher');

select as_user('00000000-0000-4000-8000-0000000000a2');
select expect((select count(*) from public.live_sessions) = 0, 'other teacher of same school sees nothing');
select expect_denied($$update public.live_sessions set title = 'x'$$, 'other teacher cannot edit');

select as_user('00000000-0000-4000-8000-0000000000ad');
select expect((select count(*) from public.live_sessions) = 1 and (public.get_session_insights('99999999-0000-4000-8000-000000000001')->'teacher') is not null, 'institution admin sees sessions + teacher insights of their institution');
select expect_denied($$select public.save_teacher_reflection('99999999-0000-4000-8000-000000000001', 'x')$$, 'admin cannot edit teacher reflection');

select as_user('00000000-0000-4000-8000-0000000000bd');
select expect((select count(*) from public.live_sessions) + (select count(*) from public.consents) = 0, 'admin of another institution sees nothing');
select expect_denied($$select public.get_session_insights('99999999-0000-4000-8000-000000000001')$$, 'admin of another institution cannot open the insights');

select as_user('00000000-0000-4000-8000-0000000000ee');
select expect((select count(*) from public.live_sessions) + (select count(*) from public.session_participants)
              + (select count(*) from public.recordings) = 0, 'stranger sees nothing');

select as_user('00000000-0000-4000-8000-000000000062');
-- TODO(live): guardians (session_participants.guardian_user_id) get read access to the minor's published insight
-- when recording is activated; today insights are read only by the student (own enrollment), staff and admins.
select expect(json_array_length(public.my_insights()) = 0, 'guardian has no insight access yet (TODO when recording is active)');

reset role;
set role anon;
select as_user('');
select expect_denied($$select count(*) from public.live_sessions$$, 'anon has no access');
reset role;
select expect((select count(*) from public.recordings_due_for_deletion()) = 0, 'nothing due for deletion yet');
select 'ALL LIVE-CLASS RLS TESTS PASSED' as result;
