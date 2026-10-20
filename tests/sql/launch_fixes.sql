-- Pre-launch audit fixes (2026-10, 001_base.sql "AUDITORÍA PRE-LANZAMIENTO"): registration by link off by default (TC-02),
-- invitations of existing accounts need the person's acceptance (TC-07) + expiry / cancel / resend / list (TC-16, P-04),
-- e-mail send caps (TC-08), per-IP rate limit (TC-01), ad-hoc live rooms (TC-13), display name from the database (TC-27),
-- class document caps (TC-14), plan attached to a calendar class (P-06), data export / account deletion check (TC-21),
-- search_path with pg_temp (TC-28) and the profiles(institution_id) index (TC-25).
-- Run after stub + 001_base.sql (alone or after the other suites: own "lf-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists ql cascade;
create schema ql;
grant usage on schema ql to anon, authenticated, service_role;
create table ql.results(n serial, label text, ok boolean, detail text);
grant all on ql.results to anon, authenticated, service_role; grant all on sequence ql.results_n_seq to anon, authenticated, service_role;
create function ql.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
create function ql.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into ql.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into ql.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function ql.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into ql.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into ql.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema ql to anon, authenticated, service_role;
create function ql.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function ql.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function ql.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function ql.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
create function ql.prof(e text) returns text language sql security definer as
$$ select p.role||':'||coalesce((select slug from public.institutions i where i.id = p.institution_id), '-') from public.profiles p where lower(p.email) = lower(e) $$;
create function ql.plan(t text) returns uuid language sql security definer as $$ select id from public.plannings where title = t limit 1 $$;
create function ql.inv(e text) returns uuid language sql security definer as $$ select id from public.invitations where lower(email) = lower(e) order by created_at desc limit 1 $$;
grant execute on function ql.inst(text), ql.uid(text), ql.grp(text), ql.sess(text), ql.prof(text), ql.inv(text), ql.plan(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== TC-02: registration by link is OFF by default =====
set role authenticated; select ql.as_user(:'OWNER');
select ql.eq('S: superadmin creates the tree', $$select (public.create_institution('LF Madre','lf-madre','lf-adm@x.com') is not null
  and public.create_institution('LF Sede 1','lf-s1','lf-s1adm@x.com',null,ql.inst('lf-madre')) is not null
  and public.create_institution('LF Sede 2','lf-s2','lf-s2adm@x.com',null,ql.inst('lf-madre')) is not null
  and public.create_institution('LF Otra','lf-otra','lf-oadm@x.com') is not null)::text$$, 'true');
select ql.eq('TC-02: new institutions and units start closed (invitation only)', $$select string_agg(open_registration::text, ',') from public.institutions where slug like 'lf-%'$$, 'false,false,false,false');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'lf-adm@x.com','{"name":"LF Admin"}',now()),
  (gen_random_uuid(),'lf-s1adm@x.com','{"name":"LF Admin S1"}',now()),
  (gen_random_uuid(),'lf-s2adm@x.com','{"name":"LF Admin S2"}',now()),
  (gen_random_uuid(),'lf-oadm@x.com','{"name":"LF Admin Otra"}',now()),
  (gen_random_uuid(),'lf-stranger@x.com','{"org_slug":"lf-madre","name":"Stranger"}',now());
select ql.eq('TC-02: a stranger who knows the /org/ link does NOT join (closed by default)', $$select ql.prof('lf-stranger@x.com')$$, 'teacher:-');
set role anon; select ql.as_user('');
select ql.eq('TC-02: the public branding says registration is closed', $$select open_registration::text from public.get_org_branding('lf-madre')$$, 'false');
reset role;
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-02: the admin can open it explicitly', $$with x as (update public.institutions set open_registration = true where slug = 'lf-s1' returning 1) select count(*)::text from x$$, '1');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'lf-t1@x.com','{"org_slug":"lf-s1","name":"LF Teacher One"}',now());
select ql.eq('TC-02: …then the link works for that unit', $$select ql.prof('lf-t1@x.com')$$, 'teacher:lf-s1');
update public.institutions set open_registration = false where slug = 'lf-s1';
select ql.eq('TC-25: index on profiles(institution_id)', $$select count(*)::text from pg_indexes where schemaname = 'public' and indexname = 'profiles_institution_idx'$$, '1');

-- ===== TC-07: an existing account is never moved by an invitation =====
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'lf-student@x.com','{"via":"student_link","name":"Stu"}',now()),
  (gen_random_uuid(),'lf-loner@x.com','{"name":"Loner"}',now()),
  (gen_random_uuid(),'lf-loner2@x.com','{"name":"Loner Two"}',now());
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-07: inviting a STUDENT account as org_admin → pending (not moved)', $$select public.invite_member(ql.inst('lf-s1'), 'LF-Student@x.com', 'org_admin')$$, 'pending');
select ql.eq('TC-07: …the student is still a student, without a unit', $$select ql.prof('lf-student@x.com')$$, 'student:-');
select ql.eq('TC-07: inviting a teacher without an institution → pending', $$select public.invite_member(ql.inst('lf-s1'), 'lf-loner@x.com', 'teacher')$$, 'pending');
select ql.eq('TC-07: …not moved', $$select ql.prof('lf-loner@x.com')$$, 'teacher:-');
select ql.eq('TC-07: reorganising my own teacher inside my account is still direct', $$select public.invite_member(ql.inst('lf-s2'), 'lf-t1@x.com', 'teacher')$$, 'added');
select ql.eq('TC-07: …moved to Sede 2', $$select ql.prof('lf-t1@x.com')$$, 'teacher:lf-s2');
select ql.eq('TC-07: the admin sees the pending invitations (list_invitations)', $$select string_agg(x->>'email'||':'||(x->>'status')||':'||(x->>'has_account'), ',' order by x->>'email') from json_array_elements(public.list_invitations(ql.inst('lf-madre'))) x where x->>'email' like 'lf-%' and x->>'email' not like '%adm%'$$, 'lf-loner@x.com:pending:true,lf-student@x.com:pending:true');
select ql.fails('TC-07: admins can no longer write invitations directly', $$insert into public.invitations(email, institution_id, role, user_id) values ('x@x.com', ql.inst('lf-s1'), 'org_admin', ql.uid('lf-loner2@x.com'))$$, 'row-level security');
select ql.as_user(:'OWNER');
select ql.eq('TC-07: even the super admin only creates a pending invitation for an existing account', $$select public.invite_member(ql.inst('lf-otra'), 'lf-loner2@x.com', 'org_admin')$$, 'pending');
select ql.eq('TC-07: …not moved', $$select ql.prof('lf-loner2@x.com')$$, 'teacher:-');
reset role;
-- the invited person
set role authenticated; select ql.as_user(ql.uid('lf-student@x.com')::text);
select ql.eq('TC-07: the student sees the invitation (unit, role, who invited)', $$select (x->>'unit_name')||':'||(x->>'role')||':'||(x->>'invited_by') from json_array_elements(public.my_invitations()) x$$, 'LF Sede 1:org_admin:LF Admin');
select ql.eq('TC-07: …and can read only their own invitation rows', $$select count(*)::text from public.invitations$$, '1');
select ql.eq('TC-07: the student declines', $$select public.respond_invitation(ql.inv('lf-student@x.com'), false)->>'status'$$, 'declined');
select ql.eq('TC-07: …still a student', $$select ql.prof('lf-student@x.com')$$, 'student:-');
select ql.eq('TC-07: …nothing pending any more', $$select json_array_length(public.my_invitations())::text$$, '0');
select ql.fails('TC-07: a declined invitation cannot be accepted later', $$select public.respond_invitation(ql.inv('lf-student@x.com'), true)$$, 'ya no está vigente');
select ql.as_user(ql.uid('lf-loner2@x.com')::text);
select ql.fails('TC-07: nobody else can answer someone''s invitation', $$select public.respond_invitation(ql.inv('lf-loner@x.com'), true)$$, 'No autorizado');
select ql.as_user(ql.uid('lf-loner@x.com')::text);
select ql.eq('TC-07: the teacher accepts', $$select public.respond_invitation(ql.inv('lf-loner@x.com'), true)->>'status'$$, 'accepted');
select ql.eq('TC-07: …now teacher of Sede 1', $$select ql.prof('lf-loner@x.com')$$, 'teacher:lf-s1');
reset role;
select ql.eq('TC-07: an existing account invited before keeps no other pending invitation after accepting', $$select count(*)::text from public.invitations where user_id = ql.uid('lf-loner@x.com') and public.tc_inv_status(invitations) = 'pending'$$, '0');

-- ===== TC-16: expiry, cancel, resend =====
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-16: invite a new email → invited', $$select public.invite_member(ql.inst('lf-s1'), 'lf-new@x.com', 'teacher')$$, 'invited');
select ql.eq('TC-16: …expires in ~14 days', $$select (expires_at between now() + interval '13 days' and now() + interval '15 days')::text from public.invitations where email = 'lf-new@x.com'$$, 'true');
select ql.eq('TC-16: cancel', $$select public.cancel_invitation(ql.inv('lf-new@x.com'))$$, 'cancelled');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'lf-new@x.com','{"name":"New"}',now());
select ql.eq('TC-16: a cancelled invitation is not applied at sign-up', $$select ql.prof('lf-new@x.com')$$, 'teacher:-');
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-16: invite another new email', $$select public.invite_member(ql.inst('lf-s1'), 'lf-late@x.com', 'teacher')$$, 'invited');
reset role;
update public.invitations set expires_at = now() - interval '1 minute' where email = 'lf-late@x.com';
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-16: …shows as expired', $$select x->>'status' from json_array_elements(public.list_invitations(ql.inst('lf-s1'))) x where x->>'email' = 'lf-late@x.com'$$, 'expired');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'lf-late@x.com','{"name":"Late"}',now());
select ql.eq('TC-16: an expired invitation is not applied at sign-up', $$select ql.prof('lf-late@x.com')$$, 'teacher:-');
reset role;
delete from auth.users where email = 'lf-late@x.com';
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-16: resend makes it valid again for 14 days', $$select (public.resend_invitation(ql.inv('lf-late@x.com'))->>'email')||':'||(select x->>'status' from json_array_elements(public.list_invitations(ql.inst('lf-s1'))) x where x->>'email' = 'lf-late@x.com')$$, 'lf-late@x.com:expired');
select ql.eq('TC-16: …pending again', $$select x->>'status' from json_array_elements(public.list_invitations(ql.inst('lf-s1'))) x where x->>'email' = 'lf-late@x.com'$$, 'pending');
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'lf-late@x.com','{"name":"Late"}',now());
select ql.eq('TC-16: …and applied at sign-up', $$select ql.prof('lf-late@x.com')$$, 'teacher:lf-s1');
set role authenticated; select ql.as_user(ql.uid('lf-s2adm@x.com')::text);
select ql.fails('P-04: a sibling admin cannot list Sede 1''s invitations', $$select public.list_invitations(ql.inst('lf-s1'))$$, 'No autorizado');
select ql.fails('P-04: …nor cancel them', $$select public.cancel_invitation(ql.inv('lf-new@x.com'))$$, 'No autorizado');
select ql.fails('P-04: …nor resend them', $$select public.resend_invitation(ql.inv('lf-new@x.com'))$$, 'No autorizado');
select ql.as_user(ql.uid('lf-t1@x.com')::text);
select ql.fails('P-04: a teacher cannot list invitations', $$select public.list_invitations(ql.inst('lf-s2'))$$, 'No autorizado');
select ql.eq('P-04: …nor read them', $$select count(*)::text from public.invitations$$, '0');
select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.fails('P-04: an accepted invitation cannot be cancelled', $$select public.cancel_invitation(ql.inv('lf-late@x.com'))$$, 'ya fue aceptada');
select public.invite_member(ql.inst('lf-s1'), 'lf-mail@x.com', 'teacher');
select ql.eq('TC-08: invitation e-mail payload for its admin', $$select public.invitation_notify_payload(ql.inv('lf-mail@x.com'))->>'unit_name'$$, 'LF Sede 1');
select ql.fails('TC-08: …not for a cancelled one', $$select public.invitation_notify_payload(ql.inv('lf-new@x.com'))$$, 'No autorizado');
select ql.as_user(ql.uid('lf-s2adm@x.com')::text);
select ql.fails('TC-08: …nor for another unit''s admin', $$select public.invitation_notify_payload(ql.inv('lf-mail@x.com'))$$, 'No autorizado');
reset role;

-- ===== TC-08: e-mail send caps (per person per day, max recipients) =====
set role authenticated; select ql.as_user(ql.uid('lf-loner@x.com')::text);
select ql.eq('TC-08: more than 100 recipients in one send → refused', $$select public.email_quota_take('session', 101)->>'reason'$$, 'too_many_recipients');
select ql.fails('TC-08: unknown kind', $$select public.email_quota_take('spam', 1)$$, 'Tipo inválido');
select ql.eq('TC-08: a teacher can send 250 recipients today', $$select (public.email_quota_take('session', 100)->>'allowed')||(public.email_quota_take('session', 100)->>'allowed')||(public.email_quota_take('session', 50)->>'allowed')$$, 'truetruetrue');
select ql.eq('TC-08: …but not 100 more (300 / day)', $$select public.email_quota_take('session', 100)->>'reason'$$, 'daily_recipients');
select ql.as_user(ql.uid('lf-student@x.com')::text);
select ql.eq('TC-08: a student: 3 sends a day', $$select (public.email_quota_take('guardian', 1)->>'allowed')||(public.email_quota_take('guardian', 1)->>'allowed')||(public.email_quota_take('guardian', 1)->>'allowed')||(public.email_quota_take('guardian', 1)->>'reason')$$, 'truetruetruedaily_sends');
reset role;
set role anon; select ql.as_user('');
select ql.fails('TC-08: anon cannot take e-mail quota', $$select public.email_quota_take('session', 1)$$, 'permission denied');
reset role;

-- ===== TC-01: per-IP rate limit (HMAC key from the server, never the IP) =====
set role authenticated; select ql.as_user(ql.uid('lf-loner@x.com')::text);
select ql.fails('TC-01: a raw IP is refused as key', $$select public.ip_rate_hit('ai:203.0.113.5', 10, 60)$$, 'Clave inválida');
select ql.fails('TC-01: absurd limits refused', $$select public.ip_rate_hit('ai:'||repeat('a', 64), 0, 60)$$, 'Límite inválido');
select ql.eq('TC-01: 3 hits allowed with limit 3, the 4th refused', $$select string_agg(public.ip_rate_hit('ai:'||repeat('b', 64), 3, 3600)::text, ',') from generate_series(1, 4)$$, 'true,true,true,false');
select ql.eq('TC-01: another IP key is independent', $$select public.ip_rate_hit('ai:'||repeat('c', 64), 3, 3600)::text$$, 'true');
select ql.fails('TC-01: nobody reads the counters directly', $$select count(*) from public.rate_counters$$, 'permission denied');
reset role;
set role anon; select ql.as_user('');
select ql.fails('TC-01: anon cannot call ip_rate_hit', $$select public.ip_rate_hit('ai:'||repeat('d', 64), 3, 60)$$, 'permission denied');
reset role;

-- ===== groups + a class for the live room / plan / document =====
set role authenticated; select ql.as_user(ql.uid('lf-adm@x.com')::text);
select public.create_group(ql.inst('lf-s1'), 'LF G1', ql.uid('lf-loner@x.com'));
select public.add_student(null, 'lf-kid@x.com', 'Kid Loaded Name', ql.grp('LF G1'));
reset role;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (gen_random_uuid(),'lf-kid@x.com','{"via":"student_link","name":"Kiddo"}',now());
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u where lower(u.email) = lower(e.email) and lower(e.email) = 'lf-kid@x.com';
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone)
select g.institution_id, g.id, g.teacher_id, 'LF now', now() - interval '5 minutes', now() + interval '40 minutes', 'America/Montevideo' from public.class_groups g where g.name = 'LF G1';
insert into public.plannings (owner_id, institution_id, title, data) values
  (ql.uid('lf-loner@x.com'), ql.inst('lf-s1'), 'Fotosíntesis 2°', '{"content":"Fotosíntesis\nObjetivos de hoy:\n- Explicar\nRespuestas:\n1. luz","params":{"subjects":["Biología"]}}'),
  (ql.uid('lf-t1@x.com'), ql.inst('lf-s2'), 'Plan ajeno', '{"content":"x"}');

-- ===== P-06: plan attached to a calendar class =====
set role authenticated; select ql.as_user(ql.uid('lf-loner@x.com')::text);
select ql.eq('P-06: the teacher attaches their saved class', $$select public.set_session_plan(ql.sess('LF now'), ql.plan('Fotosíntesis 2°'))->>'planning_title'$$, 'Fotosíntesis 2°');
select ql.fails('P-06: …not someone else''s plan', $$select public.set_session_plan(ql.sess('LF now'), ql.plan('Plan ajeno'))$$, 'no es tuya');
select ql.eq('P-06: the room reads THAT plan (teacher guide)', $$select (public.session_plan(ql.sess('LF now'))->>'title')||'|'||(public.session_plan(ql.sess('LF now'))->>'content' like 'Fotosíntesis%')$$, 'Fotosíntesis 2°|true');
select ql.eq('P-06: the calendar row shows the plan to the teacher', $$select x->>'planning_title' from json_array_elements(public.my_calendar(now() - interval '1 day', now() + interval '1 day')) x where x->>'title' = 'LF now'$$, 'Fotosíntesis 2°');
select ql.as_user(ql.uid('lf-kid@x.com')::text);
select ql.eq('P-06: a student never gets the teacher guide (answers)', $$select coalesce(public.session_plan(ql.sess('LF now'))::text, 'null')$$, 'null');
select ql.eq('P-06: …nor the plan in their calendar', $$select coalesce(x->>'planning_id', 'none') from json_array_elements(public.my_calendar(now() - interval '1 day', now() + interval '1 day')) x where x->>'title' = 'LF now'$$, 'none');
select ql.fails('P-06: a student cannot attach a plan', $$select public.set_session_plan(ql.sess('LF now'), null)$$, 'No autorizado');
select ql.as_user(ql.uid('lf-t1@x.com')::text);
select ql.fails('P-06: a teacher of another group cannot attach', $$select public.set_session_plan(ql.sess('LF now'), ql.plan('Plan ajeno'))$$, 'No autorizado');
select ql.as_user(ql.uid('lf-loner@x.com')::text);
select ql.eq('P-06: detach', $$select coalesce(public.set_session_plan(ql.sess('LF now'), null)->>'planning_id', 'none')$$, 'none');
select ql.eq('P-06: …no plan any more', $$select coalesce(public.session_plan(ql.sess('LF now'))::text, 'null')$$, 'null');
select public.set_session_plan(ql.sess('LF now'), ql.plan('Fotosíntesis 2°'));
reset role;
delete from public.plannings where title = 'Fotosíntesis 2°';
select ql.eq('P-06: deleting the plan leaves the class without plan', $$select coalesce(planning_id::text, 'none') from public.class_sessions where title = 'LF now'$$, 'none');

-- ===== TC-13 / TC-27: ad-hoc live rooms and the display name =====
set role authenticated; select ql.as_user(ql.uid('lf-loner@x.com')::text);
select set_config('ql.key', left(replace(ql.uid('lf-loner@x.com')::text, '-', ''), 12), false);
select ql.eq('TC-13: the creator hosts their ad-hoc room', $$select public.adhoc_room_access(current_setting('ql.key'))$$, 'host');
select ql.eq('TC-27: display name from the profile', $$select public.live_display_name(null)$$, 'Loner');
select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-13: staff of the same account join as guest', $$select public.adhoc_room_access(current_setting('ql.key'))$$, 'guest');
select ql.as_user(ql.uid('lf-oadm@x.com')::text);
select ql.eq('TC-13: staff of another institution → no access', $$select coalesce(public.adhoc_room_access(current_setting('ql.key')), 'none')$$, 'none');
select ql.as_user(ql.uid('lf-kid@x.com')::text);
select ql.eq('TC-13: a student → no access to ad-hoc rooms', $$select coalesce(public.adhoc_room_access(current_setting('ql.key')), 'none')$$, 'none');
select ql.eq('TC-27: a student''s name in the room = the name the institution loaded', $$select public.live_display_name(ql.sess('LF now'))$$, 'Kid Loaded Name');
select ql.as_user(ql.uid('lf-stranger@x.com')::text);
select ql.eq('TC-13: an account without institution → no access', $$select coalesce(public.adhoc_room_access(current_setting('ql.key')), 'none')$$, 'none');
select ql.eq('TC-13: a malformed key → no access', $$select coalesce(public.adhoc_room_access('x'' or 1=1'), 'none')$$, 'none');
reset role;

-- ===== TC-14: class document caps =====
set role authenticated; select ql.as_user(ql.uid('lf-kid@x.com')::text);
select ql.eq('TC-14: a normal change is accepted', $$select (public.classdoc_push(ql.sess('LF now'), 1, encode('hola', 'base64'), 'c1')->>'id' is not null)::text$$, 'true');
reset role;
update public.class_docs set bytes = 20971520 - 2 where session_id = ql.sess('LF now');
set role authenticated; select ql.as_user(ql.uid('lf-kid@x.com')::text);
select ql.fails('TC-14: a document over 20 MB refuses more changes', $$select public.classdoc_push(ql.sess('LF now'), 1, encode('hola', 'base64'), 'c1')$$, 'tamaño máximo');
reset role;
update public.class_docs set bytes = 0 where session_id = ql.sess('LF now');
select ql.eq('TC-14: per-person rate counter (4 MB / minute)', $$select (public.tc_rate_take('test:x', 4000000, 4194304, 60) and not public.tc_rate_take('test:x', 300000, 4194304, 60))::text$$, 'true');

-- ===== TC-21: my data / account deletion check =====
set role authenticated; select ql.as_user(ql.uid('lf-kid@x.com')::text);
select ql.eq('TC-21: export contains my enrollment (name as loaded) and nobody else''s', $$select (public.my_data_export()->'enrollments'->0->>'name')||'/'||(public.my_data_export()::text not like '%lf-loner%')$$, 'Kid Loaded Name/true');
select ql.eq('TC-21: a student can delete their account', $$select public.account_delete_check()->>'ok'$$, 'true');
select ql.as_user(ql.uid('lf-adm@x.com')::text);
select ql.eq('TC-21: the last admin of a main institution cannot', $$select public.account_delete_check()->>'reason'$$, 'last_admin');
select ql.as_user(:'OWNER');
select ql.eq('TC-21: the super admin cannot', $$select public.account_delete_check()->>'reason'$$, 'superadmin');
reset role;
set role anon; select ql.as_user('');
select ql.fails('TC-21: anon cannot export', $$select public.my_data_export()$$, 'permission denied');
reset role;

-- ===== TC-28: every security definer function pins search_path with pg_temp last =====
select ql.eq('TC-28: no SECURITY DEFINER function without pg_temp in its search_path', $$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=public, pg_temp')$$, '0');

select n, case when ok then 'ok' else '**FAIL**' end as result, label, detail from ql.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from ql.results;
