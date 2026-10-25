# Portfolio analysis prompt

Paste the block below into a new Claude chat to analyse the portfolio. That chat starts with no
memory of how this app was built, but it can read the data straight from Supabase through the
Supabase connector, so no figures need pasting in.

Before pasting, replace `SHEET_LINK_HERE` with the Google Sheet link. It's left out of this file
because the repository is public.

```
I want to analyse my investment portfolio. Read-only: don't change any data, tables or files, with one exception: recording house payments and repayments, described at the end.

My data is in my Supabase project "personal finance" (id yushkredjvgjmbnhnfsl), in these tables:
- nw_items: accounts and holdings (category cash/stocks/crypto/rsu; kind "balance" = one amount, "holding" = units x price; currency SGD or USD)
- nw_months: one row per month (YYYY-MM). fx = USD per 1 SGD (0.78 means S$1 = US$0.78). salary, bonus, other_flow in SGD; stock_added and crypto_added = new money in, in USD
- nw_entries: value per item per month (amount, plus price for holdings; for a holding, amount = units)
- nw_movements: each buy, sell, transfer, vest, reward, fee or opening balance on a holding (item_id = one asset at one account). units are signed (negative for sell, transfer_out, fee); amount and fee are in the holding's currency; a transfer is a transfer_out and transfer_in pair sharing a transfer_id; ref marks movements imported from a ledger (such as kraken:reward:ETH:2026-10 for a month's staking). Cost basis is by average cost from opening amounts, buys and reward values. Once a holding has movements, its monthly units come from them, and the totals they replaced (such as Stock positions at Saxo) are switched off (active = false) but keep their history
- nw_owed: money owed back to me. Each row is a payment I made that will be given back (positive amount, S$) or a repayment (negative). The cash item "House payments to be repaid" is worth payments minus repayments up to each month's end; I'm buying a house and the cash payments are being given back to me
- nw_commitments: house payments due (date_due, label, amount in S$, paid_from cash or cpf, status planned or paid with paid_on, repayable; owed_id links the nw_owed record made when a repayable cash payment was marked paid). CPF payments are not in net worth
- nw_loans and nw_loan_rates: the mortgage (principal in S$, start_date = drawdown, tenure_months, cpf_monthly = S$ paid from CPF each month, base_rate and adverse_rate in % a year for comparison) and its rate periods (rate in % a year from from_date until the next period, optional lock_in_end). Instalments are worked out on the website, not stored: monthly rest, annuity over the months left, recalculated at each rate change
Call public.nw_load() to get everything as one JSON object, movements, owed, commitments and loans included. History runs Jul-20 to Aug-26 and is frozen as imported.

Known quirks: crypto from Jul-20 to Aug-26 was reconciled on 24 Oct 2026 from the Kraken, Binance and Ledger ledgers and is stored per account (ETH and BTC at Kraken, Ledger and Binance; "Exchange cash" is US$ cash on Kraken; Binance is stored per coin at month-end prices, and the old single "Binance" total is no longer used). Kraken figures start in Sep-20, the start of its export. Kraken's SOL, USDT and USDC are in from Sep-24 (ETHW and BABY aren't before Sep-26). Crypto cost basis is in the 30 Sep 2026 opening amounts, per account: Kraken's and Binance's own average costs, and for Ledger ETH the cost of the coins it actually received (2020 Binance buys, and 7 ETH from Kraken in Dec-23 at Kraken's average then), traced through each account's trades since 2020. stock_added and crypto_added don't cover the reconciled crypto, so returns from them are unreliable before Sep-26. Dec-21 shows a cash inflow that wasn't income.

The Google Sheet with my individual stock positions is SHEET_LINK_HERE (tab "Stock Portfolio").

Start by summarising my allocation, returns on what I put in, and how concentrated I am, then ask me what I want to dig into.

Recording house payments and repayments (the only writes allowed):
- When I tell you I've paid something towards the house that will be given back, or that money has been given back, record it with exactly one call per payment or repayment:
  select public.nw_save_owed('{"date": "2026-01-15", "kind": "paid", "amount": 1000, "note": "Option to purchase"}'::jsonb);
  kind is "paid" (I paid it, owed back to me) or "repaid" (it was given back to me). amount is in S$ and always positive. Leave out item_id; it goes on "House payments to be repaid".
- Before writing, repeat back the date, kind, amount and note and wait for me to confirm. Afterwards, tell me the new amount still owed (payments minus repayments, from nw_load().owed).
- To undo a mistake: select public.nw_delete_owed(<id>); with the id from nw_load().owed, again only after I confirm.
- Don't insert, update or delete rows any other way, and don't call any other nw_ function that changes data. The month's figures update when I next save that month on the website.
```

## Notes
- The "Stock Portfolio" tab in the sheet is out of date, and its Square position shows an error
  because the ticker changed to XYZ. Update it, or give the chat your current Saxo holdings,
  before asking for a per-stock breakdown. Once the holdings are set up on the Activity tab,
  nw_movements has the per-stock positions and the sheet is no longer needed for them.
- The chat records house payments through `nw_save_owed` (from `supabase/005_owed.sql`); those
  entries show on the Activity tab as "added outside the site". Everything else stays read-only.
- If you add new tables or change how the data is stored, update the table descriptions above
  to match.
