-- Security + flow tests for the NEW 001_base.sql (run on stub + new.sql)
\set ON_ERROR_STOP 1
\pset footer off
create schema qa;
grant usage on schema qa to anon, authenticated;
create table qa.results(n serial, label text, ok boolean, detail text);
grant all on qa.results to anon, authenticated; grant all on sequence qa.results_n_seq to anon, authenticated;

create function qa.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;

-- expect an error whose message matches pattern (ILIKE '%pat%')
create function qa.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin
    execute q;
    insert into qa.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then
    insert into qa.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm);
  end;
end $$;
-- expect success and N affected rows (null = any)
create function qa.rows(label text, q text, expected int default null) returns void language plpgsql as $$
declare n int;
begin
  begin
    execute q; get diagnostics n = row_count;
    insert into qa.results(label,ok,detail) values (label, expected is null or n = expected, 'rows='||n);
  exception when others then
    insert into qa.results(label,ok,detail) values (label,false,'error: '||sqlerrm);
  end;
end $$;
-- expect scalar result (as text) = expected
create function qa.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin
    execute q into v;
    insert into qa.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then
    insert into qa.results(label,ok,detail) values (label,false,'error: '||sqlerrm);
  end;
end $$;
grant execute on all functions in schema qa to anon, authenticated;

-- ids
\set OWNER '00000000-0000-0000-0000-000000000001'
\set ADMA  '00000000-0000-0000-0000-00000000000a'
\set ADMB  '00000000-0000-0000-0000-00000000000b'
\set T1    '00000000-0000-0000-0000-0000000000a1'
\set T2    '00000000-0000-0000-0000-0000000000a2'
\set LONER '00000000-0000-0000-0000-0000000000ff'
\set STR   '00000000-0000-0000-0000-0000000000ee'
\set TB    '00000000-0000-0000-0000-0000000000b1'
\set NEWA  '00000000-0000-0000-0000-0000000000a9'

-- ===== FLOW: owner signs up (confirmed) =====
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values (:'OWNER','Owner@TeroClass.test ','{"name":"Owner"}',now());
select qa.eq('flow: owner profile email lowercased/trimmed', $$select email from public.profiles where id='00000000-0000-0000-0000-000000000001'$$, 'owner@teroclass.test');
select qa.eq('OWN: no auto-promotion by email (confirmed signup stays teacher)', $$select role from public.profiles where id='00000000-0000-0000-0000-000000000001'$$, 'teacher');
select qa.eq('OWN: migration source has no hardcoded owner email', $$select count(*) from pg_proc where prosrc ilike '%teroclass.test%' or prosrc ilike '%@gmail.com%'$$, '0');
-- manual grant (README snippet)
update public.profiles set role='superadmin' where id=(select id from auth.users where email='Owner@TeroClass.test ');
select qa.eq('flow: owner granted superadmin manually (README snippet)', $$select role from public.profiles where id='00000000-0000-0000-0000-000000000001'$$, 'superadmin');

set role authenticated; select qa.as_user(:'OWNER');
select qa.rows('flow: superadmin create_institution A', $$select public.create_institution('Inst A','alpha',' A@A.com ')$$, 1);
select qa.rows('flow: superadmin create_institution B', $$select public.create_institution('Inst B','beta','b@b.com')$$, 1);
select qa.fails('C2: create_institution with JS slug rejected', $$select public.create_institution('X',$q$a');alert(1);('$q$,'x@x.com')$$, 'Slug inválido');
select qa.eq('flow: admin_email normalized', $$select admin_email from public.institutions where slug='alpha'$$, 'a@a.com');
select qa.eq('flow: pending invitation created for a@a.com', $$select count(*) from public.invitations where email='a@a.com' and role='org_admin'$$, '1');
select qa.fails('L: invite_member empty email', $$select public.invite_member((select id from public.institutions where slug='alpha'),'  ','teacher')$$, 'Email requerido');
select qa.fails('L: invite_member null email', $$select public.invite_member((select id from public.institutions where slug='alpha'),null,'teacher')$$, 'Email requerido');
select qa.eq('L: invite_member of platform owner returns superadmin', $$select public.invite_member((select id from public.institutions where slug='alpha'),'OWNER@teroclass.test','teacher')$$, 'superadmin');
select qa.eq('flow: invite new@a.com', $$select public.invite_member((select id from public.institutions where slug='alpha'),' New@A.com','teacher')$$, 'invited');
select qa.eq('flow: invite again replaces pending (no duplicates)', $$select public.invite_member((select id from public.institutions where slug='alpha'),'new@a.com','teacher')$$, 'invited');
select qa.eq('flow: one pending invitation for new@a.com', $$select count(*) from public.invitations where email='new@a.com'$$, '1');
reset role;

-- signups
update public.institutions set open_registration = true where slug in ('alpha','beta') and not open_registration; -- 2026-10: sign-up by link is off by default (TC-02); opened explicitly here
insert into auth.users(id,email,raw_user_meta_data) values
 (:'ADMA','a@a.com','{}'), (:'ADMB','b@b.com','{}'),
 (:'T1','t1@a.com','{"org_slug":"alpha","name":"T One"}'), (:'T2','t2@a.com','{"org_slug":"ALPHA"}'),
 (:'LONER','loner@x.com','{}'), (:'NEWA','new@a.com','{}'),
 (:'TB','tb@b.com','{"org_slug":"beta"}');
select qa.eq('flow: signup via invite -> org_admin of A', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='a@a.com'$$, 'org_admin@alpha');
select qa.eq('flow: signup via invite (teacher)', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='new@a.com'$$, 'teacher@alpha');
select qa.eq('flow: invitation marked accepted', $$select count(*) from public.invitations where email='new@a.com' and accepted_at is not null$$, '1');
select qa.eq('flow: signup via open slug -> teacher of A', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='t1@a.com'$$, 'teacher@alpha');
select qa.eq('flow: signup via slug (uppercase) works', $$select (select slug from public.institutions i where i.id=institution_id) from public.profiles where email='t2@a.com'$$, 'alpha');
select qa.eq('flow: loner has no institution', $$select coalesce(institution_id::text,'none') from public.profiles where email='loner@x.com'$$, 'none');

-- ===== H3: admin B closes registration; stranger signs up via /org/beta =====
set role authenticated; select qa.as_user(:'ADMB');
select qa.rows('H3: org_admin can toggle open_registration', $$update public.institutions set open_registration=false where slug='beta'$$, 1);
reset role;
insert into auth.users(id,email,raw_user_meta_data) values (:'STR','stranger@evil.com','{"org_slug":"beta"}');
select qa.eq('H3: slug join refused when registration closed', $$select coalesce(institution_id::text,'none') from public.profiles where email='stranger@evil.com'$$, 'none');
set role anon; select qa.as_user('');
select qa.eq('flow: anon get_org_branding returns open_registration', $$select open_registration::text from public.get_org_branding('BETA')$$, 'false');
reset role;

-- docs + plans + logo objects as fixtures
set role authenticated; select qa.as_user(:'ADMA');
select qa.rows('flow: admin uploads document (insert + select id)', $$insert into public.institution_documents(institution_id,name,content,chars,uploaded_by) values ((select id from public.institutions where slug='alpha'),'pb.txt','A FULL PLAYBOOK CONTENT',23,auth.uid()) returning id$$, 1);
select qa.rows('flow: admin updates summary', $$update public.institution_documents set summary='A summary' where name='pb.txt'$$, 1);
select qa.eq('flow: admin reads content via get_document_content', $$select public.get_document_content((select id from public.institution_documents where name='pb.txt'))$$, 'A FULL PLAYBOOK CONTENT');
select qa.fails('H3: admin direct select content denied (must use fn)', $$select content from public.institution_documents$$, 'permission denied');
reset role;
insert into public.institution_documents(institution_id,name,content,summary) select id,'pbB.txt','B FULL PLAYBOOK','B sum' from public.institutions where slug='beta';
insert into storage.objects(bucket_id,name) select 'logos', id::text||'/logo.png' from public.institutions where slug in ('alpha','beta');

-- ===== H3: teacher reads docs =====
set role authenticated; select qa.as_user(:'T1');
select qa.eq('H3: teacher reads id,name,summary,chars,created_at', $$select string_agg(name||':'||summary||':'||chars, ',') from (select id,name,summary,chars,created_at from public.institution_documents) d$$, 'pb.txt:A summary:23');
select qa.fails('H3: teacher select content denied', $$select content from public.institution_documents$$, 'permission denied');
select qa.fails('H3: teacher select * denied', $$select * from public.institution_documents$$, 'permission denied');
select qa.fails('H3: teacher get_document_content denied', $$select public.get_document_content((select id from public.institution_documents where name='pb.txt'))$$, 'No autorizado');
select qa.fails('H3: teacher cannot insert documents', $$insert into public.institution_documents(institution_id,name) values (public.my_institution(),'x')$$, 'row-level security');

-- ===== C3: profile email / role =====
select qa.fails('C3a: teacher changes own email to owner email', $$update public.profiles set email='owner@teroclass.test' where id=auth.uid()$$, 'email no se puede cambiar');
select qa.fails('C3: teacher escalates role', $$update public.profiles set role='org_admin' where id=auth.uid()$$, 'No autorizado');
select qa.fails('C3: teacher changes institution', $$update public.profiles set institution_id=null where id=auth.uid()$$, 'No autorizado');
select qa.rows('flow: teacher updates own name', $$update public.profiles set name='Teacher One' where id=auth.uid()$$, 1);
select qa.rows('C3: teacher cannot update others', $$update public.profiles set name='x' where id<>auth.uid()$$, 0);
select qa.fails('C3: teacher inserts invitation', $$insert into public.invitations(email,institution_id,role) values ('x@x.com',(select institution_id from public.profiles where id=auth.uid()),'org_admin')$$, 'row-level security');
select qa.fails('C3: teacher calls set_member_role on self', $$select public.set_member_role(auth.uid(),'org_admin')$$, 'No autorizado');
select qa.fails('C3: teacher calls remove_member', $$select public.remove_member('00000000-0000-0000-0000-0000000000a2')$$, 'No autorizado');

-- ===== H4: plannings =====
select qa.rows('flow: teacher inserts plan in own institution', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),public.my_institution(),'t1 plan')$$, 1);
select qa.fails('H4: teacher inserts plan into institution B', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),(select id from public.institutions where slug='beta'),'inj')$$, 'row-level security');
select qa.fails('H4: teacher inserts plan with null institution while in A', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),null,'inj')$$, 'row-level security');
select qa.fails('H4: teacher inserts plan for another owner', $$insert into public.plannings(owner_id,institution_id,title) values ('00000000-0000-0000-0000-0000000000a2',public.my_institution(),'inj')$$, 'row-level security');
select qa.rows('flow: teacher updates own plan', $$update public.plannings set title='t1 plan v2', data='{"a":1}' where title='t1 plan'$$, 1);
reset role;
select set_config('qa.instb', (select id::text from public.institutions where slug='beta'), false);
set role authenticated; select qa.as_user(:'T1');
select qa.fails('H4: teacher moves own plan to institution B (real id)', format($$update public.plannings set institution_id=%L where title='t1 plan v2'$$, current_setting('qa.instb')), 'row-level security');
select qa.rows('H4: teacher cannot touch others plans', $$delete from public.plannings where owner_id<>auth.uid()$$, 0);
select qa.as_user(:'LONER');
select qa.rows('flow: user without institution inserts plan (null)', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),null,'loner plan')$$, 1);
select qa.as_user(:'T2');
select qa.rows('flow: t2 inserts plan in A', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),public.my_institution(),'t2 plan')$$, 1);

-- ===== C2: institutions =====
select qa.as_user(:'ADMA');
select qa.fails('C2: org_admin changes slug', $$update public.institutions set slug='alpha2' where slug='alpha'$$, 'Solo el súper admin puede cambiar el slug');
select qa.fails('C2: org_admin sets JS slug', $$update public.institutions set slug=$q$a');alert(document.domain);('$q$ where slug='alpha'$$, '');
select qa.fails('C2: org_admin changes admin_email', $$update public.institutions set admin_email='evil@x.com' where slug='alpha'$$, 'email del admin');
select qa.fails('C2: org_admin sets JS logo_url', $$update public.institutions set logo_url=$q$x" onerror="alert(1)$q$ where slug='alpha'$$, 'institutions_logo_url_format');
select qa.fails('C2: org_admin sets javascript: logo_url', $$update public.institutions set logo_url='javascript:alert(1)' where slug='alpha'$$, 'institutions_logo_url_format');
select qa.fails('C2: org_admin sets https logo with quote', $$update public.institutions set logo_url=$q$https://x.com/a.png" onload="alert(1)$q$ where slug='alpha'$$, 'institutions_logo_url_format');
select qa.fails('C2: org_admin sets CSS-injection color', $$update public.institutions set color='red;}</style><script>' where slug='alpha'$$, 'institutions_color_format');
select qa.fails('C2: org_admin sets font with double quote', $$update public.institutions set font='x"><img src=x onerror=alert(1)>' where slug='alpha'$$, 'institutions_font_format');
select qa.rows('flow: org_admin saves branding row incl. unchanged slug/admin_email (frontend saveBranding)', $$update public.institutions set name='Inst A2', slug='alpha', admin_email='A@a.com', color='#112233', bg_color='#ffffff', font=$q$'Courier New'$q$ where slug='alpha'$$, 1);
select qa.rows('flow: org_admin sets valid supabase logo_url', $$update public.institutions set logo_url='https://ppvqkjchhejjulrdqkdr.supabase.co/storage/v1/object/public/logos/'||id||'/logo-1712.png' where slug='alpha'$$, 1);
select qa.rows('flow: org_admin edits master_prompt/doc fields', $$update public.institutions set master_prompt='Be kind', doc_text='x', doc_name='y' where slug='alpha'$$, 1);
select qa.rows('C2: org_admin cannot update institution B', $$update public.institutions set name='hacked' where slug='beta'$$, 0);
select qa.fails('C2: org_admin cannot insert institution', $$insert into public.institutions(name,slug) values ('x','xx')$$, 'row-level security');

-- ===== C3c: admin edits other users =====
select qa.rows('C3c: org_admin edits teacher email (0 rows)', $$update public.profiles set email='whatever@x.com' where email='t1@a.com'$$, 0);
select qa.rows('C3c: org_admin edits teacher name (0 rows)', $$update public.profiles set name='x' where email='t1@a.com'$$, 0);
select qa.rows('C3c: org_admin sets teacher role directly (0 rows)', $$update public.profiles set role='org_admin' where email='t1@a.com'$$, 0);
select qa.eq('flow: org_admin still sees members', $$select count(*) from public.profiles where institution_id=public.my_institution()$$, '4');
select qa.fails('L: admin A invites into B', $$select public.invite_member((select id from public.institutions where slug='beta'),'x@x.com','teacher')$$, 'No autorizado');
select qa.fails('L: admin A invites with invalid role', $$select public.invite_member(public.my_institution(),'x@x.com','superadmin')$$, 'Rol inválido');
select qa.fails('L: invite member of other institution', $$select public.invite_member(public.my_institution(),'b@b.com','teacher')$$, 'otra institución');
select qa.fails('C3: last org_admin self-demote via invite_member', $$select public.invite_member(public.my_institution(),'a@a.com','teacher')$$, 'último administrador');
select qa.fails('C3: last org_admin self-demote via set_member_role', $$select public.set_member_role(auth.uid(),'teacher')$$, 'último administrador');
select qa.fails('C3: last org_admin self-remove', $$select public.remove_member(auth.uid())$$, 'último administrador');
select qa.fails('C3: set_member_role on superadmin', $$select public.set_member_role('00000000-0000-0000-0000-000000000001','teacher')$$, '');
select qa.fails('C3: set_member_role on other institution member', $$select public.set_member_role('00000000-0000-0000-0000-0000000000b1','org_admin')$$, 'No autorizado');
select qa.fails('C3: remove_member on other institution member', $$select public.remove_member('00000000-0000-0000-0000-0000000000b1')$$, 'No autorizado');
select qa.fails('C3: set_member_role invalid role', $$select public.set_member_role('00000000-0000-0000-0000-0000000000a1','superadmin')$$, 'Rol inválido');
select qa.eq('flow: set_member_role promotes t1', $$select public.set_member_role('00000000-0000-0000-0000-0000000000a1','org_admin')$$, 'org_admin');
select qa.eq('flow: now admin A can step down (2 admins)', $$select public.set_member_role(auth.uid(),'teacher')$$, 'teacher');
select qa.as_user(:'T1');
select qa.eq('flow: t1 (now admin) promotes a@a.com back', $$select public.set_member_role('00000000-0000-0000-0000-00000000000a','org_admin')$$, 'org_admin');
select qa.eq('flow: remove_member t2 (removed)', $$select public.remove_member('00000000-0000-0000-0000-0000000000a2')$$, 'removed');
select qa.eq('flow: removed t2 no longer visible to A admins', $$select (select role||':'||coalesce(institution_id::text,'none') from public.profiles where id='00000000-0000-0000-0000-0000000000a2')$$, null);
reset role;
select qa.eq('flow: t2 now teacher without institution (postgres view)', $$select role||':'||coalesce(institution_id::text,'none') from public.profiles where id='00000000-0000-0000-0000-0000000000a2'$$, 'teacher:none');
set role authenticated; select qa.as_user(:'T2');
select qa.rows('H4: removed teacher can still edit her old plan (moves to her current institution)', $$update public.plannings set title='t2 plan v2' where title='t2 plan'$$, 1);
reset role;
select qa.eq('H4: old plan institution now null', $$select coalesce(institution_id::text,'none') from public.plannings where title='t2 plan v2'$$, 'none');

-- ===== C3b: invitation hijack via stale/forged profiles.email =====
update public.profiles set email='admin@c.com' where email='loner@x.com';  -- simulate legacy hijacked data
set role authenticated; select qa.as_user(:'OWNER');
select qa.rows('flow: superadmin creates C with admin@c.com', $$select public.create_institution('Inst C','gamma','admin@c.com')$$, 1);
reset role;
select qa.eq('C3b: loner (profile email forged) NOT added to C', $$select coalesce(institution_id::text,'none')||':'||role from public.profiles where id='00000000-0000-0000-0000-0000000000ff'$$, 'none:teacher');
select qa.eq('C3b: invitation pending for real admin@c.com', $$select count(*) from public.invitations where email='admin@c.com' and accepted_at is null$$, '1');
update public.profiles set email='owner@teroclass.test' where email='t1@a.com';  -- simulate forged owner email
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000a1';
select qa.eq('C3: confirming an account never promotes it (no email-based superadmin)', $$select role from public.profiles where id='00000000-0000-0000-0000-0000000000a1'$$, 'org_admin');
update auth.users set email='loner2@x.com' where email='loner@x.com';
select qa.eq('flow: auth email change syncs profile email', $$select email from public.profiles where id='00000000-0000-0000-0000-0000000000ff'$$, 'loner2@x.com');

-- ===== Storage =====
set role anon; select qa.as_user('');
select qa.eq('H4: anon cannot list logos bucket', $$select count(*) from storage.objects$$, '0');
set role authenticated; select qa.as_user(:'T2');
select qa.eq('H4: teacher cannot list logos bucket', $$select count(*) from storage.objects$$, '0');
select qa.as_user(:'ADMA');
select qa.eq('H4: admin A sees only own folder', $$select count(*) from storage.objects where bucket_id='logos'$$, '1');
select qa.rows('flow: admin A uploads to own folder', $$insert into storage.objects(bucket_id,name) values ('logos',public.my_institution()||'/logo-2.png')$$, 1);
select qa.rows('flow: admin A upsert/updates own logo', $$update storage.objects set name=name where bucket_id='logos' and name like public.my_institution()||'/%'$$, 2);
select qa.fails('H4: admin A uploads into B folder', format($$insert into storage.objects(bucket_id,name) values ('logos',%L||'/x.png')$$, current_setting('qa.instb')), 'row-level security');
select qa.fails('H4: upload with non-uuid folder (no crash, denied)', $$insert into storage.objects(bucket_id,name) values ('logos','notauuid/x.png')$$, 'row-level security');
select qa.rows('H4: admin A cannot delete B logo', $$delete from storage.objects where name not like public.my_institution()||'/%'$$, 0);

-- ===== H2: AI quota =====
-- TC-01 (2026-10): accounts without an institution start lower: unconfirmed email 3, account younger than 7 days 5, then 15
select qa.as_user(:'LONER');
select qa.eq('TC-01: no-institution user with unconfirmed email → limit 3', $$select public.get_ai_quota()->>'limit'$$, '3');
reset role;
update auth.users set email_confirmed_at = now() where id = :'LONER';
set role authenticated; select qa.as_user(:'LONER');
select qa.eq('TC-01: confirmed but new account (< 7 days) → limit 5', $$select public.get_ai_quota()->>'limit'$$, '5');
reset role;
update public.profiles set created_at = now() - interval '8 days' where id in (:'LONER', :'T2');
update auth.users set email_confirmed_at = now() where id = :'T2';
set role authenticated; select qa.as_user(:'LONER');
select qa.eq('H2: no-institution user limit 15', $$select public.consume_ai_quota()->>'limit'$$, '15');
do $$ begin for i in 2..15 loop perform public.consume_ai_quota(); end loop; end $$;
select qa.eq('H2: 15th call allowed', $$select public.get_ai_quota()->>'used'$$, '15');
select qa.eq('H2: 16th call refused', $$select public.consume_ai_quota()::text$$, '{"allowed" : false, "reason" : "requests", "used" : 15, "limit" : 15}');
select qa.fails('H2: user cannot reset own usage (update)', $$update public.ai_usage set count=0$$, 'permission denied');
select qa.fails('H2: user cannot delete usage', $$delete from public.ai_usage$$, 'permission denied');
select qa.fails('H2: user cannot insert usage', $$insert into public.ai_usage values (auth.uid(), current_date + 1, 0)$$, 'permission denied');
select qa.fails('H2: user cannot read usage table', $$select * from public.ai_usage$$, 'permission denied');
select qa.fails('H2: user cannot call ai_daily_limit', $$select public.ai_daily_limit(auth.uid())$$, 'permission denied');
select qa.as_user(:'T2');
select qa.eq('H2: teacher w/o inst (removed) limit 15', $$select public.consume_ai_quota()->>'limit'$$, '15');
select qa.as_user(:'NEWA');
select qa.eq('H2: teacher with institution limit 60', $$select public.consume_ai_quota()->>'limit'$$, '60');
select qa.as_user(:'ADMA');
select qa.eq('H2: org_admin limit 150', $$select public.consume_ai_quota()->>'limit'$$, '150');
select qa.as_user(:'OWNER');
select qa.eq('H2: superadmin limit 500', $$select public.consume_ai_quota()->>'limit'$$, '500');
select qa.as_user('');
select qa.fails('H2: no user -> consume refused', $$select public.consume_ai_quota()$$, 'No autorizado');
set role anon;
select qa.fails('H2: anon cannot execute consume_ai_quota', $$select public.consume_ai_quota()$$, 'permission denied');
select qa.fails('anon cannot execute invite_member', $$select public.invite_member(null,'x','teacher')$$, 'permission denied');
select qa.eq('anon sees no institutions', $$select count(*) from public.institutions$$, '0');
select qa.eq('anon sees no profiles', $$select count(*) from public.profiles$$, '0');
select qa.fails('anon cannot read docs', $$select id from public.institution_documents$$, 'permission denied');

-- ===== superadmin powers =====
set role authenticated; select qa.as_user(:'OWNER');
select qa.rows('flow: superadmin changes slug', $$update public.institutions set slug='alpha-school' where slug='alpha'$$, 1);
select qa.fails('C2: superadmin also cannot set invalid slug', $$update public.institutions set slug='Bad Slug' where slug='alpha-school'$$, 'institutions_slug_format');
select qa.rows('flow: superadmin changes admin_email', $$update public.institutions set admin_email='new@a.com' where slug='alpha-school'$$, 1);
select qa.fails('C3: superadmin cannot change emails from app either', $$update public.profiles set email='z@z.com' where id=auth.uid()$$, 'email no se puede cambiar');
select qa.eq('flow: superadmin reads B content via fn', $$select public.get_document_content((select id from public.institution_documents where name='pbB.txt'))$$, 'B FULL PLAYBOOK');
reset role;

-- ===== OWN: the platform owner's identity is hidden from admins and teachers =====
-- owner placed inside institution A (worst case) + rows that reference him
update public.profiles set institution_id = (select id from public.institutions where slug='alpha-school') where id = :'OWNER';
insert into public.ai_request_log(user_id, root_id, inst_id, scope, total_tokens)
  select :'OWNER', id, id, 'institution', 777 from public.institutions where slug='alpha-school';
insert into public.ai_request_log(user_id, root_id, inst_id, scope, total_tokens)
  select :'OWNER', null, id, 'unlimited', 555 from public.institutions where slug='alpha-school';
insert into public.plannings(owner_id, institution_id, title) select :'OWNER', id, 'owner test class' from public.institutions where slug='alpha-school';
insert into public.token_purchase_requests(root_id, root_name, requested_by, pack_tokens, price, status, decided_by, decided_at)
  select id, name, :'OWNER', 1000, 1, 'approved', :'OWNER', now() from public.institutions where slug='alpha-school';
set role authenticated; select qa.as_user(:'OWNER');
select qa.rows('OWN: superadmin uploads a playbook into A', $$insert into public.institution_documents(institution_id,name,content,chars,uploaded_by) select id,'owner-pb.txt','x',1,auth.uid() from public.institutions where slug='alpha-school'$$, 1);
select qa.eq('OWN: superadmin invite gets invited_by null', $$select coalesce(invited_by::text,'null') from public.invitations where id = (select id from public.invitations where email='admin@c.com')$$, 'null');
select qa.eq('OWN: superadmin still reads own profile', $$select email from public.profiles where id=auth.uid()$$, 'owner@teroclass.test');
select qa.eq('OWN: superadmin invite_member of own email → superadmin', $$select public.invite_member((select id from public.institutions where slug='alpha-school'),'owner@teroclass.test','teacher')$$, 'superadmin');
select qa.eq('OWN: superadmin sees own class', $$select count(*) from public.plannings where owner_id=auth.uid()$$, '1');
select qa.eq('OWN: superadmin sees own log rows', $$select count(*) from public.ai_request_log where user_id=auth.uid()$$, '2');
select qa.eq('OWN: superadmin sees real requester in list_purchase_requests', $$select (public.list_purchase_requests(null)::jsonb -> 0 ->> 'requested_by_email')$$, 'owner@teroclass.test');
select qa.as_user(:'ADMA');
select qa.eq('OWN: admin cannot read owner profile row (same institution)', $$select count(*) from public.profiles where id='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: admin sees no superadmin rows at all', $$select count(*) from public.profiles where role='superadmin'$$, '0');
select qa.eq('OWN: admin still sees own members', $$select (count(*) > 0)::text from public.profiles where institution_id=public.my_institution() and id<>auth.uid()$$, 'true');
select qa.eq('OWN: institutions.created_by never points to the owner', $$select count(*) from public.institutions where created_by='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: invitations.invited_by never points to the owner', $$select count(*) from public.invitations where invited_by='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: playbook uploaded_by masked (null)', $$select coalesce(uploaded_by::text,'null') from public.institution_documents where name='owner-pb.txt'$$, 'null');
select qa.eq('OWN: admin sees no classes authored by the owner', $$select count(*) from public.plannings where owner_id='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: admin sees no owner rows in ai_request_log', $$select count(*) from public.ai_request_log where user_id='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.fails('OWN: admin cannot read decided_by of purchase requests', $$select decided_by from public.token_purchase_requests$$, 'permission denied');
select qa.fails('OWN: admin cannot read requested_by directly either', $$select requested_by from public.token_purchase_requests$$, 'permission denied');
select qa.eq('OWN: admin reads purchase requests (allowed columns)', $$select count(*) from (select id, status, decided_at from public.token_purchase_requests) x$$, '1');
select qa.eq('OWN: billing summary by_teacher masks the owner', $$select (j->'by_teacher' = '[{"name": "", "email": null, "used": 777, "masked": true, "user_id": null, "requests": 1}]'::jsonb)::text from (select public.get_billing_summary(null)::jsonb j) x$$, 'true');
select qa.eq('OWN: billing summary requests mask the owner', $$select (j->'requests'->0->>'masked')||'/'||(j->'requests'->0->>'requested_by_name') from (select public.get_billing_summary(null)::jsonb j) x$$, 'true/');
select qa.eq('OWN: billing summary has no owner email/name/id', $$select (t not ilike '%teroclass.test%' and t not ilike '%Owner%' and t not ilike '%00000000-0000-0000-0000-000000000001%')::text from (select public.get_billing_summary(null)::text t) x$$, 'true');
select qa.eq('OWN: list_purchase_requests masks the owner', $$select (t not ilike '%teroclass.test%' and t not ilike '%Owner%' and (t::jsonb->0->>'masked') = 'true')::text from (select public.list_purchase_requests(null)::text t) x$$, 'true');
select qa.eq('OWN: get_effective_config reveals nothing about the owner', $$select (t not ilike '%teroclass.test%' and t not ilike '%00000000-0000-0000-0000-000000000001%')::text from (select public.get_effective_config(null)::text t) x$$, 'true');
select qa.eq('OWN: invite_member of owner email → generic not_allowed', $$select public.invite_member(public.my_institution(),'Owner@TeroClass.test','teacher')$$, 'not_allowed');
select qa.fails('OWN: set_member_role on owner → generic No autorizado', $$select public.set_member_role('00000000-0000-0000-0000-000000000001','teacher')$$, 'No autorizado');
select qa.fails('OWN: remove_member on owner → generic No autorizado', $$select public.remove_member('00000000-0000-0000-0000-000000000001')$$, 'No autorizado');
select qa.as_user(:'NEWA');
select qa.eq('OWN: teacher cannot read owner profile', $$select count(*) from public.profiles where id='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: teacher sees no owner log rows', $$select count(*) from public.ai_request_log where user_id='00000000-0000-0000-0000-000000000001'$$, '0');
select qa.eq('OWN: teacher sees no owner playbook uploader', $$select count(*) from public.institution_documents where uploaded_by='00000000-0000-0000-0000-000000000001'$$, '0');
set role anon;
select qa.fails('OWN: anon cannot call is_superadmin_id', $$select public.is_superadmin_id('00000000-0000-0000-0000-000000000001')$$, 'permission denied');
reset role;
update public.profiles set institution_id = null where id = :'OWNER';

\echo '================ RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qa.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qa.results;
