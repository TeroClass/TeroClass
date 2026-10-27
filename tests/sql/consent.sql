-- Recording consent (one checkbox per person, 001_base.sql "CONSENTIMIENTO DE GRABACIÓN"): user_consents privacy, grant /
-- revoke / version logic, minors need a guardian, consent_declines visibility (self, admin subtree, other admin, teacher,
-- classmate, anon, super admin), the admin overview (names as loaded, no cross-institution leaks, no guardian data),
-- badge count, Métricas totals and the service-only notification payload.
-- Run after stub + 001_base.sql (alone or after the other suites: own "cn-" units).
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
-- one person's row of consent_overview (as the caller)
create function qn.person(p_unit uuid, p_email text) returns json language sql as
$$ select x from json_array_elements(public.consent_overview(p_unit)->'people') x where lower(x->>'email') = lower(p_email) limit 1 $$;
grant execute on function qn.inst(text), qn.uid(text), qn.grp(text), qn.sess(text), qn.person(uuid, text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: CN Madre › CN Sede 1 ; CN Madre › CN Sede 2 ; CN Otra =====
set role authenticated; select qn.as_user(:'OWNER');
select qn.eq('S: superadmin creates the tree', $$select (public.create_institution('CN Madre','cn-madre','cn-adm@x.com') is not null
  and public.create_institution('CN Sede 1','cn-s1','cn-s1adm@x.com',null,qn.inst('cn-madre')) is not null
  and public.create_institution('CN Sede 2','cn-s2','cn-s2adm@x.com',null,qn.inst('cn-madre')) is not null
  and public.create_institution('CN Otra','cn-otra','cn-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('cn-otra','cn-s1','cn-s2') and not open_registration; -- 2026-10: sign-up by link is off by default (TC-02); opened explicitly here
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'cn-adm@x.com','{"name":"CN Admin"}',now()),
  (gen_random_uuid(),'cn-s1adm@x.com','{"name":"CN Admin S1"}',now()),
  (gen_random_uuid(),'cn-s2adm@x.com','{"name":"CN Admin S2"}',now()),
  (gen_random_uuid(),'cn-oadm@x.com','{"name":"CN Admin Otra"}',now()),
  (gen_random_uuid(),'cn-t1@x.com','{"org_slug":"cn-s1","name":"CN Teacher One"}',now()),
  (gen_random_uuid(),'cn-t2@x.com','{"org_slug":"cn-s2","name":"CN Teacher Two"}',now()),
  (gen_random_uuid(),'cn-to@x.com','{"org_slug":"cn-otra","name":"CN Teacher Otra"}',now()),
  (gen_random_uuid(),'cn-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'cn-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  (gen_random_uuid(),'cn-minor@x.com','{"via":"student_link","name":"Mini"}',now()),
  (gen_random_uuid(),'cn-minor2@x.com','{"via":"student_link","name":"Mina"}',now()),
  (gen_random_uuid(),'cn-x@x.com','{"via":"student_link","name":"Equis"}',now()),
  (gen_random_uuid(),'cn-st4@x.com','{"via":"student_link","name":"Dani"}',now()),
  (gen_random_uuid(),'cn-stranger@x.com','{"via":"student_link","name":"Stranger"}',now());

set role authenticated; select qn.as_user(qn.uid('cn-adm@x.com')::text);
select public.create_group(qn.inst('cn-s1'), 'CN G1', qn.uid('cn-t1@x.com'));
select public.create_group(qn.inst('cn-s2'), 'CN G2', qn.uid('cn-t2@x.com'));
select public.add_student(null, 'cn-st1@x.com', 'Ana Alonso', qn.grp('CN G1'));
select public.add_student(null, 'cn-st2@x.com', 'Beto Barrios', qn.grp('CN G1'));
select public.add_student(null, 'cn-minor@x.com', 'Mini Menor', qn.grp('CN G1'));
select public.add_student(null, 'cn-x@x.com', 'Equis Uno', qn.grp('CN G1'));
select public.add_student(null, 'cn-caro@x.com', 'Caro Sin Cuenta', qn.grp('CN G1'));
select public.add_student(null, 'cn-st4@x.com', 'Dani Díaz', qn.grp('CN G2'));
select public.add_student(null, 'cn-minor2@x.com', 'Mina Menor', qn.grp('CN G2'));
select qn.as_user(qn.uid('cn-oadm@x.com')::text);
select public.create_group(qn.inst('cn-otra'), 'CN GO', qn.uid('cn-to@x.com'));
select public.add_student(null, 'cn-x@x.com', 'Equis Otra', qn.grp('CN GO'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('cn-st1@x.com','cn-st2@x.com','cn-minor@x.com','cn-minor2@x.com','cn-x@x.com','cn-st4@x.com');
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone)
select g.institution_id, g.id, g.teacher_id, x.t, now() - interval '5 minutes', now() + interval '40 minutes', 'America/Montevideo'
  from (values ('CN G1', 'CN now'), ('CN GO', 'CN GO now'), ('CN G2', 'CN G2 now')) x(g, t) join public.class_groups g on g.name = x.g;

-- ===== U: user_consents — grant / revoke / version / privacy =====
set role authenticated; select qn.as_user(qn.uid('cn-st1@x.com')::text);
select qn.eq('U: version constant', $$select public.tc_consent_version()$$, '2026-10');
select qn.eq('U: first time → status none, not recorded', $$select (public.my_consent()->>'status')||'/'||(public.my_consent()->>'recorded')$$, 'none/false');
select qn.fails('U: grant with an old text version is rejected', $$select public.grant_recording_consent('2020-01')$$, 'cambió');
select qn.eq('U: grant (one checkbox) → granted', $$select public.grant_recording_consent('2026-10')->>'status'$$, 'granted');
select qn.eq('U: … and recorded', $$select public.my_consent()->>'recorded'$$, 'true');
select qn.eq('U: granting again → still granted', $$select public.grant_recording_consent('2026-10')->>'granted'$$, 'true');
select qn.eq('U: … keeps ONE active row (old one superseded)', $$select (select count(*) from public.user_consents)||'/'||(select count(*) from public.user_consents where revoked_at is null)$$, '2/1');
select qn.eq('U: RLS — a person reads only their own rows', $$select (select count(*) from public.user_consents where user_id <> auth.uid())::text$$, '0');
select qn.fails('U: no direct insert', $$insert into public.user_consents(user_id, version) values (auth.uid(), '2026-10')$$, 'permission denied');
select qn.fails('U: no direct update', $$update public.user_consents set version = 'x'$$, 'permission denied');
select qn.fails('U: no direct delete', $$delete from public.user_consents$$, 'permission denied');
select qn.as_user(qn.uid('cn-st2@x.com')::text);
select qn.eq('U: a classmate sees none of them', $$select count(*)::text from public.user_consents$$, '0');
select qn.eq('U: classmate status is still none', $$select public.my_consent()->>'status'$$, 'none');
select qn.as_user(qn.uid('cn-st1@x.com')::text);
select qn.eq('U: revoke from the profile → revoked', $$select public.revoke_recording_consent()->>'status'$$, 'revoked');
select qn.eq('U: … not recorded, revocation date kept (asked again next class)', $$select (public.my_consent()->>'recorded')||'/'||((public.my_consent()->>'revoked_at') is not null)$$, 'false/true');
select qn.eq('U: re-grant after revoking', $$select public.grant_recording_consent('2026-10')->>'status'$$, 'granted');
select qn.as_user(qn.uid('cn-st2@x.com')::text);
select public.grant_recording_consent('2026-10');
reset role;
update public.user_consents set version = '2025-01' where user_id = qn.uid('cn-st2@x.com');   -- consent given to an OLD text
set role authenticated; select qn.as_user(qn.uid('cn-st2@x.com')::text);
select qn.eq('U: version bump → outdated, not recorded (asked again)', $$select (public.my_consent()->>'status')||'/'||(public.my_consent()->>'recorded')$$, 'outdated/false');

-- minors
select qn.as_user(qn.uid('cn-minor@x.com')::text);
select qn.fails('M: minor without guardian name', $$select public.grant_recording_consent('2026-10', true, '', 'g@x.com', true)$$, 'nombre del tutor');
select qn.fails('M: minor with an invalid guardian email', $$select public.grant_recording_consent('2026-10', true, 'Laura Pérez', 'no-es-email', true)$$, 'email del tutor');
select qn.fails('M: the guardian''s email cannot be the minor''s own (P-10)', $$select public.grant_recording_consent('2026-10', true, 'Laura Pérez', 'CN-minor@x.com', true)$$, 'distinto del tuyo');
select qn.fails('M: minor without the guardian''s agreement (declared by the student)', $$select public.grant_recording_consent('2026-10', true, 'Laura Pérez', 'laura@x.com', false)$$, 'confirmar');
-- P-10 (2026-10, owner decision): the guardian's agreement is DECLARED by the student (not verified) and labelled so
select qn.eq('M: minor with guardian name + email + declaration → recorded', $$select public.grant_recording_consent('2026-10', true, 'Laura <b>Pérez</b>', 'laura@x.com', true)->>'recorded'$$, 'true');
select qn.eq('M: … flagged minor, guardian consent declared by the student', $$select (public.my_consent()->>'minor')||'/'||(public.my_consent()->>'guardian_consent')||'/'||(public.my_consent()->>'guardian_source')||'/'||(public.my_consent()->>'consent_managed')$$, 'true/true/student/false');
select qn.eq('M: my_consent never returns guardian data', $$select (public.my_consent()::text not ilike '%laura%')::text$$, 'true');
select qn.eq('M: guardian name stored cleaned (no HTML)', $$select guardian_name from public.user_consents where user_id = auth.uid() and revoked_at is null$$, 'Laura b Pérez /b');
select qn.eq('M: the guardian-link functions of an unreleased draft are gone', $$select count(*)::text from pg_proc where proname in ('guardian_consent_info','guardian_consent_respond','guardian_email_payload')$$, '0');
-- consent_managed_by_institution: the institution declares it collected the families' consent itself → no guardian data asked
select qn.as_user(qn.uid('cn-minor2@x.com')::text);
select qn.eq('M2: institution does not manage it yet → asked for guardian data', $$select public.my_consent()->>'consent_managed'$$, 'false');
select qn.fails('M2: … so guardian data is required', $$select public.grant_recording_consent('2026-10', true)$$, 'nombre del tutor');
select qn.fails('M2: a student cannot turn the option on', $$select public.set_consent_managed(qn.inst('cn-s2'), true)$$, 'No autorizado');
select qn.as_user(qn.uid('cn-s1adm@x.com')::text);
select qn.fails('M2: the admin of a sibling unit cannot either', $$select public.set_consent_managed(qn.inst('cn-s2'), true)$$, 'No autorizado');
select qn.as_user(qn.uid('cn-adm@x.com')::text);
select qn.eq('M2: the admin of the main institution turns it on (applies below)', $$select public.set_consent_managed(qn.inst('cn-madre'), true)::text$$, 'true');
select qn.as_user(qn.uid('cn-minor2@x.com')::text);
select qn.eq('M2: now consent_managed', $$select public.my_consent()->>'consent_managed'$$, 'true');
select qn.eq('M2: minor yes without guardian data → recorded', $$select public.grant_recording_consent('2026-10', true, 'ignored', 'ignored@x.com', false)->>'recorded'$$, 'true');
select qn.eq('M2: … source = institution', $$select public.my_consent()->>'guardian_source'$$, 'institution');
select qn.eq('M2: … no guardian data stored', $$select coalesce(guardian_name,'-')||'/'||coalesce(guardian_email,'-') from public.user_consents where user_id = auth.uid() and revoked_at is null$$, '-/-');
select qn.as_user(qn.uid('cn-adm@x.com')::text);
select qn.eq('M2: … the admin sees "managed by the institution"', $$select qn.person(qn.inst('cn-madre'), 'cn-minor2@x.com')->>'guardian_source'$$, 'institution');
select qn.eq('M2: turn it off again', $$select public.set_consent_managed(qn.inst('cn-madre'), false)::text$$, 'false');
select qn.as_user(qn.uid('cn-minor@x.com')::text);
reset role;
select qn.fails('M: the table itself refuses a minor without guardian', $$insert into public.user_consents(user_id, version, is_minor) values (qn.uid('cn-minor@x.com'), '2026-10', true)$$, 'user_consents_minor_guardian');
set role anon; select qn.as_user('');
select qn.fails('U: anon cannot read consent', $$select public.my_consent()$$, 'permission denied');
select qn.fails('U: anon cannot grant', $$select public.grant_recording_consent('2026-10')$$, 'permission denied');
select qn.fails('U: anon cannot read the table', $$select count(*) from public.user_consents$$, 'permission denied');
reset role;

-- ===== D: declines + justification =====
set role authenticated; select qn.as_user(qn.uid('cn-x@x.com')::text);
select qn.eq('D: student declines in a class of Sede 1 → addressed only to Sede 1 (not Otra, which also loaded them)',
  $$select public.decline_recording_consent(qn.sess('CN now'), 'Prefiero no ser grabado <b>por ahora</b>')->>'institutions'$$, '1');
select qn.eq('D: … stored for Sede 1', $$select count(*)||'/'||bool_and(institution_id = qn.inst('cn-s1')) from public.consent_declines where user_id = auth.uid()$$, '1/true');
select qn.eq('D: a "no" is not stored as an answer: still asked next time', $$select public.my_consent()->>'status'$$, 'none');
select qn.eq('D: same student declines in Otra''s class → Otra', $$select public.decline_recording_consent(qn.sess('CN GO now'), 'Tampoco en esta clase, gracias')->>'institutions'$$, '1');
select qn.eq('D: the person sees their own declines', $$select count(*)::text from public.consent_declines$$, '2');
select qn.as_user(qn.uid('cn-stranger@x.com')::text);
select qn.fails('D: someone outside the class cannot decline for it', $$select public.decline_recording_consent(qn.sess('CN now'), 'No estoy en esta clase')$$, 'No autorizado');
select qn.as_user(qn.uid('cn-st1@x.com')::text);
select qn.fails('D: someone who already consented cannot decline', $$select public.decline_recording_consent(qn.sess('CN now'), 'Cambié de opinión hoy')$$, 'Ya diste');
select qn.as_user(qn.uid('cn-t1@x.com')::text);
select qn.eq('D: teacher declines', $$select public.decline_recording_consent(qn.sess('CN now'), 'Hoy necesito un momento privado')->>'institutions'$$, '1');
select qn.eq('D: … role teacher, addressed to their unit', $$select role||':'||(institution_id = qn.inst('cn-s1')) from public.consent_declines where user_id = auth.uid()$$, 'teacher:true');
select qn.as_user(qn.uid('cn-st2@x.com')::text);
select qn.eq('D: outdated consent + decline without a class → addressed to all units that loaded them', $$select public.decline_recording_consent(null, 'No quiero que se grabe mi voz')->>'institutions'$$, '1');
select qn.eq('D: … the old "yes" is closed', $$select (public.my_consent()->>'status')||'/'||(select count(*) from public.user_consents where revoked_at is null)$$, 'none/0');
select qn.as_user(:'OWNER');
select qn.eq('D: super admin without a unit → row without institution', $$select (public.decline_recording_consent(null, 'Soy el dueño probando esto')->>'institutions')$$, '0');
reset role;
select qn.fails('D: table check: reason length (max 1000)', $$insert into public.consent_declines(user_id, version, reason) values (qn.uid('cn-x@x.com'), '2026-10', repeat('x', 1001))$$, 'consent_declines_reason_check');

-- visibility of the justifications (RLS select + consent_overview)
set role authenticated; select qn.as_user(qn.uid('cn-adm@x.com')::text);
select qn.eq('V: admin of the main institution (subtree) sees Sede 1 declines (student + teacher + no-class), not Otra''s',
  $$select count(*)::text from public.consent_declines$$, '3');
select qn.eq('V: overview lists the same 3 with class + reason', $$select json_array_length(public.consent_overview(qn.inst('cn-madre'))->'declines')::text$$, '3');
select qn.eq('V: overview: name as loaded BY THIS institution', $$select string_agg(x->>'name', ',' order by x->>'name') from json_array_elements(public.consent_overview(qn.inst('cn-madre'))->'declines') x where x->>'role' = 'student'$$, 'Beto Barrios,Equis Uno');
select qn.eq('V: overview: class title of the decline', $$select x->>'class_title' from json_array_elements(public.consent_overview(qn.inst('cn-madre'))->'declines') x where x->>'name' = 'Equis Uno'$$, 'CN now');
select qn.eq('V: reason stored without control characters (HTML is escaped by the UI)', $$select x->>'reason' from json_array_elements(public.consent_overview(qn.inst('cn-madre'))->'declines') x where x->>'name' = 'Equis Uno'$$, 'Prefiero no ser grabado <b>por ahora</b>');
select qn.as_user(qn.uid('cn-s1adm@x.com')::text);
select qn.eq('V: admin of Sede 1 sees them too', $$select count(*)::text from public.consent_declines$$, '3');
select qn.as_user(qn.uid('cn-s2adm@x.com')::text);
select qn.eq('V: admin of Sede 2 (sibling) sees none', $$select count(*)::text from public.consent_declines$$, '0');
select qn.fails('V: admin of Sede 2 cannot open Sede 1''s overview', $$select public.consent_overview(qn.inst('cn-s1'))$$, 'No autorizado');
select qn.as_user(qn.uid('cn-oadm@x.com')::text);
select qn.eq('V: admin of Otra sees only the decline addressed to Otra', $$select count(*)::text||'/'||min(i.slug) from public.consent_declines d join public.institutions i on i.id = d.institution_id$$, '1/cn-otra');
select qn.eq('V: Otra sees the name IT loaded', $$select public.consent_overview(qn.inst('cn-otra'))->'declines'->0->>'name'$$, 'Equis Otra');
select qn.eq('V: Otra''s overview does not leak Sede 1 (names, reasons, people)', $$select (public.consent_overview(qn.inst('cn-otra'))::text not like '%Equis Uno%' and public.consent_overview(qn.inst('cn-otra'))::text not like '%Prefiero%' and public.consent_overview(qn.inst('cn-otra'))::text not like '%cn-st1%')::text$$, 'true');
select qn.as_user(qn.uid('cn-t1@x.com')::text);
select qn.eq('V: teacher sees only their own decline (not the students'')', $$select count(*)::text||'/'||bool_and(user_id = auth.uid()) from public.consent_declines$$, '1/true');
select qn.fails('V: teacher cannot open the overview', $$select public.consent_overview(qn.inst('cn-s1'))$$, 'No autorizado');
select qn.as_user(qn.uid('cn-st1@x.com')::text);
select qn.eq('V: classmate sees no declines', $$select count(*)::text from public.consent_declines$$, '0');
select qn.fails('V: classmate cannot open the overview', $$select public.consent_overview(qn.inst('cn-s1'))$$, 'No autorizado');
select qn.as_user(:'OWNER');
select qn.eq('V: super admin sees all (incl. without institution)', $$select (count(*) >= 5 and count(*) filter (where institution_id is null) >= 1)::text from public.consent_declines$$, 'true');
reset role;
set role anon; select qn.as_user('');
select qn.fails('V: anon cannot read declines', $$select count(*) from public.consent_declines$$, 'permission denied');
select qn.fails('V: anon cannot open the overview', $$select public.consent_overview(gen_random_uuid())$$, 'permission denied');
reset role;

-- admin overview: status per person
set role authenticated; select qn.as_user(qn.uid('cn-adm@x.com')::text);
select qn.eq('O: granted (with date)', $$select (qn.person(qn.inst('cn-madre'), 'cn-st1@x.com')->>'status')||'/'||((qn.person(qn.inst('cn-madre'), 'cn-st1@x.com')->>'status_at') is not null)$$, 'granted/true');
select qn.eq('O: declined (with date and count)', $$select (qn.person(qn.inst('cn-madre'), 'cn-x@x.com')->>'status')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-x@x.com')->>'declines')$$, 'declined/1');
select qn.eq('O: not signed in yet → pending', $$select (qn.person(qn.inst('cn-madre'), 'cn-caro@x.com')->>'status')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-caro@x.com')->>'linked')$$, 'pending/false');
select qn.eq('O: teacher listed with their decline', $$select (qn.person(qn.inst('cn-madre'), 'cn-t1@x.com')->>'kind')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-t2@x.com')->>'status')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-t1@x.com')->>'status')$$, 'teacher/pending/declined');
select qn.eq('O: minor → flags only (guardian ✓ declared by the student), never the guardian''s name or email', $$select (qn.person(qn.inst('cn-madre'), 'cn-minor@x.com')->>'minor')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-minor@x.com')->>'guardian_consent')||'/'||(qn.person(qn.inst('cn-madre'), 'cn-minor@x.com')->>'guardian_source')||'/'||(public.consent_overview(qn.inst('cn-madre'))::text not ilike '%laura%')$$, 'true/true/student/true');
select qn.eq('O: the owner (super admin) is never listed', $$select (public.consent_overview(qn.inst('cn-madre'))::text not like '%owner@teroclass.test%')::text$$, 'true');
select qn.eq('O: people of another institution are not listed', $$select (public.consent_overview(qn.inst('cn-madre'))::text not like '%cn-to@x.com%' and public.consent_overview(qn.inst('cn-madre'))::text not like '%Equis Otra%')::text$$, 'true');
select qn.as_user(qn.uid('cn-st1@x.com')::text);
select public.revoke_recording_consent();
select qn.as_user(qn.uid('cn-adm@x.com')::text);
select qn.eq('O: a revocation from the profile is reflected', $$select qn.person(qn.inst('cn-madre'), 'cn-st1@x.com')->>'status'$$, 'revoked');
select qn.eq('O: badge count of new declines since a moment', $$select public.consent_new_declines(qn.inst('cn-madre'), now() - interval '1 hour')::text||'/'||public.consent_new_declines(qn.inst('cn-madre'), now() + interval '1 hour')$$, '3/0');
select qn.as_user(qn.uid('cn-s2adm@x.com')::text);
select qn.fails('O: badge count only for your own units', $$select public.consent_new_declines(qn.inst('cn-s1'), null)$$, 'No autorizado');
-- P-11 (2026-10): the justification is OPTIONAL: an empty "no" is stored (status "did not accept"), without text
select qn.as_user(qn.uid('cn-st4@x.com')::text);
select qn.eq('P-11: a "no" without a reason is accepted (joins not recorded)', $$select public.decline_recording_consent(qn.sess('CN G2 now'), '   ')->>'institutions'$$, '1');
select qn.eq('P-11: … stored with an empty reason', $$select string_agg((reason = '')::text, ',') from public.consent_declines where user_id = auth.uid()$$, 'true');
select qn.as_user(qn.uid('cn-s2adm@x.com')::text);
select qn.eq('P-11: … the admin sees "did not accept" with an empty reason', $$select (qn.person(qn.inst('cn-s2'), 'cn-st4@x.com')->>'status')||'/'||(public.consent_overview(qn.inst('cn-s2'))->'declines'->0->>'reason')$$, 'declined/');
select qn.eq('P-11: … an empty "no" is not counted in the badge (nothing to read)', $$select public.consent_new_declines(qn.inst('cn-s2'), now() - interval '1 hour')::text$$, '0');

-- Métricas (super admin): totals only
select qn.fails('P: an admin cannot read platform consent totals', $$select public.platform_consent_counts(null)$$, 'No autorizado');
select qn.as_user(:'OWNER');
select qn.eq('P: totals for a unit: granted / declined / pending, no names', $$select (c->>'granted')||'/'||(c->>'declined')||'/'||(c->>'pending')||'/'||(c::text not like '%@%') from (select public.platform_consent_counts(qn.inst('cn-s1')) c) x$$, '1/3/3/true');
reset role;

-- email notification payload: service role only, once per decline, recipients = admins of the unit and above
set role authenticated; select qn.as_user(qn.uid('cn-x@x.com')::text);
select qn.fails('N: the browser cannot read the notification payload (admin emails)', $$select public.consent_decline_notify_payload(auth.uid())$$, 'permission denied');
reset role;
set role service_role;
select qn.eq('N: service role gets the unit admins (and above) for each decline', $$select string_agg(r, ',' order by r) from json_array_elements(public.consent_decline_notify_payload(qn.uid('cn-x@x.com'))) d cross join lateral json_array_elements_text(d->'recipients') r$$, 'cn-adm@x.com,cn-oadm@x.com,cn-s1adm@x.com');
select qn.eq('N: each decline is notified only once', $$select json_array_length(public.consent_decline_notify_payload(qn.uid('cn-x@x.com')))::text$$, '0');
reset role;

\echo '================ CONSENT RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qn.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qn.results;
