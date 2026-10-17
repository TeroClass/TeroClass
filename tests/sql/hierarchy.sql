-- Hierarchy (3 levels) security + flow tests. Run after stub + 001_base.sql (with or without sec.sql data).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qh cascade;
create schema qh;
grant usage on schema qh to anon, authenticated;
create table qh.results(n serial, label text, ok boolean, detail text);
grant all on qh.results to anon, authenticated; grant all on sequence qh.results_n_seq to anon, authenticated;
create function qh.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
create function qh.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qh.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qh.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qh.rows(label text, q text, expected int default null) returns void language plpgsql as $$
declare n int;
begin
  begin execute q; get diagnostics n = row_count;
    insert into qh.results(label,ok,detail) values (label, expected is null or n = expected, 'rows='||n);
  exception when others then insert into qh.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
create function qh.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qh.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qh.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qh to anon, authenticated;
-- id helpers (postgres only)
create function qh.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qh.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where email = e $$;
grant execute on function qh.inst(text), qh.uid(text) to anon, authenticated;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER'; -- manual grant (README); no auto-promotion by email

-- ===== superadmin creates the main institution =====
set role authenticated; select qh.as_user(:'OWNER');
select qh.eq('H: superadmin creates madre', $$select (public.create_institution('Madre H','madre-h','madm@h.com') is not null)::text$$, 'true');
select qh.eq('H: existing/new top-level has level 1', $$select public.institution_level(qh.inst('madre-h'))$$, '1');
reset role;
insert into auth.users(id,email,raw_user_meta_data) values (gen_random_uuid(),'madm@h.com','{}');
select qh.eq('H: madm is org_admin of madre', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='madm@h.com'$$, 'org_admin@madre-h');

-- ===== madre admin builds the tree =====
select set_config('qh.madm', qh.uid('madm@h.com')::text, false);
set role authenticated; select qh.as_user(current_setting('qh.madm'));
select qh.fails('H: org_admin cannot create top-level', $$select public.create_institution('X','x-top','')$$, 'No autorizado');
select qh.eq('H: madm creates sede 1 (with admin)', $$select (public.create_institution('Sede 1','sede1-h','s1adm@h.com',null,qh.inst('madre-h')) is not null)::text$$, 'true');
select qh.eq('H: madm creates sede 2 (no admin)', $$select (public.create_institution('Sede 2','sede2-h','',null,qh.inst('madre-h')) is not null)::text$$, 'true');
select qh.eq('H: madm creates cátedra under sede 1 (grandchild)', $$select (public.create_institution('Cátedra 1','cat1-h','c1adm@h.com',null,qh.inst('sede1-h')) is not null)::text$$, 'true');
select qh.eq('H: levels 1/2/3', $$select public.institution_level(qh.inst('madre-h'))||'/'||public.institution_level(qh.inst('sede1-h'))||'/'||public.institution_level(qh.inst('cat1-h'))$$, '1/2/3');
select qh.fails('H: depth 4 rejected (create_institution)', $$select public.create_institution('Nivel 4','lvl4-h','',null,qh.inst('cat1-h'))$$, 'Máximo 3 niveles');
select qh.fails('H: slug still globally unique', $$select public.create_institution('Dup','sede1-h','',null,qh.inst('madre-h'))$$, 'duplicate');
select qh.fails('H: slug format still validated', $$select public.create_institution('Bad','Bad Slug','',null,qh.inst('madre-h'))$$, 'Slug inválido');
select qh.eq('H: child created without own color (inherits)', $$select coalesce(color,'null')||'/'||coalesce(font,'null') from public.institutions where slug='cat1-h'$$, 'null/null');
select qh.eq('H: madm sees madre + descendants', $$select count(*) from public.institutions$$, '4');
select qh.eq('H: ancestors(cátedra) = sede, madre (root first)', $$select string_agg(i.slug, '>') from (select a, row_number() over () rn from public.institution_ancestors(qh.inst('cat1-h')) a) x join public.institutions i on i.id = x.a$$, 'madre-h>sede1-h');
select qh.eq('H: descendants(madre) = 3', $$select count(*) from public.institution_descendants(qh.inst('madre-h'))$$, '3');
select qh.rows('H: madm styles sede 1', $$update public.institutions set color='#123456', master_prompt='Sede rule' where slug='sede1-h'$$, 1);
select qh.rows('H: madm sets madre logo + prompt', $$update public.institutions set logo_url='https://x.supabase.co/storage/v1/object/public/logos/m.png', master_prompt='Madre rule', font='Georgia' where slug='madre-h'$$, 1);
select qh.rows('H: madm edits grandchild row', $$update public.institutions set master_prompt='Catedra rule' where slug='cat1-h'$$, 1);
select qh.fails('H: org_admin cannot move a unit (parent_id)', $$update public.institutions set parent_id=qh.inst('sede2-h') where slug='cat1-h'$$, 'Solo el súper admin puede mover');
select qh.eq('H: madm invites teacher to sede 2', $$select public.invite_member(qh.inst('sede2-h'),'ts2@h.com','teacher')$$, 'invited');
select qh.eq('H: madm sees invitations of descendants', $$select count(*) from public.invitations where email in ('s1adm@h.com','c1adm@h.com','ts2@h.com')$$, '3');
reset role;

-- ===== signups (invite / slug on any node) =====
insert into auth.users(id,email,raw_user_meta_data) values
 (gen_random_uuid(),'s1adm@h.com','{}'), (gen_random_uuid(),'c1adm@h.com','{}'),
 (gen_random_uuid(),'tc1@h.com','{"org_slug":"cat1-h"}'), (gen_random_uuid(),'ts2@h.com','{}'),
 (gen_random_uuid(),'tm@h.com','{"org_slug":"madre-h"}'), (gen_random_uuid(),'ts1@h.com','{"org_slug":"sede1-h"}');
select qh.eq('H: register via /org/<cátedra slug> joins the cátedra', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='tc1@h.com'$$, 'teacher@cat1-h');
select qh.eq('H: invitation to sede 2 applied', $$select role||'@'||(select slug from public.institutions i where i.id=institution_id) from public.profiles where email='ts2@h.com'$$, 'teacher@sede2-h');
select qh.eq('H: sede/cátedra admins via invitation', $$select string_agg(role||'@'||(select slug from public.institutions i where i.id=institution_id), ',' order by email) from public.profiles where email in ('s1adm@h.com','c1adm@h.com')$$, 'org_admin@cat1-h,org_admin@sede1-h');
select set_config('qh.s1adm', qh.uid('s1adm@h.com')::text, false);
select set_config('qh.c1adm', qh.uid('c1adm@h.com')::text, false);
select set_config('qh.tc1', qh.uid('tc1@h.com')::text, false);
select set_config('qh.ts2', qh.uid('ts2@h.com')::text, false);
select set_config('qh.tm', qh.uid('tm@h.com')::text, false);
select set_config('qh.ts1', qh.uid('ts1@h.com')::text, false);

-- fixtures: plans + documents
set role authenticated;
select qh.as_user(current_setting('qh.tc1'));
select qh.rows('H: cátedra teacher saves plan in own node', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),public.my_institution(),'plan C1')$$, 1);
select qh.fails('H: teacher cannot save plan into ancestor node', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),qh.inst('sede1-h'),'x')$$, 'row-level security');
select qh.as_user(current_setting('qh.ts2'));
select qh.rows('H: sede 2 teacher saves plan', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),public.my_institution(),'plan S2')$$, 1);
select qh.as_user(current_setting('qh.tm'));
select qh.rows('H: madre teacher saves plan', $$insert into public.plannings(owner_id,institution_id,title) values (auth.uid(),public.my_institution(),'plan M')$$, 1);
select qh.as_user(current_setting('qh.madm'));
select qh.rows('H: madm uploads madre playbook', $$insert into public.institution_documents(institution_id,name,content,summary) values (qh.inst('madre-h'),'m.txt','M CONTENT','M sum')$$, 1);
select qh.rows('H: madm uploads sede 2 playbook (descendant)', $$insert into public.institution_documents(institution_id,name,content,summary) values (qh.inst('sede2-h'),'s2.txt','S2 CONTENT','S2 sum')$$, 1);
select qh.as_user(current_setting('qh.s1adm'));
select qh.rows('H: sede admin uploads own playbook', $$insert into public.institution_documents(institution_id,name,content,summary) values (qh.inst('sede1-h'),'s1.txt','S1 CONTENT','S1 sum')$$, 1);
select qh.as_user(current_setting('qh.c1adm'));
select qh.rows('H: cátedra admin uploads own playbook', $$insert into public.institution_documents(institution_id,name,content,summary) values (public.my_institution(),'c1.txt','C1 CONTENT','C1 sum')$$, 1);
reset role;
insert into storage.objects(bucket_id,name) select 'logos', id::text||'/logo.png' from public.institutions where slug in ('madre-h','sede1-h','sede2-h','cat1-h');

-- ===== admin of the madre manages grandchildren =====
set role authenticated; select qh.as_user(current_setting('qh.madm'));
select qh.eq('H: madm sees classes of whole tree', $$select string_agg(title, ',' order by title) from public.plannings where title like 'plan %'$$, 'plan C1,plan M,plan S2');
select qh.eq('H: madm sees people of whole tree', $$select count(*) from public.profiles where email like '%@h.com'$$, '7');
select qh.eq('H: madm promotes grandchild teacher', $$select public.set_member_role(qh.uid('tc1@h.com'),'org_admin')$$, 'org_admin');
select qh.eq('H: madm demotes it back', $$select public.set_member_role(qh.uid('tc1@h.com'),'teacher')$$, 'teacher');
select qh.eq('H: madm reads grandchild playbook content', $$select public.get_document_content((select id from public.institution_documents where name='c1.txt'))$$, 'C1 CONTENT');
select qh.eq('H: madm invites straight into the cátedra', $$select public.invite_member(qh.inst('cat1-h'),'new-c1@h.com','teacher')$$, 'invited');
select qh.eq('H: madm moves a teacher between units it administers', $$select public.invite_member(qh.inst('sede1-h'),'ts2@h.com','teacher')$$, 'added');
select qh.eq('H: ...moved to sede 1', $$select (select slug from public.institutions i where i.id=institution_id) from public.profiles where email='ts2@h.com'$$, 'sede1-h');
select qh.eq('H: ...and back to sede 2', $$select public.invite_member(qh.inst('sede2-h'),'ts2@h.com','teacher')$$, 'added');
select qh.fails('H: madre keeps the last-admin rule', $$select public.set_member_role(auth.uid(),'teacher')$$, 'último administrador');
select qh.eq('H: madm sees logos of descendants', $$select count(*) from storage.objects where name like '%/logo.png' and split_part(name,'/',1)::uuid in (qh.inst('madre-h'),qh.inst('sede1-h'),qh.inst('sede2-h'),qh.inst('cat1-h'))$$, '4');
select qh.eq('H: madm effective config of the cátedra', $$select json_array_length(public.get_effective_config(qh.inst('cat1-h'))->'chain')$$, '3');

-- ===== admin of a sede: own subtree only =====
select qh.as_user(current_setting('qh.s1adm'));
select qh.eq('H: sede admin sees only sede + its cátedra', $$select string_agg(slug, ',' order by slug) from public.institutions$$, 'cat1-h,sede1-h');
select qh.eq('H: sede admin sees only classes of its subtree', $$select string_agg(title, ',' order by title) from public.plannings where title like 'plan %'$$, 'plan C1');
select qh.eq('H: sede admin does not see sibling/madre people', $$select count(*) from public.profiles where email in ('ts2@h.com','tm@h.com','madm@h.com')$$, '0');
select qh.eq('H: sede admin sees own + cátedra people', $$select count(*) from public.profiles where email in ('s1adm@h.com','ts1@h.com','c1adm@h.com','tc1@h.com')$$, '4');
select qh.eq('H: sede admin sees no invitations outside subtree', $$select count(*) from public.invitations where email in ('ts2@h.com','madm@h.com')$$, '0');
select qh.eq('H: sede admin sees cátedra invitation', $$select count(*) from public.invitations where email='new-c1@h.com'$$, '1');
select qh.rows('H: sede admin cannot update madre', $$update public.institutions set name='hacked' where slug='madre-h'$$, 0);
select qh.rows('H: sede admin cannot update sibling sede', $$update public.institutions set name='hacked' where slug='sede2-h'$$, 0);
select qh.rows('H: sede admin can update its cátedra', $$update public.institutions set font='Georgia' where slug='cat1-h'$$, 1);
select qh.fails('H: sede admin cannot invite into sibling', $$select public.invite_member(qh.inst('sede2-h'),'x@h.com','teacher')$$, 'No autorizado');
select qh.fails('H: sede admin cannot invite into madre', $$select public.invite_member(qh.inst('madre-h'),'x@h.com','org_admin')$$, 'No autorizado');
select qh.fails('H: sede admin cannot pull a madre teacher', $$select public.invite_member(public.my_institution(),'tm@h.com','teacher')$$, 'otra institución');
select qh.fails('H: sede admin cannot change sibling member role', $$select public.set_member_role(qh.uid('ts2@h.com'),'org_admin')$$, 'No autorizado');
select qh.fails('H: sede admin cannot remove madre admin', $$select public.remove_member(qh.uid('madm@h.com'))$$, 'No autorizado');
select qh.eq('H: sede admin playbooks: own + cátedra + madre summary', $$select string_agg(name, ',' order by name) from (select name from public.institution_documents where name in ('m.txt','s1.txt','s2.txt','c1.txt')) d$$, 'c1.txt,m.txt,s1.txt');
select qh.fails('H: sede admin cannot read madre playbook content', $$select public.get_document_content((select id from public.institution_documents where name='m.txt'))$$, 'No autorizado');
select qh.fails('H: sede admin cannot create under sibling', $$select public.create_institution('X','x-s2','',null,qh.inst('sede2-h'))$$, 'No autorizado');
select qh.fails('H: sede admin cannot create under its cátedra (depth 4)', $$select public.create_institution('X','x-c1','',null,qh.inst('cat1-h'))$$, 'Máximo 3 niveles');
select qh.eq('H: sede admin creates a 2nd cátedra', $$select (public.create_institution('Cátedra 2','cat2-h','',null,public.my_institution()) is not null)::text$$, 'true');
select qh.fails('H: sede admin cannot read madre config', $$select public.get_effective_config(qh.inst('madre-h'))$$, 'No autorizado');
select qh.fails('H: sede admin cannot read sibling config', $$select public.get_effective_config(qh.inst('sede2-h'))$$, 'No autorizado');
select qh.eq('H: sede admin reads own config (2 levels)', $$select json_array_length(public.get_effective_config()->'chain')$$, '2');
select qh.eq('H: sede admin sees only own logo folders', $$select count(*) from storage.objects where name like '%/logo.png'$$, '2');
select qh.fails('H: sede admin cannot upload into madre folder', $$insert into storage.objects(bucket_id,name) values ('logos',qh.inst('madre-h')||'/x.png')$$, 'row-level security');
select qh.rows('H: sede admin uploads into cátedra folder', $$insert into storage.objects(bucket_id,name) values ('logos',qh.inst('cat1-h')||'/x.png')$$, 1);
select qh.fails('H: sede admin cannot delete its own unit', $$select public.delete_institution(public.my_institution())$$, 'No autorizado');
select qh.eq('H: sede admin deletes empty cátedra 2', $$select public.delete_institution(qh.inst('cat2-h'))$$, 'deleted');
select qh.fails('H: sede admin cannot move members (platform fn)', $$select public.admin_move_member(qh.uid('tc1@h.com'), public.my_institution())$$, 'No autorizado');
select qh.fails('H: sede admin cannot read platform stats', $$select public.platform_stats()$$, 'No autorizado');

-- ===== methodology bars: inheritance + validation =====
select qh.as_user(current_setting('qh.madm'));
select qh.rows('H: madre hides gamification + adds custom bar', $$update public.institutions set methodology_config='{"hidden":["gamification"],"custom":[{"key":"c_mindful","label":"Mindfulness","tooltip":"Calm moments","def":30}]}' where slug='madre-h'$$, 1);
select qh.as_user(current_setting('qh.s1adm'));
select qh.rows('H: sede hides inherited custom + ttt, adds own', $$update public.institutions set methodology_config='{"hidden":["c_mindful","ttt"],"custom":[{"key":"c_lab","label":"Lab work","def":40}]}' where slug='sede1-h'$$, 1);
select qh.eq('H: config normalized (tooltip default)', $$select methodology_config->'custom'->0->>'tooltip' from public.institutions where slug='sede1-h'$$, '');
select qh.fails('H: custom label with < > rejected', $$update public.institutions set methodology_config='{"custom":[{"key":"c_x","label":"<img src=x>","def":1}]}' where slug='sede1-h'$$, 'barras inválida');
select qh.fails('H: custom key must start with c_', $$update public.institutions set methodology_config='{"custom":[{"key":"gamification","label":"X","def":1}]}' where slug='sede1-h'$$, 'barras inválida');
select qh.fails('H: custom default out of range', $$update public.institutions set methodology_config='{"custom":[{"key":"c_x","label":"X","def":150}]}' where slug='sede1-h'$$, 'barras inválida');
select qh.fails('H: unknown top-level key rejected', $$update public.institutions set methodology_config='{"evil":1}' where slug='sede1-h'$$, 'barras inválida');
select qh.fails('H: duplicate custom keys rejected', $$update public.institutions set methodology_config='{"custom":[{"key":"c_x","label":"X","def":1},{"key":"c_x","label":"Y","def":2}]}' where slug='sede1-h'$$, 'barras inválida');
select qh.fails('H: hidden must be an array of keys', $$update public.institutions set methodology_config='{"hidden":"ttt"}' where slug='sede1-h'$$, 'barras inválida');
select qh.as_user(current_setting('qh.c1adm'));
select qh.rows('H: cátedra adds its own bar', $$update public.institutions set methodology_config='{"custom":[{"key":"c_debate","label":"Debate","tooltip":"Structured debate","def":20}]}' where slug='cat1-h'$$, 1);
select qh.fails('H: cátedra admin cannot move its unit', $$update public.institutions set parent_id=null where slug='cat1-h'$$, 'Solo el súper admin puede mover');
select qh.eq('H: cátedra admin (sub-unit) may step down', $$select public.set_member_role(auth.uid(),'teacher')$$, 'teacher');

-- ===== teacher of the cátedra =====
select qh.as_user(current_setting('qh.tc1'));
select qh.eq('H: teacher sees only own institution row', $$select string_agg(slug, ',') from public.institutions$$, 'cat1-h');
select qh.eq('H: teacher reads playbook summaries of node + ancestors', $$select string_agg(name||':'||summary, ',' order by name) from (select name, summary from public.institution_documents) d where name in ('m.txt','s1.txt','s2.txt','c1.txt')$$, 'c1.txt:C1 sum,m.txt:M sum,s1.txt:S1 sum');
select qh.fails('H: teacher still cannot read playbook content', $$select content from public.institution_documents$$, 'permission denied');
select qh.fails('H: teacher cannot get_document_content of ancestor', $$select public.get_document_content((select id from public.institution_documents where name='m.txt'))$$, 'No autorizado');
select qh.eq('H: teacher config chain = madre > sede > cátedra', $$select string_agg((e->>'level')||':'||(e->>'name'), ' > ') from json_array_elements(public.get_effective_config()->'chain') e$$, '1:Madre H > 2:Sede 1 > 3:Cátedra 1');
select qh.eq('H: master prompts concatenated root first', $$select string_agg(e->>'prompt', ' | ') from json_array_elements(public.get_effective_config()->'master_prompts') e$$, 'Madre rule | Sede rule | Catedra rule');
select qh.eq('H: effective custom bars', $$select string_agg(e->>'key', ',') from json_array_elements(public.get_effective_config()->'methodology'->'custom') e$$, 'c_lab,c_debate');
select qh.eq('H: effective hidden includes gamification + ttt', $$select (public.get_effective_config()->'methodology'->'hidden')::jsonb @> '["gamification","ttt"]'::jsonb$$, 'true');
select qh.eq('H: effective branding inherits (color sede, font own, logo madre)', $$select (public.get_effective_config()->'branding'->>'color')||' '||(public.get_effective_config()->'branding'->>'font')||' '||(public.get_effective_config()->'branding'->>'logo_url')$$, '#123456 Georgia https://x.supabase.co/storage/v1/object/public/logos/m.png');
select qh.fails('H: teacher cannot read sibling config', $$select public.get_effective_config(qh.inst('sede2-h'))$$, 'No autorizado');
select qh.fails('H: teacher cannot read ancestor config directly', $$select public.get_effective_config(qh.inst('madre-h'))$$, 'No autorizado');
select qh.rows('H: teacher cannot change methodology bars', $$update public.institutions set methodology_config='{}' where slug='cat1-h'$$, 0);
select qh.fails('H: teacher cannot create units', $$select public.create_institution('X','x-t','',null,public.my_institution())$$, 'No autorizado');
select qh.eq('H: teacher sees only own plans', $$select count(*) from public.plannings where title like 'plan %'$$, '1');

-- ===== anon: public login page of any node =====
set role anon; select qh.as_user('');
select qh.eq('H: anon get_org_branding of cátedra returns effective branding + path', $$select color||' '||font||' '||path from public.get_org_branding('cat1-h')$$, '#123456 Georgia Madre H › Sede 1 › Cátedra 1');
select qh.fails('H: anon cannot call get_effective_config', $$select public.get_effective_config(null)$$, 'permission denied');
select qh.fails('H: anon cannot call institution_ancestors', $$select public.institution_ancestors(null)$$, 'permission denied');
select qh.fails('H: anon cannot call admin_move_member', $$select public.admin_move_member(null,null)$$, 'permission denied');

-- ===== superadmin: moves, cycles, depth, platform =====
set role authenticated; select qh.as_user(:'OWNER');
select qh.fails('H: cycle rejected (madre under its grandchild)', $$update public.institutions set parent_id=qh.inst('cat1-h') where slug='madre-h'$$, 'ciclo');
select qh.fails('H: self-parent rejected', $$update public.institutions set parent_id=id where slug='sede1-h'$$, 'sí misma');
select qh.fails('H: depth 4 rejected on direct insert', $$insert into public.institutions(name,slug,parent_id) values ('L4','lvl4-direct',qh.inst('cat1-h'))$$, 'Máximo 3 niveles');
select qh.fails('H: moving a 2-level subtree under a sede rejected (depth 4)', $$update public.institutions set parent_id=qh.inst('sede2-h') where slug='sede1-h'$$, 'Máximo 3 niveles');
select qh.rows('H: superadmin moves a leaf (cátedra) under sede 2', $$update public.institutions set parent_id=qh.inst('sede2-h') where slug='cat1-h'$$, 1);
select qh.rows('H: ...and back', $$update public.institutions set parent_id=qh.inst('sede1-h') where slug='cat1-h'$$, 1);
select qh.fails('H: unit with children cannot be deleted directly', $$delete from public.institutions where slug='sede1-h'$$, 'foreign key');
select qh.fails('H: delete_institution refuses units with sub-units', $$select public.delete_institution(qh.inst('sede1-h'))$$, 'sub-unidades');
select qh.fails('H: delete_institution refuses units with people', $$select public.delete_institution(qh.inst('sede2-h'))$$, 'personas');
select qh.eq('H: admin_move_member moves teacher to sede 2', $$select public.admin_move_member(qh.uid('tc1@h.com'), qh.inst('sede2-h'))$$, 'moved');
select qh.eq('H: ...profile updated', $$select (select slug from public.institutions i where i.id=institution_id)||':'||role from public.profiles where email='tc1@h.com'$$, 'sede2-h:teacher');
select qh.eq('H: admin_move_member to no institution', $$select public.admin_move_member(qh.uid('tc1@h.com'), null)$$, 'moved');
select qh.eq('H: ...no institution, teacher', $$select coalesce(institution_id::text,'none')||':'||role from public.profiles where email='tc1@h.com'$$, 'none:teacher');
select qh.fails('H: admin_move_member cannot touch superadmin', $$select public.admin_move_member(auth.uid(), qh.inst('sede2-h'))$$, 'súper admin');
select qh.fails('H: admin_move_member keeps the madre last-admin rule', $$select public.admin_move_member(qh.uid('madm@h.com'), qh.inst('sede2-h'))$$, 'último administrador');
select qh.fails('H: admin_move_member to unknown unit', $$select public.admin_move_member(qh.uid('tm@h.com'), gen_random_uuid())$$, 'No autorizado');
select qh.eq('H: platform_stats for superadmin', $$select (public.platform_stats()->>'institutions')::int >= 4 and (public.platform_stats()->>'classes')::int >= 3$$, 'true');
select qh.eq('H: superadmin effective config of any node', $$select json_array_length(public.get_effective_config(qh.inst('cat1-h'))->'chain')$$, '3');
reset role;

\echo '================ HIERARCHY RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qh.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qh.results;
