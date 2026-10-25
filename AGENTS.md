# Asset tracker: guide for coding assistants

Household net worth tracker for two people (YJ and JY). A static website on GitHub Pages
backed by Supabase. Read this before changing anything.

## Ground rules
- **This repository is public.** Never commit figures, balances, email addresses, Supabase
  service-role keys, exports or the history import. The anon key in `js/config.js` is public
  by design and is fine.
- **No build step.** Plain HTML, CSS and browser JavaScript. Don't add a bundler, framework,
  npm dependencies or TypeScript without asking. Pushing to `main` deploys.
- **Don't edit** `js/supabase.js` (supabase-js 2.118.0 UMD), `js/chart.umd.js` (Chart.js 4.4.7),
  or `js/pdf.min.js` and `js/pdf.worker.min.js` (pdfjs-dist 3.11.174 legacy UMD build and worker,
  the last release with a UMD build). They're vendored on purpose so the site loads nothing from
  other hosts. pdf.js 3.x is affected by CVE-2024-4367, so every `getDocument` call must pass
  `isEvalSupported: false`.
- **Database changes go in a new numbered file** in `supabase/` (next is `009_...sql`), written
  to be safe to run twice, and are run by hand in the Supabase SQL Editor. Never edit an old one.
- **History is frozen.** Jul-20 to Aug-26 came from a Google Sheet and is not to be cleaned up
  or rewritten. Change how things are shown, not the stored past. Only the owners correct past
  months, through the site, from source documents; the crypto lines were reconciled that way from
  the Kraken, Binance and Ledger ledgers on 24 Oct 2026 (now per coin per account, Binance
included), after a full backup.

## Files
| File | Role |
|---|---|
| `index.html` | Markup: header, sign-in screen, Overview, Activity, Spending, Home and Update tabs |
| `styles.css` | All styling. Colour tokens at the top, light and dark |
| `js/config.js` | Supabase URL and anon key; Saxo app key (empty = Saxo sync off) |
| `js/app.js` | All logic, in this order: helpers, `compute()` and `unitsAt()`; Supabase data layer (`api`); Overview (`renderHeadline`, `buildChart`, ...); Update (`startDraft`, `applyTracked`, `renderForm`, `save`, ...); Citi statement import (`pdfLines`, `readCiti`, `importCiti`, ...); Saxo sync (`startSaxo`, `finishSaxo`, `fillSaxo`, ...); Activity (`renderActivity`, `addMovement`, ...); Home (`amortise`, `renderCommitments`, `renderLoan`, `renderDueSoon`, ...); Spending (`showSpending`, ...); tabs; sign-in and start-up |
| `supabase/002_shared_access.sql` | Members table and the `nw_*` functions the site calls |
| `supabase/003_lockdown.sql` | Closes every table to the public and signed-in roles |
| `supabase/004_movements.sql` | Movements table, `nw_save_movements`, `nw_delete_movement`, `nw_setup_holdings`, and `nw_load` with movements |
| `supabase/005_owed.sql` | Money owed back table, `nw_save_owed`, `nw_delete_owed`, and `nw_load` with owed |
| `supabase/006_reconcile.sql` | Movement `ref`, `nw_apply_movements` (change, delete and add movements in one go), and `nw_load` with refs |
| `supabase/007_home.sql` | Commitments, loans and rate periods; `nw_save_commitment`, `nw_pay_commitment`, `nw_delete_commitment`, `nw_save_loan`, `nw_delete_loan`; and `nw_load` with commitments and loans |
| `supabase/008_spending.sql` | Expenses, trips, rules and statements; `nw_save_expenses`, `nw_update_expenses`, `nw_delete_expenses`, `nw_save_trip`, `nw_delete_trip`, `nw_save_rule`, `nw_delete_rule`, `nw_apply_rule`; and `nw_load` with them |
| `docs/portfolio-analysis-prompt.md` | Prompt for a separate, read-only analysis chat. Keep its table descriptions in step with any schema change |
| `.github/workflows/keep-alive.yml` | Pings `nw_ping()` twice a week so the free project doesn't pause |

`001_setup.sql` (tables plus the imported history) is deliberately not in the repo.

## Data model (Supabase, schema `public`)
- `nw_items`: accounts and holdings. `category` cash|stocks|crypto|rsu; `kind` balance (one
  amount) or holding (units x price); `currency` SGD|USD; `source` is the app it's read from
  and becomes a section on the Update tab; `monthly` true = re-entered each month, false =
  carried over; `active` false = hidden from the form but kept in history.
- `nw_months`: one row per `month` ('YYYY-MM'). `fx` is **USD per 1 SGD** (0.78 means S$1 = US$0.78).
  `salary`, `bonus`, `other_flow` in SGD; `stock_added`, `crypto_added` in USD; `note`;
  `updated_by` (email) and `updated_at`.
- `nw_entries`: (`month`, `item_id`) -> `amount`, `price`. For a holding, amount = units.
- `nw_members`: emails allowed to use the site.
- `nw_movements`: one row per buy, sell, vest, reward, fee or opening balance on a holding
  (`item_id`, an `nw_items` row of kind holding: one asset at one account). `units` are signed
  (negative for sell, transfer_out, fee); `amount` and `fee` are in the holding's currency. A
  transfer between holdings is a transfer_out and transfer_in pair sharing a `transfer_id`.

- `nw_owed`: money owed back. One row per payment made that will be given back (positive `amount`,
  S$) or repayment (negative), on a cash balance item such as "House payments to be repaid".
- `nw_commitments`: house payments due. `date_due`, `label`, `amount` (S$, positive),
  `paid_from` cash|cpf, `status` planned|paid with `paid_on` set exactly when paid, `repayable`,
  and `owed_id` (the `nw_owed` record made when a repayable cash payment is marked paid).
- `nw_loans`: a mortgage. `principal` (S$), `start_date` (drawdown), `tenure_months`,
  `cpf_monthly` (S$ from CPF each month), `base_rate` and `adverse_rate` (% a year, for the rate
  card only), `note`.
- `nw_loan_rates`: a loan's rate periods. `rate` (% a year) applies from `from_date` until the next
  period starts; `lock_in_end` is optional. Unique per (`loan_id`, `from_date`); deleted with the loan.
- `nw_expenses`: one card or bank transaction. `date` (transaction date), `posted`, `source`
  citi_card|uob_card|citi_bank|manual, `card` (a label such as "Citi Rewards", never a number),
  `description` (scrubbed statement text), `merchant` (normalised key), `amount` (S$, positive =
  money out, negative = refund), `fx_currency`, `fx_amount`, `country` (ISO-2), `category`,
  `subcategory`, `kind` recurring|travel|one_off|reimbursed|excluded, `reimbursed` (S$ paid back),
  `trip_id`, `labelled_by` rule|guess|user, `statement` (e.g. `citi_card:2026-03`), `statement_id`,
  `ref` (unique dedupe key), `note`.
- `nw_trips`: `name`, `start_date`, `end_date`, `note`.
- `nw_expense_rules`: `pattern` (case-insensitive regex on the merchant key and description),
  `category`, `subcategory`, `kind` (null = leave as detected), `priority` (lower runs first), `note`.
- `nw_statements`: one per imported statement (per card on a combined card statement): `source`,
  `card`, `period_start`, `period_end`, `purchases`, `credits`, `lines`, `imported_at`. Unique per
  (`source`, `card`, `period_start`, `period_end`).

## Home: commitments and mortgage
The Home tab (`showHome`) is hidden behind a one-line note until `007_home.sql` has been run
(`nw_load()` then has `commitments` and `loans`). It doesn't touch net worth: `compute()`, the
categories and the Overview chart ignore these tables, and CPF stays outside the tracker.

Commitments are planned payments, newest due first, with totals still to pay from cash and from
CPF. "Mark paid" asks for the date (today by default) and calls `nw_pay_commitment`; a repayable
cash payment also creates a paid `nw_owed` record, on the item `nw_save_owed` would pick, so the
money owed back line follows without entering it twice. A paid commitment keeps only its label and
note editable; one linked to an owed record can't be deleted until that record is.

`nw_save_loan` saves the loan and replaces all its rate periods in one go. It refuses a first
period after the drawdown, periods out of order, and a lock-in that ends before its own period or
after the next one starts. The form is built for one loan; a picker appears once there is one, so
more can be added.

`amortise(loan)` is pure and returns one row per instalment (due one month after the drawdown, then
monthly, clamped to the month's end): `month`, `date`, `rate`, `instalment`, `interest`,
`principal`, `balance`, `cpf`, `cash`, `cpfUsed`, `cpfAccrued`. Interest is on monthly rest. The
instalment is the annuity over the months left (`annuity()`), worked out at the start and again
whenever the rate changes. `cpf` is the lesser of `cpf_monthly` and the instalment; `cpfAccrued`
adds CPF OA interest at 2.5% a year compounded monthly (`CPF_OA_RATE`), shown as an estimate.
Nothing is rounded except for display. On load, `checkAmortise` checks S$1,000,000 at 3% over 360
months gives 4,216.04 a month and ends within a cent of zero, and `console.warn`s if not.

The mortgage section shows this month's instalment (or the first, before it starts), a rate card at
the current, base and adverse rates over the balance and months left, total interest, and a yearly
schedule in a collapsed `<details>`. With `cpf_monthly` 0 the CPF lines and columns are left out
and the whole instalment counts as cash. Within 90 days of the current period's `lock_in_end`
(`repricing()`), it shows a repricing alert. The Overview's "Due soon" card (`renderDueSoon`, hidden
when empty) lists planned commitments due within 90 days, nearest first, plus that alert.

## Spending
The Spending tab (`showSpending`) is the itemised view of card and bank outflows, beside the
inferred spending in `compute()`, which stays as it is. It's hidden behind a one-line note until
`008_spending.sql` has been run (`nw_load()` then has `expenses`, `trips`, `expense_rules` and
`statements`). Built in phases: the tables and functions are in; statement importers (Citi card
PDF, UOB card `.xls`, Citibank account outflows), categorisation and the analysis views come next.
Every total, average, standout and trip table is worked out in the browser; nothing derived is
stored.

- **Never store or show a card or account number, or a `Ref No`.** The importers drop them and
  statement text goes through `scrub()`. As a backstop, the description, merchant, card and note
  columns (and the functions that write them) refuse any run of 8 or more digits.
- **Never commit** a statement, an export, a transaction, a merchant name taken from real data,
  or any figure. Built-in rules use generic names only (chains, airlines, apps, government
  bodies); personal rules live in `nw_expense_rules`.
- `nw_save_expenses` takes `{ statement, rows }` or a list of them, all or nothing. A statement
  already imported (same source, card and period) is reused; a row whose `ref` exists is skipped,
  so importing a file twice adds nothing and a user's edits survive. It returns `nw_load()` plus
  `added` and `skipped`. `nw_delete_expenses({ statement_id })` undoes an import.
- `nw_update_expenses` changes only the fields given and sets `labelled_by = 'user'`; rules never
  touch those rows. `nw_apply_rule` re-categorises rows the rule matches, except user-labelled
  rows and rows an earlier rule (lower priority, then lower id) matches. Rule patterns are tested
  in both JavaScript and Postgres, so keep to syntax both share.
- Travel rows inside a trip's dates are linked to it (`nw_link_trips`, internal) on import, on
  saving a trip and on applying a rule, unless the user labelled them. `nw_save_trip` with
  `expense_ids` moves rows to a trip by hand (for bookings paid ahead); shrinking a trip unlinks
  automatic rows that fall outside it.

## Money owed back
House payments (and anything else paid out that will be given back) go in `nw_owed`, not as
one-offs. The cash item they belong to is worth payments minus repayments up to the month's last
day (`owedAt()`); the Update form shows it read-only, like tracked units, so bank cash can swing
without changing net worth or the inferred spending. The Activity tab's "Money owed back to you"
section adds and deletes records; a separate Claude chat may add them too through
`nw_save_owed`, as `docs/portfolio-analysis-prompt.md` describes (those show as "added outside
the site"). Without `item_id`, `nw_save_owed` uses the one item with records, or the one active
cash item whose name says "repaid". It refuses repaying more than is owed.

## Positions and movements
Investments are moving from monthly totals to positions. Until there are any movements, the
Activity tab shows a one-time "Your holdings today" form (`renderSetup`, `saveSetup`): one row per
asset per account, saved through `nw_setup_holdings`. It refuses to switch totals off while a
month between the last saved month and the set-up date is still unsaved. Once a holding has any movement, its
units for every month after the frozen history (`FROZEN_UNTIL`) come from `unitsAt()`, the sum of
its movements up to that month's last day, and the Update form shows them read-only; only the
price is entered. Holdings without movements, balances and bank cash work as before. Saved months
are not rewritten: a month picks up new units only when it's saved again. Switched-off items are
not carried into a new month, so switching off a total that positions replace (such as
Stock positions at Saxo) doesn't count it twice. Movements can be changed (Edit on the Activity
list) through `nw_apply_movements`, which refuses anything that leaves a holding below zero on any
date. Cost basis and gains come from movements by average cost (`costsAt()`): a buy adds its amount
and fee, a reward or vest its value, a sale takes cost off at the average (the rest is realised
gain), a transfer carries cost across, a fee in units keeps the cost, and an opening without a cost
makes the holding's cost unknown. The Overview shows Cost and Gain per holding; where part of a
combined line has no cost, the gain covers only the part that does. Next: prices fetched
automatically.

## Exchange ledger import (Kraken and Binance)
"Import exchange ledger" on the Activity tab reads Kraken's ledger export in the browser: the CSV
(exact; columns refid, time, type, subtype, asset, wallet, amount, fee, balance, amountusd) or the
PDF statement (amounts rounded to 4 decimal places, so differences under 0.0005 are ignored). Asset
codes are normalised (`krakenCoin`: XXBT to BTC, ETH.F to ETH). A coin's balance on a day is the last
resulting balance of each asset and wallet, added up (`krakenTotals`). For each Kraken holding with
movements, `krakenPlan` proposes: correcting the opening to the ledger's balance on the opening
date (only when the file starts by then), one staking reward per coin per month (valued from
amountusd), buys and sells (priced from the US$ or stablecoin leg), deposits and withdrawals (the
other account is chosen, or skipped), and anything else as a reward or fee. Entries netting to zero
(moves between wallets) are ignored. Changes carry refs (`kraken:reward:ETH:2026-10`,
`kraken:<refid>:<coin>`), so importing again proposes only what's new. `krakenHistory` shows
month-end Kraken balances beside the ETH and BTC the tracker stored across all accounts, for
correcting past months on the Update tab. The file is never uploaded or kept.

Binance's transaction history CSV (`readBinanceCsv`: Time, Account, Operation, Coin, Change) has no
balance column, so balances are added up from the first row in exact decimal (BigInt, 12 places)
and the export must start at the account's first transaction; it's refused if a coin would go
below zero. Rows at the same second form one trade (additions sorted before deductions). The
User ID column is never read. The same plan, history and refs apply, with `binance:` refs and
holdings whose account is Binance; the file type is detected from the CSV header.

## Citi statement import
"Import Citi statement" on the Update tab reads a Citibank Singapore PDF statement entirely in the
browser (pdf.js, loaded only when used) and fills the form for the month the statement ends in;
it never saves, uploads or keeps the PDF. `textLines` rebuilds lines from pdf.js text items (grouped
by y, sorted by x); amounts may have a stray space before the decimals ("109,862 .01").
`readCiti` takes accounts (name, currency, balance) from the Checking and Savings & Investments
summary, then each account's transactions, telling withdrawals from deposits by the column headers,
and refuses the whole statement unless opening − withdrawals + deposits = closing for every account.
The SGD savings account's value is the running balance on its "SALARY PAYMENT" credit (the closing
balance if there's none), and that credit is the salary. Movements of S$5,000 or more are listed to
tick as one-offs. Accounts map to Citibank cash items by currency and name (deposits to deposits),
never by account number: account numbers must never be stored, shown or committed, and statement
text shown on screen goes through `scrub()`. Never commit a statement or anything taken from one.

## Saxo sync
"Sync from Saxo" on the Update tab reads positions and the cash balance from Saxo's OpenAPI (live)
and fills the form; no trades. Sign-in is OAuth code flow with PKCE on Saxo's own page
(`live.logonvalidation.net`), using the app key in `js/config.js` (public by design: PKCE apps have
no secret). The verifier, state and month sit in sessionStorage only across the redirect; the
access token is kept in memory for the one sync and never stored. On return (`?code=&state=`),
`finishSaxo` runs after the data loads: `/port/v1/netpositions/me` and `/port/v1/balances/me`.
Positions match Saxo holdings by ticker (the symbol before ":"); prices are filled, units only for
holdings not tracked by Activity (a difference is reported instead). Broker cash takes CashBalance.
Before the holdings set-up, the Stock positions total takes the sum of positions, and the panel
offers to copy the positions into the set-up form. Supabase's `detectSessionInUrl` is off so it
never treats Saxo's reply as its own. Saxo account ids, keys and tokens are never shown or stored.

## How the site talks to the database
The browser never touches tables. It calls these RPC functions through supabase-js:
`nw_load()`, `nw_save_month(d jsonb)`, `nw_delete_month(m text)`, `nw_save_item(d jsonb)`,
`nw_save_movements(d jsonb)` (a list, saved all or nothing), `nw_delete_movement(m_id bigint)`,
`nw_setup_holdings(d jsonb)` (the one-time start: creates holdings, their opening balances and
switches off the totals they replace, all or nothing), `nw_save_owed(d jsonb)`, `nw_delete_owed(o_id bigint)`,
`nw_apply_movements(d jsonb)` (`{ delete, update, add }`, all or nothing; adds with an existing ref are skipped),
`nw_save_commitment(d jsonb)`, `nw_pay_commitment(c_id bigint, paid_on date)` (refuses one already
paid), `nw_delete_commitment(c_id bigint)`, `nw_save_loan(d jsonb)` (the loan plus its `rates`
list, all or nothing) and `nw_delete_loan(l_id bigint)`,
`nw_save_expenses(d jsonb)`, `nw_update_expenses(d jsonb)`, `nw_delete_expenses(d jsonb)`,
`nw_save_trip(d jsonb)`, `nw_delete_trip(t_id bigint)`, `nw_save_rule(d jsonb)`,
`nw_delete_rule(r_id bigint)` and `nw_apply_rule(r_id bigint)`. A few return `nw_load()` with an
extra key or two (`added`, `skipped`, `deleted`, `changed`, `trip_id`, `rule_id`).
Each is `SECURITY DEFINER` and starts with `nw_require_member()`, which allows a signed-in user
only if their email is in `nw_members`. Each returns the full dataset (same shape as `nw_load`),
which the page re-renders from. Keep that contract: any new write function must call
`nw_require_member()`, return `nw_load()`, and be granted to `authenticated` only.

`nw_load()` returns `{ me, members, items, months: [{ month, fx, salary, ..., entries: { item_id: [amount, price] } }], movements: [{ id, date, item_id, type, units, amount, fee, note, transfer_id, created_by }] }`.
`movements` is missing until `004_movements.sql` has been run; the Activity tab then says so.
`owed: [{ id, date, item_id, amount, note, created_by }]` is added by `005_owed.sql`; until then
the "Money owed back to you" section stays hidden.
`commitments: [{ id, date_due, label, amount, paid_from, status, paid_on, repayable, owed_id, note, created_by }]`
(by `date_due`) and `loans: [{ id, label, principal, start_date, tenure_months, cpf_monthly, base_rate, adverse_rate, note, created_by, rates: [{ id, rate, from_date, lock_in_end }] }]`
are added by `007_home.sql`; until then the Home tab shows only a note.
`expenses` (by date, every column above plus `id`), `trips`, `expense_rules` (by priority) and
`statements` (by period end) are added by `008_spending.sql`; until then the Spending tab shows
only a note.

## Calculations (all in `compute()` in app.js; nothing derived is stored)
- Value in SGD: amount (x price for holdings), divided by `fx` if USD.
- Net worth = sum of all entries. Category totals = sum by `category`.
- Spending = income + other_flow - change in cash - money moved into investments (in SGD).
  It's inferred, so a month with an unrecorded inflow shows negative spending.
- Cost basis = running sum of `stock_added` / `crypto_added` converted at each month's fx.

## Sign-in
Email and password (`signInWithPassword`). The form uses `autocomplete="username"` and
`current-password` so iCloud Keychain and other password managers save and fill it. The site
never signs anyone up; the two accounts are created in the Supabase dashboard, and passwords are
set there or with a one-off SQL update that is never committed. No sign-in emails are sent.

Passkeys (`signInWithPasskey`, `registerPasskey`; beta in Supabase, on by default in supabase-js
2.118) sit on top of that. A signed-in user adds one from the header; after that it signs them in
without a password. They're bound to the Relying Party ID set under Authentication, Passkeys
(`whyjaysee.github.io`), so they don't work on localhost. Keep the password as the fallback.

## Running locally
Serve the folder over HTTP (opening the file directly won't work), for example
`python3 -m http.server 5500`, then open http://localhost:5500. It uses the live database,
so anything you save is real.

## Style
- Copy is plain and specific, sentence case, no exclamation marks. Errors say what happened
  and what to do.
- Money: `money()`, `signed()`, `pct()` helpers; S$ for SGD, US$ for USD.
- Colours come from CSS variables (`--cash`, `--stocks`, `--crypto`, `--rsu`, `--ink`, ...),
  defined for light and dark. Don't hard-code colours.
- Escape anything user-entered with `esc()` before putting it in HTML.
