-- Reconciling movements: change or delete existing movements and add new ones in one go, all or
-- nothing, for example to correct an opening balance to a ledger and add the rewards since.
-- Movements can carry a reference (such as a Kraken ledger id) so importing the same ledger again
-- adds nothing twice.
-- Run in the Supabase SQL Editor after 005. Safe to run more than once.
-- It adds a column and functions; it changes no stored months, entries, items or movements.

begin;

alter table public.nw_movements add column if not exists ref text;
create unique index if not exists nw_movements_ref on public.nw_movements (ref) where ref is not null;

-- Same as in 005, with each movement's ref.
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
      'amount', v.amount, 'fee', v.fee, 'note', v.note, 'transfer_id', v.transfer_id, 'created_by', v.created_by, 'ref', v.ref
    ) order by v.date, v.id) from nw_movements v), '[]'::jsonb),
    'owed', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'date', o.date, 'item_id', o.item_id, 'amount', o.amount, 'note', o.note, 'created_by', o.created_by
    ) order by o.date, o.id) from nw_owed o), '[]'::jsonb));
end $$;

-- d = { delete: [id], update: [{ id, date?, units?, amount?, fee?, note? }], add: [movement] }, all
-- or nothing. A movement to add is as for nw_save_movements, plus an optional ref; one whose ref
-- already exists is skipped. Deleting or changing either half of a transfer changes both halves.
-- Refuses anything that would leave a holding below zero on any date.
create or replace function public.nw_apply_movements(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); m jsonb; t text; u numeric; dt date; tid uuid; mv record; bad record;
begin
  for m in select value from jsonb_array_elements(coalesce(d->'delete', '[]'::jsonb)) loop
    select transfer_id into tid from nw_movements where id = (m #>> '{}')::bigint;
    delete from nw_movements where id = (m #>> '{}')::bigint or (tid is not null and transfer_id = tid);
  end loop;

  for m in select value from jsonb_array_elements(coalesce(d->'update', '[]'::jsonb)) loop
    select * into mv from nw_movements where id = (m->>'id')::bigint;
    if mv.id is null then raise exception 'That movement no longer exists. Reload and try again'; end if;
    if m ? 'date' and coalesce(m->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The date must look like 2026-10-24'; end if;
    u := case when m ? 'units' then abs(coalesce(nullif(m->>'units', '')::numeric, 0)) else abs(mv.units) end;
    if u = 0 then raise exception 'Units must be more than zero'; end if;
    if mv.transfer_id is not null then
      update nw_movements set date = coalesce((m->>'date')::date, date),
        units = case when type = 'transfer_out' then -u else u end,
        note = coalesce(m->>'note', note)
      where transfer_id = mv.transfer_id;
    else
      update nw_movements set date = coalesce((m->>'date')::date, date),
        units = case when type in ('sell', 'fee') then -u else u end,
        amount = case when m ? 'amount' then abs(nullif(m->>'amount', '')::numeric) else amount end,
        fee = case when m ? 'fee' then abs(coalesce(nullif(m->>'fee', '')::numeric, 0)) else fee end,
        note = coalesce(m->>'note', note)
      where id = mv.id;
    end if;
  end loop;

  for m in select value from jsonb_array_elements(coalesce(d->'add', '[]'::jsonb)) loop
    if m->>'ref' is not null and exists (select 1 from nw_movements where ref = m->>'ref') then continue; end if;
    t := m->>'type';
    if coalesce(m->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The date must look like 2026-10-24'; end if;
    dt := (m->>'date')::date;
    if t is null or t not in ('buy', 'sell', 'transfer', 'vest', 'reward', 'fee') then raise exception 'Unknown kind of movement'; end if;
    if not exists (select 1 from nw_items where id = m->>'item_id' and kind = 'holding') then raise exception 'Pick a holding'; end if;
    u := abs(coalesce(nullif(m->>'units', '')::numeric, 0));
    if u = 0 then raise exception 'Units must be more than zero'; end if;
    if t = 'transfer' then
      if coalesce(m->>'to_item_id', '') = m->>'item_id'
         or not exists (select 1 from nw_items where id = m->>'to_item_id' and kind = 'holding') then
        raise exception 'Pick a different holding to move it to';
      end if;
      tid := gen_random_uuid();
      insert into nw_movements (date, item_id, type, units, note, transfer_id, created_by, ref)
      values (dt, m->>'item_id', 'transfer_out', -u, coalesce(m->>'note', ''), tid, who, m->>'ref'),
             (dt, m->>'to_item_id', 'transfer_in', u, coalesce(m->>'note', ''), tid, who, null);
    else
      insert into nw_movements (date, item_id, type, units, amount, fee, note, created_by, ref)
      values (dt, m->>'item_id', t, case when t in ('sell', 'fee') then -u else u end,
              abs(nullif(m->>'amount', '')::numeric), abs(coalesce(nullif(m->>'fee', '')::numeric, 0)),
              coalesce(m->>'note', ''), who, m->>'ref');
    end if;
  end loop;

  select x.item_id, x.date into bad from (
    select item_id, date, sum(units) over (partition by item_id order by date, units desc, id) as held from nw_movements
  ) x where x.held < -0.000000001 limit 1;
  if bad.item_id is not null then
    raise exception 'That would leave % at % below zero on %',
      (select name from nw_items where id = bad.item_id), (select coalesce(nullif(source, ''), 'no account') from nw_items where id = bad.item_id), bad.date;
  end if;
  return nw_load();
end $$;

revoke execute on function public.nw_load(), public.nw_apply_movements(jsonb) from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_apply_movements(jsonb) to authenticated;

commit;
