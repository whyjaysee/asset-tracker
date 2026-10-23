-- Money owed back: each payment made on someone's behalf (such as the house payments that will be
-- given back) and each repayment, recorded against a cash balance item such as
-- "House payments to be repaid". The item's value each month is worked out from these records:
-- payments minus repayments up to the month's last day.
-- Run in the Supabase SQL Editor after 004. Safe to run more than once.
-- It adds a table and functions; it changes no stored months, entries or items.

begin;

-- amount is in S$ and signed: positive = paid out and owed back, negative = repaid.
create table if not exists public.nw_owed (
  id bigint generated always as identity primary key,
  date date not null,
  item_id text not null references public.nw_items(id),
  amount numeric not null check (amount <> 0),
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists nw_owed_item_date on public.nw_owed (item_id, date);
alter table public.nw_owed enable row level security;
revoke all on public.nw_owed from anon, authenticated;

-- Same as in 004, plus 'owed'.
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
    ) order by m.month) from nw_months m), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(jsonb_build_object(
      'id', v.id, 'date', v.date, 'item_id', v.item_id, 'type', v.type, 'units', v.units,
      'amount', v.amount, 'fee', v.fee, 'note', v.note, 'transfer_id', v.transfer_id, 'created_by', v.created_by
    ) order by v.date, v.id) from nw_movements v), '[]'::jsonb),
    'owed', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'date', o.date, 'item_id', o.item_id, 'amount', o.amount, 'note', o.note, 'created_by', o.created_by
    ) order by o.date, o.id) from nw_owed o), '[]'::jsonb));
end $$;

-- Records one payment or repayment: d = { date, kind: 'paid' | 'repaid', amount (S$, above zero),
-- note?, item_id? }. Without item_id it uses the one item that already has records, or else the
-- one active cash item whose name says "repaid". Refuses a repayment larger than what's owed.
create or replace function public.nw_save_owed(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); hid text := d->>'item_id'; amt numeric; n int;
begin
  if coalesce(d->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The date must look like 2026-10-24'; end if;
  if coalesce(d->>'kind', '') not in ('paid', 'repaid') then raise exception 'kind must be paid or repaid'; end if;
  amt := abs(coalesce(nullif(d->>'amount', '')::numeric, 0));
  if amt = 0 then raise exception 'The amount must be more than zero'; end if;
  if hid is null then
    select count(distinct item_id), min(item_id) into n, hid from nw_owed;
    if n <> 1 then
      select count(*), min(id) into n, hid from nw_items where category = 'cash' and kind = 'balance' and active and name ilike '%repaid%';
      if n <> 1 then raise exception 'Say which item this is for (item_id)'; end if;
    end if;
  end if;
  if not exists (select 1 from nw_items where id = hid and category = 'cash' and kind = 'balance') then
    raise exception 'Money owed back must go on a cash item entered as a single amount';
  end if;
  insert into nw_owed (date, item_id, amount, note, created_by)
  values ((d->>'date')::date, hid, case when d->>'kind' = 'paid' then amt else -amt end, coalesce(d->>'note', ''), who);
  if exists (select 1 from (select sum(amount) over (order by date, id) as owed from nw_owed where item_id = hid) s where owed < -0.005) then
    raise exception 'That repays more than is owed at that date';
  end if;
  return nw_load();
end $$;

create or replace function public.nw_delete_owed(o_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare hid text;
begin
  perform nw_require_member();
  delete from nw_owed where id = o_id returning item_id into hid;
  if hid is not null and exists (select 1 from (select sum(amount) over (order by date, id) as owed from nw_owed where item_id = hid) s where owed < -0.005) then
    raise exception 'Deleting that would leave more repaid than was paid. Delete the repayment first';
  end if;
  return nw_load();
end $$;

revoke execute on function public.nw_load(), public.nw_save_owed(jsonb), public.nw_delete_owed(bigint)
  from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_save_owed(jsonb), public.nw_delete_owed(bigint)
  to authenticated;

commit;
