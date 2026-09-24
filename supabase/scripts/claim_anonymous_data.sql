-- Moves everything created by anonymous sessions (before email accounts existed)
-- into one email account. Run it in the Supabase SQL editor AFTER creating that
-- account in the app. Replace the email on the first line of the block.
--
-- Initiatives with the same name are merged, so the default "Producto",
-- "Marketing" and "Operaciones" of every device end up as a single copy.

do $$
declare
  target_email constant text := 'tu-email@ejemplo.com';  -- <-- change this
  target uuid;
  moved record;
  existing uuid;
begin
  select id into target from auth.users where lower(email) = lower(target_email) and not is_anonymous;
  if target is null then
    raise exception 'No existe una cuenta con el email %', target_email;
  end if;

  -- Initiatives: merge by name into the target account.
  for moved in
    select i.id, i.name from public.initiatives i
    join auth.users u on u.id = i.user_id
    where u.is_anonymous
    order by i.created_at
  loop
    select id into existing from public.initiatives
    where user_id = target and lower(name) = lower(moved.name)
    limit 1;

    if existing is null then
      update public.initiatives set user_id = target where id = moved.id;
    else
      update public.tasks set initiative_id = existing where initiative_id = moved.id;
      delete from public.initiatives where id = moved.id;
    end if;
  end loop;

  update public.meetings set user_id = target
  where user_id in (select id from auth.users where is_anonymous);

  update public.tasks set user_id = target
  where user_id in (select id from auth.users where is_anonymous);

  raise notice 'Datos movidos a %', target_email;
end;
$$;
