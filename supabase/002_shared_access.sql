-- Net worth tracker: let signed-in household members use the app from the website.
-- Run once in the Supabase SQL Editor, after 001_setup.sql.
-- Replace the email addresses and names below before running. Keep the real addresses out of the repository.

begin;

-- Who may use the app. Only these signed-in emails can read or change anything.
create table if not exists public.nw_members (
  email text primary key check (email = lower(email)),
  name text not null default '',
  added_at timestamptz not null default now()
);
alter table public.nw_members enable row level security;
revoke all on public.nw_members from anon, authenticated;

insert into public.nw_members(email, name) values
  ('YOUR_EMAIL_HERE', 'YOUR_NAME_HERE'),
  ('PARTNER_EMAIL_HERE', 'PARTNER_NAME_HERE')
on conflict (email) do update set name = excluded.name;

-- Who saved each month, and when.
alter table public.nw_months add column if not exists updated_by text not null default '';

-- The gate. Website visitors arrive as 'authenticated' with their email in the sign-in token;
-- they pass only if listed above. Direct database sessions (the Supabase dashboard, Claude)
-- carry no token and are allowed. Visitors without a sign-in never reach these functions.
create or replace function public.nw_require_member() returns text
language plpgsql stable security definer set search_path = public as $$
declare who text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    if who = '' or not exists (select 1 from nw_members where email = who) then
      raise exception 'not_a_member' using errcode = '42501', hint = 'Ask the owner to add your email to nw_members.';
    end if;
    return who;
  end if;
  return 'dashboard';
end $$;

create or replace function public.nw_load() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform nw_require_member();
  return jsonb_build_object(
    'me', lower(coalesce(auth.jwt()->>'email', '')),
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', email, 'name', name) order by added_at) from nw_members), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort, i.id) from nw_items i), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(jsonb_build_object(
        'month', m.month, 'fx', m.fx, 'salary', m.salary, 'bonus', m.bonus,
        'stock_added', m.stock_added, 'crypto_added', m.crypto_added, 'other_flow', m.other_flow, 'note', m.note,
        'updated_at', m.updated_at, 'updated_by', m.updated_by,
        'entries', coalesce((select jsonb_object_agg(e.item_id, jsonb_build_array(e.amount, e.price)) from nw_entries e where e.month = m.month), '{}'::jsonb)
      ) order by m.month) from nw_months m), '[]'::jsonb));
end $$;

create or replace function public.nw_save_month(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member();
begin
  if coalesce(d->>'month', '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Month must look like 2026-09'; end if;
  if coalesce((d->>'fx')::numeric, 0) <= 0 then raise exception 'The exchange rate must be above zero'; end if;
  insert into nw_months(month, fx, salary, bonus, stock_added, crypto_added, other_flow, note, updated_at, updated_by)
  values (d->>'month', (d->>'fx')::numeric, coalesce((d->>'salary')::numeric,0), coalesce((d->>'bonus')::numeric,0),
          coalesce((d->>'stock_added')::numeric,0), coalesce((d->>'crypto_added')::numeric,0), coalesce((d->>'other_flow')::numeric,0),
          coalesce(d->>'note',''), now(), who)
  on conflict (month) do update set fx = excluded.fx, salary = excluded.salary, bonus = excluded.bonus,
    stock_added = excluded.stock_added, crypto_added = excluded.crypto_added, other_flow = excluded.other_flow,
    note = excluded.note, updated_at = now(), updated_by = who;
  delete from nw_entries where month = d->>'month';
  insert into nw_entries(month, item_id, amount, price)
  select d->>'month', e.key, (e.value->>0)::numeric, (e.value->>1)::numeric
  from jsonb_each(coalesce(d->'entries', '{}'::jsonb)) e
  where e.value->>0 is not null;
  return nw_load();
end $$;

create or replace function public.nw_delete_month(m text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform nw_require_member();
  delete from nw_months where month = m;
  return nw_load();
end $$;

create or replace function public.nw_save_item(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare base text; new_id text; n int := 2;
begin
  perform nw_require_member();
  if d ? 'id' then
    update nw_items set name = coalesce(d->>'name', name), active = coalesce((d->>'active')::boolean, active),
      source = coalesce(d->>'source', source), monthly = coalesce((d->>'monthly')::boolean, monthly)
    where id = d->>'id';
  else
    if coalesce(trim(d->>'name'), '') = '' then raise exception 'Give it a name'; end if;
    if coalesce(d->>'category','') not in ('cash','stocks','crypto','rsu') or coalesce(d->>'kind','') not in ('balance','holding')
       or coalesce(d->>'currency','') not in ('SGD','USD') then raise exception 'Unknown type'; end if;
    base := coalesce(nullif(trim(both '_' from regexp_replace(lower(d->>'name'), '[^a-z0-9]+', '_', 'g')), ''), 'item');
    new_id := base;
    while exists (select 1 from nw_items where id = new_id) loop new_id := base || '_' || n; n := n + 1; end loop;
    insert into nw_items(id, category, name, kind, currency, active, sort, source, monthly)
    values (new_id, d->>'category', trim(d->>'name'), d->>'kind', d->>'currency', true,
            (select coalesce(max(sort),0)+1 from nw_items), coalesce(trim(d->>'source'),''), true);
  end if;
  return nw_load();
end $$;

-- Keeps a free-plan project from pausing: the weekly job in .github/workflows calls this.
-- It reads nothing and returns only the time.
create or replace function public.nw_ping() returns timestamptz
language sql stable security definer set search_path = public as $$ select now() $$;

revoke execute on function public.nw_require_member(), public.nw_load(), public.nw_save_month(jsonb),
  public.nw_delete_month(text), public.nw_save_item(jsonb), public.nw_ping() from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_save_month(jsonb), public.nw_delete_month(text),
  public.nw_save_item(jsonb) to authenticated;
grant execute on function public.nw_ping() to anon, authenticated;

commit;
