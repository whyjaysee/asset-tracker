# Asset tracker: guide for coding assistants

Household net worth tracker for two people (YJ and JY). A static website on GitHub Pages
backed by Supabase. Read this before changing anything.

## Ground rules
- **This repository is public.** Never commit figures, balances, email addresses, Supabase
  service-role keys, exports or the history import. The anon key in `js/config.js` is public
  by design and is fine.
- **No build step.** Plain HTML, CSS and browser JavaScript. Don't add a bundler, framework,
  npm dependencies or TypeScript without asking. Pushing to `main` deploys.
- **Don't edit** `js/supabase.js` (supabase-js 2.118.0 UMD) or `js/chart.umd.js` (Chart.js 4.4.7).
  They're vendored on purpose so the site loads nothing from other hosts.
- **Database changes go in a new numbered file** in `supabase/` (next is `004_...sql`), written
  to be safe to run twice, and are run by hand in the Supabase SQL Editor. Never edit an old one.
- **History is frozen.** Jul-20 to Aug-26 came from a Google Sheet and is not to be cleaned up
  or rewritten. Change how things are shown, not the stored past.

## Files
| File | Role |
|---|---|
| `index.html` | Markup: header, sign-in screen, Overview and Update tabs |
| `styles.css` | All styling. Colour tokens at the top, light and dark |
| `js/config.js` | Supabase URL and anon key |
| `js/app.js` | All logic, in this order: helpers and `compute()`; Supabase data layer (`api`); Overview (`renderHeadline`, `buildChart`, ...); Update (`startDraft`, `renderForm`, `save`, ...); tabs; sign-in and start-up |
| `supabase/002_shared_access.sql` | Members table and the `nw_*` functions the site calls |
| `supabase/003_lockdown.sql` | Closes every table to the public and signed-in roles |
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

## How the site talks to the database
The browser never touches tables. It calls four RPC functions through supabase-js:
`nw_load()`, `nw_save_month(d jsonb)`, `nw_delete_month(m text)`, `nw_save_item(d jsonb)`.
Each is `SECURITY DEFINER` and starts with `nw_require_member()`, which allows a signed-in user
only if their email is in `nw_members`. Each returns the full dataset (same shape as `nw_load`),
which the page re-renders from. Keep that contract: any new write function must call
`nw_require_member()`, return `nw_load()`, and be granted to `authenticated` only.

`nw_load()` returns `{ me, members, items, months: [{ month, fx, salary, ..., entries: { item_id: [amount, price] } }] }`.

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
