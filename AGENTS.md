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
- **Database changes go in a new numbered file** in `supabase/` (next is `005_...sql`), written
  to be safe to run twice, and are run by hand in the Supabase SQL Editor. Never edit an old one.
- **History is frozen.** Jul-20 to Aug-26 came from a Google Sheet and is not to be cleaned up
  or rewritten. Change how things are shown, not the stored past.

## Files
| File | Role |
|---|---|
| `index.html` | Markup: header, sign-in screen, Overview, Activity and Update tabs |
| `styles.css` | All styling. Colour tokens at the top, light and dark |
| `js/config.js` | Supabase URL and anon key; Saxo app key (empty = Saxo sync off) |
| `js/app.js` | All logic, in this order: helpers, `compute()` and `unitsAt()`; Supabase data layer (`api`); Overview (`renderHeadline`, `buildChart`, ...); Update (`startDraft`, `applyTracked`, `renderForm`, `save`, ...); Citi statement import (`pdfLines`, `readCiti`, `importCiti`, ...); Saxo sync (`startSaxo`, `finishSaxo`, `fillSaxo`, ...); Activity (`renderActivity`, `addMovement`, ...); tabs; sign-in and start-up |
| `supabase/002_shared_access.sql` | Members table and the `nw_*` functions the site calls |
| `supabase/003_lockdown.sql` | Closes every table to the public and signed-in roles |
| `supabase/004_movements.sql` | Movements table, `nw_save_movements`, `nw_delete_movement`, `nw_setup_holdings`, and `nw_load` with movements |
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
Stock positions at Saxo) doesn't count it twice. Next: cost basis and gains from movements, then
prices fetched automatically.

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
switches off the totals they replace, all or nothing).
Each is `SECURITY DEFINER` and starts with `nw_require_member()`, which allows a signed-in user
only if their email is in `nw_members`. Each returns the full dataset (same shape as `nw_load`),
which the page re-renders from. Keep that contract: any new write function must call
`nw_require_member()`, return `nw_load()`, and be granted to `authenticated` only.

`nw_load()` returns `{ me, members, items, months: [{ month, fx, salary, ..., entries: { item_id: [amount, price] } }], movements: [{ id, date, item_id, type, units, amount, fee, note, transfer_id, created_by }] }`.
`movements` is missing until `004_movements.sql` has been run; the Activity tab then says so.

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
