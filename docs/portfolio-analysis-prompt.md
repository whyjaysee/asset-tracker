# Portfolio analysis prompt

Paste the block below into a new Claude chat to analyse the portfolio. That chat starts with no
memory of how this app was built, but it can read the data straight from Supabase through the
Supabase connector, so no figures need pasting in.

Before pasting, replace `SHEET_LINK_HERE` with the Google Sheet link. It's left out of this file
because the repository is public.

```
I want to analyse my investment portfolio. Read-only: don't change any data, tables or files.

My data is in my Supabase project "personal finance" (id yushkredjvgjmbnhnfsl), in these tables:
- nw_items: accounts and holdings (category cash/stocks/crypto/rsu; kind "balance" = one amount, "holding" = units x price; currency SGD or USD)
- nw_months: one row per month (YYYY-MM). fx = USD per 1 SGD (0.78 means S$1 = US$0.78). salary, bonus, other_flow in SGD; stock_added and crypto_added = new money in, in USD
- nw_entries: value per item per month (amount, plus price for holdings; for a holding, amount = units)
- nw_movements: each buy, sell, transfer, vest, reward, fee or opening balance on a holding (item_id = one asset at one account). units are signed (negative for sell, transfer_out, fee); amount and fee are in the holding's currency; a transfer is a transfer_out and transfer_in pair sharing a transfer_id. Once a holding has movements, its monthly units come from them, and the totals they replaced (such as Stock positions at Saxo) are switched off (active = false) but keep their history
Call public.nw_load() to get everything as one JSON object, movements included. History runs Jul-20 to Aug-26 and is frozen as imported.

Known quirks: the external ETH holding has no recorded cost basis, so crypto returns are overstated; Dec-21 shows a cash inflow that wasn't income; Jan-24 jumps when the external ETH was first recorded.

The Google Sheet with my individual stock positions is SHEET_LINK_HERE (tab "Stock Portfolio").

Start by summarising my allocation, returns on what I put in, and how concentrated I am, then ask me what I want to dig into.
```

## Notes
- The "Stock Portfolio" tab in the sheet is out of date, and its Square position shows an error
  because the ticker changed to XYZ. Update it, or give the chat your current Saxo holdings,
  before asking for a per-stock breakdown. Once the holdings are set up on the Activity tab,
  nw_movements has the per-stock positions and the sheet is no longer needed for them.
- If you add new tables or change how the data is stored, update the table descriptions above
  to match.
