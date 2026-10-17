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
--   El rol de súper admin solo se otorga si el email ya está confirmado o si
--   todavía no existe ningún súper admin (primer arranque).

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

-- Uso diario de IA por usuario (lo maneja solo consume_ai_quota; sin acceso directo)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

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

create or replace function public.is_admin_of(inst uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_superadmin() or exists (
     select 1 from public.profiles
     where id = auth.uid() and role = 'org_admin' and institution_id = inst) $$;

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

  -- Súper admin: solo con email confirmado, o si todavía no hay ninguno (primer arranque)
  if v_email = 'im.silveiratrabal@gmail.com'
     and (new.email_confirmed_at is not null
          or not exists (select 1 from public.profiles where role = 'superadmin')) then
    v_role := 'superadmin';
  end if;

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
  if lower(trim(coalesce(new.email, ''))) = 'im.silveiratrabal@gmail.com'
     and new.email_confirmed_at is not null then
    update public.profiles set role = 'superadmin' where id = new.id and role <> 'superadmin';
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
  end if;
  return new;
end $$;
drop trigger if exists institutions_protect on public.institutions;
create trigger institutions_protect before insert or update on public.institutions
  for each row execute function public.protect_institution();

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
  using (public.is_superadmin() or id = public.my_institution());
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
         or (institution_id is not null and public.is_admin_of(institution_id)));
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
         or (institution_id is not null and public.is_admin_of(institution_id)));
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
drop function if exists public.get_org_branding(text);
create function public.get_org_branding(p_slug text)
returns table (name text, slug text, color text, bg_color text, font text, logo_url text, open_registration boolean)
language sql stable security definer set search_path = public as
$$ select name, slug, color, bg_color, font, logo_url, open_registration
     from public.institutions where slug = lower(trim(p_slug)) limit 1 $$;
grant execute on function public.get_org_branding(text) to anon, authenticated;

-- Cantidad de org_admins de una institución (uso interno)
create or replace function public.org_admin_count(p_inst uuid) returns integer
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.profiles where institution_id = p_inst and role = 'org_admin' $$;
revoke all on function public.org_admin_count(uuid) from public, anon, authenticated;

-- Sumar a alguien a una institución (si ya tiene cuenta, directo; si no, invitación).
-- Devuelve 'added' | 'invited' | 'superadmin' (el dueño de la plataforma no se toca).
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
    if prof.role = 'superadmin' then return 'superadmin'; end if;
    if prof.institution_id is not null and prof.institution_id <> p_inst then
      raise exception 'Esa persona ya pertenece a otra institución';
    end if;
    if prof.role = 'org_admin' and prof.institution_id = p_inst and p_role <> 'org_admin' then
      perform 1 from public.profiles where institution_id = p_inst and role = 'org_admin' for update;
      if public.org_admin_count(p_inst) <= 1 then
        raise exception 'No se puede quitar el último administrador de la institución';
      end if;
    end if;
    update public.profiles set institution_id = p_inst, role = p_role where id = prof.id;
    return 'added';
  end if;

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
  if t.role = 'superadmin' then raise exception 'No se puede modificar al súper admin'; end if;
  if t.role = 'org_admin' and p_role <> 'org_admin' then
    perform 1 from public.profiles where institution_id = t.institution_id and role = 'org_admin' for update;
    if public.org_admin_count(t.institution_id) <= 1 then
      raise exception 'No se puede quitar el último administrador de la institución';
    end if;
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
  if t.role = 'superadmin' then raise exception 'No se puede modificar al súper admin'; end if;
  if t.role = 'org_admin' then
    perform 1 from public.profiles where institution_id = t.institution_id and role = 'org_admin' for update;
    if public.org_admin_count(t.institution_id) <= 1 then
      raise exception 'No se puede quitar el último administrador de la institución';
    end if;
  end if;
  update public.profiles set institution_id = null, role = 'teacher' where id = p_user;
  return 'removed';
end $$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;

-- Crear institución (solo super admin) y asignar su admin
create or replace function public.create_institution(p_name text, p_slug text, p_admin_email text, p_color text default '#7c5cbf')
returns uuid
language plpgsql security definer set search_path = public as
$$
declare
  new_id  uuid;
  v_slug  text := lower(trim(coalesce(p_slug, '')));
  v_email text := lower(trim(coalesce(p_admin_email, '')));
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Nombre requerido'; end if;
  if v_slug !~ '^[a-z0-9-]{2,60}$' then
    raise exception 'Slug inválido: usa de 2 a 60 letras minúsculas, números o guiones';
  end if;
  insert into public.institutions (name, slug, color, admin_email, created_by)
  values (trim(p_name), v_slug, coalesce(nullif(trim(p_color), ''), '#7c5cbf'), nullif(v_email, ''), auth.uid())
  returning id into new_id;
  if v_email <> '' then
    perform public.invite_member(new_id, v_email, 'org_admin');
  end if;
  return new_id;
end $$;
revoke all on function public.create_institution(text, text, text, text) from public, anon;
grant execute on function public.create_institution(text, text, text, text) to authenticated;

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

-- Si ya te registraste (y confirmaste) con este email, te deja como súper admin
update public.profiles p set role = 'superadmin'
  from auth.users u
 where u.id = p.id
   and lower(trim(u.email)) = 'im.silveiratrabal@gmail.com'
   and p.role <> 'superadmin'
   and (u.email_confirmed_at is not null
        or not exists (select 1 from public.profiles s where s.role = 'superadmin'));

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
  using (institution_id = public.my_institution() or public.is_admin_of(institution_id));
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

select 'TeroClass: base creada OK' as resultado;
