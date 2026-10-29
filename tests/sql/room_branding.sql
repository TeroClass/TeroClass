-- Live-room background per institution (001_base.sql "ROOM BRANDING"): columns + CHECKs, inheritance down the hierarchy,
-- set_room_background (only that unit's admins / admins above / superadmin), get_room_background (teacher, students of the
-- class, members of the unit; never another institution), the room-backgrounds bucket and its storage policies.
-- Run after stub + 001_base.sql (alone or after the other suites: own "rb-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qr cascade;
create schema qr;
grant usage on schema qr to anon, authenticated, service_role;
create table qr.results(n serial, label text, ok boolean, detail text);
grant all on qr.results to anon, authenticated, service_role; grant all on sequence qr.results_n_seq to anon, authenticated, service_role;
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
grant execute on all functions in schema qr to anon, authenticated, service_role;
create function qr.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qr.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qr.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qr.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
create function qr.url(s text, f text) returns text language sql security definer as
$$ select 'https://abc.supabase.co/storage/v1/object/public/room-backgrounds/' || (select id from public.institutions where slug = s)::text || '/' || f $$;
create function qr.bg(j json) returns text language sql as
$$ select (j->>'kind') || '/' || coalesce(j->>'color', '-') || '/' || coalesce(regexp_replace(j->>'image_url', '^.*/', ''), '-') $$;
grant execute on function qr.inst(text), qr.uid(text), qr.grp(text), qr.sess(text), qr.url(text,text), qr.bg(json) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: RB Madre › RB Sede 1 ; RB Madre › RB Sede 2 ; RB Otra =====
set role authenticated; select qr.as_user(:'OWNER');
select qr.eq('S: superadmin creates the tree', $$select (public.create_institution('RB Madre','rb-madre','rb-adm@x.com') is not null
  and public.create_institution('RB Sede 1','rb-s1','rb-s1adm@x.com',null,qr.inst('rb-madre')) is not null
  and public.create_institution('RB Sede 2','rb-s2','rb-s2adm@x.com',null,qr.inst('rb-madre')) is not null
  and public.create_institution('RB Otra','rb-otra','rb-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('rb-s1','rb-s2','rb-otra');
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'rb-adm@x.com','{"name":"RB Admin"}',now()),
  (gen_random_uuid(),'rb-s1adm@x.com','{"name":"RB Admin S1"}',now()),
  (gen_random_uuid(),'rb-s2adm@x.com','{"name":"RB Admin S2"}',now()),
  (gen_random_uuid(),'rb-oadm@x.com','{"name":"RB Admin Otra"}',now()),
  (gen_random_uuid(),'rb-t1@x.com','{"org_slug":"rb-s1","name":"RB Teacher One"}',now()),
  (gen_random_uuid(),'rb-t2@x.com','{"org_slug":"rb-s2","name":"RB Teacher Two"}',now()),
  (gen_random_uuid(),'rb-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'rb-st2@x.com','{"via":"student_link","name":"Beto"}',now()),
  (gen_random_uuid(),'rb-st3@x.com','{"via":"student_link","name":"Caro"}',now());
set role authenticated; select qr.as_user(qr.uid('rb-adm@x.com')::text);
select public.create_group(qr.inst('rb-s1'), 'RB G1', qr.uid('rb-t1@x.com'));
select public.create_group(qr.inst('rb-s2'), 'RB G2', qr.uid('rb-t2@x.com'));
select public.add_student(null, 'rb-st1@x.com', 'Ana Alonso', qr.grp('RB G1'));
select public.add_student(null, 'rb-st2@x.com', 'Beto Bravo', qr.grp('RB G2'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('rb-st1@x.com','rb-st2@x.com');
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, now() - interval '5 minutes', now() + interval '40 minutes', 'America/Montevideo', 'scheduled'
  from (values ('RB G1', 'RB class 1'), ('RB G2', 'RB class 2')) x(g, t) join public.class_groups g on g.name = x.g;

-- ===== schema =====
select qr.eq('C: three new columns on institutions', $$select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'institutions' and column_name in ('room_bg_kind','room_bg_color','room_bg_url')$$, '3');
select qr.eq('C: bucket room-backgrounds exists and is public (URLs work for students)', $$select public::text from storage.buckets where id = 'room-backgrounds'$$, 'true');
select qr.eq('C: four storage policies on the bucket', $$select count(*)::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'room_bg_%'$$, '4');
select qr.eq('C: anon cannot call get_room_background / set_room_background', $$select (has_function_privilege('anon', 'public.get_room_background(uuid,uuid)', 'execute') or has_function_privilege('anon', 'public.set_room_background(uuid,text,text,text)', 'execute'))::text$$, 'false');
select qr.eq('C: nobody calls room_background() directly', $$select has_function_privilege('authenticated', 'public.room_background(uuid)', 'execute')::text$$, 'false');

-- ===== default =====
set role authenticated; select qr.as_user(qr.uid('rb-t1@x.com')::text);
select qr.eq('D: nothing chosen → the default light background', $$select qr.bg(public.get_room_background(qr.sess('RB class 1')))$$, 'default/-/-');
select qr.as_user(qr.uid('rb-st3@x.com')::text);
select qr.eq('D: a student without a unit and no class → default (no error)', $$select qr.bg(public.get_room_background())$$, 'default/-/-');

-- ===== write: who =====
select qr.as_user(qr.uid('rb-t1@x.com')::text);
select qr.fails('W: a teacher cannot set the background', $$select public.set_room_background(qr.inst('rb-s1'), 'color', '#112233')$$, 'No autorizado');
select qr.eq('W: …nor update the column directly (RLS: 0 rows)', $$with x as (update public.institutions set room_bg_kind = 'default' where slug = 'rb-s1' returning 1) select count(*)::text from x$$, '0');
select qr.as_user(qr.uid('rb-st1@x.com')::text);
select qr.fails('W: a student cannot set it', $$select public.set_room_background(qr.inst('rb-s1'), 'default')$$, 'No autorizado');
select qr.as_user(qr.uid('rb-oadm@x.com')::text);
select qr.fails('W: another institution''s admin cannot set it', $$select public.set_room_background(qr.inst('rb-s1'), 'color', '#112233')$$, 'No autorizado');
select qr.as_user(qr.uid('rb-s1adm@x.com')::text);
select qr.fails('W: a branch admin cannot set the parent''s background', $$select public.set_room_background(qr.inst('rb-madre'), 'color', '#112233')$$, 'No autorizado');
select qr.fails('W: …nor a sibling branch''s', $$select public.set_room_background(qr.inst('rb-s2'), 'color', '#112233')$$, 'No autorizado');

-- ===== inheritance =====
select qr.as_user(qr.uid('rb-adm@x.com')::text);
select qr.eq('I: parent admin sets a color', $$select qr.bg(public.set_room_background(qr.inst('rb-madre'), 'color', '#1E3A5F'))$$, 'color/#1e3a5f/-');
select qr.as_user(qr.uid('rb-t1@x.com')::text);
select qr.eq('I: the branch class inherits the parent color', $$select qr.bg(public.get_room_background(qr.sess('RB class 1')))$$, 'color/#1e3a5f/-');
select qr.eq('I: …and says where it comes from', $$select (public.get_room_background(qr.sess('RB class 1'))->>'from' = qr.inst('rb-madre')::text)::text$$, 'true');
select qr.eq('I: the teacher''s own unit (ad-hoc rooms) too', $$select qr.bg(public.get_room_background())$$, 'color/#1e3a5f/-');

select qr.as_user(qr.uid('rb-s1adm@x.com')::text);
select qr.eq('I: branch admin uploads its own image (own folder)', $$select qr.bg(public.set_room_background(qr.inst('rb-s1'), 'image', null, qr.url('rb-s1', 'room-1.webp')))$$, 'image/-/room-1.webp');
select qr.eq('I: the branch admin sees own + inherited (parent) for the Marca panel', $$select (x->'own'->>'kind')||'/'||(x->'parent'->>'kind')||'/'||(x->'parent'->>'color') from (select public.get_room_background(null, qr.inst('rb-s1')) x) y$$, 'image/color/#1e3a5f');
select qr.as_user(qr.uid('rb-st1@x.com')::text);
select qr.eq('R: the enrolled student reads the image of their class', $$select qr.bg(public.get_room_background(qr.sess('RB class 1')))$$, 'image/-/room-1.webp');
select qr.eq('R: …the answer has only the background (no other institution data)', $$select string_agg(k, ',' order by k) from json_object_keys(public.get_room_background(qr.sess('RB class 1'))) k$$, 'color,from,image_url,kind');
select qr.eq('R: …and the student still cannot read the institutions table', $$select count(*)::text from public.institutions where slug like 'rb-%'$$, '0');
select qr.fails('R: a student cannot read a class of another group', $$select public.get_room_background(qr.sess('RB class 2'))$$, 'No autorizado');
select qr.fails('R: …nor another institution by id', $$select public.get_room_background(null, qr.inst('rb-otra'))$$, 'No autorizado');
select qr.as_user(qr.uid('rb-st2@x.com')::text);
select qr.eq('R: the sibling branch student sees the parent color (inherited)', $$select qr.bg(public.get_room_background(qr.sess('RB class 2')))$$, 'color/#1e3a5f/-');
select qr.as_user(qr.uid('rb-t2@x.com')::text);
select qr.fails('R: a teacher of another branch cannot read class 1', $$select public.get_room_background(qr.sess('RB class 1'))$$, 'No autorizado');
select qr.eq('R: a member reads their own unit by id (effective, no "own")', $$select qr.bg(x)||'/'||coalesce(x->>'own', 'no-own') from (select public.get_room_background(null, qr.inst('rb-s2')) x) y$$, 'color/#1e3a5f/-/no-own');
select qr.as_user(qr.uid('rb-oadm@x.com')::text);
select qr.fails('R: another institution''s admin cannot read class 1', $$select public.get_room_background(qr.sess('RB class 1'))$$, 'No autorizado');
select qr.fails('R: …nor the unit by id', $$select public.get_room_background(null, qr.inst('rb-s1'))$$, 'No autorizado');
select qr.as_user(qr.uid('rb-adm@x.com')::text);
select qr.eq('R: the parent admin reads the branch class', $$select qr.bg(public.get_room_background(qr.sess('RB class 1')))$$, 'image/-/room-1.webp');

-- ===== validation =====
select qr.as_user(qr.uid('rb-s1adm@x.com')::text);
select qr.fails('V: an image in ANOTHER unit''s folder is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'image', null, qr.url('rb-madre', 'x.png'))$$, 'inválida');
select qr.fails('V: an external URL is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'image', null, 'https://evil.example/x.png')$$, 'inválida');
select qr.fails('V: http (not https) is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'image', null, replace(qr.url('rb-s1', 'x.png'), 'https:', 'http:'))$$, 'inválida');
select qr.fails('V: an SVG is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'image', null, qr.url('rb-s1', 'x.svg'))$$, 'inválida');
select qr.fails('V: the logos bucket is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'image', null, replace(qr.url('rb-s1', 'x.png'), 'room-backgrounds', 'logos'))$$, 'inválida');
select qr.fails('V: a bad color is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'color', 'red')$$, 'inválido');
select qr.fails('V: an unknown kind is refused', $$select public.set_room_background(qr.inst('rb-s1'), 'video')$$, 'inválido');
select qr.fails('V: a direct update with a bad color hits the CHECK', $$update public.institutions set room_bg_kind = 'color', room_bg_color = 'javascript:1' where slug = 'rb-s1'$$, 'institutions_room_bg');
select qr.fails('V: a direct update pointing to another unit''s folder hits the CHECK', $$update public.institutions set room_bg_kind = 'image', room_bg_url = qr.url('rb-madre', 'x.png') where slug = 'rb-s1'$$, 'institutions_room_bg_url');
select qr.fails('V: kind=color without a color hits the CHECK', $$update public.institutions set room_bg_kind = 'color', room_bg_color = null, room_bg_url = null where slug = 'rb-s1'$$, 'institutions_room_bg_complete');
select qr.eq('V: the image is still there after the refused changes', $$select qr.bg(public.get_room_background(null, qr.inst('rb-s1')))$$, 'image/-/room-1.webp');

-- ===== default override + back to inherit =====
select qr.eq('O: a branch can force the default light background over the parent color', $$select qr.bg(public.set_room_background(qr.inst('rb-s1'), 'default'))$$, 'default/-/-');
select qr.eq('O: …stored as its own "default" (not inherited)', $$select public.get_room_background(null, qr.inst('rb-s1'))->'own'->>'kind'$$, 'default');
select qr.eq('O: "inherit" clears it → the parent color again', $$select qr.bg(public.set_room_background(qr.inst('rb-s1'), 'inherit'))$$, 'color/#1e3a5f/-');
select qr.eq('O: …and the old image / color are cleared', $$select coalesce(x->'own'->>'kind','null')||'/'||coalesce(x->'own'->>'image_url','null') from (select public.get_room_background(null, qr.inst('rb-s1')) x) y$$, 'null/null');
reset role;
set role authenticated; select qr.as_user(:'OWNER');
select qr.eq('O: the superadmin can set any unit', $$select qr.bg(public.set_room_background(qr.inst('rb-otra'), 'color', '#0f766e'))$$, 'color/#0f766e/-');
reset role;

-- ===== storage policies (bucket room-backgrounds) =====
set role authenticated; select qr.as_user(qr.uid('rb-s1adm@x.com')::text);
select qr.eq('ST: branch admin may write <own unit>/room-2.png', $$select public.can_manage_room_bg(qr.inst('rb-s1')::text || '/room-2.png')::text$$, 'true');
select qr.eq('ST: …not an .svg / .html', $$select (public.can_manage_room_bg(qr.inst('rb-s1')::text || '/x.svg') or public.can_manage_room_bg(qr.inst('rb-s1')::text || '/x.html'))::text$$, 'false');
select qr.eq('ST: …not in the parent''s folder', $$select public.can_manage_room_bg(qr.inst('rb-madre')::text || '/room.png')::text$$, 'false');
select qr.eq('ST: upload into own folder passes RLS', $$with x as (insert into storage.objects(bucket_id, name) values ('room-backgrounds', qr.inst('rb-s1')::text || '/room-2.png') returning 1) select count(*)::text from x$$, '1');
select qr.fails('ST: upload into another unit''s folder is blocked by RLS', $$insert into storage.objects(bucket_id, name) values ('room-backgrounds', qr.inst('rb-otra')::text || '/room.png')$$, 'row-level security');
select qr.as_user(qr.uid('rb-t1@x.com')::text);
select qr.fails('ST: a teacher cannot upload a background', $$insert into storage.objects(bucket_id, name) values ('room-backgrounds', qr.inst('rb-s1')::text || '/room-3.png')$$, 'row-level security');
select qr.as_user(qr.uid('rb-st1@x.com')::text);
select qr.fails('ST: a student cannot upload a background', $$insert into storage.objects(bucket_id, name) values ('room-backgrounds', qr.inst('rb-s1')::text || '/room-4.png')$$, 'row-level security');
reset role;

select n, case when ok then 'ok' else '**FAIL**' end as result, label, detail from qr.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qr.results;
