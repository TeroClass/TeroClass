-- Plans, free trial, sales leads and model comparison (2026-10-21) — security + flow tests.
-- Run after stub + 001_base.sql (with or without the data of the other suites).
--   · get_plans is public (anon too), launch offers only when enabled; update_plans only the super admin, validated
--   · trial: counted in consume_ai_quota with the user's own token (no service key): 5 completed main generations, the 6th
--     → 'trial_limit'; in-flight ones count; failed ones don't (but only the server can mark one as failed: finish_key);
--     follow-ups (continue / verify / student) only right after a counted class; active-plan institutions, individual
--     Docente plans and the super admin are never limited; students never see a trial
--   · model override only for the super admin; the per-kind default model setting is returned
--   · sales_leads / model_comparisons: no direct access; submit via RPC (validated, rate limited), read only the super admin
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qp cascade;
create schema qp;
grant usage on schema qp to anon, authenticated, service_role;
create table qp.results(n serial, label text, ok boolean, detail text);
grant all on qp.results to anon, authenticated, service_role; grant all on sequence qp.results_n_seq to anon, authenticated, service_role;
create function qp.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create function qp.fails(label text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into qp.results(label,ok,detail) values (label,false,'expected error, got success');
  exception when others then insert into qp.results(label,ok,detail) values (label, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
create function qp.eq(label text, q text, expected text) returns void language plpgsql as $$
declare v text;
begin
  begin execute q into v;
    insert into qp.results(label,ok,detail) values (label, v is not distinct from expected, 'got='||coalesce(v,'NULL'));
  exception when others then insert into qp.results(label,ok,detail) values (label,false,'error: '||sqlerrm); end;
end $$;
grant execute on all functions in schema qp to anon, authenticated, service_role;
create function qp.inst(s text) returns uuid language sql security definer as $$ select id from public.institutions where slug = s $$;
create function qp.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where email = e $$;
-- one full main generation as the server does it: consume (user token) → finish ok with the key
create function qp.gen(p_ok boolean default true) returns text language plpgsql as $$
declare j json;
begin
  j := public.consume_ai_quota('{"kind":"generate"}'::jsonb, null);
  if not (j->>'allowed')::boolean then return coalesce(j->>'reason', 'refused'); end if;
  perform public.finish_ai_event((j->>'event')::bigint, p_ok, j->>'finish_key');
  return 'ok';
end $$;
create function qp.req(p_kind text) returns text language plpgsql as $$
declare j json;
begin
  j := public.consume_ai_quota(jsonb_build_object('kind', p_kind), null);
  if not (j->>'allowed')::boolean then return coalesce(j->>'reason', 'refused'); end if;
  perform public.finish_ai_event((j->>'event')::bigint, true, j->>'finish_key');
  return 'ok';
end $$;
grant execute on all functions in schema qp to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';
-- known starting plans (the suite may run on a DB where they were changed): the seed again
update public.platform_settings set ai_model_default = '{"main":"default","student":"default","summary":"default","verify":"default"}';

-- ===== get_plans: public =====
set role anon; select qp.as_user(null);
select qp.eq('P: anon reads the plans (Docente USD 12 / 99, EUR 11.99)', $$select string_agg((x->'prices'->'usd'->>'monthly')||'/'||(x->'prices'->'usd'->>'annual')||'/'||(x->'prices'->'eur'->>'monthly'), ',') from json_array_elements(public.get_plans()->'plans') x where x->>'id'='docente'$$, '12/99/11.99');
select qp.eq('P: Institución tiers 14 / 12 / 10 per seat (annual)', $$select string_agg(t->'usd'->>'annual_per_month', '/') from json_array_elements(public.get_plans()->'plans') x, json_array_elements(x->'tiers') t where x->>'id'='institucion'$$, '14/12/10');
select qp.eq('P: trial = 5 classes, pop-up at 2, reminder at 4', $$select (j->'trial'->>'generations_lifetime')||'/'||(j->'trial'->>'paywall_at')||'/'||(j->'trial'->>'reminder_at') from (select public.get_plans() j) x$$, '5/2/4');
select qp.eq('P: class packs 50 (USD 25) and 200 (USD 85)', $$select string_agg((x->>'credits')||':'||(x->>'usd'), ',' order by (x->>'credits')::int) from json_array_elements(public.get_plans()->'addons') x where x->>'kind'='classes'$$, '50:25,200:85');
select qp.eq('P: launch offers hidden while disabled', $$select json_array_length(public.get_plans()->'launch_offers')$$, '0');
select qp.fails('P: anon cannot read platform_settings', $$select plans from public.platform_settings$$, 'permission denied');
select qp.fails('P: anon cannot update plans', $$select public.update_plans('{"docente":{"usd_monthly":1}}')$$, 'permission denied');
select qp.fails('P: anon cannot read my_trial_status', $$select public.my_trial_status()$$, 'permission denied');
reset role;

-- ===== people =====
set role authenticated; select qp.as_user(:'OWNER');
select qp.eq('P: superadmin creates two main institutions', $$select (public.create_institution('Plan Paga','plan-paga','pp-adm@x.com') is not null and public.create_institution('Plan Libre','plan-libre','pl-adm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('plan-paga','plan-libre') and not open_registration;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'pp-adm@x.com','{"name":"Paga Admin"}',now()), (gen_random_uuid(),'pl-adm@x.com','{"name":"Libre Admin"}',now()),
  (gen_random_uuid(),'pp-t@x.com','{"org_slug":"plan-paga","name":"Paga Teacher"}',now()),
  (gen_random_uuid(),'pl-t@x.com','{"org_slug":"plan-libre","name":"Libre Teacher"}',now()),
  (gen_random_uuid(),'solo-trial@x.com','{"name":"Solo"}',now()),
  (gen_random_uuid(),'solo-doc@x.com','{"name":"Docente Plan"}',now()),
  (gen_random_uuid(),'student-p@x.com','{"name":"Student"}',now());
update public.profiles set created_at = now() - interval '10 days' where email in ('solo-trial@x.com','solo-doc@x.com');  -- past the new-account daily caps
update public.profiles set role = 'student', institution_id = null where email = 'student-p@x.com';
select set_config('qp.ppt', qp.uid('pp-t@x.com')::text, false);
select set_config('qp.plt', qp.uid('pl-t@x.com')::text, false);
select set_config('qp.pla', qp.uid('pl-adm@x.com')::text, false);
select set_config('qp.solo', qp.uid('solo-trial@x.com')::text, false);
select set_config('qp.doc', qp.uid('solo-doc@x.com')::text, false);
select set_config('qp.stu', qp.uid('student-p@x.com')::text, false);
select qp.eq('P: new main institutions start without a plan (none)', $$select string_agg(plan_status, ',') from public.billing_accounts where root_id in (qp.inst('plan-paga'), qp.inst('plan-libre'))$$, 'none,none');

-- ===== plan status: only the super admin =====
set role authenticated; select qp.as_user(current_setting('qp.pla'));
select qp.fails('P: org admin cannot activate a plan', $$select public.set_institution_plan_status(qp.inst('plan-libre'),'active','institucion')$$, 'No autorizado');
select qp.fails('P: org admin cannot give themselves a Docente plan', $$select public.set_individual_plan('pl-adm@x.com','active')$$, 'No autorizado');
select qp.fails('P: org admin cannot edit plans', $$select public.update_plans('{"docente":{"usd_monthly":1}}')$$, 'No autorizado');
select qp.fails('P: org admin cannot read billing_accounts.plan_status', $$select plan_status from public.billing_accounts$$, 'permission denied');
select qp.fails('P: org admin cannot write trial_state', $$insert into public.trial_state(user_id, paywall_shown_at) values (auth.uid(), now())$$, 'permission denied');
select qp.fails('P: org admin cannot write individual_plans', $$insert into public.individual_plans(user_id) values (auth.uid())$$, 'permission denied');
reset role;
set role authenticated; select qp.as_user(:'OWNER');
select qp.fails('P: invalid status refused', $$select public.set_institution_plan_status(qp.inst('plan-paga'),'gratis',null)$$, 'inválido');
select qp.eq('P: superadmin activates Plan Paga (institucion) and applies the plan limits (seats × 30 × 25k)',
  $$select (j->>'plan_status')||'/'||(j->>'plan_id')||'/'||(j->>'monthly_tokens')||'/'||((j->>'plan_activated_at') is not null)::text from (select public.set_institution_plan_status(qp.inst('plan-paga'),'active','institucion',true) j) x$$,
  'active/institucion/7500000/true');
select qp.eq('P: overview shows the plan status', $$select string_agg(x->>'plan_status', ',' order by x->>'slug') from json_array_elements(public.platform_billing_overview()->'accounts') x where x->>'slug' in ('plan-paga','plan-libre')$$, 'none,active');
select qp.eq('P: Docente plan for an account without institution', $$select public.set_individual_plan('solo-doc@x.com','active','paid by transfer')->>'plan_status'$$, 'active');
select qp.fails('P: Docente plan: unknown email', $$select public.set_individual_plan('nobody@x.com','active')$$, 'No hay ninguna cuenta');
select qp.fails('P: Docente plan: never a student', $$select public.set_individual_plan('student-p@x.com','active')$$, 'no se puede modificar');
select qp.eq('P: list of individual plans', $$select string_agg(x->>'email', ',') from json_array_elements(public.list_individual_plans()) x$$, 'solo-doc@x.com');
reset role;

-- ===== who is on trial =====
set role authenticated;
select qp.as_user(current_setting('qp.solo'));
select qp.eq('P: account without institution → trial 0/5', $$select (j->>'trial')||'/'||(j->>'used')||'/'||(j->>'limit')||'/'||(j->>'remaining')||'/'||(j->>'watermark') from (select public.my_trial_status() j) x$$, 'true/0/5/5/true');
select qp.as_user(current_setting('qp.plt'));
select qp.eq('P: teacher of an institution without plan → trial (in_institution)', $$select (j->>'trial')||'/'||(j->>'in_institution')||'/'||(j->>'plan_status') from (select public.my_trial_status() j) x$$, 'true/true/none');
select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: teacher of an active-plan institution → no trial', $$select public.my_trial_status()::text$$, '{"trial" : false}');
select qp.as_user(current_setting('qp.doc'));
select qp.eq('P: Docente plan → no trial', $$select public.my_trial_status()->>'trial'$$, 'false');
select qp.as_user(:'OWNER');
select qp.eq('P: super admin → never a trial', $$select public.my_trial_status()->>'trial'$$, 'false');
select qp.as_user(current_setting('qp.stu'));
select qp.eq('P: student → never a trial', $$select public.my_trial_status()->>'trial'$$, 'false');
select qp.eq('P: student → trial_mark does nothing', $$select public.trial_mark('paywall')->>'trial'$$, 'false');
reset role;
select qp.eq('P: …and no trial row was written for the student', $$select count(*) from public.trial_state where user_id = current_setting('qp.stu')::uuid$$, '0');

-- ===== the trial limit, enforced with the user's own token =====
set role authenticated; select qp.as_user(current_setting('qp.solo'));
select qp.eq('P: classes 1-2 allowed', $$select qp.gen()||qp.gen()$$, 'okok');
select qp.eq('P: after the 2nd: used 2, remaining 3', $$select (j->>'used')||'/'||(j->>'remaining') from (select public.my_trial_status() j) x$$, '2/3');
select qp.eq('P: trial_mark paywall → stored once', $$select (public.trial_mark('paywall')->>'paywall_shown_at') is not null$$, 'true');
select qp.eq('P: a FAILED generation (server marks it with its key) does not count', $$select qp.gen(false)||'/'||(public.my_trial_status()->>'used')$$, 'ok/2');
select qp.eq('P: follow-ups right after a class are allowed (continue, verify, student)', $$select qp.req('continue')||qp.req('verify')||qp.req('student')$$, 'okokok');
select qp.eq('P: classes 3-4 allowed', $$select qp.gen()||qp.gen()$$, 'okok');
-- the user tries to "give back" a class: marking their own in-flight request as failed without the server's key is refused
select set_config('qp.ev', (public.consume_ai_quota('{"kind":"generate"}'::jsonb, null)->>'event'), false);
select qp.eq('P: finish as FAILED without the key → refused (stays in flight, still counts)', $$select public.finish_ai_event(current_setting('qp.ev')::bigint, false)::text$$, 'false');
select qp.eq('P: …with a wrong key → refused', $$select public.finish_ai_event(current_setting('qp.ev')::bigint, false, 'nope')::text$$, 'false');
select qp.eq('P: in-flight 5th counts: a 6th is refused even before the 5th finishes', $$select qp.gen()$$, 'trial_limit');
select qp.eq('P: finish OK without the key is allowed (can only add)', $$select public.finish_ai_event(current_setting('qp.ev')::bigint, true)::text$$, 'true');
select qp.eq('P: 5 used, 0 remaining', $$select (j->>'used')||'/'||(j->>'remaining') from (select public.my_trial_status() j) x$$, '5/0');
select qp.eq('P: the 6th class → trial_limit (with trial_used / trial_limit)', $$select (j->>'allowed')||'/'||(j->>'reason')||'/'||(j->>'trial_used')||'/'||(j->>'trial_limit') from (select public.consume_ai_quota('{"kind":"generate"}'::jsonb, 1000) j) x$$, 'false/trial_limit/5/5');
select qp.eq('P: …and without meta (direct call) too', $$select public.consume_ai_quota()->>'reason'$$, 'trial_limit');
select qp.eq('P: …a refused class takes no daily request', $$select public.get_ai_quota()->>'used'$$, '9');
select qp.eq('P: the handout of the last class is still allowed (follow-up)', $$select qp.req('student')$$, 'ok');
select qp.eq('P: at most 6 follow-ups per class', $$select qp.req('continue')||qp.req('verify')||qp.req('student')||qp.req('student')||qp.req('student')||'/'||qp.req('student')$$, 'okokokokok/trial_limit');
reset role; update public.ai_events set created_at = created_at - interval '3 hours' where user_id = current_setting('qp.solo')::uuid;
delete from public.ai_usage where user_id = current_setting('qp.solo')::uuid; -- a new day for the daily request cap (15 without institution)
set role authenticated; select qp.as_user(current_setting('qp.solo'));
select qp.eq('P: follow-ups hours later (no recent class) → trial_limit', $$select qp.req('continue')$$, 'trial_limit');
select qp.eq('P: a playbook summary is not a class (not limited by the trial)', $$select qp.req('playbook')$$, 'ok');
select qp.eq('P: trial_mark limit + dismiss', $$select ((j->>'limit_shown_at') is not null)::text||'/'||((j->>'dismissed_at') is not null)::text from (select public.trial_mark('limit') x1, public.trial_mark('dismiss') j) x$$, 'true/true');
select qp.fails('P: trial_mark validates', $$select public.trial_mark('bogus')$$, 'inválido');
reset role;

-- a trial user that never generated can't use "continue" to get classes without counting them
set role authenticated; select qp.as_user(current_setting('qp.pla'));
select qp.eq('P: trial admin: "continue" with no counted class → trial_limit', $$select qp.req('continue')$$, 'trial_limit');
reset role;

-- active-plan members, Docente plans and the super admin are never limited
set role authenticated; select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: active-plan teacher: 7 classes in a row', $$select qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()$$, 'okokokokokokok');
select qp.as_user(current_setting('qp.doc'));
select qp.eq('P: Docente plan: 6 classes', $$select qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()$$, 'okokokokokok');
select qp.as_user(:'OWNER');
select qp.eq('P: super admin: 6 classes', $$select qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()||qp.gen()$$, 'okokokokokok');
reset role;
-- an institution moved back to "no plan": its teacher is on trial again (lifetime count: already over)
set role authenticated; select qp.as_user(:'OWNER');
select qp.eq('P: plan cancelled', $$select public.set_institution_plan_status(qp.inst('plan-paga'),'cancelled')->>'plan_status'$$, 'cancelled');
select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: …its teacher is blocked at the next class', $$select qp.gen()$$, 'trial_limit');
select qp.as_user(:'OWNER');
select qp.eq('P: plan back to active', $$select public.set_institution_plan_status(qp.inst('plan-paga'),'pilot')->>'plan_status'$$, 'pilot');
select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: …pilot is an active plan: generating again', $$select qp.gen()$$, 'ok');
reset role;
select qp.eq('P: the Docente plan has the plan''s monthly classes (25 × 25k)', $$select public.ai_budget_check(qp.uid('solo-doc@x.com'))->>'allowance'$$, '625000');
select qp.eq('P: a trial account keeps the free allowance', $$select public.ai_budget_check(qp.uid('solo-trial@x.com'))->>'allowance'$$, (select personal_monthly_tokens::text from public.platform_settings));

-- ===== model override: super admin only; per-kind default =====
set role authenticated; select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: teacher asking for a model → refused (reason model), nothing counted', $$select (j->>'allowed')||'/'||(j->>'reason')||'/'||(public.get_ai_quota()->>'used') from (select public.consume_ai_quota('{"kind":"generate"}'::jsonb, null, 'mini') j) x$$, 'false/model/8');
select qp.eq('P: teacher: default model', $$select public.consume_ai_quota('{"kind":"generate"}'::jsonb)->>'model'$$, 'default');
select qp.fails('P: teacher cannot change the default model', $$select public.update_ai_model_default('{"main":"mini"}')$$, 'No autorizado');
select qp.as_user(:'OWNER');
select qp.eq('P: super admin can ask for mini', $$select public.consume_ai_quota('{"kind":"generate"}'::jsonb, null, 'mini')->>'model'$$, 'mini');
select qp.eq('P: super admin: an unknown model is refused', $$select public.consume_ai_quota('{"kind":"generate"}'::jsonb, null, 'gpt-5')->>'reason'$$, 'model');
select qp.fails('P: model setting validated', $$select public.update_ai_model_default('{"main":"gpt-5"}')$$, 'inválido');
select qp.eq('P: super admin switches student handouts to mini', $$select public.update_ai_model_default('{"student":"mini"}')::text$$, '{"main": "default", "verify": "default", "student": "mini", "summary": "default"}');
select qp.as_user(current_setting('qp.ppt'));
select qp.eq('P: the setting is respected per kind (student → mini, main → default)', $$select (public.consume_ai_quota('{"kind":"student"}'::jsonb)->>'model')||'/'||(public.consume_ai_quota('{"kind":"generate"}'::jsonb)->>'model')$$, 'mini/default');
reset role;
update public.platform_settings set ai_model_default = '{"main":"default","student":"default","summary":"default","verify":"default"}';

-- ===== update_plans (super admin) =====
set role authenticated; select qp.as_user(:'OWNER');
select qp.fails('P: plans: negative price refused', $$select public.update_plans('{"docente":{"usd_monthly":-1}}')$$, 'inválido');
select qp.fails('P: plans: text price refused', $$select public.update_plans('{"docente":{"usd_monthly":"12"}}')$$, 'inválido');
select qp.fails('P: plans: reminder after the limit refused', $$select public.update_plans('{"trial":{"reminder_at":9}}')$$, 'recordatorio');
select qp.fails('P: plans: tiers must keep their number', $$select public.update_plans('{"institucion":{"tiers":[{"usd_monthly":1}]}}')$$, 'tiers');
select qp.eq('P: plans: Docente 13 / 109 and the 200 pack USD 80', $$select (j->'plans'->1->'prices'->'usd'->>'monthly')||'/'||(j->'plans'->1->'prices'->'usd'->>'annual')||'/'||(j->'addons'->1->>'usd') from (select public.update_plans('{"docente":{"usd_monthly":13,"usd_annual":109},"addons":{"pack_clases_200":{"usd":80}}}') j) x$$, '13/109/80');
select qp.eq('P: plans: middle tier 11.5 / 13.75', $$select (j->'plans'->2->'tiers'->1->'usd'->>'annual_per_month')||'/'||(j->'plans'->2->'tiers'->1->'usd'->>'monthly') from (select public.update_plans('{"institucion":{"tiers":[{},{"usd_annual_per_month":11.5,"usd_monthly":13.75},{}]}}') j) x$$, '11.5/13.75');
select qp.eq('P: plans: the trial limit can change (6) and applies at once', $$select public.update_plans('{"trial":{"generations_lifetime":6}}')->'trial'->>'generations_lifetime'$$, '6');
select qp.as_user(current_setting('qp.solo'));
select qp.eq('P: …the solo trial user now has 1 more', $$select (j->>'remaining')||'/'||qp.gen() from (select public.my_trial_status() j) x$$, '1/ok');
select qp.as_user(:'OWNER');
select qp.eq('P: plans: back to 5', $$select public.update_plans('{"trial":{"generations_lifetime":5}}')->'trial'->>'generations_lifetime'$$, '5');
select qp.eq('P: launch offer founder ON', $$select (select o->>'enabled' from json_array_elements(public.update_plans('{"launch_offers":{"founder":true}}')->'launch_offers') o where o->>'id'='founder')$$, 'true');
select qp.fails('P: launch offers take booleans', $$select public.update_plans('{"launch_offers":{"founder":"yes"}}')$$, 'inválido');
reset role;
set role anon; select qp.as_user(null);
select qp.eq('P: get_plans shows only the enabled offer + founder_taken', $$select (select string_agg(o->>'id', ',') from json_array_elements(j->'launch_offers') o)||'/'||(j->>'founder_taken') from (select public.get_plans() j) x$$, 'founder/0');
reset role;
set role authenticated; select qp.as_user(:'OWNER');
select qp.eq('P: plans restored', $$select (j->'plans'->1->'prices'->'usd'->>'monthly')||'/'||(j->'addons'->1->>'usd') from (select public.update_plans('{"docente":{"usd_monthly":12,"usd_annual":99},"addons":{"pack_clases_200":{"usd":85}},"institucion":{"tiers":[{},{"usd_annual_per_month":12,"usd_monthly":14.5},{}]},"launch_offers":{"founder":false}}') j) x$$, '12/85');
reset role;

-- ===== sales leads =====
\set LEAD '{"name":"Ana <b>Pérez</b>","institution":"Colegio Sur","role":"direccion","country":"uy","teachers_count":"10-29","contact_channel":"whatsapp","whatsapp":"+598 99 123 456","email":"Ana@Colegio.edu.uy","preferred_plan":"institucion","message":"Hola\\r\\nQueremos una demo <script>","consent":true,"lang":"es"}'
select set_config('qp.lead', :'LEAD', false);
create function qp.last_anon_lead() returns uuid language sql security definer as $$ select id from public.sales_leads where anonymous order by created_at desc limit 1 $$;
grant execute on function qp.last_anon_lead() to service_role;
set role anon; select qp.as_user(null);
select qp.fails('P: anon cannot submit through the RPC', $$select public.submit_sales_lead('{}'::jsonb)$$, 'permission denied');
select qp.fails('P: anon cannot read sales_leads', $$select count(*) from public.sales_leads$$, 'permission denied');
select qp.fails('P: anon cannot call the service RPC', $$select public.submit_sales_lead_service('{}'::jsonb,'plans_page','x')$$, 'permission denied');
reset role;
set role authenticated; select qp.as_user(current_setting('qp.solo'));
select qp.fails('P: lead: consent is required', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{consent}', 'false'))$$, 'consentimiento');
select qp.fails('P: lead: bad email', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{email}', '"nope"'))$$, 'email');
select qp.fails('P: lead: WhatsApp required when chosen', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{whatsapp}', '""'))$$, 'whatsapp');
select qp.fails('P: lead: unknown role', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{role}', '"ceo"'))$$, 'role');
select qp.fails('P: lead: message max 1000', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{message}', to_jsonb(repeat('x', 1001))))$$, 'message');
select qp.eq('P: lead stored, cleaned (no < >, email lower-case, country upper-case, phone compact)',
  $$select (j->>'name')||'|'||(j->>'email')||'|'||(j->>'country')||'|'||(j->>'whatsapp')||'|'||(j->>'source')||'|'||replace(j->>'message', E'\n', '\n') from (select public.submit_sales_lead(current_setting('qp.lead')::jsonb, 'popup_gen2') j) x$$,
  'Ana b Pérez /b|ana@colegio.edu.uy|UY|+59899123456|popup_gen2|Hola\nQueremos una demo  script');
select qp.eq('P: …my_trial_status knows a lead was sent', $$select public.my_trial_status()->>'lead_sent'$$, 'true');
select qp.fails('P: the submitter cannot read leads (not even their own)', $$select count(*) from public.sales_leads$$, 'permission denied');
select qp.fails('P: the submitter cannot list leads', $$select public.list_sales_leads()$$, 'No autorizado');
select qp.fails('P: the submitter cannot change a lead', $$select public.update_sales_lead((select null::uuid), 'ganado')$$, 'No autorizado');
select qp.fails('P: cannot insert directly', $$insert into public.sales_leads(name,institution,role,country,teachers_count,contact_channel,email,consent) values ('x','y','otro','UY','1-2','email','a@b.co',true)$$, 'permission denied');
select qp.eq('P: unknown source → other', $$select public.submit_sales_lead(jsonb_set(current_setting('qp.lead')::jsonb, '{contact_channel}', '"email"'), 'hack')->>'source'$$, 'other');
select qp.eq('P: 3rd lead in the hour ok', $$select public.submit_sales_lead(current_setting('qp.lead')::jsonb, 'plans_page')->>'source'$$, 'plans_page');
select qp.fails('P: 4th lead in the hour → rate limited', $$select public.submit_sales_lead(current_setting('qp.lead')::jsonb, 'plans_page')$$, 'Demasiados pedidos');
select qp.eq('P: the submitter can mark their fresh lead as notified (server, after the email)', $$select public.sales_lead_notified((select null::uuid))::text$$, 'false');
select qp.fails('P: the service-only notified mark is not for users', $$select public.sales_lead_notified_service(null)$$, 'permission denied');
select qp.as_user(current_setting('qp.stu'));
select qp.fails('P: a student cannot send a lead', $$select public.submit_sales_lead(current_setting('qp.lead')::jsonb)$$, 'No autorizado');
reset role;
set role service_role; select qp.as_user(null);
select qp.eq('P: service (API + Turnstile) stores an anonymous lead', $$select (j->>'anonymous')||'/'||(j->>'source') from (select public.submit_sales_lead_service(current_setting('qp.lead')::jsonb, 'plans_page', 'ipkey-abcdef123') j) x$$, 'true/plans_page');
select qp.eq('P: service marks it notified', $$select public.sales_lead_notified_service(qp.last_anon_lead())::text$$, 'true');
select qp.eq('P: anon leads limited per IP (2 more, then refused)', $$select (public.submit_sales_lead_service(current_setting('qp.lead')::jsonb, 'plans_page', 'ipkey-abcdef123')->>'anonymous')||(public.submit_sales_lead_service(current_setting('qp.lead')::jsonb, 'plans_page', 'ipkey-abcdef123')->>'anonymous')$$, 'truetrue');
select qp.fails('P: …4th from the same IP', $$select public.submit_sales_lead_service(current_setting('qp.lead')::jsonb, 'plans_page', 'ipkey-abcdef123')$$, 'Demasiados pedidos');
reset role;
set role authenticated; select qp.as_user(:'OWNER');
select qp.eq('P: super admin lists all leads, newest first, with the account', $$select json_array_length(public.list_sales_leads())||'/'||(select count(*) from json_array_elements(public.list_sales_leads()) x where x->>'account_email' = 'solo-trial@x.com')$$, '6/3');
select qp.eq('P: …with the trial usage of the account', $$select (select max((x->>'classes_generated')::int) from json_array_elements(public.list_sales_leads()) x where x->>'account_email' = 'solo-trial@x.com')::text$$, '6');
select qp.eq('P: new leads badge', $$select public.sales_leads_new_count()::text$$, '6');
select qp.eq('P: update status + notes', $$select (j->>'status')||'/'||(j->>'notes') from (select public.update_sales_lead((select (x->>'id')::uuid from json_array_elements(public.list_sales_leads()) x limit 1), 'contactado', 'Llamar el martes') j) x$$, 'contactado/Llamar el martes');
select qp.fails('P: invalid status refused', $$select public.update_sales_lead((select (x->>'id')::uuid from json_array_elements(public.list_sales_leads()) x limit 1), 'vendido')$$, 'inválido');
select qp.eq('P: filter by status', $$select json_array_length(public.list_sales_leads('contactado'))||'/'||public.sales_leads_new_count()$$, '1/5');
reset role;
set role authenticated; select qp.as_user(current_setting('qp.pla'));
select qp.fails('P: an institution admin cannot list leads', $$select public.list_sales_leads()$$, 'No autorizado');
select qp.fails('P: …nor the badge', $$select public.sales_leads_new_count()$$, 'No autorizado');
reset role;
set role authenticated; select qp.as_user(current_setting('qp.solo'));
select qp.eq('P: data export: own sales requests (3)', $$select json_array_length(public.my_data_export()->'sales_requests')$$, '3');
reset role;

-- ===== model comparisons =====
\set CMP '{"title":"Fotosíntesis","params":{"prompt":"Fotosíntesis","language":"Spanish"},"left_model":"mini","winner":"a","note":"más clara","results":{"default":{"ms":30000,"prompt_tokens":15000,"completion_tokens":8000,"deployment":"gpt-4o"},"mini":{"ms":20000,"prompt_tokens":15000,"completion_tokens":8000,"deployment":"gpt-4.1-mini"}},"texts":{"default":{"guide":"G1","handout":"H1"},"mini":{"guide":"G2","handout":"H2"}}}'
select set_config('qp.cmp', :'CMP', false);
set role authenticated; select qp.as_user(current_setting('qp.ppt'));
select qp.fails('P: teacher cannot save a comparison', $$select public.save_model_comparison(current_setting('qp.cmp')::jsonb)$$, 'No autorizado');
select qp.fails('P: teacher cannot read comparisons', $$select count(*) from public.model_comparisons$$, 'permission denied');
select qp.fails('P: teacher cannot read the summary', $$select public.model_comparison_summary()$$, 'No autorizado');
select qp.as_user(:'OWNER');
select qp.fails('P: a rating is required', $$select public.save_model_comparison(jsonb_set(current_setting('qp.cmp')::jsonb, '{winner}', '"maybe"'))$$, 'Elegí');
select qp.eq('P: "A better" with mini on the left → mini wins; cost from the settings (default 0.1175, mini 0.0188)',
  $$select (j->>'winner')||'/'||(j->'results'->'default'->>'usd')||'/'||(j->'results'->'mini'->>'usd') from (select public.save_model_comparison(current_setting('qp.cmp')::jsonb) j) x$$, 'mini/0.11750/0.01880');
select qp.eq('P: "B better" with mini on the left → default wins', $$select public.save_model_comparison(jsonb_set(current_setting('qp.cmp')::jsonb, '{winner}', '"b"'))->>'winner'$$, 'default');
select qp.eq('P: "tie"', $$select public.save_model_comparison(jsonb_set(current_setting('qp.cmp')::jsonb, '{winner}', '"tie"'))->>'winner'$$, 'tie');
select qp.eq('P: summary: 3 pairs, win rates, avg cost', $$select (j->>'total')||'/'||(j->'win_rate'->>'mini')||'/'||(j->'win_rate'->>'default')||'/'||(j->'avg_usd'->>'mini')||'/'||json_array_length(j->'recent') from (select public.model_comparison_summary() j) x$$, '3/33.3/33.3/0.01880/3');
select qp.eq('P: one comparison with its texts', $$select (j->>'mini_guide')||(j->>'default_handout') from (select public.get_model_comparison((select (x->>'id')::uuid from json_array_elements(public.model_comparison_summary()->'recent') x limit 1)) j) x$$, 'G2H1');
select qp.eq('P: mini prices editable', $$select public.update_ai_prices_mini(0.5, 2)->>'ai_price_input_mini'$$, '0.5000');
select qp.eq('P: mini prices restored', $$select public.update_ai_prices_mini(0.4, 1.6)->>'ai_price_output_mini'$$, '1.6000');
reset role;

-- ===== funnel (Métricas) =====
set role authenticated; select qp.as_user(current_setting('qp.ppt'));
select qp.fails('P: teacher cannot read the funnel', $$select public.platform_funnel(30)$$, 'No autorizado');
select qp.as_user(:'OWNER');
-- (other suites may have added accounts to the same database: their people count too, so the cohort numbers are lower bounds)
select qp.eq('P: funnel: signups ≥6, trial ≥3, 2nd class ≥3, saw paywall ≥1, hit limit ≥3 / leads 6 / converted 1 + 1',
  $$select ((j->>'signups')::int >= 6 and (j->>'trial')::int >= 3 and (j->>'reached_2nd')::int >= 3 and (j->>'saw_paywall')::int >= 1 and (j->>'hit_limit')::int >= 3
            and (j->>'trial_now')::int >= (j->>'trial')::int)::text||'/'||(j->>'leads')||'/'||(j->>'converted_institutions')||'/'||(j->>'converted_individuals')||'/'||(j->'leads_by_source'->>'popup_gen2')
     from (select public.platform_funnel(30) j) x$$,
  'true/6/1/1/1');
reset role;

\echo '================ PLANS RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qp.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qp.results;
