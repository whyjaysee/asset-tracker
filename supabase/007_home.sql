-- Home: house commitments (payments due, from cash or CPF) and the mortgage (terms and rate
-- periods). The Home tab reads these; the mortgage schedule is worked out in the browser.
-- Run in the Supabase SQL Editor after 006. Safe to run more than once.
-- It adds tables and functions; it changes no existing rows.

begin;

-- A payment due on the house. amount is in S$. A paid, repayable cash commitment points to the
-- money-owed-back record it created (owed_id); deleting that record clears the link.
create table if not exists public.nw_commitments (
  id bigint generated always as identity primary key,
  date_due date not null,
  label text not null check (trim(label) <> ''),
  amount numeric not null check (amount > 0),
  paid_from text not null check (paid_from in ('cash', 'cpf')),
  status text not null default 'planned' check (status in ('planned', 'paid')),
  paid_on date,
  repayable boolean not null default false,
  owed_id bigint references public.nw_owed(id) on delete set null,
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  check ((status = 'paid') = (paid_on is not null))
);
alter table public.nw_commitments enable row level security;
revoke all on public.nw_commitments from anon, authenticated;

-- A loan. start_date is the drawdown; the first instalment is one month later. Rates are annual %.
-- base_rate and adverse_rate are for comparing instalments on the rate card.
create table if not exists public.nw_loans (
  id bigint generated always as identity primary key,
  label text not null check (trim(label) <> ''),
  principal numeric not null check (principal > 0),
  start_date date not null,
  tenure_months int not null check (tenure_months > 0),
  cpf_monthly numeric not null default 0 check (cpf_monthly >= 0),
  base_rate numeric,
  adverse_rate numeric,
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now()
);
alter table public.nw_loans enable row level security;
revoke all on public.nw_loans from anon, authenticated;

-- A rate applies from from_date until the next row's from_date. lock_in_end is when the
-- package's lock-in ends, for the repricing reminder.
create table if not exists public.nw_loan_rates (
  id bigint generated always as identity primary key,
  loan_id bigint not null references public.nw_loans(id) on delete cascade,
  rate numeric not null check (rate >= 0 and rate < 100),
  from_date date not null,
  lock_in_end date,
  unique (loan_id, from_date)
);
alter table public.nw_loan_rates enable row level security;
revoke all on public.nw_loan_rates from anon, authenticated;

-- Same as in 006, plus 'commitments' and 'loans' (each with its rates).
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
    ) order by o.date, o.id) from nw_owed o), '[]'::jsonb),
    'commitments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'date_due', c.date_due, 'label', c.label, 'amount', c.amount, 'paid_from', c.paid_from,
      'status', c.status, 'paid_on', c.paid_on, 'repayable', c.repayable, 'owed_id', c.owed_id, 'note', c.note, 'created_by', c.created_by
    ) order by c.date_due, c.id) from nw_commitments c), '[]'::jsonb),
    'loans', coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'label', l.label, 'principal', l.principal, 'start_date', l.start_date, 'tenure_months', l.tenure_months,
      'cpf_monthly', l.cpf_monthly, 'base_rate', l.base_rate, 'adverse_rate', l.adverse_rate, 'note', l.note, 'created_by', l.created_by,
      'rates', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'rate', r.rate, 'from_date', r.from_date, 'lock_in_end', r.lock_in_end)
        order by r.from_date) from nw_loan_rates r where r.loan_id = l.id), '[]'::jsonb)
    ) order by l.id) from nw_loans l), '[]'::jsonb));
end $$;

-- d = { id?, date_due, label, amount, paid_from: 'cash' | 'cpf', repayable?, note? }. Adds one, or
-- changes a planned one; a paid one keeps everything but its label and note.
create or replace function public.nw_save_commitment(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); amt numeric; cur public.nw_commitments;
begin
  if coalesce(d->>'date_due', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The due date must look like 2026-10-24'; end if;
  if coalesce(trim(d->>'label'), '') = '' then raise exception 'Say what the payment is for'; end if;
  amt := coalesce(nullif(d->>'amount', '')::numeric, 0);
  if amt <= 0 then raise exception 'The amount must be more than zero'; end if;
  if coalesce(d->>'paid_from', '') not in ('cash', 'cpf') then raise exception 'Say whether it is paid from cash or CPF'; end if;
  if d ? 'id' then
    select * into cur from nw_commitments where id = (d->>'id')::bigint;
    if cur.id is null then raise exception 'That commitment no longer exists. Reload and try again'; end if;
    if cur.status = 'paid' then
      update nw_commitments set label = trim(d->>'label'), note = coalesce(d->>'note', note) where id = cur.id;
    else
      update nw_commitments set date_due = (d->>'date_due')::date, label = trim(d->>'label'), amount = amt,
        paid_from = d->>'paid_from', repayable = coalesce((d->>'repayable')::boolean, false), note = coalesce(d->>'note', '')
      where id = cur.id;
    end if;
  else
    insert into nw_commitments (date_due, label, amount, paid_from, repayable, note, created_by)
    values ((d->>'date_due')::date, trim(d->>'label'), amt, d->>'paid_from', coalesce((d->>'repayable')::boolean, false), coalesce(d->>'note', ''), who);
  end if;
  return nw_load();
end $$;

-- Marks a commitment paid. A repayable one paid from cash also records the payment as money owed
-- back, on the item nw_save_owed would pick: the one item with records, or the one active cash
-- item whose name says "repaid".
create or replace function public.nw_pay_commitment(c_id bigint, paid_on date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); cur public.nw_commitments; hid text; n int; oid bigint;
begin
  select * into cur from nw_commitments where id = c_id;
  if cur.id is null then raise exception 'That commitment no longer exists. Reload and try again'; end if;
  if cur.status = 'paid' then raise exception 'That commitment is already marked paid'; end if;
  if paid_on is null then raise exception 'Enter the date it was paid'; end if;
  if cur.repayable and cur.paid_from = 'cash' then
    select count(distinct item_id), min(item_id) into n, hid from nw_owed;
    if n <> 1 then
      select count(*), min(id) into n, hid from nw_items where category = 'cash' and kind = 'balance' and active and name ilike '%repaid%';
      if n <> 1 then raise exception 'Add a cash line for money owed back (a name with "repaid" in it) under Update, Accounts and holdings, then try again'; end if;
    end if;
    insert into nw_owed (date, item_id, amount, note, created_by) values (paid_on, hid, cur.amount, cur.label, who) returning id into oid;
  end if;
  update nw_commitments set status = 'paid', paid_on = nw_pay_commitment.paid_on, owed_id = oid where id = c_id;
  return nw_load();
end $$;

create or replace function public.nw_delete_commitment(c_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur public.nw_commitments;
begin
  perform nw_require_member();
  select * into cur from nw_commitments where id = c_id;
  if cur.status = 'paid' and cur.owed_id is not null then
    raise exception 'This payment was also recorded as money owed back. Delete that record on the Activity tab first, then this';
  end if;
  delete from nw_commitments where id = c_id;
  return nw_load();
end $$;

-- d = { id?, label, principal, start_date, tenure_months, cpf_monthly?, base_rate?, adverse_rate?,
-- note?, rates: [{ rate, from_date, lock_in_end? }] }. Saves the loan and replaces its rates, all or
-- nothing. Rate periods must be in date order, start on or before start_date, and each lock-in
-- must end on or after its period starts and by the time the next one starts.
create or replace function public.nw_save_loan(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); lid bigint; r jsonb; prev date; prev_lock date; fd date; i int := 0;
begin
  if coalesce(trim(d->>'label'), '') = '' then raise exception 'Give the loan a name'; end if;
  if coalesce(nullif(d->>'principal', '')::numeric, 0) <= 0 then raise exception 'The loan amount must be more than zero'; end if;
  if coalesce(d->>'start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The drawdown date must look like 2026-10-24'; end if;
  if coalesce(nullif(d->>'tenure_months', '')::int, 0) <= 0 then raise exception 'The tenure must be at least one month'; end if;
  if coalesce(nullif(d->>'cpf_monthly', '')::numeric, 0) < 0 then raise exception 'CPF per month cannot be negative'; end if;
  if jsonb_typeof(d->'rates') is distinct from 'array' or jsonb_array_length(d->'rates') = 0 then raise exception 'Add at least one rate period'; end if;
  for r in select value from jsonb_array_elements(d->'rates') loop
    i := i + 1;
    if coalesce(r->>'from_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Each rate period needs a start date'; end if;
    if nullif(r->>'rate', '') is null or (r->>'rate')::numeric < 0 or (r->>'rate')::numeric >= 100 then raise exception 'Each rate period needs a rate between 0 and 100%%'; end if;
    fd := (r->>'from_date')::date;
    if i = 1 and fd > (d->>'start_date')::date then raise exception 'The first rate period must start on or before the drawdown date'; end if;
    if prev is not null and fd <= prev then raise exception 'Rate periods must be in date order, each starting after the one before'; end if;
    if prev_lock is not null and prev_lock > fd then raise exception 'A lock-in can''t end after the next rate period starts'; end if;
    if nullif(r->>'lock_in_end', '') is not null and (r->>'lock_in_end')::date < fd then raise exception 'A lock-in can''t end before its rate period starts'; end if;
    prev := fd;
    prev_lock := nullif(r->>'lock_in_end', '')::date;
  end loop;
  if d ? 'id' and nullif(d->>'id', '') is not null then
    lid := (d->>'id')::bigint;
    update nw_loans set label = trim(d->>'label'), principal = (d->>'principal')::numeric, start_date = (d->>'start_date')::date,
      tenure_months = (d->>'tenure_months')::int, cpf_monthly = coalesce(nullif(d->>'cpf_monthly', '')::numeric, 0),
      base_rate = nullif(d->>'base_rate', '')::numeric, adverse_rate = nullif(d->>'adverse_rate', '')::numeric, note = coalesce(d->>'note', '')
    where id = lid;
    if not found then raise exception 'That loan no longer exists. Reload and try again'; end if;
    delete from nw_loan_rates where loan_id = lid;
  else
    insert into nw_loans (label, principal, start_date, tenure_months, cpf_monthly, base_rate, adverse_rate, note, created_by)
    values (trim(d->>'label'), (d->>'principal')::numeric, (d->>'start_date')::date, (d->>'tenure_months')::int,
      coalesce(nullif(d->>'cpf_monthly', '')::numeric, 0), nullif(d->>'base_rate', '')::numeric, nullif(d->>'adverse_rate', '')::numeric,
      coalesce(d->>'note', ''), who)
    returning id into lid;
  end if;
  insert into nw_loan_rates (loan_id, rate, from_date, lock_in_end)
  select lid, (p.v->>'rate')::numeric, (p.v->>'from_date')::date, nullif(p.v->>'lock_in_end', '')::date from jsonb_array_elements(d->'rates') as p(v);
  return nw_load();
end $$;

create or replace function public.nw_delete_loan(l_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform nw_require_member();
  delete from nw_loans where id = l_id;
  return nw_load();
end $$;

revoke execute on function public.nw_load(), public.nw_save_commitment(jsonb), public.nw_pay_commitment(bigint, date),
  public.nw_delete_commitment(bigint), public.nw_save_loan(jsonb), public.nw_delete_loan(bigint) from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_save_commitment(jsonb), public.nw_pay_commitment(bigint, date),
  public.nw_delete_commitment(bigint), public.nw_save_loan(jsonb), public.nw_delete_loan(bigint) to authenticated;

commit;
