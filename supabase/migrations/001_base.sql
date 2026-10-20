-- TeroClass · Fase 1 · Base de datos
-- Pegar completo en Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin riesgo sobre una base que ya tiene datos
-- (todo es "if not exists" / "create or replace" / "drop ... if exists").
--
-- IMPORTANTE (seguridad de registros, H7):
--   Al registrarse, handle_new_user aplica la invitación pendiente (o el slug de
--   /org/<slug>) en el mismo momento del alta, ANTES de que la persona confirme
--   su email. Con usuarios reales hay que tener activado en Supabase
--   Authentication → Providers → Email → "Confirm email" = ON, con SMTP propio
--   (Authentication → Emails → SMTP Settings). Si no, cualquiera podría
--   registrarse con el email de otra persona invitada y quedarse con su lugar.
--
-- SÚPER ADMIN (dueño de la plataforma): el rol vive SOLO en profiles.role. Este script nunca
--   promueve a nadie por email y nunca le quita el rol a un súper admin existente. Para otorgarlo
--   a mano (una sola vez, en el SQL Editor; ver README):
--     update public.profiles set role='superadmin' where id=(select id from auth.users where email='OWNER_EMAIL_HERE');
--   La identidad del súper admin (nombre, email, id) no se muestra a admins ni docentes.
--
-- JERARQUÍA (3 niveles): institución madre › sede/facultad › cátedra/área.
--   institutions.parent_id (null = madre). Los admins de una unidad administran también
--   todo lo que cuelga debajo (clases, personas, invitaciones, playbooks, marca, barras).
--   Las instituciones que ya existían quedan como madres, sin cambios.

-- ========== TABLAS ==========
create table if not exists public.institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  branding jsonb not null default '{}'::jsonb,   -- colores, tipografía, etc.
  logo_url text,
  master_prompt text default '',
  doc_text text default '',
  doc_name text default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text default '',
  role text not null default 'teacher' check (role in ('superadmin','org_admin','teacher')),
  institution_id uuid references public.institutions(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Roles: superadmin / org_admin / teacher / student. Los estudiantes son gratis: nunca ocupan asientos
-- (seats_used cuenta solo teacher + org_admin) y no pertenecen a una unidad (institution_id null):
-- su vínculo con cada institución son sus inscripciones (student_enrollments).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('superadmin','org_admin','teacher','student'));

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  role text not null default 'teacher' check (role in ('org_admin','teacher')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invitations_email_idx on public.invitations (lower(email));
-- Auditoría 2026-10 (TC-07, TC-16, P-04): las invitaciones vencen (14 días), se pueden cancelar o reenviar, y una
-- cuenta que YA existe nunca se mueve sola: queda una invitación pendiente (user_id) que la persona acepta o rechaza
-- dentro de la app (my_invitations / respond_invitation).
alter table public.invitations add column if not exists expires_at timestamptz;
alter table public.invitations add column if not exists declined_at timestamptz;
alter table public.invitations add column if not exists cancelled_at timestamptz;
alter table public.invitations add column if not exists last_sent_at timestamptz;
alter table public.invitations add column if not exists user_id uuid references auth.users(id) on delete cascade;
-- invitaciones pendientes que ya existían: 14 días desde ahora (no se vencen de golpe al actualizar)
update public.invitations set expires_at = greatest(created_at, now()) + interval '14 days' where expires_at is null;
alter table public.invitations alter column expires_at set default (now() + interval '14 days');
alter table public.invitations alter column expires_at set not null;
create index if not exists invitations_user_idx on public.invitations (user_id) where user_id is not null;
create index if not exists invitations_inst_idx on public.invitations (institution_id, created_at desc);
-- Pendiente = ni aceptada, ni rechazada, ni cancelada, y sin vencer
create or replace function public.tc_inv_pending(i public.invitations) returns boolean
language sql stable set search_path = public, pg_temp as
$$ select i.accepted_at is null and i.declined_at is null and i.cancelled_at is null and i.expires_at > now() $$;
create or replace function public.tc_inv_status(i public.invitations) returns text
language sql stable set search_path = public, pg_temp as
$$ select case when i.accepted_at is not null then 'accepted' when i.declined_at is not null then 'declined'
               when i.cancelled_at is not null then 'cancelled' when i.expires_at <= now() then 'expired' else 'pending' end $$;

-- Contadores de límites de frecuencia (IA por IP, emails, documento de clase, salas). Sin acceso directo:
-- solo las funciones de abajo (tc_rate_take). Las filas viejas se borran solas.
create table if not exists public.rate_counters (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  amount bigint not null default 0,
  primary key (key, window_start)
);
create index if not exists rate_counters_window_idx on public.rate_counters (window_start);
alter table public.rate_counters enable row level security;
revoke all on public.rate_counters from anon, authenticated;
-- Suma p_amount a la ventana actual de p_key; devuelve false (y no suma) si se pasaría de p_limit. Uso interno.
create or replace function public.tc_rate_take(p_key text, p_amount bigint, p_limit bigint, p_window_s integer) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_ws timestamptz := to_timestamp(floor(extract(epoch from now()) / greatest(p_window_s, 1)) * greatest(p_window_s, 1));
        v_after bigint;
begin
  if random() < 0.01 then delete from public.rate_counters where window_start < now() - interval '2 days'; end if;
  insert into public.rate_counters as r (key, window_start, amount) values (left(p_key, 200), v_ws, greatest(p_amount, 0))
  on conflict (key, window_start) do update set amount = r.amount + excluded.amount where r.amount + excluded.amount <= p_limit
  returning r.amount into v_after;
  if v_after is null then return false; end if;
  if v_after > p_limit then  -- primera fila de la ventana ya por encima del límite
    update public.rate_counters set amount = amount - greatest(p_amount, 0) where key = left(p_key, 200) and window_start = v_ws;
    return false;
  end if;
  return true;
end $$;
revoke all on function public.tc_rate_take(text, bigint, bigint, integer) from public, anon, authenticated;

-- Marcas de cambios de datos que se aplican UNA sola vez (volver a correr el script no los repite).
create table if not exists public.tc_schema_marks (key text primary key, done_at timestamptz not null default now());
alter table public.tc_schema_marks enable row level security;
revoke all on public.tc_schema_marks from anon, authenticated;

create table if not exists public.plannings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  institution_id uuid references public.institutions(id) on delete set null,
  title text default '',
  data jsonb not null default '{}'::jsonb,       -- planificación completa
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plannings_owner_idx on public.plannings (owner_id);
create index if not exists profiles_institution_idx on public.profiles (institution_id) where institution_id is not null;  -- TC-25
create index if not exists plannings_inst_idx on public.plannings (institution_id);

-- Columnas de marca de la institución
alter table public.institutions add column if not exists slug text unique;
alter table public.institutions add column if not exists color text default '#7c5cbf';
alter table public.institutions add column if not exists bg_color text default '#f0eef8';
alter table public.institutions add column if not exists font text default 'Inter';
alter table public.institutions add column if not exists admin_email text;
-- Si es true, quien se registra desde /org/<slug> entra directo como docente (ocupa un asiento).
-- Si es false (por defecto desde 2026-10, TC-02), solo se entra por invitación.
alter table public.institutions add column if not exists open_registration boolean not null default false;
alter table public.institutions alter column open_registration set default false;
-- Una sola vez: las instituciones que ya existían pasan a "solo por invitación" (un admin lo puede volver a abrir
-- en Panel → Equipo → Acceso por link; volver a correr el script no lo pisa).
do $$
begin
  if not exists (select 1 from public.tc_schema_marks where key = '2026-10-open-registration-off') then
    update public.institutions set open_registration = false where open_registration;
    insert into public.tc_schema_marks (key) values ('2026-10-open-registration-off');
  end if;
end $$;

-- Jerarquía de hasta 3 niveles: institución madre › sede/facultad › cátedra/área.
-- parent_id null = institución madre (las instituciones que ya existían quedan así).
-- No se puede borrar una unidad mientras tenga sub-unidades (on delete restrict).
alter table public.institutions add column if not exists parent_id uuid references public.institutions(id) on delete restrict;
create index if not exists institutions_parent_idx on public.institutions (parent_id);
-- Barras de "enfoque de aprendizaje" de esta unidad (se suman a las heredadas):
--   {"hidden": ["clave", ...], "custom": [{"key":"c_...","label":"...","tooltip":"...","def":0-100}, ...]}
alter table public.institutions add column if not exists methodology_config jsonb not null default '{}'::jsonb;

-- Uso diario de IA por usuario (lo maneja solo consume_ai_quota; sin acceso directo)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

-- Cada pedido a la IA con sus metadatos (tipo, materias, idioma, franja de edad, nivel, barras), para
-- Insights del súper admin. Lo escribe solo consume_ai_quota (con el token del usuario: funciona aun sin
-- la clave del servidor) y finish_ai_event marca si terminó bien. Nadie lo lee directo (sin políticas):
-- solo platform_insights (súper admin), con totales, sin nombres.
create table if not exists public.ai_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  inst_id uuid references public.institutions(id) on delete set null,
  root_id uuid references public.institutions(id) on delete set null,
  kind text not null default 'generate',
  subjects text[] not null default '{}',
  language text,
  age_band text,
  level text,
  bars jsonb not null default '{}'::jsonb,
  ok boolean,
  finished_at timestamptz
);
create index if not exists ai_events_created_idx on public.ai_events (created_at);
create index if not exists ai_events_inst_idx on public.ai_events (inst_id, created_at);
create index if not exists ai_events_user_idx on public.ai_events (user_id, created_at);

-- ========== PLAN Y CONSUMO: tablas ==========
-- Cada institución madre (parent_id null) es una "cuenta": compra ASIENTOS y recibe una
-- ASIGNACIÓN MENSUAL de tokens de IA; las sub-unidades usan la cuenta de su madre.
-- Agotada la asignación, se usan los tokens EXTRA (paquetes comprados, no vencen).
-- Sin pagos en la app: comprar crea una SOLICITUD que el súper admin aprueba tras cobrar afuera.
-- Ninguna de estas tablas se escribe desde la app: solo funciones del servidor.

-- Ajustes de la plataforma (una sola fila; los edita el súper admin con update_platform_settings)
create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  pack_tokens bigint not null default 2000000 check (pack_tokens between 1000 and 1000000000),
  pack_price numeric(12,2) not null default 11.99 check (pack_price >= 0 and pack_price <= 1000000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  personal_monthly_tokens bigint not null default 200000 check (personal_monthly_tokens between 0 and 100000000000),
  default_seats integer not null default 10 check (default_seats between 0 and 1000000),
  default_monthly_tokens bigint not null default 2000000 check (default_monthly_tokens between 0 and 100000000000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;
-- Precio de la IA por millón de tokens (USD), para el costo estimado de Insights. Por defecto GPT-4o.
alter table public.platform_settings add column if not exists ai_price_input numeric(10,4) not null default 2.50
  check (ai_price_input >= 0 and ai_price_input <= 1000);
alter table public.platform_settings add column if not exists ai_price_output numeric(10,4) not null default 10.00
  check (ai_price_output >= 0 and ai_price_output <= 1000);

-- Plan de cada cuenta (una fila por institución madre; se crea al crear la madre o al primer uso)
create table if not exists public.billing_accounts (
  root_id uuid primary key references public.institutions(id) on delete cascade,
  seats integer not null check (seats between 0 and 1000000),
  monthly_tokens bigint not null check (monthly_tokens between 0 and 100000000000),
  extra_tokens_balance bigint not null default 0 check (extra_tokens_balance >= 0),
  updated_at timestamptz not null default now()
);

-- Consumo por mes calendario (UTC). scope 'institution' → account_id = madre; 'personal' → usuario sin institución.
--   used = tokens contados contra la asignación del mes (puede pasarla por el último pedido)
--   extra_used = tokens descontados del saldo extra
create table if not exists public.token_usage_monthly (
  scope text not null check (scope in ('institution','personal')),
  account_id uuid not null,
  month date not null,
  used bigint not null default 0,
  extra_used bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope, account_id, month)
);

-- Registro de cada pedido a la IA (lo escribe solo ai_record_usage, con la clave del servidor)
create table if not exists public.ai_request_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  root_id uuid references public.institutions(id) on delete set null,
  inst_id uuid references public.institutions(id) on delete set null,
  scope text not null check (scope in ('institution','personal','unlimited')),
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  from_extra bigint not null default 0,
  kind text not null default 'generate',
  created_at timestamptz not null default now()
);
create index if not exists ai_request_log_root_idx on public.ai_request_log (root_id, created_at);
create index if not exists ai_request_log_user_idx on public.ai_request_log (user_id, created_at);

-- Solicitudes de compra de paquetes de tokens (se aprueban a mano)
create table if not exists public.token_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  root_id uuid references public.institutions(id) on delete set null,
  root_name text not null default '',
  requested_by uuid references auth.users(id) on delete set null,
  pack_tokens bigint not null check (pack_tokens > 0),
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'USD',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz
);
-- Una sola solicitud pendiente por cuenta
create unique index if not exists token_purchase_one_pending on public.token_purchase_requests (root_id) where status = 'pending';
create index if not exists token_purchase_root_idx on public.token_purchase_requests (root_id, created_at);

-- ========== LIMPIEZA DE DATOS + REGLAS DE FORMATO ==========
-- Slug, logo, colores y tipografía se muestran en pantallas de otros usuarios
-- (incluido el súper admin): solo se aceptan formatos seguros.
do $$
declare r record; cand text;
begin
  -- 1) Corregir slugs inválidos existentes (sin perder el link si se puede)
  for r in select id, slug from public.institutions
            where slug is not null and slug !~ '^[a-z0-9-]{2,60}$' loop
    cand := left(regexp_replace(lower(r.slug), '[^a-z0-9-]', '', 'g'), 60);
    if length(cand) < 2 or exists (select 1 from public.institutions where slug = cand and id <> r.id) then
      cand := left(coalesce(nullif(cand, ''), 'org'), 51) || '-' || left(r.id::text, 8);
    end if;
    update public.institutions set slug = cand where id = r.id;
    raise notice 'TeroClass: slug "%" cambiado a "%" (el link /org/ cambia)', r.slug, cand;
  end loop;
  -- 2) Logos / colores / tipografías inválidos → valor seguro
  update public.institutions set logo_url = null
   where logo_url is not null and logo_url !~ '^https://[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$';
  update public.institutions set color = '#7c5cbf'
   where color is not null and color !~ '^#[0-9A-Fa-f]{3,8}$';
  update public.institutions set bg_color = '#f0eef8'
   where bg_color is not null and bg_color !~ '^#[0-9A-Fa-f]{3,8}$';
  update public.institutions set font = 'Inter'
   where font is not null and font !~ '^[A-Za-z0-9 ,''-]{1,80}$';

  -- 3) Reglas (se agregan una sola vez)
  if not exists (select 1 from pg_constraint where conname = 'institutions_slug_format') then
    alter table public.institutions add constraint institutions_slug_format
      check (slug ~ '^[a-z0-9-]{2,60}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'institutions_logo_url_format') then
    -- solo https://, sin comillas, espacios, < > ( ) ni barras invertidas
    alter table public.institutions add constraint institutions_logo_url_format
      check (logo_url is null or logo_url ~ '^https://[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'institutions_color_format') then
    alter table public.institutions add constraint institutions_color_format
      check (color is null or color ~ '^#[0-9A-Fa-f]{3,8}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'institutions_bg_color_format') then
    alter table public.institutions add constraint institutions_bg_color_format
      check (bg_color is null or bg_color ~ '^#[0-9A-Fa-f]{3,8}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'institutions_font_format') then
    alter table public.institutions add constraint institutions_font_format
      check (font is null or font ~ '^[A-Za-z0-9 ,''-]{1,80}$');
  end if;
end $$;

-- ========== FUNCIONES DE AYUDA ==========
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.my_institution() returns uuid
language sql stable security definer set search_path = public, pg_temp as
$$ select institution_id from public.profiles where id = auth.uid() $$;

create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select role = 'superadmin' from public.profiles where id = auth.uid()), false) $$;

-- ¿Ese usuario es súper admin? (uso interno: ocultar su identidad a los demás)
create or replace function public.is_superadmin_id(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select p_user is not null and exists (select 1 from public.profiles where id = p_user and role = 'superadmin') $$;
-- (lo usan las políticas RLS, que corren con el rol de quien consulta: authenticated necesita ejecutarla;
--  solo responde sí/no para un id que ya se conoce, y los ids del súper admin no se muestran a nadie)
revoke all on function public.is_superadmin_id(uuid) from public, anon;
grant execute on function public.is_superadmin_id(uuid) to authenticated;

-- Al insertar: si la columna indicada (argumento del trigger) apunta a un súper admin, queda en null.
-- Así ni su id ni su identidad aparecen en filas que leen admins y docentes (created_by, invited_by,
-- uploaded_by). Corre como el dueño de la función (puede consultar profiles).
create or replace function public.hide_superadmin_refs() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
declare c text; j jsonb := to_jsonb(new);
begin
  foreach c in array tg_argv loop
    if j ? c and jsonb_typeof(j->c) = 'string' and public.is_superadmin_id((j->>c)::uuid) then
      j := jsonb_set(j, array[c], 'null'::jsonb);
    end if;
  end loop;
  return jsonb_populate_record(new, j);
end $$;
revoke all on function public.hide_superadmin_refs() from public, anon, authenticated;

-- ===== Jerarquía: ayudas =====
-- Cadena de una unidad: ella misma (depth 0) y sus ancestros (depth 1 = padre, 2 = abuelo).
create or replace function public.institution_chain(p_id uuid) returns table (id uuid, depth integer)
language sql stable security definer set search_path = public, pg_temp as
$$ with recursive up(id, parent_id, depth) as (
     select i.id, i.parent_id, 0 from public.institutions i where i.id = p_id
     union all
     select i.id, i.parent_id, up.depth + 1
       from public.institutions i join up on i.id = up.parent_id
      where up.depth < 10)
   select up.id, up.depth from up order by up.depth desc $$;

-- Ancestros (sin incluirse): padre, abuelo...
create or replace function public.institution_ancestors(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as
$$ select c.id from public.institution_chain(p_id) c where c.depth > 0 order by c.depth desc $$;

-- Descendientes (sin incluirse): hijos, nietos...
create or replace function public.institution_descendants(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as
$$ with recursive down(id, depth) as (
     select i.id, 1 from public.institutions i where i.parent_id = p_id
     union all
     select i.id, down.depth + 1
       from public.institutions i join down on i.parent_id = down.id
      where down.depth < 10)
   select down.id from down $$;

-- Nivel: 1 = institución madre, 2 = sede/facultad, 3 = cátedra/área
create or replace function public.institution_level(p_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select count(*)::int from public.institution_chain(p_id) $$;

-- Cuántos niveles cuelgan debajo (0 = no tiene sub-unidades)
create or replace function public.institution_height(p_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ with recursive down(id, depth) as (
     select i.id, 1 from public.institutions i where i.parent_id = p_id
     union all
     select i.id, down.depth + 1
       from public.institutions i join down on i.parent_id = down.id
      where down.depth < 10)
   select coalesce(max(depth), 0)::int from down $$;

revoke all on function public.institution_chain(uuid) from public, anon;
revoke all on function public.institution_ancestors(uuid) from public, anon;
revoke all on function public.institution_descendants(uuid) from public, anon;
revoke all on function public.institution_level(uuid) from public, anon;
revoke all on function public.institution_height(uuid) from public, anon;
grant execute on function public.institution_chain(uuid) to authenticated;
grant execute on function public.institution_ancestors(uuid) to authenticated;
grant execute on function public.institution_descendants(uuid) to authenticated;
grant execute on function public.institution_level(uuid) to authenticated;
grant execute on function public.institution_height(uuid) to authenticated;

-- ¿Esta unidad es la mía o una de sus superiores? (docentes: leer resúmenes del playbook heredado)
create or replace function public.in_my_chain(inst uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select inst is not null and exists (
     select 1 from public.institution_chain(public.my_institution()) c where c.id = inst) $$;

-- Admin de una unidad = súper admin, o org_admin de esa unidad o de cualquiera de sus superiores
create or replace function public.is_admin_of(inst uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select public.is_superadmin() or (inst is not null and exists (
     select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'org_admin' and p.institution_id is not null
        and p.institution_id in (select c.id from public.institution_chain(inst) c))) $$;

-- ===== Plan y consumo: ayudas internas (sin acceso desde la app) =====
-- Mes de consumo: primer día del mes calendario en UTC
create or replace function public.billing_month() returns date
language sql stable set search_path = public, pg_temp as
$$ select date_trunc('month', now() at time zone 'utc')::date $$;

-- Cuenta de una unidad = su institución madre (la cima de la cadena)
create or replace function public.billing_root(p_inst uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as
$$ select c.id from public.institution_chain(p_inst) c order by c.depth desc limit 1 $$;

-- Asientos en uso: docentes + admins de toda la cuenta (madre y todo lo que cuelga)
create or replace function public.seats_used(p_root uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select count(*)::int from public.profiles
    where role in ('teacher','org_admin') and institution_id is not null
      and (institution_id = p_root or institution_id in (select public.institution_descendants(p_root))) $$;

-- Plan vigente (si la cuenta todavía no tiene fila, valen los valores por defecto)
create or replace function public.billing_seats(p_root uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select a.seats from public.billing_accounts a where a.root_id = p_root),
                   (select s.default_seats from public.platform_settings s where s.id)) $$;

create or replace function public.seat_available(p_root uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select p_root is not null and public.seats_used(p_root) < public.billing_seats(p_root) $$;

-- Crea la fila del plan con los valores por defecto si falta (uso interno, escribe)
create or replace function public.ensure_billing_account(p_root uuid) returns void
language sql volatile security definer set search_path = public, pg_temp as
$$ insert into public.billing_accounts (root_id, seats, monthly_tokens)
   select p_root, s.default_seats, s.default_monthly_tokens from public.platform_settings s
    where s.id and p_root is not null and exists (select 1 from public.institutions i where i.id = p_root and i.parent_id is null)
   on conflict (root_id) do nothing $$;

-- Antes de sumar a alguien a una unidad: ¿queda un asiento en la cuenta? (si ya ocupa uno en la
-- misma cuenta, moverlo no cuesta otro). Error claro si no.
create or replace function public.assert_seat_for(p_inst uuid, p_user uuid default null) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_root uuid := public.billing_root(p_inst); v_used int; v_seats int;
begin
  if v_root is null then return; end if;
  if p_user is not null and exists (
       select 1 from public.profiles p
        where p.id = p_user and p.role in ('teacher','org_admin') and p.institution_id is not null
          and public.billing_root(p.institution_id) = v_root) then
    return;
  end if;
  perform public.ensure_billing_account(v_root);
  perform 1 from public.billing_accounts where root_id = v_root for update; -- una alta a la vez por cuenta
  v_used := public.seats_used(v_root); v_seats := public.billing_seats(v_root);
  if v_used >= v_seats then
    raise exception 'No quedan asientos disponibles en el plan de la institución (% de % en uso)', v_used, v_seats;
  end if;
end $$;

revoke all on function public.billing_month() from public, anon, authenticated;
revoke all on function public.billing_root(uuid) from public, anon, authenticated;
revoke all on function public.seats_used(uuid) from public, anon, authenticated;
revoke all on function public.billing_seats(uuid) from public, anon, authenticated;
revoke all on function public.seat_available(uuid) from public, anon, authenticated;
revoke all on function public.ensure_billing_account(uuid) from public, anon, authenticated;
revoke all on function public.assert_seat_for(uuid, uuid) from public, anon, authenticated;

-- Al registrarse: crear perfil y aplicar invitación pendiente (o slug abierto).
-- Todo se basa en auth.users.email (el email real de la cuenta), nunca en profiles.email.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  inv     public.invitations%rowtype;
  v_email text := lower(trim(coalesce(new.email, '')));
  v_slug  text := lower(trim(coalesce(new.raw_user_meta_data->>'org_slug', '')));
  v_role  text := 'teacher';
  v_inst  uuid;
  -- Ingreso de estudiante (link mágico desde "Soy estudiante"): sin invitación queda como estudiante,
  -- sin institución y sin acceso al generador. Las invitaciones de docentes se aplican igual que siempre.
  v_student boolean := coalesce(new.raw_user_meta_data->>'via', '') = 'student_link';
begin
  if v_email <> '' then
    -- solo invitaciones vigentes (TC-16: vencen a los 14 días; canceladas o rechazadas no cuentan)
    select * into inv from public.invitations i
     where lower(i.email) = v_email and public.tc_inv_pending(i)
     order by i.created_at desc limit 1;
  end if;

  if inv.id is not null then
    v_role := inv.role;
    v_inst := inv.institution_id;
  elsif v_student then
    v_role := 'student'; v_inst := null;
  elsif v_slug <> '' then
    -- Solo se entra por slug si la institución tiene el registro abierto
    select id into v_inst from public.institutions
     where slug = v_slug and open_registration
     limit 1;
  end if;

  -- Plan: sin asiento libre en la cuenta, la persona queda sin institución (el alta no falla)
  -- y la invitación sigue pendiente. La pantalla /org/<slug> ya avisa antes de registrarse.
  if v_inst is not null and not public.seat_available(public.billing_root(v_inst)) then
    v_inst := null; v_role := case when v_student then 'student' else 'teacher' end; inv := null;
  end if;

  -- Nadie se vuelve súper admin al registrarse: ese rol se otorga solo a mano (ver encabezado).

  insert into public.profiles (id, email, name, role, institution_id)
  values (new.id, v_email,
          left(trim(coalesce(new.raw_user_meta_data->>'name', '')), 120),
          v_role, v_inst);

  if inv.id is not null then
    update public.invitations set accepted_at = now() where id = inv.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Si cambia el email de la cuenta (Auth) o se confirma, reflejarlo en el perfil
create or replace function public.handle_user_updated() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(trim(coalesce(new.email, ''))) where id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_user_updated();

-- Fecha de modificación automática
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists plannings_touch on public.plannings;
create trigger plannings_touch before update on public.plannings
  for each row execute function public.touch_updated_at();

-- Perfiles: desde la app (roles authenticated/anon) nadie cambia email, id ni fecha;
-- rol e institución solo el súper admin (las funciones del servidor y el panel de
-- Supabase corren con otro rol y sí pueden).
create or replace function public.protect_profile() returns trigger
language plpgsql set search_path = public, pg_temp as
$$
begin
  if current_user in ('authenticated','anon') then
    if new.email is distinct from old.email then
      raise exception 'El email no se puede cambiar desde el perfil';
    end if;
    if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
      raise exception 'No autorizado a cambiar este dato';
    end if;
    if (new.role is distinct from old.role or new.institution_id is distinct from old.institution_id)
       and not public.is_superadmin() then
      raise exception 'No autorizado a cambiar rol o institución';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();

-- Barras de enfoque: valida y normaliza methodology_config.
-- Devuelve siempre {"hidden":[...],"custom":[{key,label,tooltip,def}]}; formato inválido → error.
create or replace function public.clean_methodology_config(p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as
$$
declare
  v_hidden jsonb := '[]'::jsonb;
  v_custom jsonb := '[]'::jsonb;
  v_keys   text[] := '{}';
  e jsonb; k text; lbl text; tip text; d numeric;
begin
  if p is null or p = 'null'::jsonb then return '{"hidden":[],"custom":[]}'::jsonb; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Configuración de barras inválida'; end if;
  if exists (select 1 from jsonb_object_keys(p) x where x not in ('hidden','custom')) then
    raise exception 'Configuración de barras inválida';
  end if;
  if p ? 'hidden' and p->'hidden' <> 'null'::jsonb then
    if jsonb_typeof(p->'hidden') <> 'array' or jsonb_array_length(p->'hidden') > 40 then
      raise exception 'Configuración de barras inválida';
    end if;
    for e in select * from jsonb_array_elements(p->'hidden') loop
      if jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[a-z0-9_]{1,40}$' then
        raise exception 'Configuración de barras inválida';
      end if;
      if not v_hidden @> jsonb_build_array(e) then v_hidden := v_hidden || jsonb_build_array(e); end if;
    end loop;
  end if;
  if p ? 'custom' and p->'custom' <> 'null'::jsonb then
    if jsonb_typeof(p->'custom') <> 'array' or jsonb_array_length(p->'custom') > 15 then
      raise exception 'Configuración de barras inválida (máximo 15 barras propias)';
    end if;
    for e in select * from jsonb_array_elements(p->'custom') loop
      if jsonb_typeof(e) <> 'object' then raise exception 'Configuración de barras inválida'; end if;
      k   := e->>'key';
      lbl := trim(coalesce(e->>'label', ''));
      tip := trim(coalesce(e->>'tooltip', ''));
      if k is null or k !~ '^c_[a-z0-9_]{1,40}$' or k = any(v_keys) then
        raise exception 'Configuración de barras inválida';
      end if;
      if lbl = '' or length(lbl) > 60 or length(tip) > 300 or lbl ~ '[<>]' or tip ~ '[<>]' then
        raise exception 'Configuración de barras inválida (nombre de 1 a 60 caracteres, descripción hasta 300, sin < >)';
      end if;
      if jsonb_typeof(e->'def') <> 'number' then raise exception 'Configuración de barras inválida'; end if;
      d := (e->>'def')::numeric;
      if d < 0 or d > 100 or d <> trunc(d) then raise exception 'Configuración de barras inválida (valor inicial de 0 a 100)'; end if;
      v_keys := v_keys || k;
      v_custom := v_custom || jsonb_build_array(jsonb_build_object('key', k, 'label', lbl, 'tooltip', tip, 'def', d::int));
    end loop;
  end if;
  return jsonb_build_object('hidden', v_hidden, 'custom', v_custom);
end $$;

-- Instituciones: slug y email del admin solo los cambia el súper admin.
-- Un org_admin puede cambiar nombre, colores, tipografía, logo, prompt, documentos
-- y si el registro por link está abierto.
create or replace function public.protect_institution() returns trigger
language plpgsql set search_path = public, pg_temp as
$$
begin
  new.slug := nullif(lower(trim(new.slug)), '');
  new.admin_email := nullif(lower(trim(new.admin_email)), '');
  if tg_op = 'UPDATE' and current_user in ('authenticated','anon') and not public.is_superadmin() then
    if new.slug is distinct from old.slug then
      raise exception 'Solo el súper admin puede cambiar el slug';
    end if;
    if new.admin_email is distinct from nullif(lower(trim(old.admin_email)), '') then
      raise exception 'Solo el súper admin puede cambiar el email del admin';
    end if;
    if new.id is distinct from old.id or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'No autorizado a cambiar este dato';
    end if;
    if new.parent_id is distinct from old.parent_id then
      raise exception 'Solo el súper admin puede mover unidades';
    end if;
  end if;
  new.methodology_config := public.clean_methodology_config(new.methodology_config);
  return new;
end $$;
drop trigger if exists institutions_protect on public.institutions;
create trigger institutions_protect before insert or update on public.institutions
  for each row execute function public.protect_institution();

-- Jerarquía: máximo 3 niveles y sin ciclos (corre antes que institutions_protect)
create or replace function public.institutions_hierarchy() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id then return new; end if;
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'Una unidad no puede depender de sí misma';
  end if;
  if tg_op = 'UPDATE' and new.parent_id in (select public.institution_descendants(new.id)) then
    raise exception 'No se puede mover una unidad dentro de una de sus sub-unidades (ciclo)';
  end if;
  if public.institution_level(new.parent_id)
     + 1 + (case when tg_op = 'UPDATE' then public.institution_height(new.id) else 0 end) > 3 then
    raise exception 'Máximo 3 niveles: institución madre › sede/facultad › cátedra/área';
  end if;
  return new;
end $$;
drop trigger if exists institutions_hierarchy on public.institutions;
create trigger institutions_hierarchy before insert or update of parent_id on public.institutions
  for each row execute function public.institutions_hierarchy();

-- Planificaciones: si la persona cambió de institución (o dejó de tener una), al
-- editar una planificación vieja esta pasa a su institución actual, así la regla
-- "institution_id = mi institución" no le impide guardar.
create or replace function public.plannings_keep_institution() returns trigger
language plpgsql set search_path = public, pg_temp as
$$
begin
  if current_user in ('authenticated','anon') and not public.is_superadmin()
     and new.institution_id is not distinct from old.institution_id
     and new.institution_id is distinct from public.my_institution() then
    new.institution_id := public.my_institution();
  end if;
  return new;
end $$;
drop trigger if exists plannings_institution on public.plannings;
create trigger plannings_institution before update on public.plannings
  for each row execute function public.plannings_keep_institution();

-- ========== SEGURIDAD (quién ve qué) ==========
alter table public.institutions enable row level security;
alter table public.profiles     enable row level security;
alter table public.invitations  enable row level security;
alter table public.plannings    enable row level security;
alter table public.ai_usage     enable row level security;

-- Instituciones
drop policy if exists inst_select on public.institutions;
create policy inst_select on public.institutions for select
  using (public.is_superadmin() or id = public.my_institution() or public.is_admin_of(id));
drop policy if exists inst_insert on public.institutions;
create policy inst_insert on public.institutions for insert
  with check (public.is_superadmin());
drop policy if exists inst_update on public.institutions;
create policy inst_update on public.institutions for update
  using (public.is_admin_of(id)) with check (public.is_admin_of(id));
drop policy if exists inst_delete on public.institutions;
create policy inst_delete on public.institutions for delete
  using (public.is_superadmin());

-- Perfiles: los admins ven a su gente, pero solo cada uno edita su propio perfil
-- (en la práctica, solo el nombre). Roles y bajas: set_member_role / remove_member.
drop policy if exists prof_select on public.profiles;
-- Estudiantes: solo se ven a sí mismos (y el súper admin). Los admins ven a sus estudiantes únicamente
-- a través de las inscripciones que cargó su institución (list_students), nunca por profiles.
create policy prof_select on public.profiles for select
  using (id = auth.uid() or public.is_superadmin()
         or (institution_id is not null and role not in ('superadmin','student') and public.is_admin_of(institution_id)));
drop policy if exists prof_update on public.profiles;
create policy prof_update on public.profiles for update
  using (id = auth.uid() or public.is_superadmin())
  with check (id = auth.uid() or public.is_superadmin());

-- Invitaciones
drop policy if exists inv_all on public.invitations;
create policy inv_all on public.invitations for all
  using (public.is_admin_of(institution_id))
  with check (public.is_admin_of(institution_id));

-- Planificaciones: cada docente las suyas (y solo en su institución);
-- admins ven las de su institución
drop policy if exists plan_select on public.plannings;
create policy plan_select on public.plannings for select
  using (owner_id = auth.uid()
         or (institution_id is not null and public.is_admin_of(institution_id)
             and (public.is_superadmin() or not public.is_superadmin_id(owner_id))));
drop policy if exists plan_insert on public.plannings;
create policy plan_insert on public.plannings for insert
  with check (owner_id = auth.uid() and public.my_role() is distinct from 'student'
              and (public.is_superadmin() or institution_id is not distinct from public.my_institution()));
drop policy if exists plan_update on public.plannings;
create policy plan_update on public.plannings for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
              and (public.is_superadmin() or institution_id is not distinct from public.my_institution()));
drop policy if exists plan_delete on public.plannings;
create policy plan_delete on public.plannings for delete
  using (owner_id = auth.uid());

-- Uso de IA: sin políticas = nadie lo lee ni escribe directo (solo consume_ai_quota)
revoke all on public.ai_usage from anon, authenticated;

-- ========== LOGOS (almacenamiento) ==========
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

-- ¿Es admin de la institución dueña de esta carpeta (<institution_id>/archivo)?
create or replace function public.can_manage_logo(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_inst uuid;
begin
  begin
    v_inst := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  return v_inst is not null and public.is_admin_of(v_inst);
end $$;
revoke all on function public.can_manage_logo(text) from public, anon;
grant execute on function public.can_manage_logo(text) to authenticated;

-- El bucket es público: las URL públicas de los logos funcionan sin política de
-- lectura. Listar/leer por API queda solo para los admins de esa carpeta
-- (lo necesita el upload con upsert:true).
drop policy if exists logos_read on storage.objects;
create policy logos_read on storage.objects for select to authenticated
  using (bucket_id = 'logos' and public.can_manage_logo(name));
drop policy if exists logos_write on storage.objects;
create policy logos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.can_manage_logo(name));
drop policy if exists logos_update on storage.objects;
create policy logos_update on storage.objects for update to authenticated
  using (bucket_id = 'logos' and public.can_manage_logo(name))
  with check (bucket_id = 'logos' and public.can_manage_logo(name));
drop policy if exists logos_delete on storage.objects;
create policy logos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and public.can_manage_logo(name));


-- ========== FUNCIONES PARA LA APP ==========
-- Marca pública de una institución (para la pantalla de login /org/<slug>)
-- Marca efectiva: si una sub-unidad no tiene color / fondo / tipografía / logo propios,
-- usa los de la unidad superior más cercana que sí los tenga.
create or replace function public.institution_branding(p_id uuid) returns json
language sql stable security definer set search_path = public, pg_temp as
$$ select json_build_object(
     'name',     (select i.name from public.institutions i where i.id = p_id),
     'color',    coalesce((select i.color    from public.institution_chain(p_id) c join public.institutions i on i.id = c.id where i.color    is not null order by c.depth limit 1), '#7c5cbf'),
     'bg_color', coalesce((select i.bg_color from public.institution_chain(p_id) c join public.institutions i on i.id = c.id where i.bg_color is not null order by c.depth limit 1), '#f0eef8'),
     'font',     coalesce((select i.font     from public.institution_chain(p_id) c join public.institutions i on i.id = c.id where i.font     is not null order by c.depth limit 1), 'Inter'),
     'logo_url', (select i.logo_url from public.institution_chain(p_id) c join public.institutions i on i.id = c.id where i.logo_url is not null order by c.depth limit 1),
     'path',     (select string_agg(i.name, ' › ' order by c.depth desc) from public.institution_chain(p_id) c join public.institutions i on i.id = c.id)) $$;
revoke all on function public.institution_branding(uuid) from public, anon, authenticated;

-- seats_full: la cuenta no tiene asientos libres (la pantalla de registro avisa antes de crear la cuenta)
drop function if exists public.get_org_branding(text);
create function public.get_org_branding(p_slug text)
returns table (name text, slug text, color text, bg_color text, font text, logo_url text, open_registration boolean, path text, seats_full boolean)
language sql stable security definer set search_path = public, pg_temp as
$$ select i.name, i.slug, b->>'color', b->>'bg_color', b->>'font', b->>'logo_url', i.open_registration, b->>'path',
          not public.seat_available(public.billing_root(i.id))
     from public.institutions i
     cross join lateral (select public.institution_branding(i.id)::jsonb as b) x
    where i.slug = lower(trim(p_slug)) limit 1 $$;
grant execute on function public.get_org_branding(text) to anon, authenticated;

-- Configuración efectiva de una unidad (de la madre hacia abajo). Por defecto, la mía.
-- Devuelve {chain:[{id,name,level,parent_id,slug,master_prompt,methodology}],
--           master_prompts:[{id,name,prompt}], methodology:{hidden,custom}, branding:{...}}
-- methodology efectiva: barras base sin "hidden" + "custom" (de la madre hacia abajo, cada nivel
-- primero oculta y después agrega). La pueden pedir: súper admin, sus admins y quien pertenece a ella.
create or replace function public.get_effective_config(p_inst uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_inst   uuid := coalesce(p_inst, public.my_institution());
  v_chain  jsonb := '[]'::jsonb;
  v_mp     jsonb := '[]'::jsonb;
  v_hidden jsonb := '[]'::jsonb;
  v_custom jsonb := '[]'::jsonb;
  r record; cfg jsonb; e jsonb; lvl int := 0;
begin
  if v_inst is null then return null; end if;
  if not exists (select 1 from public.institutions where id = v_inst) then raise exception 'No autorizado'; end if;
  if not (public.is_superadmin() or v_inst = public.my_institution() or public.is_admin_of(v_inst)) then
    raise exception 'No autorizado';
  end if;
  for r in select i.id, i.name, i.slug, i.parent_id, i.master_prompt, i.methodology_config
             from public.institution_chain(v_inst) c join public.institutions i on i.id = c.id
            order by c.depth desc loop
    lvl := lvl + 1;
    cfg := public.clean_methodology_config(r.methodology_config);
    v_chain := v_chain || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'name', r.name, 'slug', r.slug, 'level', lvl, 'parent_id', r.parent_id,
      'master_prompt', coalesce(r.master_prompt, ''), 'methodology', cfg));
    if trim(coalesce(r.master_prompt, '')) <> '' then
      v_mp := v_mp || jsonb_build_array(jsonb_build_object('id', r.id, 'name', r.name, 'prompt', r.master_prompt));
    end if;
    for e in select * from jsonb_array_elements(cfg->'hidden') loop
      if not v_hidden @> jsonb_build_array(e) then v_hidden := v_hidden || jsonb_build_array(e); end if;
      select coalesce(jsonb_agg(x), '[]'::jsonb) into v_custom
        from jsonb_array_elements(v_custom) x where x->>'key' <> (e #>> '{}');
    end loop;
    for e in select * from jsonb_array_elements(cfg->'custom') loop
      select coalesce(jsonb_agg(x), '[]'::jsonb) into v_custom
        from jsonb_array_elements(v_custom) x where x->>'key' <> e->>'key';
      v_custom := v_custom || jsonb_build_array(e);
      v_hidden := v_hidden - (e->>'key');
    end loop;
  end loop;
  return json_build_object(
    'chain', v_chain,
    'master_prompts', v_mp,
    'methodology', jsonb_build_object('hidden', v_hidden, 'custom', v_custom),
    'branding', public.institution_branding(v_inst));
end $$;
revoke all on function public.get_effective_config(uuid) from public, anon;
grant execute on function public.get_effective_config(uuid) to authenticated;

-- Súper admin: totales de la plataforma (incluye usos de IA de hoy, UTC)
create or replace function public.platform_stats() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  return json_build_object(
    'institutions', (select count(*) from public.institutions),
    'top_level',    (select count(*) from public.institutions where parent_id is null),
    'users',        (select count(*) from public.profiles),
    'teachers',     (select count(*) from public.profiles where role = 'teacher'),
    'admins',       (select count(*) from public.profiles where role = 'org_admin'),
    'students',     (select count(*) from public.profiles where role = 'student'),
    'classes',      (select count(*) from public.plannings),
    'ai_today',     (select coalesce(sum(count), 0) from public.ai_usage where day = (now() at time zone 'utc')::date),
    'ai_users_today', (select count(*) from public.ai_usage where day = (now() at time zone 'utc')::date and count > 0));
end $$;
revoke all on function public.platform_stats() from public, anon;
grant execute on function public.platform_stats() to authenticated;

-- Cantidad de org_admins de una institución (uso interno)
create or replace function public.org_admin_count(p_inst uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select count(*)::int from public.profiles where institution_id = p_inst and role = 'org_admin' $$;
revoke all on function public.org_admin_count(uuid) from public, anon, authenticated;

-- Una institución madre no puede quedarse sin admin. Las sub-unidades sí (las siguen
-- administrando los admins de las unidades superiores). Uso interno.
create or replace function public.assert_not_last_admin(p_inst uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if p_inst is null then return; end if;
  if exists (select 1 from public.institutions where id = p_inst and parent_id is not null) then return; end if;
  perform 1 from public.profiles where institution_id = p_inst and role = 'org_admin' for update;
  if public.org_admin_count(p_inst) <= 1 then
    raise exception 'No se puede quitar el último administrador de la institución';
  end if;
end $$;
revoke all on function public.assert_not_last_admin(uuid) from public, anon, authenticated;

-- Sumar a alguien a una institución. Devuelve:
--   'invited'   → no tiene cuenta: invitación por email (se aplica sola cuando se registra con ese email; vence a los 14 días)
--   'pending'   → YA tiene cuenta (estudiante, docente sin institución…): queda una invitación pendiente que la persona
--                 acepta o rechaza dentro de la app (TC-07: nunca se mueve una cuenta sin su aceptación)
--   'added'     → ya es docente/admin de una unidad que quien invita administra (dentro de la misma cuenta):
--                 reorganización interna, se mueve directo (como antes)
--   'not_allowed' (esa cuenta no se puede invitar; al súper admin que llama se le devuelve 'superadmin').
-- No revela a otros que ese email es del dueño.
create or replace function public.invite_member(p_inst uuid, p_email text, p_role text default 'teacher')
returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  prof    public.profiles%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if p_inst is null or not public.is_admin_of(p_inst) then raise exception 'No autorizado'; end if;
  if p_role is null or p_role not in ('teacher','org_admin') then raise exception 'Rol inválido'; end if;
  if v_email = '' then raise exception 'Email requerido'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Email inválido'; end if;

  -- Buscar por el email REAL de la cuenta (auth.users), no por profiles.email
  select p.* into prof
    from public.profiles p join auth.users u on u.id = p.id
   where lower(trim(u.email)) = v_email
   limit 1;

  if prof.id is not null then
    if prof.role = 'superadmin' then
      return case when public.is_superadmin() then 'superadmin' else 'not_allowed' end;
    end if;
    -- Reorganización interna: ya es docente/admin de una unidad que administro, en la misma cuenta → directo.
    if prof.role in ('teacher','org_admin') and prof.institution_id is not null and public.is_admin_of(prof.institution_id)
       and public.billing_root(prof.institution_id) = public.billing_root(p_inst) then
      if prof.role = 'org_admin' and (prof.institution_id is distinct from p_inst or p_role <> 'org_admin') then
        perform public.assert_not_last_admin(prof.institution_id);
      end if;
      perform public.assert_seat_for(p_inst, prof.id);
      update public.profiles set institution_id = p_inst, role = p_role where id = prof.id;
      return 'added';
    end if;
    -- De otra institución que no administro: no se puede invitar.
    if prof.institution_id is not null and not public.is_admin_of(prof.institution_id) then
      raise exception 'Esa persona ya pertenece a otra institución';
    end if;
    -- Cualquier otra cuenta (estudiante, docente sin institución, admin de otra cuenta que administro como súper
    -- admin…): invitación pendiente; la persona la acepta o la rechaza en la app.
    perform public.assert_seat_for(p_inst, prof.id);
    delete from public.invitations
     where institution_id = p_inst and accepted_at is null and (user_id = prof.id or lower(email) = v_email);
    insert into public.invitations (email, institution_id, role, invited_by, user_id)
    values (v_email, p_inst, p_role, auth.uid(), prof.id);
    return 'pending';
  end if;

  perform public.assert_seat_for(p_inst, null);
  delete from public.invitations
   where lower(email) = v_email and institution_id = p_inst and accepted_at is null;
  insert into public.invitations (email, institution_id, role, invited_by)
  values (v_email, p_inst, p_role, auth.uid());
  return 'invited';
end $$;
revoke all on function public.invite_member(uuid, text, text) from public, anon;
grant execute on function public.invite_member(uuid, text, text) to authenticated;

-- Cambiar el rol de alguien de la institución ('teacher' | 'org_admin'). Devuelve el rol nuevo.
create or replace function public.set_member_role(p_user uuid, p_role text)
returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare t public.profiles%rowtype;
begin
  if p_role is null or p_role not in ('teacher','org_admin') then raise exception 'Rol inválido'; end if;
  select * into t from public.profiles where id = p_user;
  if t.id is null or t.institution_id is null or not public.is_admin_of(t.institution_id) then
    raise exception 'No autorizado';
  end if;
  if t.role = 'superadmin' then
    if public.is_superadmin() then raise exception 'No se puede modificar al súper admin'; end if;
    raise exception 'No autorizado';
  end if;
  if t.role = 'org_admin' and p_role <> 'org_admin' then
    perform public.assert_not_last_admin(t.institution_id);
  end if;
  update public.profiles set role = p_role where id = p_user;
  return p_role;
end $$;
revoke all on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- Sacar a alguien de la institución (queda como docente sin institución). Devuelve 'removed'.
create or replace function public.remove_member(p_user uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare t public.profiles%rowtype;
begin
  select * into t from public.profiles where id = p_user;
  if t.id is null or t.institution_id is null or not public.is_admin_of(t.institution_id) then
    raise exception 'No autorizado';
  end if;
  if t.role = 'superadmin' then
    if public.is_superadmin() then raise exception 'No se puede modificar al súper admin'; end if;
    raise exception 'No autorizado';
  end if;
  if t.role = 'org_admin' then
    perform public.assert_not_last_admin(t.institution_id);
  end if;
  update public.profiles set institution_id = null, role = 'teacher' where id = p_user;
  return 'removed';
end $$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;

-- Crear institución o sub-unidad y (opcional) invitar a su admin.
--   p_parent null → institución madre (solo súper admin).
--   p_parent = una unidad que administrás → sub-unidad (máximo 3 niveles). Sin color propio
--   (null) hereda la marca de la unidad superior.
drop function if exists public.create_institution(text, text, text, text);
create or replace function public.create_institution(p_name text, p_slug text, p_admin_email text default '',
                                                     p_color text default null, p_parent uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  new_id  uuid;
  v_slug  text := lower(trim(coalesce(p_slug, '')));
  v_email text := lower(trim(coalesce(p_admin_email, '')));
  v_color text := nullif(trim(coalesce(p_color, '')), '');
begin
  if p_parent is null then
    if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  else
    if not exists (select 1 from public.institutions where id = p_parent) or not public.is_admin_of(p_parent) then
      raise exception 'No autorizado';
    end if;
    if public.institution_level(p_parent) >= 3 then
      raise exception 'Máximo 3 niveles: institución madre › sede/facultad › cátedra/área';
    end if;
  end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Nombre requerido'; end if;
  if v_slug !~ '^[a-z0-9-]{2,60}$' then
    raise exception 'Slug inválido: usa de 2 a 60 letras minúsculas, números o guiones';
  end if;
  if p_parent is null then
    insert into public.institutions (name, slug, color, admin_email, created_by)
    values (left(trim(p_name), 120), v_slug, coalesce(v_color, '#7c5cbf'), nullif(v_email, ''), auth.uid())
    returning id into new_id;
    perform public.ensure_billing_account(new_id); -- plan por defecto (asientos + tokens/mes)
  else
    insert into public.institutions (name, slug, color, bg_color, font, admin_email, created_by, parent_id)
    values (left(trim(p_name), 120), v_slug, v_color, null, null, nullif(v_email, ''), auth.uid(), p_parent)
    returning id into new_id;
  end if;
  if v_email <> '' then
    perform public.invite_member(new_id, v_email, 'org_admin');
  end if;
  return new_id;
end $$;
revoke all on function public.create_institution(text, text, text, text, uuid) from public, anon;
grant execute on function public.create_institution(text, text, text, text, uuid) to authenticated;

-- Borrar una sub-unidad vacía (sin sub-unidades ni personas). La puede borrar el súper
-- admin o un admin de una unidad superior. Devuelve 'deleted'.
create or replace function public.delete_institution(p_inst uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_parent uuid; v_found boolean;
begin
  select true, parent_id into v_found, v_parent from public.institutions where id = p_inst;
  if v_found is null then raise exception 'No autorizado'; end if;
  if not (public.is_superadmin() or (v_parent is not null and public.is_admin_of(v_parent))) then
    raise exception 'No autorizado';
  end if;
  if exists (select 1 from public.institutions where parent_id = p_inst) then
    raise exception 'Primero borrá o mové sus sub-unidades';
  end if;
  if exists (select 1 from public.profiles where institution_id = p_inst) then
    raise exception 'Primero mové o quitá a las personas de esta unidad';
  end if;
  if exists (select 1 from public.class_groups where institution_id = p_inst)
     or exists (select 1 from public.student_enrollments where institution_id = p_inst)
     or exists (select 1 from public.class_sessions where institution_id = p_inst) then
    raise exception 'Primero borrá los grupos, estudiantes y clases de esta unidad';
  end if;
  delete from public.institutions where id = p_inst;
  return 'deleted';
end $$;
revoke all on function public.delete_institution(uuid) from public, anon;
grant execute on function public.delete_institution(uuid) to authenticated;

-- Súper admin: mover a una persona a otra unidad (o dejarla sin institución con null).
-- Mantiene su rol (sin institución queda como docente). Devuelve 'moved'.
create or replace function public.admin_move_member(p_user uuid, p_inst uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare t public.profiles%rowtype;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  select * into t from public.profiles where id = p_user;
  if t.id is null then raise exception 'No autorizado'; end if;
  if t.role = 'superadmin' then raise exception 'No se puede modificar al súper admin'; end if;
  if t.role = 'student' then raise exception 'Los estudiantes no pertenecen a una unidad: se cargan en los grupos'; end if;
  if p_inst is not null and not exists (select 1 from public.institutions where id = p_inst) then
    raise exception 'No autorizado';
  end if;
  if t.institution_id is not distinct from p_inst then return 'moved'; end if;
  if t.role = 'org_admin' then perform public.assert_not_last_admin(t.institution_id); end if;
  update public.profiles
     set institution_id = p_inst,
         role = case when p_inst is null then 'teacher' else role end
   where id = p_user;
  return 'moved';
end $$;
revoke all on function public.admin_move_member(uuid, uuid) from public, anon;
grant execute on function public.admin_move_member(uuid, uuid) to authenticated;

-- Límite diario de IA. Suma 1 uso y devuelve {"allowed":bool,"used":int,"limit":int}.
-- Límites por día (UTC): súper admin 500, org_admin 150, docente con institución 60,
-- usuario sin institución 15. TC-01 (2026-10): las cuentas sin institución son las que cualquiera puede crear gratis,
-- así que arrancan más bajo: email sin confirmar 3, cuenta de menos de 7 días 5, después 15. Estos topes valen
-- aunque falte la clave del servidor (no dependen de SUPABASE_SERVICE_ROLE_KEY).
create or replace function public.ai_daily_limit(p_uid uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select case
     when p.role = 'student' then 0          -- estudiantes: sin generador
     when p.role = 'superadmin' then 500
     when p.role = 'org_admin' and p.institution_id is not null then 150
     when p.institution_id is not null then 60
     when p.id is null then 0
     when (select u.email_confirmed_at from auth.users u where u.id = p_uid) is null then 3
     when p.created_at > now() - interval '7 days' then 5
     else 15 end
   from (select null) x left join public.profiles p on p.id = p_uid $$;
revoke all on function public.ai_daily_limit(uuid) from public, anon, authenticated;

-- Metadatos de un pedido a la IA: solo valores conocidos (el resto se descarta). Uso interno.
-- {kind, subjects[≤5, ≤60 car.], language, age_band, level, bars{clave: 0-100, ≤20}}
create or replace function public.ai_meta_clean(p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as
$$
declare
  v_kind text; v_subj text[] := '{}'; v_s text; v_bars jsonb := '{}'::jsonb; k text; v jsonb; n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_kind := case when jsonb_typeof(p->'kind') = 'string' then lower(p->>'kind') else '' end;
  if v_kind not in ('generate','continue','verify','student','playbook') then v_kind := 'other'; end if;
  if jsonb_typeof(p->'subjects') = 'array' then
    for v in select e from jsonb_array_elements(p->'subjects') e limit 20 loop
      exit when coalesce(array_length(v_subj, 1), 0) >= 5;
      if jsonb_typeof(v) = 'string' then
        v_s := left(btrim(regexp_replace(regexp_replace(v #>> '{}', '[[:cntrl:]<>]', ' ', 'g'), '\s+', ' ', 'g')), 60);
        if v_s <> '' and not exists (select 1 from unnest(v_subj) x where lower(x) = lower(v_s)) then v_subj := v_subj || v_s; end if;
      end if;
    end loop;
  end if;
  if jsonb_typeof(p->'bars') = 'object' then
    for k, v in select key, value from jsonb_each(p->'bars') limit 50 loop
      exit when n >= 20;
      if k ~ '^[a-z][a-z0-9_]{0,40}$' and jsonb_typeof(v) = 'number' then
        v_bars := v_bars || jsonb_build_object(k, least(greatest(round((v #>> '{}')::numeric), 0), 100)::int);
        n := n + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('kind', v_kind, 'subjects', to_jsonb(v_subj),
    'language', case when p->>'language' in ('English','Spanish','Portuguese','French','German','Italian') then p->>'language' end,
    'age_band', case when p->>'age_band' in ('infant','preschool','early','primary','preteen','teen','olderteen','adult','mixed') then p->>'age_band' end,
    'level', case when p->>'level' in ('Early Childhood','Primary','Secondary','Intermediate','Advanced','University','Adult Education') then p->>'level' end,
    'bars', v_bars);
end $$;
revoke all on function public.ai_meta_clean(jsonb) from public, anon, authenticated;

-- Suma 1 uso del día y, si viene p_meta (lo manda api/generate.js), anota el pedido en ai_events
-- (institución y usuario salen del perfil, nunca del pedido). Si no se pudo anotar, el pedido sigue igual.
-- La versión vieja sin argumentos se reemplaza (llamarla sin nada sigue funcionando: p_meta es opcional).
drop function if exists public.consume_ai_quota();
create or replace function public.consume_ai_quota(p_meta jsonb default null) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare
  v_uid   uuid := auth.uid();
  v_day   date := (now() at time zone 'utc')::date;
  v_limit integer;
  v_used  integer;
  v_inst  uuid;
  v_event bigint;
  m       jsonb;
begin
  if v_uid is null then raise exception 'No autorizado'; end if;
  v_limit := public.ai_daily_limit(v_uid);
  if v_limit <= 0 then -- estudiantes: nunca generan (ni se anota nada en ai_events)
    return json_build_object('allowed', false, 'used', 0, 'limit', 0);
  end if;
  insert into public.ai_usage as a (user_id, day, count) values (v_uid, v_day, 1)
  on conflict (user_id, day) do update set count = a.count + 1 where a.count < v_limit
  returning a.count into v_used;
  if v_used is null then
    select count into v_used from public.ai_usage where user_id = v_uid and day = v_day;
    return json_build_object('allowed', false, 'used', v_used, 'limit', v_limit);
  end if;
  if p_meta is null then
    return json_build_object('allowed', true, 'used', v_used, 'limit', v_limit);
  end if;
  begin
    m := public.ai_meta_clean(p_meta);
    select institution_id into v_inst from public.profiles where id = v_uid;
    insert into public.ai_events (user_id, inst_id, root_id, kind, subjects, language, age_band, level, bars)
    values (v_uid, v_inst, case when v_inst is not null then public.billing_root(v_inst) end, m->>'kind',
            array(select jsonb_array_elements_text(m->'subjects')), m->>'language', m->>'age_band', m->>'level', m->'bars')
    returning id into v_event;
  exception when others then v_event := null;
  end;
  return json_build_object('allowed', true, 'used', v_used, 'limit', v_limit, 'event', v_event);
end $$;
revoke all on function public.consume_ai_quota(jsonb) from public, anon;
grant execute on function public.consume_ai_quota(jsonb) to authenticated;

-- api/generate.js (con el token del usuario) marca cómo terminó su pedido: una sola vez, solo los propios,
-- dentro de los 15 minutos. Devuelve true si lo marcó.
create or replace function public.finish_ai_event(p_event bigint, p_ok boolean) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  update public.ai_events set ok = coalesce(p_ok, false), finished_at = now()
   where id = p_event and user_id = auth.uid() and ok is null and created_at > now() - interval '15 minutes';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.finish_ai_event(bigint, boolean) from public, anon;
grant execute on function public.finish_ai_event(bigint, boolean) to authenticated;

-- Consultar el uso de hoy sin gastar (para mostrar en la app)
create or replace function public.get_ai_quota() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_uid uuid := auth.uid(); v_limit integer;
begin
  if v_uid is null then raise exception 'No autorizado'; end if;
  v_limit := public.ai_daily_limit(v_uid);
  return json_build_object(
    'used', coalesce((select count from public.ai_usage
                       where user_id = v_uid and day = (now() at time zone 'utc')::date), 0),
    'limit', v_limit);
end $$;
revoke all on function public.get_ai_quota() from public, anon;
grant execute on function public.get_ai_quota() to authenticated;

-- Perfiles: profiles.email siempre igual al email real de la cuenta (repara datos viejos)
update public.profiles p set email = lower(trim(u.email))
  from auth.users u
 where u.id = p.id and u.email is not null and p.email is distinct from lower(trim(u.email));

-- Súper admins: se conservan tal cual (este script no promueve ni degrada a nadie).

-- ========== PLAYBOOK / PRINCIPIOS DE LA INSTITUCIÓN ==========
create table if not exists public.institution_documents (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  name text not null,
  kind text not null default 'playbook',
  content text,                 -- texto extraído del documento (solo admins, vía get_document_content)
  summary text,                 -- lo esencial que la IA usa en cada clase
  chars integer default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inst_docs_inst_idx on public.institution_documents (institution_id);
alter table public.institution_documents enable row level security;
drop policy if exists idoc_select on public.institution_documents;
create policy idoc_select on public.institution_documents for select
  using (public.in_my_chain(institution_id) or public.is_admin_of(institution_id));
drop policy if exists idoc_insert on public.institution_documents;
create policy idoc_insert on public.institution_documents for insert
  with check (public.is_admin_of(institution_id));
drop policy if exists idoc_update on public.institution_documents;
create policy idoc_update on public.institution_documents for update
  using (public.is_admin_of(institution_id)) with check (public.is_admin_of(institution_id));
drop policy if exists idoc_delete on public.institution_documents;
create policy idoc_delete on public.institution_documents for delete
  using (public.is_admin_of(institution_id));

-- El texto completo (content) no se puede leer con select: solo vía get_document_content.
-- Se pueden leer todas las demás columnas; insertar/editar/borrar sigue igual (con RLS).
revoke all on public.institution_documents from anon;
revoke select on public.institution_documents from authenticated;
revoke select (content) on public.institution_documents from authenticated;
grant select (id, institution_id, name, kind, summary, chars, uploaded_by, created_at)
  on public.institution_documents to authenticated;
grant insert, update, delete on public.institution_documents to authenticated;

create or replace function public.get_document_content(p_id uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_inst uuid; v_content text;
begin
  select institution_id, content into v_inst, v_content
    from public.institution_documents where id = p_id;
  if v_inst is null or not public.is_admin_of(v_inst) then raise exception 'No autorizado'; end if;
  return v_content;
end $$;
revoke all on function public.get_document_content(uuid) from public, anon;
grant execute on function public.get_document_content(uuid) to authenticated;

-- ========== PLAN Y CONSUMO: seguridad y funciones ==========
-- Nadie escribe estas tablas desde la app. Lectura directa solo del registro de pedidos
-- y de las solicitudes de compra (admins de la cuenta / súper admin); el resto, vía funciones.
alter table public.platform_settings       enable row level security;
alter table public.billing_accounts        enable row level security;
alter table public.token_usage_monthly     enable row level security;
alter table public.ai_request_log          enable row level security;
alter table public.token_purchase_requests enable row level security;
revoke all on public.platform_settings, public.billing_accounts, public.token_usage_monthly,
              public.ai_request_log, public.token_purchase_requests from anon, authenticated;
revoke all on sequence public.ai_request_log_id_seq from anon, authenticated;
grant select on public.ai_request_log to authenticated;
-- decided_by (quién aprobó: el súper admin) no se lee directo; requested_by solo si no es súper admin (vía funciones)
grant select (id, root_id, root_name, pack_tokens, price, currency, status, note, created_at, decided_at)
  on public.token_purchase_requests to authenticated;

-- Registro: el súper admin todo; cada uno sus pedidos; los admins, los de sus unidades (y las de abajo)
drop policy if exists ailog_select on public.ai_request_log;
create policy ailog_select on public.ai_request_log for select
  using (public.is_superadmin() or user_id = auth.uid()
         or (inst_id is not null and scope <> 'unlimited' and public.is_admin_of(inst_id)
             and not public.is_superadmin_id(user_id)));
-- Solicitudes: el súper admin todas; los admins de cualquier unidad de la cuenta, las de su cuenta
drop policy if exists tpr_select on public.token_purchase_requests;
create policy tpr_select on public.token_purchase_requests for select
  using (public.is_superadmin()
         or (root_id is not null and public.my_role() = 'org_admin' and public.in_my_chain(root_id)));

-- ── Funciones del SERVIDOR (solo service_role: api/generate.js con SUPABASE_SERVICE_ROLE_KEY) ──
-- ¿Puede este usuario usar la IA ahora? Devuelve
-- {allowed, scope:'institution'|'personal'|'unlimited', root_id, allowance, used_month, extra_balance,
--  remaining, warn (quedan ≤ 20% de la asignación del mes), is_admin, can_buy, month, resets_on}
create or replace function public.ai_budget_check(p_user uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  p public.profiles%rowtype;
  v_month date := public.billing_month();
  v_root uuid; v_allow bigint; v_used bigint := 0; v_extra bigint := 0; v_rem bigint;
  s public.platform_settings%rowtype;
begin
  if p_user is null then raise exception 'Usuario requerido'; end if;
  select * into p from public.profiles where id = p_user;
  select * into s from public.platform_settings where id;
  if p.role = 'superadmin' then
    return json_build_object('allowed', true, 'scope', 'unlimited', 'root_id', null, 'allowance', null,
      'used_month', null, 'extra_balance', null, 'remaining', null, 'warn', false,
      'is_admin', true, 'can_buy', false, 'month', v_month, 'resets_on', (v_month + interval '1 month')::date);
  end if;
  if p.institution_id is null then
    v_allow := s.personal_monthly_tokens;
    select coalesce(sum(used), 0) into v_used from public.token_usage_monthly
     where scope = 'personal' and account_id = p_user and month = v_month;
  else
    v_root := public.billing_root(p.institution_id);
    select coalesce(a.monthly_tokens, s.default_monthly_tokens), coalesce(a.extra_tokens_balance, 0)
      into v_allow, v_extra
      from (select 1) x left join public.billing_accounts a on a.root_id = v_root;
    select coalesce(sum(used), 0) into v_used from public.token_usage_monthly
     where scope = 'institution' and account_id = v_root and month = v_month;
  end if;
  v_rem := greatest(v_allow - v_used, 0) + v_extra;
  return json_build_object(
    'allowed', v_rem > 0,
    'scope', case when v_root is null then 'personal' else 'institution' end,
    'root_id', v_root, 'allowance', v_allow, 'used_month', v_used, 'extra_balance', v_extra,
    'remaining', v_rem,
    'warn', case when v_allow > 0 then v_rem <= v_allow * 0.2 else v_rem <= 0 end,
    'is_admin', v_root is not null and p.role = 'org_admin',
    'can_buy', v_root is not null and p.role = 'org_admin' and p.institution_id = v_root,
    'month', v_month, 'resets_on', (v_month + interval '1 month')::date);
end $$;
revoke all on function public.ai_budget_check(uuid) from public, anon, authenticated;
grant execute on function public.ai_budget_check(uuid) to service_role;

-- Anota el consumo real de un pedido (tokens que informó Azure): primero la asignación del mes,
-- después el saldo extra. Si el último pedido se pasa de todo, el exceso queda en el mes (el saldo
-- extra nunca baja de 0). Devuelve el mismo json que ai_budget_check, ya actualizado.
create or replace function public.ai_record_usage(p_user uuid, p_prompt integer, p_completion integer, p_kind text default 'generate')
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare
  v_prompt int := least(greatest(coalesce(p_prompt, 0), 0), 2000000);
  v_comp   int := least(greatest(coalesce(p_completion, 0), 0), 2000000);
  v_total  bigint := v_prompt + v_comp;
  v_kind   text := left(coalesce(nullif(regexp_replace(lower(coalesce(p_kind, '')), '[^a-z0-9_-]', '', 'g'), ''), 'generate'), 40);
  v_month  date := public.billing_month();
  p public.profiles%rowtype; a public.billing_accounts%rowtype;
  v_scope text; v_root uuid; v_used bigint; v_take bigint := 0; v_extra bigint := 0;
begin
  if p_user is null then raise exception 'Usuario requerido'; end if;
  select * into p from public.profiles where id = p_user;
  if p.role = 'superadmin' then v_scope := 'unlimited';
  elsif p.institution_id is null then v_scope := 'personal';
  else v_scope := 'institution'; v_root := public.billing_root(p.institution_id);
  end if;

  if v_scope = 'institution' then
    perform public.ensure_billing_account(v_root);
    select * into a from public.billing_accounts where root_id = v_root for update; -- serializa la cuenta
    select coalesce(sum(used), 0) into v_used from public.token_usage_monthly
     where scope = 'institution' and account_id = v_root and month = v_month;
    v_take  := least(v_total, greatest(a.monthly_tokens - v_used, 0));
    v_extra := least(v_total - v_take, a.extra_tokens_balance);
    if v_extra > 0 then
      update public.billing_accounts set extra_tokens_balance = extra_tokens_balance - v_extra, updated_at = now()
       where root_id = v_root;
    end if;
  end if;
  if v_scope <> 'unlimited' then
    insert into public.token_usage_monthly as t (scope, account_id, month, used, extra_used)
    values (v_scope, coalesce(v_root, p_user), v_month, v_total - v_extra, v_extra)
    on conflict (scope, account_id, month) do update
      set used = t.used + excluded.used, extra_used = t.extra_used + excluded.extra_used, updated_at = now();
  end if;
  insert into public.ai_request_log (user_id, root_id, inst_id, scope, prompt_tokens, completion_tokens, total_tokens, from_extra, kind)
  values (p_user, v_root, p.institution_id, v_scope, v_prompt, v_comp, v_total, v_extra, v_kind);
  return public.ai_budget_check(p_user);
end $$;
revoke all on function public.ai_record_usage(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ai_record_usage(uuid, integer, integer, text) to service_role;

-- Para api/billing/status: confirma que la clave del servidor funciona y que este script corrió
create or replace function public.billing_service_ping() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select true $$;
revoke all on function public.billing_service_ping() from public, anon, authenticated;
grant execute on function public.billing_service_ping() to service_role;

-- ── Funciones para la APP (con permisos) ──
-- ¿Quién ve el consumo de una cuenta? El súper admin y los org_admin de cualquier unidad de esa cuenta.
create or replace function public.can_view_billing(p_root uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select p_root is not null and (public.is_superadmin() or (
     public.my_role() = 'org_admin' and public.my_institution() is not null
     and public.billing_root(public.my_institution()) = p_root)) $$;
revoke all on function public.can_view_billing(uuid) from public, anon, authenticated;

-- Asientos de una cuenta: {root_id, seats, used, available, full}
create or replace function public.get_seat_status(p_root uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_root uuid := public.billing_root(coalesce(p_root, public.my_institution())); v_used int; v_seats int;
begin
  if not public.can_view_billing(v_root) then raise exception 'No autorizado'; end if;
  v_used := public.seats_used(v_root); v_seats := public.billing_seats(v_root);
  return json_build_object('root_id', v_root, 'seats', v_seats, 'used', v_used,
                           'available', greatest(v_seats - v_used, 0), 'full', v_used >= v_seats);
end $$;
revoke all on function public.get_seat_status(uuid) from public, anon;
grant execute on function public.get_seat_status(uuid) to authenticated;

-- Resumen de "Plan y consumo" de la cuenta de una unidad (por defecto, la mía).
-- Totales de la cuenta para todos sus admins; el detalle por unidad y por docente, solo de lo que
-- cada admin administra (el admin de una sede no ve a los docentes de otra sede).
create or replace function public.get_billing_summary(p_inst uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_inst  uuid := coalesce(p_inst, public.my_institution());
  v_root  uuid := public.billing_root(v_inst);
  v_month date := public.billing_month();
  s public.platform_settings%rowtype;
  v_seats int; v_allow bigint; v_extra bigint; v_used bigint := 0; v_xused bigint := 0;
  v_scope uuid[];
begin
  if v_inst is null or v_root is null then raise exception 'No autorizado'; end if;
  if not public.can_view_billing(v_root) then raise exception 'No autorizado'; end if;
  select * into s from public.platform_settings where id;
  select coalesce(a.seats, s.default_seats), coalesce(a.monthly_tokens, s.default_monthly_tokens), coalesce(a.extra_tokens_balance, 0)
    into v_seats, v_allow, v_extra
    from (select 1) x left join public.billing_accounts a on a.root_id = v_root;
  select coalesce(sum(used), 0), coalesce(sum(extra_used), 0) into v_used, v_xused
    from public.token_usage_monthly where scope = 'institution' and account_id = v_root and month = v_month;
  -- unidades cuyo detalle puede ver quien pregunta
  select array_agg(i.id) into v_scope from public.institutions i
   where (i.id = v_root or i.id in (select public.institution_descendants(v_root))) and public.is_admin_of(i.id);
  return json_build_object(
    'root_id', v_root,
    'root_name', (select name from public.institutions where id = v_root),
    'month', v_month, 'resets_on', (v_month + interval '1 month')::date,
    'seats', v_seats, 'seats_used', public.seats_used(v_root),
    'monthly_tokens', v_allow, 'used_month', v_used, 'extra_used_month', v_xused,
    'extra_balance', v_extra, 'remaining', greatest(v_allow - v_used, 0) + v_extra,
    'pack_tokens', s.pack_tokens, 'pack_price', s.pack_price, 'currency', s.currency,
    'can_request', public.my_role() = 'org_admin' and public.my_institution() = v_root,
    'full_detail', coalesce(array_length(v_scope, 1), 0) > 0 and v_root = any(v_scope),
    'pending', (select json_build_object('id', r.id, 'pack_tokens', r.pack_tokens, 'price', r.price, 'currency', r.currency, 'created_at', r.created_at)
                  from public.token_purchase_requests r where r.root_id = v_root and r.status = 'pending' limit 1),
    'by_unit', coalesce((select json_agg(x order by x.used desc) from (
        select l.inst_id as id, i.name, sum(l.total_tokens)::bigint as used, count(*)::int as requests
          from public.ai_request_log l join public.institutions i on i.id = l.inst_id
         where l.root_id = v_root and l.created_at >= v_month and l.inst_id = any(v_scope)
         group by l.inst_id, i.name) x), '[]'::json),
    -- el súper admin nunca aparece con nombre/email/id ante otros (masked = true → "Equipo TeroClass")
    'by_teacher', coalesce((select json_agg(x order by x.used desc) from (
        select case when m.masked then null else l.user_id end as user_id,
               case when m.masked then '' else coalesce(nullif(p.name, ''), p.email, '—') end as name,
               case when m.masked then null else p.email end as email, m.masked,
               sum(l.total_tokens)::bigint as used, count(*)::int as requests
          from public.ai_request_log l left join public.profiles p on p.id = l.user_id
          cross join lateral (select coalesce(p.role = 'superadmin', false) and not public.is_superadmin() as masked) m
         where l.root_id = v_root and l.created_at >= v_month and l.inst_id = any(v_scope)
         group by 1, 2, 3, 4
         order by sum(l.total_tokens) desc limit 10) x), '[]'::json),
    'requests', coalesce((select json_agg(x order by x.created_at desc) from (
        select r.id, r.pack_tokens, r.price, r.currency, r.status, r.note, r.created_at, r.decided_at,
               case when m.masked then '' else coalesce(nullif(p.name, ''), p.email, '') end as requested_by_name, m.masked
          from public.token_purchase_requests r left join public.profiles p on p.id = r.requested_by
          cross join lateral (select coalesce(p.role = 'superadmin', false) and not public.is_superadmin() as masked) m
         where r.root_id = v_root order by r.created_at desc limit 20) x), '[]'::json));
end $$;
revoke all on function public.get_billing_summary(uuid) from public, anon;
grant execute on function public.get_billing_summary(uuid) to authenticated;

-- Pedir un paquete de tokens (queda pendiente hasta que el súper admin confirme el pago).
-- Solo los admins de la institución madre. Una solicitud pendiente a la vez.
create or replace function public.request_token_pack() returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_root uuid := public.my_institution(); s public.platform_settings%rowtype; r public.token_purchase_requests%rowtype;
begin
  if public.my_role() is distinct from 'org_admin' or v_root is null
     or exists (select 1 from public.institutions where id = v_root and parent_id is not null) then
    raise exception 'No autorizado: solo los admins de la institución madre pueden comprar tokens';
  end if;
  perform 1 from public.institutions where id = v_root for update; -- una solicitud a la vez
  if exists (select 1 from public.token_purchase_requests where root_id = v_root and status = 'pending') then
    raise exception 'Ya hay una solicitud de compra pendiente para esta institución';
  end if;
  select * into s from public.platform_settings where id;
  insert into public.token_purchase_requests (root_id, root_name, requested_by, pack_tokens, price, currency)
  values (v_root, (select name from public.institutions where id = v_root), auth.uid(), s.pack_tokens, s.pack_price, s.currency)
  returning * into r;
  return json_build_object('id', r.id, 'pack_tokens', r.pack_tokens, 'price', r.price, 'currency', r.currency, 'status', r.status, 'created_at', r.created_at);
end $$;
revoke all on function public.request_token_pack() from public, anon;
grant execute on function public.request_token_pack() to authenticated;

-- Solicitudes de compra: súper admin todas (o por estado); admins, las de su cuenta.
create or replace function public.list_purchase_requests(p_status text default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_root uuid;
begin
  if p_status is not null and p_status not in ('pending','approved','rejected') then raise exception 'Estado inválido'; end if;
  if not public.is_superadmin() then
    if public.my_role() is distinct from 'org_admin' or public.my_institution() is null then raise exception 'No autorizado'; end if;
    v_root := public.billing_root(public.my_institution());
  end if;
  return coalesce((select json_agg(x order by (x.status = 'pending') desc, x.created_at desc) from (
    select r.id, r.root_id, coalesce(i.name, r.root_name) as root_name, i.slug as root_slug, r.pack_tokens, r.price, r.currency,
           r.status, r.note, r.created_at, r.decided_at,
           case when m.masked then '' else coalesce(nullif(p.name, ''), p.email, '') end as requested_by_name,
           case when m.masked then null else p.email end as requested_by_email, m.masked
      from public.token_purchase_requests r
      left join public.institutions i on i.id = r.root_id
      left join public.profiles p on p.id = r.requested_by
      cross join lateral (select coalesce(p.role = 'superadmin', false) and not public.is_superadmin() as masked) m
     where (v_root is null or r.root_id = v_root) and (p_status is null or r.status = p_status)
     order by (r.status = 'pending') desc, r.created_at desc limit 200) x), '[]'::json);
end $$;
revoke all on function public.list_purchase_requests(text) from public, anon;
grant execute on function public.list_purchase_requests(text) to authenticated;

-- Súper admin: aprobar (suma el paquete al saldo extra de la cuenta, una sola vez) o rechazar.
create or replace function public.decide_purchase_request(p_id uuid, p_approve boolean, p_note text default '') returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare r public.token_purchase_requests%rowtype; v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if p_approve is null then raise exception 'Decisión requerida'; end if;
  select * into r from public.token_purchase_requests where id = p_id for update;
  if r.id is null then raise exception 'Solicitud no encontrada'; end if;
  if r.status <> 'pending' then raise exception 'Esta solicitud ya fue resuelta'; end if;
  if p_approve then
    if r.root_id is null then raise exception 'La institución de esta solicitud ya no existe'; end if;
    perform public.ensure_billing_account(r.root_id);
    update public.billing_accounts set extra_tokens_balance = extra_tokens_balance + r.pack_tokens, updated_at = now()
     where root_id = r.root_id;
  end if;
  update public.token_purchase_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         note = v_note, decided_by = auth.uid(), decided_at = now()
   where id = p_id;
  return case when p_approve then 'approved' else 'rejected' end;
end $$;
revoke all on function public.decide_purchase_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_purchase_request(uuid, boolean, text) to authenticated;

-- Súper admin: asientos y tokens por mes de una institución madre
create or replace function public.set_institution_plan(p_root uuid, p_seats integer, p_monthly_tokens bigint) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if not exists (select 1 from public.institutions where id = p_root and parent_id is null) then
    raise exception 'El plan se define en la institución madre';
  end if;
  if p_seats is null or p_seats < 0 or p_seats > 1000000 then raise exception 'Cantidad de asientos inválida'; end if;
  if p_monthly_tokens is null or p_monthly_tokens < 0 or p_monthly_tokens > 100000000000 then raise exception 'Cantidad de tokens inválida'; end if;
  perform public.ensure_billing_account(p_root);
  update public.billing_accounts set seats = p_seats, monthly_tokens = p_monthly_tokens, updated_at = now() where root_id = p_root;
  return json_build_object('root_id', p_root, 'seats', p_seats, 'monthly_tokens', p_monthly_tokens);
end $$;
revoke all on function public.set_institution_plan(uuid, integer, bigint) from public, anon;
grant execute on function public.set_institution_plan(uuid, integer, bigint) to authenticated;

-- Súper admin: ajustes de la plataforma (paquete, precio, moneda, asignación personal, valores por defecto)
create or replace function public.update_platform_settings(p_pack_tokens bigint, p_pack_price numeric, p_currency text,
  p_personal_monthly_tokens bigint, p_default_seats integer, p_default_monthly_tokens bigint) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_cur text := upper(trim(coalesce(p_currency, '')));
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if p_pack_tokens is null or p_pack_tokens < 1000 or p_pack_tokens > 1000000000 then raise exception 'Tamaño de paquete inválido (de 1.000 a 1.000.000.000 tokens)'; end if;
  if p_pack_price is null or p_pack_price < 0 or p_pack_price > 1000000 then raise exception 'Precio inválido'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'Moneda inválida (código de 3 letras, ej. USD)'; end if;
  if p_personal_monthly_tokens is null or p_personal_monthly_tokens < 0 or p_personal_monthly_tokens > 100000000000
     or p_default_monthly_tokens is null or p_default_monthly_tokens < 0 or p_default_monthly_tokens > 100000000000 then
    raise exception 'Cantidad de tokens inválida';
  end if;
  if p_default_seats is null or p_default_seats < 0 or p_default_seats > 1000000 then raise exception 'Cantidad de asientos inválida'; end if;
  update public.platform_settings
     set pack_tokens = p_pack_tokens, pack_price = round(p_pack_price, 2), currency = v_cur,
         personal_monthly_tokens = p_personal_monthly_tokens, default_seats = p_default_seats,
         default_monthly_tokens = p_default_monthly_tokens, updated_by = auth.uid(), updated_at = now()
   where id;
  return (select row_to_json(x) from (select pack_tokens, pack_price, currency, personal_monthly_tokens, default_seats, default_monthly_tokens
                                        from public.platform_settings where id) x);
end $$;
revoke all on function public.update_platform_settings(bigint, numeric, text, bigint, integer, bigint) from public, anon;
grant execute on function public.update_platform_settings(bigint, numeric, text, bigint, integer, bigint) to authenticated;

-- Súper admin: ajustes + plan y consumo del mes de cada institución madre + consumo personal
create or replace function public.platform_billing_overview() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_month date := public.billing_month(); s public.platform_settings%rowtype;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  select * into s from public.platform_settings where id;
  return json_build_object(
    'month', v_month,
    'settings', json_build_object('pack_tokens', s.pack_tokens, 'pack_price', s.pack_price, 'currency', s.currency,
      'personal_monthly_tokens', s.personal_monthly_tokens, 'default_seats', s.default_seats, 'default_monthly_tokens', s.default_monthly_tokens,
      'ai_price_input', s.ai_price_input, 'ai_price_output', s.ai_price_output),
    'accounts', coalesce((select json_agg(x order by x.name) from (
      select i.id, i.name, i.slug,
             coalesce(a.seats, s.default_seats) as seats, public.seats_used(i.id) as seats_used,
             coalesce(a.monthly_tokens, s.default_monthly_tokens) as monthly_tokens,
             coalesce(a.extra_tokens_balance, 0) as extra_balance,
             coalesce(u.used, 0) as used_month, coalesce(u.extra_used, 0) as extra_used_month,
             exists (select 1 from public.token_purchase_requests r where r.root_id = i.id and r.status = 'pending') as pending
        from public.institutions i
        left join public.billing_accounts a on a.root_id = i.id
        left join public.token_usage_monthly u on u.scope = 'institution' and u.account_id = i.id and u.month = v_month
       where i.parent_id is null) x), '[]'::json),
    'personal', (select json_build_object('users', count(*), 'used_month', coalesce(sum(used), 0))
                   from public.token_usage_monthly where scope = 'personal' and month = v_month),
    'pending_requests', (select count(*) from public.token_purchase_requests where status = 'pending'));
end $$;
revoke all on function public.platform_billing_overview() from public, anon;
grant execute on function public.platform_billing_overview() to authenticated;

-- ========== MÉTRICAS DE LA PLATAFORMA (solo súper admin; antes "Insights": la función conserva el nombre platform_insights) ==========
-- ai_events: sin acceso directo para nadie (lo escriben consume_ai_quota / finish_ai_event).
alter table public.ai_events enable row level security;
revoke all on public.ai_events from anon, authenticated;
revoke all on sequence public.ai_events_id_seq from anon, authenticated;

-- Súper admin: precio de la IA por millón de tokens (USD) para el costo estimado
create or replace function public.update_ai_prices(p_input numeric, p_output numeric) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if p_input is null or p_input < 0 or p_input > 1000 or p_output is null or p_output < 0 or p_output > 1000 then
    raise exception 'Precio de IA inválido (de 0 a 1000 USD por millón de tokens)';
  end if;
  update public.platform_settings
     set ai_price_input = round(p_input, 4), ai_price_output = round(p_output, 4), updated_by = auth.uid(), updated_at = now()
   where id;
  return (select json_build_object('ai_price_input', ai_price_input, 'ai_price_output', ai_price_output)
            from public.platform_settings where id);
end $$;
revoke all on function public.update_ai_prices(numeric, numeric) from public, anon;
grant execute on function public.update_ai_prices(numeric, numeric) to authenticated;

-- Súper admin: uso del producto en los últimos p_days días (UTC), de toda la plataforma o de una unidad
-- y todo lo que cuelga de ella. p_exclude_self: sin la actividad de quien consulta. Un solo JSON:
--   usage   {per_day[{day,classes}], classes, saved, handouts, requests, failed, active{d1,d7,d30},
--            active_period, new_users, returning_users (activos en 2+ semanas distintas), top_institutions[]}
--   content {classes, subjects[], languages[], age_bands[], levels[], bars[{key,avg,count}],
--            playbook_institutions, institutions}
--   costs   {recorded_ever, requests, prompt_tokens, completion_tokens, total_tokens, classes,
--            price_input, price_output, usd, by_institution[]}   (tokens: solo con la clave del servidor)
-- Sin nombres ni emails de personas: solo totales.
create or replace function public.platform_insights(p_days integer, p_unit uuid default null, p_exclude_self boolean default true)
returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_days  integer := least(greatest(coalesce(p_days, 30), 1), 366);
  v_today date := (now() at time zone 'utc')::date;
  v_from  date;
  v_since timestamptz;
  v_me    uuid := auth.uid();
  v_excl  boolean := coalesce(p_exclude_self, true);
  v_units uuid[];
  v_pin   numeric; v_pout numeric;
  r json;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  v_from := v_today - (v_days - 1);
  v_since := v_from::timestamp at time zone 'utc';
  if p_unit is not null then
    if not exists (select 1 from public.institutions where id = p_unit) then raise exception 'Unidad no encontrada'; end if;
    v_units := array(select p_unit union all select public.institution_descendants(p_unit));
  end if;
  select ai_price_input, ai_price_output into v_pin, v_pout from public.platform_settings where id;
  v_pin := coalesce(v_pin, 2.50); v_pout := coalesce(v_pout, 10.00);

  with
  ev as (   -- pedidos a la IA del período, en el alcance
    select e.* from public.ai_events e
     where e.created_at >= v_since
       and (v_units is null or e.inst_id = any(v_units))
       and (not v_excl or e.user_id is distinct from v_me)),
  gen as (select * from ev where ev.kind = 'generate' and ev.ok),
  pl as (   -- clases guardadas en el período
    select p.* from public.plannings p
     where p.created_at >= v_since
       and (v_units is null or p.institution_id = any(v_units))
       and (not v_excl or p.owner_id is distinct from v_me)),
  act as (  -- actividad (generó o guardó una clase) de los últimos 30 días
    select e.user_id as uid, e.created_at as ts from public.ai_events e
     where e.created_at > now() - interval '30 days' and e.user_id is not null
       and (v_units is null or e.inst_id = any(v_units)) and (not v_excl or e.user_id is distinct from v_me)
    union all
    select p.owner_id, p.updated_at from public.plannings p
     where p.updated_at > now() - interval '30 days'
       and (v_units is null or p.institution_id = any(v_units)) and (not v_excl or p.owner_id is distinct from v_me)),
  actp as ( -- actividad del período
    select ev.user_id as uid, ev.created_at as ts from ev where ev.user_id is not null
    union all select pl.owner_id, pl.created_at from pl
    union all
    select p.owner_id, p.updated_at from public.plannings p
     where p.updated_at >= v_since
       and (v_units is null or p.institution_id = any(v_units)) and (not v_excl or p.owner_id is distinct from v_me)),
  lg as (   -- tokens registrados por el servidor (solo con SUPABASE_SERVICE_ROLE_KEY)
    select l.* from public.ai_request_log l
     where l.created_at >= v_since
       and (v_units is null or l.inst_id = any(v_units))
       and (not v_excl or l.user_id is distinct from v_me)),
  subj as (select lower(su) as k, min(su) as label, count(*) as n from gen, unnest(gen.subjects) su group by lower(su)),
  barq as (select b.key, round(avg((b.value #>> '{}')::numeric), 1) as avg, count(*) as n
             from gen, jsonb_each(gen.bars) b where jsonb_typeof(b.value) = 'number' group by b.key)
  select json_build_object(
    'days', v_days, 'from', v_from, 'to', v_today, 'exclude_self', v_excl,
    'unit', (select json_build_object('id', i.id, 'name', i.name) from public.institutions i where i.id = p_unit),
    'tracking_since', (select min(e.created_at) from public.ai_events e),
    'usage', json_build_object(
      'per_day', (select coalesce(json_agg(json_build_object('day', d.day, 'classes', coalesce(c.n, 0)) order by d.day), '[]'::json)
                    from (select v_from + g as day from generate_series(0, v_days - 1) g) d
                    left join (select (gen.created_at at time zone 'utc')::date as day, count(*) as n from gen group by 1) c on c.day = d.day),
      'classes', (select count(*) from gen),
      'saved', (select count(*) from pl),
      'handouts', (select count(*) from ev where ev.kind = 'student' and ev.ok),
      'requests', (select count(*) from ev),
      'failed', (select count(*) from ev where ev.ok = false),
      'active', json_build_object(
        'd1', (select count(distinct uid) from act where ts > now() - interval '1 day'),
        'd7', (select count(distinct uid) from act where ts > now() - interval '7 days'),
        'd30', (select count(distinct uid) from act)),
      'active_period', (select count(distinct uid) from actp),
      'new_users', (select count(*) from public.profiles p
                     where p.created_at >= v_since
                       and (v_units is null or p.institution_id = any(v_units))
                       and (not v_excl or p.id is distinct from v_me)),
      'returning_users', (select count(*) from (select uid from actp group by uid
                            having count(distinct date_trunc('week', ts at time zone 'utc')) >= 2) x),
      'top_institutions', (select coalesce(json_agg(json_build_object('id', t.id, 'name', coalesce(i.name, ''), 'classes', t.n)
                                                   order by t.n desc, i.name), '[]'::json)
                             from (select case when v_units is null then gen.root_id else gen.inst_id end as id, count(*) as n
                                     from gen group by 1 order by 2 desc limit 10) t
                             left join public.institutions i on i.id = t.id)),
    'content', json_build_object(
      'classes', (select count(*) from gen),
      'subjects', (select coalesce(json_agg(json_build_object('name', x.label, 'count', x.n) order by x.n desc, x.label), '[]'::json)
                     from (select * from subj order by n desc, label limit 10) x),
      'languages', (select coalesce(json_agg(json_build_object('name', x.language, 'count', x.n) order by x.n desc, x.language), '[]'::json)
                      from (select gen.language, count(*) as n from gen where gen.language is not null group by 1) x),
      'age_bands', (select coalesce(json_agg(json_build_object('name', x.age_band, 'count', x.n) order by x.n desc, x.age_band), '[]'::json)
                      from (select gen.age_band, count(*) as n from gen where gen.age_band is not null group by 1) x),
      'levels', (select coalesce(json_agg(json_build_object('name', x.level, 'count', x.n) order by x.n desc, x.level), '[]'::json)
                   from (select gen.level, count(*) as n from gen where gen.level is not null group by 1) x),
      'bars', (select coalesce(json_agg(json_build_object('key', barq.key, 'avg', barq.avg, 'count', barq.n) order by barq.key), '[]'::json) from barq),
      'playbook_institutions', (select count(distinct d.institution_id) from public.institution_documents d
                                 where v_units is null or d.institution_id = any(v_units)),
      'institutions', (select count(*) from public.institutions i where v_units is null or i.id = any(v_units))),
    -- Estudiantes: solo totales (nunca emails ni nombres). total = emails distintos cargados; linked = ya
    -- entraron con su link; active = tuvieron al menos una clase (no cancelada) en el período.
    'students', (select json_build_object(
        'total', count(distinct lower(e.email)),
        'linked', count(distinct e.user_id),
        'active', count(distinct lower(e.email)) filter (where exists (
            select 1 from public.class_sessions s
             where s.status = 'scheduled' and s.starts_at >= v_since and s.starts_at <= now()
               and (exists (select 1 from public.group_members m where m.group_id = s.group_id and m.enrollment_id = e.id)
                    or exists (select 1 from public.session_invitees si where si.session_id = s.id and si.enrollment_id = e.id)))),
        'groups', (select count(*) from public.class_groups g where v_units is null or g.institution_id = any(v_units)),
        'sessions', (select count(*) from public.class_sessions s where s.status = 'scheduled' and s.starts_at >= v_since
                       and s.starts_at <= now() and (v_units is null or s.institution_id = any(v_units))),
        -- clases con insights (informe del docente) en el período: solo el total
        'insight_sessions', (select count(*) from public.teacher_insights ti join public.class_sessions s on s.id = ti.session_id
                              where s.starts_at >= v_since and (v_units is null or s.institution_id = any(v_units))),
        -- asistencia total del período (presentes + tarde / esperados en clases terminadas): solo la tasa, sin nombres
        'attendance', public.tc_attendance_rate(v_since, v_units))
      from public.student_enrollments e where v_units is null or e.institution_id = any(v_units)),
    'costs', (select json_build_object(
        'recorded_ever', exists (select 1 from public.ai_request_log),
        'requests', count(*),
        'prompt_tokens', coalesce(sum(lg.prompt_tokens), 0),
        'completion_tokens', coalesce(sum(lg.completion_tokens), 0),
        'total_tokens', coalesce(sum(lg.total_tokens), 0),
        'classes', count(*) filter (where lg.kind = 'generate'),
        'price_input', v_pin, 'price_output', v_pout,
        'usd', round(coalesce(sum(lg.prompt_tokens), 0) / 1e6 * v_pin + coalesce(sum(lg.completion_tokens), 0) / 1e6 * v_pout, 4),
        'by_institution', (select coalesce(json_agg(json_build_object('id', t.id, 'name', coalesce(i.name, ''), 'tokens', t.tokens,
                                     'classes', t.classes, 'usd', t.usd) order by t.tokens desc, i.name), '[]'::json)
                             from (select case when v_units is null then lg.root_id else lg.inst_id end as id,
                                          sum(lg.total_tokens) as tokens, count(*) filter (where lg.kind = 'generate') as classes,
                                          round(sum(lg.prompt_tokens) / 1e6 * v_pin + sum(lg.completion_tokens) / 1e6 * v_pout, 4) as usd
                                     from lg group by 1 order by 2 desc limit 15) t
                             left join public.institutions i on i.id = t.id))
      from lg)
  ) into r;
  return r;
end $$;
revoke all on function public.platform_insights(integer, uuid, boolean) from public, anon;
grant execute on function public.platform_insights(integer, uuid, boolean) to authenticated;

-- ========== GRUPOS, ESTUDIANTES Y CALENDARIO ==========
-- Institución › sede › cátedra › GRUPO (ej. "English B1 – Tue/Thu"). Un grupo pertenece a una unidad, tiene
-- UN docente y opcionalmente UN suplente (mismo acceso a las clases del grupo) y muchos estudiantes.
--
-- PRIVACIDAD (todo se lee y escribe SOLO con las funciones de abajo; las tablas no tienen acceso directo):
--   · Cada institución ve únicamente los emails y nombres que cargó ella misma: la inscripción
--     (student_enrollments) es de la unidad que la cargó, con el email tal como se cargó. La ven los admins
--     de esa unidad (y de sus superiores). Si dos instituciones cargan a la misma persona hay dos
--     inscripciones y ninguna ve la otra.
--   · Un docente ve nombre y email de los estudiantes de los grupos donde es docente o suplente (y de los
--     invitados a sus clases sueltas); nada más.
--   · Un estudiante ve sus grupos, sus clases, el nombre del docente y sus propios datos. Nunca los emails
--     de sus compañeros (solo cuántos son).
--   · Los estudiantes no tienen unidad (profiles.institution_id null) ni ocupan asientos.
--   · Nada de esto se anota en ai_events; Métricas (platform_insights) solo recibe totales.
-- MENORES: muchos estudiantes son menores. El consentimiento de grabación (uno solo, por persona) está al final de
--   este archivo ("CONSENTIMIENTO DE GRABACIÓN"): para un menor exige nombre, email y confirmación del tutor/a.
--   institutions.consent_managed_by_institution queda reservado (instituciones que lo gestionan por su cuenta; sin uso).
alter table public.institutions add column if not exists consent_managed_by_institution boolean not null default false;

-- ── ayudas de formato (uso interno) ──
create or replace function public.tc_email_ok(p text) returns boolean
language sql immutable set search_path = public, pg_temp as
$$ select p is not null and length(p) <= 254 and p ~ '^[^@[:space:]<>"'',;()]+@[^@[:space:]<>"'',;()]+\.[A-Za-z]{2,24}$' $$;
create or replace function public.tc_tz_ok(p text) returns boolean
language sql stable set search_path = public, pg_temp as
$$ select p is not null and length(p) between 1 and 64 and exists (select 1 from pg_timezone_names where name = p) $$;
create or replace function public.tc_clean_text(p text, n integer) returns text
language sql immutable set search_path = public, pg_temp as
$$ select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]<>]', ' ', 'g'), '\s+', ' ', 'g')), n) $$;
-- fecha + hora local de una zona → instante (timestamptz). Respeta cambios de horario.
create or replace function public.tc_local_ts(d date, t time, tz text) returns timestamptz
language sql stable set search_path = public, pg_temp as $$ select (d + t) at time zone tz $$;
-- días de una serie: 1 = lunes … 7 = domingo (ISO)
create or replace function public.tc_series_dates(p_days integer[], p_from date, p_to date) returns setof date
language sql immutable set search_path = public, pg_temp as
$$ select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
    where extract(isodow from g)::int = any(p_days) $$;
create or replace function public.tc_weekdays(p integer[]) returns integer[]
language plpgsql immutable set search_path = public, pg_temp as
$$
declare v integer[];
begin
  if p is null or coalesce(array_length(p, 1), 0) = 0 then raise exception 'Elegí al menos un día de la semana'; end if;
  if exists (select 1 from unnest(p) x where x is null or x < 1 or x > 7) then raise exception 'Días de la semana inválidos'; end if;
  select array_agg(distinct x order by x) into v from unnest(p) x;
  return v;
end $$;
create or replace function public.tc_check_duration(p integer) returns void
language plpgsql immutable set search_path = public, pg_temp as
$$ begin if p is null or p < 5 or p > 720 then raise exception 'Duración inválida (de 5 a 720 minutos)'; end if; end $$;
-- token del feed de calendario: 64 caracteres hex (dos UUID v4 aleatorios, ~244 bits)
create or replace function public.tc_new_token() returns text
language sql volatile set search_path = public, pg_temp as
$$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

-- ── tablas ──
create table if not exists public.class_groups (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  teacher_id uuid references auth.users(id) on delete set null,      -- UN docente
  substitute_id uuid references auth.users(id) on delete set null,   -- UN suplente (opcional)
  timezone text not null default 'America/Montevideo',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_groups_sub_differs check (substitute_id is null or substitute_id is distinct from teacher_id)
);
create unique index if not exists class_groups_unit_name on public.class_groups (institution_id, lower(btrim(name)));
create index if not exists class_groups_teacher_idx on public.class_groups (teacher_id);
create index if not exists class_groups_sub_idx on public.class_groups (substitute_id);

-- Inscripción = "esta unidad cargó este email". El email queda tal como se cargó (sin espacios al costado).
create table if not exists public.student_enrollments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  email text not null check (public.tc_email_ok(email)),
  name text not null default '',
  user_id uuid references auth.users(id) on delete set null,   -- se completa con claim_enrollments()
  loaded_by uuid references auth.users(id) on delete set null, -- quién lo cargó (admin, o docente en una clase suelta)
  source text not null default 'manual' check (source in ('manual','csv','session')),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists student_enrollments_unit_email on public.student_enrollments (institution_id, lower(email));
create index if not exists student_enrollments_email_idx on public.student_enrollments (lower(email));
create index if not exists student_enrollments_user_idx on public.student_enrollments (user_id);

create table if not exists public.group_members (
  group_id uuid not null references public.class_groups(id) on delete cascade,
  enrollment_id uuid not null references public.student_enrollments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, enrollment_id)
);
create index if not exists group_members_enr_idx on public.group_members (enrollment_id);

-- Serie semanal (las clases se materializan como filas en class_sessions, máximo 1 año)
create table if not exists public.session_series (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.class_groups(id) on delete cascade,
  title text not null default '',
  weekdays integer[] not null,
  start_time time not null,
  duration_min integer not null check (duration_min between 5 and 720),
  start_date date not null,
  end_date date not null,
  timezone text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_series_dates check (end_date >= start_date and end_date <= start_date + 366)
);

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  group_id uuid references public.class_groups(id) on delete cascade,      -- null = clase suelta
  series_id uuid references public.session_series(id) on delete set null,
  teacher_id uuid references auth.users(id) on delete set null,            -- quién la creó (suelta: su docente)
  title text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/Montevideo',
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  modified boolean not null default false,  -- editada sola: editar la serie no la pisa
  seq integer not null default 0,           -- SEQUENCE del .ics (sube en cada cambio)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_sessions_time check (ends_at > starts_at and ends_at <= starts_at + interval '12 hours')
);
create index if not exists class_sessions_group_idx on public.class_sessions (group_id, starts_at);
create index if not exists class_sessions_series_idx on public.class_sessions (series_id);
create index if not exists class_sessions_teacher_idx on public.class_sessions (teacher_id, starts_at);
create index if not exists class_sessions_inst_idx on public.class_sessions (institution_id, starts_at);
-- P-06 (2026-10): la clase planificada (una planificación guardada del docente) que se da en esta clase del calendario
alter table public.class_sessions add column if not exists planning_id uuid references public.plannings(id) on delete set null;
create index if not exists class_sessions_planning_idx on public.class_sessions (planning_id) where planning_id is not null;

-- Invitados por email a una clase (clases sueltas o extra en un grupo)
create table if not exists public.session_invitees (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  enrollment_id uuid not null references public.student_enrollments(id) on delete cascade,
  primary key (session_id, enrollment_id)
);
create index if not exists session_invitees_enr_idx on public.session_invitees (enrollment_id);

-- Feed de calendario personal (Google Calendar, Outlook, Apple): token aleatorio, se puede regenerar
create table if not exists public.calendar_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

-- Docente / suplente PENDIENTE: email de alguien todavía no registrado (invitado). Se asigna solo apenas se
-- registra o acepta la invitación (trigger profiles_claim_pending_groups). Solo lo ven los admins de la unidad.
alter table public.class_groups add column if not exists pending_teacher_email text;
alter table public.class_groups add column if not exists pending_substitute_email text;
alter table public.class_groups drop constraint if exists class_groups_pending_ok;
alter table public.class_groups add constraint class_groups_pending_ok check (
  (pending_teacher_email is null or (length(pending_teacher_email) <= 254 and teacher_id is null))
  and (pending_substitute_email is null or (length(pending_substitute_email) <= 254 and substitute_id is null))
  and (pending_teacher_email is null or pending_teacher_email is distinct from pending_substitute_email));
-- Origen de la serie: 'csv' = la creó / actualiza la importación (volver a importar la reconoce y no duplica)
alter table public.session_series add column if not exists origin text not null default 'manual';
alter table public.session_series drop constraint if exists session_series_origin_check;
alter table public.session_series add constraint session_series_origin_check check (origin in ('manual','csv'));
create index if not exists session_series_group_idx on public.session_series (group_id, origin, created_at);

-- Sin acceso directo para nadie desde la app: todo pasa por las funciones de abajo.
alter table public.class_groups        enable row level security;
alter table public.student_enrollments enable row level security;
alter table public.group_members       enable row level security;
alter table public.session_series      enable row level security;
alter table public.class_sessions      enable row level security;
alter table public.session_invitees    enable row level security;
alter table public.calendar_tokens     enable row level security;
revoke all on public.class_groups, public.student_enrollments, public.group_members, public.session_series,
              public.class_sessions, public.session_invitees, public.calendar_tokens from anon, authenticated;

drop trigger if exists class_groups_touch on public.class_groups;
create trigger class_groups_touch before update on public.class_groups for each row execute function public.touch_updated_at();
drop trigger if exists session_series_touch on public.session_series;
create trigger session_series_touch before update on public.session_series for each row execute function public.touch_updated_at();
drop trigger if exists class_sessions_touch on public.class_sessions;
create trigger class_sessions_touch before update on public.class_sessions for each row execute function public.touch_updated_at();
drop trigger if exists enrollments_hide_owner on public.student_enrollments;
create trigger enrollments_hide_owner before insert or update of loaded_by on public.student_enrollments
  for each row execute function public.hide_superadmin_refs('loaded_by');

-- ── permisos (uso interno y de las políticas) ──
-- ¿Doy clase en este grupo? (docente o suplente)
create or replace function public.teaches_group(p_group uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select auth.uid() is not null and exists (
     select 1 from public.class_groups g where g.id = p_group and auth.uid() in (g.teacher_id, g.substitute_id)) $$;
-- ¿Puedo editar esta clase? Grupo: su docente o suplente actual. Suelta: quien la creó.
create or replace function public.teaches_session(p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select auth.uid() is not null and exists (
     select 1 from public.class_sessions s left join public.class_groups g on g.id = s.group_id
      where s.id = p_session
        and ((s.group_id is not null and auth.uid() in (g.teacher_id, g.substitute_id))
             or (s.group_id is null and s.teacher_id = auth.uid()
                 and public.billing_root(public.my_institution()) = public.billing_root(s.institution_id)))) $$;
-- ¿Este usuario asiste a esta clase como estudiante? (miembro del grupo o invitado)
create or replace function public.tc_attends(p_session uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select p_user is not null and exists (
     select 1 from public.student_enrollments e
      where e.user_id = p_user
        and (exists (select 1 from public.group_members m join public.class_sessions s on s.group_id = m.group_id
                      where s.id = p_session and m.enrollment_id = e.id)
             or exists (select 1 from public.session_invitees i where i.session_id = p_session and i.enrollment_id = e.id))) $$;
-- Nombre visible de una persona (nunca su email). El súper admin aparece como "TeroClass team" ante los demás.
create or replace function public.tc_person_name(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select case when p_user is null then ''
               when public.is_superadmin_id(p_user) and not public.is_superadmin() then 'TeroClass team'
               else coalesce((select nullif(btrim(p.name), '') from public.profiles p where p.id = p_user), '') end $$;
-- Docente/suplente para las pantallas de admin: {id,name,email}; email solo si quien pregunta administra a esa persona
create or replace function public.tc_person_json(p_user uuid) returns json
language sql stable security definer set search_path = public, pg_temp as
$$ select case when p_user is null then null
               when public.is_superadmin_id(p_user) and not public.is_superadmin() then
                 json_build_object('id', null, 'name', 'TeroClass team', 'email', null, 'masked', true)
               else (select json_build_object('id', p.id, 'name', coalesce(p.name, ''),
                              'email', case when public.is_superadmin() or (p.institution_id is not null and public.is_admin_of(p.institution_id)) then p.email end,
                              'masked', false)
                       from public.profiles p where p.id = p_user) end $$;
-- Docente válido para un grupo de esta unidad: teacher u org_admin de la misma cuenta, que quien asigna administra
create or replace function public.tc_assert_teacher(p_unit uuid, p_user uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare p public.profiles%rowtype;
begin
  if p_user is null then return; end if;
  select * into p from public.profiles where id = p_user;
  if p.id is null or p.role not in ('teacher','org_admin') or p.institution_id is null
     or not public.is_admin_of(p.institution_id)
     or public.billing_root(p.institution_id) is distinct from public.billing_root(p_unit) then
    raise exception 'Docente no válido para este grupo';
  end if;
end $$;
-- Crea (o encuentra) la inscripción de un email en una unidad. Nombre: se actualiza si viene uno.
create or replace function public.tc_ensure_enrollment(p_unit uuid, p_email text, p_name text, p_source text) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_email text := btrim(coalesce(p_email, '')); v_name text := public.tc_clean_text(p_name, 120); v_id uuid;
begin
  if not public.tc_email_ok(v_email) then raise exception 'Email inválido: %', left(v_email, 80); end if;
  select id into v_id from public.student_enrollments where institution_id = p_unit and lower(email) = lower(v_email);
  if v_id is null then
    insert into public.student_enrollments (institution_id, email, name, loaded_by, source)
    values (p_unit, v_email, v_name, auth.uid(), coalesce(p_source, 'manual'))
    on conflict (institution_id, lower(email)) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.student_enrollments where institution_id = p_unit and lower(email) = lower(v_email);
    end if;
  elsif v_name <> '' then
    update public.student_enrollments set name = v_name where id = v_id and name is distinct from v_name;
  end if;
  return v_id;
end $$;
-- La sesión actual viene de un link o código enviado por email (prueba que la persona controla ese email).
-- Supabase lo informa en el claim "amr" del JWT.
create or replace function public.tc_session_via_email() returns boolean
language plpgsql stable set search_path = public, pg_temp as
$$
declare j jsonb;
begin
  begin j := auth.jwt(); exception when others then return false; end;
  if j is null or jsonb_typeof(j->'amr') is distinct from 'array' then return false; end if;
  return exists (select 1 from jsonb_array_elements(j->'amr') e
                  where (case when jsonb_typeof(e) = 'object' then e->>'method' else e #>> '{}' end)
                        in ('otp','magiclink','email/signup','invite','recovery','email_change'));
end $$;

revoke all on function public.tc_email_ok(text) from public, anon, authenticated;
revoke all on function public.tc_tz_ok(text) from public, anon, authenticated;
revoke all on function public.tc_clean_text(text, integer) from public, anon, authenticated;
revoke all on function public.tc_local_ts(date, time, text) from public, anon, authenticated;
revoke all on function public.tc_series_dates(integer[], date, date) from public, anon, authenticated;
revoke all on function public.tc_weekdays(integer[]) from public, anon, authenticated;
revoke all on function public.tc_check_duration(integer) from public, anon, authenticated;
revoke all on function public.tc_new_token() from public, anon, authenticated;
revoke all on function public.teaches_group(uuid) from public, anon, authenticated;
revoke all on function public.teaches_session(uuid) from public, anon, authenticated;
revoke all on function public.tc_attends(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tc_person_name(uuid) from public, anon, authenticated;
revoke all on function public.tc_person_json(uuid) from public, anon, authenticated;
revoke all on function public.tc_assert_teacher(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tc_ensure_enrollment(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.tc_session_via_email() from public, anon, authenticated;
-- (las filas nuevas solo se insertan desde funciones security definer, que sí evalúan tc_email_ok)

-- Si un docente deja la institución (o deja de ser docente/admin), deja de ser docente / suplente de sus grupos
-- (y así pierde el acceso a los emails de esos estudiantes).
create or replace function public.profiles_groups_cleanup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if old.institution_id is not null
     and (new.institution_id is null or new.role not in ('teacher','org_admin')
          or public.billing_root(new.institution_id) is distinct from public.billing_root(old.institution_id)) then
    update public.class_groups set teacher_id = null
     where teacher_id = new.id and public.billing_root(institution_id) = public.billing_root(old.institution_id);
    update public.class_groups set substitute_id = null
     where substitute_id = new.id and public.billing_root(institution_id) = public.billing_root(old.institution_id);
  end if;
  return new;
end $$;
revoke all on function public.profiles_groups_cleanup() from public, anon, authenticated;
drop trigger if exists profiles_groups_cleanup on public.profiles;
create trigger profiles_groups_cleanup after update of institution_id, role on public.profiles
  for each row execute function public.profiles_groups_cleanup();

-- ── docente / suplente por EMAIL (CSV o "Editar grupo"), registrado o todavía no ──
-- Estado de un email para ser docente de un grupo de la unidad p_unit (lo pregunta un admin):
--   registered  → docente/admin de la misma cuenta que quien pregunta administra ({id, name})
--   invited     → sin cuenta, ya tiene una invitación pendiente en la cuenta
--   invite      → sin cuenta: se lo invita como docente (invite_member)
--   add         → tiene cuenta pero sin unidad: invite_member le deja una invitación pendiente que acepta en la app
--   not_allowed → es de otra institución / de una unidad que no administro / no se puede invitar
--   bad_email · none
create or replace function public.tc_person_status(p_unit uuid, p_email text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_email text := lower(btrim(coalesce(p_email, ''))); p public.profiles%rowtype; v_root uuid := public.billing_root(p_unit);
begin
  if v_email = '' then return jsonb_build_object('status', 'none'); end if;
  if not public.tc_email_ok(v_email) then return jsonb_build_object('status', 'bad_email'); end if;
  select pr.* into p from public.profiles pr join auth.users u on u.id = pr.id where lower(btrim(u.email)) = v_email limit 1;
  if p.id is not null then
    if p.role = 'superadmin' then return jsonb_build_object('status', 'not_allowed'); end if;
    if p.role in ('teacher','org_admin') and p.institution_id is not null then
      if public.is_admin_of(p.institution_id) and public.billing_root(p.institution_id) = v_root then
        return jsonb_build_object('status', 'registered', 'id', p.id, 'name', coalesce(p.name, ''));
      end if;
      return jsonb_build_object('status', 'not_allowed');
    end if;
    return jsonb_build_object('status', 'add');
  end if;
  if exists (select 1 from public.invitations i where lower(i.email) = v_email and public.tc_inv_pending(i)
              and public.billing_root(i.institution_id) = v_root) then
    return jsonb_build_object('status', 'invited');
  end if;
  return jsonb_build_object('status', 'invite');
end $$;
revoke all on function public.tc_person_status(uuid, text) from public, anon, authenticated;

-- Asignar docente (p_kind 'teacher') o suplente ('substitute') de un grupo por email. Registrado → queda asignado.
-- Si no: queda PENDIENTE en el grupo y se lo invita a la unidad del grupo con las reglas de invite_member
-- (permisos + asientos). Sin asientos: queda pendiente igual (sin invitación). Devuelve
-- 'assigned' | 'invited' | 'seats_full' | 'none'. Uso interno (quien llama ya verificó que administra el grupo).
create or replace function public.tc_assign_person(p_group uuid, p_kind text, p_email text) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; st jsonb; v_email text := lower(btrim(coalesce(p_email, ''))); v_id uuid; v_res text;
begin
  select * into g from public.class_groups where id = p_group;
  if g.id is null or p_kind not in ('teacher','substitute') then raise exception 'No autorizado'; end if;
  st := public.tc_person_status(g.institution_id, v_email);
  if st->>'status' = 'none' then return 'none'; end if;
  if st->>'status' in ('not_allowed','bad_email') then raise exception 'Docente no válido para este grupo'; end if;
  if st->>'status' = 'registered' then
    v_id := (st->>'id')::uuid;
    if v_id = (case when p_kind = 'teacher' then g.substitute_id else g.teacher_id end) then raise exception 'El suplente tiene que ser otra persona'; end if;
    if p_kind = 'teacher' then update public.class_groups set teacher_id = v_id, pending_teacher_email = null where id = p_group;
    else update public.class_groups set substitute_id = v_id, pending_substitute_email = null where id = p_group; end if;
    return 'assigned';
  end if;
  if v_email = (case when p_kind = 'teacher' then g.pending_substitute_email else g.pending_teacher_email end) then
    raise exception 'El suplente tiene que ser otra persona';
  end if;
  if p_kind = 'teacher' then update public.class_groups set teacher_id = null, pending_teacher_email = v_email where id = p_group;
  else update public.class_groups set substitute_id = null, pending_substitute_email = v_email where id = p_group; end if;
  if st->>'status' = 'invited' then return 'invited'; end if;
  begin
    v_res := public.invite_member(g.institution_id, v_email, 'teacher');   -- 'pending': el trigger lo asigna cuando acepta
  exception when others then
    if sqlerrm ilike '%asientos%' then return 'seats_full'; end if;
    raise;
  end;
  return case when v_res = 'added' then 'assigned' else 'invited' end;
end $$;
revoke all on function public.tc_assign_person(uuid, text, text) from public, anon, authenticated;

-- Apenas alguien queda como docente/admin de una unidad (registro con invitación o por /org/<slug>,
-- invite_member a una cuenta existente, mover de unidad) toma los grupos que lo esperaban por su email
-- (email REAL de la cuenta, auth.users) dentro de la misma cuenta.
create or replace function public.tc_claim_pending_groups() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_email text; v_root uuid;
begin
  if new.role not in ('teacher','org_admin') or new.institution_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.institution_id is not distinct from new.institution_id and old.role is not distinct from new.role then return new; end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.id;
  if coalesce(v_email, '') = '' then return new; end if;
  v_root := public.billing_root(new.institution_id);
  update public.class_groups g set teacher_id = new.id, pending_teacher_email = null
   where g.pending_teacher_email = v_email and g.teacher_id is null and g.substitute_id is distinct from new.id
     and public.billing_root(g.institution_id) = v_root;
  update public.class_groups g set substitute_id = new.id, pending_substitute_email = null
   where g.pending_substitute_email = v_email and g.substitute_id is null and g.teacher_id is distinct from new.id
     and public.billing_root(g.institution_id) = v_root;
  return new;
end $$;
revoke all on function public.tc_claim_pending_groups() from public, anon, authenticated;
drop trigger if exists profiles_claim_pending_groups on public.profiles;
create trigger profiles_claim_pending_groups after insert or update of institution_id, role on public.profiles
  for each row execute function public.tc_claim_pending_groups();

-- Aplicar un horario nuevo a una serie (misma regla que "Editar toda la serie"): las clases FUTURAS no editadas
-- una por una se mueven, las de días que ya no van se borran y se agregan las que faltan. Las pasadas no cambian.
-- p_start_date / p_timezone null = sin cambio. Uso interno (quien llama ya validó permisos y datos).
create or replace function public.tc_series_apply(p_series uuid, p_title text, p_days integer[], p_start_time time,
                                                  p_duration integer, p_start_date date, p_end_date date, p_timezone text)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.session_series%rowtype; v_tz text; v_sd date; v_today date; v_del int := 0; v_upd int := 0; v_ins int := 0;
begin
  select * into s from public.session_series where id = p_series;
  if s.id is null then raise exception 'No autorizado'; end if;
  v_tz := coalesce(nullif(btrim(p_timezone), ''), s.timezone); v_sd := coalesce(p_start_date, s.start_date);
  v_today := (now() at time zone v_tz)::date;
  update public.session_series set title = p_title, weekdays = p_days, start_time = p_start_time, duration_min = p_duration,
         start_date = v_sd, end_date = p_end_date, timezone = v_tz where id = p_series;
  delete from public.class_sessions c
   where c.series_id = p_series and c.starts_at > now() and not c.modified
     and (c.starts_at at time zone s.timezone)::date not in (select public.tc_series_dates(p_days, greatest(v_sd, v_today), p_end_date));
  get diagnostics v_del = row_count;
  update public.class_sessions c
     set title = p_title,
         starts_at = public.tc_local_ts((c.starts_at at time zone s.timezone)::date, p_start_time, v_tz),
         ends_at = public.tc_local_ts((c.starts_at at time zone s.timezone)::date, p_start_time, v_tz) + make_interval(mins => p_duration),
         timezone = v_tz, seq = c.seq + 1
   where c.series_id = p_series and c.starts_at > now() and not c.modified;
  get diagnostics v_upd = row_count;
  insert into public.class_sessions (institution_id, group_id, series_id, teacher_id, title, starts_at, ends_at, timezone)
  select g.institution_id, g.id, s.id, coalesce(g.teacher_id, auth.uid()), p_title, public.tc_local_ts(d, p_start_time, v_tz),
         public.tc_local_ts(d, p_start_time, v_tz) + make_interval(mins => p_duration), v_tz
    from public.tc_series_dates(p_days, greatest(v_sd, v_today), p_end_date) d
    join public.class_groups g on g.id = s.group_id
   where public.tc_local_ts(d, p_start_time, v_tz) > now()
     and not exists (select 1 from public.class_sessions c where c.series_id = s.id and (c.starts_at at time zone v_tz)::date = d);
  get diagnostics v_ins = row_count;
  return json_build_object('updated', v_upd, 'created', v_ins, 'removed', v_del);
end $$;
revoke all on function public.tc_series_apply(uuid, text, integer[], time, integer, date, date, text) from public, anon, authenticated;

-- ── ADMIN: grupos y estudiantes de la unidad elegida (y todo lo que cuelga de ella) ──
create or replace function public.tc_unit_scope(p_unit uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as
$$ select array(select p_unit union all select public.institution_descendants(p_unit)) $$;
revoke all on function public.tc_unit_scope(uuid) from public, anon, authenticated;

create or replace function public.tc_assert_admin(p_unit uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as
$$ begin
  if p_unit is null or not exists (select 1 from public.institutions where id = p_unit) or not public.is_admin_of(p_unit) then
    raise exception 'No autorizado';
  end if;
end $$;
revoke all on function public.tc_assert_admin(uuid) from public, anon, authenticated;

create or replace function public.list_groups(p_unit uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  return coalesce((select json_agg(x order by x.unit_name, lower(x.name)) from (
    select g.id, g.name, g.institution_id, i.name as unit_name, g.timezone,
           public.tc_person_json(g.teacher_id) as teacher, public.tc_person_json(g.substitute_id) as substitute,
           -- pendientes (invitados que todavía no se registraron): solo en esta función, solo para admins
           case when g.pending_teacher_email is not null then json_build_object('email', g.pending_teacher_email,
             'invited', exists (select 1 from public.invitations iv where lower(iv.email) = g.pending_teacher_email and public.tc_inv_pending(iv)
                                  and public.billing_root(iv.institution_id) = public.billing_root(g.institution_id))) end as pending_teacher,
           case when g.pending_substitute_email is not null then json_build_object('email', g.pending_substitute_email,
             'invited', exists (select 1 from public.invitations iv where lower(iv.email) = g.pending_substitute_email and public.tc_inv_pending(iv)
                                  and public.billing_root(iv.institution_id) = public.billing_root(g.institution_id))) end as pending_substitute,
           (select count(*) from public.group_members m where m.group_id = g.id)::int as students,
           (select min(s.starts_at) from public.class_sessions s
             where s.group_id = g.id and s.status = 'scheduled' and s.ends_at > now()) as next_session,
           (select json_build_object('weekdays', ss.weekdays, 'start_time', to_char(ss.start_time, 'HH24:MI'), 'duration_min', ss.duration_min,
                     'start_date', ss.start_date, 'end_date', ss.end_date, 'timezone', ss.timezone, 'origin', ss.origin)
              from public.session_series ss where ss.group_id = g.id and ss.end_date >= (now() at time zone ss.timezone)::date
             order by (ss.origin = 'csv') desc, ss.created_at desc limit 1) as schedule
      from public.class_groups g join public.institutions i on i.id = g.institution_id
     where g.institution_id = any(public.tc_unit_scope(p_unit))) x), '[]'::json);
end $$;

create or replace function public.list_students(p_unit uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  return coalesce((select json_agg(x order by lower(x.name), lower(x.email)) from (
    select e.id, e.email, e.name, e.institution_id, i.name as unit_name, (e.user_id is not null) as linked, e.source, e.created_at,
           coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name) order by lower(g.name))
                       from public.group_members m join public.class_groups g on g.id = m.group_id
                      where m.enrollment_id = e.id), '[]'::json) as groups
      from public.student_enrollments e join public.institutions i on i.id = e.institution_id
     where e.institution_id = any(public.tc_unit_scope(p_unit))
     limit 10000) x), '[]'::json);
end $$;

-- Estudiantes de un grupo (nombre + email): admins de su unidad y su docente / suplente
create or replace function public.list_group_members(p_group uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_inst uuid;
begin
  select institution_id into v_inst from public.class_groups where id = p_group;
  if v_inst is null or not (public.is_admin_of(v_inst) or public.teaches_group(p_group)) then raise exception 'No autorizado'; end if;
  return coalesce((select json_agg(x order by lower(x.name), lower(x.email)) from (
    select e.id as enrollment_id, e.email, e.name, (e.user_id is not null) as linked
      from public.group_members m join public.student_enrollments e on e.id = m.enrollment_id
     where m.group_id = p_group) x), '[]'::json);
end $$;

-- Crear un grupo. Docente / suplente: una cuenta (p_teacher / p_substitute) o un EMAIL (p_teacher_email /
-- p_substitute_email) de alguien invitado o por invitar: queda pendiente y se asigna solo cuando se registra.
drop function if exists public.create_group(uuid, text, uuid, uuid, text);
create or replace function public.create_group(p_unit uuid, p_name text, p_teacher uuid default null,
                                               p_substitute uuid default null, p_timezone text default 'America/Montevideo',
                                               p_teacher_email text default null, p_substitute_email text default null)
returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_name text := public.tc_clean_text(p_name, 120); v_tz text := coalesce(nullif(btrim(p_timezone), ''), 'America/Montevideo'); v_id uuid;
        v_te text := case when p_teacher is null then lower(btrim(coalesce(p_teacher_email, ''))) else '' end;
        v_se text := case when p_substitute is null then lower(btrim(coalesce(p_substitute_email, ''))) else '' end;
begin
  perform public.tc_assert_admin(p_unit);
  if v_name = '' then raise exception 'Nombre del grupo requerido'; end if;
  if not public.tc_tz_ok(v_tz) then raise exception 'Zona horaria inválida'; end if;
  if p_substitute is not null and p_substitute = p_teacher then raise exception 'El suplente tiene que ser otra persona'; end if;
  if v_te <> '' and v_te = v_se then raise exception 'El suplente tiene que ser otra persona'; end if;
  perform public.tc_assert_teacher(p_unit, p_teacher);
  perform public.tc_assert_teacher(p_unit, p_substitute);
  if exists (select 1 from public.class_groups where institution_id = p_unit and lower(btrim(name)) = lower(v_name)) then
    raise exception 'Ya existe un grupo con ese nombre en esta unidad';
  end if;
  insert into public.class_groups (institution_id, name, teacher_id, substitute_id, timezone, created_by)
  values (p_unit, v_name, p_teacher, p_substitute, v_tz, auth.uid()) returning id into v_id;
  if v_te <> '' then perform public.tc_assign_person(v_id, 'teacher', v_te); end if;
  if v_se <> '' then perform public.tc_assign_person(v_id, 'substitute', v_se); end if;
  return v_id;
end $$;

-- Cambiar nombre, docente, suplente o zona horaria (se mandan todos los valores; null = sin docente / sin suplente).
-- Un email en p_teacher_email / p_substitute_email = docente pendiente (si ya era el pendiente, no se reinvita).
drop function if exists public.update_group(uuid, text, uuid, uuid, text);
create or replace function public.update_group(p_group uuid, p_name text, p_teacher uuid, p_substitute uuid, p_timezone text,
                                               p_teacher_email text default null, p_substitute_email text default null)
returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; v_name text := public.tc_clean_text(p_name, 120); v_tz text := btrim(coalesce(p_timezone, ''));
        v_te text := case when p_teacher is null then lower(btrim(coalesce(p_teacher_email, ''))) else '' end;
        v_se text := case when p_substitute is null then lower(btrim(coalesce(p_substitute_email, ''))) else '' end;
begin
  select * into g from public.class_groups where id = p_group;
  if g.id is null or not public.is_admin_of(g.institution_id) then raise exception 'No autorizado'; end if;
  if v_name = '' then raise exception 'Nombre del grupo requerido'; end if;
  if not public.tc_tz_ok(v_tz) then raise exception 'Zona horaria inválida'; end if;
  if p_substitute is not null and p_substitute = p_teacher then raise exception 'El suplente tiene que ser otra persona'; end if;
  if v_te <> '' and v_te = v_se then raise exception 'El suplente tiene que ser otra persona'; end if;
  if p_teacher is distinct from g.teacher_id then perform public.tc_assert_teacher(g.institution_id, p_teacher); end if;
  if p_substitute is distinct from g.substitute_id then perform public.tc_assert_teacher(g.institution_id, p_substitute); end if;
  if exists (select 1 from public.class_groups where institution_id = g.institution_id and id <> g.id and lower(btrim(name)) = lower(v_name)) then
    raise exception 'Ya existe un grupo con ese nombre en esta unidad';
  end if;
  update public.class_groups set name = v_name, teacher_id = p_teacher, substitute_id = p_substitute, timezone = v_tz,
         pending_teacher_email = case when v_te <> '' and v_te = g.pending_teacher_email then v_te end,
         pending_substitute_email = case when v_se <> '' and v_se = g.pending_substitute_email then v_se end
   where id = p_group;
  if v_te <> '' and v_te is distinct from g.pending_teacher_email then perform public.tc_assign_person(p_group, 'teacher', v_te); end if;
  if v_se <> '' and v_se is distinct from g.pending_substitute_email then perform public.tc_assign_person(p_group, 'substitute', v_se); end if;
  return p_group;
end $$;

-- Borrar un grupo (con sus clases; los estudiantes siguen cargados en la unidad)
create or replace function public.delete_group(p_group uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_inst uuid;
begin
  select institution_id into v_inst from public.class_groups where id = p_group;
  if v_inst is null or not public.is_admin_of(v_inst) then raise exception 'No autorizado'; end if;
  delete from public.class_groups where id = p_group;
  return 'deleted';
end $$;

-- Cargar un estudiante (email + nombre) en una unidad; con p_group, en la unidad de ese grupo y dentro del grupo.
-- Devuelve {enrollment_id, created, in_group}
create or replace function public.add_student(p_unit uuid, p_email text, p_name text default '', p_group uuid default null)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_unit uuid := p_unit; v_id uuid; v_new boolean; v_in boolean := false; n int;
begin
  if p_group is not null then
    select institution_id into v_unit from public.class_groups where id = p_group;
    if v_unit is null then raise exception 'No autorizado'; end if;
  end if;
  perform public.tc_assert_admin(v_unit);
  if not public.tc_email_ok(btrim(coalesce(p_email, ''))) then raise exception 'Email inválido: %', left(btrim(coalesce(p_email, '')), 80); end if;
  v_new := not exists (select 1 from public.student_enrollments where institution_id = v_unit and lower(email) = lower(btrim(p_email)));
  v_id := public.tc_ensure_enrollment(v_unit, p_email, p_name, 'manual');
  if p_group is not null then
    insert into public.group_members (group_id, enrollment_id) values (p_group, v_id) on conflict do nothing;
    get diagnostics n = row_count; v_in := true;
  end if;
  return json_build_object('enrollment_id', v_id, 'created', v_new, 'in_group', v_in);
end $$;

-- Sumar una inscripción a un grupo. Si el grupo es de otra unidad, la inscripción se copia a esa unidad
-- (así los admins de la unidad del grupo ven a sus estudiantes). Devuelve la inscripción usada.
create or replace function public.group_add_student(p_group uuid, p_enrollment uuid) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; e public.student_enrollments%rowtype; v_id uuid;
begin
  select * into g from public.class_groups where id = p_group;
  select * into e from public.student_enrollments where id = p_enrollment;
  if g.id is null or e.id is null or not public.is_admin_of(g.institution_id) or not public.is_admin_of(e.institution_id) then
    raise exception 'No autorizado';
  end if;
  v_id := case when e.institution_id = g.institution_id then e.id
               else public.tc_ensure_enrollment(g.institution_id, e.email, e.name, e.source) end;
  insert into public.group_members (group_id, enrollment_id) values (p_group, v_id) on conflict do nothing;
  return v_id;
end $$;

create or replace function public.group_remove_student(p_group uuid, p_enrollment uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_inst uuid;
begin
  select institution_id into v_inst from public.class_groups where id = p_group;
  if v_inst is null or not public.is_admin_of(v_inst) then raise exception 'No autorizado'; end if;
  delete from public.group_members where group_id = p_group and enrollment_id = p_enrollment;
  return 'removed';
end $$;

-- Mover de un grupo a otro (p_from null = solo agregar al destino)
create or replace function public.move_student(p_enrollment uuid, p_from_group uuid, p_to_group uuid) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_id uuid;
begin
  if p_to_group is null then raise exception 'Elegí el grupo de destino'; end if;
  if p_from_group is not null then
    if not exists (select 1 from public.class_groups g where g.id = p_from_group and public.is_admin_of(g.institution_id)) then
      raise exception 'No autorizado';
    end if;
  end if;
  v_id := public.group_add_student(p_to_group, p_enrollment);
  if p_from_group is not null and p_from_group <> p_to_group then
    delete from public.group_members where group_id = p_from_group and enrollment_id = p_enrollment;
  end if;
  return v_id;
end $$;

-- Quitar a un estudiante de la unidad (borra la inscripción de esa unidad y su lugar en los grupos)
create or replace function public.remove_student(p_enrollment uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_inst uuid;
begin
  select institution_id into v_inst from public.student_enrollments where id = p_enrollment;
  if v_inst is null or not public.is_admin_of(v_inst) then raise exception 'No autorizado'; end if;
  delete from public.student_enrollments where id = p_enrollment;
  return 'removed';
end $$;

-- Importar desde un CSV ya leído en el navegador (public/csv-import.js normaliza cada fila):
--   p_rows = [{line, email, name, group, unit, teacher_email, substitute_email,
--              weekdays:[1..7], start_time:"HH:MM", duration_min, start_date:"YYYY-MM-DD", end_date, timezone, errors:[...]}]
-- p_commit = false → solo valida (vista previa); true → carga. Idempotente: volver a importar el mismo archivo no
-- duplica grupos, inscripciones ni clases. Máximo 2000 filas.
-- Docente, suplente, horario y zona horaria son del GRUPO: las filas de un grupo pueden repetirlos o dejarlos vacíos;
-- si dos filas del mismo grupo dicen cosas distintas, la segunda es un error ('conflict', field).
-- Una fila con grupo + horario/docente y sin email define un grupo sin estudiantes todavía ('group_only').
-- Estado por fila: ok · exists (ya estaba) · new_group (se crea el grupo) · group_only · error (code).
-- Códigos: missing_email, bad_email, duplicate, unknown_unit, ambiguous_unit, unknown_teacher, unknown_substitute,
--          unknown_group, bad_group, missing_group, conflict, same_person, bad_schedule y los del navegador
--          (ambiguous_day, bad_days, bad_time, bad_end_time, bad_duration, time_conflict, bad_date, bad_end_date,
--          date_mdy, end_before_start, range_too_long, bad_tz, bad_teacher_email, bad_substitute_email);
--          aviso: teacher_ignored (el grupo ya tiene otro docente: se mantiene).
-- Por grupo (groups[]): docente/suplente (registered · invite · invited · add · current · pending · kept, seats_full),
--   horario (schedule_status: none · new · unchanged · changed · error), clases que se crean (solo FUTURAS),
--   estudiantes. Al cargar, en este orden: grupos → docente y suplente (registrado: asignado; si no: pendiente +
--   invitación a la unidad del grupo, reglas de invite_member) → inscripciones → serie semanal (origin 'csv') con sus
--   clases. Horario cambiado: solo se mueven las clases futuras no editadas una por una (tc_series_apply); las pasadas
--   nunca se tocan.
create or replace function public.import_students(p_unit uuid, p_rows jsonb, p_create_groups boolean default false, p_commit boolean default false)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare
  v_scope uuid[]; v_root uuid; r jsonb; i int := 0; k text; w jsonb;
  v_line int; v_email text; v_name text; v_gname text; v_temail text; v_semail text; v_unitq text;
  v_unit uuid; v_unit_name text; v_n int; v_group uuid; v_gteacher uuid; v_enr uuid;
  v_status text; v_code text; v_field text; v_warn text; v_key text; v_gkey text;
  v_vals jsonb; v_def jsonb; v_g jsonb; v_tst jsonb; v_sst jsonb; v_t jsonb; v_s jsonb; v_sched jsonb; v_prev jsonb;
  v_days integer[]; v_time time; v_dur int; v_sd date; v_ed date; v_tz text; v_today date;
  v_sstatus text; v_serr text; v_missing text[]; v_classes int; v_past int; v_other int; v_res text; v_sid uuid;
  v_cg public.class_groups%rowtype; v_ser public.session_series%rowtype;
  v_seen text[] := '{}'; v_groups jsonb := '{}'::jsonb; v_people jsonb := '{}'::jsonb; v_work jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb; v_glist jsonb := '[]'::jsonb; v_gids jsonb := '{}'::jsonb; v_newp text[] := '{}'; v_avail int;
  c_ok int := 0; c_exists int := 0; c_err int := 0; c_newrows int := 0; c_grows int := 0; c_classes int := 0; c_changes int := 0;
  c_codes constant text[] := array['ambiguous_day','bad_days','bad_time','bad_end_time','bad_duration','time_conflict','bad_date',
    'bad_end_date','date_mdy','end_before_start','range_too_long','bad_tz','bad_teacher_email','bad_substitute_email','same_person'];
begin
  perform public.tc_assert_admin(p_unit);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'Archivo inválido'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Demasiadas filas (máximo 2000)'; end if;
  v_scope := public.tc_unit_scope(p_unit); v_root := public.billing_root(p_unit);

  -- ── 1) cada fila ──
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if jsonb_typeof(r) <> 'object' then raise exception 'Archivo inválido'; end if;
    v_line := case when jsonb_typeof(r->'line') = 'number' then (r->>'line')::int else i + 1 end;
    v_email := btrim(coalesce(r->>'email', ''));
    v_name := public.tc_clean_text(r->>'name', 120);
    v_gname := public.tc_clean_text(r->>'group', 200);
    v_temail := lower(btrim(coalesce(r->>'teacher_email', '')));
    v_semail := lower(btrim(coalesce(r->>'substitute_email', '')));
    v_unitq := btrim(coalesce(r->>'unit', ''));
    v_status := 'ok'; v_code := null; v_field := null; v_warn := null; v_unit := null; v_unit_name := null;
    v_group := null; v_gteacher := null; v_gkey := null; v_g := null; v_tst := null; v_sst := null;
    -- valores del grupo (el navegador ya los normalizó; acá se vuelven a validar)
    v_vals := '{}'::jsonb;
    begin
      if jsonb_typeof(r->'weekdays') = 'array' and jsonb_array_length(r->'weekdays') > 0 then
        v_days := public.tc_weekdays(array(select (x #>> '{}')::int from jsonb_array_elements(r->'weekdays') x));
        v_vals := v_vals || jsonb_build_object('weekdays', to_jsonb(v_days));
      end if;
      if coalesce(r->>'start_time', '') <> '' then
        if (r->>'start_time') !~ '^\d{2}:\d{2}$' then raise exception 'hora'; end if;
        v_vals := v_vals || jsonb_build_object('start_time', to_char((r->>'start_time')::time, 'HH24:MI'));
      end if;
      if coalesce(r->>'duration_min', '') <> '' then
        v_dur := (r->>'duration_min')::int; perform public.tc_check_duration(v_dur);
        v_vals := v_vals || jsonb_build_object('duration_min', v_dur);
      end if;
      if coalesce(r->>'start_date', '') <> '' then
        if (r->>'start_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'fecha'; end if;
        v_vals := v_vals || jsonb_build_object('start_date', (r->>'start_date')::date::text);
      end if;
      if coalesce(r->>'end_date', '') <> '' then
        if (r->>'end_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'fecha'; end if;
        v_vals := v_vals || jsonb_build_object('end_date', (r->>'end_date')::date::text);
      end if;
      if coalesce(r->>'timezone', '') <> '' then
        if not public.tc_tz_ok(btrim(r->>'timezone')) then raise exception 'zona'; end if;
        v_vals := v_vals || jsonb_build_object('timezone', btrim(r->>'timezone'));
      end if;
    exception when others then v_status := 'error'; v_code := 'bad_schedule'; v_vals := '{}'::jsonb;
    end;
    if v_temail <> '' then v_vals := v_vals || jsonb_build_object('teacher_email', v_temail); end if;
    if v_semail <> '' then v_vals := v_vals || jsonb_build_object('substitute_email', v_semail); end if;
    -- unidad (por slug o nombre, dentro de la unidad elegida y lo que cuelga)
    if v_unitq = '' then v_unit := p_unit;
    else
      select count(*), min(id::text)::uuid into v_n, v_unit from public.institutions
       where id = any(v_scope) and (slug = lower(v_unitq) or lower(btrim(name)) = lower(v_unitq));
      if v_n <> 1 then
        if v_status = 'ok' then v_status := 'error'; v_code := case when v_n = 0 then 'unknown_unit' else 'ambiguous_unit' end; end if;
        v_unit := null;
      end if;
    end if;
    if v_unit is not null then select name into v_unit_name from public.institutions where id = v_unit; end if;
    -- problemas de formato que encontró el navegador (días ambiguos, fechas inválidas, …)
    if v_status = 'ok' and jsonb_typeof(r->'errors') = 'array' and jsonb_array_length(r->'errors') > 0 then
      select x into v_code from jsonb_array_elements_text(r->'errors') x where x = any(c_codes) limit 1;
      v_status := 'error'; v_code := coalesce(v_code, 'bad_schedule');
    end if;
    if v_status = 'ok' then
      if v_email = '' then
        if v_gname <> '' and v_vals <> '{}'::jsonb then v_status := 'group_only';
        else v_status := 'error'; v_code := 'missing_email'; end if;
      elsif not public.tc_email_ok(v_email) then v_status := 'error'; v_code := 'bad_email';
      end if;
    end if;
    if v_status <> 'error' and length(v_gname) > 120 then v_status := 'error'; v_code := 'bad_group'; end if;
    if v_status <> 'error' and v_gname = '' and (v_vals - 'teacher_email') <> '{}'::jsonb then v_status := 'error'; v_code := 'missing_group'; end if;
    if v_status = 'ok' then
      v_key := lower(v_email) || '|' || v_unit::text || '|' || lower(v_gname);
      if v_key = any(v_seen) then v_status := 'error'; v_code := 'duplicate'; else v_seen := v_seen || v_key; end if;
    end if;
    -- docente / suplente del grupo
    if v_status <> 'error' and v_gname <> '' and v_temail <> '' then
      v_tst := v_people->v_temail;
      if v_tst is null then v_tst := public.tc_person_status(v_unit, v_temail); v_people := v_people || jsonb_build_object(v_temail, v_tst); end if;
      if v_tst->>'status' in ('not_allowed','bad_email') then v_status := 'error'; v_code := 'unknown_teacher'; end if;
    end if;
    if v_status <> 'error' and v_gname <> '' and v_semail <> '' then
      v_sst := v_people->v_semail;
      if v_sst is null then v_sst := public.tc_person_status(v_unit, v_semail); v_people := v_people || jsonb_build_object(v_semail, v_sst); end if;
      if v_sst->>'status' in ('not_allowed','bad_email') then v_status := 'error'; v_code := 'unknown_substitute'; end if;
    end if;
    -- el grupo: valores que no coinciden con los de otra fila del mismo grupo → error en esta fila
    if v_status <> 'error' and v_gname <> '' then
      v_gkey := v_unit::text || '|' || lower(v_gname);
      v_g := v_groups->v_gkey;
      if v_g is null then
        select * into v_cg from public.class_groups where institution_id = v_unit and lower(btrim(name)) = lower(v_gname);
        v_g := jsonb_build_object('key', v_gkey, 'unit_id', v_unit, 'unit', v_unit_name, 'name', coalesce(v_cg.name, v_gname), 'group_id', v_cg.id,
                                  'def', '{}'::jsonb, 'students', 0, 'students_new', 0, 'first_line', v_line);
      end if;
      v_def := v_g->'def';
      for k in select jsonb_object_keys(v_vals) loop
        if v_def ? k and (v_def->k) <> (v_vals->k) then v_status := 'error'; v_code := 'conflict'; v_field := k; exit; end if;
      end loop;
      if v_status <> 'error' then
        v_def := v_def || v_vals;
        if coalesce(v_def->>'teacher_email', '') <> '' and v_def->>'teacher_email' = v_def->>'substitute_email' then
          v_status := 'error'; v_code := 'same_person';
        end if;
      end if;
      if v_status <> 'error' and (v_g->>'group_id') is null then
        if not p_commit or p_create_groups then if v_status = 'ok' then v_status := 'new_group'; end if;
        else v_status := 'error'; v_code := 'unknown_group'; end if;
      end if;
      if v_status <> 'error' then
        v_group := (v_g->>'group_id')::uuid;
        if v_group is not null and v_temail <> '' then
          select teacher_id into v_gteacher from public.class_groups where id = v_group;
          if v_gteacher is not null and (v_tst->>'id') is distinct from v_gteacher::text then v_warn := 'teacher_ignored'; end if;
        end if;
      end if;
    end if;
    if v_status in ('ok','new_group') then
      if exists (select 1 from public.student_enrollments e where e.institution_id = v_unit and lower(e.email) = lower(v_email)
                  and (v_gname = '' or (v_group is not null and exists (select 1 from public.group_members m where m.group_id = v_group and m.enrollment_id = e.id)))) then
        v_status := 'exists';
      end if;
    end if;
    if v_g is not null and v_status <> 'error' then
      v_g := jsonb_set(v_g, '{def}', v_def);
      if v_status in ('ok','new_group','exists') then v_g := jsonb_set(v_g, '{students}', to_jsonb((v_g->>'students')::int + 1)); end if;
      if v_status in ('ok','new_group') then v_g := jsonb_set(v_g, '{students_new}', to_jsonb((v_g->>'students_new')::int + 1)); end if;
      v_groups := v_groups || jsonb_build_object(v_gkey, v_g);
    end if;
    if v_status = 'error' then c_err := c_err + 1; elsif v_status = 'exists' then c_exists := c_exists + 1;
    elsif v_status = 'group_only' then c_grows := c_grows + 1;
    else c_ok := c_ok + 1; if v_status = 'new_group' then c_newrows := c_newrows + 1; end if; end if;
    if v_status in ('ok','new_group','exists') then
      v_work := v_work || jsonb_build_array(jsonb_build_object('email', v_email, 'name', v_name, 'unit_id', v_unit, 'gkey', v_gkey));
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('line', v_line, 'email', left(v_email, 254), 'name', v_name,
               'group', v_gname, 'unit', v_unit_name, 'status', v_status, 'code', v_code, 'field', v_field, 'warning', v_warn));
  end loop;

  -- ── 2) cada grupo: docente, suplente, horario, clases ──
  v_avail := greatest(public.billing_seats(v_root) - public.seats_used(v_root), 0);
  for v_g in select value from jsonb_each(v_groups) order by (value->>'first_line')::int loop
    v_def := v_g->'def';
    select * into v_cg from public.class_groups where id = (v_g->>'group_id')::uuid;
    v_tz := coalesce(v_def->>'timezone', v_cg.timezone, 'America/Montevideo');
    v_today := (now() at time zone v_tz)::date;
    -- docente / suplente (seats_full: personas nuevas que no entran en los asientos libres)
    v_t := null; v_s := null;
    foreach k in array array['teacher','substitute'] loop
      v_res := v_def->>(k || '_email');
      if v_res is not null then
        w := (v_people->v_res) || jsonb_build_object('email', v_res);
        if (case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end) is not null then
          w := w || jsonb_build_object('status', case when (w->>'id') = (case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end)::text then 'registered' else 'kept' end,
                                       'current', public.tc_person_name(case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end));
        elsif w->>'status' = 'registered' then w := w || jsonb_build_object('assign', true);
        elsif w->>'status' in ('invite','add') then
          if not (v_res = any(v_newp)) then v_newp := v_newp || v_res; end if;
          if array_position(v_newp, v_res) > v_avail then w := w || jsonb_build_object('seats_full', true); end if;
        end if;
      elsif (case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end) is not null then
        w := jsonb_build_object('status', 'current', 'name', public.tc_person_name(case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end));
      elsif (case when k = 'teacher' then v_cg.pending_teacher_email else v_cg.pending_substitute_email end) is not null then
        w := jsonb_build_object('status', 'pending', 'email', case when k = 'teacher' then v_cg.pending_teacher_email else v_cg.pending_substitute_email end);
      else w := null; end if;
      if k = 'teacher' then v_t := w; else v_s := w; end if;
    end loop;
    -- horario
    v_sched := null; v_prev := null; v_sstatus := 'none'; v_serr := null; v_missing := '{}'; v_classes := 0; v_past := 0; v_other := 0;
    v_ser := null;
    if v_cg.id is not null then
      select * into v_ser from public.session_series where group_id = v_cg.id and origin = 'csv' order by created_at desc limit 1;
    end if;
    if v_def ?| array['weekdays','start_time','duration_min','start_date','end_date'] then
      v_missing := array(select m from unnest(array['weekdays','start_time','duration_min','end_date']) m where not v_def ? m);
      if cardinality(v_missing) > 0 then v_sstatus := 'error'; v_serr := 'schedule_incomplete';
      else
        v_days := array(select (x #>> '{}')::int from jsonb_array_elements(v_def->'weekdays') x);
        v_time := (v_def->>'start_time')::time; v_dur := (v_def->>'duration_min')::int;
        v_sd := coalesce((v_def->>'start_date')::date, v_ser.start_date, v_today); v_ed := (v_def->>'end_date')::date;
        if v_ed < v_sd then v_sstatus := 'error'; v_serr := 'end_before_start';
        elsif v_ed > v_sd + 366 then v_sstatus := 'error'; v_serr := 'range_too_long';
        else
          select count(*) into v_classes from public.tc_series_dates(v_days, greatest(v_sd, v_today), v_ed) d where public.tc_local_ts(d, v_time, v_tz) > now();
          select count(*) into v_past from public.tc_series_dates(v_days, v_sd, least(v_ed, v_today)) d where public.tc_local_ts(d, v_time, v_tz) <= now();
          v_sched := jsonb_build_object('weekdays', to_jsonb(v_days), 'start_time', to_char(v_time, 'HH24:MI'), 'duration_min', v_dur,
                                        'start_date', v_sd, 'end_date', v_ed, 'timezone', v_tz);
          if v_ser.id is null then v_sstatus := 'new';
          elsif v_ser.weekdays = v_days and v_ser.start_time = v_time and v_ser.duration_min = v_dur and v_ser.start_date = v_sd
                and v_ser.end_date = v_ed and v_ser.timezone = v_tz then v_sstatus := 'unchanged';
          else
            v_sstatus := 'changed';
            v_prev := jsonb_build_object('weekdays', to_jsonb(v_ser.weekdays), 'start_time', to_char(v_ser.start_time, 'HH24:MI'), 'duration_min', v_ser.duration_min,
                                         'start_date', v_ser.start_date, 'end_date', v_ser.end_date, 'timezone', v_ser.timezone);
          end if;
          if v_classes = 0 and v_sstatus <> 'unchanged' then v_sstatus := 'error'; v_serr := 'no_dates'; v_sched := null; end if;
          if v_cg.id is not null then
            select count(*) into v_other from public.class_sessions c
             where c.group_id = v_cg.id and c.status = 'scheduled' and c.starts_at > now() and c.series_id is distinct from v_ser.id;
          end if;
        end if;
      end if;
    end if;
    if v_sstatus in ('new','changed') then c_classes := c_classes + v_classes; end if;
    if v_sstatus = 'changed' then c_changes := c_changes + 1; end if;
    v_glist := v_glist || jsonb_build_array(jsonb_build_object('key', v_g->'key', 'name', v_g->'name', 'unit', v_g->'unit', 'unit_id', v_g->'unit_id',
      'group_id', v_g->'group_id', 'exists', v_cg.id is not null, 'teacher', v_t, 'substitute', v_s, 'timezone', v_tz,
      'schedule', v_sched, 'schedule_status', v_sstatus, 'schedule_error', v_serr, 'missing', to_jsonb(v_missing), 'previous', v_prev,
      'series_id', v_ser.id, 'classes', v_classes, 'past_skipped', v_past, 'other_classes', v_other,
      'students', v_g->'students', 'students_new', v_g->'students_new'));
  end loop;

  -- ── 3) cargar: grupos → docente y suplente → inscripciones → series con sus clases ──
  if p_commit then
    for v_g in select value from jsonb_array_elements(v_glist) loop
      v_group := (v_g->>'group_id')::uuid;
      if v_group is null then
        select id into v_group from public.class_groups where institution_id = (v_g->>'unit_id')::uuid and lower(btrim(name)) = lower(v_g->>'name');
        if v_group is null then
          insert into public.class_groups (institution_id, name, timezone, created_by)
          values ((v_g->>'unit_id')::uuid, v_g->>'name', v_g->>'timezone', auth.uid()) returning id into v_group;
        end if;
      else
        update public.class_groups set timezone = v_g->>'timezone' where id = v_group and timezone is distinct from v_g->>'timezone';
      end if;
      v_gids := v_gids || jsonb_build_object(v_g->>'key', v_group);
      foreach k in array array['teacher','substitute'] loop
        w := v_g->k;
        if w is not null and coalesce(w->>'email', '') <> '' and w->>'status' in ('registered','invite','invited','add') then
          select * into v_cg from public.class_groups where id = v_group;
          if (case when k = 'teacher' then v_cg.teacher_id else v_cg.substitute_id end) is null then
            begin
              perform public.tc_assign_person(v_group, k, w->>'email');
            exception when others then null;   -- p. ej. la misma persona ya es el suplente: se mantiene como estaba
            end;
          end if;
        end if;
      end loop;
    end loop;
    for w in select value from jsonb_array_elements(v_work) loop
      v_enr := public.tc_ensure_enrollment((w->>'unit_id')::uuid, w->>'email', w->>'name', 'csv');
      if coalesce(w->>'gkey', '') <> '' and v_gids ? (w->>'gkey') then
        insert into public.group_members (group_id, enrollment_id) values ((v_gids->>(w->>'gkey'))::uuid, v_enr) on conflict do nothing;
      end if;
    end loop;
    for v_g in select value from jsonb_array_elements(v_glist) loop
      if v_g->>'schedule_status' not in ('new','changed') then continue; end if;
      v_group := (v_gids->>(v_g->>'key'))::uuid; v_sched := v_g->'schedule';
      v_days := array(select (x #>> '{}')::int from jsonb_array_elements(v_sched->'weekdays') x);
      v_time := (v_sched->>'start_time')::time; v_dur := (v_sched->>'duration_min')::int;
      v_sd := (v_sched->>'start_date')::date; v_ed := (v_sched->>'end_date')::date; v_tz := v_sched->>'timezone';
      if v_g->>'schedule_status' = 'changed' then
        select * into v_ser from public.session_series where id = (v_g->>'series_id')::uuid;
        perform public.tc_series_apply(v_ser.id, v_ser.title, v_days, v_time, v_dur, v_sd, v_ed, v_tz);
      else
        insert into public.session_series (group_id, title, weekdays, start_time, duration_min, start_date, end_date, timezone, created_by, origin)
        values (v_group, '', v_days, v_time, v_dur, v_sd, v_ed, v_tz, auth.uid(), 'csv') returning id into v_sid;
        v_today := (now() at time zone v_tz)::date;
        insert into public.class_sessions (institution_id, group_id, series_id, teacher_id, title, starts_at, ends_at, timezone)
        select g.institution_id, g.id, v_sid, coalesce(g.teacher_id, auth.uid()), '', public.tc_local_ts(d, v_time, v_tz),
               public.tc_local_ts(d, v_time, v_tz) + make_interval(mins => v_dur), v_tz
          from public.tc_series_dates(v_days, greatest(v_sd, v_today), v_ed) d join public.class_groups g on g.id = v_group
         where public.tc_local_ts(d, v_time, v_tz) > now();
      end if;
    end loop;
  end if;

  return json_build_object('total', i, 'ok', c_ok, 'exists', c_exists, 'errors', c_err, 'new_group_rows', c_newrows, 'group_rows', c_grows,
    'new_groups', coalesce((select jsonb_agg(jsonb_build_object('unit', g->'unit', 'name', g->'name') order by g->>'unit', g->>'name')
                              from jsonb_array_elements(v_glist) g where not (g->>'exists')::boolean), '[]'::jsonb),
    'groups', v_glist, 'classes', c_classes, 'schedule_changes', c_changes, 'seats_available', v_avail,
    'committed', coalesce(p_commit, false), 'rows', v_out);
end $$;

-- ── DOCENTES: sus grupos y sus clases ──
-- Grupos donde soy docente o suplente
create or replace function public.my_groups() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  return coalesce((select json_agg(x order by lower(x.name)) from (
    select g.id, g.name, i.name as unit_name, g.institution_id, g.timezone,
           case when g.teacher_id = auth.uid() then 'teacher' else 'substitute' end as role,
           (select count(*) from public.group_members m where m.group_id = g.id)::int as students
      from public.class_groups g join public.institutions i on i.id = g.institution_id
     where auth.uid() in (g.teacher_id, g.substitute_id)) x), '[]'::json);
end $$;

-- Clases semanales de un grupo: días (1 = lunes … 7 = domingo), hora de inicio, duración, desde / hasta (máx. 1 año)
create or replace function public.create_series(p_group uuid, p_title text, p_weekdays integer[], p_start_time time,
                                                p_duration integer, p_start_date date, p_end_date date)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; v_days integer[]; v_id uuid; v_n int; v_title text := public.tc_clean_text(p_title, 200);
begin
  select * into g from public.class_groups where id = p_group;
  if g.id is null or not public.teaches_group(p_group) then raise exception 'No autorizado'; end if;
  v_days := public.tc_weekdays(p_weekdays);
  perform public.tc_check_duration(p_duration);
  if p_start_time is null or p_start_date is null or p_end_date is null then raise exception 'Faltan datos de la serie'; end if;
  if p_end_date < p_start_date then raise exception 'La fecha de fin es anterior a la de inicio'; end if;
  if p_end_date > p_start_date + 366 then raise exception 'Una serie puede durar como máximo un año'; end if;
  if p_start_date < (now() at time zone g.timezone)::date - 1 then raise exception 'La serie no puede empezar en el pasado'; end if;
  insert into public.session_series (group_id, title, weekdays, start_time, duration_min, start_date, end_date, timezone, created_by)
  values (g.id, v_title, v_days, p_start_time, p_duration, p_start_date, p_end_date, g.timezone, auth.uid()) returning id into v_id;
  insert into public.class_sessions (institution_id, group_id, series_id, teacher_id, title, starts_at, ends_at, timezone)
  select g.institution_id, g.id, v_id, auth.uid(), v_title, public.tc_local_ts(d, p_start_time, g.timezone),
         public.tc_local_ts(d, p_start_time, g.timezone) + make_interval(mins => p_duration), g.timezone
    from public.tc_series_dates(v_days, p_start_date, p_end_date) d;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Ninguna fecha coincide con los días elegidos'; end if;
  return json_build_object('series_id', v_id, 'created', v_n);
end $$;

-- Editar TODA la serie desde hoy: las clases futuras no editadas una por una se mueven al nuevo horario,
-- las de días que ya no van se borran y se agregan las nuevas. Las pasadas no cambian.
create or replace function public.update_series(p_series uuid, p_title text, p_weekdays integer[], p_start_time time,
                                                p_duration integer, p_end_date date)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.session_series%rowtype; v_days integer[]; v_title text := public.tc_clean_text(p_title, 200);
begin
  select * into s from public.session_series where id = p_series;
  if s.id is null or not public.teaches_group(s.group_id) then raise exception 'No autorizado'; end if;
  v_days := public.tc_weekdays(p_weekdays);
  perform public.tc_check_duration(p_duration);
  if p_start_time is null or p_end_date is null then raise exception 'Faltan datos de la serie'; end if;
  if p_end_date < s.start_date then raise exception 'La fecha de fin es anterior a la de inicio'; end if;
  if p_end_date > s.start_date + 366 then raise exception 'Una serie puede durar como máximo un año'; end if;
  return public.tc_series_apply(p_series, v_title, v_days, p_start_time, p_duration, null, p_end_date, null);
end $$;

-- Cancelar toda la serie desde ahora (las clases quedan como canceladas: el feed lo avisa a los calendarios)
create or replace function public.cancel_series(p_series uuid) returns integer
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.session_series%rowtype; v_n int;
begin
  select * into s from public.session_series where id = p_series;
  if s.id is null or not public.teaches_group(s.group_id) then raise exception 'No autorizado'; end if;
  update public.class_sessions set status = 'cancelled', seq = seq + 1
   where series_id = p_series and starts_at > now() and status <> 'cancelled';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Una clase suelta: de un grupo (p_group) o sin grupo, invitando estudiantes por email (p_emails).
-- Un email que todavía no es estudiante de la institución queda cargado por quien lo invita (misma privacidad).
create or replace function public.create_session(p_group uuid, p_title text, p_starts_at timestamptz, p_duration integer,
                                                 p_timezone text default null, p_emails text[] default null)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; v_inst uuid; v_tz text; v_id uuid; v_e text; v_enr uuid; v_n int := 0;
        v_title text := public.tc_clean_text(p_title, 200); v_emails text[] := '{}';
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_emails from unnest(coalesce(p_emails, '{}')) x where btrim(coalesce(x, '')) <> '';
  if coalesce(array_length(v_emails, 1), 0) > 200 then raise exception 'Demasiados invitados (máximo 200)'; end if;
  foreach v_e in array v_emails loop
    if not public.tc_email_ok(v_e) then raise exception 'Email inválido: %', left(v_e, 80); end if;
  end loop;
  if p_group is not null then
    select * into g from public.class_groups where id = p_group;
    if g.id is null or not public.teaches_group(p_group) then raise exception 'No autorizado'; end if;
    v_inst := g.institution_id; v_tz := g.timezone;
  else
    if coalesce(public.my_role(), '') not in ('teacher','org_admin') or public.my_institution() is null then
      raise exception 'Para crear una clase sin grupo necesitás pertenecer a una institución';
    end if;
    if coalesce(array_length(v_emails, 1), 0) = 0 then raise exception 'Agregá al menos un email de estudiante'; end if;
    v_inst := public.my_institution();
    v_tz := coalesce(nullif(btrim(p_timezone), ''), 'America/Montevideo');
    if not public.tc_tz_ok(v_tz) then raise exception 'Zona horaria inválida'; end if;
  end if;
  perform public.tc_check_duration(p_duration);
  if p_starts_at is null or p_starts_at < now() - interval '1 day' or p_starts_at > now() + interval '400 days' then
    raise exception 'Fecha de la clase inválida';
  end if;
  insert into public.class_sessions (institution_id, group_id, teacher_id, title, starts_at, ends_at, timezone)
  values (v_inst, p_group, auth.uid(), v_title, p_starts_at, p_starts_at + make_interval(mins => p_duration), v_tz)
  returning id into v_id;
  foreach v_e in array v_emails loop
    v_enr := public.tc_ensure_enrollment(v_inst, v_e, '', 'session');
    insert into public.session_invitees (session_id, enrollment_id) values (v_id, v_enr) on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return json_build_object('id', v_id, 'invited', v_n);
end $$;

-- Editar UNA clase (título, inicio, duración). Si es de una serie queda marcada: editar la serie no la pisa.
create or replace function public.update_session(p_session uuid, p_title text, p_starts_at timestamptz, p_duration integer)
returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  perform public.tc_check_duration(p_duration);
  if p_starts_at is null or p_starts_at < now() - interval '1 day' or p_starts_at > now() + interval '400 days' then
    raise exception 'Fecha de la clase inválida';
  end if;
  update public.class_sessions
     set title = public.tc_clean_text(p_title, 200), starts_at = p_starts_at,
         ends_at = p_starts_at + make_interval(mins => p_duration), seq = seq + 1, modified = (series_id is not null)
   where id = p_session;
  return p_session;
end $$;

-- Cancelar (o reactivar con p_cancel = false) UNA clase
create or replace function public.cancel_session(p_session uuid, p_cancel boolean default true) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  update public.class_sessions
     set status = case when coalesce(p_cancel, true) then 'cancelled' else 'scheduled' end, seq = seq + 1,
         modified = (series_id is not null)
   where id = p_session;
  return case when coalesce(p_cancel, true) then 'cancelled' else 'scheduled' end;
end $$;

-- Filas de calendario para una persona (docente, suplente, quien creó una clase suelta o estudiante).
create or replace function public.tc_calendar_rows(p_user uuid, p_from timestamptz, p_to timestamptz, p_limit integer)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(jsonb_agg(x order by x.starts_at, x.id), '[]'::jsonb) from (
     select s.id, coalesce(nullif(s.title, ''), g.name, '') as title, s.title as raw_title, s.starts_at, s.ends_at, s.timezone,
            s.status, s.seq, s.updated_at, s.group_id, g.name as group_name, i.name as unit_name, s.series_id, s.modified,
            case when g.id is not null and g.teacher_id = p_user then 'teacher'
                 when g.id is not null and g.substitute_id = p_user then 'substitute'
                 when g.id is null and s.teacher_id = p_user then 'teacher'
                 else 'student' end as role,
            public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)) as teacher_name,
            -- plan adjunto (P-06): solo el docente / suplente / quien la creó ve cuál es (nunca los estudiantes)
            case when (g.id is not null and p_user in (g.teacher_id, g.substitute_id)) or (g.id is null and s.teacher_id = p_user)
                 then s.planning_id end as planning_id,
            case when (g.id is not null and p_user in (g.teacher_id, g.substitute_id)) or (g.id is null and s.teacher_id = p_user)
                 then (select pl.title from public.plannings pl where pl.id = s.planning_id) end as planning_title,
            ((select count(*) from public.group_members m where m.group_id = s.group_id)
             + (select count(*) from public.session_invitees si where si.session_id = s.id))::int as people
       from public.class_sessions s
       join public.institutions i on i.id = s.institution_id
       left join public.class_groups g on g.id = s.group_id
      where s.starts_at < p_to and s.ends_at > p_from
        and (s.group_id in (select gg.id from public.class_groups gg where p_user in (gg.teacher_id, gg.substitute_id))
             or (s.group_id is null and s.teacher_id = p_user)
             or s.group_id in (select m.group_id from public.group_members m
                                 join public.student_enrollments e on e.id = m.enrollment_id where e.user_id = p_user)
             or s.id in (select si.session_id from public.session_invitees si
                           join public.student_enrollments e on e.id = si.enrollment_id where e.user_id = p_user))
      order by s.starts_at limit p_limit) x $$;
revoke all on function public.tc_calendar_rows(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;

-- Mi calendario (máximo 200 días por consulta). can_edit = docente / suplente / quien la creó.
create or replace function public.my_calendar(p_from timestamptz, p_to timestamptz) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '200 days' then raise exception 'Rango de fechas inválido'; end if;
  return (select coalesce(jsonb_agg(r || jsonb_build_object('can_edit', r->>'role' <> 'student') order by r->>'starts_at'), '[]'::jsonb)
            from jsonb_array_elements(public.tc_calendar_rows(auth.uid(), p_from, p_to, 2000)) r)::json;
end $$;

-- Quiénes están en una clase (nombre + email): su docente / suplente / quien la creó, y los admins de su unidad
create or replace function public.session_people(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_inst uuid; v_group uuid;
begin
  select institution_id, group_id into v_inst, v_group from public.class_sessions where id = p_session;
  if v_inst is null or not (public.teaches_session(p_session) or public.is_admin_of(v_inst)) then raise exception 'No autorizado'; end if;
  return coalesce((select json_agg(x order by lower(x.name), lower(x.email)) from (
    select e.id as enrollment_id, e.name, e.email, 'group' as via
      from public.group_members m join public.student_enrollments e on e.id = m.enrollment_id where m.group_id = v_group
    union
    select e.id, e.name, e.email, 'invite'
      from public.session_invitees si join public.student_enrollments e on e.id = si.enrollment_id
     where si.session_id = p_session
       and not exists (select 1 from public.group_members m where m.group_id = v_group and m.enrollment_id = e.id)) x), '[]'::json);
end $$;

-- Admin: calendario (solo lectura) de la unidad y lo que cuelga
create or replace function public.unit_calendar(p_unit uuid, p_from timestamptz, p_to timestamptz) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '200 days' then raise exception 'Rango de fechas inválido'; end if;
  return coalesce((select json_agg(x order by x.starts_at) from (
    select s.id, coalesce(nullif(s.title, ''), g.name, '') as title, s.starts_at, s.ends_at, s.timezone, s.status, s.group_id,
           g.name as group_name, i.name as unit_name, s.series_id, 'admin' as role, false as can_edit,
           public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)) as teacher_name,
           ((select count(*) from public.group_members m where m.group_id = s.group_id)
            + (select count(*) from public.session_invitees si where si.session_id = s.id))::int as people
      from public.class_sessions s join public.institutions i on i.id = s.institution_id
      left join public.class_groups g on g.id = s.group_id
     where s.institution_id = any(public.tc_unit_scope(p_unit)) and s.starts_at < p_to and s.ends_at > p_from
     order by s.starts_at limit 2000) x), '[]'::json);
end $$;

-- ── ESTUDIANTES ──
-- Vincular mis inscripciones: el email REAL de mi cuenta (auth.users, verificado) igual al cargado, sin
-- importar mayúsculas, y solo si esta sesión se abrió con un link/código enviado a ese email.
-- No cambia el rol (los docentes/admins que además son estudiantes ven esas clases en su calendario).
create or replace function public.claim_enrollments() returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_uid uuid := auth.uid(); v_email text; v_conf timestamptz; v_n int := 0; v_ok boolean;
begin
  if v_uid is null then raise exception 'No autorizado'; end if;
  select lower(btrim(u.email)), u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = v_uid;
  v_ok := v_email is not null and v_email <> '' and v_conf is not null and public.tc_session_via_email();
  if v_ok then
    update public.student_enrollments set user_id = v_uid, claimed_at = now()
     where lower(email) = v_email and user_id is null;
    get diagnostics v_n = row_count;
  end if;
  return json_build_object('linked', v_n, 'verified', v_ok, 'role', public.my_role(),
    'enrollments', (select count(*) from public.student_enrollments where user_id = v_uid));
end $$;

-- Panel del estudiante: sus grupos (con el nombre del docente y CUÁNTOS compañeros, nunca sus emails),
-- sus clases (desde ayer hasta 120 días) y sus datos. Súper admin ("Ver como"): p_group y/o p_enrollment.
create or replace function public.student_view(p_group uuid default null, p_enrollment uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_enr uuid[] := '{}'; v_groups uuid[] := '{}'; v_name text := ''; v_email text := '';
begin
  if p_group is null and p_enrollment is null then
    if auth.uid() is null then raise exception 'No autorizado'; end if;
    v_enr := array(select id from public.student_enrollments where user_id = auth.uid());
    select coalesce(u.email, '') into v_email from auth.users u where u.id = auth.uid();
    select coalesce((select nullif(name, '') from public.student_enrollments where user_id = auth.uid() and name <> '' order by created_at limit 1),
                    (select nullif(name, '') from public.profiles where id = auth.uid()), '') into v_name;
  else
    if not public.is_superadmin() then raise exception 'No autorizado'; end if;
    if p_enrollment is not null then
      select array[id], email, name into v_enr, v_email, v_name from public.student_enrollments where id = p_enrollment;
      if v_enr is null then raise exception 'No autorizado'; end if;
    else
      if not exists (select 1 from public.class_groups where id = p_group) then raise exception 'No autorizado'; end if;
      v_groups := array[p_group];
    end if;
  end if;
  v_groups := v_groups || array(select distinct m.group_id from public.group_members m where m.enrollment_id = any(v_enr));
  return json_build_object(
    'me', json_build_object('name', coalesce(v_name, ''), 'email', coalesce(v_email, '')),
    'enrollments', coalesce(array_length(v_enr, 1), 0),
    'groups', coalesce((select json_agg(x order by lower(x.name)) from (
        select g.id, g.name, i.name as unit_name, r.name as institution_name, g.timezone,
               public.tc_person_name(g.teacher_id) as teacher_name, public.tc_person_name(g.substitute_id) as substitute_name,
               (select count(*) from public.group_members m where m.group_id = g.id)::int as classmates
          from public.class_groups g join public.institutions i on i.id = g.institution_id
          join public.institutions r on r.id = public.billing_root(g.institution_id)
         where g.id = any(v_groups)) x), '[]'::json),
    'sessions', coalesce((select json_agg(x order by x.starts_at) from (
        select s.id, coalesce(nullif(s.title, ''), g.name, '') as title, s.starts_at, s.ends_at, s.timezone, s.status,
               g.name as group_name, public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)) as teacher_name,
               exists (select 1 from public.class_docs d where d.session_id = s.id) as has_doc
          from public.class_sessions s left join public.class_groups g on g.id = s.group_id
         where (s.group_id = any(v_groups)
                or exists (select 1 from public.session_invitees si where si.session_id = s.id and si.enrollment_id = any(v_enr)))
           and s.ends_at > now() - interval '1 day' and s.starts_at < now() + interval '120 days'
         order by s.starts_at limit 300) x), '[]'::json),
    -- sus insights más recientes (los propios; el mensaje del docente solo si está publicado: ver my_insight)
    'insights', public.tc_insight_summaries(v_enr, 5),
    -- documentos de sus clases ya terminadas (últimos 90 días; quedan como registro)
    'docs', coalesce((select json_agg(x order by x.starts_at desc) from (
        select s.id, coalesce(nullif(s.title, ''), g.name, '') as title, s.starts_at, s.ends_at, g.name as group_name, d.updated_at
          from public.class_docs d join public.class_sessions s on s.id = d.session_id left join public.class_groups g on g.id = s.group_id
         where (s.group_id = any(v_groups)
                or exists (select 1 from public.session_invitees si where si.session_id = s.id and si.enrollment_id = any(v_enr)))
           and s.ends_at <= now() and s.ends_at > now() - interval '90 days'
         order by s.starts_at desc limit 8) x), '[]'::json),
    -- su asistencia (solo la propia: "Asististe a 9 de 10 clases"); un estudiante genérico de "Ver como" no tiene
    'attendance', public.tc_attendance_summary(v_enr));
end $$;

-- ── CALENDARIO EXTERNO (Google Calendar, Outlook, Apple) sin proveedor de email ──
-- Mi token del feed (lo crea si falta; p_reset = true lo cambia y el link viejo deja de funcionar)
create or replace function public.my_calendar_token(p_reset boolean default false) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'No autorizado'; end if;
  if coalesce(p_reset, false) then delete from public.calendar_tokens where user_id = v_uid; end if;
  insert into public.calendar_tokens (user_id, token) values (v_uid, public.tc_new_token()) on conflict (user_id) do nothing;
  return (select token from public.calendar_tokens where user_id = v_uid);
end $$;

-- Feed: lo llama api/calendar/feed.js con la clave publicable (anon). Solo las clases de la persona dueña
-- del token (60 días para atrás, 400 para adelante), sin emails ni datos de otros estudiantes.
-- Token inválido o desconocido → lista vacía.
create or replace function public.calendar_feed(p_token text) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_uid uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return '[]'::json; end if;
  select user_id into v_uid from public.calendar_tokens where token = p_token;
  if v_uid is null then return '[]'::json; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r->'id', 'title', r->'title', 'group_name', r->'group_name',
            'starts_at', r->'starts_at', 'ends_at', r->'ends_at', 'status', r->'status', 'seq', r->'seq',
            'updated_at', r->'updated_at', 'teacher_name', r->'teacher_name', 'role', r->'role') order by r->>'starts_at'), '[]'::jsonb)
            from jsonb_array_elements(public.tc_calendar_rows(v_uid, now() - interval '60 days', now() + interval '400 days', 1000)) r)::json;
end $$;

-- Para api/notify (con el token de quien da la clase): la clase y los emails de sus estudiantes
create or replace function public.session_notify_payload(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  return (select json_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), g.name, ''), 'group_name', g.name,
            'starts_at', s.starts_at, 'ends_at', s.ends_at, 'timezone', s.timezone, 'status', s.status, 'seq', s.seq,
            'teacher_name', public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)),
            'recipients', coalesce((select json_agg(json_build_object('email', p->>'email', 'name', p->>'name'))
                                      from json_array_elements(public.session_people(p_session)) p), '[]'::json))
            from public.class_sessions s left join public.class_groups g on g.id = s.group_id where s.id = p_session);
end $$;

-- ========== INSIGHTS DE CLASE (docente, suplente, admins y cada estudiante) ==========
-- Un "insight" cuelga de una CLASE DEL CALENDARIO (class_sessions), no de la videollamada:
--   · teacher_insights: UN informe de observación por clase (guía TEC: evidencia → qué funcionó → área
--     prioritaria → próximo paso) + la reflexión que escribe el docente.
--   · student_insights: UNO por estudiante de esa clase (inscripción = student_enrollments): repaso, progreso,
--     devolución, vocabulario + el mensaje del docente (borrador y versión publicada).
-- Hoy no hay grabación: los datos son de DEMOSTRACIÓN (is_demo = true) y se generan al terminar una clase en la
-- demo del aula en vivo o con "Generar insights de demo" (generate_demo_insights). Cuando se active la grabación
-- (002_live_class.sql), el servidor escribirá filas reales en estas mismas tablas: live_sessions.class_session_id
-- vincula la llamada con la clase y student_insights.participant_id con el participante de la llamada.
-- PRIVACIDAD (sin acceso directo a las tablas; todo por las funciones de abajo):
--   · cada estudiante ve SOLO sus insights y el mensaje de su docente cuando está PUBLICADO (nunca el borrador,
--     nunca el informe del docente ni su reflexión, nunca a sus compañeros);
--   · docente / suplente: las clases de los grupos donde da clase (y sus clases sueltas);
--   · admins: las clases de su unidad y lo que cuelga; súper admin: todo. La reflexión docente la ven el docente
--     y los admins de esa unidad. Ningún dato guarda nombres ni emails: se leen de la inscripción al mostrar.
do $$
declare t text; c text; i record; n bigint;
begin
  -- Una versión vieja de 002_live_class.sql (nunca ejecutada en producción) creaba estas tablas colgadas de
  -- live_sessions. Si existen con esa forma: vacías → se borran; con datos → se renombran a *_live_legacy.
  foreach t in array array['student_insights','teacher_insights'] loop
    c := case when t = 'student_insights' then 'enrollment_id' else 'is_demo' end;
    if to_regclass('public.' || t) is not null and not exists (
         select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c) then
      execute format('select count(*) from public.%I', t) into n;
      if n = 0 then execute format('drop table public.%I cascade', t);
      else
        for i in select indexname from pg_indexes where schemaname = 'public' and tablename = t loop
          execute format('alter index public.%I rename to %I', i.indexname, left(i.indexname, 50) || '_legacy');
        end loop;
        execute format('alter table public.%I rename to %I', t, t || '_live_legacy');
      end if;
    end if;
  end loop;
end $$;

create table if not exists public.teacher_insights (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.class_sessions(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,          -- encabezado, métricas, 13 áreas, qué funcionó, foco, próximo paso
  is_demo boolean not null default false,
  teacher_reflection text not null default '' check (length(teacher_reflection) <= 8000),
  reflection_at timestamptz,
  model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.student_insights (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  enrollment_id uuid not null references public.student_enrollments(id) on delete cascade,
  participant_id uuid,                               -- 002_live_class.sql: participante de la llamada (FK allí)
  data jsonb not null default '{}'::jsonb,           -- repaso, progreso, seguimiento, devolución, vocabulario
  is_demo boolean not null default false,
  teacher_message text not null default '' check (length(teacher_message) <= 4000),     -- borrador del docente
  published_message text not null default '' check (length(published_message) <= 4000), -- lo que ve el estudiante
  published_at timestamptz,
  model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_insights_session_enrollment unique (session_id, enrollment_id)
);
create index if not exists student_insights_enr_idx on public.student_insights (enrollment_id);
alter table public.teacher_insights enable row level security;
alter table public.student_insights enable row level security;
revoke all on public.teacher_insights, public.student_insights from anon, authenticated;
drop trigger if exists teacher_insights_touch on public.teacher_insights;
create trigger teacher_insights_touch before update on public.teacher_insights for each row execute function public.touch_updated_at();
drop trigger if exists student_insights_touch on public.student_insights;
create trigger student_insights_touch before update on public.student_insights for each row execute function public.touch_updated_at();

-- ── ayudas internas ──
-- Estudiantes de una clase: miembros del grupo + invitados por email
create or replace function public.tc_session_students(p_session uuid) returns table (enrollment_id uuid, name text, email text)
language sql stable security definer set search_path = public, pg_temp as
$$ select e.id, e.name, e.email from public.class_sessions s
     join public.group_members m on m.group_id = s.group_id
     join public.student_enrollments e on e.id = m.enrollment_id
    where s.id = p_session
   union
   select e.id, e.name, e.email from public.session_invitees si
     join public.student_enrollments e on e.id = si.enrollment_id
    where si.session_id = p_session $$;
-- ¿Puedo ver los insights de esta clase? Docente / suplente (o quien creó la clase suelta) y admins de su unidad.
create or replace function public.tc_can_view_insights(p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select auth.uid() is not null and exists (
     select 1 from public.class_sessions s
      where s.id = p_session and (public.teaches_session(s.id) or public.is_admin_of(s.institution_id))) $$;
-- Texto libre del docente: sin caracteres de control (se conservan los saltos de línea)
create or replace function public.tc_clean_note(p text, n integer) returns text
language sql immutable set search_path = public, pg_temp as
$$ select left(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), n) $$;
-- Lista resumida de insights de unas inscripciones (lo que ve el propio estudiante), más nuevas primero
create or replace function public.tc_insight_summaries(p_enr uuid[], p_limit integer) returns json
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(json_agg(x order by x.starts_at desc, x.id), '[]'::json) from (
     select si.id, si.session_id, coalesce(nullif(s.title, ''), g.name, '') as title, s.starts_at, s.ends_at, s.timezone,
            g.name as group_name, public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)) as teacher_name,
            left(coalesce(si.data #>> '{recap,summary}', ''), 280) as summary, coalesce(si.data->>'kind', '') as kind,
            si.published_at is not null as has_message, si.is_demo
       from public.student_insights si
       join public.class_sessions s on s.id = si.session_id
       left join public.class_groups g on g.id = s.group_id
      where si.enrollment_id = any(coalesce(p_enr, '{}'))
      order by s.starts_at desc, si.id limit greatest(coalesce(p_limit, 50), 0)) x $$;
revoke all on function public.tc_session_students(uuid) from public, anon, authenticated;
revoke all on function public.tc_can_view_insights(uuid) from public, anon, authenticated;
revoke all on function public.tc_clean_note(text, integer) from public, anon, authenticated;
revoke all on function public.tc_insight_summaries(uuid[], integer) from public, anon, authenticated;

-- ── generar insights de DEMOSTRACIÓN para una clase (de hoy o anterior, no cancelada) ──
-- Quién: su docente / suplente (o quien creó la clase suelta) o un admin de su unidad (súper admin incluido).
-- p_payload: el contenido de ejemplo que arma la app a partir de sus muestras (public/insights-view.js):
--   {kind: 'language'|'discipline', lang, subject, title, recap{summary,topics[]}, teacher{…}, students[{…}, …]}
-- Idempotente: si la clase ya tiene informe no se toca; cada estudiante recibe una fila una sola vez (los que se
-- suman después reciben la suya en la próxima llamada). Las filas quedan marcadas is_demo = true.
create or replace function public.generate_demo_insights(p_session uuid, p_payload jsonb) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; v_pool int; v_base jsonb; v_teacher boolean; v_n int := 0;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or not public.tc_can_view_insights(p_session) then raise exception 'No autorizado'; end if;
  if s.status = 'cancelled' then raise exception 'Una clase cancelada no tiene insights'; end if;
  if (s.starts_at at time zone s.timezone)::date > (now() at time zone s.timezone)::date then
    raise exception 'Los insights de demo se generan para clases de hoy o anteriores';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 262144
     or coalesce(p_payload->>'kind', '') not in ('language','discipline') or coalesce(p_payload->>'lang', '') !~ '^[a-z]{2}$'
     or jsonb_typeof(p_payload->'teacher') is distinct from 'object' or jsonb_typeof(p_payload->'recap') is distinct from 'object'
     or jsonb_typeof(p_payload->'students') is distinct from 'array'
     or jsonb_array_length(p_payload->'students') not between 1 and 24
     or exists (select 1 from jsonb_array_elements(p_payload->'students') x where jsonb_typeof(x) <> 'object') then
    raise exception 'Datos de demo inválidos';
  end if;
  v_pool := jsonb_array_length(p_payload->'students');
  v_base := jsonb_build_object('kind', p_payload->'kind', 'lang', p_payload->'lang', 'subject', coalesce(p_payload->'subject', '""'::jsonb),
                               'title', coalesce(p_payload->'title', '""'::jsonb), 'recap', p_payload->'recap');
  insert into public.teacher_insights (session_id, data, is_demo, model)
  values (s.id, (p_payload->'teacher') || v_base, true, 'demo')
  on conflict (session_id) do nothing;
  get diagnostics v_n = row_count; v_teacher := v_n > 0;
  insert into public.student_insights (session_id, enrollment_id, data, is_demo, model)
  select s.id, x.enrollment_id, ((p_payload->'students')->(((x.rn - 1) % v_pool)::int)) || v_base, true, 'demo'
    from (select st.enrollment_id, row_number() over (order by lower(coalesce(nullif(st.name, ''), st.email)), st.enrollment_id) as rn
            from public.tc_session_students(s.id) st) x
  on conflict (session_id, enrollment_id) do nothing;
  get diagnostics v_n = row_count;
  return json_build_object('session_id', s.id, 'teacher_created', v_teacher, 'students_created', v_n,
                           'students', (select count(*) from public.student_insights where session_id = s.id));
end $$;

-- ── listas ──
-- Clases con insights + clases recientes sin insights ("pending", para generar los de demo).
--   p_mine = true  → docente / suplente: mis clases (Docencia → Insights)
--   p_mine = false → admin: la unidad p_unit y todo lo que cuelga (súper admin: p_unit null = todo)
-- Filtros: grupo, docente (solo admin), rango de fechas (fecha local de la clase), búsqueda de estudiante
-- (nombre o email: solo de las clases que ya ve quien pregunta).
create or replace function public.list_insight_sessions(p_unit uuid default null, p_mine boolean default true,
  p_group uuid default null, p_teacher uuid default null, p_from date default null, p_to date default null, p_q text default null)
returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_me uuid := auth.uid(); v_mine boolean := coalesce(p_mine, true); v_units uuid[]; v_q text; v_root uuid;
begin
  if v_me is null then raise exception 'No autorizado'; end if;
  if not v_mine then
    if p_unit is null then
      if not public.is_superadmin() then raise exception 'No autorizado'; end if;
    else
      perform public.tc_assert_admin(p_unit);
      v_units := public.tc_unit_scope(p_unit);
    end if;
  end if;
  v_root := public.billing_root(public.my_institution());
  v_q := lower(btrim(coalesce(p_q, '')));
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  return (with sc as (
      select s.id, coalesce(nullif(s.title, ''), g.name, '') as title, s.starts_at, s.ends_at, s.timezone, s.status,
             s.group_id, g.name as group_name, i.name as unit_name,
             public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)) as teacher_name,
             case when not v_mine then 'admin' when g.id is not null and g.substitute_id = v_me then 'substitute' else 'teacher' end as role
        from public.class_sessions s
        join public.institutions i on i.id = s.institution_id
        left join public.class_groups g on g.id = s.group_id
       where (case when v_mine then (s.group_id is not null and v_me in (g.teacher_id, g.substitute_id))
                                     or (s.group_id is null and s.teacher_id = v_me and v_root = public.billing_root(s.institution_id))
                   else v_units is null or s.institution_id = any(v_units) end)
         and (p_group is null or s.group_id = p_group)
         and (p_teacher is null or (case when s.group_id is null then s.teacher_id = p_teacher else p_teacher in (g.teacher_id, g.substitute_id) end))
         and (p_from is null or (s.starts_at at time zone s.timezone)::date >= p_from)
         and (p_to is null or (s.starts_at at time zone s.timezone)::date <= p_to)),
    withins as (
      select sc.*, ti.id is not null as has_report, coalesce(ti.is_demo, false) as report_demo,
             coalesce(ti.teacher_reflection, '') <> '' as has_reflection,
             (select count(*) from public.student_insights si where si.session_id = sc.id)::int as students,
             (select count(*) from public.student_insights si where si.session_id = sc.id and si.published_at is not null)::int as published,
             exists (select 1 from public.student_insights si where si.session_id = sc.id and si.is_demo) as students_demo
        from sc left join public.teacher_insights ti on ti.session_id = sc.id
       where (ti.id is not null or exists (select 1 from public.student_insights si where si.session_id = sc.id))
         and (v_q = '' or exists (select 1 from public.student_insights si join public.student_enrollments e on e.id = si.enrollment_id
                                   where si.session_id = sc.id and (lower(e.name) like '%' || v_q || '%' or lower(e.email) like '%' || v_q || '%')))),
    grp as (
      select g.id, g.name, i.name as unit_name, g.teacher_id, g.substitute_id
        from public.class_groups g join public.institutions i on i.id = g.institution_id
       where case when v_mine then v_me in (g.teacher_id, g.substitute_id) else v_units is null or g.institution_id = any(v_units) end)
    select json_build_object(
      'scope', case when v_mine then 'mine' else 'unit' end,
      'unit', (select json_build_object('id', i.id, 'name', i.name) from public.institutions i where i.id = p_unit and not v_mine),
      'sessions', coalesce((select json_agg(json_build_object('id', w.id, 'title', w.title, 'starts_at', w.starts_at, 'ends_at', w.ends_at,
          'timezone', w.timezone, 'status', w.status, 'group_id', w.group_id, 'group_name', w.group_name, 'unit_name', w.unit_name,
          'teacher_name', w.teacher_name, 'role', w.role, 'has_report', w.has_report, 'has_reflection', w.has_reflection,
          'students', w.students, 'published', w.published, 'is_demo', w.report_demo or w.students_demo) order by w.starts_at desc, w.id)
        from (select * from withins order by starts_at desc, id limit 300) w), '[]'::json),
      'pending', case when v_q <> '' then '[]'::json else coalesce((select json_agg(json_build_object('id', p.id, 'title', p.title,
          'starts_at', p.starts_at, 'ends_at', p.ends_at, 'timezone', p.timezone, 'group_name', p.group_name, 'unit_name', p.unit_name,
          'teacher_name', p.teacher_name, 'role', p.role, 'students', (select count(*) from public.tc_session_students(p.id))::int)
          order by p.starts_at desc, p.id)
        from (select * from sc
               where sc.status = 'scheduled' and sc.starts_at > now() - interval '30 days'
                 and (sc.starts_at at time zone sc.timezone)::date <= (now() at time zone sc.timezone)::date
                 and not exists (select 1 from public.teacher_insights ti where ti.session_id = sc.id)
               order by sc.starts_at desc, sc.id limit 8) p), '[]'::json) end,
      'groups', coalesce((select json_agg(json_build_object('id', grp.id, 'name', grp.name, 'unit_name', grp.unit_name) order by lower(grp.name), grp.id)
        from (select * from grp order by lower(name) limit 500) grp), '[]'::json),
      'teachers', case when v_mine then '[]'::json else coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by lower(t.name), t.id)
        from (select distinct x.id, public.tc_person_name(x.id) as name
                from (select teacher_id as id from grp union select substitute_id from grp) x
               where x.id is not null and not (public.is_superadmin_id(x.id) and not public.is_superadmin())) t), '[]'::json) end));
end $$;

-- Una clase: informe del docente + insights de cada estudiante (con su nombre; nunca emails).
-- can_edit = docente / suplente (escribe la reflexión y los mensajes); los admins la ven en solo lectura.
create or replace function public.get_session_insights(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; g public.class_groups%rowtype; v_teach boolean;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or not public.tc_can_view_insights(p_session) then raise exception 'No autorizado'; end if;
  select * into g from public.class_groups where id = s.group_id;
  v_teach := public.teaches_session(p_session);
  return json_build_object(
    'session', json_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), g.name, ''), 'starts_at', s.starts_at,
       'ends_at', s.ends_at, 'timezone', s.timezone, 'status', s.status, 'group_id', s.group_id, 'group_name', g.name,
       'unit_name', (select name from public.institutions where id = s.institution_id),
       'teacher_name', public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)),
       'duration_min', round(extract(epoch from (s.ends_at - s.starts_at)) / 60)::int,
       'students_total', (select count(*) from public.tc_session_students(s.id))::int),
    'can_edit', v_teach,
    'role', case when not v_teach then 'admin' when g.id is not null and g.substitute_id = auth.uid() then 'substitute' else 'teacher' end,
    'teacher', (select json_build_object('id', ti.id, 'data', ti.data, 'is_demo', ti.is_demo, 'reflection', ti.teacher_reflection,
                  'reflection_at', ti.reflection_at, 'created_at', ti.created_at)
                  from public.teacher_insights ti where ti.session_id = s.id),
    'students', coalesce((select json_agg(json_build_object('id', si.id, 'enrollment_id', si.enrollment_id,
                   'name', coalesce(nullif(btrim(e.name), ''), split_part(e.email, '@', 1)), 'data', si.data, 'is_demo', si.is_demo,
                   'teacher_message', si.teacher_message, 'published_message', si.published_message, 'published_at', si.published_at)
                   order by lower(coalesce(nullif(btrim(e.name), ''), e.email)), si.id)
                   from public.student_insights si join public.student_enrollments e on e.id = si.enrollment_id
                  where si.session_id = s.id), '[]'::json));
end $$;

-- Reflexión del docente (solo su docente / suplente; los admins la leen)
create or replace function public.save_teacher_reflection(p_session uuid, p_reflection text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare r public.teacher_insights%rowtype;
begin
  if p_session is null or not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  update public.teacher_insights set teacher_reflection = public.tc_clean_note(p_reflection, 8000), reflection_at = now()
   where session_id = p_session returning * into r;
  if r.id is null then raise exception 'Todavía no hay insights para esta clase'; end if;
  return json_build_object('reflection', r.teacher_reflection, 'reflection_at', r.reflection_at);
end $$;

-- Mensaje del docente a un estudiante: guardar borrador (p_publish = false) o publicarlo (el estudiante lo ve).
create or replace function public.save_insight_message(p_insight uuid, p_message text, p_publish boolean default false) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_sess uuid; v_msg text := public.tc_clean_note(p_message, 4000); r public.student_insights%rowtype;
begin
  select session_id into v_sess from public.student_insights where id = p_insight;
  if v_sess is null or not public.teaches_session(v_sess) then raise exception 'No autorizado'; end if;
  if coalesce(p_publish, false) and v_msg = '' then raise exception 'Escribí un mensaje antes de publicarlo'; end if;
  update public.student_insights
     set teacher_message = v_msg,
         published_message = case when coalesce(p_publish, false) then v_msg else published_message end,
         published_at = case when coalesce(p_publish, false) then now() else published_at end
   where id = p_insight returning * into r;
  return json_build_object('teacher_message', r.teacher_message, 'published_message', r.published_message, 'published_at', r.published_at);
end $$;

-- ESTUDIANTE: mis insights (lista) y uno completo. Súper admin ("Ver como" estudiante): p_enrollment
-- (un grupo sin estudiante elegido = estudiante genérico: sin insights propios).
create or replace function public.my_insights(p_group uuid default null, p_enrollment uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_enr uuid[] := '{}';
begin
  if p_group is null and p_enrollment is null then
    if auth.uid() is null then raise exception 'No autorizado'; end if;
    v_enr := array(select id from public.student_enrollments where user_id = auth.uid());
  else
    if not public.is_superadmin() then raise exception 'No autorizado'; end if;
    if p_enrollment is not null then
      if not exists (select 1 from public.student_enrollments where id = p_enrollment) then raise exception 'No autorizado'; end if;
      v_enr := array[p_enrollment];
    end if;
  end if;
  return public.tc_insight_summaries(v_enr, 200);
end $$;

create or replace function public.my_insight(p_id uuid, p_enrollment uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare si public.student_insights%rowtype; s public.class_sessions%rowtype; g public.class_groups%rowtype; e public.student_enrollments%rowtype;
begin
  select * into si from public.student_insights where id = p_id;
  select * into e from public.student_enrollments where id = si.enrollment_id;
  if si.id is null or e.id is null then raise exception 'No autorizado'; end if;
  if p_enrollment is null then
    if auth.uid() is null or e.user_id is distinct from auth.uid() then raise exception 'No autorizado'; end if;
  elsif not public.is_superadmin() or si.enrollment_id <> p_enrollment then raise exception 'No autorizado';
  end if;
  select * into s from public.class_sessions where id = si.session_id;
  select * into g from public.class_groups where id = s.group_id;
  return json_build_object('id', si.id, 'session_id', s.id,
    'session', json_build_object('title', coalesce(nullif(s.title, ''), g.name, ''), 'starts_at', s.starts_at, 'ends_at', s.ends_at,
       'timezone', s.timezone, 'group_name', g.name, 'teacher_name', public.tc_person_name(coalesce(g.teacher_id, s.teacher_id)),
       'duration_min', round(extract(epoch from (s.ends_at - s.starts_at)) / 60)::int),
    'student_name', e.name, 'data', si.data, 'is_demo', si.is_demo,
    'message', case when si.published_at is not null then si.published_message else '' end,
    'published_at', si.published_at);
end $$;

-- Permisos de las funciones de la app
do $$
declare f text;
begin
  foreach f in array array[
    'generate_demo_insights(uuid, jsonb)',
    'list_insight_sessions(uuid, boolean, uuid, uuid, date, date, text)', 'get_session_insights(uuid)',
    'save_teacher_reflection(uuid, text)', 'save_insight_message(uuid, text, boolean)',
    'my_insights(uuid, uuid)', 'my_insight(uuid, uuid)',
    'list_groups(uuid)', 'list_students(uuid)', 'list_group_members(uuid)',
    'create_group(uuid, text, uuid, uuid, text, text, text)', 'update_group(uuid, text, uuid, uuid, text, text, text)', 'delete_group(uuid)',
    'add_student(uuid, text, text, uuid)', 'group_add_student(uuid, uuid)', 'group_remove_student(uuid, uuid)',
    'move_student(uuid, uuid, uuid)', 'remove_student(uuid)', 'import_students(uuid, jsonb, boolean, boolean)',
    'my_groups()', 'create_series(uuid, text, integer[], time, integer, date, date)',
    'update_series(uuid, text, integer[], time, integer, date)', 'cancel_series(uuid)',
    'create_session(uuid, text, timestamptz, integer, text, text[])', 'update_session(uuid, text, timestamptz, integer)',
    'cancel_session(uuid, boolean)', 'my_calendar(timestamptz, timestamptz)', 'session_people(uuid)',
    'unit_calendar(uuid, timestamptz, timestamptz)', 'claim_enrollments()', 'student_view(uuid, uuid)',
    'my_calendar_token(boolean)', 'session_notify_payload(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- ========== DOCUMENTO DE LA CLASE (uno por clase del calendario) ==========
-- Un documento colaborativo (tipo Google Docs) por clase: docente, suplente y estudiantes de la clase lo leen y
-- escriben a la vez; queda como registro después de la clase. Editor: Yjs + TipTap (public/class-doc.js).
-- QUIÉN:
--   · docente / suplente de la clase (o quien creó la clase suelta): leen, escriben, bloquean / desbloquean,
--     restauran versiones;
--   · estudiantes de la clase (miembros del grupo o invitados): leen y escriben, salvo que el docente lo bloquee;
--   · admins de la unidad (y de sus superiores) y súper admin: SOLO LECTURA. Nadie más.
-- CÓMO SE GUARDA (sin acceso directo a las tablas; todo por las funciones de abajo, que verifican el acceso):
--   · class_doc_updates: cada cambio (actualización Yjs) que manda un editor (classdoc_push). Se numeran en orden
--     (la fila de class_docs se bloquea al insertar), así quien lee nunca se saltea uno.
--   · class_docs.state: foto compacta (Y.encodeStateAsUpdate) hasta state_upto; un editor la manda cada tanto
--     (classdoc_snapshot) y los cambios ya incluidos se borran.
--   · class_doc_versions: versiones (cada 10 min mientras se edita, al terminar la clase, manuales, antes de
--     restaurar); máximo 20 por documento. Restaurar (solo docente) sube "generation" y los clientes recargan.
--   · class_doc_presence: quién tiene el documento abierto (nombre y color los pone la base, no el navegador).
-- TIEMPO REAL: los navegadores se avisan por Supabase Realtime en un canal PRIVADO "classdoc:<id de la clase>"
--   (políticas sobre realtime.messages al final de esta sección, con el mismo control de acceso). Por el canal
--   NUNCA viaja el contenido: solo "hay cambios, leé" y la posición del cursor; el contenido siempre se lee y se
--   escribe con estas funciones. Sin Realtime, la app consulta cada 2 segundos.
create table if not exists public.class_docs (
  session_id uuid primary key references public.class_sessions(id) on delete cascade,
  state bytea,                                       -- foto Yjs hasta state_upto (null = vacío)
  state_upto bigint not null default 0,              -- último cambio (class_doc_updates.id) incluido en state
  generation integer not null default 1,             -- sube al restaurar una versión
  locked boolean not null default false,             -- bloqueado por el docente: los estudiantes solo leen
  locked_at timestamptz,
  channel_key text not null default public.tc_new_token(),  -- canal de respaldo si los privados no están disponibles
  bytes integer not null default 0,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.class_doc_updates (
  id bigserial primary key,
  session_id uuid not null references public.class_docs(session_id) on delete cascade,
  generation integer not null,
  data bytea not null check (octet_length(data) between 1 and 262144),
  client_id text not null default '' check (length(client_id) <= 40),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists class_doc_updates_sess_idx on public.class_doc_updates (session_id, id);
create table if not exists public.class_doc_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_docs(session_id) on delete cascade,
  parts bytea[] not null,                            -- foto + cambios pendientes en ese momento (se aplican en orden)
  label text not null check (label in ('auto','class_end','manual','before_restore')),
  bytes integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists class_doc_versions_sess_idx on public.class_doc_versions (session_id, created_at desc);
create table if not exists public.class_doc_presence (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 40),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  color text not null default '#7c5cbf',
  role text not null default 'student',
  state jsonb not null default '{}'::jsonb,         -- solo la posición del cursor (máx. 2 KB)
  seen_at timestamptz not null default now(),
  primary key (session_id, client_id)
);
alter table public.class_docs         enable row level security;
alter table public.class_doc_updates  enable row level security;
alter table public.class_doc_versions enable row level security;
alter table public.class_doc_presence enable row level security;
revoke all on public.class_docs, public.class_doc_updates, public.class_doc_versions, public.class_doc_presence from anon, authenticated;
revoke all on sequence public.class_doc_updates_id_seq from anon, authenticated;
drop trigger if exists class_docs_hide_owner on public.class_docs;
create trigger class_docs_hide_owner before insert or update of updated_by on public.class_docs
  for each row execute function public.hide_superadmin_refs('updated_by');
drop trigger if exists class_doc_versions_hide_owner on public.class_doc_versions;
create trigger class_doc_versions_hide_owner before insert on public.class_doc_versions
  for each row execute function public.hide_superadmin_refs('created_by');

-- ── ayudas internas ──
-- Mi papel en el documento de esta clase: 'teacher' (docente / suplente / quien creó la clase suelta),
-- 'student' (asiste: miembro del grupo o invitado), 'admin' (admin de su unidad o súper admin: solo lectura) o null.
create or replace function public.tc_classdoc_role(p_session uuid) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select case when auth.uid() is null or s.id is null then null
               when public.teaches_session(s.id) then 'teacher'
               when public.tc_attends(s.id, auth.uid()) then 'student'
               when public.is_admin_of(s.institution_id) then 'admin' end
     from (select p_session as id) x left join public.class_sessions s on s.id = x.id $$;
-- Nombre que ven los demás en el documento (nunca el email): estudiante = nombre cargado por la institución
create or replace function public.tc_classdoc_name(p_session uuid, p_user uuid, p_role text) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(nullif(case when p_role = 'student' then
            (select btrim(e.name) from public.student_enrollments e
              where e.user_id = p_user
                and (exists (select 1 from public.group_members m join public.class_sessions s on s.group_id = m.group_id
                              where s.id = p_session and m.enrollment_id = e.id)
                     or exists (select 1 from public.session_invitees i where i.session_id = p_session and i.enrollment_id = e.id))
              order by e.created_at limit 1) end, ''),
          nullif(public.tc_person_name(p_user), ''), 'Participante') $$;
-- Color estable por persona y clase (paleta de la app)
create or replace function public.tc_classdoc_color(p_session uuid, p_user uuid) returns text
language sql immutable set search_path = public, pg_temp as
$$ select (array['#7c5cbf','#0891b2','#d97706','#059669','#db2777','#4f46e5','#b45309','#0f766e','#9333ea','#dc2626'])
          [1 + abs(hashtext(coalesce(p_session::text, '') || coalesce(p_user::text, ''))) % 10] $$;
-- base64 → bytea (null si no es base64 válido)
create or replace function public.tc_b64(p text) returns bytea
language plpgsql immutable set search_path = public, pg_temp as
$$ begin
  if p is null or p = '' or p !~ '^[A-Za-z0-9+/=[:space:]]+$' then return null; end if;
  return decode(p, 'base64');
exception when others then return null;
end $$;
create or replace function public.tc_b64e(p bytea) returns text
language sql immutable set search_path = public, pg_temp as $$ select translate(encode(p, 'base64'), E'\n\r', '') $$;
-- Guarda una versión con la foto + los cambios pendientes (máximo 20 por documento; "fin de clase" se conserva)
create or replace function public.tc_classdoc_add_version(p_session uuid, p_label text) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare d public.class_docs%rowtype; v_parts bytea[]; v_id uuid;
begin
  select * into d from public.class_docs where session_id = p_session;
  if d.session_id is null then return null; end if;
  v_parts := (case when d.state is not null then array[d.state] else '{}'::bytea[] end)
             || coalesce((select array_agg(u.data order by u.id) from public.class_doc_updates u
                           where u.session_id = p_session and u.generation = d.generation and u.id > d.state_upto), '{}'::bytea[]);
  if coalesce(array_length(v_parts, 1), 0) = 0 then return null; end if;
  insert into public.class_doc_versions (session_id, parts, label, bytes, created_by)
  values (p_session, v_parts, p_label, (select coalesce(sum(octet_length(x)), 0) from unnest(v_parts) x),
          case when p_label in ('manual','before_restore') then auth.uid() end)
  returning id into v_id;
  -- máximo 20 versiones y 40 MB por documento (TC-14): se borran las más viejas, la de "fin de clase" se conserva
  delete from public.class_doc_versions where id in (
    select id from (select id, row_number() over (order by (label = 'class_end') desc, created_at desc, id) rn,
                           sum(bytes) over (order by (label = 'class_end') desc, created_at desc, id) acc
                      from public.class_doc_versions where session_id = p_session) x
     where x.rn > 20 or (x.acc > 41943040 and x.rn > 1));
  return v_id;
end $$;
-- Crea la fila del documento (si falta) y la bloquea hasta el fin de la transacción: los cambios quedan numerados en orden
create or replace function public.tc_classdoc_lock_row(p_session uuid) returns public.class_docs
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare d public.class_docs%rowtype;
begin
  insert into public.class_docs (session_id) values (p_session) on conflict (session_id) do nothing;
  select * into d from public.class_docs where session_id = p_session for update;
  return d;
end $$;
-- Política de Realtime: ¿puedo escuchar (p_send = false) o mandar (true) en este canal? Solo canales "classdoc:<uuid>".
-- Mandar: docente y estudiantes de la clase (los admins solo escuchan). Por el canal no viaja contenido.
create or replace function public.tc_classdoc_rt_ok(p_topic text, p_send boolean) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_role text;
begin
  if p_topic is null or p_topic !~ '^classdoc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  v_role := public.tc_classdoc_role(substr(p_topic, 10)::uuid);
  return case when coalesce(p_send, false) then v_role in ('teacher','student') else v_role is not null end;
end $$;
revoke all on function public.tc_classdoc_role(uuid) from public, anon, authenticated;
revoke all on function public.tc_classdoc_name(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.tc_classdoc_color(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tc_b64(text) from public, anon, authenticated;
revoke all on function public.tc_b64e(bytea) from public, anon, authenticated;
revoke all on function public.tc_classdoc_add_version(uuid, text) from public, anon, authenticated;
revoke all on function public.tc_classdoc_lock_row(uuid) from public, anon, authenticated;
-- (las políticas de realtime.messages corren con el rol de quien se conecta: authenticated la necesita; solo responde sí/no)
revoke all on function public.tc_classdoc_rt_ok(text, boolean) from public, anon;
grant execute on function public.tc_classdoc_rt_ok(text, boolean) to authenticated;

-- ── funciones de la app ──
-- Abrir: la clase, mi papel, si puedo editar, la foto + los cambios pendientes y el canal de tiempo real.
create or replace function public.classdoc_open(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_role text := public.tc_classdoc_role(p_session); s public.class_sessions%rowtype; g public.class_groups%rowtype;
        d public.class_docs%rowtype;
begin
  if v_role is null then raise exception 'No autorizado'; end if;
  select * into s from public.class_sessions where id = p_session;
  select * into g from public.class_groups where id = s.group_id;
  select * into d from public.class_docs where session_id = p_session;
  return json_build_object(
    'session', json_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), g.name, ''), 'starts_at', s.starts_at,
       'ends_at', s.ends_at, 'timezone', s.timezone, 'status', s.status, 'group_id', s.group_id, 'group_name', g.name,
       'teacher_name', public.tc_person_name(coalesce(g.teacher_id, s.teacher_id))),
    'role', v_role,
    'can_edit', v_role = 'teacher' or (v_role = 'student' and not coalesce(d.locked, false)),
    'can_lock', v_role = 'teacher',
    'locked', coalesce(d.locked, false),
    'generation', coalesce(d.generation, 1),
    'state', case when d.state is not null then public.tc_b64e(d.state) end,
    'upto', coalesce(d.state_upto, 0),
    'updates', coalesce((select json_agg(json_build_object('id', u.id, 'd', public.tc_b64e(u.data), 'c', u.client_id) order by u.id)
                           from public.class_doc_updates u
                          where u.session_id = p_session and u.generation = d.generation and u.id > d.state_upto), '[]'::json),
    'channel', json_build_object('topic', 'classdoc:' || p_session::text, 'key', d.channel_key),
    'me', case when v_role in ('teacher','student') then json_build_object('name', public.tc_classdoc_name(p_session, auth.uid(), v_role),
            'color', public.tc_classdoc_color(p_session, auth.uid())) end,
    'versions', (select count(*) from public.class_doc_versions v where v.session_id = p_session),
    'updated_at', d.updated_at);
end $$;

-- Mandar un cambio (actualización Yjs en base64). Docente siempre; estudiantes si no está bloqueado; admins nunca.
create or replace function public.classdoc_push(p_session uuid, p_generation integer, p_update text, p_client text default '')
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_role text := public.tc_classdoc_role(p_session); d public.class_docs%rowtype; s public.class_sessions%rowtype;
        v_data bytea := public.tc_b64(p_update); v_id bigint; v_last timestamptz;
begin
  if v_role is null then raise exception 'No autorizado'; end if;
  if v_role not in ('teacher','student') then raise exception 'Solo lectura: no podés editar este documento'; end if;
  if v_data is null or octet_length(v_data) = 0 then raise exception 'Cambio inválido'; end if;
  if octet_length(v_data) > 262144 then raise exception 'Cambio demasiado grande'; end if;
  d := public.tc_classdoc_lock_row(p_session);
  if v_role = 'student' and d.locked then raise exception 'El docente bloqueó el documento'; end if;
  if p_generation is distinct from d.generation then raise exception 'Documento desactualizado: volvé a abrirlo'; end if;
  -- TC-14: tope por documento (20 MB entre foto y cambios sin compactar) y por persona (4 MB por minuto)
  if d.bytes + octet_length(v_data) > 20971520 then raise exception 'El documento llegó a su tamaño máximo'; end if;
  if not public.tc_rate_take('classdoc:' || auth.uid()::text, octet_length(v_data), 4194304, 60) then
    raise exception 'Demasiados cambios seguidos: esperá un momento';
  end if;
  select * into s from public.class_sessions where id = p_session;
  -- versiones automáticas: "fin de clase" (el estado al terminar, antes del primer cambio posterior) y cada 10 minutos
  if now() > s.ends_at and not exists (select 1 from public.class_doc_versions where session_id = p_session and label = 'class_end') then
    perform public.tc_classdoc_add_version(p_session, 'class_end');
  end if;
  select max(created_at) into v_last from public.class_doc_versions where session_id = p_session;
  if v_last is null or v_last < now() - interval '10 minutes' then perform public.tc_classdoc_add_version(p_session, 'auto'); end if;
  insert into public.class_doc_updates (session_id, generation, data, client_id, user_id)
  values (p_session, d.generation, v_data, left(coalesce(p_client, ''), 40), auth.uid()) returning id into v_id;
  update public.class_docs set updated_at = now(), updated_by = auth.uid(), bytes = bytes + octet_length(v_data) where session_id = p_session;
  return json_build_object('id', v_id, 'generation', d.generation);
end $$;

-- Leer los cambios desde p_after (+ quién está conectado). Si me quedé atrás (foto nueva o versión restaurada):
-- reset = true con la foto completa. Docente / estudiantes anuncian su presencia (p_presence = {cursor}).
create or replace function public.classdoc_pull(p_session uuid, p_after bigint default 0, p_generation integer default null,
                                                p_client text default '', p_presence jsonb default null)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_role text := public.tc_classdoc_role(p_session); d public.class_docs%rowtype; v_reset boolean; v_client text := left(coalesce(p_client, ''), 40);
begin
  if v_role is null then raise exception 'No autorizado'; end if;
  if p_presence is not null and v_role in ('teacher','student') and v_client <> '' then
    insert into public.class_doc_presence (session_id, client_id, user_id, name, color, role, state, seen_at)
    values (p_session, v_client, auth.uid(), public.tc_classdoc_name(p_session, auth.uid(), v_role), public.tc_classdoc_color(p_session, auth.uid()),
            v_role, case when jsonb_typeof(p_presence) = 'object' and octet_length(p_presence::text) <= 2048 then p_presence else '{}'::jsonb end, now())
    on conflict (session_id, client_id) do update
      set state = excluded.state, seen_at = now(), name = excluded.name, role = excluded.role
      where class_doc_presence.user_id = auth.uid();
    delete from public.class_doc_presence where session_id = p_session and seen_at < now() - interval '2 minutes';
  end if;
  select * into d from public.class_docs where session_id = p_session;
  v_reset := d.session_id is not null and (p_generation is distinct from d.generation or coalesce(p_after, 0) < d.state_upto);
  return json_build_object(
    'generation', coalesce(d.generation, 1), 'locked', coalesce(d.locked, false),
    'can_edit', v_role = 'teacher' or (v_role = 'student' and not coalesce(d.locked, false)),
    'reset', coalesce(v_reset, false),
    'state', case when v_reset and d.state is not null then public.tc_b64e(d.state) end,
    'upto', coalesce(d.state_upto, 0),
    'updates', coalesce((select json_agg(json_build_object('id', u.id, 'd', public.tc_b64e(u.data), 'c', u.client_id) order by u.id)
                           from (select * from public.class_doc_updates u
                                  where u.session_id = p_session and u.generation = d.generation
                                    and u.id > (case when v_reset then d.state_upto else greatest(coalesce(p_after, 0), d.state_upto) end)
                                  order by u.id limit 2000) u), '[]'::json),
    'presence', coalesce((select json_agg(json_build_object('client', pr.client_id, 'name', pr.name, 'color', pr.color, 'role', pr.role, 'state', pr.state)
                                          order by pr.name, pr.client_id)
                            from public.class_doc_presence pr
                           where pr.session_id = p_session and pr.client_id <> v_client and pr.seen_at > now() - interval '45 seconds'), '[]'::json));
end $$;

-- Foto compacta (la manda un editor cada tanto): reemplaza la foto y borra los cambios ya incluidos (hasta p_upto)
create or replace function public.classdoc_snapshot(p_session uuid, p_generation integer, p_state text, p_upto bigint)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_role text := public.tc_classdoc_role(p_session); d public.class_docs%rowtype; v_data bytea := public.tc_b64(p_state); v_max bigint;
begin
  if v_role is null then raise exception 'No autorizado'; end if;
  if v_role not in ('teacher','student') then raise exception 'Solo lectura: no podés editar este documento'; end if;
  if v_data is null then raise exception 'Cambio inválido'; end if;
  if octet_length(v_data) > 4194304 then raise exception 'El documento es demasiado grande'; end if;
  d := public.tc_classdoc_lock_row(p_session);
  if v_role = 'student' and d.locked then raise exception 'El docente bloqueó el documento'; end if;
  if p_generation is distinct from d.generation then raise exception 'Documento desactualizado: volvé a abrirlo'; end if;
  if coalesce(p_upto, -1) < d.state_upto then return json_build_object('ok', false, 'upto', d.state_upto); end if;
  select max(id) into v_max from public.class_doc_updates where session_id = p_session and generation = d.generation;
  if p_upto > greatest(coalesce(v_max, 0), d.state_upto) then raise exception 'Cambio inválido'; end if;
  update public.class_docs set state = v_data, state_upto = p_upto, bytes = octet_length(v_data), updated_at = now() where session_id = p_session;
  delete from public.class_doc_updates where session_id = p_session and id <= p_upto;
  return json_build_object('ok', true, 'upto', p_upto);
end $$;

-- Bloquear (los estudiantes solo leen) o desbloquear: solo docente / suplente
create or replace function public.classdoc_set_lock(p_session uuid, p_locked boolean) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare d public.class_docs%rowtype;
begin
  if public.tc_classdoc_role(p_session) is distinct from 'teacher' then raise exception 'No autorizado'; end if;
  d := public.tc_classdoc_lock_row(p_session);
  update public.class_docs set locked = coalesce(p_locked, false), locked_at = case when coalesce(p_locked, false) then now() end,
         updated_at = now(), updated_by = auth.uid()
   where session_id = p_session;
  return json_build_object('locked', coalesce(p_locked, false));
end $$;

-- Historial: versiones (cualquiera con acceso las ve) · una versión completa · guardar una ahora / fin de clase (docente)
create or replace function public.classdoc_versions(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if public.tc_classdoc_role(p_session) is null then raise exception 'No autorizado'; end if;
  return coalesce((select json_agg(json_build_object('id', v.id, 'label', v.label, 'created_at', v.created_at, 'bytes', v.bytes,
                     'by', case when v.created_by is not null then public.tc_person_name(v.created_by) end) order by v.created_at desc, v.id)
                     from public.class_doc_versions v where v.session_id = p_session), '[]'::json);
end $$;
create or replace function public.classdoc_version(p_version uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v public.class_doc_versions%rowtype;
begin
  select * into v from public.class_doc_versions where id = p_version;
  if v.id is null or public.tc_classdoc_role(v.session_id) is null then raise exception 'No autorizado'; end if;
  return json_build_object('id', v.id, 'session_id', v.session_id, 'label', v.label, 'created_at', v.created_at,
                           'parts', (select json_agg(public.tc_b64e(x) order by o) from unnest(v.parts) with ordinality t(x, o)));
end $$;
create or replace function public.classdoc_add_version(p_session uuid, p_label text default 'manual') returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_id uuid;
begin
  if public.tc_classdoc_role(p_session) is distinct from 'teacher' then raise exception 'No autorizado'; end if;
  if coalesce(p_label, '') not in ('manual','class_end') then raise exception 'Versión inválida'; end if;
  perform public.tc_classdoc_lock_row(p_session);
  if p_label = 'class_end' and exists (select 1 from public.class_doc_versions where session_id = p_session and label = 'class_end') then
    return json_build_object('id', null, 'created', false);
  end if;
  v_id := public.tc_classdoc_add_version(p_session, p_label);
  return json_build_object('id', v_id, 'created', v_id is not null);
end $$;
-- Restaurar una versión (solo docente / suplente): guarda la actual como "antes de restaurar", vuelve a esa versión y
-- sube generation (los navegadores abiertos recargan; los cambios de una generación vieja se rechazan).
create or replace function public.classdoc_restore(p_version uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v public.class_doc_versions%rowtype; d public.class_docs%rowtype; x bytea;
begin
  select * into v from public.class_doc_versions where id = p_version;
  if v.id is null or public.tc_classdoc_role(v.session_id) is distinct from 'teacher' then raise exception 'No autorizado'; end if;
  d := public.tc_classdoc_lock_row(v.session_id);
  perform public.tc_classdoc_add_version(v.session_id, 'before_restore');
  delete from public.class_doc_updates where session_id = v.session_id;
  update public.class_docs set generation = generation + 1, state = null, state_upto = 0, updated_at = now(), updated_by = auth.uid()
   where session_id = v.session_id returning * into d;
  foreach x in array v.parts loop
    insert into public.class_doc_updates (session_id, generation, data, client_id, user_id) values (v.session_id, d.generation, x, 'restore', auth.uid());
  end loop;
  return json_build_object('generation', d.generation, 'restored', v.id);
end $$;

-- Clases de un grupo (pasadas y próximas) para la tarjeta del grupo: docente / suplente o admin de su unidad
create or replace function public.group_sessions(p_group uuid, p_past_days integer default 60, p_future_days integer default 30)
returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype;
begin
  select * into g from public.class_groups where id = p_group;
  if g.id is null or not (public.teaches_group(p_group) or public.is_admin_of(g.institution_id)) then raise exception 'No autorizado'; end if;
  return json_build_object(
    'group', json_build_object('id', g.id, 'name', g.name, 'timezone', g.timezone, 'unit_name', (select name from public.institutions where id = g.institution_id)),
    'can_edit', public.teaches_group(p_group),
    'sessions', coalesce((select json_agg(json_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), g.name), 'starts_at', s.starts_at,
          'ends_at', s.ends_at, 'timezone', s.timezone, 'status', s.status, 'has_doc', d.session_id is not null,
          'doc_locked', coalesce(d.locked, false), 'doc_updated_at', d.updated_at) order by s.starts_at desc, s.id)
        from public.class_sessions s left join public.class_docs d on d.session_id = s.id
       where s.group_id = p_group
         and s.starts_at > now() - make_interval(days => least(greatest(coalesce(p_past_days, 60), 0), 400))
         and s.starts_at < now() + make_interval(days => least(greatest(coalesce(p_future_days, 30), 0), 400))), '[]'::json));
end $$;

-- Tiempo real: políticas del canal privado "classdoc:<id>" (solo si el proyecto tiene Realtime, como todo Supabase)
do $$
begin
  if to_regclass('realtime.messages') is not null and to_regproc('realtime.topic') is not null then
    execute 'drop policy if exists tc_classdoc_listen on realtime.messages';
    execute 'create policy tc_classdoc_listen on realtime.messages for select to authenticated using (public.tc_classdoc_rt_ok((select realtime.topic()), false))';
    execute 'drop policy if exists tc_classdoc_send on realtime.messages';
    execute 'create policy tc_classdoc_send on realtime.messages for insert to authenticated with check (public.tc_classdoc_rt_ok((select realtime.topic()), true))';
  end if;
end $$;

-- ========== ASISTENCIA ==========
-- Una fila por clase y estudiante (inscripción) en session_attendance; también la presencia del docente (kind 'teacher').
-- AUTOMÁTICA (hoy): al entrar a la sala desde "Entrar a clase" el navegador llama attendance_join; mientras está en la
--   sala manda attendance_heartbeat cada minuto y attendance_leave al salir (si se cierra la pestaña, el último latido
--   cuenta como salida). Tarde = entró más de N minutos después del inicio (N = institutions.attendance_late_minutes,
--   heredado de la unidad superior; 10 por defecto). Sin registro y con la clase terminada = ausente (se calcula al leer).
-- CORRECCIONES DEL DOCENTE: set_attendance (source 'teacher') gana sobre lo automático; null vuelve a lo automático.
-- PRIVACIDAD: el estudiante ve solo lo suyo (resumen en student_view); docente / suplente: sus grupos y clases;
--   admins: su unidad y lo que cuelga (solo lectura); súper admin: todo. Métricas: solo la tasa total.
-- PRÓXIMAMENTE (video real + IA): attendance_record_external (solo con la service key) recibe los eventos de la sala
--   de LiveKit (api/livekit/webhook.js: participant_joined / participant_left → source 'auto') y la participación que
--   estime la IA (source 'ai'); nunca pisa una corrección del docente.
alter table public.institutions add column if not exists attendance_late_minutes integer;
alter table public.institutions drop constraint if exists institutions_attendance_late_ok;
alter table public.institutions add constraint institutions_attendance_late_ok check (attendance_late_minutes is null or attendance_late_minutes between 0 and 120);
create table if not exists public.session_attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  enrollment_id uuid references public.student_enrollments(id) on delete cascade,   -- estudiante (null = docente)
  user_id uuid references auth.users(id) on delete set null,
  kind text not null default 'student' check (kind in ('student','teacher')),
  first_join timestamptz,
  last_seen timestamptz,
  last_leave timestamptz,
  seconds_present integer not null default 0 check (seconds_present >= 0),
  in_room boolean not null default false,
  joins integer not null default 0,
  auto_status text check (auto_status in ('present','late')),                      -- lo que calculó la sala al entrar
  status text check (status in ('present','late','absent','excused')),              -- corrección del docente (gana)
  source text not null default 'auto' check (source in ('auto','teacher','ai')),
  note text not null default '' check (length(note) <= 500),
  participation_seconds integer check (participation_seconds is null or participation_seconds >= 0),  -- IA (futuro)
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_attendance_kind check ((kind = 'student') = (enrollment_id is not null))
);
create unique index if not exists session_attendance_student on public.session_attendance (session_id, enrollment_id) where enrollment_id is not null;
create unique index if not exists session_attendance_teacher on public.session_attendance (session_id, user_id) where kind = 'teacher';
create index if not exists session_attendance_enr_idx on public.session_attendance (enrollment_id);
alter table public.session_attendance enable row level security;
revoke all on public.session_attendance from anon, authenticated;
drop trigger if exists session_attendance_touch on public.session_attendance;
create trigger session_attendance_touch before update on public.session_attendance for each row execute function public.touch_updated_at();
drop trigger if exists session_attendance_hide_owner on public.session_attendance;
create trigger session_attendance_hide_owner before insert or update of updated_by on public.session_attendance
  for each row execute function public.hide_superadmin_refs('updated_by');

-- ── ayudas internas ──
create or replace function public.tc_late_minutes(p_inst uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select i.attendance_late_minutes from public.institution_chain(p_inst) c join public.institutions i on i.id = c.id
                     where i.attendance_late_minutes is not null order by c.depth limit 1), 10) $$;
-- La inscripción con la que este usuario asiste a esta clase
create or replace function public.tc_session_enrollment(p_session uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as
$$ select e.id from public.student_enrollments e
    where p_user is not null and e.user_id = p_user
      and (exists (select 1 from public.group_members m join public.class_sessions s on s.group_id = m.group_id
                    where s.id = p_session and m.enrollment_id = e.id)
           or exists (select 1 from public.session_invitees i where i.session_id = p_session and i.enrollment_id = e.id))
    order by e.created_at limit 1 $$;
-- Estado que se muestra: corrección del docente › lo que calculó la sala › ausente si la clase terminó › pendiente
create or replace function public.tc_att_status(p_override text, p_auto text, p_first_join timestamptz, p_ends_at timestamptz) returns text
language sql stable set search_path = public, pg_temp as
$$ select coalesce(p_override, case when p_first_join is not null then coalesce(p_auto, 'present') end,
                   case when now() > p_ends_at then 'absent' else 'pending' end) $$;
-- Entrar / latido / salir: suma los segundos dentro del horario de la clase desde el último latido (si fue hace < 150 s)
create or replace function public.tc_att_touch(p_session uuid, p_mode text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; v_kind text; v_enr uuid; r public.session_attendance%rowtype; v_add integer := 0;
        v_now timestamptz := now(); v_late integer;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or auth.uid() is null then raise exception 'No autorizado'; end if;
  if public.teaches_session(p_session) then v_kind := 'teacher';
  else
    v_enr := public.tc_session_enrollment(p_session, auth.uid());
    if v_enr is null then raise exception 'No autorizado'; end if;
    v_kind := 'student';
  end if;
  if v_kind = 'student' and p_mode = 'join' then
    if s.status = 'cancelled' then raise exception 'La clase está cancelada'; end if;
    if v_now < s.starts_at - interval '10 minutes' or v_now > s.ends_at then raise exception 'La clase no está abierta ahora'; end if;
  end if;
  if v_kind = 'teacher' then
    select * into r from public.session_attendance where session_id = p_session and kind = 'teacher' and user_id = auth.uid() for update;
  else
    select * into r from public.session_attendance where session_id = p_session and enrollment_id = v_enr for update;
  end if;
  if r.id is null then
    if p_mode = 'leave' then return json_build_object('status', null, 'recorded', false); end if;
    if v_kind = 'student' and p_mode <> 'join' and (v_now < s.starts_at - interval '10 minutes' or v_now > s.ends_at or s.status = 'cancelled') then
      return json_build_object('status', null, 'recorded', false);
    end if;
    insert into public.session_attendance (session_id, enrollment_id, user_id, kind)
    values (p_session, v_enr, auth.uid(), v_kind) returning * into r;
  end if;
  if r.in_room and r.last_seen is not null and v_now - r.last_seen <= interval '150 seconds' then
    v_add := greatest(0, floor(extract(epoch from (least(v_now, s.ends_at) - greatest(r.last_seen, s.starts_at)))))::int;
  end if;
  v_late := public.tc_late_minutes(s.institution_id);
  update public.session_attendance
     set first_join = coalesce(first_join, v_now),
         auto_status = coalesce(auto_status, case when v_kind = 'student' then
                         case when v_now > s.starts_at + make_interval(mins => v_late) then 'late' else 'present' end end),
         joins = joins + case when p_mode = 'join' then 1 else 0 end,
         seconds_present = seconds_present + v_add,
         last_seen = v_now,
         in_room = p_mode <> 'leave',
         last_leave = case when p_mode = 'leave' then v_now else last_leave end
   where id = r.id returning * into r;
  return json_build_object('recorded', true, 'kind', v_kind, 'minutes', round(r.seconds_present / 60.0)::int,
    'status', case when v_kind = 'student' then public.tc_att_status(r.status, r.auto_status, r.first_join, s.ends_at) end);
end $$;
-- Resumen de asistencia de unas inscripciones (lo que ve el propio estudiante): clases terminadas y no canceladas de
-- sus grupos (desde el día en que lo sumaron al grupo) + las clases a las que lo invitaron
create or replace function public.tc_attendance_summary(p_enr uuid[]) returns json
language sql stable security definer set search_path = public, pg_temp as
$$ with exp as (
     select distinct on (s.id, x.enr) s.id as session_id, x.enr, s.ends_at, g.name as group_name, s.group_id
       from (select unnest(coalesce(p_enr, '{}')) as enr) x
       join public.class_sessions s on s.status = 'scheduled' and s.ends_at < now()
            and (exists (select 1 from public.group_members m where m.group_id = s.group_id and m.enrollment_id = x.enr
                          and s.starts_at >= date_trunc('day', m.created_at))
                 or exists (select 1 from public.session_invitees i where i.session_id = s.id and i.enrollment_id = x.enr))
       left join public.class_groups g on g.id = s.group_id),
   st as (
     select exp.*, public.tc_att_status(a.status, a.auto_status, a.first_join, exp.ends_at) as status
       from exp left join public.session_attendance a on a.session_id = exp.session_id and a.enrollment_id = exp.enr)
   select json_build_object(
     'held', count(*), 'attended', count(*) filter (where status in ('present','late')),
     'present', count(*) filter (where status = 'present'), 'late', count(*) filter (where status = 'late'),
     'absent', count(*) filter (where status = 'absent'), 'excused', count(*) filter (where status = 'excused'),
     'groups', coalesce((select json_agg(json_build_object('name', gg.group_name, 'held', gg.held, 'attended', gg.attended) order by lower(gg.group_name))
                           from (select coalesce(group_name, '') as group_name, count(*) as held, count(*) filter (where status in ('present','late')) as attended
                                   from st group by coalesce(group_name, '')) gg), '[]'::json))
   from st $$;
-- Tasa total de asistencia (Métricas del súper admin; sin nombres): presentes + tarde / esperados, clases terminadas del período
create or replace function public.tc_attendance_rate(p_since timestamptz, p_units uuid[]) returns json
language sql stable security definer set search_path = public, pg_temp as
$$ with exp as (
     select s.id, s.ends_at, x.enrollment_id from public.class_sessions s
       cross join lateral public.tc_session_students(s.id) x
      where s.status = 'scheduled' and s.starts_at >= p_since and s.ends_at < now()
        and (p_units is null or s.institution_id = any(p_units))),
   st as (select public.tc_att_status(a.status, a.auto_status, a.first_join, exp.ends_at) as status
            from exp left join public.session_attendance a on a.session_id = exp.id and a.enrollment_id = exp.enrollment_id)
   select json_build_object('expected', count(*) filter (where status <> 'excused'),
                            'attended', count(*) filter (where status in ('present','late')),
                            'rate', case when count(*) filter (where status <> 'excused') > 0
                                         then round(100.0 * count(*) filter (where status in ('present','late')) / count(*) filter (where status <> 'excused'), 1) end)
     from st $$;
revoke all on function public.tc_late_minutes(uuid) from public, anon, authenticated;
revoke all on function public.tc_session_enrollment(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tc_att_status(text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.tc_att_touch(uuid, text) from public, anon, authenticated;
revoke all on function public.tc_attendance_summary(uuid[]) from public, anon, authenticated;
revoke all on function public.tc_attendance_rate(timestamptz, uuid[]) from public, anon, authenticated;

-- ── funciones de la app ──
create or replace function public.attendance_join(p_session uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$ begin return public.tc_att_touch(p_session, 'join'); end $$;
create or replace function public.attendance_heartbeat(p_session uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$ begin return public.tc_att_touch(p_session, 'beat'); end $$;
create or replace function public.attendance_leave(p_session uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$ begin return public.tc_att_touch(p_session, 'leave'); end $$;

-- Lista de una clase (nombre, email, estado, minutos): docente / suplente (puede corregir) o admin de su unidad (lectura)
create or replace function public.session_attendance(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; g public.class_groups%rowtype; v_teach boolean;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or not (public.teaches_session(p_session) or public.is_admin_of(s.institution_id)) then raise exception 'No autorizado'; end if;
  select * into g from public.class_groups where id = s.group_id;
  v_teach := public.teaches_session(p_session);
  return (with people as (
      select st.enrollment_id, st.name, st.email from public.tc_session_students(p_session) st
      union
      select e.id, e.name, e.email from public.session_attendance a join public.student_enrollments e on e.id = a.enrollment_id
       where a.session_id = p_session),
    rows as (
      select p.*, a.first_join, a.last_leave, a.last_seen, a.in_room, a.seconds_present, a.joins, a.auto_status, a.status as override,
             a.source, coalesce(a.note, '') as note,
             public.tc_att_status(a.status, a.auto_status, a.first_join, s.ends_at) as eff
        from people p left join public.session_attendance a on a.session_id = p_session and a.enrollment_id = p.enrollment_id)
    select json_build_object(
      'session', json_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), g.name, ''), 'starts_at', s.starts_at, 'ends_at', s.ends_at,
         'timezone', s.timezone, 'status', s.status, 'group_id', s.group_id, 'group_name', g.name),
      'can_edit', v_teach, 'late_minutes', public.tc_late_minutes(s.institution_id),
      'started', now() >= s.starts_at, 'ended', now() > s.ends_at,
      'students', coalesce((select json_agg(json_build_object('enrollment_id', r.enrollment_id,
            'name', coalesce(nullif(btrim(r.name), ''), split_part(r.email, '@', 1)), 'email', r.email, 'status', r.eff,
            'auto_status', r.auto_status, 'override', r.override, 'source', coalesce(r.source, 'auto'), 'note', r.note,
            'minutes', round(coalesce(r.seconds_present, 0) / 60.0)::int, 'first_join', r.first_join, 'last_leave', r.last_leave,
            'joins', coalesce(r.joins, 0), 'in_room', coalesce(r.in_room, false) and r.last_seen > now() - interval '150 seconds')
            order by lower(coalesce(nullif(btrim(r.name), ''), r.email)), r.enrollment_id) from rows r), '[]'::json),
      'counts', (select json_build_object('present', count(*) filter (where eff = 'present'), 'late', count(*) filter (where eff = 'late'),
                   'absent', count(*) filter (where eff = 'absent'), 'excused', count(*) filter (where eff = 'excused'),
                   'pending', count(*) filter (where eff = 'pending'), 'total', count(*)) from rows),
      'staff', coalesce((select json_agg(json_build_object('name', public.tc_person_name(a.user_id), 'first_join', a.first_join,
                   'minutes', round(a.seconds_present / 60.0)::int) order by a.first_join)
                   from public.session_attendance a where a.session_id = p_session and a.kind = 'teacher' and a.user_id is not null), '[]'::json)));
end $$;

-- Corrección del docente / suplente: presente, tarde, ausente, justificado (o null = volver a lo automático) + nota
create or replace function public.set_attendance(p_session uuid, p_enrollment uuid, p_status text, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; r public.session_attendance%rowtype; v_status text := nullif(btrim(coalesce(p_status, '')), '');
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  if v_status is not null and v_status not in ('present','late','absent','excused') then raise exception 'Estado de asistencia inválido'; end if;
  if p_enrollment is null or not (exists (select 1 from public.tc_session_students(p_session) st where st.enrollment_id = p_enrollment)
                                  or exists (select 1 from public.session_attendance a where a.session_id = p_session and a.enrollment_id = p_enrollment)) then
    raise exception 'Ese estudiante no es de esta clase';
  end if;
  insert into public.session_attendance (session_id, enrollment_id, kind) values (p_session, p_enrollment, 'student')
  on conflict (session_id, enrollment_id) where enrollment_id is not null do nothing;
  update public.session_attendance
     set status = v_status, source = case when v_status is null then 'auto' else 'teacher' end,
         note = case when p_note is null then note else public.tc_clean_note(p_note, 500) end, updated_by = auth.uid()
   where session_id = p_session and enrollment_id = p_enrollment returning * into r;
  return json_build_object('status', public.tc_att_status(r.status, r.auto_status, r.first_join, s.ends_at), 'override', r.status,
                           'source', r.source, 'note', r.note);
end $$;

-- Informe del grupo: % de cada estudiante, presentes / tarde / ausentes / justificados y la matriz clases × estudiantes.
-- Docente / suplente del grupo o admin de su unidad. Rango: fechas locales del grupo (máx. 366 días; por defecto 90).
-- Emails: los que cargó esa institución (los ven el docente y los admins, como en la lista del grupo).
create or replace function public.attendance_report(p_group uuid, p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare g public.class_groups%rowtype; v_to date; v_from date;
begin
  select * into g from public.class_groups where id = p_group;
  if g.id is null or not (public.teaches_group(p_group) or public.is_admin_of(g.institution_id)) then raise exception 'No autorizado'; end if;
  v_to := coalesce(p_to, (now() at time zone g.timezone)::date);
  v_from := coalesce(p_from, v_to - 89);
  if v_from > v_to or v_to - v_from > 366 then raise exception 'Rango de fechas inválido'; end if;
  return (with ses as (
      select s.id, coalesce(nullif(s.title, ''), g.name) as title, s.starts_at, s.ends_at
        from public.class_sessions s
       where s.group_id = p_group and s.status = 'scheduled' and s.starts_at <= now()
         and (s.starts_at at time zone g.timezone)::date between v_from and v_to
       order by s.starts_at limit 200),
    stu as (
      select e.id as enrollment_id, e.name, e.email, m.created_at as since, true as member
        from public.group_members m join public.student_enrollments e on e.id = m.enrollment_id where m.group_id = p_group
      union all
      select e.id, e.name, e.email, null, false from public.student_enrollments e
       where exists (select 1 from public.session_attendance a join ses on ses.id = a.session_id where a.enrollment_id = e.id)
         and not exists (select 1 from public.group_members m where m.group_id = p_group and m.enrollment_id = e.id)),
    cell as (
      select stu.enrollment_id, ses.id as session_id, ses.starts_at,
             case when a.id is null and (not stu.member or ses.starts_at < date_trunc('day', stu.since)) then null
                  else public.tc_att_status(a.status, a.auto_status, a.first_join, ses.ends_at) end as status,
             a.source
        from stu cross join ses
        left join public.session_attendance a on a.session_id = ses.id and a.enrollment_id = stu.enrollment_id),
    agg as (
      select stu.*,
             (select count(*) from cell c where c.enrollment_id = stu.enrollment_id and c.status = 'present') as present,
             (select count(*) from cell c where c.enrollment_id = stu.enrollment_id and c.status = 'late') as late,
             (select count(*) from cell c where c.enrollment_id = stu.enrollment_id and c.status = 'absent') as absent,
             (select count(*) from cell c where c.enrollment_id = stu.enrollment_id and c.status = 'excused') as excused,
             (select coalesce(json_agg(json_build_object('s', c.status, 'src', c.source) order by c.starts_at, c.session_id), '[]'::json)
                from cell c where c.enrollment_id = stu.enrollment_id) as cells
        from stu)
    select json_build_object(
      'group', json_build_object('id', g.id, 'name', g.name, 'timezone', g.timezone, 'unit_name', (select name from public.institutions where id = g.institution_id)),
      'from', v_from, 'to', v_to, 'can_edit', public.teaches_group(p_group), 'late_minutes', public.tc_late_minutes(g.institution_id),
      'sessions', coalesce((select json_agg(json_build_object('id', ses.id, 'title', ses.title, 'starts_at', ses.starts_at, 'ends_at', ses.ends_at)
                              order by ses.starts_at, ses.id) from ses), '[]'::json),
      'students', coalesce((select json_agg(json_build_object('enrollment_id', a.enrollment_id,
            'name', coalesce(nullif(btrim(a.name), ''), split_part(a.email, '@', 1)), 'email', a.email, 'member', a.member,
            'present', a.present, 'late', a.late, 'absent', a.absent, 'excused', a.excused,
            'pct', case when a.present + a.late + a.absent > 0 then round(100.0 * (a.present + a.late) / (a.present + a.late + a.absent)) end,
            'cells', a.cells) order by a.member desc, lower(coalesce(nullif(btrim(a.name), ''), a.email)), a.enrollment_id) from agg a), '[]'::json),
      'totals', (select json_build_object('present', count(*) filter (where status = 'present'), 'late', count(*) filter (where status = 'late'),
                   'absent', count(*) filter (where status = 'absent'), 'excused', count(*) filter (where status = 'excused'),
                   'rate', case when count(*) filter (where status in ('present','late','absent')) > 0
                                then round(100.0 * count(*) filter (where status in ('present','late')) / count(*) filter (where status in ('present','late','absent'))) end)
                   from cell)));
end $$;

-- Retraso permitido de una unidad (admins): minutos después del inicio para contar "tarde" (null = heredar de la unidad superior)
create or replace function public.set_attendance_late_minutes(p_unit uuid, p_minutes integer) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  if p_minutes is not null and (p_minutes < 0 or p_minutes > 120) then raise exception 'Minutos inválidos (de 0 a 120)'; end if;
  update public.institutions set attendance_late_minutes = p_minutes where id = p_unit;
  return json_build_object('late_minutes', public.tc_late_minutes(p_unit), 'own', p_minutes);
end $$;

-- HOOK para el video real + IA (todavía no se usa): solo con la service key (api/livekit/webhook.js). Registra la
-- entrada / salida / segundos que informe LiveKit (p_source 'auto') o la participación que estime la IA ('ai').
-- Nunca pisa una corrección del docente (source 'teacher').
create or replace function public.attendance_record_external(p_session uuid, p_enrollment uuid, p_joined_at timestamptz,
  p_left_at timestamptz, p_seconds integer, p_participation_seconds integer default null, p_source text default 'auto')
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare s public.class_sessions%rowtype; r public.session_attendance%rowtype;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null or coalesce(p_source, '') not in ('auto','ai')
     or not exists (select 1 from public.tc_session_students(p_session) st where st.enrollment_id = p_enrollment) then
    raise exception 'Datos de asistencia inválidos';
  end if;
  insert into public.session_attendance (session_id, enrollment_id, kind) values (p_session, p_enrollment, 'student')
  on conflict (session_id, enrollment_id) where enrollment_id is not null do nothing;
  update public.session_attendance a
     set first_join = least(coalesce(a.first_join, p_joined_at), coalesce(p_joined_at, a.first_join)),
         auto_status = coalesce(a.auto_status, case when p_joined_at is null then null
                         when p_joined_at > s.starts_at + make_interval(mins => public.tc_late_minutes(s.institution_id)) then 'late' else 'present' end),
         last_leave = coalesce(p_left_at, a.last_leave), last_seen = greatest(coalesce(a.last_seen, p_left_at, p_joined_at), coalesce(p_left_at, p_joined_at)),
         seconds_present = greatest(a.seconds_present, coalesce(p_seconds, 0)),
         participation_seconds = coalesce(p_participation_seconds, a.participation_seconds),
         source = case when a.source = 'teacher' then 'teacher' else p_source end
   where a.session_id = p_session and a.enrollment_id = p_enrollment returning * into r;
  return json_build_object('status', public.tc_att_status(r.status, r.auto_status, r.first_join, s.ends_at), 'source', r.source);
end $$;
revoke all on function public.attendance_record_external(uuid, uuid, timestamptz, timestamptz, integer, integer, text) from public, anon, authenticated;
grant execute on function public.attendance_record_external(uuid, uuid, timestamptz, timestamptz, integer, integer, text) to service_role;

-- Permisos de las funciones de la app (documento de la clase + asistencia)
do $$
declare f text;
begin
  foreach f in array array[
    'classdoc_open(uuid)', 'classdoc_push(uuid, integer, text, text)', 'classdoc_pull(uuid, bigint, integer, text, jsonb)',
    'classdoc_snapshot(uuid, integer, text, bigint)', 'classdoc_set_lock(uuid, boolean)', 'classdoc_versions(uuid)',
    'classdoc_version(uuid)', 'classdoc_add_version(uuid, text)', 'classdoc_restore(uuid)', 'group_sessions(uuid, integer, integer)',
    'attendance_join(uuid)', 'attendance_heartbeat(uuid)', 'attendance_leave(uuid)', 'session_attendance(uuid)',
    'set_attendance(uuid, uuid, text, text)', 'attendance_report(uuid, date, date)', 'set_attendance_late_minutes(uuid, integer)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ========== IDENTIDAD DEL SÚPER ADMIN: oculta para admins y docentes ==========
-- Filas nuevas: created_by / invited_by / uploaded_by que apunten a un súper admin quedan en null.
drop trigger if exists institutions_hide_owner on public.institutions;
create trigger institutions_hide_owner before insert on public.institutions
  for each row execute function public.hide_superadmin_refs('created_by');
drop trigger if exists invitations_hide_owner on public.invitations;
create trigger invitations_hide_owner before insert or update of invited_by on public.invitations
  for each row execute function public.hide_superadmin_refs('invited_by');
drop trigger if exists idocs_hide_owner on public.institution_documents;
create trigger idocs_hide_owner before insert or update of uploaded_by on public.institution_documents
  for each row execute function public.hide_superadmin_refs('uploaded_by');
-- Filas que ya existían (se puede volver a ejecutar: después de la primera vez no cambia nada)
update public.institutions set created_by = null
 where created_by is not null and created_by in (select id from public.profiles where role = 'superadmin');
update public.invitations set invited_by = null
 where invited_by is not null and invited_by in (select id from public.profiles where role = 'superadmin');
update public.institution_documents set uploaded_by = null
 where uploaded_by is not null and uploaded_by in (select id from public.profiles where role = 'superadmin');

-- Cuentas que ya existían: plan por defecto para cada institución madre sin fila
insert into public.billing_accounts (root_id, seats, monthly_tokens)
select i.id, s.default_seats, s.default_monthly_tokens
  from public.institutions i cross join public.platform_settings s
 where i.parent_id is null and s.id
on conflict (root_id) do nothing;

-- ══ Aula en vivo (LiveKit): qué papel tiene quien llama en una clase del calendario ══
-- Lo usa api/class/token.js con el token del usuario antes de firmar el acceso a la sala.
-- Solo responde por quien llama: 'teacher' (docente o suplente), 'student' (inscripto o invitado),
-- 'admin' (admin de la unidad) o null. No revela nada de otras personas.
create or replace function public.live_room_role(p_session uuid) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select s.role from (select public.tc_classdoc_role(p_session) as role) s
    where exists (select 1 from public.class_sessions cs where cs.id = p_session and cs.status <> 'cancelled') $$;
revoke all on function public.live_room_role(uuid) from public, anon;
grant execute on function public.live_room_role(uuid) to authenticated;

-- ══════════ CONSENTIMIENTO DE GRABACIÓN (uno solo, por persona; 2026-10) ══════════
-- Una sola casilla: "Acepto que mis clases en TeroClass se graben (solo audio) y que la IA las analice para generar mis
-- insights y mejorar las clases" (grabación + análisis con IA + almacenamiento; el audio original se borra a los 30 días).
--   · Se pide la PRIMERA vez que la persona entra a cualquier sala (docentes también). Un "sí" queda guardado acá
--     (user_consents) y no se vuelve a pedir mientras siga vigente y la versión del texto coincida
--     (tc_consent_version(); se sube cuando cambia el texto y entonces se vuelve a preguntar).
--   · Menores de 18: el "sí" cuenta solo con nombre + email del tutor/a y su confirmación (lo exige la tabla).
--   · Un "no" NO queda guardado como respuesta: se vuelve a preguntar en la próxima clase. Cada "no" pide una
--     justificación obligatoria (consent_declines) que llega a los admins de la institución de esa persona
--     (estudiante: la/s institución/es que lo cargaron para esa clase; docente: su unidad).
--   · Revocar (desde el perfil) cierra el "sí" (revoked_at) y se vuelve a preguntar en la próxima clase.
--   · api/class/token.js NO confía en lo que manda el navegador: lee my_consent() con el token del usuario y pone
--     recorded / consent / minor / guardian_consent en la metadata de LiveKit (nunca datos del tutor/a).
-- Privacidad: cada persona ve solo lo suyo (RLS); los admins ven el estado de las personas que cargó su unidad (y
-- debajo) y las justificaciones dirigidas a ellas (consent_overview); nadie más. Escrituras: solo con estas funciones.
-- Relación con 002_live_class.sql: su tabla "consents" (por llamada y participante) queda como registro de auditoría
-- que escribe el servidor (service role) a partir de user_consents (columna user_consent_id); ver 002.
create or replace function public.tc_consent_version() returns text
language sql immutable set search_path = public, pg_temp as
$$ select '2026-10'::text $$;   -- = CONSENT_VERSION de public/live-class.js y api/class/token.js (tests/api-consent.test.mjs lo verifica)
revoke all on function public.tc_consent_version() from public, anon;
grant execute on function public.tc_consent_version() to authenticated, service_role;

create table if not exists public.user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null check (length(version) between 1 and 40),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('user','superseded')),
  is_minor boolean not null default false,
  guardian_name text check (guardian_name is null or length(guardian_name) between 1 and 120),
  guardian_email text check (guardian_email is null or public.tc_email_ok(guardian_email)),
  guardian_consent boolean not null default false,
  created_at timestamptz not null default now(),
  constraint user_consents_minor_guardian check (not is_minor or (guardian_name is not null and guardian_email is not null)),
  constraint user_consents_revoked check ((revoked_at is null) = (revoked_reason is null))
);
-- 2026-10 (P-10): el "sí" de un menor cuenta recién cuando el tutor/a lo confirma desde SU link (guardian_token);
-- antes alcanzaba con una casilla que marcaba el propio menor. guardian_consent = confirmado por el tutor/a.
alter table public.user_consents add column if not exists guardian_token text;
alter table public.user_consents add column if not exists guardian_confirmed_at timestamptz;
alter table public.user_consents add column if not exists guardian_declined_at timestamptz;
alter table public.user_consents add column if not exists guardian_token_expires_at timestamptz;
create unique index if not exists user_consents_guardian_token_idx on public.user_consents (guardian_token) where guardian_token is not null;
alter table public.user_consents drop constraint if exists user_consents_minor_guardian;
alter table public.user_consents add constraint user_consents_minor_guardian
  check (not is_minor or (guardian_name is not null and guardian_email is not null));
-- Una sola vez: los "sí" de menores que ya existían (casilla marcada por el propio menor) quedan esperando la
-- confirmación del tutor/a (no se graban hasta que confirme). Se les genera el link.
do $$
begin
  if not exists (select 1 from public.tc_schema_marks where key = '2026-10-minor-guardian-confirm') then
    update public.user_consents set guardian_consent = false, guardian_token = public.tc_new_token(),
           guardian_token_expires_at = now() + interval '30 days'
     where is_minor and revoked_at is null and guardian_confirmed_at is null;
    insert into public.tc_schema_marks (key) values ('2026-10-minor-guardian-confirm');
  end if;
end $$;
create unique index if not exists user_consents_one_active on public.user_consents (user_id) where revoked_at is null;
create index if not exists user_consents_user_idx on public.user_consents (user_id, granted_at desc);

create table if not exists public.consent_declines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  institution_id uuid references public.institutions(id) on delete cascade,   -- null = sin institución (solo súper admin)
  session_id uuid references public.class_sessions(id) on delete set null,     -- la clase a la que estaba entrando
  role text not null default 'student' check (role in ('student','teacher')),
  version text not null check (length(version) between 1 and 40),
  reason text not null default '' check (char_length(reason) <= 1000),   -- opcional desde 2026-10 (P-11)
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
-- 2026-10 (P-11): la justificación pasa a ser OPCIONAL (antes: obligatoria, mínimo 10 caracteres)
alter table public.consent_declines alter column reason set default '';
alter table public.consent_declines drop constraint if exists consent_declines_reason_check;
alter table public.consent_declines add constraint consent_declines_reason_check check (char_length(reason) <= 1000);
create index if not exists consent_declines_inst_idx on public.consent_declines (institution_id, created_at desc);
create index if not exists consent_declines_user_idx on public.consent_declines (user_id, created_at desc);

-- RLS: lectura directa solo de lo propio (y las justificaciones, también los admins de esa unidad); nadie escribe directo.
alter table public.user_consents enable row level security;
alter table public.consent_declines enable row level security;
revoke all on public.user_consents, public.consent_declines from anon, authenticated;
grant select on public.user_consents, public.consent_declines to authenticated;
drop policy if exists uc_select_own on public.user_consents;
create policy uc_select_own on public.user_consents for select to authenticated using (user_id = auth.uid());
drop policy if exists cd_select on public.consent_declines;
create policy cd_select on public.consent_declines for select to authenticated
  using (user_id = auth.uid() or public.is_admin_of(institution_id));

-- Estado del consentimiento de quien llama (lo usan el lobby, el perfil y api/class/token.js). Sin datos del tutor/a.
create or replace function public.my_consent() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare c public.user_consents%rowtype; v text := public.tc_consent_version(); v_rev timestamptz;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  select * into c from public.user_consents where user_id = auth.uid() and revoked_at is null;
  select max(revoked_at) into v_rev from public.user_consents where user_id = auth.uid() and revoked_reason = 'user';
  return json_build_object(
    'current_version', v,
    'status', case when c.id is null then case when v_rev is not null then 'revoked' else 'none' end
                   when c.version <> v then 'outdated' else 'granted' end,
    'granted', c.id is not null and c.version = v,
    'recorded', c.id is not null and c.version = v and (not c.is_minor or c.guardian_consent),
    'version', c.version, 'granted_at', c.granted_at, 'revoked_at', case when c.id is null then v_rev end,
    'minor', coalesce(c.is_minor, false), 'guardian_consent', case when c.is_minor then c.guardian_consent end,
    -- P-10: el menor ve el estado de la confirmación de su tutor/a y el link para mandárselo (solo su propia fila)
    'guardian_status', case when not coalesce(c.is_minor, false) then null when c.guardian_consent then 'confirmed'
                            when c.guardian_declined_at is not null then 'declined' else 'pending' end,
    'guardian_token', case when c.is_minor and not c.guardian_consent and c.guardian_declined_at is null
                                and coalesce(c.guardian_token_expires_at, now()) > now() then c.guardian_token end);
end $$;

-- "Sí" (una sola casilla). Menores: nombre + email del tutor/a; cuenta recién cuando el tutor/a confirma desde su link
-- (P-10, guardian_consent_respond). p_guardian_consent se ignora (lo marcaba el propio menor). Reemplaza un "sí" anterior.
create or replace function public.grant_recording_consent(p_version text, p_minor boolean default false, p_guardian_name text default null,
                                                          p_guardian_email text default null, p_guardian_consent boolean default false)
returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_minor boolean := coalesce(p_minor, false); v_name text := public.tc_clean_text(p_guardian_name, 120);
        v_email text := btrim(coalesce(p_guardian_email, ''));
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_version is distinct from public.tc_consent_version() then raise exception 'El texto del consentimiento cambió: recargá la página'; end if;
  if v_minor then
    if v_name = '' then raise exception 'Menores de 18: falta el nombre del tutor/a'; end if;
    if not public.tc_email_ok(v_email) then raise exception 'Menores de 18: email del tutor/a inválido'; end if;
    if lower(v_email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')) then
      raise exception 'Menores de 18: el email del tutor/a tiene que ser distinto del tuyo';
    end if;
  end if;
  update public.user_consents set revoked_at = now(), revoked_reason = 'superseded' where user_id = auth.uid() and revoked_at is null;
  insert into public.user_consents (user_id, version, is_minor, guardian_name, guardian_email, guardian_consent, guardian_token, guardian_token_expires_at)
  values (auth.uid(), p_version, v_minor, case when v_minor then v_name end, case when v_minor then v_email end, false,
          case when v_minor then public.tc_new_token() end, case when v_minor then now() + interval '30 days' end);
  return public.my_consent();
end $$;

-- Revocar desde el perfil: se vuelve a preguntar en la próxima clase.
create or replace function public.revoke_recording_consent() returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  update public.user_consents set revoked_at = now(), revoked_reason = 'user' where user_id = auth.uid() and revoked_at is null;
  return public.my_consent();
end $$;

-- "No" + justificación OPCIONAL (P-11, 2026-10; antes obligatoria). Si la persona escribe algo, le llega a la/s
-- institución/es de esa persona para esa clase (vacío = queda solo el "no aceptó", sin texto):
-- estudiante → las unidades que lo cargaron (grupo o invitación de la clase; sin clase: todas sus inscripciones);
-- docente → su unidad. Sin institución: queda con institution_id null (solo la ve la propia persona y el súper admin).
create or replace function public.decline_recording_consent(p_session uuid, p_reason text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_reason text := public.tc_clean_note(p_reason, 1000); v_role text; v_insts uuid[]; v_ids uuid[] := '{}'; v_id uuid; v_i uuid;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if exists (select 1 from public.user_consents where user_id = auth.uid() and revoked_at is null and version = public.tc_consent_version()) then
    raise exception 'Ya diste tu consentimiento';
  end if;
  if (select count(*) from public.consent_declines where user_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Demasiadas respuestas hoy: probá mañana';
  end if;
  if p_session is not null then
    if not exists (select 1 from public.class_sessions where id = p_session) then raise exception 'No autorizado'; end if;
    if public.teaches_session(p_session) then v_role := 'teacher';
    elsif public.tc_attends(p_session, auth.uid()) then v_role := 'student';
    else raise exception 'No autorizado'; end if;
  else
    v_role := case when coalesce(public.my_role(), '') in ('teacher','org_admin','superadmin') then 'teacher' else 'student' end;
  end if;
  -- un "sí" de una versión anterior ya no vale: se cierra
  update public.user_consents set revoked_at = now(), revoked_reason = 'superseded' where user_id = auth.uid() and revoked_at is null;
  if v_role = 'teacher' then
    v_insts := array_remove(array[public.my_institution()], null);
  elsif p_session is not null then
    v_insts := array(select distinct e.institution_id from public.student_enrollments e
                      where e.user_id = auth.uid()
                        and (exists (select 1 from public.group_members m join public.class_sessions s on s.group_id = m.group_id
                                      where s.id = p_session and m.enrollment_id = e.id)
                             or exists (select 1 from public.session_invitees i where i.session_id = p_session and i.enrollment_id = e.id)));
  else
    v_insts := array(select distinct e.institution_id from public.student_enrollments e where e.user_id = auth.uid());
  end if;
  if coalesce(array_length(v_insts, 1), 0) = 0 then v_insts := array[null::uuid]; end if;
  foreach v_i in array v_insts loop
    insert into public.consent_declines (user_id, institution_id, session_id, role, version, reason)
    values (auth.uid(), v_i, p_session, v_role, public.tc_consent_version(), v_reason) returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  return json_build_object('ids', to_json(v_ids), 'recorded', false, 'institutions', (select count(*) from unnest(v_insts) x where x is not null));
end $$;

-- ADMIN (unidad elegida + lo que cuelga): estado de cada persona que cargó (estudiantes) o que pertenece (docentes/admins)
-- y las justificaciones dirigidas a esas unidades. Nombre / email: los que cargó esa institución. El súper admin no aparece.
create or replace function public.consent_overview(p_unit uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v text := public.tc_consent_version(); v_scope uuid[];
begin
  perform public.tc_assert_admin(p_unit);
  v_scope := public.tc_unit_scope(p_unit);
  return json_build_object('version', v,
    'people', coalesce((select json_agg(json_build_object(
        'kind', x.kind, 'name', x.name, 'email', x.email, 'unit_id', x.institution_id, 'unit_name', i.name, 'linked', x.user_id is not null,
        'status', st.status, 'status_at', st.at, 'minor', coalesce(c.is_minor, false) and st.status = 'granted',
        'guardian_consent', case when c.is_minor and st.status = 'granted' then c.guardian_consent end,
        'declines', (select count(*) from public.consent_declines d2 where d2.user_id = x.user_id and d2.institution_id = any(v_scope)))
        order by lower(x.name), lower(x.email))
      from (select 'teacher'::text as kind, coalesce(nullif(btrim(p.name), ''), p.email) as name, p.email, p.institution_id, p.id as user_id
              from public.profiles p where p.institution_id = any(v_scope) and p.role in ('teacher','org_admin')
            union all
            select 'student', coalesce(nullif(btrim(e.name), ''), e.email), e.email, e.institution_id, e.user_id
              from public.student_enrollments e where e.institution_id = any(v_scope)) x
      join public.institutions i on i.id = x.institution_id
      left join public.user_consents c on c.user_id = x.user_id and c.revoked_at is null and c.version = v
      left join lateral (select max(d.created_at) as at from public.consent_declines d where d.user_id = x.user_id and d.institution_id = any(v_scope)) ld on true
      left join lateral (select max(u.revoked_at) as at from public.user_consents u where u.user_id = x.user_id and u.revoked_reason = 'user') lr on true
      cross join lateral (select case
          when x.user_id is null then 'pending'
          when c.id is not null then 'granted'
          when ld.at is not null and ld.at >= coalesce(lr.at, '-infinity'::timestamptz) then 'declined'
          when lr.at is not null then 'revoked'
          else 'pending' end as status) s0
      cross join lateral (select s0.status, case s0.status when 'granted' then c.granted_at when 'declined' then ld.at when 'revoked' then lr.at end as at) st
    ), '[]'::json),
    'declines', coalesce((select json_agg(json_build_object(
        'id', d.id, 'role', d.role, 'reason', d.reason, 'created_at', d.created_at, 'unit_id', d.institution_id, 'unit_name', i.name,
        'name', case when d.role = 'student' then coalesce((select coalesce(nullif(btrim(e.name), ''), e.email) from public.student_enrollments e
                                                            where e.user_id = d.user_id and e.institution_id = d.institution_id order by e.created_at limit 1), '')
                     else public.tc_person_name(d.user_id) end,
        'email', case when d.role = 'student' then (select e.email from public.student_enrollments e
                                                     where e.user_id = d.user_id and e.institution_id = d.institution_id order by e.created_at limit 1)
                      when public.is_superadmin_id(d.user_id) and not public.is_superadmin() then null
                      else (select p.email from public.profiles p where p.id = d.user_id) end,
        'session_id', d.session_id, 'class_title', coalesce(nullif(s.title, ''), g.name), 'class_starts_at', s.starts_at)
        order by d.created_at desc)
      from public.consent_declines d join public.institutions i on i.id = d.institution_id
      left join public.class_sessions s on s.id = d.session_id left join public.class_groups g on g.id = s.group_id
      where d.institution_id = any(v_scope)), '[]'::json));
end $$;

-- Cantidad de justificaciones nuevas (badge de Grupos) desde un momento dado.
create or replace function public.consent_new_declines(p_unit uuid, p_since timestamptz) returns integer
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  -- solo las que traen un motivo escrito (un "no" sin texto no es una novedad que haya que leer)
  return (select count(*)::int from public.consent_declines
           where institution_id = any(public.tc_unit_scope(p_unit)) and created_at > coalesce(p_since, '-infinity'::timestamptz)
             and btrim(reason) <> '');
end $$;

-- Métricas (súper admin): solo totales, sin nombres. Personas = docentes/admins de las unidades + inscripciones.
create or replace function public.platform_consent_counts(p_unit uuid default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v text := public.tc_consent_version(); v_units uuid[];
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if p_unit is not null then v_units := public.tc_unit_scope(p_unit); end if;
  return (with ppl as (
      select distinct coalesce(x.user_id::text, 'e:' || x.eid::text) as k, x.user_id from (
        select p.id as user_id, null::uuid as eid from public.profiles p
         where p.role in ('teacher','org_admin') and p.institution_id is not null and (v_units is null or p.institution_id = any(v_units))
        union all
        select e.user_id, e.id from public.student_enrollments e where v_units is null or e.institution_id = any(v_units)) x),
    st as (select case
        when ppl.user_id is null then 'pending'
        when exists (select 1 from public.user_consents c where c.user_id = ppl.user_id and c.revoked_at is null and c.version = v) then 'granted'
        when (select max(d.created_at) from public.consent_declines d where d.user_id = ppl.user_id)
             >= coalesce((select max(u.revoked_at) from public.user_consents u where u.user_id = ppl.user_id and u.revoked_reason = 'user'), '-infinity'::timestamptz)
          then 'declined'
        else 'pending' end as s from ppl)
    select json_build_object('version', v, 'people', count(*), 'granted', count(*) filter (where s = 'granted'),
                             'declined', count(*) filter (where s = 'declined'), 'pending', count(*) filter (where s = 'pending'))
      from st);
end $$;

-- Aviso por email a los admins (api/notify/consent.js, SOLO con la service key): justificaciones de esa persona de los
-- últimos 15 minutos que todavía no se avisaron. Las marca como avisadas. Destinatarios: org_admins de la unidad o de
-- sus superiores (nunca el súper admin).
create or replace function public.consent_decline_notify_payload(p_user uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare r json;
begin
  with due as (
    update public.consent_declines d set notified_at = now()
     where d.user_id = p_user and d.notified_at is null and d.institution_id is not null and d.created_at > now() - interval '15 minutes'
       and btrim(d.reason) <> ''   -- P-11: un "no" sin motivo no genera email
    returning d.*)
  select coalesce(json_agg(json_build_object(
      'id', due.id, 'role', due.role, 'reason', due.reason, 'created_at', due.created_at, 'unit_name', i.name,
      'name', case when due.role = 'student' then coalesce((select coalesce(nullif(btrim(e.name), ''), e.email) from public.student_enrollments e
                                                             where e.user_id = due.user_id and e.institution_id = due.institution_id order by e.created_at limit 1), '')
                   else coalesce((select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = due.user_id), '') end,
      'class_title', coalesce(nullif(s.title, ''), g.name), 'class_starts_at', s.starts_at, 'timezone', s.timezone,
      'recipients', coalesce((select json_agg(distinct p.email) from public.profiles p
                               where p.role = 'org_admin' and p.institution_id in (select c.id from public.institution_chain(due.institution_id) c)), '[]'::json))), '[]'::json)
    into r
    from due join public.institutions i on i.id = due.institution_id
    left join public.class_sessions s on s.id = due.session_id left join public.class_groups g on g.id = s.group_id;
  return r;
end $$;

do $$
declare f text;
begin
  foreach f in array array['my_consent()', 'grant_recording_consent(text, boolean, text, text, boolean)', 'revoke_recording_consent()',
    'decline_recording_consent(uuid, text)', 'consent_overview(uuid)', 'consent_new_declines(uuid, timestamptz)', 'platform_consent_counts(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.consent_decline_notify_payload(uuid) from public, anon, authenticated;
grant execute on function public.consent_decline_notify_payload(uuid) to service_role;

-- ══════════ AUDITORÍA PRE-LANZAMIENTO (2026-10): invitaciones, límites, plan de la clase, tutor/a, cuenta ══════════
-- Ver README → "Pre-launch fixes". Todo se puede volver a correr; nada de esto lee ni escribe datos de otras personas
-- fuera de las reglas de siempre (RLS + funciones security definer).

-- ── Invitaciones (TC-07, TC-16, P-03, P-04) ──
-- Las invitaciones ya no se escriben directo desde la app: solo con invite_member / cancel_invitation /
-- resend_invitation / respond_invitation. Los admins las leen (RLS) y la persona invitada ve las suyas.
drop policy if exists inv_all on public.invitations;
drop policy if exists inv_select on public.invitations;
create policy inv_select on public.invitations for select
  using (public.is_admin_of(institution_id) or user_id = auth.uid());

-- Invitaciones pendientes para MÍ (cuenta existente: por user_id; o por mi email verificado).
create or replace function public.my_invitations() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_email text; v_conf boolean;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  select lower(btrim(u.email)), u.email_confirmed_at is not null into v_email, v_conf from auth.users u where u.id = auth.uid();
  return coalesce((select json_agg(json_build_object(
      'id', i.id, 'role', i.role, 'institution_id', i.institution_id, 'unit_name', ins.name,
      'path', (select string_agg(x.name, ' › ' order by c.depth desc) from public.institution_chain(i.institution_id) c join public.institutions x on x.id = c.id),
      'invited_by', case when i.invited_by is null then 'TeroClass' else public.tc_person_name(i.invited_by) end,
      'created_at', i.created_at, 'expires_at', i.expires_at) order by i.created_at desc)
    from public.invitations i join public.institutions ins on ins.id = i.institution_id
   where public.tc_inv_pending(i)
     and (i.user_id = auth.uid() or (i.user_id is null and v_conf and lower(i.email) = v_email))), '[]'::json);
end $$;

-- Aceptar o rechazar una invitación pendiente. Aceptar aplica las mismas reglas de siempre (asientos, último admin).
create or replace function public.respond_invitation(p_id uuid, p_accept boolean) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare inv public.invitations%rowtype; me public.profiles%rowtype; v_email text; v_conf boolean;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  select lower(btrim(u.email)), u.email_confirmed_at is not null into v_email, v_conf from auth.users u where u.id = auth.uid();
  select * into inv from public.invitations i where i.id = p_id
     and (i.user_id = auth.uid() or (i.user_id is null and v_conf and lower(i.email) = v_email)) for update;
  if inv.id is null then raise exception 'No autorizado'; end if;
  if not public.tc_inv_pending(inv) then raise exception 'Esta invitación ya no está vigente'; end if;
  if not coalesce(p_accept, false) then
    update public.invitations set declined_at = now() where id = inv.id;
    return json_build_object('status', 'declined');
  end if;
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.role = 'superadmin' then raise exception 'No autorizado'; end if;
  if me.role = 'org_admin' and me.institution_id is not null and me.institution_id is distinct from inv.institution_id then
    perform public.assert_not_last_admin(me.institution_id);
  end if;
  perform public.assert_seat_for(inv.institution_id, me.id);
  update public.profiles set institution_id = inv.institution_id, role = inv.role where id = me.id;
  update public.invitations set accepted_at = now(), user_id = auth.uid() where id = inv.id;
  -- las demás invitaciones pendientes para mí quedan sin efecto (solo se pertenece a una unidad)
  update public.invitations i set declined_at = now()
   where i.id <> inv.id and i.accepted_at is null and i.declined_at is null and i.cancelled_at is null
     and (i.user_id = auth.uid() or lower(i.email) = v_email);
  return json_build_object('status', 'accepted', 'institution_id', inv.institution_id, 'role', inv.role);
end $$;

-- ADMIN: invitaciones de la unidad elegida y de todo lo que cuelga (pendientes, vencidas, aceptadas, rechazadas,
-- canceladas; las 300 más nuevas). Quién invitó: nombre (el súper admin aparece como "TeroClass").
create or replace function public.list_invitations(p_unit uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.tc_assert_admin(p_unit);
  return coalesce((select json_agg(x order by x.sort_key, x.created_at desc) from (
    select i.id, i.email, i.role, i.institution_id as unit_id, ins.name as unit_name, ins.slug as unit_slug,
           i.created_at, i.expires_at, i.accepted_at, i.declined_at, i.cancelled_at, i.last_sent_at,
           public.tc_inv_status(i) as status, i.user_id is not null as has_account,
           case when i.invited_by is null then 'TeroClass' else public.tc_person_name(i.invited_by) end as invited_by,
           case public.tc_inv_status(i) when 'pending' then 0 when 'expired' then 1 else 2 end as sort_key
      from public.invitations i join public.institutions ins on ins.id = i.institution_id
     where i.institution_id = any(public.tc_unit_scope(p_unit))
     order by i.created_at desc limit 300) x), '[]'::json);
end $$;

create or replace function public.cancel_invitation(p_id uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare inv public.invitations%rowtype;
begin
  select * into inv from public.invitations where id = p_id;
  if inv.id is null or not public.is_admin_of(inv.institution_id) then raise exception 'No autorizado'; end if;
  if inv.accepted_at is not null then raise exception 'Esta invitación ya fue aceptada'; end if;
  update public.invitations set cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  return 'cancelled';
end $$;

-- Reenviar: vuelve a estar vigente 14 días (también una vencida o cancelada; no una aceptada o rechazada).
create or replace function public.resend_invitation(p_id uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare inv public.invitations%rowtype;
begin
  select * into inv from public.invitations where id = p_id;
  if inv.id is null or not public.is_admin_of(inv.institution_id) then raise exception 'No autorizado'; end if;
  if inv.accepted_at is not null then raise exception 'Esta invitación ya fue aceptada'; end if;
  if inv.declined_at is not null then raise exception 'La persona rechazó esta invitación: invitala de nuevo'; end if;
  if inv.user_id is null then perform public.assert_seat_for(inv.institution_id, null); end if;
  update public.invitations set expires_at = now() + interval '14 days', cancelled_at = null, last_sent_at = now() where id = p_id;
  return (select json_build_object('id', i.id, 'email', i.email, 'role', i.role, 'unit_name', ins.name, 'unit_slug', ins.slug,
                                   'expires_at', i.expires_at, 'has_account', i.user_id is not null)
            from public.invitations i join public.institutions ins on ins.id = i.institution_id where i.id = p_id);
end $$;

-- Datos de una invitación para el email (api/notify/invite.js, con el token de quien invita): solo admins de esa unidad.
create or replace function public.invitation_notify_payload(p_id uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare inv public.invitations%rowtype;
begin
  select * into inv from public.invitations where id = p_id;
  if inv.id is null or not public.is_admin_of(inv.institution_id) or not public.tc_inv_pending(inv) then raise exception 'No autorizado'; end if;
  return (select json_build_object('id', inv.id, 'email', inv.email, 'role', inv.role, 'unit_name', ins.name, 'unit_slug', ins.slug,
                                   'expires_at', inv.expires_at, 'has_account', inv.user_id is not null,
                                   'inviter', public.tc_person_name(auth.uid()))
            from public.institutions ins where ins.id = inv.institution_id);
end $$;

do $$
declare f text;
begin
  foreach f in array array['my_invitations()', 'respond_invitation(uuid, boolean)', 'list_invitations(uuid)', 'cancel_invitation(uuid)',
                           'resend_invitation(uuid)', 'invitation_notify_payload(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.tc_inv_pending(public.invitations) from public, anon, authenticated;
revoke all on function public.tc_inv_status(public.invitations) from public, anon, authenticated;

-- ── Límites de envío de emails (TC-08): por persona y por día, antes de que exista RESEND_API_KEY ──
-- La API (notify/session, notify/invite, notify/guardian) lo pide con el token de quien manda, ANTES de enviar.
-- Topes: máximo 100 destinatarios por envío; por día (UTC) 30 envíos y 300 destinatarios (docentes/admins),
-- 3 envíos y 3 destinatarios para cuentas sin institución ni grupo (p. ej. el email al tutor/a).
create or replace function public.email_quota_take(p_kind text, p_recipients integer) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_role text := public.my_role(); v_staff boolean; v_n int := coalesce(p_recipients, 0); v_sends int; v_rcpt int;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_kind is null or p_kind not in ('session','invite','guardian','consent') then raise exception 'Tipo inválido'; end if;
  if v_n < 1 then return json_build_object('allowed', false, 'reason', 'none'); end if;
  if v_n > 100 then return json_build_object('allowed', false, 'reason', 'too_many_recipients', 'max', 100); end if;
  v_staff := v_role in ('teacher','org_admin','superadmin') and (public.my_institution() is not null or v_role = 'superadmin');
  v_sends := case when v_role = 'superadmin' then 200 when v_staff then 30 else 3 end;
  v_rcpt := case when v_role = 'superadmin' then 2000 when v_staff then 300 else 3 end;
  if not public.tc_rate_take('mail:n:' || auth.uid()::text, 1, v_sends, 86400) then
    return json_build_object('allowed', false, 'reason', 'daily_sends', 'max', v_sends);
  end if;
  if not public.tc_rate_take('mail:r:' || auth.uid()::text, v_n, v_rcpt, 86400) then
    return json_build_object('allowed', false, 'reason', 'daily_recipients', 'max', v_rcpt);
  end if;
  return json_build_object('allowed', true);
end $$;
revoke all on function public.email_quota_take(text, integer) from public, anon;
grant execute on function public.email_quota_take(text, integer) to authenticated;

-- ── Límite global por IP (TC-01): la API manda una clave HMAC de la IP (nunca la IP), así nadie puede adivinar ni
-- gastar el cupo de la IP de otra persona. También limita cuántas veces la llama una misma cuenta.
create or replace function public.ip_rate_hit(p_key text, p_limit integer, p_window_s integer) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_key is null or p_key !~ '^[a-z]{2,10}:[0-9a-f]{64}$' then raise exception 'Clave inválida'; end if;
  if p_limit is null or p_limit not between 1 and 100000 or p_window_s is null or p_window_s not between 10 and 86400 then
    raise exception 'Límite inválido';
  end if;
  if not public.tc_rate_take('iprl:' || auth.uid()::text, 1, 3000, 3600) then return false; end if;
  return public.tc_rate_take(p_key, 1, p_limit, p_window_s);
end $$;
revoke all on function public.ip_rate_hit(text, integer, integer) from public, anon;
grant execute on function public.ip_rate_hit(text, integer, integer) to authenticated;

-- ── Salas sueltas del aula en vivo (TC-13) ──
-- Una sala que no es de una clase del calendario se llama "<12 hex del docente>-<algo>". Solo puede entrar quien la
-- creó ('host') y el personal (docentes/admins) de la MISMA cuenta (institución madre) que quien la creó ('guest').
-- Estudiantes y cuentas sin institución: no (sus clases van por el calendario, que decide live_room_role).
create or replace function public.adhoc_room_access(p_owner_key text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare me public.profiles%rowtype;
begin
  if auth.uid() is null or p_owner_key is null or p_owner_key !~ '^[0-9a-f]{12}$' then return null; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.role not in ('teacher','org_admin','superadmin') then return null; end if;
  if replace(me.id::text, '-', '') like p_owner_key || '%' then return 'host'; end if;
  if me.institution_id is null then return null; end if;
  if exists (select 1 from public.profiles o
              where replace(o.id::text, '-', '') like p_owner_key || '%' and o.role in ('teacher','org_admin')
                and o.institution_id is not null and public.billing_root(o.institution_id) = public.billing_root(me.institution_id)) then
    return 'guest';
  end if;
  return null;
end $$;
revoke all on function public.adhoc_room_access(text) from public, anon;
grant execute on function public.adhoc_room_access(text) to authenticated;
-- Nombre visible en la sala (TC-27): lo decide la base, nunca el navegador. Inscripción: el nombre que cargó la
-- institución; si no, el del perfil.
create or replace function public.live_display_name(p_session uuid default null) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select left(coalesce(
     (select nullif(btrim(e.name), '') from public.student_enrollments e
       where p_session is not null and e.id = public.tc_session_enrollment(p_session, auth.uid())),
     (select nullif(btrim(p.name), '') from public.profiles p where p.id = auth.uid()),
     (select split_part(p.email, '@', 1) from public.profiles p where p.id = auth.uid()),
     'Participant'), 80) $$;
revoke all on function public.live_display_name(uuid) from public, anon;
grant execute on function public.live_display_name(uuid) to authenticated;

-- ── Plan de la clase (P-06): una planificación guardada adjunta a una clase del calendario ──
-- Solo el docente / suplente (o quien creó la clase suelta) adjunta o quita, y solo planificaciones propias.
create or replace function public.set_session_plan(p_session uuid, p_planning uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare v_title text;
begin
  if auth.uid() is null or not public.teaches_session(p_session) then raise exception 'No autorizado'; end if;
  if p_planning is not null then
    select pl.title into v_title from public.plannings pl where pl.id = p_planning and pl.owner_id = auth.uid();
    if not found then raise exception 'Esa planificación no es tuya'; end if;
  end if;
  update public.class_sessions set planning_id = p_planning where id = p_session;
  return json_build_object('planning_id', p_planning, 'planning_title', v_title);
end $$;
-- El plan de una clase para quien la da (docente / suplente / quien la creó): título, guía docente y parámetros.
-- A los estudiantes nunca (la guía tiene las respuestas): devuelve null.
create or replace function public.session_plan(p_session uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null or not public.teaches_session(p_session) then return null; end if;
  return (select json_build_object('id', pl.id, 'title', pl.title, 'content', coalesce(pl.data->>'content', ''),
                                   'params', coalesce(pl.data->'params', '{}'::jsonb), 'mine', pl.owner_id = auth.uid())
            from public.class_sessions s join public.plannings pl on pl.id = s.planning_id where s.id = p_session);
end $$;
revoke all on function public.set_session_plan(uuid, uuid) from public, anon;
grant execute on function public.set_session_plan(uuid, uuid) to authenticated;
revoke all on function public.session_plan(uuid) from public, anon;
grant execute on function public.session_plan(uuid) to authenticated;

-- ── Tutor/a de un menor (P-10): confirma o rechaza desde SU link (/tutor?t=<token>), sin cuenta ──
-- No es una verificación de identidad (eso queda pendiente: ver README); sí evita que el propio menor marque la casilla.
create or replace function public.guardian_consent_info(p_token text) returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare c public.user_consents%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return json_build_object('status', 'invalid'); end if;
  select * into c from public.user_consents where guardian_token = p_token;
  if c.id is null or c.revoked_at is not null then return json_build_object('status', 'invalid'); end if;
  if c.guardian_token_expires_at is not null and c.guardian_token_expires_at < now() and not c.guardian_consent then
    return json_build_object('status', 'expired');
  end if;
  return json_build_object(
    'status', case when c.guardian_consent then 'confirmed' when c.guardian_declined_at is not null then 'declined' else 'pending' end,
    'student', coalesce((select split_part(nullif(btrim(p.name), ''), ' ', 1) from public.profiles p where p.id = c.user_id), ''),
    'guardian_name', c.guardian_name, 'requested_at', c.granted_at);
end $$;
create or replace function public.guardian_consent_respond(p_token text, p_accept boolean) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as
$$
declare c public.user_consents%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Link inválido'; end if;
  select * into c from public.user_consents where guardian_token = p_token for update;
  if c.id is null or c.revoked_at is not null then raise exception 'Link inválido'; end if;
  if c.guardian_token_expires_at is not null and c.guardian_token_expires_at < now() and not c.guardian_consent then
    raise exception 'El link venció: pedile un link nuevo';
  end if;
  if coalesce(p_accept, false) then
    update public.user_consents set guardian_consent = true, guardian_confirmed_at = now(), guardian_declined_at = null where id = c.id;
  else
    update public.user_consents set guardian_consent = false, guardian_confirmed_at = null, guardian_declined_at = now() where id = c.id;
  end if;
  return public.guardian_consent_info(p_token);
end $$;
revoke all on function public.guardian_consent_info(text) from public;
grant execute on function public.guardian_consent_info(text) to anon, authenticated;
revoke all on function public.guardian_consent_respond(text, boolean) from public;
grant execute on function public.guardian_consent_respond(text, boolean) to anon, authenticated;
-- Para el email al tutor/a (api/notify/guardian.js, con el token del menor): solo su propio pedido pendiente.
create or replace function public.guardian_email_payload() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  return (select json_build_object('guardian_email', c.guardian_email, 'guardian_name', c.guardian_name, 'token', c.guardian_token,
                                   'student', coalesce((select nullif(btrim(p.name), '') from public.profiles p where p.id = c.user_id), ''))
            from public.user_consents c
           where c.user_id = auth.uid() and c.revoked_at is null and c.is_minor and not c.guardian_consent
             and c.guardian_token is not null and coalesce(c.guardian_token_expires_at, now()) > now());
end $$;
revoke all on function public.guardian_email_payload() from public, anon;
grant execute on function public.guardian_email_payload() to authenticated;

-- ── Mis datos (TC-21, derechos de acceso / portabilidad): todo lo mío, en JSON ──
create or replace function public.my_data_export() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  return json_build_object(
    'exported_at', now(),
    'profile', (select json_build_object('email', p.email, 'name', p.name, 'role', p.role, 'created_at', p.created_at,
                                         'institution', (select i.name from public.institutions i where i.id = p.institution_id))
                  from public.profiles p where p.id = auth.uid()),
    'plannings', coalesce((select json_agg(json_build_object('title', pl.title, 'created_at', pl.created_at, 'updated_at', pl.updated_at, 'data', pl.data)
                                           order by pl.created_at) from public.plannings pl where pl.owner_id = auth.uid()), '[]'::json),
    'enrollments', coalesce((select json_agg(json_build_object('institution', i.name, 'name', e.name, 'email', e.email, 'created_at', e.created_at))
                               from public.student_enrollments e join public.institutions i on i.id = e.institution_id
                              where e.user_id = auth.uid()), '[]'::json),
    'recording_consent', coalesce((select json_agg(json_build_object('version', c.version, 'granted_at', c.granted_at, 'revoked_at', c.revoked_at,
                                                                     'minor', c.is_minor, 'guardian_name', c.guardian_name, 'guardian_email', c.guardian_email,
                                                                     'guardian_confirmed_at', c.guardian_confirmed_at) order by c.granted_at)
                                     from public.user_consents c where c.user_id = auth.uid()), '[]'::json),
    'recording_declines', coalesce((select json_agg(json_build_object('created_at', d.created_at, 'reason', d.reason) order by d.created_at)
                                      from public.consent_declines d where d.user_id = auth.uid()), '[]'::json),
    'insights', coalesce((select json_agg(json_build_object('class', coalesce(nullif(s.title, ''), g.name), 'starts_at', s.starts_at,
                                                            'data', si.data, 'message', si.published_message) order by s.starts_at)
                            from public.student_insights si join public.student_enrollments e on e.id = si.enrollment_id
                            join public.class_sessions s on s.id = si.session_id left join public.class_groups g on g.id = s.group_id
                           where e.user_id = auth.uid()), '[]'::json),
    'attendance', coalesce((select json_agg(json_build_object('class', coalesce(nullif(s.title, ''), g.name), 'starts_at', s.starts_at,
                                                              'first_join', a.first_join, 'minutes', round(coalesce(a.seconds_present, 0) / 60.0)) order by s.starts_at)
                              from public.session_attendance a join public.class_sessions s on s.id = a.session_id
                              left join public.class_groups g on g.id = s.group_id where a.user_id = auth.uid()), '[]'::json));
end $$;
revoke all on function public.my_data_export() from public, anon;
grant execute on function public.my_data_export() to authenticated;
-- Antes de borrar la cuenta (api/account/delete.js): ¿se puede? (el súper admin y el último admin de una institución madre no)
create or replace function public.account_delete_check() returns json
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare me public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.role = 'superadmin' then return json_build_object('ok', false, 'reason', 'superadmin'); end if;
  if me.role = 'org_admin' and me.institution_id is not null
     and (select parent_id from public.institutions where id = me.institution_id) is null
     and public.org_admin_count(me.institution_id) <= 1 then
    return json_build_object('ok', false, 'reason', 'last_admin');
  end if;
  return json_build_object('ok', true);
end $$;
revoke all on function public.account_delete_check() from public, anon;
grant execute on function public.account_delete_check() to authenticated;

-- Que la API de Supabase vea enseguida las funciones nuevas
notify pgrst, 'reload schema';

select 'TeroClass: base creada OK' as resultado;
