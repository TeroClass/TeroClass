-- Platform insights (super admin) + AI request metadata (ai_events) security and flow tests.
-- Run after stub + 001_base.sql (with or without the data of the other suites: numbers are checked per unit).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qi cascade;
create schema qi;
grant usage on schema qi to anon, authenticated, service_role;
create table qi.results(n serial, label text, ok boolean, detail text);
grant all on qi.results to anon, authenticated, service_role; grant all on sequence qi.results_n_seq to anon, authenticated, service_role;
create function qi.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create function qi.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qi.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qi.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qi.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qi.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qi.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qi to anon, authenticated, service_role;
create function qi.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qi.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where email = e $$;
-- insights of a unit (by slug) as the current user, one path of the JSON
create function qi.ins(days int, slug text, excl boolean, path text[]) returns text language sql as
$$ select public.platform_insights(days, case when slug is null then null else qi.inst(slug) end, excl)::jsonb #>> path $$;
grant execute on function qi.inst(text), qi.uid(text), qi.ins(int, text, boolean, text[]) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';
update public.platform_settings set ai_price_input = 2.50, ai_price_output = 10.00;

-- ===== tree: Ins Madre › Ins Sede 1 › Ins Cát 1 ; Ins Madre › Ins Sede 2 ; Ins Otra (other main institution) =====
set role authenticated; select qi.as_user(:'OWNER');
select qi.eq('I: superadmin creates the tree', $$select (public.create_institution('Ins Madre','ins-madre','ins-madm@x.com') is not null
  and public.create_institution('Ins Sede 1','ins-sede1','',null,qi.inst('ins-madre')) is not null
  and public.create_institution('Ins Sede 2','ins-sede2','',null,qi.inst('ins-madre')) is not null
  and public.create_institution('Ins Cát 1','ins-cat1','',null,qi.inst('ins-sede1')) is not null
  and public.create_institution('Ins Otra','ins-otra','') is not null)::text$$, 'true');
reset role;
insert into auth.users(id,email,raw_user_meta_data) values
  (gen_random_uuid(),'ins-madm@x.com','{"name":"Ins Admin"}'),
  (gen_random_uuid(),'ins-t1@x.com','{"org_slug":"ins-cat1","name":"T1"}'),
  (gen_random_uuid(),'ins-t2@x.com','{"org_slug":"ins-sede2","name":"T2"}'),
  (gen_random_uuid(),'ins-t3@x.com','{"org_slug":"ins-otra","name":"T3"}');
select set_config('qi.madm', qi.uid('ins-madm@x.com')::text, false);
select set_config('qi.t1', qi.uid('ins-t1@x.com')::text, false);
select set_config('qi.t2', qi.uid('ins-t2@x.com')::text, false);
select set_config('qi.t3', qi.uid('ins-t3@x.com')::text, false);
select qi.eq('I: members placed', $$select string_agg(email||':'||role||':'||(select slug from public.institutions i where i.id=institution_id), ',' order by email)
  from public.profiles where email like 'ins-%'$$, 'ins-madm@x.com:org_admin:ins-madre,ins-t1@x.com:teacher:ins-cat1,ins-t2@x.com:teacher:ins-sede2,ins-t3@x.com:teacher:ins-otra');

-- ===== recording: consume_ai_quota(p_meta) with the user's own token =====
set role authenticated; select qi.as_user(current_setting('qi.t1'));
select qi.eq('I: without meta the answer is unchanged (no event)', $$select (public.consume_ai_quota()::jsonb ? 'event')::text$$, 'false');
select set_config('qi.ev1', public.consume_ai_quota('{"kind":"generate","subjects":["  Math  ","math","Bio\u0007logy<b>","History","Art","Music","Geo"],"language":"Spanish","age_band":"teen","level":"Secondary","bars":{"gamification":70,"pbl":150,"Bad Key":5,"collab":"x","neg":-3},"inst_id":"00000000-0000-0000-0000-00000000dead","user_id":"00000000-0000-0000-0000-00000000beef"}')->>'event', false);
select qi.eq('I: meta call returns an event id', $$select (current_setting('qi.ev1') ~ '^[0-9]+$')::text$$, 'true');
select qi.fails('I: teacher cannot read ai_events', $$select count(*) from public.ai_events$$, 'permission denied');
select qi.fails('I: teacher cannot insert ai_events', $$insert into public.ai_events(user_id,kind) values (auth.uid(),'generate')$$, 'permission denied');
select qi.fails('I: teacher cannot update ai_events', $$update public.ai_events set ok = true$$, 'permission denied');
select qi.fails('I: teacher cannot call ai_meta_clean', $$select public.ai_meta_clean('{}')$$, 'permission denied');
select qi.fails('I: teacher cannot call platform_insights', $$select public.platform_insights(30)$$, 'No autorizado');
select qi.fails('I: teacher cannot call update_ai_prices', $$select public.update_ai_prices(0,0)$$, 'No autorizado');
select qi.eq('I: finish own event → true', $$select public.finish_ai_event(current_setting('qi.ev1')::bigint, true)::text$$, 'true');
select qi.eq('I: finish twice → false (only once)', $$select public.finish_ai_event(current_setting('qi.ev1')::bigint, false)::text$$, 'false');
reset role;
select qi.eq('I: stored with the profile''s unit/user (not the payload''s), sanitized',
  $$select (user_id = qi.uid('ins-t1@x.com'))::text||'|'||(inst_id = qi.inst('ins-cat1'))::text||'|'||(root_id = qi.inst('ins-madre'))::text||'|'||kind||'|'||array_to_string(subjects,';')||'|'||language||'|'||age_band||'|'||level||'|'||bars::text||'|'||ok::text
      from public.ai_events where id = current_setting('qi.ev1')::bigint$$,
  'true|true|true|generate|Math;Bio logy b;History;Art;Music|Spanish|teen|Secondary|{"neg": 0, "pbl": 100, "gamification": 70}|true');
set role authenticated; select qi.as_user(current_setting('qi.t2'));
select qi.eq('I: other user cannot finish someone else''s event', $$select public.finish_ai_event(current_setting('qi.ev1')::bigint, false)::text$$, 'false');
select set_config('qi.ev2', public.consume_ai_quota('{"kind":"<script>","subjects":"Math","language":"Klingon","age_band":"old","level":"x","bars":[1,2]}')->>'event', false);
select public.finish_ai_event(current_setting('qi.ev2')::bigint, true);
reset role;
select qi.eq('I: unknown values dropped (kind → other, no subjects/language/age/level/bars)',
  $$select kind||'|'||cardinality(subjects)||'|'||coalesce(language,'-')||'|'||coalesce(age_band,'-')||'|'||coalesce(level,'-')||'|'||bars::text from public.ai_events where id = current_setting('qi.ev2')::bigint$$,
  'other|0|-|-|-|{}');
select qi.eq('I: old events cannot be finished (15 min window)',
  $$with x as (update public.ai_events set ok = null, created_at = now() - interval '1 hour' where id = current_setting('qi.ev2')::bigint returning id) select count(*) from x$$, '1');
set role authenticated; select qi.as_user(current_setting('qi.t2'));
select qi.eq('I: ...finish refused', $$select public.finish_ai_event(current_setting('qi.ev2')::bigint, true)::text$$, 'false');
reset role; update public.ai_events set created_at = now(), ok = true where id = current_setting('qi.ev2')::bigint;
set role anon; select qi.as_user(null);
select qi.fails('I: anon cannot call platform_insights', $$select public.platform_insights(30)$$, 'permission denied');
select qi.fails('I: anon cannot call finish_ai_event', $$select public.finish_ai_event(1, true)$$, 'permission denied');
select qi.fails('I: anon cannot call consume_ai_quota(meta)', $$select public.consume_ai_quota('{}'::jsonb)$$, 'permission denied');
reset role;

-- ===== data set (as postgres: exact timestamps) =====
-- generated classes (ok): t1 (cát 1) 3 now + 1 eight days ago; t2 (sede 2) 2 now (Spanish/English); t3 (otra) 1;
-- the owner 2 (no unit); one failed; one student handout (t1); one 40 days ago (t2)
insert into public.ai_events (user_id, inst_id, root_id, kind, subjects, language, age_band, level, bars, ok, created_at) values
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), qi.inst('ins-madre'), 'generate', '{Math}', 'Spanish', 'teen', 'Secondary', '{"gamification":50}', true, now()),
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), qi.inst('ins-madre'), 'generate', '{Math,Physics}', 'Spanish', 'teen', 'Secondary', '{"gamification":30}', true, now()),
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), qi.inst('ins-madre'), 'generate', '{Physics}', 'Spanish', 'olderteen', 'Secondary', '{}', true, now() - interval '8 days'),
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), qi.inst('ins-madre'), 'student', '{Math}', 'Spanish', 'teen', null, '{}', true, now()),
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), qi.inst('ins-madre'), 'generate', '{Math}', 'Spanish', 'teen', null, '{}', false, now()),
  (qi.uid('ins-t2@x.com'), qi.inst('ins-sede2'), qi.inst('ins-madre'), 'generate', '{History}', 'English', 'adult', null, '{}', true, now()),
  (qi.uid('ins-t2@x.com'), qi.inst('ins-sede2'), qi.inst('ins-madre'), 'generate', '{history}', 'Spanish', 'adult', null, '{}', true, now()),
  (qi.uid('ins-t2@x.com'), qi.inst('ins-sede2'), qi.inst('ins-madre'), 'generate', '{Old}', 'Spanish', 'adult', null, '{}', true, now() - interval '40 days'),
  (qi.uid('ins-t3@x.com'), qi.inst('ins-otra'), qi.inst('ins-otra'), 'generate', '{Art}', 'French', 'primary', null, '{}', true, now()),
  (:'OWNER', qi.inst('ins-sede1'), qi.inst('ins-madre'), 'generate', '{Owner}', 'English', 'adult', null, '{}', true, now()),
  (:'OWNER', qi.inst('ins-sede1'), qi.inst('ins-madre'), 'generate', '{Owner}', 'English', 'adult', null, '{}', true, now());
-- saved classes
insert into public.plannings (owner_id, institution_id, title, data, created_at, updated_at) values
  (qi.uid('ins-t1@x.com'), qi.inst('ins-cat1'), 'p1', '{}', now(), now()),
  (qi.uid('ins-t2@x.com'), qi.inst('ins-sede2'), 'p2', '{}', now(), now()),
  (:'OWNER', qi.inst('ins-sede1'), 'p3', '{}', now(), now());
-- server-recorded tokens (only with the service key): 1M prompt + 0.5M completion in cát 1; 2M prompt in otra
insert into public.ai_request_log (user_id, root_id, inst_id, scope, prompt_tokens, completion_tokens, total_tokens, kind) values
  (qi.uid('ins-t1@x.com'), qi.inst('ins-madre'), qi.inst('ins-cat1'), 'institution', 600000, 300000, 900000, 'generate'),
  (qi.uid('ins-t1@x.com'), qi.inst('ins-madre'), qi.inst('ins-cat1'), 'institution', 400000, 200000, 600000, 'student'),
  (qi.uid('ins-t3@x.com'), qi.inst('ins-otra'), qi.inst('ins-otra'), 'institution', 2000000, 0, 2000000, 'generate'),
  (:'OWNER', qi.inst('ins-madre'), qi.inst('ins-sede1'), 'unlimited', 1000000, 1000000, 2000000, 'generate');
insert into public.institution_documents (institution_id, name, summary) values (qi.inst('ins-sede2'), 'pb.txt', '- core');

-- ===== admins are denied; superadmin gets one JSON =====
set role authenticated; select qi.as_user(current_setting('qi.madm'));
select qi.fails('I: institution admin cannot call platform_insights', $$select public.platform_insights(30, qi.inst('ins-madre'))$$, 'No autorizado');
select qi.fails('I: institution admin cannot read ai_events', $$select count(*) from public.ai_events$$, 'permission denied');
select qi.fails('I: institution admin cannot change AI prices', $$select public.update_ai_prices(1,1)$$, 'No autorizado');
select qi.as_user(:'OWNER');
select qi.eq('I: superadmin: keys', $$select string_agg(k, ',' order by k) from jsonb_object_keys(public.platform_insights(30)::jsonb) k$$,
  'content,costs,days,exclude_self,from,to,tracking_since,unit,usage');
select qi.fails('I: superadmin cannot read ai_events directly either (only via the RPC)', $$select count(*) from public.ai_events$$, 'permission denied');
select qi.eq('I: per_day has one entry per day (7 / 30 / 90)', $$select jsonb_array_length(qi.ins(7,null,true,'{usage,per_day}')::jsonb)||'/'||jsonb_array_length(qi.ins(30,null,true,'{usage,per_day}')::jsonb)||'/'||jsonb_array_length(qi.ins(90,null,true,'{usage,per_day}')::jsonb)$$, '7/30/90');
select qi.eq('I: days clamped (0 → 1, 9999 → 366)', $$select qi.ins(0,null,true,'{days}')||'/'||qi.ins(9999,null,true,'{days}')$$, '1/366');
select qi.fails('I: unknown unit → error', $$select public.platform_insights(30, '00000000-0000-0000-0000-00000000dead')$$, 'Unidad no encontrada');

-- ===== subtree filtering =====
-- madre tree (30 days, exclude self): t1 → 2 now + 1 eight days ago + ev1 (Math etc.) = 4 ; t2 → 2 + ev2 is kind other = 2 → 6
select qi.eq('I: madre subtree: classes (30d)', $$select qi.ins(30,'ins-madre',true,'{usage,classes}')$$, '6');
select qi.eq('I: sede 1 subtree = sede 1 + cátedra 1 only', $$select qi.ins(30,'ins-sede1',true,'{usage,classes}')$$, '4');
select qi.eq('I: cátedra 1 alone', $$select qi.ins(30,'ins-cat1',true,'{usage,classes}')$$, '4');
select qi.eq('I: sede 2 alone', $$select qi.ins(30,'ins-sede2',true,'{usage,classes}')$$, '2');
select qi.eq('I: other main institution separate', $$select qi.ins(30,'ins-otra',true,'{usage,classes}')$$, '1');
select qi.eq('I: all ≥ madre + otra', $$select ((qi.ins(30,null,true,'{usage,classes}'))::int >= 7)::text$$, 'true');
select qi.eq('I: 7-day period drops the 8-day-old class', $$select qi.ins(7,'ins-cat1',true,'{usage,classes}')$$, '3');
select qi.eq('I: 90-day period includes the 40-day-old class', $$select qi.ins(90,'ins-sede2',true,'{usage,classes}')$$, '3');
select qi.eq('I: handouts / failed / saved (cát 1)', $$select qi.ins(30,'ins-cat1',true,'{usage,handouts}')||'/'||qi.ins(30,'ins-cat1',true,'{usage,failed}')||'/'||qi.ins(30,'ins-cat1',true,'{usage,saved}')$$, '1/1/1');
select qi.eq('I: top institutions inside a unit = its units', $$select string_agg((x->>'name')||':'||(x->>'classes'), ',') from jsonb_array_elements(qi.ins(30,'ins-madre',true,'{usage,top_institutions}')::jsonb) x$$, 'Ins Cát 1:4,Ins Sede 2:2');
select qi.eq('I: top institutions (all) grouped by main institution', $$select (x->>'classes') from jsonb_array_elements(qi.ins(30,null,true,'{usage,top_institutions}')::jsonb) x where x->>'name'='Ins Madre'$$, '6');
select qi.eq('I: active teachers d1/d7/d30 (madre)', $$select qi.ins(30,'ins-madre',true,'{usage,active,d1}')||'/'||qi.ins(30,'ins-madre',true,'{usage,active,d7}')||'/'||qi.ins(30,'ins-madre',true,'{usage,active,d30}')$$, '2/2/2');
select qi.eq('I: returning users: t1 active in 2 distinct weeks (30d), only 1 week in 7d', $$select qi.ins(30,'ins-cat1',true,'{usage,returning_users}')||'/'||qi.ins(7,'ins-cat1',true,'{usage,returning_users}')$$, '1/0');
select qi.eq('I: new users in the unit (cát 1 teacher)', $$select qi.ins(30,'ins-cat1',true,'{usage,new_users}')$$, '1');
select qi.eq('I: unit echo', $$select qi.ins(30,'ins-sede1',true,'{unit,name}')$$, 'Ins Sede 1');

-- ===== exclude my own activity =====
select qi.eq('I: owner''s classes excluded by default (sede 1)', $$select qi.ins(30,'ins-sede1',true,'{usage,classes}')$$, '4');
select qi.eq('I: ...included when exclude_self = false', $$select qi.ins(30,'ins-sede1',false,'{usage,classes}')$$, '6');
select qi.eq('I: owner''s saved class too', $$select qi.ins(30,'ins-sede1',true,'{usage,saved}')||'/'||qi.ins(30,'ins-sede1',false,'{usage,saved}')$$, '1/2');
select qi.eq('I: owner''s tokens too', $$select qi.ins(30,'ins-sede1',true,'{costs,total_tokens}')||'/'||qi.ins(30,'ins-sede1',false,'{costs,total_tokens}')$$, '1500000/3500000');
select qi.eq('I: default exclude_self is true', $$select (public.platform_insights(30, qi.inst('ins-sede1'))::jsonb #>> '{usage,classes}')$$, '4');

-- ===== content =====
select qi.eq('I: top subjects (case-insensitive, cát 1)', $$select string_agg((x->>'name')||':'||(x->>'count'), ',') from jsonb_array_elements(qi.ins(30,'ins-cat1',true,'{content,subjects}')::jsonb) x$$, 'Math:3,Physics:2,Art:1,Bio logy b:1,History:1,Music:1');
select qi.eq('I: subjects merged by case (sede 2)', $$select string_agg((x->>'name')||':'||(x->>'count'), ',') from jsonb_array_elements(qi.ins(30,'ins-sede2',true,'{content,subjects}')::jsonb) x$$, 'History:2');
select qi.eq('I: languages (madre)', $$select string_agg((x->>'name')||':'||(x->>'count'), ',') from jsonb_array_elements(qi.ins(30,'ins-madre',true,'{content,languages}')::jsonb) x$$, 'Spanish:5,English:1');
select qi.eq('I: age bands (cát 1)', $$select string_agg((x->>'name')||':'||(x->>'count'), ',') from jsonb_array_elements(qi.ins(30,'ins-cat1',true,'{content,age_bands}')::jsonb) x$$, 'teen:3,olderteen:1');
select qi.eq('I: average bars (cát 1)', $$select string_agg((x->>'key')||':'||(x->>'avg')||'/'||(x->>'count'), ',') from jsonb_array_elements(qi.ins(30,'ins-cat1',true,'{content,bars}')::jsonb) x$$, 'gamification:50.0/3,neg:0.0/1,pbl:100.0/1');
select qi.eq('I: institutions with a playbook (madre tree: 1 of 4)', $$select qi.ins(30,'ins-madre',true,'{content,playbook_institutions}')||'/'||qi.ins(30,'ins-madre',true,'{content,institutions}')$$, '1/4');

-- ===== costs =====
select qi.eq('I: tokens in/out/total and classes (cát 1)', $$select qi.ins(30,'ins-cat1',true,'{costs,prompt_tokens}')||'/'||qi.ins(30,'ins-cat1',true,'{costs,completion_tokens}')||'/'||qi.ins(30,'ins-cat1',true,'{costs,total_tokens}')||'/'||qi.ins(30,'ins-cat1',true,'{costs,classes}')$$, '1000000/500000/1500000/1');
select qi.eq('I: estimated USD with GPT-4o defaults (1M×2.50 + 0.5M×10)', $$select qi.ins(30,'ins-cat1',true,'{costs,usd}')::numeric::text$$, '7.5000');
select qi.eq('I: recorded_ever', $$select qi.ins(30,'ins-cat1',true,'{costs,recorded_ever}')$$, 'true');
select qi.eq('I: cost by institution (all, grouped by main institution)', $$select (x->>'usd')::numeric::text from jsonb_array_elements(qi.ins(30,null,true,'{costs,by_institution}')::jsonb) x where x->>'name'='Ins Otra'$$, '5.0000');
select qi.eq('I: superadmin changes AI prices', $$select public.update_ai_prices(5, 20)::jsonb->>'ai_price_output'$$, '20.0000');
select qi.eq('I: ...and the estimate follows', $$select qi.ins(30,'ins-cat1',true,'{costs,usd}')::numeric::text$$, '15.0000');
select qi.fails('I: invalid price rejected', $$select public.update_ai_prices(-1, 5)$$, 'Precio de IA inválido');
select qi.eq('I: prices in the platform overview', $$select (public.platform_billing_overview()::jsonb #>> '{settings,ai_price_input}')::numeric::text$$, '5.0000');
reset role;
update public.platform_settings set ai_price_input = 2.50, ai_price_output = 10.00;

\echo '================ INSIGHTS RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qi.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qi.results;
