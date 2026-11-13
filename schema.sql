-- Run once in Supabase Dashboard → SQL Editor.
-- Application content and profiles live in Postgres; there is no store.json.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table if not exists public.role_definitions (
  role_key text primary key check (role_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  label text not null,
  description text not null default '',
  capabilities jsonb not null default '{"dashboard_view": false, "manage_content": false, "manage_users": false}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.role_definitions (role_key, label, description, capabilities, is_system)
values
  ('member', 'عضو', 'حساب عادي؛ يشاهد المحتوى العام ويستخدم الأقسام المسموح بها.', '{"dashboard_view": false, "manage_content": false, "manage_users": false}', true),
  ('viewer_admin', 'مشرف مشاهدة', 'يفتح لوحة المطور للعرض فقط؛ لا يمكنه إضافة المحتوى أو تعديله أو حذفه.', '{"dashboard_view": true, "manage_content": false, "manage_users": false}', true),
  ('admin', 'مدير', 'إدارة المحتوى والمستخدمين والرتب وصلاحيات الموقع.', '{"dashboard_view": true, "manage_content": true, "manage_users": true}', true)
on conflict (role_key) do nothing;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  gender text not null check (gender in ('male', 'female')),
  roles text[] not null default array['member']::text[],
  banned boolean not null default false,
  blocked_sections text[] not null default '{}'::text[],
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 24),
  constraint profiles_blocked_sections check (blocked_sections <@ array['tournaments', 'program_downloads']::text[])
);
create unique index if not exists profiles_username_lower_unique on public.profiles (lower(username));

create or replace function private.has_capability(target_user uuid, requested_capability text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(bool_or(coalesce((rd.capabilities ->> requested_capability)::boolean, false)), false)
  from public.profiles p
  cross join lateral unnest(p.roles) as assigned(role_key)
  join public.role_definitions rd on rd.role_key = assigned.role_key
  where p.id = target_user and not p.banned
$$;

create or replace function private.section_allowed(target_user uuid, requested_section text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.has_capability(target_user, 'manage_users') or exists (
    select 1 from public.profiles p
    where p.id = target_user and not p.banned and not (requested_section = any(p.blocked_sections))
  )
$$;

grant execute on function private.has_capability(uuid, text) to anon, authenticated;
grant execute on function private.section_allowed(uuid, text) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, gender)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'username', 'member_' || left(new.id::text, 8)), 24),
    case when new.raw_user_meta_data ->> 'gender' = 'female' then 'female' else 'male' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_iq_studio on auth.users;
create trigger on_auth_user_created_iq_studio
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.programs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  image_url text not null default '',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.program_downloads (
  program_id uuid primary key references public.programs(id) on delete cascade,
  download_url text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  thumbnail_url text not null default '',
  video_url text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  image_url text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.live_stream (
  id smallint primary key default 1 check (id = 1),
  url text not null default '',
  description text not null default '',
  thumbnail_url text not null default '',
  status text not null default 'offline' check (status in ('live', 'paused', 'offline')),
  updated_at timestamptz not null default now()
);
insert into public.live_stream (id) values (1) on conflict (id) do nothing;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

alter table public.role_definitions enable row level security;
alter table public.profiles enable row level security;
alter table public.programs enable row level security;
alter table public.program_downloads enable row level security;
alter table public.videos enable row level security;
alter table public.news enable row level security;
alter table public.live_stream enable row level security;
alter table public.notifications enable row level security;

grant select on public.role_definitions to anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.programs, public.program_downloads,
  public.videos, public.news, public.live_stream, public.notifications to authenticated;
grant select on public.programs, public.videos, public.news to anon;

drop policy if exists role_definitions_read on public.role_definitions;
create policy role_definitions_read on public.role_definitions for select to anon, authenticated using (true);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.has_capability((select auth.uid()), 'dashboard_view'));

drop policy if exists programs_public_read on public.programs;
create policy programs_public_read on public.programs for select to anon, authenticated using (true);
drop policy if exists programs_admin_insert on public.programs;
create policy programs_admin_insert on public.programs for insert to authenticated
  with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists programs_admin_update on public.programs;
create policy programs_admin_update on public.programs for update to authenticated
  using (private.has_capability((select auth.uid()), 'manage_content'))
  with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists programs_admin_delete on public.programs;
create policy programs_admin_delete on public.programs for delete to authenticated
  using (private.has_capability((select auth.uid()), 'manage_content'));

drop policy if exists downloads_allowed_read on public.program_downloads;
create policy downloads_allowed_read on public.program_downloads for select to authenticated
  using (private.section_allowed((select auth.uid()), 'program_downloads'));
drop policy if exists downloads_admin_insert on public.program_downloads;
create policy downloads_admin_insert on public.program_downloads for insert to authenticated
  with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists downloads_admin_update on public.program_downloads;
create policy downloads_admin_update on public.program_downloads for update to authenticated
  using (private.has_capability((select auth.uid()), 'manage_content'))
  with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists downloads_admin_delete on public.program_downloads;
create policy downloads_admin_delete on public.program_downloads for delete to authenticated
  using (private.has_capability((select auth.uid()), 'manage_content'));

drop policy if exists videos_public_read on public.videos;
create policy videos_public_read on public.videos for select to anon, authenticated using (true);
drop policy if exists videos_admin_insert on public.videos;
create policy videos_admin_insert on public.videos for insert to authenticated with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists videos_admin_update on public.videos;
create policy videos_admin_update on public.videos for update to authenticated using (private.has_capability((select auth.uid()), 'manage_content')) with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists videos_admin_delete on public.videos;
create policy videos_admin_delete on public.videos for delete to authenticated using (private.has_capability((select auth.uid()), 'manage_content'));

drop policy if exists news_public_read on public.news;
create policy news_public_read on public.news for select to anon, authenticated using (true);
drop policy if exists news_admin_insert on public.news;
create policy news_admin_insert on public.news for insert to authenticated with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists news_admin_update on public.news;
create policy news_admin_update on public.news for update to authenticated using (private.has_capability((select auth.uid()), 'manage_content')) with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists news_admin_delete on public.news;
create policy news_admin_delete on public.news for delete to authenticated using (private.has_capability((select auth.uid()), 'manage_content'));

drop policy if exists live_stream_allowed_read on public.live_stream;
create policy live_stream_allowed_read on public.live_stream for select to authenticated
  using (private.section_allowed((select auth.uid()), 'tournaments'));
drop policy if exists live_stream_admin_insert on public.live_stream;
create policy live_stream_admin_insert on public.live_stream for insert to authenticated with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists live_stream_admin_update on public.live_stream;
create policy live_stream_admin_update on public.live_stream for update to authenticated using (private.has_capability((select auth.uid()), 'manage_content')) with check (private.has_capability((select auth.uid()), 'manage_content'));

drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using (private.section_allowed((select auth.uid()), 'tournaments'));
drop policy if exists notifications_admin_insert on public.notifications;
create policy notifications_admin_insert on public.notifications for insert to authenticated with check (private.has_capability((select auth.uid()), 'manage_content'));
drop policy if exists notifications_admin_delete on public.notifications;
create policy notifications_admin_delete on public.notifications for delete to authenticated using (private.has_capability((select auth.uid()), 'manage_content'));

create or replace function public.record_my_login()
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare stamped_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.profiles set last_sign_in_at = clock_timestamp()
  where id = auth.uid() returning last_sign_in_at into stamped_at;
  return stamped_at;
end;
$$;
revoke all on function public.record_my_login() from public;
grant execute on function public.record_my_login() to authenticated;

create or replace function public.admin_update_user(
  target_user uuid,
  is_banned boolean,
  restricted_sections text[],
  assigned_roles text[]
)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.has_capability(auth.uid(), 'manage_users') then raise exception 'ليس لديك صلاحية إدارة المستخدمين'; end if;
  if restricted_sections is null or not (restricted_sections <@ array['tournaments', 'program_downloads']::text[]) then
    raise exception 'قائمة الأقسام غير صالحة';
  end if;
  if assigned_roles is null or cardinality(assigned_roles) = 0 then raise exception 'يجب منح رتبة واحدة على الأقل'; end if;
  if exists (select 1 from unnest(assigned_roles) as roles(role_key) where not exists (select 1 from public.role_definitions d where d.role_key = roles.role_key)) then
    raise exception 'توجد رتبة غير معروفة';
  end if;
  update public.profiles
  set banned = is_banned,
      blocked_sections = (select coalesce(array_agg(distinct sections.section_key), '{}'::text[]) from unnest(restricted_sections) as sections(section_key)),
      roles = (select array_agg(distinct roles.role_key order by roles.role_key) from unnest(assigned_roles) as roles(role_key))
  where id = target_user;
  if not found then raise exception 'المستخدم غير موجود'; end if;
end;
$$;
revoke all on function public.admin_update_user(uuid, boolean, text[], text[]) from public;
grant execute on function public.admin_update_user(uuid, boolean, text[], text[]) to authenticated;

create or replace function public.admin_create_role(
  requested_key text,
  requested_label text,
  requested_description text,
  requested_capabilities jsonb
)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.has_capability(auth.uid(), 'manage_users') then raise exception 'ليس لديك صلاحية إدارة الرتب'; end if;
  if requested_key !~ '^[a-z][a-z0-9_]{1,31}$' then raise exception 'معرّف الرتبة يجب أن يكون إنجليزياً ومن دون مسافات'; end if;
  if requested_label is null or char_length(trim(requested_label)) < 2 then raise exception 'اسم الرتبة مطلوب'; end if;
  if requested_capabilities is null or jsonb_typeof(requested_capabilities) <> 'object' then raise exception 'الصلاحيات غير صالحة'; end if;
  if exists (select 1 from jsonb_each(requested_capabilities) item where item.key not in ('dashboard_view', 'manage_content', 'manage_users') or jsonb_typeof(item.value) <> 'boolean') then
    raise exception 'الصلاحيات المتاحة: مشاهدة اللوحة، إدارة المحتوى، إدارة المستخدمين';
  end if;
  insert into public.role_definitions (role_key, label, description, capabilities, is_system)
  values (requested_key, trim(requested_label), coalesce(requested_description, ''),
    jsonb_build_object(
      'dashboard_view', coalesce((requested_capabilities ->> 'dashboard_view')::boolean, false),
      'manage_content', coalesce((requested_capabilities ->> 'manage_content')::boolean, false),
      'manage_users', coalesce((requested_capabilities ->> 'manage_users')::boolean, false)
    ), false);
end;
$$;
revoke all on function public.admin_create_role(text, text, text, jsonb) from public;
grant execute on function public.admin_create_role(text, text, text, jsonb) to authenticated;

create or replace function public.admin_delete_role(requested_key text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.has_capability(auth.uid(), 'manage_users') then raise exception 'ليس لديك صلاحية إدارة الرتب'; end if;
  if requested_key in ('member', 'viewer_admin', 'admin') then raise exception 'لا يمكن حذف الرتب الأساسية'; end if;
  if not exists (select 1 from public.role_definitions where role_key = requested_key and not is_system) then raise exception 'الرتبة غير موجودة أو أساسية'; end if;
  update public.profiles set roles = array_remove(roles, requested_key) where requested_key = any(roles);
  delete from public.role_definitions where role_key = requested_key;
end;
$$;
revoke all on function public.admin_delete_role(text) from public;
grant execute on function public.admin_delete_role(text) to authenticated;

-- Promote the initial owner after creating the account from the Register form:
-- update public.profiles set roles = array['admin'] where username = 'iq2011';
