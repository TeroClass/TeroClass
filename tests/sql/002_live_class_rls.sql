-- RLS tests for supabase/migrations/002_live_class.sql on a local Postgres 16 with Supabase stubs.
-- Usage (fresh database): psql -v ON_ERROR_STOP=1 -f stub.sql -f 001_base.sql -f 002_live_class.sql -f tests/sql/002_live_class_rls.sql
-- Any failed expectation raises an exception (non-zero exit with ON_ERROR_STOP=1).
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
insert into public.plannings(id, owner_id, institution_id, title) values
  ('cccccccc-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'T1 plan'),
  ('cccccccc-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'T2 plan');

-- ── teacher t1 creates a session ──
set role authenticated;
select as_user('00000000-0000-4000-8000-0000000000a1');
insert into public.live_sessions(id, teacher_id, institution_id, planning_id, title, livekit_room)
  values ('dddddddd-0000-4000-8000-000000000001', auth.uid(), 'bbbbbbbb-0000-4000-8000-000000000001',
          'cccccccc-0000-4000-8000-0000000000a1', 'Chemistry 3B', 'room-t1-a');
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
insert into public.student_insights(session_id, participant_id, data, published_at) values
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', '{"recap":"s1"}', now()),
  ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', '{"recap":"s2"}', null);
insert into public.teacher_insights(session_id, data) values ('dddddddd-0000-4000-8000-000000000001', '{"areas":13}');
select expect((select retention_until::date from public.recordings limit 1) = (now() + interval '30 days')::date, 'raw audio retention defaults to 30 days');

-- ── consents ──
set role authenticated;
select as_user('00000000-0000-4000-8000-000000000051');
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'recording', true, '2026-10', auth.uid());
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', auth.uid())$$,
  'student cannot consent for someone else');
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', 'recording', true, '2026-10', auth.uid())$$,
  'student cannot consent for an adult participant either (RLS)');
select expect_denied($$update public.consents set granted = false$$, 'consents are append-only (no update)');
select expect_denied($$delete from public.consents$$, 'consents are append-only (no delete)');

select as_user('00000000-0000-4000-8000-000000000052');
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', auth.uid())$$,
  'minor cannot self-consent');
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', false, '2026-10', auth.uid());
select expect(true, 'minor can record a refusal (granted=false)');

select as_user('00000000-0000-4000-8000-000000000062');
select expect_denied($$insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by, given_by_user_id)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', 'guardian', auth.uid())$$,
  'guardian consent requires guardian name and email');
insert into public.consents(session_id, participant_id, kind, granted, policy_version, given_by, given_by_user_id, guardian_name, guardian_email)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000052', 'recording', true, '2026-10', 'guardian', auth.uid(), 'Laura Pérez', 'guardian@x.com');
select expect(true, 'guardian can consent for the minor');
select expect((select count(*) from public.student_insights) = 0, 'guardian does not see unpublished insights');
select expect((select count(*) from public.transcript_segments) = 1, 'guardian sees only the minor''s transcript');
select public.revoke_consent((select id from public.consents where given_by = 'guardian'));
select expect((select revoked_at is not null from public.consents where given_by = 'guardian'), 'guardian can revoke via revoke_consent()');

-- ── visibility ──
select as_user('00000000-0000-4000-8000-000000000051');
select expect((select count(*) from public.live_sessions) = 1, 'student sees the session they are in');
select expect((select count(*) from public.session_participants) = 1, 'student sees only own participant row');
select expect((select count(*) from public.student_insights) = 1, 'student sees own published insight');
select expect((select count(*) from public.teacher_insights) = 0, 'student never sees teacher insights');
select expect((select count(*) from public.recordings) = 1 and (select count(*) from public.transcript_segments) = 1, 'student sees only own recording/transcript');
select expect_denied($$insert into public.recordings(session_id, participant_id, storage_path)
  values ('dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000051', 'x')$$, 'browser cannot insert recordings');
select expect_denied($$update public.student_insights set teacher_message = 'hack'$$, 'student cannot edit insights');

select as_user('00000000-0000-4000-8000-0000000000a1');
select expect((select count(*) from public.session_participants) = 3, 'teacher sees whole roster');
select expect((select count(*) from public.student_insights) = 2, 'teacher sees all student insights');
select expect((select count(*) from public.consents) = 3, 'teacher sees consents of the session');
update public.student_insights set teacher_message = 'Great job!', published_at = now()
  where participant_id = 'eeeeeeee-0000-4000-8000-000000000052';
update public.teacher_insights set teacher_reflection = 'I will wait longer after questions.';
select expect((select teacher_reflection from public.teacher_insights) like 'I will%', 'teacher edits own reflection');
select expect_denied($$update public.teacher_insights set data = '{}'$$, 'teacher cannot rewrite AI data');
select expect_denied($$update public.live_sessions set teacher_id = '00000000-0000-4000-8000-0000000000a2'$$, 'cannot hand the session to another teacher');

select as_user('00000000-0000-4000-8000-0000000000a2');
select expect((select count(*) from public.live_sessions) = 0, 'other teacher of same school sees nothing');
select expect_denied($$update public.live_sessions set title = 'x'$$, 'other teacher cannot edit');

select as_user('00000000-0000-4000-8000-0000000000ad');
select expect((select count(*) from public.live_sessions) = 1 and (select count(*) from public.teacher_insights) = 1, 'institution admin sees sessions + teacher insights of their institution');
select expect_denied($$update public.teacher_insights set teacher_reflection = 'x'$$, 'admin cannot edit teacher reflection');

select as_user('00000000-0000-4000-8000-0000000000bd');
select expect((select count(*) from public.live_sessions) + (select count(*) from public.student_insights)
              + (select count(*) from public.consents) = 0, 'admin of another institution sees nothing');

select as_user('00000000-0000-4000-8000-0000000000ee');
select expect((select count(*) from public.live_sessions) + (select count(*) from public.session_participants)
              + (select count(*) from public.recordings) = 0, 'stranger sees nothing');

select as_user('00000000-0000-4000-8000-000000000062');
select expect((select count(*) from public.student_insights) = 1, 'guardian sees the minor''s insight once published');

reset role;
set role anon;
select as_user('');
select expect_denied($$select count(*) from public.live_sessions$$, 'anon has no access');
reset role;
select expect((select count(*) from public.recordings_due_for_deletion()) = 0, 'nothing due for deletion yet');
select 'ALL LIVE-CLASS RLS TESTS PASSED' as result;
