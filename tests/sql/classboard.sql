-- Class whiteboard ("Pizarra": one per calendar class): access matrix (teacher, substitute, enrolled / invited student,
-- other student, own admin read-only, parent admin, sibling / other-institution admin, superadmin, anon), element validation
-- (types, images refused, ids, versions, links, customData), last-writer-wins per element (version / versionNonce), deltas by
-- rev, lock, 2 MB size cap, versions / restore permissions, presence names from the database, Realtime policies (listen / send,
-- lock), group card + student dashboard lists. Run after stub + 001_base.sql (alone or after the other suites: own "cb-" units).
\set ON_ERROR_STOP 1
\pset footer off
drop schema if exists qb cascade;
create schema qb;
grant usage on schema qb to anon, authenticated, service_role;
create table qb.results(n serial, label text, ok boolean, detail text);
grant all on qb.results to anon, authenticated, service_role; grant all on sequence qb.results_n_seq to anon, authenticated, service_role;
create function qb.as_user(u text) returns void language plpgsql as
$$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); perform set_config('request.jwt.claims', '', false); end $$;
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
create function qb.uid(e text) returns uuid language sql security definer as $$ select id from auth.users where lower(email) = lower(e) $$;
create function qb.grp(n text) returns uuid language sql security definer as $$ select id from public.class_groups where name = n $$;
create function qb.sess(t text) returns uuid language sql security definer as $$ select id from public.class_sessions where title = t order by created_at limit 1 $$;
-- an Excalidraw element (only the fields the database looks at, plus a few visible ones)
create function qb.el(id text, ver int, nonce bigint, typ text default 'rectangle', del boolean default false, extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object('id', id, 'type', typ, 'version', ver, 'versionNonce', nonce, 'isDeleted', del,
  'x', 10, 'y', 20, 'width', 100, 'height', 50, 'strokeColor', '#1e1e1e', 'index', 'a0') || extra $$;
create function qb.els(variadic e jsonb[]) returns jsonb language sql immutable as $$ select jsonb_agg(x) from unnest(e) x $$;
create function qb.row(t text, id text) returns text language sql security definer as
$$ select version||'/'||nonce||'/'||deleted from public.class_board_elements where session_id = qb.sess(t) and element_id = id $$;
create function qb.nver(t text) returns bigint language sql security definer as $$ select count(*) from public.class_board_versions where session_id = qb.sess(t) $$;
create function qb.ver(t text, l text) returns uuid language sql security definer as $$ select id from public.class_board_versions where session_id = qb.sess(t) and label = l order by created_at desc limit 1 $$;
create function qb.gen(t text) returns integer language sql security definer as $$ select generation from public.class_boards where session_id = qb.sess(t) $$;
create function qb.rt(t text) returns void language plpgsql as $$ begin perform set_config('realtime.topic', t, false); end $$;
grant execute on function qb.inst(text), qb.uid(text), qb.grp(text), qb.sess(text), qb.el(text,int,bigint,text,boolean,jsonb), qb.els(jsonb[]),
  qb.row(text,text), qb.nver(text), qb.ver(text,text), qb.gen(text), qb.rt(text) to anon, authenticated, service_role;

\set OWNER '00000000-0000-0000-0000-000000000001'
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
  values (:'OWNER','owner@teroclass.test','{"name":"Owner"}',now()) on conflict do nothing;
update public.profiles set role='superadmin' where id=:'OWNER';

-- ===== tree: CB Madre › CB Sede 1 ; CB Madre › CB Sede 2 ; CB Otra =====
set role authenticated; select qb.as_user(:'OWNER');
select qb.eq('S: superadmin creates the tree', $$select (public.create_institution('CB Madre','cb-madre','cb-adm@x.com') is not null
  and public.create_institution('CB Sede 1','cb-s1','cb-s1adm@x.com',null,qb.inst('cb-madre')) is not null
  and public.create_institution('CB Sede 2','cb-s2','cb-s2adm@x.com',null,qb.inst('cb-madre')) is not null
  and public.create_institution('CB Otra','cb-otra','cb-oadm@x.com') is not null)::text$$, 'true');
reset role;
update public.institutions set open_registration = true where slug in ('cb-otra','cb-s1','cb-s2') and not open_registration;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
  (gen_random_uuid(),'cb-adm@x.com','{"name":"CB Admin"}',now()),
  (gen_random_uuid(),'cb-s1adm@x.com','{"name":"CB Admin S1"}',now()),
  (gen_random_uuid(),'cb-s2adm@x.com','{"name":"CB Admin S2"}',now()),
  (gen_random_uuid(),'cb-oadm@x.com','{"name":"CB Admin Otra"}',now()),
  (gen_random_uuid(),'cb-t1@x.com','{"org_slug":"cb-s1","name":"CB Teacher One"}',now()),
  (gen_random_uuid(),'cb-sub@x.com','{"org_slug":"cb-s1","name":"CB Sub"}',now()),
  (gen_random_uuid(),'cb-t2@x.com','{"org_slug":"cb-s2","name":"CB Teacher Two"}',now()),
  (gen_random_uuid(),'cb-st1@x.com','{"via":"student_link","name":"Ana"}',now()),
  (gen_random_uuid(),'cb-st4@x.com','{"via":"student_link","name":"Dani"}',now()),
  (gen_random_uuid(),'cb-guest@x.com','{"via":"student_link","name":"Guest"}',now());
set role authenticated; select qb.as_user(qb.uid('cb-adm@x.com')::text);
select public.create_group(qb.inst('cb-s1'), 'CB G1', qb.uid('cb-t1@x.com'), qb.uid('cb-sub@x.com'));
select public.create_group(qb.inst('cb-s2'), 'CB G2', qb.uid('cb-t2@x.com'));
select public.add_student(null, 'cb-st1@x.com', 'Ana Alonso', qb.grp('CB G1'));
select public.add_student(null, 'cb-st4@x.com', 'Dani Díaz', qb.grp('CB G2'));
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u
 where lower(u.email) = lower(e.email) and lower(e.email) in ('cb-st1@x.com','cb-st4@x.com');
insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone, status)
select g.institution_id, g.id, g.teacher_id, x.t, now() + x.d, now() + x.d + interval '45 minutes', 'America/Montevideo', 'scheduled'
  from (values ('CB G1', 'CB board', interval '-1 days'), ('CB G1', 'CB now', interval '-5 minutes'), ('CB G1', 'CB big', interval '-5 minutes'),
               ('CB G2', 'CB G2 past', interval '-1 days')) x(g, t, d)
  join public.class_groups g on g.name = x.g;
set role authenticated; select qb.as_user(qb.uid('cb-t1@x.com')::text);
select public.create_session(null, 'CB one-off', now() - interval '10 minutes', 60, 'America/Montevideo', array['cb-guest@x.com']);
reset role;
update public.student_enrollments e set user_id = u.id, claimed_at = now() from auth.users u where lower(u.email) = lower(e.email) and lower(e.email) = 'cb-guest@x.com';

-- ===== access matrix (open) =====
set role authenticated; select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.eq('B: teacher opens: role teacher, can draw + lock, empty board, private channel topic, name from the database', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->>'locked')||'/'||json_array_length(x->'elements')||'/'||(x->'channel'->>'topic' = 'classboard:'||qb.sess('CB board'))::text||'/'||(x->'me'->>'name')||'/'||(x->>'max_bytes')
  from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'teacher/true/true/false/0/true/CB Teacher One/2097152');
select qb.as_user(qb.uid('cb-sub@x.com')::text);
select qb.eq('B: substitute = teacher (draw + lock)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock') from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'teacher/true/true');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: enrolled student draws, cannot lock; name = the name the school loaded', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||(x->'me'->>'name') from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'student/true/false/Ana Alonso');
select qb.as_user(qb.uid('cb-guest@x.com')::text);
select qb.eq('B: invited student of a one-off class draws on its board', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.classboard_open(qb.sess('CB one-off')) x) y$$, 'student/true');
select qb.fails('B: invited student cannot open a board of a group they are not in', $$select public.classboard_open(qb.sess('CB board'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-st4@x.com')::text);
select qb.fails('B: other student (other group) cannot open', $$select public.classboard_open(qb.sess('CB board'))$$, 'No autorizado');
select qb.fails('B: other student cannot push', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('x1', 1, 5)), 'c9')$$, 'No autorizado');
select qb.fails('B: other student cannot pull', $$select public.classboard_pull(qb.sess('CB board'), 0, 1, 'c9', null)$$, 'No autorizado');
select qb.fails('B: other student cannot read versions', $$select public.classboard_versions(qb.sess('CB board'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-t2@x.com')::text);
select qb.fails('B: teacher of another group cannot open', $$select public.classboard_open(qb.sess('CB board'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.eq('B: own unit admin: read-only (role admin, cannot draw / lock, no presence identity)', $$select (x->>'role')||'/'||(x->>'can_edit')||'/'||(x->>'can_lock')||'/'||coalesce(x->>'me','null') from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'admin/false/false/null');
select qb.as_user(qb.uid('cb-adm@x.com')::text);
select qb.eq('B: parent unit admin reads too', $$select public.classboard_open(qb.sess('CB board'))->>'role'$$, 'admin');
select qb.as_user(qb.uid('cb-s2adm@x.com')::text);
select qb.fails('B: sibling unit admin cannot open', $$select public.classboard_open(qb.sess('CB board'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-oadm@x.com')::text);
select qb.fails('B: other-institution admin cannot open', $$select public.classboard_open(qb.sess('CB board'))$$, 'No autorizado');
select qb.fails('B: other-institution admin cannot pull', $$select public.classboard_pull(qb.sess('CB board'), 0, 1, 'cx', null)$$, 'No autorizado');
select qb.as_user(:'OWNER');
select qb.eq('B: superadmin: read-only', $$select (x->>'role')||'/'||(x->>'can_edit') from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'admin/false');
select qb.fails('B: superadmin cannot push (read-only)', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('x1', 1, 5)), 'c0')$$, 'Solo lectura');
select qb.fails('B: unknown class', $$select public.classboard_open(gen_random_uuid())$$, 'No autorizado');

-- ===== drawing: push / pull / last writer wins =====
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.eq('B: teacher pushes two shapes (rev 1)', $$select (x->>'rev')||'/'||(x->>'applied') from (select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('r1', 1, 100), qb.el('t1', 1, 100, 'text', false, '{"text":"Hola"}')), 'c1') x) y$$, '1/2');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: student draws a free-hand line (rev 2)', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('f1', 3, 7, 'freedraw', false, '{"points":[[0,0],[5,5],[9,2]]}')), 'c2')->>'rev'$$, '2');
select qb.eq('B: student pull from 0 gets the 3 elements; from rev 1 only the new one', $$select json_array_length(public.classboard_pull(qb.sess('CB board'), 0, 1, 'c2', '{"pointer":{"x":1,"y":2}}'::jsonb)->'elements')||'/'||(select string_agg(e->>'id', ',') from json_array_elements(public.classboard_pull(qb.sess('CB board'), 1, 1, 'c2', null)->'elements') e)$$, '3/f1');
select qb.eq('B: a newer version of the same element wins (version 2 > 1)', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('r1', 2, 999, 'rectangle', false, '{"x":300}')), 'c2')->>'applied'$$, '1');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.eq('B: an older version is ignored (applied 0, rev unchanged)', $$select (x->>'applied')||'/'||(x->>'rev') from (select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('r1', 1, 1, 'rectangle', false, '{"x":-5}')), 'c1') x) y$$, '0/3');
select qb.eq('B: same version: the lower versionNonce wins (as Excalidraw reconcileElements)', $$select (public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('r1', 2, 50, 'rectangle', false, '{"x":400}')), 'c1')->>'applied')
  ||'/'||(public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('r1', 2, 70, 'rectangle', false, '{"x":500}')), 'c1')->>'applied')$$, '1/0');
select qb.eq('B: stored = the winner (x 400)', $$select (e->>'x') from json_array_elements(public.classboard_open(qb.sess('CB board'))->'elements') e where e->>'id' = 'r1'$$, '400');
select qb.eq('B: teacher sees the student in presence (name from the school, own color, pointer), never an email', $$select (p->>'name')||'/'||(p->>'role')||'/'||(p->>'color' ~ '^#[0-9a-f]{6}$')::text||'/'||(p->'state'->'pointer'->>'x')||'/'||(position('@' in x::text) = 0)::text
  from (select public.classboard_pull(qb.sess('CB board'), 0, 1, 'c1', '{}'::jsonb) x) y, json_array_elements(x->'presence') p$$, 'Ana Alonso/student/true/1/true');
select qb.eq('B: deleting keeps a tombstone without the drawing (others delete it too)', $$select (public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('t1', 2, 1, 'text', true, '{"text":"Hola"}')), 'c1')->>'applied')
  ||'/'||(select (e::jsonb ? 'text')::text||'/'||(e->>'isDeleted') from json_array_elements(public.classboard_pull(qb.sess('CB board'), 0, 1, 'c1', null)->'elements') e where e->>'id' = 't1')$$, '1/false/true');

-- ===== validation (never trust the browser) =====
select qb.fails('B: images refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('i1', 1, 1, 'image', false, '{"fileId":"abc"}')), 'c1')$$, 'imágenes');
select qb.fails('B: embedded web pages refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('e1', 1, 1, 'embeddable', false, '{"link":"https://evil.example"}')), 'c1')$$, 'imágenes');
select qb.fails('B: unknown element type refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('u1', 1, 1, 'script')), 'c1')$$, 'no permitido');
select qb.fails('B: invalid id refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('<x>', 1, 1)), 'c1')$$, 'Cambio inválido');
select qb.fails('B: missing version refused', $$select public.classboard_push(qb.sess('CB board'), 1, jsonb_build_array(qb.el('v1', 1, 1) - 'version'), 'c1')$$, 'Cambio inválido');
select qb.fails('B: non-integer version refused', $$select public.classboard_push(qb.sess('CB board'), 1, jsonb_build_array(qb.el('v1', 1, 1) || '{"version":"7"}'), 'c1')$$, 'Cambio inválido');
select qb.fails('B: not an array refused', $$select public.classboard_push(qb.sess('CB board'), 1, '{"id":"x"}'::jsonb, 'c1')$$, 'Cambio inválido');
select qb.fails('B: empty array refused', $$select public.classboard_push(qb.sess('CB board'), 1, '[]'::jsonb, 'c1')$$, 'Cambio inválido');
select qb.fails('B: a whole push is all-or-nothing (one bad element → nothing stored)', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('ok9', 1, 1), qb.el('bad9', 1, 1, 'image')), 'c1')$$, 'imágenes');
select qb.eq('B: … and the good element of that push was not stored', $$select coalesce(qb.row('CB board', 'ok9'), 'none')$$, 'none');
select qb.eq('B: two shapes with links pushed', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('l1', 1, 1, 'rectangle', false, '{"link":"javascript:alert(1)","customData":{"a":1}}'), qb.el('l2', 1, 1, 'rectangle', false, '{"link":"https://teroclass.com/x"}')), 'c1')->>'applied'$$, '2');
select qb.eq('B: javascript: links and customData are removed; https links kept', $$select string_agg(coalesce(e->>'link', 'null')||':'||(e::jsonb ? 'customData')::text, ',' order by e->>'id') from json_array_elements(public.classboard_open(qb.sess('CB board'))->'elements') e where e->>'id' in ('l1','l2')$$, 'null:false,https://teroclass.com/x:false');
select qb.fails('B: a change from an old generation refused', $$select public.classboard_push(qb.sess('CB board'), 7, qb.els(qb.el('g1', 1, 1)), 'c1')$$, 'desactualizada');
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.fails('B: unit admin cannot push', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('a1', 1, 1)), 'ca')$$, 'Solo lectura');
select qb.eq('B: admin reads the elements (pull)', $$select (json_array_length(public.classboard_pull(qb.sess('CB board'), 0, 1, 'ca', '{}'::jsonb)->'elements') >= 4)::text$$, 'true');
reset role;
select qb.eq('B: an admin reading never appears in presence', $$select count(*)::text from public.class_board_presence where session_id = qb.sess('CB board') and user_id = qb.uid('cb-s1adm@x.com')$$, '0');
select qb.eq('B: the first change after the class ended stored the "class end" version first', $$select (qb.ver('CB board','class_end') is not null)::text$$, 'true');
select qb.eq('B: board bytes = sum of its elements', $$select (b.bytes = (select sum(bytes) from public.class_board_elements e where e.session_id = b.session_id))::text from public.class_boards b where b.session_id = qb.sess('CB board')$$, 'true');

-- ===== lock =====
set role authenticated; select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.fails('B: student cannot lock', $$select public.classboard_set_lock(qb.sess('CB board'), true)$$, 'No autorizado');
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.fails('B: admin cannot lock', $$select public.classboard_set_lock(qb.sess('CB board'), true)$$, 'No autorizado');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.eq('B: teacher locks', $$select public.classboard_set_lock(qb.sess('CB board'), true)->>'locked'$$, 'true');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: locked: student opens read-only', $$select (x->>'locked')||'/'||(x->>'can_edit') from (select public.classboard_open(qb.sess('CB board')) x) y$$, 'true/false');
select qb.fails('B: locked: student push refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('s9', 1, 1)), 'c2')$$, 'bloqueó');
select qb.eq('B: locked: student still reads (pull says can_edit false)', $$select (x->>'can_edit')||'/'||(json_array_length(x->'elements') > 0)::text from (select public.classboard_pull(qb.sess('CB board'), 0, 1, 'c2', null) x) y$$, 'false/true');
select qb.as_user(qb.uid('cb-sub@x.com')::text);
select qb.eq('B: locked: substitute still draws', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('sub1', 1, 1, 'ellipse')), 'c3')->>'applied'$$, '1');
select qb.eq('B: substitute unlocks', $$select public.classboard_set_lock(qb.sess('CB board'), false)->>'locked'$$, 'false');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: unlocked: student draws again', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('s9', 1, 1, 'arrow', false, '{"points":[[0,0],[40,10]]}')), 'c2')->>'applied'$$, '1');

-- ===== size cap (2 MB per board) =====
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.fails('B: one element over 256 KB refused', $$select public.classboard_push(qb.sess('CB big'), 1, qb.els(qb.el('huge', 1, 1, 'text', false, jsonb_build_object('text', repeat('a', 270000)))), 'c1')$$, 'demasiado grande');
select qb.eq('B: 8 elements of ~235 KB fit (≈ 1.9 MB)', $$select (public.classboard_push(qb.sess('CB big'), 1, (select jsonb_agg(qb.el('big'||i, 1, 1, 'text', false, jsonb_build_object('text', repeat('b', 235000)))) from generate_series(1, 4) i), 'c1')->>'applied')
  ||'/'||(public.classboard_push(qb.sess('CB big'), 1, (select jsonb_agg(qb.el('big'||i, 1, 1, 'text', false, jsonb_build_object('text', repeat('b', 235000)))) from generate_series(5, 8) i), 'c1')->>'applied')$$, '4/4');
select qb.fails('B: one more makes it pass 2 MB → refused with a friendly message', $$select public.classboard_push(qb.sess('CB big'), 1, qb.els(qb.el('big9', 1, 1, 'text', false, jsonb_build_object('text', repeat('b', 235000)))), 'c1')$$, 'tamaño máximo (2 MB)');
select qb.eq('B: … nothing of it stored', $$select coalesce(qb.row('CB big', 'big9'), 'none')$$, 'none');
select qb.eq('B: deleting frees space: a delete is accepted and then a new element fits', $$select (public.classboard_push(qb.sess('CB big'), 1, qb.els(qb.el('big1', 2, 1, 'text', true), qb.el('big2', 2, 1, 'text', true)), 'c1')->>'applied')
  ||'/'||(public.classboard_push(qb.sess('CB big'), 1, qb.els(qb.el('big9', 1, 1, 'text', false, jsonb_build_object('text', repeat('b', 235000)))), 'c1')->>'applied')$$, '2/1');
select qb.eq('B: board under the cap', $$select (public.classboard_open(qb.sess('CB big'))->>'bytes')::bigint <= 2097152$$, 'true');

-- ===== versions + restore =====
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.fails('B: student cannot save a manual version', $$select public.classboard_add_version(qb.sess('CB board'), 'manual')$$, 'No autorizado');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.eq('B: teacher saves a version', $$select public.classboard_add_version(qb.sess('CB board'), 'manual')->>'created'$$, 'true');
select qb.eq('B: "class end" version only once', $$select public.classboard_add_version(qb.sess('CB board'), 'class_end')->>'created'$$, 'false');
select qb.fails('B: unknown version label refused', $$select public.classboard_add_version(qb.sess('CB board'), 'hack')$$, 'Versión inválida');
reset role;
select qb.eq('B: a version keeps only the visible elements (no tombstones)', $$select (select count(*) from jsonb_array_elements(v.elements) e where coalesce((e->>'isDeleted')::boolean, false))::text from public.class_board_versions v where v.id = qb.ver('CB board','manual')$$, '0');
set role authenticated; select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: student sees the history and opens a version', $$select (json_array_length(public.classboard_versions(qb.sess('CB board'))) >= 2)::text||'/'||(json_array_length(public.classboard_version(qb.ver('CB board','manual'))->'elements') > 0)::text$$, 'true/true');
select qb.fails('B: student cannot restore', $$select public.classboard_restore(qb.ver('CB board','manual'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.eq('B: admin opens a version (read-only)', $$select public.classboard_version(qb.ver('CB board','manual'))->>'label'$$, 'manual');
select qb.fails('B: admin cannot restore', $$select public.classboard_restore(qb.ver('CB board','manual'))$$, 'No autorizado');
select qb.fails('B: admin cannot save a version', $$select public.classboard_add_version(qb.sess('CB board'), 'manual')$$, 'No autorizado');
select qb.as_user(qb.uid('cb-oadm@x.com')::text);
select qb.fails('B: other-institution admin cannot open a version', $$select public.classboard_version(qb.ver('CB board','manual'))$$, 'No autorizado');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('after', 1, 1, 'diamond')), 'c1');
select qb.eq('B: teacher restores the class-end version: generation 2', $$select public.classboard_restore(qb.ver('CB board','class_end'))->>'generation'$$, '2');
select qb.eq('B: restored content = the class-end elements; a "before restore" version keeps what was there', $$select (select string_agg(e->>'id', ',' order by e->>'id') from json_array_elements(public.classboard_open(qb.sess('CB board'))->'elements') e)||'/'||(qb.ver('CB board','before_restore') is not null)::text$$, 'r1,t1/true');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.fails('B: after restore, a change from the old generation is refused', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('stale', 1, 1)), 'c2')$$, 'desactualizada');
select qb.eq('B: after restore, a pull with the old generation resets (all elements)', $$select (x->>'reset')||'/'||(x->>'generation')||'/'||json_array_length(x->'elements') from (select public.classboard_pull(qb.sess('CB board'), 99999, 1, 'c2', null) x) y$$, 'true/2/2');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select count(*) from (select public.classboard_add_version(qb.sess('CB board'), 'manual') from generate_series(1, 25)) x;
reset role;
select qb.eq('B: at most 20 versions per board, the class-end one kept', $$select qb.nver('CB board')::text||'/'||(qb.ver('CB board','class_end') is not null)::text$$, '20/true');
select qb.eq('B: version authors: never the owner; manual ones by the teacher', $$select (count(*) filter (where created_by = qb.uid('cb-t1@x.com')) >= 18)::text||'/'||(count(*) filter (where created_by = '00000000-0000-0000-0000-000000000001'))::text from public.class_board_versions where session_id = qb.sess('CB board')$$, 'true/0');

-- ===== direct access, group card, student dashboard =====
set role authenticated; select qb.as_user(qb.uid('cb-t1@x.com')::text);
select qb.fails('B: direct select on class_boards denied', $$select count(*) from public.class_boards$$, 'permission denied');
select qb.fails('B: direct select on class_board_elements denied', $$select count(*) from public.class_board_elements$$, 'permission denied');
select qb.fails('B: direct insert into class_board_elements denied', $$insert into public.class_board_elements(session_id, element_id, version, rev, data) values (qb.sess('CB board'), 'z', 1, 1, '{}')$$, 'permission denied');
select qb.fails('B: direct select on class_board_versions denied', $$select count(*) from public.class_board_versions$$, 'permission denied');
select qb.fails('B: internal helpers are not callable', $$select public.tc_classboard_clean('{}'::jsonb)$$, 'permission denied');
select qb.eq('B: group sessions (teacher): the board is flagged', $$select (s->>'has_board')||'/'||(s->>'board_locked') from (select public.group_sessions(qb.grp('CB G1')) x) y, json_array_elements(x->'sessions') s where s->>'id' = qb.sess('CB board')::text$$, 'true/false');
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.eq('B: group sessions (unit admin): read-only, board flagged', $$select (x->>'can_edit')||'/'||(select s->>'has_board' from json_array_elements(x->'sessions') s where s->>'id' = qb.sess('CB board')::text) from (select public.group_sessions(qb.grp('CB G1')) x) y$$, 'false/true');
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.eq('B: student dashboard lists the boards of their past classes', $$select (select count(*) from json_array_elements(public.student_view()->'boards') d where d->>'id' = qb.sess('CB board')::text)::text$$, '1');
select qb.as_user(qb.uid('cb-st4@x.com')::text);
select qb.eq('B: … and not the boards of other groups', $$select (select count(*) from json_array_elements(public.student_view()->'boards') d where d->>'id' = qb.sess('CB board')::text)::text$$, '0');

-- ===== Realtime: private channel "classboard:<id>" (policies on realtime.messages) =====
select qb.as_user(qb.uid('cb-st1@x.com')::text); select qb.rt('classboard:' || qb.sess('CB board'));
select qb.eq('B: RT: enrolled student can send on the channel', $$with i as (insert into realtime.messages(topic, event, payload) values ('classboard:' || qb.sess('CB board'), 'els', '{}') returning 1) select count(*)::text from i$$, '1');
select qb.eq('B: RT: enrolled student can listen', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select public.classboard_set_lock(qb.sess('CB board'), true);
select qb.as_user(qb.uid('cb-st1@x.com')::text);
select qb.fails('B: RT: locked board: student cannot send', $$insert into realtime.messages(topic, event, payload) values ('classboard:' || qb.sess('CB board'), 'els', '{}')$$, 'row-level security');
select qb.eq('B: RT: locked board: student still listens', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qb.as_user(qb.uid('cb-sub@x.com')::text);
select qb.eq('B: RT: locked board: substitute still sends', $$with i as (insert into realtime.messages(topic, event, payload) values ('classboard:' || qb.sess('CB board'), 'els', '{}') returning 1) select count(*)::text from i$$, '1');
select qb.as_user(qb.uid('cb-t1@x.com')::text);
select public.classboard_set_lock(qb.sess('CB board'), false);
select qb.as_user(qb.uid('cb-s1adm@x.com')::text);
select qb.eq('B: RT: unit admin can listen (read-only)', $$select (count(*) >= 1)::text from realtime.messages$$, 'true');
select qb.fails('B: RT: unit admin cannot send', $$insert into realtime.messages(topic, event, payload) values ('classboard:' || qb.sess('CB board'), 'els', '{}')$$, 'row-level security');
select qb.as_user(qb.uid('cb-st4@x.com')::text);
select qb.eq('B: RT: other student hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qb.fails('B: RT: other student cannot send', $$insert into realtime.messages(topic, event, payload) values ('classboard:' || qb.sess('CB board'), 'els', '{}')$$, 'row-level security');
select qb.as_user(qb.uid('cb-oadm@x.com')::text);
select qb.eq('B: RT: other-institution admin hears nothing', $$select count(*)::text from realtime.messages$$, '0');
select qb.as_user(qb.uid('cb-st1@x.com')::text); select qb.rt('classboard:not-a-uuid');
select qb.eq('B: RT: malformed topics are not opened', $$select count(*)::text from realtime.messages$$, '0');
select qb.rt('');
set role anon; select qb.as_user('');
select qb.fails('B: anon cannot open', $$select public.classboard_open(qb.sess('CB board'))$$, 'permission denied');
select qb.fails('B: anon cannot push', $$select public.classboard_push(qb.sess('CB board'), 1, qb.els(qb.el('x', 1, 1)), 'c')$$, 'permission denied');
select qb.fails('B: anon cannot pull', $$select public.classboard_pull(qb.sess('CB board'), 0, 1, 'c', null)$$, 'permission denied');
select qb.fails('B: anon cannot restore', $$select public.classboard_restore(gen_random_uuid())$$, 'permission denied');
reset role;

\echo '================ CLASS BOARD RESULTS ================'
select n, case when ok then 'PASS' else '**FAIL**' end as res, label, detail from qb.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from qb.results;
