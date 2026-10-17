-- Plan & usage (seats + monthly AI tokens + token packs) security + flow tests.
-- Run after stub + 001_base.sql (with or without the data of security.sql / hierarchy.sql).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qb cascade;
create schema qb;
grant usage on schema qb to anon, authenticated, service_role;
create table qb.results(n serial, label text, ok boolean, detail text);
grant all on qb.results to anon, authenticated, service_role; grant all on sequence qb.results_n_seq to anon, authenticated, service_role;
create function qb.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create function qb.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qb.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qb.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qb.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qb.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qb.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qb to anon, authenticated, service_role;
create function qb.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qb.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where email = e $$;
-- test-only reads (run as postgres): what the server stored
create function qb.bal(s text) returns bigint language sql security definer as $$ select extra_tokens_balance from public.billing_accounts where root_id = qb.inst(s) $$;
create function qb.used(s text) returns text language sql security definer as
$$ select coalesce(sum(used),0)||'/'||coalesce(sum(extra_used),0) from public.token_usage_monthly where scope='institution' and account_id = qb.inst(s) and month = public.billing_month() $$;
grant execute on function qb.inst(text), qb.uid(text), qb.bal(text), qb.used(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER'; -- manual grant (README); no auto-promotion by email
-- known starting settings (the suite may run on a DB where they were changed)
update public.platform_settings set pack_tokens=2000000, pack_price=11.99, currency='USD', personal_monthly_tokens=200000, default_seats=10, default_monthly_tokens=2000000;

-- ===== defaults =====
select qb.eq('B: settings defaults (pack 2M / 11.99 USD / personal 200k / 10 seats / 2M per month)',
  $$select pack_tokens||'/'||pack_price||'/'||currency||'/'||personal_monthly_tokens||'/'||default_seats||'/'||default_monthly_tokens from public.platform_settings$$,
  '2000000/11.99/USD/200000/10/2000000');
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: superadmin creates madre A', $$select (public.create_institution('Bill A','bill-a','billa@x.com') is not null)::text$$, 'true');
select qb.eq('B: superadmin creates madre B', $$select (public.create_institution('Bill B','bill-b','billb@x.com') is not null)::text$$, 'true');
reset role;
select qb.eq('B: new madre gets the default plan', $$select seats||'/'||monthly_tokens||'/'||extra_tokens_balance from public.billing_accounts where root_id=qb.inst('bill-a')$$, '10/2000000/0');
insert into auth.users(id,email,raw_user_meta_data) values
  (gen_random_uuid(),'billa@x.com','{"name":"Admin A"}'), (gen_random_uuid(),'billb@x.com','{"name":"Admin B"}'),
  (gen_random_uuid(),'ta1@x.com','{"org_slug":"bill-a","name":"Teacher A1"}'),
  (gen_random_uuid(),'tb1@x.com','{"org_slug":"bill-b","name":"Teacher B1"}'),
  (gen_random_uuid(),'solo@x.com','{"name":"Solo"}');
select set_config('qb.adma', qb.uid('billa@x.com')::text, false);
select set_config('qb.admb', qb.uid('billb@x.com')::text, false);
select set_config('qb.ta1',  qb.uid('ta1@x.com')::text, false);
select set_config('qb.solo', qb.uid('solo@x.com')::text, false);
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.eq('B: admin A creates a sub-unit with its admin', $$select (public.create_institution('Bill A Sede','bill-a-s1','sadm@x.com',null,qb.inst('bill-a')) is not null)::text$$, 'true');
reset role;
select qb.eq('B: sub-units have no plan row of their own', $$select count(*) from public.billing_accounts where root_id=qb.inst('bill-a-s1')$$, '0');
insert into auth.users(id,email,raw_user_meta_data) values
  (gen_random_uuid(),'sadm@x.com','{"name":"Sede Admin"}'), (gen_random_uuid(),'ts1@x.com','{"org_slug":"bill-a-s1","name":"Teacher S1"}');
select set_config('qb.sadm', qb.uid('sadm@x.com')::text, false);
select set_config('qb.ts1',  qb.uid('ts1@x.com')::text, false);
select qb.eq('B: members placed (seat available)', $$select string_agg(email||':'||role||':'||coalesce((select slug from public.institutions i where i.id=institution_id),'-'), ',' order by email) from public.profiles where email in ('billa@x.com','sadm@x.com','ta1@x.com','ts1@x.com')$$,
  'billa@x.com:org_admin:bill-a,sadm@x.com:org_admin:bill-a-s1,ta1@x.com:teacher:bill-a,ts1@x.com:teacher:bill-a-s1');

-- ===== teacher: no billing access at all =====
set role authenticated; select qb.as_user(current_setting('qb.ta1'));
select qb.fails('B: teacher cannot read billing_accounts', $$select count(*) from public.billing_accounts$$, 'permission denied');
select qb.fails('B: teacher cannot read platform_settings', $$select count(*) from public.platform_settings$$, 'permission denied');
select qb.fails('B: teacher cannot read token_usage_monthly', $$select count(*) from public.token_usage_monthly$$, 'permission denied');
select qb.fails('B: teacher cannot insert a purchase request directly', $$insert into public.token_purchase_requests(root_id,pack_tokens,price) values (qb.inst('bill-a'),99999999,0)$$, 'permission denied');
select qb.fails('B: teacher cannot write the request log', $$insert into public.ai_request_log(user_id,scope,total_tokens) values (auth.uid(),'personal',-5000000)$$, 'permission denied');
select qb.fails('B: teacher cannot call ai_budget_check (service only)', $$select public.ai_budget_check(auth.uid())$$, 'permission denied');
select qb.fails('B: teacher cannot call ai_record_usage (service only)', $$select public.ai_record_usage(auth.uid(),-100,-100,'x')$$, 'permission denied');
select qb.fails('B: teacher cannot call billing_service_ping', $$select public.billing_service_ping()$$, 'permission denied');
select qb.fails('B: teacher cannot call internal helpers (ensure_billing_account)', $$select public.ensure_billing_account(qb.inst('bill-a'))$$, 'permission denied');
select qb.fails('B: teacher cannot call internal helpers (seats_used)', $$select public.seats_used(qb.inst('bill-a'))$$, 'permission denied');
select qb.fails('B: teacher get_billing_summary refused', $$select public.get_billing_summary(null)$$, 'No autorizado');
select qb.fails('B: teacher get_seat_status refused', $$select public.get_seat_status(null)$$, 'No autorizado');
select qb.fails('B: teacher request_token_pack refused', $$select public.request_token_pack()$$, 'No autorizado');
select qb.fails('B: teacher list_purchase_requests refused', $$select public.list_purchase_requests(null)$$, 'No autorizado');
select qb.fails('B: teacher decide_purchase_request refused', $$select public.decide_purchase_request(gen_random_uuid(),true,'')$$, 'No autorizado');
select qb.fails('B: teacher set_institution_plan refused', $$select public.set_institution_plan(qb.inst('bill-a'),999,999999999)$$, 'No autorizado');
select qb.fails('B: teacher update_platform_settings refused', $$select public.update_platform_settings(1000,0,'USD',999999999,999,999999999)$$, 'No autorizado');
select qb.fails('B: teacher platform_billing_overview refused', $$select public.platform_billing_overview()$$, 'No autorizado');
reset role;
set role anon; select qb.as_user(null);
select qb.fails('B: anon get_billing_summary denied', $$select public.get_billing_summary(null)$$, 'permission denied');
select qb.fails('B: anon ai_record_usage denied', $$select public.ai_record_usage(null,1,1,'x')$$, 'permission denied');
select qb.eq('B: anon get_org_branding exposes only seats_full', $$select seats_full::text from public.get_org_branding('bill-a')$$, 'false');
reset role;

-- ===== service role: consumption order =====
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: superadmin sets plan A (10 seats, 1000 tokens/month)', $$select public.set_institution_plan(qb.inst('bill-a'),10,1000)->>'monthly_tokens'$$, '1000');
select qb.fails('B: plan only on the madre', $$select public.set_institution_plan(qb.inst('bill-a-s1'),5,5)$$, 'institución madre');
select qb.fails('B: plan validates seats', $$select public.set_institution_plan(qb.inst('bill-a'),-1,5)$$, 'asientos');
select qb.eq('B: superadmin sets pack 5000 tokens for 9.5 EUR', $$select public.update_platform_settings(5000,9.5,'eur',200000,10,2000000)->>'currency'$$, 'EUR');
select qb.fails('B: settings reject a bad currency', $$select public.update_platform_settings(5000,9.5,'euros',200000,10,2000000)$$, 'Moneda');
select qb.fails('B: settings reject a tiny pack', $$select public.update_platform_settings(10,9.5,'USD',200000,10,2000000)$$, 'paquete');
reset role;
set role service_role;
select qb.eq('B: budget check (teacher of A) before use', $$select (j->>'allowed')||'/'||(j->>'scope')||'/'||(j->>'allowance')||'/'||(j->>'remaining')||'/'||(j->>'warn')||'/'||(j->>'is_admin') from (select public.ai_budget_check(qb.uid('ta1@x.com')) j) x$$, 'true/institution/1000/1000/false/false');
select qb.eq('B: sub-unit teacher uses the madre account', $$select public.ai_budget_check(qb.uid('ts1@x.com'))->>'root_id' = qb.inst('bill-a')::text$$, 'true');
select qb.eq('B: record 600+200 → 200 left, warn', $$select (j->>'remaining')||'/'||(j->>'warn') from (select public.ai_record_usage(qb.uid('ta1@x.com'),600,200,'generate') j) x$$, '200/true');
select qb.eq('B: record 300 more → allowance used, overflow kept in month', $$select (j->>'remaining')||'/'||(j->>'allowed')||'/'||(j->>'used_month') from (select public.ai_record_usage(qb.uid('ts1@x.com'),250,50,'student') j) x$$, '0/false/1100');
select qb.eq('B: admin flags in budget (root admin can buy, sub admin cannot)', $$select (public.ai_budget_check(qb.uid('billa@x.com'))->>'can_buy')||'/'||(public.ai_budget_check(qb.uid('sadm@x.com'))->>'is_admin')||'/'||(public.ai_budget_check(qb.uid('sadm@x.com'))->>'can_buy')$$, 'true/true/false');
select qb.eq('B: record sanitizes kind and negative counts', $$select (public.ai_record_usage(qb.uid('ta1@x.com'),-50,-50,'<Script>!')->>'used_month')$$, '1100');
reset role;
select qb.eq('B: kind stored sanitized', $$select kind||':'||total_tokens from public.ai_request_log where user_id=qb.uid('ta1@x.com') order by id desc limit 1$$, 'script:0');

-- ===== purchase requests =====
set role authenticated; select qb.as_user(current_setting('qb.sadm'));
select qb.fails('B: sub-unit admin cannot request a pack', $$select public.request_token_pack()$$, 'madre');
select qb.eq('B: sub-unit admin sees the account summary', $$select (public.get_billing_summary(null)->>'root_id') = qb.inst('bill-a')::text and (public.get_billing_summary(null)->>'can_request') = 'false'$$, 'true');
select qb.eq('B: sub-unit admin detail only covers their unit (no teacher of the madre)', $$select (select string_agg(x->>'email', ',') from json_array_elements(public.get_billing_summary(null)->'by_teacher') x)$$, 'ts1@x.com');
select qb.eq('B: sub-unit admin by_unit only their unit', $$select (select string_agg(x->>'name', ',') from json_array_elements(public.get_billing_summary(null)->'by_unit') x)$$, 'Bill A Sede');
select qb.eq('B: sub-unit admin request log rows = their unit only', $$select count(*) from public.ai_request_log$$, '1');
reset role;
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.eq('B: root admin summary totals', $$select (j->>'used_month')||'/'||(j->>'monthly_tokens')||'/'||(j->>'remaining')||'/'||(j->>'seats_used')||'/'||(j->>'seats')||'/'||(j->>'can_request') from (select public.get_billing_summary(null) j) x$$, '1100/1000/0/4/10/true');
select qb.eq('B: root admin sees all teachers of the account', $$select (select string_agg(x->>'email', ',' order by x->>'email') from json_array_elements(public.get_billing_summary(null)->'by_teacher') x)$$, 'ta1@x.com,ts1@x.com');
select qb.eq('B: root admin get_seat_status', $$select (j->>'used')||'/'||(j->>'seats')||'/'||(j->>'full') from (select public.get_seat_status(null) j) x$$, '4/10/false');
select qb.eq('B: root admin requests a pack (snapshot 5000 / 9.50 EUR)', $$select (j->>'pack_tokens')||'/'||(j->>'price')||'/'||(j->>'currency')||'/'||(j->>'status') from (select public.request_token_pack() j) x$$, '5000/9.50/EUR/pending');
select qb.fails('B: only one pending request at a time', $$select public.request_token_pack()$$, 'pendiente');
select qb.eq('B: root admin lists own requests', $$select json_array_length(public.list_purchase_requests(null))$$, '1');
select qb.fails('B: org admin cannot approve', $$select public.decide_purchase_request((select id from public.token_purchase_requests where root_id=qb.inst('bill-a') and status='pending'),true,'')$$, 'No autorizado');
select qb.fails('B: org admin cannot change own plan via RPC', $$select public.set_institution_plan(qb.inst('bill-a'),999,999999)$$, 'No autorizado');
select qb.fails('B: org admin cannot read billing_accounts directly', $$select count(*) from public.billing_accounts$$, 'permission denied');
select qb.fails('B: org admin cannot update purchase requests directly', $$update public.token_purchase_requests set status='approved'$$, 'permission denied');
reset role;
set role authenticated; select qb.as_user(current_setting('qb.admb'));
select qb.fails('B: admin of B cannot read A summary', $$select public.get_billing_summary(qb.inst('bill-a'))$$, 'No autorizado');
select qb.fails('B: admin of B cannot read A summary via a sub-unit', $$select public.get_billing_summary(qb.inst('bill-a-s1'))$$, 'No autorizado');
select qb.fails('B: admin of B cannot read A seats', $$select public.get_seat_status(qb.inst('bill-a'))$$, 'No autorizado');
select qb.eq('B: admin of B lists no requests of A', $$select json_array_length(public.list_purchase_requests(null))$$, '0');
select qb.eq('B: admin of B sees no A purchase rows (RLS)', $$select count(*) from public.token_purchase_requests$$, '0');
select qb.eq('B: admin of B sees no A request log (RLS)', $$select count(*) from public.ai_request_log where root_id=qb.inst('bill-a')$$, '0');
select qb.eq('B: admin of B can request for B only (own madre)', $$select public.request_token_pack()->>'status'$$, 'pending');
reset role;
select qb.eq('B: B request is for B', $$select count(*) from public.token_purchase_requests where root_id=qb.inst('bill-b') and status='pending'$$, '1');
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: superadmin lists all pending', $$select json_array_length(public.list_purchase_requests('pending'))$$, '2');
select qb.fails('B: list validates status', $$select public.list_purchase_requests('bogus')$$, 'Estado');
select qb.eq('B: approve A request', $$select public.decide_purchase_request((select id from public.token_purchase_requests where root_id=qb.inst('bill-a') and status='pending'),true,'paid by transfer')$$, 'approved');
select qb.fails('B: approving twice is refused', $$select public.decide_purchase_request((select id from public.token_purchase_requests where root_id=qb.inst('bill-a') order by created_at desc limit 1),true,'')$$, 'ya fue resuelta');
select qb.fails('B: rejecting an approved request is refused', $$select public.decide_purchase_request((select id from public.token_purchase_requests where root_id=qb.inst('bill-a') order by created_at desc limit 1),false,'')$$, 'ya fue resuelta');
select qb.eq('B: overview shows A extra balance + no pending', $$select (x->>'extra_balance')||'/'||(x->>'pending')||'/'||(x->>'used_month') from json_array_elements(public.platform_billing_overview()->'accounts') x where x->>'slug'='bill-a'$$, '5000/false/1100');
select qb.eq('B: reject B request with note', $$select public.decide_purchase_request((select id from public.token_purchase_requests where root_id=qb.inst('bill-b') and status='pending'),false,'  no payment received  ')$$, 'rejected');
reset role;
select qb.eq('B: approval added the pack exactly once', $$select qb.bal('bill-a')$$, '5000');
select qb.eq('B: rejection adds nothing', $$select qb.bal('bill-b')$$, '0');
set role authenticated; select qb.as_user(current_setting('qb.admb'));
select qb.eq('B: admin B sees the rejection note', $$select (x->>'status')||':'||(x->>'note') from json_array_elements(public.list_purchase_requests(null)) x$$, 'rejected:no payment received');
select qb.eq('B: admin B can request again after a rejection', $$select public.request_token_pack()->>'status'$$, 'pending');
reset role;

-- ===== extra balance is used after the monthly allowance =====
set role service_role;
select qb.eq('B: allowance gone, extra 5000 → allowed again', $$select (j->>'allowed')||'/'||(j->>'remaining')||'/'||(j->>'extra_balance') from (select public.ai_budget_check(qb.uid('ta1@x.com')) j) x$$, 'true/5000/5000');
select qb.eq('B: record 1000 → paid from extra', $$select public.ai_record_usage(qb.uid('ta1@x.com'),700,300,'generate')->>'extra_balance'$$, '4000');
reset role;
select qb.eq('B: month used unchanged / extra_used 1000', $$select qb.used('bill-a')$$, '1100/1000');
set role service_role;
select qb.eq('B: record 4500 → extra stops at 0, rest counted in the month', $$select (j->>'extra_balance')||'/'||(j->>'allowed') from (select public.ai_record_usage(qb.uid('ts1@x.com'),4000,500,'generate') j) x$$, '0/false');
reset role;
select qb.eq('B: month used 1600 / extra_used 5000', $$select qb.used('bill-a')$$, '1600/5000');
select qb.eq('B: log: 5 rows for A, from_extra sums 5000', $$select count(*)||'/'||sum(from_extra) from public.ai_request_log where root_id=qb.inst('bill-a')$$, '5/5000');

-- ===== monthly reset (calendar month, UTC) =====
update public.token_usage_monthly set month = (month - interval '1 month')::date where scope='institution' and account_id=qb.inst('bill-a');
set role service_role;
select qb.eq('B: new month → allowance available again (old month ignored)', $$select (j->>'used_month')||'/'||(j->>'remaining')||'/'||(j->>'allowed') from (select public.ai_budget_check(qb.uid('ta1@x.com')) j) x$$, '0/1000/true');
select qb.eq('B: record in new month starts a new row', $$select public.ai_record_usage(qb.uid('ta1@x.com'),100,0,'generate')->>'used_month'$$, '100');
reset role;
select qb.eq('B: two month rows for A', $$select count(*) from public.token_usage_monthly where scope='institution' and account_id=qb.inst('bill-a')$$, '2');

-- ===== personal allowance and superadmin =====
set role service_role;
select qb.eq('B: user without institution → personal 200k', $$select (j->>'scope')||'/'||(j->>'allowance')||'/'||(j->>'can_buy') from (select public.ai_budget_check(qb.uid('solo@x.com')) j) x$$, 'personal/200000/false');
select qb.eq('B: personal record 150k → no warn yet', $$select (j->>'remaining')||'/'||(j->>'warn') from (select public.ai_record_usage(qb.uid('solo@x.com'),100000,50000,'generate') j) x$$, '50000/false');
select qb.eq('B: personal record 20k → warn', $$select (j->>'remaining')||'/'||(j->>'warn') from (select public.ai_record_usage(qb.uid('solo@x.com'),20000,0,'generate') j) x$$, '30000/true');
select qb.eq('B: superadmin is unlimited', $$select (j->>'allowed')||'/'||(j->>'scope') from (select public.ai_budget_check('00000000-0000-0000-0000-000000000001'::uuid) j) x$$, 'true/unlimited');
select qb.eq('B: superadmin usage is logged but not deducted', $$select public.ai_record_usage('00000000-0000-0000-0000-000000000001'::uuid,5000000,5000000,'generate')->>'allowed'$$, 'true');
select qb.eq('B: service role can ping', $$select public.billing_service_ping()::text$$, 'true');
reset role;
select qb.eq('B: superadmin log row capped and scoped unlimited', $$select scope||':'||total_tokens from public.ai_request_log where user_id='00000000-0000-0000-0000-000000000001'::uuid order by id desc limit 1$$, 'unlimited:4000000');
select qb.eq('B: no usage row for superadmin', $$select count(*) from public.token_usage_monthly where account_id='00000000-0000-0000-0000-000000000001'::uuid$$, '0');
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: lower personal allowance to 100k', $$select public.update_platform_settings(5000,9.5,'EUR',100000,10,2000000)->>'personal_monthly_tokens'$$, '100000');
reset role;
set role service_role;
select qb.eq('B: personal over the new allowance → blocked', $$select (j->>'allowed')||'/'||(j->>'remaining') from (select public.ai_budget_check(qb.uid('solo@x.com')) j) x$$, 'false/0');
reset role;
set role authenticated; select qb.as_user(current_setting('qb.solo'));
select qb.eq('B: users read only their own request log', $$select count(*)||'/'||count(*) filter (where user_id=auth.uid()) from public.ai_request_log$$, '2/2');
reset role;

-- ===== seats =====
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: plan A down to 4 seats (all used)', $$select public.set_institution_plan(qb.inst('bill-a'),4,1000)->>'seats'$$, '4');
reset role;
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.eq('B: seat status full', $$select public.get_seat_status(null)->>'full'$$, 'true');
select qb.fails('B: invite of a new email refused when full', $$select public.invite_member(qb.inst('bill-a'),'new1@x.com','teacher')$$, 'No quedan asientos');
select qb.fails('B: invite into a sub-unit refused too (shared seats)', $$select public.invite_member(qb.inst('bill-a-s1'),'new1@x.com','teacher')$$, 'No quedan asientos');
select qb.fails('B: adding an existing account without institution refused', $$select public.invite_member(qb.inst('bill-a'),'solo@x.com','teacher')$$, 'No quedan asientos');
select qb.eq('B: moving a member inside the account still works when full', $$select public.invite_member(qb.inst('bill-a-s1'),'ta1@x.com','teacher')$$, 'added');
select qb.fails('B: creating a sub-unit with a new admin refused when full', $$select public.create_institution('Bill A Sede 2','bill-a-s2','new2@x.com',null,qb.inst('bill-a'))$$, 'No quedan asientos');
reset role;
select qb.eq('B: ...and the sub-unit was not created (atomic)', $$select count(*) from public.institutions where slug='bill-a-s2'$$, '0');
select qb.eq('B: get_org_branding reports seats_full', $$select seats_full::text from public.get_org_branding('bill-a-s1')$$, 'true');
insert into auth.users(id,email,raw_user_meta_data) values (gen_random_uuid(),'late@x.com','{"org_slug":"bill-a"}');
select qb.eq('B: slug signup when full → account without institution', $$select coalesce(institution_id::text,'none')||':'||role from public.profiles where email='late@x.com'$$, 'none:teacher');
-- an invitation saved while there was room, accepted after the seats filled up
update public.billing_accounts set seats = 5 where root_id = qb.inst('bill-a');
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.eq('B: invitation saved while a seat is free', $$select public.invite_member(qb.inst('bill-a'),'inv1@x.com','org_admin')$$, 'invited');
reset role;
update public.billing_accounts set seats = 4 where root_id = qb.inst('bill-a');
insert into auth.users(id,email,raw_user_meta_data) values (gen_random_uuid(),'inv1@x.com','{}');
select qb.eq('B: invited signup when full → no institution, teacher', $$select coalesce(institution_id::text,'none')||':'||role from public.profiles where email='inv1@x.com'$$, 'none:teacher');
select qb.eq('B: ...and the invitation stays pending', $$select count(*) from public.invitations where email='inv1@x.com' and accepted_at is null$$, '1');
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: superadmin raises seats to 6', $$select public.set_institution_plan(qb.inst('bill-a'),6,1000)->>'seats'$$, '6');
reset role;
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.eq('B: with free seats the existing account is added', $$select public.invite_member(qb.inst('bill-a'),'inv1@x.com','teacher')$$, 'added');
select qb.eq('B: seats used 5/6', $$select (public.get_seat_status(null)->>'used')||'/'||(public.get_seat_status(null)->>'seats')$$, '5/6');
reset role;
insert into auth.users(id,email,raw_user_meta_data) values (gen_random_uuid(),'late2@x.com','{"org_slug":"bill-a-s1"}');
select qb.eq('B: slug signup with a free seat joins (counts the whole account)', $$select (select slug from public.institutions i where i.id=institution_id) from public.profiles where email='late2@x.com'$$, 'bill-a-s1');
select qb.eq('B: now full again', $$select seats_full::text from public.get_org_branding('bill-a')$$, 'true');

-- ===== defaults for new institutions follow the settings =====
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('B: default seats 3 / 500k tokens', $$select public.update_platform_settings(5000,9.5,'EUR',100000,3,500000)->>'default_seats'$$, '3');
select qb.eq('B: new madre C created', $$select (public.create_institution('Bill C','bill-c','') is not null)::text$$, 'true');
reset role;
select qb.eq('B: madre C got the new defaults', $$select seats||'/'||monthly_tokens from public.billing_accounts where root_id=qb.inst('bill-c')$$, '3/500000');
select qb.eq('B: settings record who changed them', $$select (updated_by = '00000000-0000-0000-0000-000000000001')::text from public.platform_settings$$, 'true');
set role authenticated; select qb.as_user(current_setting('qb.adma'));
select qb.fails('B: org admin cannot update platform_settings directly', $$update public.platform_settings set pack_price = 0$$, 'permission denied');
reset role;
update public.platform_settings set pack_tokens=2000000, pack_price=11.99, currency='USD', personal_monthly_tokens=200000, default_seats=10, default_monthly_tokens=2000000;

\echo '================ BILLING RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qb.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qb.results;
