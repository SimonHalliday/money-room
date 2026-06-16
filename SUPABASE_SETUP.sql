-- =====================================================================
--  The Money Room — Supabase setup
--  Paste this whole file into the Supabase SQL Editor and click "Run".
--  Safe to run more than once.
-- =====================================================================

-- One profile per signed-in user, pointing at the household they belong to.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid,
  created_at timestamptz default now()
);

-- A household holds the whole app's data as a single JSON blob, shared by its members.
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text default 'Our household',
  join_code text unique default substr(md5(random()::text), 1, 6),
  owner_id uuid references auth.users(id),
  data jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Auto-create a profile row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Create a new household and attach the caller to it.
create or replace function public.create_household()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare hid uuid;
begin
  insert into public.households (owner_id) values (auth.uid()) returning id into hid;
  update public.profiles set household_id = hid where id = auth.uid();
  return hid;
end;
$$;

-- Join an existing household by its 6-character code.
create or replace function public.join_household(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare hid uuid;
begin
  select id into hid from public.households where join_code = lower(trim(code));
  if hid is null then
    raise exception 'No household found with that code';
  end if;
  update public.profiles set household_id = hid where id = auth.uid();
  return hid;
end;
$$;

-- ---------------------------------------------------------------------
--  Row Level Security: you can only see/edit your own household.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.households enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (id = auth.uid());

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (id = auth.uid());

drop policy if exists "members read household" on public.households;
create policy "members read household" on public.households
  for select using (id = (select household_id from public.profiles where id = auth.uid()));

drop policy if exists "members update household" on public.households;
create policy "members update household" on public.households
  for update using (id = (select household_id from public.profiles where id = auth.uid()));

-- ---------------------------------------------------------------------
--  Live sync: let the app subscribe to household changes.
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.households;
exception
  when duplicate_object then null;
end;
$$;
