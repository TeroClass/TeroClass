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
create index if not exists plannings_inst_idx on public.plannings (institution_id);

-- Columnas de marca de la institución
alter table public.institutions add column if not exists slug text unique;
alter table public.institutions add column if not exists color text default '#7c5cbf';
alter table public.institutions add column if not exists bg_color text default '#f0eef8';
alter table public.institutions add column if not exists font text default 'Inter';
alter table public.institutions add column if not exists admin_email text;
-- Si es true, quien se registra desde /org/<slug> entra directo como docente.
-- Si es false, solo se entra por invitación.
alter table public.institutions add column if not exists open_registration boolean not null default true;

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
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.my_institution() returns uuid
language sql stable security definer set search_path = public as
$$ select institution_id from public.profiles where id = auth.uid() $$;

create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'superadmin' from public.profiles where id = auth.uid()), false) $$;

-- ¿Ese usuario es súper admin? (uso interno: ocultar su identidad a los demás)
create or replace function public.is_superadmin_id(p_user uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select p_user is not null and exists (select 1 from public.profiles where id = p_user and role = 'superadmin') $$;
-- (lo usan las políticas RLS, que corren con el rol de quien consulta: authenticated necesita ejecutarla;
--  solo responde sí/no para un id que ya se conoce, y los ids del súper admin no se muestran a nadie)
revoke all on function public.is_superadmin_id(uuid) from public, anon;
grant execute on function public.is_superadmin_id(uuid) to authenticated;

-- Al insertar: si la columna indicada (argumento del trigger) apunta a un súper admin, queda en null.
-- Así ni su id ni su identidad aparecen en filas que leen admins y docentes (created_by, invited_by,
-- uploaded_by). Corre como el dueño de la función (puede consultar profiles).
create or replace function public.hide_superadmin_refs() returns trigger
language plpgsql security definer set search_path = public as
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
language sql stable security definer set search_path = public as
$$ with recursive up(id, parent_id, depth) as (
     select i.id, i.parent_id, 0 from public.institutions i where i.id = p_id
     union all
     select i.id, i.parent_id, up.depth + 1
       from public.institutions i join up on i.id = up.parent_id
      where up.depth < 10)
   select up.id, up.depth from up order by up.depth desc $$;

-- Ancestros (sin incluirse): padre, abuelo...
create or replace function public.institution_ancestors(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public as
$$ select c.id from public.institution_chain(p_id) c where c.depth > 0 order by c.depth desc $$;

-- Descendientes (sin incluirse): hijos, nietos...
create or replace function public.institution_descendants(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public as
$$ with recursive down(id, depth) as (
     select i.id, 1 from public.institutions i where i.parent_id = p_id
     union all
     select i.id, down.depth + 1
       from public.institutions i join down on i.parent_id = down.id
      where down.depth < 10)
   select down.id from down $$;

-- Nivel: 1 = institución madre, 2 = sede/facultad, 3 = cátedra/área
create or replace function public.institution_level(p_id uuid) returns integer
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.institution_chain(p_id) $$;

-- Cuántos niveles cuelgan debajo (0 = no tiene sub-unidades)
create or replace function public.institution_height(p_id uuid) returns integer
language sql stable security definer set search_path = public as
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
language sql stable security definer set search_path = public as
$$ select inst is not null and exists (
     select 1 from public.institution_chain(public.my_institution()) c where c.id = inst) $$;

-- Admin de una unidad = súper admin, o org_admin de esa unidad o de cualquiera de sus superiores
create or replace function public.is_admin_of(inst uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_superadmin() or (inst is not null and exists (
     select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'org_admin' and p.institution_id is not null
        and p.institution_id in (select c.id from public.institution_chain(inst) c))) $$;

-- ===== Plan y consumo: ayudas internas (sin acceso desde la app) =====
-- Mes de consumo: primer día del mes calendario en UTC
create or replace function public.billing_month() returns date
language sql stable set search_path = public as
$$ select date_trunc('month', now() at time zone 'utc')::date $$;

-- Cuenta de una unidad = su institución madre (la cima de la cadena)
create or replace function public.billing_root(p_inst uuid) returns uuid
language sql stable security definer set search_path = public as
$$ select c.id from public.institution_chain(p_inst) c order by c.depth desc limit 1 $$;

-- Asientos en uso: docentes + admins de toda la cuenta (madre y todo lo que cuelga)
create or replace function public.seats_used(p_root uuid) returns integer
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.profiles
    where role in ('teacher','org_admin') and institution_id is not null
      and (institution_id = p_root or institution_id in (select public.institution_descendants(p_root))) $$;

-- Plan vigente (si la cuenta todavía no tiene fila, valen los valores por defecto)
create or replace function public.billing_seats(p_root uuid) returns integer
language sql stable security definer set search_path = public as
$$ select coalesce((select a.seats from public.billing_accounts a where a.root_id = p_root),
                   (select s.default_seats from public.platform_settings s where s.id)) $$;

create or replace function public.seat_available(p_root uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select p_root is not null and public.seats_used(p_root) < public.billing_seats(p_root) $$;

-- Crea la fila del plan con los valores por defecto si falta (uso interno, escribe)
create or replace function public.ensure_billing_account(p_root uuid) returns void
language sql volatile security definer set search_path = public as
$$ insert into public.billing_accounts (root_id, seats, monthly_tokens)
   select p_root, s.default_seats, s.default_monthly_tokens from public.platform_settings s
    where s.id and p_root is not null and exists (select 1 from public.institutions i where i.id = p_root and i.parent_id is null)
   on conflict (root_id) do nothing $$;

-- Antes de sumar a alguien a una unidad: ¿queda un asiento en la cuenta? (si ya ocupa uno en la
-- misma cuenta, moverlo no cuesta otro). Error claro si no.
create or replace function public.assert_seat_for(p_inst uuid, p_user uuid default null) returns void
language plpgsql volatile security definer set search_path = public as
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
language plpgsql security definer set search_path = public as
$$
declare
  inv     public.invitations%rowtype;
  v_email text := lower(trim(coalesce(new.email, '')));
  v_slug  text := lower(trim(coalesce(new.raw_user_meta_data->>'org_slug', '')));
  v_role  text := 'teacher';
  v_inst  uuid;
begin
  if v_email <> '' then
    select * into inv from public.invitations
     where lower(email) = v_email and accepted_at is null
     order by created_at desc limit 1;
  end if;

  if inv.id is not null then
    v_role := inv.role;
    v_inst := inv.institution_id;
  elsif v_slug <> '' then
    -- Solo se entra por slug si la institución tiene el registro abierto
    select id into v_inst from public.institutions
     where slug = v_slug and open_registration
     limit 1;
  end if;

  -- Plan: sin asiento libre en la cuenta, la persona queda sin institución (el alta no falla)
  -- y la invitación sigue pendiente. La pantalla /org/<slug> ya avisa antes de registrarse.
  if v_inst is not null and not public.seat_available(public.billing_root(v_inst)) then
    v_inst := null; v_role := 'teacher'; inv := null;
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
language plpgsql security definer set search_path = public as
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
language plpgsql set search_path = public as
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
language plpgsql immutable set search_path = public as
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
language plpgsql set search_path = public as
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
language plpgsql security definer set search_path = public as
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
language plpgsql set search_path = public as
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
create policy prof_select on public.profiles for select
  using (id = auth.uid() or public.is_superadmin()
         or (institution_id is not null and role <> 'superadmin' and public.is_admin_of(institution_id)));
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
  with check (owner_id = auth.uid()
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
language plpgsql stable security definer set search_path = public as
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
language sql stable security definer set search_path = public as
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
language sql stable security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
$$
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  return json_build_object(
    'institutions', (select count(*) from public.institutions),
    'top_level',    (select count(*) from public.institutions where parent_id is null),
    'users',        (select count(*) from public.profiles),
    'teachers',     (select count(*) from public.profiles where role = 'teacher'),
    'admins',       (select count(*) from public.profiles where role = 'org_admin'),
    'classes',      (select count(*) from public.plannings),
    'ai_today',     (select coalesce(sum(count), 0) from public.ai_usage where day = (now() at time zone 'utc')::date),
    'ai_users_today', (select count(*) from public.ai_usage where day = (now() at time zone 'utc')::date and count > 0));
end $$;
revoke all on function public.platform_stats() from public, anon;
grant execute on function public.platform_stats() to authenticated;

-- Cantidad de org_admins de una institución (uso interno)
create or replace function public.org_admin_count(p_inst uuid) returns integer
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.profiles where institution_id = p_inst and role = 'org_admin' $$;
revoke all on function public.org_admin_count(uuid) from public, anon, authenticated;

-- Una institución madre no puede quedarse sin admin. Las sub-unidades sí (las siguen
-- administrando los admins de las unidades superiores). Uso interno.
create or replace function public.assert_not_last_admin(p_inst uuid) returns void
language plpgsql security definer set search_path = public as
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

-- Sumar a alguien a una institución (si ya tiene cuenta, directo; si no, invitación).
-- Devuelve 'added' | 'invited' | 'not_allowed' (esa cuenta no se puede invitar; al súper admin
-- que llama se le devuelve 'superadmin'). No revela a otros que ese email es del dueño.
create or replace function public.invite_member(p_inst uuid, p_email text, p_role text default 'teacher')
returns text
language plpgsql security definer set search_path = public as
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
    -- Se puede mover a alguien entre unidades que uno administra; si está en otra, no.
    if prof.institution_id is not null and prof.institution_id <> p_inst
       and not public.is_admin_of(prof.institution_id) then
      raise exception 'Esa persona ya pertenece a otra institución';
    end if;
    if prof.role = 'org_admin' and (prof.institution_id is distinct from p_inst or p_role <> 'org_admin') then
      perform public.assert_not_last_admin(prof.institution_id);
    end if;
    perform public.assert_seat_for(p_inst, prof.id);
    update public.profiles set institution_id = p_inst, role = p_role where id = prof.id;
    return 'added';
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
language plpgsql security definer set search_path = public as
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
language plpgsql security definer set search_path = public as
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
language plpgsql security definer set search_path = public as
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
language plpgsql security definer set search_path = public as
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
  delete from public.institutions where id = p_inst;
  return 'deleted';
end $$;
revoke all on function public.delete_institution(uuid) from public, anon;
grant execute on function public.delete_institution(uuid) to authenticated;

-- Súper admin: mover a una persona a otra unidad (o dejarla sin institución con null).
-- Mantiene su rol (sin institución queda como docente). Devuelve 'moved'.
create or replace function public.admin_move_member(p_user uuid, p_inst uuid)
returns text
language plpgsql security definer set search_path = public as
$$
declare t public.profiles%rowtype;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  select * into t from public.profiles where id = p_user;
  if t.id is null then raise exception 'No autorizado'; end if;
  if t.role = 'superadmin' then raise exception 'No se puede modificar al súper admin'; end if;
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
-- usuario sin institución 15.
create or replace function public.ai_daily_limit(p_uid uuid) returns integer
language sql stable security definer set search_path = public as
$$ select case
     when p.role = 'superadmin' then 500
     when p.role = 'org_admin' and p.institution_id is not null then 150
     when p.institution_id is not null then 60
     else 15 end
   from (select null) x left join public.profiles p on p.id = p_uid $$;
revoke all on function public.ai_daily_limit(uuid) from public, anon, authenticated;

create or replace function public.consume_ai_quota() returns json
language plpgsql volatile security definer set search_path = public as
$$
declare
  v_uid   uuid := auth.uid();
  v_day   date := (now() at time zone 'utc')::date;
  v_limit integer;
  v_used  integer;
begin
  if v_uid is null then raise exception 'No autorizado'; end if;
  v_limit := public.ai_daily_limit(v_uid);
  insert into public.ai_usage as a (user_id, day, count) values (v_uid, v_day, 1)
  on conflict (user_id, day) do update set count = a.count + 1 where a.count < v_limit
  returning a.count into v_used;
  if v_used is null then
    select count into v_used from public.ai_usage where user_id = v_uid and day = v_day;
    return json_build_object('allowed', false, 'used', v_used, 'limit', v_limit);
  end if;
  return json_build_object('allowed', true, 'used', v_used, 'limit', v_limit);
end $$;
revoke all on function public.consume_ai_quota() from public, anon;
grant execute on function public.consume_ai_quota() to authenticated;

-- Consultar el uso de hoy sin gastar (para mostrar en la app)
create or replace function public.get_ai_quota() returns json
language plpgsql stable security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
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
language plpgsql volatile security definer set search_path = public as
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
language sql stable security definer set search_path = public as $$ select true $$;
revoke all on function public.billing_service_ping() from public, anon, authenticated;
grant execute on function public.billing_service_ping() to service_role;

-- ── Funciones para la APP (con permisos) ──
-- ¿Quién ve el consumo de una cuenta? El súper admin y los org_admin de cualquier unidad de esa cuenta.
create or replace function public.can_view_billing(p_root uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select p_root is not null and (public.is_superadmin() or (
     public.my_role() = 'org_admin' and public.my_institution() is not null
     and public.billing_root(public.my_institution()) = p_root)) $$;
revoke all on function public.can_view_billing(uuid) from public, anon, authenticated;

-- Asientos de una cuenta: {root_id, seats, used, available, full}
create or replace function public.get_seat_status(p_root uuid default null) returns json
language plpgsql stable security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
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
language plpgsql volatile security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
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
language plpgsql volatile security definer set search_path = public as
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
language plpgsql volatile security definer set search_path = public as
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
language plpgsql volatile security definer set search_path = public as
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
language plpgsql stable security definer set search_path = public as
$$
declare v_month date := public.billing_month(); s public.platform_settings%rowtype;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  select * into s from public.platform_settings where id;
  return json_build_object(
    'month', v_month,
    'settings', json_build_object('pack_tokens', s.pack_tokens, 'pack_price', s.pack_price, 'currency', s.currency,
      'personal_monthly_tokens', s.personal_monthly_tokens, 'default_seats', s.default_seats, 'default_monthly_tokens', s.default_monthly_tokens),
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

-- Que la API de Supabase vea enseguida las funciones nuevas
notify pgrst, 'reload schema';

select 'TeroClass: base creada OK' as resultado;
