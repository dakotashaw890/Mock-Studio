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
