-- Anota: initial schema.
-- Run this once in the Supabase SQL editor (or with `supabase db push`).
-- Every row belongs to the signed-in user (anonymous sign-in by default) and
-- Row Level Security keeps each user's data private.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.initiatives (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  color       text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  timestamptz not null default now()
);

create table public.meetings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  created_at  timestamptz not null default now()
);

-- A task with meeting_id = null belongs to the meeting in progress.
-- Saving a meeting moves those tasks into the new meetings row.
create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meeting_id     uuid references public.meetings (id) on delete cascade,
  initiative_id  uuid references public.initiatives (id) on delete set null,
  text           text not null check (char_length(text) between 1 and 2000),
  image_path     text,
  created_at     timestamptz not null default now()
);

create index initiatives_user_idx on public.initiatives (user_id, created_at);
create index meetings_user_idx    on public.meetings (user_id, created_at desc);
create index tasks_user_meeting_idx on public.tasks (user_id, meeting_id, created_at desc);
create index tasks_initiative_idx on public.tasks (initiative_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: each user only sees and changes their own rows.
-- ---------------------------------------------------------------------------

alter table public.initiatives enable row level security;
alter table public.meetings    enable row level security;
alter table public.tasks       enable row level security;

create policy "own initiatives" on public.initiatives
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own meetings" on public.meetings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own tasks" on public.tasks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (meeting_id is null or exists (
      select 1 from public.meetings m where m.id = meeting_id and m.user_id = (select auth.uid())))
    and (initiative_id is null or exists (
      select 1 from public.initiatives i where i.id = initiative_id and i.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- Save the meeting in progress atomically: create the meeting and move every
-- pending task into it. Returns the new meeting id.
-- ---------------------------------------------------------------------------

create or replace function public.save_meeting(p_title text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if not exists (select 1 from public.tasks where user_id = auth.uid() and meeting_id is null) then
    raise exception 'No hay tareas para guardar';
  end if;

  insert into public.meetings (title) values (p_title) returning id into new_id;

  update public.tasks
     set meeting_id = new_id
   where user_id = auth.uid() and meeting_id is null;

  return new_id;
end;
$$;

revoke execute on function public.save_meeting(text) from public, anon;
grant execute on function public.save_meeting(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for task images, one folder per user.
-- Object paths look like "<user id>/<random id>.png".
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-images', 'task-images', false, 10485760,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

create policy "read own task images" on storage.objects
  for select to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "upload own task images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "update own task images" on storage.objects
  for update to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "delete own task images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
