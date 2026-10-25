-- Spending: itemised card and bank outflows, trips, categorising rules and the statements they
-- came from. The Spending tab reads these; every total and average is worked out in the browser.
-- Run in the Supabase SQL Editor after 007. Safe to run more than once.
-- It adds tables and functions; it changes no existing rows.
--
-- Card and account numbers are never stored: the importers drop them, and every text column
-- refuses a run of 8 or more digits as a backstop.

begin;

-- A trip, for travel by trip. Travel rows inside its dates are linked to it.
create table if not exists public.nw_trips (
  id bigint generated always as identity primary key,
  name text not null check (trim(name) <> ''),
  start_date date,
  end_date date,
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
alter table public.nw_trips enable row level security;
revoke all on public.nw_trips from anon, authenticated;

-- One imported statement (per card for a combined card statement), for coverage and undo.
create table if not exists public.nw_statements (
  id bigint generated always as identity primary key,
  source text not null check (source in ('citi_card', 'uob_card', 'citi_bank', 'manual')),
  card text not null default '' check (card !~ '\d([ -]?\d){7,}'),
  period_start date not null,
  period_end date not null,
  purchases numeric,
  credits numeric,
  lines int,
  imported_at timestamptz not null default now(),
  created_by text not null default '',
  unique (source, card, period_start, period_end),
  check (period_end >= period_start)
);
alter table public.nw_statements enable row level security;
revoke all on public.nw_statements from anon, authenticated;

-- A categorising rule. pattern is a case-insensitive regular expression tested on the merchant
-- key and the description; lower priority runs first. kind null leaves the kind as detected.
create table if not exists public.nw_expense_rules (
  id bigint generated always as identity primary key,
  pattern text not null check (trim(pattern) <> ''),
  category text not null check (trim(category) <> ''),
  subcategory text not null default '',
  kind text check (kind in ('recurring', 'travel', 'one_off', 'reimbursed', 'excluded')),
  priority int not null default 100,
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now()
);
alter table public.nw_expense_rules enable row level security;
revoke all on public.nw_expense_rules from anon, authenticated;

-- One transaction. amount is in S$: positive = money out, negative = a refund or credit.
-- ref is the dedupe key built by the importer, so importing a file again adds nothing.
-- labelled_by = 'user' rows are never re-categorised by a rule.
create table if not exists public.nw_expenses (
  id bigint generated always as identity primary key,
  date date not null,
  posted date,
  source text not null check (source in ('citi_card', 'uob_card', 'citi_bank', 'manual')),
  card text not null default '' check (card !~ '\d([ -]?\d){7,}'),
  description text not null check (trim(description) <> '' and description !~ '\d([ -]?\d){7,}'),
  merchant text not null check (trim(merchant) <> '' and merchant !~ '\d([ -]?\d){7,}'),
  amount numeric not null,
  fx_currency text check (fx_currency ~ '^[A-Z]{3}$'),
  fx_amount numeric,
  country text check (country ~ '^[A-Z]{2}$'),
  category text not null check (trim(category) <> ''),
  subcategory text not null default '',
  kind text not null default 'recurring' check (kind in ('recurring', 'travel', 'one_off', 'reimbursed', 'excluded')),
  reimbursed numeric not null default 0 check (reimbursed >= 0),
  trip_id bigint references public.nw_trips(id) on delete set null,
  labelled_by text not null default 'rule' check (labelled_by in ('rule', 'guess', 'user')),
  statement text not null default '',
  statement_id bigint references public.nw_statements(id) on delete set null,
  ref text not null unique check (trim(ref) <> ''),
  note text not null default '' check (note !~ '\d([ -]?\d){7,}'),
  created_by text not null default '',
  created_at timestamptz not null default now()
);
alter table public.nw_expenses enable row level security;
revoke all on public.nw_expenses from anon, authenticated;
create index if not exists nw_expenses_date on public.nw_expenses (date);
create index if not exists nw_expenses_merchant on public.nw_expenses (merchant);
create index if not exists nw_expenses_statement on public.nw_expenses (statement_id);
create index if not exists nw_expenses_trip on public.nw_expenses (trip_id);

-- Same as in 007, plus 'expenses', 'trips', 'expense_rules' and 'statements'.
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
    ) order by l.id) from nw_loans l), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'date', x.date, 'posted', x.posted, 'source', x.source, 'card', x.card, 'description', x.description,
      'merchant', x.merchant, 'amount', x.amount, 'fx_currency', x.fx_currency, 'fx_amount', x.fx_amount, 'country', x.country,
      'category', x.category, 'subcategory', x.subcategory, 'kind', x.kind, 'reimbursed', x.reimbursed, 'trip_id', x.trip_id,
      'labelled_by', x.labelled_by, 'statement', x.statement, 'statement_id', x.statement_id, 'ref', x.ref, 'note', x.note,
      'created_by', x.created_by
    ) order by x.date, x.id) from nw_expenses x), '[]'::jsonb),
    'trips', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'start_date', t.start_date, 'end_date', t.end_date, 'note', t.note, 'created_by', t.created_by
    ) order by t.start_date nulls last, t.id) from nw_trips t), '[]'::jsonb),
    'expense_rules', coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'pattern', u.pattern, 'category', u.category, 'subcategory', u.subcategory, 'kind', u.kind,
      'priority', u.priority, 'note', u.note, 'created_by', u.created_by
    ) order by u.priority, u.id) from nw_expense_rules u), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'source', s.source, 'card', s.card, 'period_start', s.period_start, 'period_end', s.period_end,
      'purchases', s.purchases, 'credits', s.credits, 'lines', s.lines, 'imported_at', s.imported_at, 'created_by', s.created_by
    ) order by s.period_end, s.source, s.card) from nw_statements s), '[]'::jsonb));
end $$;

-- Links travel rows to the trip whose dates they fall in. Rows the user labelled keep their trip.
-- Internal: called by the functions below, not by the site.
create or replace function public.nw_link_trips() returns void
language sql security definer set search_path = public as $$
  update nw_expenses e set trip_id = t.id
  from nw_trips t
  where e.trip_id is null and e.kind = 'travel' and e.labelled_by <> 'user'
    and t.start_date is not null and t.end_date is not null and e.date between t.start_date and t.end_date;
$$;

-- d = { statement?: { source, card?, period_start, period_end, purchases?, credits?, lines? },
--       rows: [{ date, posted?, source?, card?, description, merchant, amount, fx_currency?, fx_amount?,
--                country?, category, subcategory?, kind?, reimbursed?, trip_id?, labelled_by?, ref, note? }] }
-- or a list of those, saved all or nothing. A statement already imported is reused. Rows whose
-- ref already exists are skipped, so a user's edits survive a re-import. Returns nw_load() plus
-- added and skipped.
create or replace function public.nw_save_expenses(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  who text := nw_require_member(); part jsonb; s jsonb; r jsonb; sid bigint; label text; src text;
  added int := 0; skipped int := 0; n int; i int; long text := '\d([ -]?\d){7,}';
begin
  if jsonb_typeof(d) not in ('object', 'array') then raise exception 'Nothing to save'; end if;
  for part in select value from jsonb_array_elements(case when jsonb_typeof(d) = 'array' then d else jsonb_build_array(d) end) loop
    sid := null; label := ''; src := null;
    s := part->'statement';
    if jsonb_typeof(s) = 'object' then
      src := s->>'source';
      if coalesce(src, '') not in ('citi_card', 'uob_card', 'citi_bank', 'manual') then raise exception 'The statement''s source must be citi_card, uob_card, citi_bank or manual'; end if;
      if coalesce(s->>'period_start', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(s->>'period_end', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'The statement period must have a start and end date like 2026-10-24';
      end if;
      if (s->>'period_end')::date < (s->>'period_start')::date then raise exception 'The statement period ends before it starts'; end if;
      if coalesce(s->>'card', '') ~ long then raise exception 'The card label looks like it holds a card number. Nothing was saved'; end if;
      select id into sid from nw_statements
      where source = src and card = coalesce(s->>'card', '') and period_start = (s->>'period_start')::date and period_end = (s->>'period_end')::date;
      if sid is null then
        insert into nw_statements (source, card, period_start, period_end, purchases, credits, lines, created_by)
        values (src, coalesce(s->>'card', ''), (s->>'period_start')::date, (s->>'period_end')::date,
          nullif(s->>'purchases', '')::numeric, nullif(s->>'credits', '')::numeric, nullif(s->>'lines', '')::int, who)
        returning id into sid;
      end if;
      label := src || ':' || to_char((s->>'period_end')::date, 'YYYY-MM');
    end if;
    if jsonb_typeof(part->'rows') is distinct from 'array' then raise exception 'Nothing to save: the import has no rows'; end if;
    i := 0;
    for r in select value from jsonb_array_elements(part->'rows') loop
      i := i + 1;
      if coalesce(r->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Row %: the date must look like 2026-10-24', i; end if;
      if nullif(r->>'posted', '') is not null and r->>'posted' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Row %: the posting date must look like 2026-10-24', i; end if;
      if coalesce(r->>'source', src, '') not in ('citi_card', 'uob_card', 'citi_bank', 'manual') then raise exception 'Row %: the source must be citi_card, uob_card, citi_bank or manual', i; end if;
      if coalesce(trim(r->>'description'), '') = '' or coalesce(trim(r->>'merchant'), '') = '' then raise exception 'Row %: a description and merchant are needed', i; end if;
      if coalesce(r->>'description', '') ~ long or coalesce(r->>'merchant', '') ~ long or coalesce(r->>'card', '') ~ long or coalesce(r->>'note', '') ~ long then
        raise exception 'Row %: the text looks like it holds a card or account number. Nothing was saved', i;
      end if;
      if coalesce(r->>'amount', '') !~ '^-?\d+(\.\d+)?$' then raise exception 'Row %: the amount must be a number', i; end if;
      if coalesce(trim(r->>'category'), '') = '' then raise exception 'Row %: a category is needed', i; end if;
      if coalesce(r->>'kind', 'recurring') not in ('recurring', 'travel', 'one_off', 'reimbursed', 'excluded') then raise exception 'Row %: unknown kind', i; end if;
      if coalesce(r->>'labelled_by', 'rule') not in ('rule', 'guess', 'user') then raise exception 'Row %: labelled_by must be rule, guess or user', i; end if;
      if coalesce(nullif(r->>'reimbursed', '')::numeric, 0) < 0 then raise exception 'Row %: the amount paid back can''t be negative', i; end if;
      if coalesce(trim(r->>'ref'), '') = '' then raise exception 'Row %: a ref is needed', i; end if;
      if nullif(r->>'trip_id', '') is not null and not exists (select 1 from nw_trips where id = (r->>'trip_id')::bigint) then
        raise exception 'Row %: that trip no longer exists. Reload and try again', i;
      end if;
      insert into nw_expenses (date, posted, source, card, description, merchant, amount, fx_currency, fx_amount, country,
        category, subcategory, kind, reimbursed, trip_id, labelled_by, statement, statement_id, ref, note, created_by)
      values ((r->>'date')::date, nullif(r->>'posted', '')::date, coalesce(r->>'source', src), coalesce(r->>'card', s->>'card', ''),
        trim(r->>'description'), trim(r->>'merchant'), (r->>'amount')::numeric, nullif(upper(r->>'fx_currency'), ''),
        nullif(r->>'fx_amount', '')::numeric, nullif(upper(r->>'country'), ''), trim(r->>'category'), coalesce(r->>'subcategory', ''),
        coalesce(r->>'kind', 'recurring'), coalesce(nullif(r->>'reimbursed', '')::numeric, 0), nullif(r->>'trip_id', '')::bigint,
        coalesce(r->>'labelled_by', 'rule'), coalesce(nullif(r->>'statement', ''), label), sid, trim(r->>'ref'), coalesce(r->>'note', ''), who)
      on conflict (ref) do nothing;
      get diagnostics n = row_count;
      added := added + n;
      skipped := skipped + 1 - n;
    end loop;
  end loop;
  perform nw_link_trips();
  return nw_load() || jsonb_build_object('added', added, 'skipped', skipped);
end $$;

-- d = [{ id, category?, subcategory?, kind?, reimbursed?, trip_id?, note? }], all or nothing.
-- Only the fields given change; each row becomes labelled_by = 'user'.
create or replace function public.nw_update_expenses(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; cur public.nw_expenses; amt numeric;
begin
  perform nw_require_member();
  if jsonb_typeof(d) is distinct from 'array' then raise exception 'Send a list of changes'; end if;
  for r in select value from jsonb_array_elements(d) loop
    select * into cur from nw_expenses where id = nullif(r->>'id', '')::bigint;
    if cur.id is null then raise exception 'A transaction no longer exists. Reload and try again'; end if;
    if r ? 'category' and coalesce(trim(r->>'category'), '') = '' then raise exception 'A category can''t be empty'; end if;
    if r ? 'kind' and coalesce(r->>'kind', '') not in ('recurring', 'travel', 'one_off', 'reimbursed', 'excluded') then raise exception 'Unknown kind'; end if;
    if r ? 'reimbursed' then
      amt := coalesce(nullif(r->>'reimbursed', '')::numeric, 0);
      if amt < 0 then raise exception 'The amount paid back can''t be negative'; end if;
      if amt > abs(cur.amount) then raise exception 'The amount paid back can''t be more than the transaction'; end if;
    end if;
    if nullif(r->>'trip_id', '') is not null and not exists (select 1 from nw_trips where id = (r->>'trip_id')::bigint) then
      raise exception 'That trip no longer exists. Reload and try again';
    end if;
    if coalesce(r->>'note', '') ~ '\d([ -]?\d){7,}' then raise exception 'The note looks like it holds a card or account number'; end if;
    update nw_expenses set
      category = case when r ? 'category' then trim(r->>'category') else category end,
      subcategory = case when r ? 'subcategory' then coalesce(r->>'subcategory', '') else subcategory end,
      kind = case when r ? 'kind' then r->>'kind' else kind end,
      reimbursed = case when r ? 'reimbursed' then amt else reimbursed end,
      trip_id = case when r ? 'trip_id' then nullif(r->>'trip_id', '')::bigint else trip_id end,
      note = case when r ? 'note' then coalesce(r->>'note', '') else note end,
      labelled_by = 'user'
    where id = cur.id;
  end loop;
  return nw_load();
end $$;

-- d = { ids: [..] } (or a plain list of ids), or { statement_id } to undo an import: its rows and
-- the statement record go. Returns nw_load() plus deleted.
create or replace function public.nw_delete_expenses(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  perform nw_require_member();
  if jsonb_typeof(d) = 'object' and nullif(d->>'statement_id', '') is not null then
    delete from nw_expenses where statement_id = (d->>'statement_id')::bigint;
    get diagnostics n = row_count;
    delete from nw_statements where id = (d->>'statement_id')::bigint;
  else
    delete from nw_expenses where id in (
      select (value #>> '{}')::bigint from jsonb_array_elements(case when jsonb_typeof(d) = 'array' then d else coalesce(d->'ids', '[]'::jsonb) end));
    get diagnostics n = row_count;
  end if;
  return nw_load() || jsonb_build_object('deleted', n);
end $$;

-- d = { id?, name, start_date?, end_date?, note?, expense_ids? }. Travel rows inside the dates are
-- linked (rows the user labelled keep theirs); expense_ids moves those rows to this trip by hand.
create or replace function public.nw_save_trip(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); tid bigint; sd date; ed date;
begin
  if coalesce(trim(d->>'name'), '') = '' then raise exception 'Give the trip a name'; end if;
  if coalesce(d->>'name', '') ~ '\d([ -]?\d){7,}' or coalesce(d->>'note', '') ~ '\d([ -]?\d){7,}' then raise exception 'The text looks like it holds a card or account number'; end if;
  if nullif(d->>'start_date', '') is not null and d->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The start date must look like 2026-10-24'; end if;
  if nullif(d->>'end_date', '') is not null and d->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'The end date must look like 2026-10-24'; end if;
  sd := nullif(d->>'start_date', '')::date;
  ed := nullif(d->>'end_date', '')::date;
  if sd is not null and ed is not null and ed < sd then raise exception 'The trip ends before it starts'; end if;
  if nullif(d->>'id', '') is not null then
    tid := (d->>'id')::bigint;
    update nw_trips set name = trim(d->>'name'), start_date = sd, end_date = ed, note = coalesce(d->>'note', '') where id = tid;
    if not found then raise exception 'That trip no longer exists. Reload and try again'; end if;
    update nw_expenses set trip_id = null
    where trip_id = tid and labelled_by <> 'user' and (sd is null or ed is null or date not between sd and ed);
  else
    insert into nw_trips (name, start_date, end_date, note, created_by) values (trim(d->>'name'), sd, ed, coalesce(d->>'note', ''), who)
    returning id into tid;
  end if;
  if jsonb_typeof(d->'expense_ids') = 'array' then
    update nw_expenses set trip_id = tid, kind = 'travel', labelled_by = 'user'
    where id in (select (value #>> '{}')::bigint from jsonb_array_elements(d->'expense_ids'));
  end if;
  perform nw_link_trips();
  return nw_load() || jsonb_build_object('trip_id', tid);
end $$;

create or replace function public.nw_delete_trip(t_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform nw_require_member();
  delete from nw_trips where id = t_id;
  return nw_load();
end $$;

-- d = { id?, pattern, category, subcategory?, kind?, priority?, note? }. The pattern must be a valid
-- regular expression; keep to the syntax JavaScript and Postgres share (the site tests rules in
-- the browser, nw_apply_rule here).
create or replace function public.nw_save_rule(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text := nw_require_member(); rid bigint;
begin
  if coalesce(trim(d->>'pattern'), '') = '' then raise exception 'A rule needs a pattern'; end if;
  begin
    perform 'x' ~* (d->>'pattern');
  exception when others then
    raise exception 'That pattern isn''t a valid regular expression';
  end;
  if coalesce(trim(d->>'category'), '') = '' then raise exception 'A rule needs a category'; end if;
  if nullif(d->>'kind', '') is not null and d->>'kind' not in ('recurring', 'travel', 'one_off', 'reimbursed', 'excluded') then raise exception 'Unknown kind'; end if;
  if nullif(d->>'priority', '') is not null and d->>'priority' !~ '^-?\d+$' then raise exception 'The priority must be a whole number'; end if;
  if nullif(d->>'id', '') is not null then
    rid := (d->>'id')::bigint;
    update nw_expense_rules set pattern = trim(d->>'pattern'), category = trim(d->>'category'), subcategory = coalesce(d->>'subcategory', ''),
      kind = nullif(d->>'kind', ''), priority = coalesce(nullif(d->>'priority', '')::int, 100), note = coalesce(d->>'note', '')
    where id = rid;
    if not found then raise exception 'That rule no longer exists. Reload and try again'; end if;
  else
    insert into nw_expense_rules (pattern, category, subcategory, kind, priority, note, created_by)
    values (trim(d->>'pattern'), trim(d->>'category'), coalesce(d->>'subcategory', ''), nullif(d->>'kind', ''),
      coalesce(nullif(d->>'priority', '')::int, 100), coalesce(d->>'note', ''), who)
    returning id into rid;
  end if;
  return nw_load() || jsonb_build_object('rule_id', rid);
end $$;

create or replace function public.nw_delete_rule(r_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform nw_require_member();
  delete from nw_expense_rules where id = r_id;
  return nw_load();
end $$;

-- Re-categorises the rows a rule matches, except rows the user labelled and rows an earlier rule
-- (lower priority, or the same priority and a lower id) matches. Returns nw_load() plus changed.
create or replace function public.nw_apply_rule(r_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.nw_expense_rules; n int;
begin
  perform nw_require_member();
  select * into u from nw_expense_rules where id = r_id;
  if u.id is null then raise exception 'That rule no longer exists. Reload and try again'; end if;
  update nw_expenses e set category = u.category, subcategory = u.subcategory, kind = coalesce(u.kind, e.kind), labelled_by = 'rule'
  where e.labelled_by <> 'user' and (e.merchant ~* u.pattern or e.description ~* u.pattern)
    and not exists (select 1 from nw_expense_rules o
      where (o.priority, o.id) < (u.priority, u.id) and (e.merchant ~* o.pattern or e.description ~* o.pattern));
  get diagnostics n = row_count;
  perform nw_link_trips();
  return nw_load() || jsonb_build_object('changed', n);
end $$;

revoke execute on function public.nw_load(), public.nw_link_trips(), public.nw_save_expenses(jsonb), public.nw_update_expenses(jsonb),
  public.nw_delete_expenses(jsonb), public.nw_save_trip(jsonb), public.nw_delete_trip(bigint), public.nw_save_rule(jsonb),
  public.nw_delete_rule(bigint), public.nw_apply_rule(bigint) from public, anon, authenticated;
grant execute on function public.nw_load(), public.nw_save_expenses(jsonb), public.nw_update_expenses(jsonb),
  public.nw_delete_expenses(jsonb), public.nw_save_trip(jsonb), public.nw_delete_trip(bigint), public.nw_save_rule(jsonb),
  public.nw_delete_rule(bigint), public.nw_apply_rule(bigint) to authenticated;

commit;
