-- Applied to Supabase project "Mockup Studio" (wxzinlczpohjqlnhshhh).
-- Printify tokens live in Supabase Vault; only the service role (edge function) can read them.
create extension if not exists supabase_vault with schema vault;
create table public.printify_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret_id uuid not null,
  shops jsonb not null default '[]'::jsonb,
  connected_at timestamptz not null default now()
);
alter table public.printify_connections enable row level security;
create policy "read own connection" on public.printify_connections for select to authenticated using ((select auth.uid()) = user_id);
-- save_printify_token / get_printify_token / delete_printify_token: security definer, execute granted to service_role only.

-- catalog print-area cache (public Printify catalog data; service role only)
create table if not exists public.printify_catalog_cache (
  blueprint_id integer not null, provider_id integer not null, variants jsonb not null,
  updated_at timestamptz not null default now(), primary key (blueprint_id, provider_id));
alter table public.printify_catalog_cache enable row level security;
revoke all on public.printify_catalog_cache from anon, authenticated;

-- per-user studio settings (adjustments follow the login across devices)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table public.user_settings enable row level security;
create policy "read own settings" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own settings" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own settings" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update on public.user_settings to authenticated;

-- design library: list table + private storage bucket, each user sees only their own
create table if not exists public.design_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null, path text not null, width integer, height integer, bytes integer, thumb text,
  created_at timestamptz not null default now(), unique (user_id, name));
alter table public.design_library enable row level security;
-- policies: own rows only (select/insert/update/delete); storage bucket 'designs' private, files under <user id>/
