-- TeroClass · Fase 1 · Base de datos
-- Pegar completo en Supabase → SQL Editor → New query → Run

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

-- Al registrarse: crear perfil y aplicar invitación pendiente
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as
$$
declare inv public.invitations%rowtype;
begin
  select * into inv from public.invitations
   where lower(email) = lower(new.email) and accepted_at is null
   order by created_at desc limit 1;

  insert into public.profiles (id, email, name, role, institution_id)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', ''),
    case when lower(new.email) = 'im.silveiratrabal@gmail.com' then 'superadmin'
         when inv.id is not null then inv.role
         else 'teacher' end,
    coalesce(inv.institution_id,
             (select id from public.institutions
               where slug = nullif(new.raw_user_meta_data->>'org_slug',''))
    )
  );

  if inv.id is not null then
    update public.invitations set accepted_at = now() where id = inv.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Fecha de modificación automática
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists plannings_touch on public.plannings;
create trigger plannings_touch before update on public.plannings
  for each row execute function public.touch_updated_at();

-- Un usuario no puede cambiarse su propio rol ni institución desde la app
-- (los cambios hechos por funciones del servidor o desde el panel de Supabase sí se permiten)
create or replace function public.protect_profile() returns trigger
language plpgsql set search_path = public as
$$
begin
  if current_user in ('authenticated','anon')
     and (new.role is distinct from old.role or new.institution_id is distinct from old.institution_id)
     and not public.is_superadmin() then
    raise exception 'No autorizado a cambiar rol o institución';
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();

-- ========== SEGURIDAD (quién ve qué) ==========
alter table public.institutions enable row level security;
alter table public.profiles     enable row level security;
alter table public.invitations  enable row level security;
alter table public.plannings    enable row level security;

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

-- Perfiles
drop policy if exists prof_select on public.profiles;
create policy prof_select on public.profiles for select
  using (id = auth.uid() or public.is_superadmin()
         or (institution_id is not null and public.is_admin_of(institution_id)));
drop policy if exists prof_update on public.profiles;
create policy prof_update on public.profiles for update
  using (id = auth.uid() or public.is_superadmin()
         or (institution_id is not null and public.is_admin_of(institution_id)));

-- Invitaciones
drop policy if exists inv_all on public.invitations;
create policy inv_all on public.invitations for all
  using (public.is_admin_of(institution_id))
  with check (public.is_admin_of(institution_id));

-- Planificaciones: cada docente las suyas; admins ven las de su institución
drop policy if exists plan_select on public.plannings;
create policy plan_select on public.plannings for select
  using (owner_id = auth.uid()
         or (institution_id is not null and public.is_admin_of(institution_id)));
drop policy if exists plan_insert on public.plannings;
create policy plan_insert on public.plannings for insert
  with check (owner_id = auth.uid());
drop policy if exists plan_update on public.plannings;
create policy plan_update on public.plannings for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists plan_delete on public.plannings;
create policy plan_delete on public.plannings for delete
  using (owner_id = auth.uid());

-- ========== LOGOS (almacenamiento) ==========
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

drop policy if exists logos_read on storage.objects;
create policy logos_read on storage.objects for select
  using (bucket_id = 'logos');
drop policy if exists logos_write on storage.objects;
create policy logos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'logos'
              and public.is_admin_of(((storage.foldername(name))[1])::uuid));
drop policy if exists logos_update on storage.objects;
create policy logos_update on storage.objects for update to authenticated
  using (bucket_id = 'logos'
         and public.is_admin_of(((storage.foldername(name))[1])::uuid));
drop policy if exists logos_delete on storage.objects;
create policy logos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'logos'
         and public.is_admin_of(((storage.foldername(name))[1])::uuid));


-- ========== FUNCIONES PARA LA APP ==========
-- Marca pública de una institución (para la pantalla de login /org/<slug>)
create or replace function public.get_org_branding(p_slug text)
returns table (name text, slug text, color text, bg_color text, font text, logo_url text)
language sql stable security definer set search_path = public as
$$ select name, slug, color, bg_color, font, logo_url
     from public.institutions where slug = lower(p_slug) limit 1 $$;
grant execute on function public.get_org_branding(text) to anon, authenticated;

-- Sumar a alguien a una institución (si ya tiene cuenta, directo; si no, invitación)
create or replace function public.invite_member(p_inst uuid, p_email text, p_role text default 'teacher')
returns text
language plpgsql security definer set search_path = public as
$$
declare prof public.profiles%rowtype;
begin
  if not public.is_admin_of(p_inst) then raise exception 'No autorizado'; end if;
  if p_role not in ('teacher','org_admin') then raise exception 'Rol inválido'; end if;
  select * into prof from public.profiles where lower(email) = lower(trim(p_email));
  if prof.id is not null then
    if prof.role = 'superadmin' then return 'superadmin'; end if;
    if prof.institution_id is not null and prof.institution_id <> p_inst then
      raise exception 'Esa persona ya pertenece a otra institución';
    end if;
    update public.profiles set institution_id = p_inst, role = p_role where id = prof.id;
    return 'added';
  end if;
  insert into public.invitations (email, institution_id, role, invited_by)
  values (lower(trim(p_email)), p_inst, p_role, auth.uid());
  return 'invited';
end $$;
grant execute on function public.invite_member(uuid, text, text) to authenticated;

-- Crear institución (solo super admin) y asignar su admin
create or replace function public.create_institution(p_name text, p_slug text, p_admin_email text, p_color text default '#7c5cbf')
returns uuid
language plpgsql security definer set search_path = public as
$$
declare new_id uuid;
begin
  if not public.is_superadmin() then raise exception 'No autorizado'; end if;
  insert into public.institutions (name, slug, color, admin_email, created_by)
  values (p_name, lower(p_slug), coalesce(p_color,'#7c5cbf'), lower(trim(p_admin_email)), auth.uid())
  returning id into new_id;
  if coalesce(trim(p_admin_email),'') <> '' then
    perform public.invite_member(new_id, p_admin_email, 'org_admin');
  end if;
  return new_id;
end $$;
grant execute on function public.create_institution(text, text, text, text) to authenticated;

-- Si ya te registraste con este email, te deja como súper admin
update public.profiles set role = 'superadmin'
 where lower(email) = 'im.silveiratrabal@gmail.com';

-- ========== PLAYBOOK / PRINCIPIOS DE LA INSTITUCIÓN ==========
create table if not exists public.institution_documents (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  name text not null,
  kind text not null default 'playbook',
  content text,                 -- texto extraído del documento
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

select 'TeroClass: base creada OK' as resultado;
