-- Positions and movements: record each trade, transfer, vest or reward against a holding
-- (an nw_items row of kind 'holding': one asset at one account), so the units held each month
-- are worked out from the movements instead of typed in.
-- Run in the Supabase SQL Editor after 002 and 003. Safe to run more than once.
-- It adds a table and functions; it changes no stored months, entries or items.

begin;

-- Units are signed: positive adds to the holding, negative takes from it.
-- A transfer is two rows sharing a transfer_id: transfer_out on one holding, transfer_in on another.
-- amount is the total paid or received in the holding's currency (null when not known or not
-- relevant); fee is a cash fee in the same currency.
create table if not exists public.nw_movements (
  id bigint generated always as identity primary key,
  date date not null,
  item_id text not null references public.nw_items(id),
  type text not null check (type in ('opening', 'buy', 'sell', 'transfer_in', 'transfer_out', 'vest', 'reward', 'fee')),
  units numeric not null check (units <> 0),
  amount numeric check (amount >= 0),
  fee numeric not null default 0 check (fee >= 0),
  note text not null default '',
  transfer_id uuid,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  check ((type in ('sell', 'transfer_out', 'fee')) = (units < 0))
);
create index if not exists nw_movements_item_date on public.nw_movements (item_id, date);
alter table public.nw_movements enable row level security;
revoke all on public.nw_movements from anon, authenticated;

-- Same as in 002, plus 'movements'.
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
    ) order by v.date, v.id) from nw_movements v), '[]'::jsonb));
end $$;

-- Takes a list of movements and adds them all, or none if any is invalid.
-- Each is { date, item_id, type, units, amount?, fee?, note? }; units may be given unsigned.
-- type 'transfer' also needs to_item_id and becomes a transfer_out and transfer_in pair.
-- An 'opening' for a holding that already has one is skipped, so starting twice is harmless.
create or replace function public.nw_save_movements(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); m jsonb; t text; u numeric; dt date; tid uuid;
begin
  if jsonb_typeof(d) is distinct from 'array' or jsonb_array_length(d) = 0 then raise exception 'Nothing to save'; end if;
  for m in select value from jsonb_array_elements(d) loop
    t := m->>'type';
    if coalesce(m->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The date must look like 2026-10-24'; end if;
    dt := (m->>'date')::date;
    if t is null or t not in ('opening', 'buy', 'sell', 'transfer', 'vest', 'reward', 'fee') then raise exception 'Unknown kind of movement'; end if;
    if not exists (select 1 from nw_items where id = m->>'item_id' and kind = 'holding') then raise exception 'Pick a holding'; end if;
    u := abs(coalesce(nullif(m->>'units', '')::numeric, 0));
    if u = 0 then raise exception 'Units must be more than zero'; end if;
    if t = 'opening' and exists (select 1 from nw_movements where item_id = m->>'item_id' and type = 'opening') then continue; end if;
    if t = 'transfer' then
      if coalesce(m->>'to_item_id', '') = m->>'item_id'
         or not exists (select 1 from nw_items where id = m->>'to_item_id' and kind = 'holding') then
        raise exception 'Pick a different holding to move it to';
      end if;
      tid := gen_random_uuid();
      insert into nw_movements (date, item_id, type, units, note, transfer_id, created_by)
      values (dt, m->>'item_id', 'transfer_out', -u, coalesce(m->>'note', ''), tid, who),
             (dt, m->>'to_item_id', 'transfer_in', u, coalesce(m->>'note', ''), tid, who);
    else
      insert into nw_movements (date, item_id, type, units, amount, fee, note, created_by)
      values (dt, m->>'item_id', t, case when t in ('sell', 'fee') then -u else u end,
              abs(nullif(m->>'amount', '')::numeric), abs(coalesce(nullif(m->>'fee', '')::numeric, 0)),
              coalesce(m->>'note', ''), who);
    end if;
  end loop;
  return nw_load();
end $$;

-- Deletes a movement, and the other half if it is part of a transfer.
create or replace function public.nw_delete_movement(m_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  perform nw_require_member();
  select transfer_id into tid from nw_movements where id = m_id;
  delete from nw_movements where id = m_id or (tid is not null and transfer_id = tid);
  return nw_load();
end $$;

-- One-time start: adds the holdings held now, each with an opening balance on d.date, and
-- switches off the totals they replace. All or nothing.
-- d = { date, holdings: [{ item_id } or { name, source, category, currency }, plus units, amount? ],
--       switch_off: [item_id] }
-- A holding given by name and source reuses an existing holding with the same name and source.
create or replace function public.nw_setup_holdings(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); h jsonb; dt date; hid text; base text; n int; u numeric;
begin
  if coalesce(d->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The date must look like 2026-10-24'; end if;
  dt := (d->>'date')::date;
  if jsonb_typeof(d->'holdings') is distinct from 'array' or jsonb_array_length(d->'holdings') = 0 then
    raise exception 'Add at least one holding';
  end if;
  for h in select value from jsonb_array_elements(d->'holdings') loop
    u := abs(coalesce(nullif(h->>'units', '')::numeric, 0));
    if u = 0 then raise exception 'Units must be more than zero'; end if;
    hid := null;
    if h ? 'item_id' then
      select id into hid from nw_items where id = h->>'item_id' and kind = 'holding';
      if hid is null then raise exception 'Pick a holding'; end if;
    else
      if coalesce(trim(h->>'name'), '') = '' or coalesce(trim(h->>'source'), '') = '' then
        raise exception 'Each holding needs an asset and an account';
      end if;
      if coalesce(h->>'category', '') not in ('stocks', 'crypto', 'rsu') or coalesce(h->>'currency', '') not in ('SGD', 'USD') then
        raise exception 'Unknown type';
      end if;
      select id into hid from nw_items
      where kind = 'holding' and lower(name) = lower(trim(h->>'name')) and lower(source) = lower(trim(h->>'source'))
      order by id limit 1;
      if hid is null then
        base := coalesce(nullif(trim(both '_' from regexp_replace(lower(trim(h->>'name') || ' ' || trim(h->>'source')), '[^a-z0-9]+', '_', 'g')), ''), 'item');
        hid := base; n := 2;
        while exists (select 1 from nw_items where id = hid) loop hid := base || '_' || n; n := n + 1; end loop;
        insert into nw_items (id, category, name, kind, currency, active, sort, source, monthly)
        values (hid, h->>'category', trim(h->>'name'), 'holding', h->>'currency', true,
                (select coalesce(max(sort), 0) + 1 from nw_items), trim(h->>'source'), true);
      end if;
    end if;
    if exists (select 1 from nw_movements where item_id = hid) then
      raise exception '% already has movements. Record changes on the Activity tab instead.',
        (select name || ' at ' || coalesce(nullif(source, ''), 'no account') from nw_items where id = hid);
    end if;
    update nw_items set active = true, monthly = true where id = hid;
    insert into nw_movements (date, item_id, type, units, amount, note, created_by)
    values (dt, hid, 'opening', u, abs(nullif(h->>'amount', '')::numeric), 'Holdings set up', who);
  end loop;
  update nw_items set active = false
  where id in (select jsonb_array_elements_text(coalesce(d->'switch_off', '[]'::jsonb)))
    and not exists (select 1 from nw_movements v where v.item_id = nw_items.id);
  return nw_load();
end $$;

revoke execute on function public.nw_load(), public.nw_save_movements(jsonb), public.nw_delete_movement(bigint),
  public.nw_setup_holdings(jsonb) from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_save_movements(jsonb), public.nw_delete_movement(bigint),
  public.nw_setup_holdings(jsonb) to authenticated;

commit;
