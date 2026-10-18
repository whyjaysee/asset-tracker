-- Lock the whole project down so the public (anon) key can't read or change anything,
-- and signed-in users can only use the net worth app's own functions.
-- Safe to run more than once. Run BEFORE the website goes live, because publishing the site
-- makes the public key visible to anyone.

begin;

-- 1. Turn on row-level security everywhere in public (four older tables had it off).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- 2. Remove every direct table, view and sequence grant from the public and signed-in roles.
--    The app never touches tables directly; it goes through the nw_* functions.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 3. The portfolio_summary view ran with its owner's rights, bypassing row-level security.
alter view if exists public.portfolio_summary set (security_invoker = true);

-- 4. A helper function anyone could call. Revoking EXECUTE does not stop it working as a trigger.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- 5. New tables, views, sequences and functions start private instead of open to everyone.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

commit;
