-- Anota: email accounts, meeting priority and a configurable reminder.
-- Run once in the Supabase SQL editor, after 20260924000000_init.sql.

-- ---------------------------------------------------------------------------
-- Meeting priority: alta, media or baja.
-- ---------------------------------------------------------------------------

alter table public.meetings
  add column priority text not null default 'media'
  check (priority in ('alta', 'media', 'baja'));

-- ---------------------------------------------------------------------------
-- Per-user settings. For now only the reminder interval, in minutes.
-- ---------------------------------------------------------------------------

create table public.user_settings (
  user_id           uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  reminder_minutes  integer not null default 30 check (reminder_minutes between 1 and 480),
  updated_at        timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "own settings" on public.user_settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- save_meeting now also receives the priority.
-- ---------------------------------------------------------------------------

drop function if exists public.save_meeting(text);

create function public.save_meeting(p_title text, p_priority text default 'media')
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

  insert into public.meetings (title, priority) values (p_title, p_priority) returning id into new_id;

  update public.tasks
     set meeting_id = new_id
   where user_id = auth.uid() and meeting_id is null;

  return new_id;
end;
$$;

revoke execute on function public.save_meeting(text, text) from public, anon;
grant execute on function public.save_meeting(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Images stay readable when their task moves to another account
-- (see supabase/scripts/claim_anonymous_data.sql). The file keeps its original
-- folder, so this policy grants access through the task that points to it.
-- ---------------------------------------------------------------------------

create policy "read images of own tasks" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-images'
    and exists (
      select 1 from public.tasks t
      where t.image_path = objects.name and t.user_id = (select auth.uid())
    )
  );
