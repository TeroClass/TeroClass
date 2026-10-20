-- TeroClass · Aula en vivo (live classroom) · Base de datos
--
-- ⚠️  NO EJECUTAR TODAVÍA. DO NOT RUN YET.
--     El aula en vivo funciona hoy en modo Demo (sin servidor de video ni grabación).
--     Ejecutar este archivo recién cuando se active LiveKit (ver docs/live-class.md),
--     DESPUÉS de 001_base.sql. Se puede volver a ejecutar sin riesgo
--     (if not exists / create or replace / drop ... if exists).
--
-- Modelo de permisos (mismo criterio que 001_base.sql):
--   - El/la docente es dueño/a de su sesión (live_sessions.teacher_id) y ve todo lo de ella.
--   - Cada alumno/a ve solo lo suyo (session_participants.user_id = auth.uid());
--     su tutor/a ve lo de ese alumno/a (session_participants.guardian_user_id = auth.uid()).
--   - Admins de la institución (y súper admin) ven las sesiones de su institución.
--   - Grabaciones y transcripciones las escribe SOLO el servidor (service role, que salta RLS):
--     el navegador nunca puede insertarlas ni modificarlas.
--   - Consentimientos (cambio 2026-10): la fuente de verdad es el consentimiento ÚNICO por persona de 001_base.sql
--     (user_consents: una casilla = grabación + análisis con IA + almacenamiento; menores con tutor/a). La tabla
--     "consents" de acá queda como REGISTRO DE AUDITORÍA por llamada: la escribe solo el servidor (service role) al
--     dar acceso a la sala / empezar a grabar, copiando el user_consents vigente (columna user_consent_id; una fila
--     por tipo: recording, ai_analysis, storage). El navegador ya no inserta acá. revoke_consent() revoca además el
--     consentimiento de la persona (user_consents) para que deje de grabarse en todas sus clases.
--   - Audio crudo: retention_until = 30 días; un job (service role) lo borra del storage
--     y marca deleted_at (ver recordings_due_for_deletion()).
--
-- INSIGHTS (cambio 2026-10): student_insights y teacher_insights ahora viven en 001_base.sql, colgadas de la
--   CLASE DEL CALENDARIO (class_sessions), con sus funciones y reglas de privacidad (sin acceso directo).
--   Hoy se llenan con datos de demostración. Este archivo solo las conecta con la videollamada:
--     · live_sessions.class_session_id → la clase del calendario que se dicta en esta llamada;
--     · student_insights.participant_id → el participante de la llamada (FK a session_participants).
--   El pipeline real (LiveKit + Azure Speech + IA, con service role) escribirá filas con is_demo = false en
--   esas tablas, para la class_session_id de la llamada. Es un superconjunto seguro: se puede ejecutar
--   (y re-ejecutar) después del 001 nuevo sin cambiar nada de lo que ya existe.

-- Requiere el 001_base.sql con insights de clase (class_sessions + student_insights por inscripción).
do $$
begin
  if to_regclass('public.class_sessions') is null or to_regclass('public.user_consents') is null or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'student_insights' and column_name = 'enrollment_id') then
    raise exception 'Primero ejecutá la versión actual de 001_base.sql (insights de clase y consentimiento único)';
  end if;
end $$;

-- ========== TABLAS ==========
create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users(id) on delete cascade,
  institution_id uuid references public.institutions(id) on delete set null,
  planning_id uuid references public.plannings(id) on delete set null,
  title text not null default '' check (length(title) <= 200),
  subject text default '' check (length(subject) <= 120),
  class_language text default '' check (length(class_language) <= 40),
  livekit_room text not null unique check (livekit_room ~ '^[A-Za-z0-9_-]{3,64}$'),
  status text not null default 'scheduled'
    check (status in ('scheduled','live','processing','ready','ended','cancelled')),
  recording_enabled boolean not null default true,
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists live_sessions_teacher_idx on public.live_sessions (teacher_id);
create index if not exists live_sessions_inst_idx on public.live_sessions (institution_id);
-- La clase del calendario (001_base.sql) que se dicta en esta llamada: sus insights son los de esa clase.
alter table public.live_sessions add column if not exists class_session_id uuid references public.class_sessions(id) on delete set null;
create index if not exists live_sessions_class_idx on public.live_sessions (class_session_id);

create table if not exists public.session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,          -- null = invitado sin cuenta
  guardian_user_id uuid references auth.users(id) on delete set null, -- tutor/a con cuenta (menores)
  display_name text not null default '' check (length(display_name) <= 80),
  role text not null default 'student' check (role in ('teacher','student','observer')),
  is_minor boolean not null default false,
  livekit_identity text not null check (length(livekit_identity) between 1 and 128),
  recorded boolean not null default false,   -- lo decide el servidor según los consentimientos
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, livekit_identity)
);
create index if not exists session_participants_session_idx on public.session_participants (session_id);
create index if not exists session_participants_user_idx on public.session_participants (user_id);
create index if not exists session_participants_guardian_idx on public.session_participants (guardian_user_id);

-- Quién consintió qué, cuándo, con qué versión del texto, y si fue un tutor.
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.session_participants(id) on delete cascade,
  kind text not null check (kind in ('recording','ai_analysis','storage')),
  granted boolean not null,
  policy_version text not null check (length(policy_version) between 1 and 40),
  given_by text not null default 'self' check (given_by in ('self','guardian')),
  given_by_user_id uuid references auth.users(id) on delete set null,
  guardian_name text check (guardian_name is null or length(guardian_name) between 1 and 120),
  guardian_email text check (guardian_email is null or guardian_email ~ '^[^\s@<>"'']{1,64}@[^\s@<>"'']{1,190}\.[A-Za-z]{2,24}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint consents_guardian_fields check (given_by = 'self' or (guardian_name is not null and guardian_email is not null))
);
create index if not exists consents_participant_idx on public.consents (participant_id);
-- El consentimiento único (001_base.sql) del que sale esta fila de auditoría.
alter table public.consents add column if not exists user_consent_id uuid references public.user_consents(id) on delete set null;
create index if not exists consents_session_idx on public.consents (session_id);

-- Audio por participante (solo voz). Lo escribe el recorder (service role).
create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.session_participants(id) on delete cascade,
  storage_path text not null check (length(storage_path) <= 500),
  duration_s integer check (duration_s is null or duration_s >= 0),
  speech_s integer check (speech_s is null or speech_s >= 0),
  status text not null default 'recording' check (status in ('recording','uploaded','transcribed','failed','deleted')),
  retention_until timestamptz not null default (now() + interval '30 days'),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists recordings_session_idx on public.recordings (session_id);
create index if not exists recordings_retention_idx on public.recordings (retention_until) where deleted_at is null;

create table if not exists public.transcript_segments (
  id bigserial primary key,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.session_participants(id) on delete cascade,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  text text not null default '',
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  check (end_ms >= start_ms)
);
create index if not exists transcript_segments_session_idx on public.transcript_segments (session_id, start_ms);

-- Insights de cada estudiante: la tabla está en 001_base.sql (por clase del calendario e inscripción).
-- Acá solo se la vincula con el participante de la llamada.
alter table public.student_insights drop constraint if exists student_insights_participant_fk;
alter table public.student_insights add constraint student_insights_participant_fk
  foreign key (participant_id) references public.session_participants(id) on delete set null;
create index if not exists student_insights_participant_idx on public.student_insights (participant_id);

-- ========== FUNCIONES DE AYUDA (security definer: evitan recursión entre políticas) ==========
create or replace function public.owns_session(p_session uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.live_sessions where id = p_session and teacher_id = auth.uid()) $$;

create or replace function public.admin_of_session(p_session uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select (s.institution_id is not null and public.is_admin_of(s.institution_id))
                      or public.is_superadmin()
                    from public.live_sessions s where s.id = p_session), false) $$;

-- Alumno/a o tutor/a de un participante concreto
create or replace function public.is_self_or_guardian(p_participant uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.session_participants
                   where id = p_participant and auth.uid() is not null
                     and (user_id = auth.uid() or guardian_user_id = auth.uid())) $$;

create or replace function public.in_session(p_session uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.session_participants
                   where session_id = p_session and auth.uid() is not null
                     and (user_id = auth.uid() or guardian_user_id = auth.uid())) $$;

revoke all on function public.owns_session(uuid) from public, anon;
revoke all on function public.admin_of_session(uuid) from public, anon;
revoke all on function public.is_self_or_guardian(uuid) from public, anon;
revoke all on function public.in_session(uuid) from public, anon;
grant execute on function public.owns_session(uuid) to authenticated;
grant execute on function public.admin_of_session(uuid) to authenticated;
grant execute on function public.is_self_or_guardian(uuid) to authenticated;
grant execute on function public.in_session(uuid) to authenticated;

-- ========== REGLAS AUTOMÁTICAS ==========
drop trigger if exists live_sessions_touch on public.live_sessions;
create trigger live_sessions_touch before update on public.live_sessions
  for each row execute function public.touch_updated_at();
-- (student_insights / teacher_insights: sus triggers están en 001_base.sql)

-- La institución de la sesión es siempre la del docente (como plannings) y la planificación
-- vinculada tiene que ser suya.
create or replace function public.live_sessions_guard() returns trigger
language plpgsql set search_path = public as
$$
begin
  if current_user in ('authenticated','anon') and not public.is_superadmin() then
    if tg_op = 'INSERT' or new.institution_id is distinct from old.institution_id then
      new.institution_id := public.my_institution();
    end if;
    if tg_op = 'UPDATE' and new.teacher_id is distinct from old.teacher_id then
      raise exception 'No se puede cambiar el docente de la sesión';
    end if;
    if new.planning_id is not null and (tg_op = 'INSERT' or new.planning_id is distinct from old.planning_id)
       and not exists (select 1 from public.plannings where id = new.planning_id and owner_id = auth.uid()) then
      raise exception 'Esa planificación no es tuya';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists live_sessions_guard on public.live_sessions;
create trigger live_sessions_guard before insert or update on public.live_sessions
  for each row execute function public.live_sessions_guard();

-- Consentimiento de menores: solo un tutor/a puede darlo.
create or replace function public.consents_guard() returns trigger
language plpgsql security definer set search_path = public as
$$
declare v_minor boolean; v_session uuid;
begin
  select is_minor, session_id into v_minor, v_session
    from public.session_participants where id = new.participant_id;
  if v_session is null or v_session <> new.session_id then
    raise exception 'El participante no pertenece a esta sesión';
  end if;
  if v_minor and new.granted and new.given_by <> 'guardian' then
    raise exception 'Menores de 18: el consentimiento lo tiene que dar un tutor/a';
  end if;
  return new;
end $$;
drop trigger if exists consents_guard on public.consents;
create trigger consents_guard before insert on public.consents
  for each row execute function public.consents_guard();

-- ========== SEGURIDAD (quién ve qué) ==========
alter table public.live_sessions        enable row level security;
alter table public.session_participants enable row level security;
alter table public.consents             enable row level security;
alter table public.recordings           enable row level security;
alter table public.transcript_segments  enable row level security;

-- Sesiones
drop policy if exists ls_select on public.live_sessions;
create policy ls_select on public.live_sessions for select
  using (teacher_id = auth.uid() or public.admin_of_session(id) or public.in_session(id));
drop policy if exists ls_insert on public.live_sessions;
create policy ls_insert on public.live_sessions for insert
  with check (teacher_id = auth.uid() and public.my_role() in ('teacher','org_admin','superadmin'));
drop policy if exists ls_update on public.live_sessions;
create policy ls_update on public.live_sessions for update
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
drop policy if exists ls_delete on public.live_sessions;
create policy ls_delete on public.live_sessions for delete
  using (teacher_id = auth.uid());

-- Participantes: el docente arma la lista; cada uno (o su tutor) ve su propia fila.
drop policy if exists sp_select on public.session_participants;
create policy sp_select on public.session_participants for select
  using (public.owns_session(session_id) or public.admin_of_session(session_id)
         or user_id = auth.uid() or guardian_user_id = auth.uid());
drop policy if exists sp_insert on public.session_participants;
create policy sp_insert on public.session_participants for insert
  with check (public.owns_session(session_id));
drop policy if exists sp_update on public.session_participants;
create policy sp_update on public.session_participants for update
  using (public.owns_session(session_id)) with check (public.owns_session(session_id));
drop policy if exists sp_delete on public.session_participants;
create policy sp_delete on public.session_participants for delete
  using (public.owns_session(session_id));
-- "recorded", joined_at y left_at los define solo el servidor
revoke update on public.session_participants from authenticated;
grant update (display_name, role, is_minor, guardian_user_id) on public.session_participants to authenticated;

-- Consentimientos (auditoría por llamada): los lee el docente, los admins y cada persona (o su tutor); los escribe solo
-- el servidor (service role) a partir de user_consents. Nadie los edita ni borra desde la app.
drop policy if exists cs_select on public.consents;
create policy cs_select on public.consents for select
  using (public.owns_session(session_id) or public.admin_of_session(session_id)
         or public.is_self_or_guardian(participant_id) or given_by_user_id = auth.uid());
drop policy if exists cs_insert on public.consents;   -- (antes: el navegador agregaba los suyos; ahora solo el servidor)
revoke insert, update, delete on public.consents from anon, authenticated;

create or replace function public.revoke_consent(p_id uuid) returns void
language plpgsql security definer set search_path = public as
$$
declare v_part uuid; v_user uuid;
begin
  select participant_id into v_part from public.consents where id = p_id and revoked_at is null;
  if v_part is null or not public.is_self_or_guardian(v_part) then raise exception 'No autorizado'; end if;
  update public.consents set revoked_at = now() where id = p_id;
  -- el consentimiento único de esa persona (001_base.sql) también se revoca: deja de grabarse en todas sus clases
  -- y se le vuelve a preguntar en la próxima.
  select user_id into v_user from public.session_participants where id = v_part;
  if v_user is not null then
    update public.user_consents set revoked_at = now(), revoked_reason = 'user' where user_id = v_user and revoked_at is null;
  end if;
  -- TODO(live): el servidor deja de grabar a este participante y borra lo que corresponda.
end $$;
revoke all on function public.revoke_consent(uuid) from public, anon;
grant execute on function public.revoke_consent(uuid) to authenticated;

-- Grabaciones: lectura para docente/admin (y cada participante, las suyas); escritura solo servidor.
drop policy if exists rec_select on public.recordings;
create policy rec_select on public.recordings for select
  using (public.owns_session(session_id) or public.admin_of_session(session_id)
         or public.is_self_or_guardian(participant_id));
revoke insert, update, delete on public.recordings from anon, authenticated;

drop policy if exists ts_select on public.transcript_segments;
create policy ts_select on public.transcript_segments for select
  using (public.owns_session(session_id) or public.admin_of_session(session_id)
         or public.is_self_or_guardian(participant_id));
revoke insert, update, delete on public.transcript_segments from anon, authenticated;

-- Insights: sin acceso directo (políticas de una versión anterior de este archivo, si existían, se quitan).
-- Se leen y escriben con las funciones de 001_base.sql: get_session_insights, my_insights, my_insight,
-- save_teacher_reflection, save_insight_message (el pipeline real escribe con service role).
drop policy if exists si_select on public.student_insights;
drop policy if exists si_update on public.student_insights;
drop policy if exists ti_select on public.teacher_insights;
drop policy if exists ti_update on public.teacher_insights;
revoke all on public.student_insights, public.teacher_insights from anon, authenticated;

revoke all on public.live_sessions, public.session_participants, public.consents, public.recordings,
  public.transcript_segments, public.student_insights, public.teacher_insights from anon;

-- Para el job de borrado (service role): audio vencido que todavía no se borró.
create or replace function public.recordings_due_for_deletion() returns setof public.recordings
language sql stable security definer set search_path = public as
$$ select * from public.recordings where deleted_at is null and retention_until <= now() $$;
revoke all on function public.recordings_due_for_deletion() from public, anon, authenticated;

select 'TeroClass: aula en vivo creada OK' as resultado;
