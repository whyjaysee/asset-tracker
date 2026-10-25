// Net worth tracker. Plain browser JavaScript; no build step.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Shared by both pages: loading data, the calculations, and number formatting.
const CATS = [
  { id: 'cash', name: 'Cash' },
  { id: 'stocks', name: 'Stocks' },
  { id: 'crypto', name: 'Crypto' },
  { id: 'rsu', name: 'RSU' },
];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthLong = (m) => `${MONTH_NAMES[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const monthShort = (m) => `${MONTH_NAMES[+m.slice(5) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const monthName = (m) => MONTH_NAMES[+m.slice(5) - 1];
function nextMonth(m) {
  let y = +m.slice(0, 4), mo = +m.slice(5) + 1;
  if (mo > 12) { mo = 1; y++; }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

const nf0 = new Intl.NumberFormat('en-SG', { maximumFractionDigits: 0 });
const money = (v) => (v == null || isNaN(v) ? '–' : (v < 0 ? '−' : '') + 'S$' + nf0.format(Math.abs(Math.round(v))));
const signed = (v) => (v == null || isNaN(v) ? '–' : (v < 0 ? '−' : '+') + 'S$' + nf0.format(Math.abs(Math.round(v))));
const pct = (v, d = 0) => (v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
const signedPct = (v, d = 1) => (v == null || !isFinite(v) ? '–' : (v < 0 ? '−' : '+') + Math.abs(v * 100).toFixed(d) + '%');
const compact = (v) => {
  const a = Math.abs(v);
  return (v < 0 ? '−' : '') + (a >= 1e6 ? (a / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'm' : a >= 1000 ? Math.round(a / 1000) + 'k' : Math.round(a));
};
const plain = (v, maxDp = 6) => (v == null ? '' : new Intl.NumberFormat('en-SG', { maximumFractionDigits: maxDp }).format(v));
// Decimal places that keep very small prices (such as BONK at US$0.0000038) exact.
const tiny = (v, dp = 6) => (v && Math.abs(v) < 0.01 ? 10 : dp);

// Value of one entry in SGD. fx is USD per 1 SGD (0.78 means S$1 = US$0.78).
function entrySgd(item, entry, fx) {
  if (!entry || entry[0] == null) return 0;
  const native = entry[0] * (item.kind === 'holding' ? (entry[1] || 0) : 1);
  return item.currency === 'USD' ? native / fx : native;
}

// Turns raw months into one computed row per month.
function compute(data) {
  const items = Object.fromEntries(data.items.map((i) => [i.id, i]));
  let prev = null, stockCost = 0, cryptoCost = 0;
  return data.months.map((m) => {
    const by = { cash: 0, stocks: 0, crypto: 0, rsu: 0 };
    const lines = [];
    for (const [id, e] of Object.entries(m.entries)) {
      const it = items[id];
      if (!it) continue;
      const v = entrySgd(it, e, m.fx);
      by[it.category] += v;
      lines.push({ item: it, amount: e[0], price: e[1], value: v });
    }
    const net = by.cash + by.stocks + by.crypto + by.rsu;
    const income = m.salary + m.bonus;
    const moved = (m.stock_added + m.crypto_added) / m.fx; // cash sent to investments, in SGD
    stockCost += m.stock_added / m.fx;
    cryptoCost += m.crypto_added / m.fx;
    const row = { ...m, by, lines, net, income, moved, stockCost, cryptoCost, change: null, changePct: null, spending: null, saved: null, delta: null };
    if (prev) {
      row.change = net - prev.net;
      row.changePct = prev.net ? row.change / prev.net : null;
      row.delta = Object.fromEntries(CATS.map((c) => [c.id, by[c.id] - prev.by[c.id]]));
      // Spending is whatever income did not end up in cash or investments.
      row.spending = income + m.other_flow - (by.cash - prev.by.cash) - moved;
      row.saved = income - row.spending;
    }
    prev = row;
    return row;
  });
}

// Once a holding has movements (supabase/004_movements.sql), its units come from them.
// Months up to FROZEN_UNTIL are the imported history and keep their stored units.
const FROZEN_UNTIL = '2026-08';
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthEnd = (m) => isoDay(new Date(+m.slice(0, 4), +m.slice(5), 0));
function unitsAt(d, itemId, day) {
  let u = null;
  for (const v of d.movements || []) if (v.item_id === itemId && v.date <= day) u = (u || 0) + Number(v.units);
  return u == null ? null : Math.round(u * 1e10) / 1e10;
}
// Cost of each holding up to a day, by average cost, in the holding's currency. A buy adds its amount
// and fee, a reward or vest its value, a sale takes cost off at the average price (the rest is
// realised gain), a transfer carries cost to the other account, and a fee in units keeps the cost.
// An opening or transfer without a known cost makes that holding's cost unknown.
const MOVE_ORDER = { opening: 0, buy: 1, vest: 1, reward: 1, transfer_out: 2, transfer_in: 3, sell: 4, fee: 5 };
function costsAt(d, day) {
  const out = {}, moved = {};
  const get = (id) => out[id] || (out[id] = { units: 0, cost: 0, realised: 0, unknown: false });
  const moves = (d.movements || []).filter((v) => v.date <= day).sort((a, b) => a.date.localeCompare(b.date) || MOVE_ORDER[a.type] - MOVE_ORDER[b.type] || a.id - b.id);
  for (const v of moves) {
    const h = get(v.item_id), u = Number(v.units), avg = h.units > 0 ? h.cost / h.units : 0;
    if (v.type === 'transfer_out') { moved[v.transfer_id] = { cost: avg * -u, unknown: h.unknown }; h.cost -= avg * -u; }
    else if (v.type === 'transfer_in') { const m = moved[v.transfer_id] || { cost: 0, unknown: true }; h.cost += m.cost; h.unknown = h.unknown || m.unknown; }
    else if (v.type === 'sell') { h.realised += Number(v.amount || 0) - Number(v.fee || 0) - avg * -u; h.cost -= avg * -u; }
    else if (v.type !== 'fee') {
      if (v.amount == null && v.type === 'opening') h.unknown = true;
      h.cost += Number(v.amount || 0) + (v.type === 'buy' ? Number(v.fee || 0) : 0);
    }
    h.units += u;
    if (h.units <= 1e-12) { h.units = 0; h.cost = 0; h.unknown = false; }
  }
  return out;
}

// Money owed back (supabase/005_owed.sql): a cash line's value is payments minus repayments so far.
function owedAt(d, itemId, day) {
  let v = null;
  for (const o of d.owed || []) if (o.item_id === itemId && o.date <= day) v = (v || 0) + Number(o.amount);
  return v == null ? null : Math.round(v * 100) / 100;
}

function toast(text, isError) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = text;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 2600);
}


// ---------- data: Supabase, signed in as a household member ----------
const sb = window.supabase.createClient(window.NW_CONFIG.supabaseUrl, window.NW_CONFIG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: false } });
const api = {
  data: null, online: false, loadedAt: null,
  async rpc(fn, args) {
    let res;
    try { res = await sb.rpc(fn, args); } catch (e) { throw { code: 'network', message: String(e && e.message || e) }; }
    if (res.error) throw { code: res.error.code || res.status, status: res.status, message: res.error.message || '' };
    this.data = res.data; this.online = true; this.loadedAt = Date.now();
    return res.data;
  },
  load() { return this.rpc('nw_load'); },
  saveMonth(m) { return this.rpc('nw_save_month', { d: m }); },
  deleteMonth(m) { return this.rpc('nw_delete_month', { m }); },
  saveItem(d) { return this.rpc('nw_save_item', { d }); },
  saveMovements(list) { return this.rpc('nw_save_movements', { d: list }); },
  deleteMovement(id) { return this.rpc('nw_delete_movement', { m_id: id }); },
  setupHoldings(d) { return this.rpc('nw_setup_holdings', { d }); },
  saveOwed(d) { return this.rpc('nw_save_owed', { d }); },
  applyMovements(d) { return this.rpc('nw_apply_movements', { d }); },
  saveCommitment(d) { return this.rpc('nw_save_commitment', { d }); },
  payCommitment(id, day) { return this.rpc('nw_pay_commitment', { c_id: id, paid_on: day }); },
  deleteCommitment(id) { return this.rpc('nw_delete_commitment', { c_id: id }); },
  saveLoan(d) { return this.rpc('nw_save_loan', { d }); },
  deleteLoan(id) { return this.rpc('nw_delete_loan', { l_id: id }); },
  deleteOwed(id) { return this.rpc('nw_delete_owed', { o_id: id }); },
  saveExpenses(d) { return this.rpc('nw_save_expenses', { d }); },
  updateExpenses(list) { return this.rpc('nw_update_expenses', { d: list }); },
  deleteExpenses(d) { return this.rpc('nw_delete_expenses', { d }); },
  saveTrip(d) { return this.rpc('nw_save_trip', { d }); },
  deleteTrip(id) { return this.rpc('nw_delete_trip', { t_id: id }); },
  saveRule(d) { return this.rpc('nw_save_rule', { d }); },
  deleteRule(id) { return this.rpc('nw_delete_rule', { r_id: id }); },
  applyRule(id) { return this.rpc('nw_apply_rule', { r_id: id }); },
};
function memberName(email) {
  const m = api.data && (api.data.members || []).find((x) => x.email === email);
  return (m && String(m.name).trim()) || email;
}
function explain(err) {
  const msg = String((err && err.message) || '');
  if (/not_a_member/.test(msg)) return 'This email is not on the household list. Ask the owner to add it in Supabase (table nw_members).';
  if (err && (err.status === 401 || /JWT|jwt/.test(msg))) return 'Your sign-in has expired. Sign out and sign in again.';
  if (err && (err.code === 'network' || err.status === 540 || err.status === 503 || /paused|Failed to fetch|NetworkError/i.test(msg)))
    return 'The database is not answering. If it was paused, open your Supabase dashboard and choose Restore project, then try again in a few minutes.';
  return msg || 'Something went wrong talking to Supabase.';
}
const unsure = (err) => err && err.code === 'network';
function setStatus(html, warn, button, onClick) {
  $('status').innerHTML = html ? `<div class="bar ${warn ? 'warn' : ''}"><span>${html}</span>${button ? `<button class="btn" id="statusbtn" type="button">${button}</button>` : ''}</div>` : '';
  if (button) $('statusbtn').onclick = onClick;
}
const clock = (t) => new Date(t).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const prefs = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('nw.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nw.' + k, JSON.stringify(v)); } catch {} },
};

const VIEWS = [
  { id: 'net', name: 'Net worth' },
  { id: 'mix', name: 'Breakdown' },
  { id: 'change', name: 'Monthly change' },
  { id: 'flow', name: 'Income and spending' },
  { id: 'returns', name: 'Investment returns' },
];
const RANGES = [{ id: 12, name: '1Y' }, { id: 36, name: '3Y' }, { id: 0, name: 'All' }];

let rows = [], chart = null;
const state = {
  view: prefs.get('view', 'net'),
  range: prefs.get('range', 0),
  on: prefs.get('on', { cash: true, stocks: true, crypto: true, rsu: true }),
  mixPct: prefs.get('mixPct', false),
  asset: prefs.get('asset', 'stocks'),
  month: null,
};

function seg(el, options, current, onPick) {
  el.innerHTML = '';
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.name;
    b.setAttribute('aria-pressed', String(o.id === current));
    b.onclick = () => onPick(o.id);
    el.appendChild(b);
  }
}

function selected() { return rows.find((r) => r.month === state.month) || rows[rows.length - 1]; }
function visible() { return state.range ? rows.slice(-state.range) : rows; }
function activeCats(list) {
  return CATS.filter((c) => list.some((r) => Math.abs(r.by[c.id]) > 0.5));
}
function sumOn(by) { return CATS.reduce((t, c) => t + (state.on[c.id] ? by[c.id] : 0), 0); }

// ---------- headline, tiles, tables ----------
function renderHeadline() {
  const r = selected(), i = rows.indexOf(r), prev = rows[i - 1], yearAgo = rows[i - 12];
  $('figure').textContent = money(r.net);
  let s = '';
  if (prev) {
    const dir = r.change >= 0 ? 'up' : 'down';
    s += `<b class="${dir}">${r.change >= 0 ? 'Up' : 'Down'} ${money(Math.abs(r.change))}</b> (${signedPct(r.changePct)}) on ${monthName(prev.month)}. `;
    const moves = CATS.map((c) => ({ name: c.name.toLowerCase(), d: r.delta[c.id] })).filter((m) => Math.abs(m.d) >= 1)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (moves.length) {
      s += `${moves[0].name[0].toUpperCase() + moves[0].name.slice(1)} moved most, ${signed(moves[0].d)}`;
      if (moves.length > 1) s += '; ' + moves.slice(1).map((m) => `${m.name} ${signed(m.d)}`).join(', ');
      s += '. ';
    }
  }
  if (yearAgo) {
    const d = r.net - yearAgo.net;
    s += `Over 12 months that is ${d >= 0 ? 'up' : 'down'} ${money(Math.abs(d))} (${signedPct(d / yearAgo.net)}) from ${money(yearAgo.net)}.`;
  }
  $('story').innerHTML = s;

  const cats = CATS.filter((c) => Math.abs(r.by[c.id]) > 0.5);
  $('classes').innerHTML = cats.map((c) => `
    <div class="class" style="--c:var(--${c.id})">
      <div class="label"><span class="dot"></span>${c.name}</div>
      <div class="value">${money(r.by[c.id])}</div>
      <div class="sub">${pct(r.by[c.id] / r.net)} of total${prev ? ` · <span class="${r.delta[c.id] >= 0 ? 'up' : 'down'}">${signed(r.delta[c.id])}</span>` : ''}</div>
    </div>`).join('');
  $('sharebar').innerHTML = cats.map((c) => `<span style="--c:var(--${c.id});flex:${Math.max(r.by[c.id], 0)}"></span>`).join('');
}

// Crypto is shown as ETH, BTC and everything else, each combined across accounts.
const coinGroup = (it) => (/^ETH\b/i.test(it.name) ? 'ETH' : /^BTC\b/i.test(it.name) ? 'BTC' : 'Others');
function cryptoGroups(lines) {
  const groups = {};
  for (const l of lines) {
    const g = coinGroup(l.item);
    const x = groups[g] || (groups[g] = { name: g, value: 0, units: 0, usd: 0, unitsKnown: g !== 'Others', parts: {}, coins: {}, ids: [] });
    x.value += l.value;
    x.ids.push(l.item.id);
    if (l.item.kind === 'holding') { x.units += l.amount; x.usd += l.amount * (l.price || 0); } else x.unitsKnown = false;
    const a = l.item.source || 'Other';
    const p = x.parts[a] || (x.parts[a] = { account: a, value: 0, units: 0, ids: [] });
    p.ids.push(l.item.id);
    p.value += l.value;
    if (l.item.kind === 'holding') p.units += l.amount;
    const coin = l.item.kind === 'holding' ? l.item.name : `${l.item.name} (all coins)`;
    x.coins[coin] = (x.coins[coin] || 0) + l.value;
  }
  return ['ETH', 'BTC', 'Others'].filter((g) => groups[g]).map((g) => groups[g]);
}

function renderHoldings() {
  const r = selected();
  $('holdtitle').textContent = `What you held in ${monthLong(r.month)}`;
  const order = Object.fromEntries(CATS.map((c, i) => [c.id, i]));
  const shown = r.lines.filter((l) => Math.abs(l.value) > 0.5);
  // Cost and value in S$ of the holdings among ids whose cost is known; null when none has movements.
  const costs = r.month > FROZEN_UNTIL ? costsAt(api.data, monthEnd(r.month)) : {};
  const valueOf = Object.fromEntries(r.lines.map((l) => [l.item.id, l.value]));
  const costOf = (ids) => {
    const tracked = ids.filter((id) => costs[id]);
    if (!tracked.length) return null;
    const known = tracked.filter((id) => !costs[id].unknown);
    const sgd = (id) => { const it = api.data.items.find((i) => i.id === id); return it.currency === 'USD' ? costs[id].cost / r.fx : costs[id].cost; };
    const usd = known.every((id) => api.data.items.find((i) => i.id === id).currency === 'USD');
    const units = known.reduce((t, id) => t + costs[id].units, 0);
    return { cost: known.reduce((t, id) => t + sgd(id), 0), value: known.reduce((t, id) => t + (valueOf[id] || 0), 0), partial: known.length < ids.length, none: !known.length,
      avg: usd && units > 0 && !(known.length < ids.length) ? known.reduce((t, id) => t + costs[id].cost, 0) / units : null };
  };
  const crypto = cryptoGroups(shown.filter((l) => l.item.category === 'crypto')).map((g) => ({
    item: { name: g.name !== 'Others' ? g.name : Object.keys(g.coins).some((c) => c.endsWith('(all coins)')) ? 'Other crypto' : `Other crypto (${Object.keys(g.coins).length})`, category: 'crypto', kind: g.unitsKnown ? 'holding' : 'group' },
    amount: g.units, price: g.units ? g.usd / g.units : null, value: g.value, cost: costOf(g.ids),
  }));
  const lines = shown.filter((l) => l.item.category !== 'crypto').map((l) => ({ ...l, cost: l.item.kind === 'holding' ? costOf([l.item.id]) : null }))
    .concat(crypto).sort((a, b) => order[a.item.category] - order[b.item.category] || b.value - a.value);
  const anyCost = lines.some((l) => l.cost != null);
  $('holdings').innerHTML = `<tr><th>Holding</th><th>Units</th><th>Price</th>${anyCost ? '<th>Avg cost</th>' : ''}<th>Value</th>${anyCost ? '<th>Cost</th><th>Gain</th>' : ''}<th>Share</th></tr>` + lines.map((l) => {
    const h = l.item.kind === 'holding';
    const native = l.item.currency === 'USD' && l.item.kind === 'balance' ? ` <span class="muted">US$${plain(l.amount, 0)}</span>` : '';
    const c = l.cost, g = c && c.value - c.cost;
    const cost = !c ? '' : c.none ? '<span class="muted">unknown</span>' : money(c.cost) + (c.partial ? ' <span class="muted">+ unknown</span>' : '');
    const gain = !c || c.none ? '' : `<span class="${g >= 0 ? 'up' : 'down'}">${signed(g)}</span>${c.partial ? ' <span class="muted">on part</span>' : ''}`;
    return `<tr><td><span class="dot" style="--c:var(--${l.item.category})"></span>${esc(l.item.name)}${native}</td>
      <td>${h ? plain(l.amount, 4) : ''}</td><td>${h && l.price != null ? 'US$' + plain(l.price, tiny(l.price, 2)) : ''}</td>
      ${anyCost ? `<td>${h && c && c.avg != null ? 'US$' + plain(c.avg, tiny(c.avg, 2)) : ''}</td>` : ''}
      <td>${money(l.value)}</td>${anyCost ? `<td>${cost}</td><td>${gain}</td>` : ''}<td class="muted">${pct(l.value / r.net)}</td></tr>`;
  }).join('') + `<tr><td class="muted" colspan="${anyCost ? 8 : 5}" style="border:0;white-space:normal">US$ converted at S$1 = US$${r.fx}. Crypto is combined across accounts; ETH and BTC prices and average costs are blended across them (each account's own is under Crypto by coin).${anyCost ? ' Cost is what each account paid for what it holds, by average cost, from the Activity tab. Where part of a line has no recorded cost, the gain covers only the part that does.' : ''}</td></tr>`;
}

function renderFlow() {
  const r = selected();
  const line = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
  if (r.spending == null) {
    $('flow').innerHTML = line('Income', money(r.income));
    $('flownote').textContent = 'Spending needs a previous month to compare against.';
    return;
  }
  let h = line('Salary', money(r.salary));
  if (r.bonus) h += line('Bonus', money(r.bonus));
  if (r.other_flow) h += line(esc(r.note) || 'One-off', signed(r.other_flow));
  h += line('Change in cash', signed(r.delta.cash));
  if (r.moved) h += line('Moved into investments', money(r.moved));
  h += line('Spending', money(r.spending), 'total');
  h += line('Saved', `${money(r.saved)} <span class="muted">${r.income ? pct(r.saved / r.income) + ' of income' : ''}</span>`, 'total');
  $('flow').innerHTML = h;
  $('flownote').textContent = r.spending < 0
    ? 'Cash rose by more than your income this month, so some money came in that is not recorded as income. Add it as a one-off on the Update tab.'
    : 'Spending is worked out, not entered: income minus what stayed in cash or went into investments.';
}

function renderHistory() {
  const head = ['Month', 'Net worth', 'Change', 'Cash', 'Stocks', 'Crypto', 'Income', 'Spending', 'Saved'];
  $('history').innerHTML = '<tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr>' + [...rows].reverse().map((r) =>
    `<tr><td>${monthShort(r.month)}</td><td>${money(r.net)}</td><td class="${r.change >= 0 ? 'up' : 'down'}">${r.change == null ? '' : signed(r.change)}</td>
     <td>${money(r.by.cash)}</td><td>${money(r.by.stocks)}</td><td>${money(r.by.crypto)}</td>
     <td>${money(r.income)}</td><td>${r.spending == null ? '' : money(r.spending)}</td><td>${r.saved == null ? '' : money(r.saved)}</td></tr>`).join('');
}

async function downloadCsv() {
  const head = ['month', 'net_worth', 'cash', 'stocks', 'crypto', 'rsu', 'change', 'salary', 'bonus', 'spending', 'saved', 'stock_added_usd', 'crypto_added_usd', 'other_flow', 'usd_per_sgd', 'note'];
  const n = (v) => (v == null ? '' : Math.round(v * 100) / 100);
  const body = rows.map((r) => [r.month, n(r.net), n(r.by.cash), n(r.by.stocks), n(r.by.crypto), n(r.by.rsu), n(r.change), r.salary, r.bonus, n(r.spending), n(r.saved), r.stock_added, r.crypto_added, r.other_flow, r.fx, '"' + (r.note || '').replace(/"/g, '""') + '"'].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([head.join(',') + '\n' + body.join('\n')], { type: 'text/csv' }));
  a.download = 'net-worth.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- chart ----------
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(c) {
    const a = c.tooltip?.getActiveElements?.() || [];
    if (!a.length || c.config.type === 'bar') return;
    const x = a[0].element.x, { top, bottom } = c.chartArea;
    c.ctx.save();
    c.ctx.strokeStyle = css('--ink-3'); c.ctx.lineWidth = 1;
    c.ctx.beginPath(); c.ctx.moveTo(x, top); c.ctx.lineTo(x, bottom); c.ctx.stroke();
    c.ctx.restore();
  },
};

function buildChart() {
  const list = visible(), labels = list.map((r) => monthShort(r.month));
  const cats = activeCats(list), shown = cats.filter((c) => state.on[c.id]);
  const surface = css('--surface'), ink = css('--ink');
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: surface, pointHoverBorderWidth: 2, tension: 0.15, ...extra });
  const names = shown.map((c) => c.name.toLowerCase());
  const scope = shown.length === cats.length ? 'Net worth' : names.length ? names.join(' + ').replace(/^./, (x) => x.toUpperCase()) : 'Nothing selected';
  let type = 'line', datasets = [], title = '', note = '', chips = true, legend = [], sub = null, yPct = false, stacked = false, footer = null;

  if (state.view === 'net') {
    title = `${scope} over time`;
    datasets = [line(scope, list.map((r) => sumOn(r.by)), ink)];
  } else if (state.view === 'mix') {
    stacked = true; yPct = state.mixPct;
    title = state.mixPct ? 'Share of the total held in each' : 'What the total is made of';
    sub = { options: [{ id: false, name: 'S$' }, { id: true, name: '%' }], current: state.mixPct, pick: (v) => { state.mixPct = v; prefs.set('mixPct', v); } };
    datasets = shown.map((c) => line(c.name, list.map((r) => (state.mixPct ? (sumOn(r.by) ? r.by[c.id] / sumOn(r.by) : 0) : r.by[c.id])), css('--' + c.id), { fill: true, borderColor: surface, tension: 0 }));
    if (!state.mixPct) footer = (items) => 'Total  ' + money(items.reduce((t, i) => t + i.parsed.y, 0));
  } else if (state.view === 'change') {
    type = 'bar';
    title = `Month-on-month change in ${scope.toLowerCase()}`;
    note = 'Includes both market moves and money you added.';
    const all = rows.map((r) => sumOn(r.by));
    const offset = rows.length - list.length;
    const d = list.map((r, i) => (i + offset === 0 ? null : all[i + offset] - all[i + offset - 1]));
    datasets = [{ label: 'Change', data: d, backgroundColor: d.map((v) => (v >= 0 ? css('--cash') : css('--down'))), borderRadius: 3, maxBarThickness: 18 }];
  } else if (state.view === 'flow') {
    chips = false;
    title = 'Income against spending';
    note = 'The gap between the lines is what you saved. Spending is worked out from the change in cash, so a month with an unrecorded inflow dips below zero.';
    datasets = [line('Income', list.map((r) => r.income), css('--cash')), line('Spending', list.map((r) => r.spending), css('--stocks'))];
    legend = [['Income', '--cash'], ['Spending', '--stocks']];
  } else {
    chips = false;
    const a = state.asset, cost = a === 'stocks' ? 'stockCost' : 'cryptoCost';
    const last = list[list.length - 1], gain = last.by[a] - last[cost];
    title = `${a === 'stocks' ? 'Stocks' : 'Crypto'}: what it is worth against what you put in`;
    note = `${monthShort(last.month)}: worth ${money(last.by[a])} on ${money(last[cost])} put in, a ${gain >= 0 ? 'gain' : 'loss'} of ${money(Math.abs(gain))}.` + (a === 'crypto' ? ' The imported history has no cost recorded for the externally held ETH, so this gain is overstated.' : '');
    sub = { options: [{ id: 'stocks', name: 'Stocks' }, { id: 'crypto', name: 'Crypto' }], current: a, pick: (v) => { state.asset = v; prefs.set('asset', v); } };
    datasets = [line('Worth', list.map((r) => r.by[a]), css('--' + a)), line('Put in', list.map((r) => r[cost]), css('--ink-3'), { borderDash: [5, 4], stepped: true })];
    legend = [['Worth', '--' + a], ['Put in', '--ink-3']];
  }

  $('charttitle').textContent = title;
  $('chartnote').textContent = note;
  $('chart').setAttribute('aria-label', title);
  const chipsEl = $('chips');
  chipsEl.innerHTML = '';
  if (chips) {
    for (const c of cats) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.style.setProperty('--c', `var(--${c.id})`);
      b.setAttribute('aria-pressed', String(!!state.on[c.id]));
      b.innerHTML = `<span class="dot"></span>${c.name}`;
      b.onclick = () => { state.on[c.id] = !state.on[c.id]; prefs.set('on', state.on); buildChart(); };
      chipsEl.appendChild(b);
    }
  } else {
    chipsEl.innerHTML = legend.map(([n, v]) => `<span class="legend" style="--c:var(${v})"><span class="dash"></span>${n}</span>`).join('');
  }
  const subEl = $('sub');
  subEl.style.display = sub ? '' : 'none';
  if (sub) seg(subEl, sub.options, sub.current, (v) => { sub.pick(v); buildChart(); });

  const grid = css('--line'), tick = css('--ink-2');
  const fmtY = (v) => (yPct ? pct(v) : compact(v));
  chart?.destroy();
  chart = new Chart($('chart'), {
    type,
    data: { labels, datasets },
    plugins: [crosshair],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => { if (els.length) { state.month = list[els[0].index].month; $('asof').value = state.month; renderMonth(); } },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      scales: {
        x: { grid: { display: false }, border: { color: grid }, ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { stacked, max: yPct ? 1 : undefined, grid: { color: grid }, border: { display: false }, ticks: { color: tick, callback: fmtY, maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--ink'), titleColor: css('--bg'), bodyColor: css('--bg'), footerColor: css('--bg'), padding: 10, boxPadding: 4, usePointStyle: true,
          itemSort: (a, b) => (stacked ? b.datasetIndex - a.datasetIndex : 0),
          callbacks: {
            title: (items) => monthLong(list[items[0].dataIndex].month),
            label: (i) => ` ${i.dataset.label}  ${i.parsed.y == null ? '–' : yPct ? pct(i.parsed.y, 1) : type === 'bar' ? signed(i.parsed.y) : money(i.parsed.y)}`,
            footer: footer || (() => ''),
          },
        },
      },
    },
  });
}

// Crypto for the chosen month as ETH, BTC and Others; each bar is split by the account it's held in.
// Before the holdings set-up, crypto was stored as combined lines; those are grouped the same way.
function renderCoins() {
  const r = selected();
  const lines = r.lines.filter((l) => l.item.category === 'crypto' && Math.abs(l.value) > 0.5);
  $('coins-sec').hidden = !lines.length;
  if (!lines.length) return;
  const total = lines.reduce((t, l) => t + l.value, 0);
  const byAccount = {};
  for (const l of lines) byAccount[l.item.source || 'Other'] = (byAccount[l.item.source || 'Other'] || 0) + l.value;
  const accounts = Object.keys(byAccount).sort((a, b) => byAccount[b] - byAccount[a]);
  const color = (a) => `var(--acct-${(accounts.indexOf(a) % 5) + 1})`;
  const list = cryptoGroups(lines), max = Math.max(...list.map((g) => g.value), 1);
  // Each account's own average cost per coin (US$), where its cost is known.
  const costs = r.month > FROZEN_UNTIL ? costsAt(api.data, monthEnd(r.month)) : {};
  const avgOf = (ids) => {
    const cs = ids.map((id) => costs[id]);
    if (!cs.length || cs.some((c) => !c || c.unknown)) return null;
    const u = cs.reduce((t, c) => t + c.units, 0);
    return u > 0 ? cs.reduce((t, c) => t + c.cost, 0) / u : null;
  };
  $('coins-title').textContent = `Crypto by coin, ${monthLong(r.month)}`;
  $('coins-legend').innerHTML = accounts.map((a) => `<span class="legend" style="--c:${color(a)}"><span class="dot"></span>${esc(a)} ${money(byAccount[a])}</span>`).join('');
  $('coins').innerHTML = list.map((g) => {
    const parts = Object.values(g.parts).sort((a, b) => accounts.indexOf(a.account) - accounts.indexOf(b.account));
    const units = (p) => (g.unitsKnown ? plain(p.units, 6) : '');
    const where = parts.map((p) => `${p.account} ${g.unitsKnown ? plain(p.units, 6) : money(p.value)}`).join(', ');
    const inside = g.name === 'Others'
      ? `<div class="coinparts muted">${Object.entries(g.coins).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${esc(c)} ${money(v)}`).join(' · ')}</div>` : '';
    return `<div class="coin">
      <div class="coinname">${esc(g.name)}${g.unitsKnown ? `<span class="muted">${plain(g.units, 6)}</span>` : ''}</div>
      <div class="coinbar" role="img" aria-label="${esc(g.name)}: ${esc(where)}"><div style="width:${(Math.max(g.value, 0) / max * 100).toFixed(2)}%">${parts.map((p) =>
        `<span style="--c:${color(p.account)};flex:${Math.max(p.value, 0)}" title="${esc(p.account)}: ${g.unitsKnown ? plain(p.units, 6) + ' ' + esc(g.name) + ', ' : ''}${money(p.value)}"></span>`).join('')}</div></div>
      <div class="coinval">${money(g.value)} <span class="muted">${pct(g.value / total)}</span></div>
      <div class="coinparts">${parts.map((p) => { const a = g.unitsKnown ? avgOf(p.ids) : null; return `<span><span class="dot" style="--c:${color(p.account)}"></span>${esc(p.account)} ${units(p)} <span class="muted">${money(p.value)}${a != null ? ` · avg US$${plain(a, tiny(a, 2))}` : ''}</span></span>`; }).join(' &nbsp; ')}</div>
      ${inside}
    </div>`;
  }).join('');
  $('coins-note').textContent = `${money(total)} in crypto across ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}. Bars are sized against the largest coin; colours show where each is held.`;
}

function renderMonth() { renderHeadline(); renderHoldings(); renderFlow(); renderCoins(); }
function renderControls() {
  seg($('views'), VIEWS, state.view, (v) => { state.view = v; prefs.set('view', v); renderControls(); buildChart(); });
  seg($('ranges'), RANGES, state.range, (v) => { state.range = v; prefs.set('range', v); renderControls(); buildChart(); });
}

let overviewWired = false;
function showOverview(d) {
  renderDueSoon(d);
  rows = compute(d);
  $('ov-empty').hidden = rows.length > 0;
  $('ov-body').hidden = rows.length === 0;
  if (!rows.length) return;
  if (!rows.some((r) => r.month === state.month)) state.month = rows[rows.length - 1].month;
  $('asof').innerHTML = [...rows].reverse().map((r) => `<option value="${r.month}">${monthLong(r.month)}</option>`).join('');
  $('asof').value = state.month;
  if (!overviewWired) {
    overviewWired = true;
    $('asof').onchange = (e) => { state.month = e.target.value; renderMonth(); };
    $('csv').onclick = downloadCsv;
    const repaint = () => { if (rows.length && !$('page-overview').hidden) buildChart(); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);
    new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  renderControls(); renderMonth(); renderHistory(); buildChart();
}

let data = null, draft = null, base = null, exists = false, dirty = false, tracked = new Set(), imported = new Set();

const parse = (s) => { const v = parseFloat(String(s).replace(/[, ]/g, '')); return isNaN(v) ? null : v; };
const sym = (cur) => (cur === 'USD' ? 'US$' : 'S$');

function startDraft(month) {
  const found = data.months.find((m) => m.month === month);
  base = [...data.months].reverse().find((m) => m.month < month) || null;
  exists = !!found; dirty = false;
  imported = new Set();
  $('citi').hidden = true;
  $('saxo').hidden = true;
  if (found) {
    draft = JSON.parse(JSON.stringify(found));
  } else {
    const src = base || { fx: 0.78, salary: 0, entries: {} };
    const active = new Set(data.items.filter((i) => i.active).map((i) => i.id));
    const entries = Object.fromEntries(Object.entries(src.entries).filter(([id]) => active.has(id)).map(([id, e]) => [id, [...e]]));
    draft = { month, fx: src.fx, salary: src.salary, bonus: 0, stock_added: 0, crypto_added: 0, other_flow: 0, note: '', entries };
  }
  const differs = applyTracked();
  $('month').value = month;
  $('title').textContent = monthLong(month);
  $('hint').textContent = (exists
    ? 'Already saved. Change anything and save again.'
    : base ? `New month, filled in from ${monthLong(base.month)}. Enter the numbers below; everything else carries over.` : 'First month. Fill in what you hold.')
    + (differs.length ? ` Units of ${differs.join(', ')} now come from Activity and differ from what was saved; save to update them.` : '');
  $('delete').hidden = !exists;
  $('delete').textContent = 'Delete this month';
  delete $('delete').dataset.armed;
  renderForm(); renderSummary();
}

// Puts the units worked out from Activity into the draft; returns the names that changed.
function applyTracked() {
  tracked = new Set();
  const differs = [];
  if (draft.month <= FROZEN_UNTIL) return differs;
  for (const it of data.items) {
    const u = (it.kind === 'holding' ? unitsAt : owedAt)(data, it.id, monthEnd(draft.month));
    if (u == null) continue;
    tracked.add(it.id);
    const e = draft.entries[it.id] || (draft.entries[it.id] = [null, null]);
    if (exists && e[0] !== u) differs.push(it.name);
    e[0] = u;
  }
  return differs;
}

function field(key, value, prefix, label, cls = '') {
  if (imported.has(key)) cls += ' changed';
  return `<div class="field ${cls}"><span>${prefix}</span><input inputmode="decimal" data-key="${key}" value="${value == null ? '' : plain(value, tiny(value))}" aria-label="${esc(label)}"></div>`;
}

// One section per place you check, in the order you check them.
function groups() {
  const shown = (it) => it.active || (draft.entries[it.id] && draft.entries[it.id][0]);
  const out = [];
  for (const it of data.items.filter(shown)) {
    const name = it.source || 'Other';
    let g = out.find((x) => x.name === name);
    if (!g) out.push((g = { name, items: [] }));
    g.items.push(it);
  }
  return out;
}

function renderForm() {
  let h = '', step = 0;
  const carried = [], names = [];
  const row = (label, fields, was) => `<div class="row"><label>${label}</label>${fields}<span class="was">${was || ''}</span></div>`;
  for (const g of groups()) {
    const now = [];
    for (const it of g.items) {
      const e = draft.entries[it.id] || [null, null], b = base && base.entries[it.id];
      const dot = `<span class="dot" style="--c:var(--${it.category})"></span>`;
      if (it.kind === 'holding') {
        const price = row(`${dot}${esc(it.name)} price`, field(`e.${it.id}.1`, e[1], sym(it.currency), `${it.name} price`, 'span2'), b ? 'was ' + plain(b[1], tiny(b[1], 2)) : '');
        (it.monthly ? now : carried).push(price);
        if (tracked.has(it.id)) {
          carried.push(row(`${dot}${esc(it.name)} units held`, `<div class="field quiet span2"><input value="${plain(e[0])}" readonly aria-label="${esc(it.name)} units held, from Activity"></div>`, 'from Activity'));
        } else {
          carried.push(row(`${dot}${esc(it.name)} units held`, field(`e.${it.id}.0`, e[0], '', `${it.name} units held`, 'span2'), b ? 'was ' + plain(b[0]) : ''));
          names.push(`${it.name} units`);
        }
      } else {
        const r = tracked.has(it.id)
          ? row(`${dot}${esc(it.name)}`, `<div class="field quiet span2"><span>${sym(it.currency)}</span><input value="${plain(e[0])}" readonly aria-label="${esc(it.name)}, from Activity"></div>`, 'from Activity')
          : row(`${dot}${esc(it.name)}`, field(`e.${it.id}.0`, e[0], sym(it.currency), it.name, 'span2'), b ? 'was ' + plain(b[0], 0) : '');
        (it.monthly ? now : carried).push(r);
        if (!it.monthly) names.push(it.name);
      }
    }
    if (now.length) h += `<fieldset><legend><span class="step">${++step}</span>${esc(g.name)} <span class="sum" data-sum="${esc(g.name)}"></span></legend>${now.join('')}</fieldset>`;
  }
  carried.push(row('S$1 buys', field('m.fx', draft.fx, 'US$', 'US dollars per Singapore dollar', 'span2'), base ? 'was ' + base.fx : ''));
  carried.push(row('Salary', field('m.salary', draft.salary, 'S$', 'Salary', 'span2'), base ? 'was ' + plain(base.salary, 0) : ''));
  names.push('exchange rate', 'salary');
  h += `<details class="carried" ${base && !imported.size ? '' : 'open'}>
    <summary>Carried over${base ? ' from ' + monthName(base.month) : ''} <span class="sum">${esc(names.join(', '))}</span></summary>
    <p class="hint">These keep last month's value until you change them.</p>
    ${carried.join('')}
    <h3>Only when it happens</h3>
    ${row('Bonus', field('m.bonus', draft.bonus || null, 'S$', 'Bonus', 'span2'))}
    ${row('Added to stocks', field('m.stock_added', draft.stock_added || null, 'US$', 'New money into stocks', 'span2'))}
    ${row('Added to crypto', field('m.crypto_added', draft.crypto_added || null, 'US$', 'New money into crypto', 'span2'))}
    ${row('One-off in (+) or out (−)', field('m.other_flow', draft.other_flow || null, 'S$', 'One-off amount', 'span2'))}
    ${row('What it was', `<div class="field text span2${imported.has('note') ? ' changed' : ''}"><input data-key="note" value="${esc(draft.note)}" placeholder="e.g. house payment, gift" aria-label="Note"></div>`)}
  </details>`;
  $('form').innerHTML = h;
}

$('form').addEventListener('input', (ev) => {
  const key = ev.target.dataset.key;
  if (!key) return;
  dirty = true;
  if (key === 'note') draft.note = ev.target.value;
  else if (key.startsWith('m.')) draft[key.slice(2)] = parse(ev.target.value) ?? 0;
  else {
    const [, id, idx] = key.split('.');
    const e = draft.entries[id] || (draft.entries[id] = [null, null]);
    e[+idx] = parse(ev.target.value);
  }
  ev.target.closest('.field').classList.add('changed');
  renderSummary();
});
$('form').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });

function cleaned() {
  const entries = {};
  for (const [id, e] of Object.entries(draft.entries)) if (e[0] != null) entries[id] = e;
  return { ...draft, entries };
}

function renderSummary() {
  const d = cleaned();
  const months = data.months.filter((m) => m.month !== d.month).concat(d.fx > 0 ? [d] : []).sort((a, b) => a.month.localeCompare(b.month));
  const r = compute({ items: data.items, months }).find((x) => x.month === d.month);
  $('sumlabel').textContent = `Net worth, ${monthLong(d.month)}`;
  $('save').textContent = `Save ${monthLong(d.month)}`;
  if (!r) { $('sumfigure').textContent = '–'; $('sumchange').textContent = 'Enter an exchange rate above zero.'; $('sumlist').innerHTML = ''; $('save').disabled = true; return; }
  $('save').disabled = !api.online;
  $('delete').disabled = !api.online;
  $('sumfigure').textContent = money(r.net);
  $('sumchange').innerHTML = r.change == null ? '' : `<span class="${r.change >= 0 ? 'up' : 'down'}">${signed(r.change)}</span> (${signedPct(r.changePct)}) on ${monthName(base.month)}`;
  const line = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
  let h = '';
  for (const c of CATS) {
    if (Math.abs(r.by[c.id]) < 0.5 && !(r.delta && Math.abs(r.delta[c.id]) > 0.5)) continue;
    h += line(c.name, `${money(r.by[c.id])}${r.delta ? ` <span class="muted">${signed(r.delta[c.id])}</span>` : ''}`);
  }
  if (r.spending != null) {
    h += line('Spending', money(r.spending), 'total') + line('Saved', money(r.saved), 'total');
  }
  $('sumlist').innerHTML = h;
  for (const g of groups()) {
    const el = [...document.querySelectorAll('[data-sum]')].find((x) => x.dataset.sum === g.name);
    if (el) el.textContent = money(g.items.reduce((t, it) => t + entrySgd(it, d.entries[it.id], d.fx), 0));
  }
}

async function save() {
  if ($('save').disabled) return;
  try {
    data = await api.saveMonth(cleaned());
    toast(`Saved ${monthLong(draft.month)}`);
    startDraft(draft.month);
  } catch (e) { toast(saveError(e), true); }
}
$('save').onclick = save;

$('delete').onclick = async () => {
  const b = $('delete');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
  try {
    data = await api.deleteMonth(draft.month);
    toast(`Deleted ${monthLong(draft.month)}`);
    startDraft(draft.month);
  } catch (e) { toast(saveError(e), true); }
};

$('month').onchange = (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) startDraft(e.target.value); };

// ---------- Citi statement import ----------
// The PDF is read in this browser with pdf.js and is never uploaded or kept. Accounts are matched
// to items by name and currency; account numbers are skipped over, never stored or shown.
const ONE_OFF_SGD = 5000;
const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CURRENCY = /\b(SGD|USD|EUR|GBP|AUD|HKD|JPY|CNY|CHF|CAD|NZD)\b/;
// Amounts such as 1,234.56, also with a stray space before the decimals ("109,862 .01").
const AMOUNT = /(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)\s?\.\s?(\d{2})(?!\d|\s?%)/g;
const DAY_MON_YEAR = '(\\d{1,2})\\s?([A-Za-z]{3,9})\\.?,?\\s?(\\d{4})';
const MON_DAY_YEAR = '([A-Za-z]{3,9})\\.?\\s(\\d{1,2}),?\\s(\\d{4})';
const PERIOD = new RegExp(`${DAY_MON_YEAR}\\s*(?:-|–|to)\\s*${DAY_MON_YEAR}`, 'i');
const PERIOD_MDY = new RegExp(`${MON_DAY_YEAR}\\s*(?:-|–|to)\\s*${MON_DAY_YEAR}`, 'i');
const PERIOD_NUM = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|–|to)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i;
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
// A date at the start of a transaction line: "28 SEP", "Sep 28 2026" or "28/09".
const TX_DATE = new RegExp(`^(?:(\\d{1,2})\\s?${MON}|${MON}\\s(\\d{1,2}),?(?:\\s(\\d{4}))?|(\\d{1,2})\\/(\\d{1,2})(?:\\/\\d{2,4})?)\\b\\s*`, 'i');
// Page furniture between pages, skipped so it doesn't join a transaction's description.
const PAGE_NOISE = /^Page \d+ of \d+$|Statement Period|\(continued\)\s*$|^Transactions Done$|^\S+\/\S+\/\S+\/\S+$/i;
const nf2 = new Intl.NumberFormat('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur2 = (v, c) => (v < 0 ? '−' : '') + sym(c) + nf2.format(Math.abs(v));
const cents = (v) => Math.round(v * 100) / 100;
// Long runs of digits (account and reference numbers) are hidden wherever statement text is shown.
const scrub = (s) => s.replace(/\d[\d\s-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '…' : m)).replace(/\s+/g, ' ').trim();
const isoDate = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
const monthIndex = (name) => MONTHS3.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;
const dayMonth = (iso) => `${+iso.slice(8)} ${MONTH_NAMES[+iso.slice(5, 7) - 1].slice(0, 3)}`;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return loadPdfJs.p || (loadPdfJs.p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.min.js'; resolve(window.pdfjsLib); };
    s.onerror = () => { loadPdfJs.p = null; reject(new Error('The PDF reader did not load. Reload the page and try again.')); };
    document.head.appendChild(s);
  }));
}

// Text lines in reading order. Each keeps the right edge of every character, for telling columns apart.
function textLines(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) <= 2.5) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows.map((row) => {
    let raw = '';
    const right = [];
    for (const it of row.items.sort((a, b) => a.x - b.x)) {
      if (raw) { raw += ' '; right.push(it.x); }
      raw += it.s;
      for (let i = 0; i < it.s.length; i++) right.push(it.x + it.w);
    }
    const amounts = [...raw.matchAll(AMOUNT)].map((m) => ({ v: +(m[1].replace(/,/g, '') + '.' + m[2]), i: m.index, end: m.index + m[0].length, r: right[m.index + m[0].length - 1] }));
    return { raw, right, amounts, text: raw.replace(/\s+/g, ' ').trim() };
  });
}

// pdf.js is configured with isEvalSupported off: pdf.js 3.x is affected by CVE-2024-4367 otherwise.
// Each page's text items: string, position, width and height.
async function pdfPages(bytes) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      pages.push(items.filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height })));
      page.cleanup();
    }
  } finally { doc.destroy(); }
  return pages;
}
async function pdfLines(bytes) { return (await pdfPages(bytes)).flatMap(textLines); }

const lineWithout = (l) => l.amounts.reduceRight((s, a) => s.slice(0, a.i) + ' ' + s.slice(a.end), l.raw).replace(/\s+/g, ' ').trim();
const wordRight = (l, re) => { const m = re.exec(l.raw); return m ? l.right[m.index + m[0].length - 1] : null; };

// Reads the period, the summary accounts and each account's transactions from a Citibank Singapore
// statement, and checks every account adds up. Returns { error } or { start, end, accounts }.
function readCiti(lines) {
  const fail = (error) => ({ error });
  let start = null, end = null;
  for (const l of lines) {
    let m = PERIOD.exec(l.text);
    if (m && monthIndex(m[2]) && monthIndex(m[5])) { start = isoDate(+m[3], monthIndex(m[2]), +m[1]); end = isoDate(+m[6], monthIndex(m[5]), +m[4]); }
    else if ((m = PERIOD_MDY.exec(l.text)) && monthIndex(m[1]) && monthIndex(m[4])) { start = isoDate(+m[3], monthIndex(m[1]), +m[2]); end = isoDate(+m[6], monthIndex(m[4]), +m[5]); }
    else if ((m = PERIOD_NUM.exec(l.text))) { start = isoDate(+m[3], +m[2], +m[1]); end = isoDate(+m[6], +m[5], +m[4]); }
    if (end) break;
  }
  if (!end) return fail('Could not find the statement period. Check this is a Citibank Singapore account statement PDF, not a scan or a credit card statement.');

  const sumStart = lines.findIndex((l) => /^(checking|savings\s*&\s*investments)\b/i.test(l.text));
  if (sumStart < 0) return fail('Could not find the Checking or Savings & Investments summary in this statement.');
  const isOpen = (l) => /OPENING BALANCE|BALANCE BROUGHT FORWARD|BALANCE B\/F/i.test(l.text);
  const firstOpen = lines.findIndex((l, i) => i > sumStart && isOpen(l));
  const accounts = [];
  for (let i = sumStart; i < (firstOpen < 0 ? lines.length : firstOpen); i++) {
    const l = lines[i], c = CURRENCY.exec(l.raw);
    const bal = c && l.amounts.find((a) => a.i > c.index);
    if (!bal) continue;
    const name = l.raw.slice(0, c.index).replace(/\d[\d\s-]*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || /\btotal\b/i.test(name) || /^(account|currency|balance)\b/i.test(name)) continue;
    const same = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase() && a.currency === c[1]);
    if (same) same.summary = cents(same.summary + bal.v);
    else accounts.push({ name, currency: c[1], summary: bal.v, txs: [], details: false });
  }
  if (!accounts.length) return fail('Could not read any accounts from the Checking or Savings & Investments summary.');

  const named = (l) => accounts.find((a) => l.text.toLowerCase().includes(a.name.toLowerCase()));
  const yearOf = (mon) => +end.slice(0, 4) - (mon > +end.slice(5, 7) ? 1 : 0);
  for (let o = (firstOpen < 0 ? lines.length : firstOpen); o < lines.length; o++) {
    if (!isOpen(lines[o])) continue;
    let acc = null, hi = o - 1;
    for (let k = o - 1; k >= Math.max(0, o - 10) && !acc; k--) { acc = named(lines[k]); hi = k; }
    if (!acc || acc.details) continue;
    const c = lines.findIndex((l, i) => i > o && /CLOSING BALANCE/i.test(l.text));
    if (c < 0) return fail(`Could not find the closing balance for ${acc.name}.`);
    if (!lines[o].amounts.length || !lines[c].amounts.length) return fail(`Could not read the opening or closing balance for ${acc.name}.`);
    acc.details = true;
    acc.opening = lines[o].amounts.at(-1).v;
    acc.closing = lines[c].amounts.at(-1).v;

    let head = null;
    for (let k = hi; k < c && !head; k++) if (/withdraw|debit/i.test(lines[k].text) && /deposit|credit/i.test(lines[k].text)) head = lines[k];
    const cols = head && [['d', wordRight(head, /withdrawals?|debits?/i)], ['c', wordRight(head, /deposits?|credits?/i)], ['b', wordRight(head, /balance/i)]].filter(([, r]) => r != null);

    const txs = [];
    let cur = null;
    for (let i = o + 1; i < c; i++) {
      const l = lines[i];
      if (PAGE_NOISE.test(l.text)) continue;
      if (isOpen(l) || /CARRIED FORWARD|BALANCE C\/F|^TOTAL\b/i.test(l.text) || (/withdraw|debit/i.test(l.text) && /balance/i.test(l.text))) { cur = null; continue; }
      const d = TX_DATE.exec(l.text);
      if (d) {
        const mon = d[2] ? monthIndex(d[2]) : d[3] ? monthIndex(d[3]) : +d[7];
        const day = +(d[1] || d[4] || d[6]), year = d[5] ? +d[5] : yearOf(mon);
        let desc = lineWithout(l).replace(TX_DATE, '');
        while (TX_DATE.test(desc)) desc = desc.replace(TX_DATE, '');
        cur = { date: isoDate(year, mon, day), desc, amounts: [...l.amounts] };
        txs.push(cur);
      } else if (l.amounts.length) {
        if (cur && !cur.amounts.length) { cur.amounts.push(...l.amounts); cur.desc += ' ' + lineWithout(l); }
        else { cur = { date: cur ? cur.date : start, desc: lineWithout(l), amounts: [...l.amounts] }; txs.push(cur); }
      } else if (cur) cur.desc += ' ' + l.text;
    }

    let run = acc.opening, debits = 0, credits = 0;
    for (const t of txs.filter((x) => x.amounts.length)) {
      let amt = null, side = null, printed = null;
      if (cols && cols.some(([k]) => k === 'd') && cols.some(([k]) => k === 'c')) {
        for (const a of t.amounts) {
          const k = [...cols].sort((x, y) => Math.abs(a.r - x[1]) - Math.abs(a.r - y[1]))[0][0];
          if (k === 'b') printed = a.v; else if (amt == null) { amt = a.v; side = k; }
        }
      }
      if (amt == null && t.amounts.length >= 2) {
        amt = t.amounts.at(-2).v; printed = t.amounts.at(-1).v;
        side = printed >= run ? 'c' : 'd';
      }
      if (amt == null) return fail(`Could not tell whether a ${t.date ? dayMonth(t.date) : ''} line in ${acc.name} was a withdrawal or a deposit.`);
      if (side === 'c') credits += amt; else debits += amt;
      run = cents(run + (side === 'c' ? amt : -amt));
      if (printed != null && Math.abs(printed - run) > 0.005) return fail(`${acc.name}: the running balance on ${t.date ? dayMonth(t.date) : 'a line'} is ${cur2(printed, acc.currency)}, but the lines before it add up to ${cur2(run, acc.currency)}. Nothing was filled.`);
      acc.txs.push({ date: t.date, desc: t.desc.replace(/\s+/g, ' ').trim(), signed: side === 'c' ? amt : -amt, balance: run });
    }
    const worked = cents(acc.opening - debits + credits);
    const totals = lines[c + 1] && /^TOTAL\b/i.test(lines[c + 1].text) && lines[c + 1].amounts.length === 2 ? lines[c + 1].amounts.map((a) => a.v) : null;
    if (totals && (Math.abs(totals[0] - debits) > 0.005 || Math.abs(totals[1] - credits) > 0.005)) return fail(`${acc.name}: the statement's totals are withdrawals ${cur2(totals[0], acc.currency)} and deposits ${cur2(totals[1], acc.currency)}, but its lines add up to ${cur2(debits, acc.currency)} and ${cur2(credits, acc.currency)}. Nothing was filled.`);
    if (Math.abs(worked - acc.closing) > 0.005) return fail(`${acc.name} doesn't add up: opening ${cur2(acc.opening, acc.currency)} − withdrawals ${cur2(debits, acc.currency)} + deposits ${cur2(credits, acc.currency)} = ${cur2(worked, acc.currency)}, but the closing balance is ${cur2(acc.closing, acc.currency)}. Nothing was filled.`);
    if (Math.abs(acc.closing - acc.summary) > 0.005) return fail(`${acc.name}: the closing balance ${cur2(acc.closing, acc.currency)} doesn't match the summary's ${cur2(acc.summary, acc.currency)}. Nothing was filled.`);
  }
  for (const a of accounts) if (!a.details) a.closing = a.summary;
  return { start, end, accounts };
}

// The Citibank cash item for a statement account: same currency, and a deposit only for a deposit.
function citiItem(acc) {
  const pool = data.items.filter((i) => i.category === 'cash' && i.kind === 'balance' && i.currency === acc.currency && /citi/i.test(i.source || ''));
  const dep = /deposit/i.test(acc.name);
  const one = (list) => { const on = list.filter((i) => i.active); return on.length === 1 ? on[0] : list.length === 1 ? list[0] : null; };
  return one(pool.filter((i) => /deposit/i.test(i.name) === dep)) || one(pool);
}

let citi = null;
async function importCiti(bytes) {
  showCiti({ busy: true });
  let r;
  try { r = readCiti(await pdfLines(bytes)); }
  catch (e) { r = { error: `Could not read that PDF (${e && e.message ? e.message : e}). Check it's the statement PDF downloaded from Citibank.` }; }
  if (r.error) return showCiti(r);
  const month = r.end.slice(0, 7);
  if (month <= FROZEN_UNTIL) return showCiti({ error: `This statement ends in ${monthLong(month)}, inside the imported history, which isn't changed. Import a later statement.` });
  if (dirty && draft.month !== month) return showCiti({ error: `This statement is for ${monthLong(month)}, but you have unsaved changes to ${monthLong(draft.month)}. Save them first, then import again.` });

  // Fills into the open draft when it's the statement's month, keeping anything already entered.
  if (!dirty || draft.month !== month) startDraft(month);
  const notes = [], fills = new Map();
  const savings = r.accounts.find((a) => /interestplus/i.test(a.name)) || r.accounts.find((a) => a.currency === 'SGD' && !/deposit/i.test(a.name));
  const pay = savings && [...savings.txs].reverse().find((t) => t.signed > 0 && /SALARY\s*PAYMENT/i.test(t.desc));
  for (const a of r.accounts) {
    a.value = a === savings && pay ? pay.balance : a.closing;
    a.used = a === savings && pay ? `${cur2(a.value, a.currency)} after salary on ${dayMonth(pay.date)}` : cur2(a.value, a.currency) + (a.details ? '' : ' (summary; no transactions listed)');
    a.item = a.currency === 'SGD' || a.currency === 'USD' ? citiItem(a) : null;
    if (!a.item) { notes.push(`Couldn't match ${a.name} (${a.currency}) to a Citibank cash item, so it was left as it was.`); continue; }
    fills.set(a.item.id, cents((fills.get(a.item.id) || 0) + a.value));
  }
  if (savings && !pay) notes.push(`No SALARY PAYMENT credit in ${savings.name}, so it used the closing balance and left salary as it was.`);
  for (const [id, v] of fills) {
    const e = draft.entries[id] || (draft.entries[id] = [null, null]);
    e[0] = v;
    imported.add(`e.${id}.0`);
  }
  if (pay) { draft.salary = pay.signed; imported.add('m.salary'); }

  const big = [];
  for (const a of r.accounts) for (const t of a.txs) {
    if (t === pay) continue;
    const sgd = a.currency === 'USD' ? t.signed / draft.fx : a.currency === 'SGD' ? t.signed : null;
    if (sgd != null && Math.abs(sgd) >= ONE_OFF_SGD) big.push({ date: t.date, account: a.name, currency: a.currency, signed: t.signed, sgd: cents(sgd), desc: scrub(t.desc), label: scrub(t.desc).slice(0, 60), on: false });
  }
  citi = { ...r, month, notes, pay, savings, big, keep: { other_flow: draft.other_flow, note: draft.note } };
  dirty = true;
  renderForm(); renderSummary();
  showCiti(citi);
}

function applyOneOffs() {
  const on = citi.big.filter((b) => b.on);
  draft.other_flow = on.length ? cents(on.reduce((t, b) => t + b.sgd, 0)) : citi.keep.other_flow;
  draft.note = on.length ? on.map((b) => b.label.trim() || b.desc).join('; ') : citi.keep.note;
  for (const k of ['m.other_flow', 'note']) if (on.length) imported.add(k); else imported.delete(k);
  renderForm(); renderSummary();
}

function showCiti(r) {
  const el = $('citi');
  el.hidden = false;
  el.classList.toggle('error', !!r.error);
  if (r.busy) { el.innerHTML = '<p>Reading the statement in this browser…</p>'; return; }
  const close = '<p class="actions"><button class="btn" type="button" data-citi="close">Close</button></p>';
  if (r.error) { el.innerHTML = `<h2>Statement not imported</h2><p class="err">${esc(r.error)}</p>${close}`; return; }
  const period = r.start ? `${dayMonth(r.start)} to ${dayMonth(r.end)} ${r.end.slice(0, 4)}` : `to ${dayMonth(r.end)} ${r.end.slice(0, 4)}`;
  const accounts = r.accounts.map((a) => `<tr><td class="desc">${esc(a.name)}</td><td>${a.currency}</td><td>${cur2(a.closing, a.currency)}</td><td>${esc(a.used)}</td><td class="desc">${a.item ? esc(a.item.name) : '<span class="muted">not filled</span>'}</td></tr>`).join('');
  const big = r.big.length
    ? `<h3>Movements of S$${nf0.format(ONE_OFF_SGD)} or more</h3>
      <p>Tick any that are one-offs, and edit the label if you like. Ticked ones are added up into "One-off in (+) or out (−)", with their labels in "What it was".</p>
      <div class="scroll"><table><tr><th>One-off</th><th>Date</th><th class="desc">Account</th><th class="desc">Description</th><th>Amount</th><th class="desc">Label</th></tr>${r.big.map((b, i) => `<tr>
        <td><input type="checkbox" data-big="${i}" ${b.on ? 'checked' : ''} aria-label="Count as a one-off"></td><td>${dayMonth(b.date)}</td><td class="desc">${esc(b.account)}</td><td class="desc">${esc(b.desc)}</td>
        <td>${cur2(b.signed, b.currency)}${b.currency === 'SGD' ? '' : ` <span class="muted">${cur2(b.sgd, 'SGD')}</span>`}</td>
        <td class="label"><input data-label="${i}" value="${esc(b.label)}" aria-label="Label" ${b.on ? '' : 'disabled'}></td></tr>`).join('')}</table></div>`
    : `<p>No other movements of S$${nf0.format(ONE_OFF_SGD)} or more.</p>`;
  el.innerHTML = `<h2>Citi statement, ${period}</h2>
    <p>Filled ${monthLong(r.month)}${exists ? ', which was already saved; saving replaces it' : ''}. Check the highlighted fields, then save. Nothing is saved until you do.</p>
    ${r.pay ? `<p>Salary ${cur2(r.pay.signed, 'SGD')} on ${dayMonth(r.pay.date)}, filled in.</p>` : ''}
    ${r.notes.map((n) => `<p class="err">${esc(n)}</p>`).join('')}
    <div class="scroll"><table><tr><th class="desc">Account</th><th>Currency</th><th>Closing balance</th><th>Filled in</th><th class="desc">Into</th></tr>${accounts}</table></div>
    ${big}${close}`;
}

$('citi-btn').onclick = () => $('citi-file').click();
$('citi-file').onchange = async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) await importCiti(new Uint8Array(await f.arrayBuffer()));
};
$('citi').addEventListener('click', (ev) => { if (ev.target.dataset.citi === 'close') $('citi').hidden = true; });
$('citi').addEventListener('change', (ev) => {
  const i = ev.target.dataset.big;
  if (i == null || !citi) return;
  citi.big[+i].on = ev.target.checked;
  $('citi').querySelector(`[data-label="${i}"]`).disabled = !ev.target.checked;
  applyOneOffs();
});
$('citi').addEventListener('input', (ev) => {
  const i = ev.target.dataset.label;
  if (i == null || !citi) return;
  citi.big[+i].label = ev.target.value;
  applyOneOffs();
});

// ---------- Saxo sync: positions and cash balance ----------
// Signs in on Saxo's own page (OAuth code flow with PKCE), reads positions and the cash balance,
// and fills the form. The access token stays in memory for this one sync; nothing from Saxo is
// stored except the figures you save. Account ids and keys are never shown or kept.
const SAXO = { auth: 'https://live.logonvalidation.net', api: 'https://gateway.saxobank.com/openapi' };
const SAXO_STASH = 'nw.saxo';
const saxoRedirect = () => location.origin + location.pathname;
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let saxoBack = null, saxo = null;

async function startSaxo() {
  const key = window.NW_CONFIG.saxoAppKey;
  if (!key) {
    return showSaxo({ error: 'Saxo sync is not set up yet.', setup: true });
  }
  if (dirty) return showSaxo({ error: `You have unsaved changes to ${monthLong(draft.month)}. Save them first: signing in to Saxo leaves this page.` });
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(SAXO_STASH, JSON.stringify({ verifier, state, month: draft.month }));
  const q = new URLSearchParams({ response_type: 'code', client_id: key, state, redirect_uri: saxoRedirect(), code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(`${SAXO.auth}/authorize?${q}`);
}

async function saxoGet(token, path) {
  const out = [];
  let url = SAXO.api + path;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new Error('Saxo turned the request down. Sign in to Saxo again, and check the app has read access.');
    if (!res.ok) throw new Error(`Saxo answered ${res.status}. Try again in a minute.`);
    const body = await res.json();
    if (!Array.isArray(body.Data)) return body;
    out.push(...body.Data);
    url = body.__next ? (body.__next.startsWith('http') ? body.__next : 'https://gateway.saxobank.com' + body.__next) : null;
  }
  return out;
}

// Runs after Saxo sends the browser back here with ?code=…&state=…, once the data has loaded.
async function finishSaxo() {
  const back = saxoBack;
  saxoBack = null;
  const stash = JSON.parse(sessionStorage.getItem(SAXO_STASH) || 'null');
  sessionStorage.removeItem(SAXO_STASH);
  showTab('update');
  if (stash && stash.month) startDraft(stash.month);
  if (back.error) return showSaxo({ error: `Saxo sign-in didn't finish (${back.error}). Try Sync from Saxo again.` });
  if (!stash || stash.state !== back.state) return showSaxo({ error: 'That Saxo sign-in reply did not match this page. Try Sync from Saxo again.' });
  showSaxo({ busy: true });
  let positions, balance;
  try {
    const res = await fetch(`${SAXO.auth}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.code, redirect_uri: saxoRedirect(), client_id: window.NW_CONFIG.saxoAppKey, code_verifier: stash.verifier }),
    });
    if (!res.ok) throw new Error(`Saxo did not accept the sign-in (${res.status}). Try Sync from Saxo again.`);
    const token = (await res.json()).access_token;
    [positions, balance] = await Promise.all([
      saxoGet(token, '/port/v1/netpositions/me?FieldGroups=NetPositionBase,NetPositionView,DisplayAndFormat'),
      saxoGet(token, '/port/v1/balances/me'),
    ]);
  } catch (e) {
    return showSaxo({ error: /fetch|network|load failed/i.test(String(e && e.message)) ? "Couldn't reach Saxo from this page. Check your connection and try again." : String(e && e.message || e) });
  }
  fillSaxo(positions, balance);
}

// Converts between US$ and S$ at the month's rate (fx is US$ per S$1); null for other currencies.
const convert = (v, from, to) => (from === to ? v : from === 'USD' && to === 'SGD' ? v / draft.fx : from === 'SGD' && to === 'USD' ? v * draft.fx : null);

function fillSaxo(positions, balance) {
  const notes = [], rows = [];
  const items = data.items.filter((i) => /saxo/i.test(i.source || ''));
  const holdings = items.filter((i) => i.kind === 'holding');
  const put = (id, idx, v) => {
    const e = draft.entries[id] || (draft.entries[id] = [null, null]);
    e[idx] = idx === 0 ? v : Math.round(v * 1e6) / 1e6;
    imported.add(`e.${id}.${idx}`);
  };
  for (const p of positions) {
    const d = p.DisplayAndFormat || {}, base = p.NetPositionBase || {}, view = p.NetPositionView || {};
    const symbol = String(d.Symbol || '').toUpperCase(), ticker = symbol.split(':')[0];
    const units = Number(base.Amount), price = Number(view.CurrentPrice), currency = d.Currency || '';
    const open = Number(view.AverageOpenPriceIncludingCosts ?? view.AverageOpenPrice);
    const row = { ticker, name: d.Description || '', units, price, currency, value: units * price, cost: open > 0 ? Math.round(units * open * 100) / 100 : null, item: null, type: base.AssetType || '' };
    rows.push(row);
    const it = holdings.find((i) => [ticker, symbol].includes(String(i.name).toUpperCase()));
    if (!it) continue;
    row.item = it;
    const px = convert(price, currency, it.currency);
    if (px == null) { notes.push(`${ticker} is priced in ${currency}, which the tracker doesn't handle, so its price was left as it was.`); continue; }
    put(it.id, 1, px);
    if (tracked.has(it.id)) {
      const mine = draft.entries[it.id][0];
      if (Math.abs(mine - units) > 1e-9) notes.push(`Saxo shows ${plain(units)} ${ticker}, but Activity adds up to ${plain(mine)}. Record the missing buy or sell on the Activity tab.`);
    } else put(it.id, 0, units);
  }
  for (const it of holdings.filter((i) => i.active && !rows.some((r) => r.item === i))) {
    if ((draft.entries[it.id] || [])[0]) notes.push(`${it.name} is in the tracker but not in Saxo any more. If it was sold, record the sale on the Activity tab.`);
  }

  const cashItem = items.find((i) => i.kind === 'balance' && /cash/i.test(i.name));
  const cash = cashItem && convert(Number(balance.CashBalance), balance.Currency, cashItem.currency);
  if (cashItem && cash != null) put(cashItem.id, 0, Math.round(cash * 100) / 100);
  else notes.push(cashItem ? `Saxo's cash is in ${balance.Currency}, which the tracker doesn't handle, so Broker cash was left as it was.` : 'No Saxo cash item to put the cash balance in.');

  const total = items.find((i) => i.kind === 'balance' && i.active && !/cash/i.test(i.name));
  if (total && !rows.some((r) => r.item)) {
    const sum = rows.reduce((t, r) => { const v = convert(r.value, r.currency, total.currency); return v == null ? NaN : t + v; }, 0);
    if (isNaN(sum)) notes.push(`Some positions are in currencies the tracker doesn't handle, so ${total.name} was left as it was.`);
    else { put(total.id, 0, Math.round(sum * 100) / 100); notes.unshift(`${total.name} was filled with the total of your positions. Once you set up your holdings on the Activity tab, each position is filled separately.`); }
  }

  const now = new Date(), today = isoDay(now);
  if (draft.month !== today.slice(0, 7)) notes.unshift(`These are Saxo's figures for today, ${dayMonth(today)} ${today.slice(0, 4)}, not the end of ${monthLong(draft.month)}.`);
  saxo = { at: now, rows, cash: balance.CashBalance, cashCurrency: balance.Currency, notes, cashItem, total: total && !rows.some((r) => r.item) ? total : null };
  dirty = true;
  renderForm(); renderSummary();
  showSaxo(saxo);
}

function showSaxo(r) {
  const el = $('saxo');
  el.hidden = false;
  el.classList.toggle('error', !!r.error);
  const close = '<p class="actions"><button class="btn" type="button" data-saxo="close">Close</button></p>';
  if (r.busy) { el.innerHTML = '<p>Reading your Saxo positions…</p>'; return; }
  if (r.error) {
    const how = r.setup ? `<ol>
      <li>In SaxoTraderGO, allow OpenAPI access for your account.</li>
      <li>On developer.saxo, create a live application that uses PKCE, with read access, and add these redirect addresses: <code>https://whyjaysee.github.io/asset-tracker/</code> and <code>http://localhost:5500/</code>.</li>
      <li>Put its app key in <code>js/config.js</code> as <code>saxoAppKey</code>.</li></ol>` : '';
    el.innerHTML = `<h2>Saxo not synced</h2><p class="err">${esc(r.error)}</p>${how}${close}`;
    return;
  }
  const unmatched = r.rows.filter((x) => !x.item);
  const table = r.rows.length
    ? `<div class="scroll"><table><tr><th class="desc">Position</th><th>Units</th><th>Price</th><th>Value</th><th class="desc">Into</th></tr>${r.rows.map((x) => `<tr>
        <td class="desc">${esc(x.ticker)} <span class="muted">${esc(x.name)}</span></td><td>${plain(x.units)}</td><td>${esc(x.currency)} ${plain(x.price, 4)}</td>
        <td>${esc(x.currency)} ${nf2.format(x.value)}</td><td class="desc">${x.item ? esc(holdingName(x.item)) : r.total ? esc(r.total.name) + ' (total)' : '<span class="muted">not in the tracker</span>'}</td></tr>`).join('')}</table></div>`
    : '<p>No open positions.</p>';
  const setupLink = unmatched.length && Array.isArray(api.data.movements) && !api.data.movements.length
    ? '<button class="btn" type="button" data-saxo="setup">Use these in Your holdings today</button> ' : '';
  el.innerHTML = `<h2>Saxo, ${clock(r.at)}</h2>
    <p>Filled ${monthLong(draft.month)}${exists ? ', which was already saved; saving replaces it' : ''}. Check the highlighted fields, then save. Nothing is saved until you do.</p>
    ${r.cashItem ? `<p>Cash ${esc(r.cashCurrency)} ${nf2.format(r.cash)}, into ${esc(r.cashItem.name)}.</p>` : ''}
    ${r.notes.map((n) => `<p class="err">${esc(n)}</p>`).join('')}
    ${table}
    ${unmatched.length && !r.total ? `<p>${unmatched.length === 1 ? 'One position isn\'t' : unmatched.length + ' positions aren\'t'} in the tracker yet. Add ${unmatched.length === 1 ? 'it' : 'them'} on the Activity tab.</p>` : ''}
    <p class="actions">${setupLink}<button class="btn" type="button" data-saxo="close">Close</button></p>`;
}

// Puts Saxo's positions into the one-time holdings set-up on the Activity tab.
function saxoToSetup() {
  if (!setupRows) setupRows = setupStart(api.data);
  setupRows = setupRows.filter((r) => !(/saxo/i.test(r.account) && !r.asset.trim() && !String(r.units).trim()));
  for (const x of saxo.rows.filter((r) => !r.item)) {
    const cost = x.cost != null && x.currency === 'USD' ? String(x.cost) : '';
    const row = setupRows.find((r) => setupKey(r.account, r.asset) === setupKey('Saxo', x.ticker));
    if (row) Object.assign(row, { units: String(x.units), cost: row.cost || cost });
    else setupRows.push({ account: 'Saxo', asset: x.ticker, cat: 'stocks', units: String(x.units), cost });
  }
  $('setup-date').value = isoDay(saxo.at);
  showTab('activity');
  renderActivity(api.data);
}

$('saxo-btn').onclick = startSaxo;
$('saxo').addEventListener('click', (ev) => {
  const a = ev.target.dataset.saxo;
  if (a === 'close') $('saxo').hidden = true;
  if (a === 'setup') saxoToSetup();
});

// ---------- accounts and holdings ----------
function renderItems() {
  const cat = Object.fromEntries(CATS.map((c) => [c.id, c.name]));
  $('items').innerHTML = '<tr><th>Name</th><th>Where you check it</th><th>Group</th><th>Entered as</th><th>Changes monthly</th><th>In the form</th></tr>' + data.items.map((i) =>
    `<tr><td><span class="dot" style="--c:var(--${i.category})"></span>${esc(i.name)}</td>
     <td><input class="src" data-source="${i.id}" value="${esc(i.source)}" placeholder="e.g. Kraken" aria-label="Where you check ${esc(i.name)}"></td><td>${cat[i.category]}</td>
     <td>${i.kind === 'holding' ? 'Units × price' : 'Amount'} in ${i.currency}</td>
     <td><input type="checkbox" data-monthly="${i.id}" ${i.monthly ? 'checked' : ''} aria-label="${esc(i.name)} changes monthly"></td>
     <td><input type="checkbox" data-item="${i.id}" ${i.active ? 'checked' : ''} aria-label="Show ${esc(i.name)} in the form"></td></tr>`).join('');
}
$('items').addEventListener('change', async (ev) => {
  const t = ev.target.dataset, on = ev.target.checked ? 1 : 0;
  if (!t.item && !t.source && !t.monthly) return;
  try { data = await api.saveItem(t.item ? { id: t.item, active: on } : t.monthly ? { id: t.monthly, monthly: on } : { id: t.source, source: ev.target.value.trim() }); } catch (e) { toast(saveError(e), true); }
  renderItems(); renderForm(); renderSummary();
});
$('additem').onclick = async () => {
  try {
    data = await api.saveItem({ name: $('newname').value, source: $('newsrc').value, category: $('newcat').value, kind: $('newkind').value, currency: $('newcur').value });
    $('newname').value = ''; $('newsrc').value = '';
    toast('Added');
    renderItems(); renderForm(); renderSummary();
  } catch (e) { toast(saveError(e), true); }
};

const saveError = (e) => (unsure(e) ? 'Could not confirm that. Reload and check before trying again.' : explain(e));
function showUpdate(d) {
  data = d;
  if (draft && dirty) { applyTracked(); renderForm(); renderSummary(); renderItems(); return; }
  const last = d.months.length ? d.months[d.months.length - 1].month : null;
  const now = new Date(), thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  startDraft(draft ? draft.month : last ? nextMonth(last) : thisMonth);
  renderItems();
}

// ---------- activity: buys, sells, transfers, vests and rewards ----------
const MOVE_NAMES = { opening: 'Opening balance', buy: 'Bought', sell: 'Sold', transfer_in: 'Moved in', transfer_out: 'Moved out', vest: 'Vested', reward: 'Reward', fee: 'Fee' };
const MOVE_FORM = {
  buy: { amount: 'Total paid', fee: true, need: true, help: 'Units bought and the total paid for them, not counting the fee.' },
  sell: { amount: 'Total received', fee: true, need: true, help: 'Units sold and the total received for them, before the fee.' },
  transfer: { help: 'Units that left the first account. If some were lost to a network fee, add that separately as a fee.' },
  vest: { amount: 'Value when vested', help: 'Units you received, after any shares withheld for tax.' },
  reward: { amount: 'Value when received', help: 'Staking rewards, airdrops or reinvested dividends. The value is optional.' },
  fee: { help: 'Units taken as a fee, such as a network fee on a transfer.' },
  opening: { amount: 'Total cost, if known', help: 'Units already held on the day you start tracking this holding.' },
};
const holdingName = (it) => (it.source ? `${it.name} · ${it.source}` : it.name);
const heldNow = (d, id) => unitsAt(d, id, '9999-12-31');

// The first movement after which a holding would hold less than zero, if any.
// Same-day additions count before same-day removals.
function goesNegative(moves) {
  const run = {};
  for (const v of [...moves].sort((a, b) => a.date.localeCompare(b.date) || b.units - a.units)) {
    run[v.item_id] = (run[v.item_id] || 0) + Number(v.units);
    if (run[v.item_id] < -1e-9) return v;
  }
  return null;
}
const belowZero = (d, v) => `That would leave ${holdingName(d.items.find((i) => i.id === v.item_id) || { name: v.item_id })} below zero on ${v.date}.`;

function syncActForm() {
  const d = api.data, t = $('act-type').value, f = MOVE_FORM[t];
  const it = d.items.find((i) => i.id === $('act-item').value);
  $('act-itemlabel').textContent = t === 'transfer' ? 'Moved from' : 'Holding';
  $('act-torow').hidden = t !== 'transfer';
  $('act-amountrow').hidden = !f.amount;
  $('act-amountlabel').textContent = f.amount || '';
  $('act-feerow').hidden = !f.fee;
  $('act-cur').textContent = $('act-feecur').textContent = it ? sym(it.currency) : '';
  $('act-help').textContent = f.help;
  const held = it ? heldNow(d, it.id) : null;
  $('act-held').textContent = held == null ? '' : `${plain(held)} held now`;
  const units = parse($('act-units').value), amount = parse($('act-amount').value);
  $('act-each').textContent = f.amount && units > 0 && amount != null && it ? `${sym(it.currency)}${plain(amount / units, 2)} each` : '';
}

function renderActivity(d) {
  const all = d.items.filter((i) => i.kind === 'holding' && (i.active || heldNow(d, i.id)));
  for (const id of ['act-item', 'act-to']) {
    const el = $(id), was = el.value;
    el.innerHTML = all.map((i) => `<option value="${esc(i.id)}">${esc(holdingName(i))}</option>`).join('');
    if (all.some((i) => i.id === was)) el.value = was;
  }

  const started = (d.movements || []).length > 0;
  $('act-setup').hidden = started;
  $('act-main').hidden = !started;
  if (!started) renderSetup(d);

  const byId = Object.fromEntries(d.items.map((i) => [i.id, i]));
  const held = d.items.map((i) => ({ it: i, u: heldNow(d, i.id) })).filter((x) => x.u != null);
  $('act-positions').innerHTML = held.length
    ? held.map((x) => `<div><dt><span class="dot" style="--c:var(--${x.it.category})"></span> ${esc(holdingName(x.it))}</dt><dd>${plain(x.u)}</dd></div>`).join('')
    : '<div><dt>Nothing tracked yet.</dt><dd></dd></div>';

  const moves = d.movements || [];
  const pair = (v, type) => moves.find((w) => w.transfer_id === v.transfer_id && w.type === type);
  const rowsHtml = [...moves].reverse().filter((v) => !(v.type === 'transfer_in' && pair(v, 'transfer_out'))).map((v) => {
    const it = byId[v.item_id] || { name: v.item_id, currency: 'USD', category: 'stocks' };
    const to = v.type === 'transfer_out' && pair(v, 'transfer_in');
    const what = to ? 'Moved' : MOVE_NAMES[v.type];
    const where = to ? `${esc(holdingName(it))} → ${esc(holdingName(byId[to.item_id] || { name: to.item_id }))}` : esc(holdingName(it));
    const units = to ? plain(Math.abs(v.units)) : (v.units > 0 ? '+' : '−') + plain(Math.abs(v.units));
    const amount = v.amount == null ? '' : sym(it.currency) + plain(v.amount, 2) + (v.fee ? ` <span class="muted">+ ${plain(v.fee, 2)} fee</span>` : '');
    return `<tr><td>${esc(v.date)}</td><td>${what}</td><td><span class="dot" style="--c:var(--${it.category})"></span>${where}</td>
      <td>${units}</td><td>${amount}</td><td class="note">${esc(v.note)}</td><td>${hasRefs(d) ? `<button type="button" data-edit="${v.id}">Edit</button> ` : ''}<button type="button" data-del="${v.id}">Delete</button></td></tr>`;
  });
  $('act-none').hidden = moves.length > 0;
  $('act-list').innerHTML = moves.length ? '<tr><th>Date</th><th>What</th><th>Holding</th><th>Units</th><th>Amount</th><th>Note</th><th></th></tr>' + rowsHtml.join('') : '';
  syncActForm();
}

// One-time set-up: every holding held now, entered at once, each saved with an opening balance.
let setupRows = null, setupOff = null;
const setupKey = (account, asset) => `${account.trim().toLowerCase()}|${asset.trim().toLowerCase()}`;
// Starts with a row per account that holds investments, splitting labels such as "Kraken and Ledger".
function setupStart(d) {
  const rows = [], seen = new Set();
  for (const it of d.items.filter((i) => i.active && i.category !== 'cash')) {
    const accounts = (it.source || '').split(/\s+and\s+|\s*[,&]\s*/).map((s) => s.trim()).filter(Boolean);
    for (const account of accounts) {
      const asset = it.kind === 'holding' ? it.name : '';
      if (seen.has(setupKey(account, asset))) continue;
      seen.add(setupKey(account, asset));
      rows.push({ account, asset, cat: it.category, units: '', cost: '' });
    }
  }
  const order = [...new Set(rows.map((r) => r.account))];
  rows.sort((a, b) => order.indexOf(a.account) - order.indexOf(b.account));
  return rows.length ? rows : [{ account: '', asset: '', cat: 'stocks', units: '', cost: '' }];
}

function renderSetup(d) {
  if (!setupRows) {
    setupRows = setupStart(d);
    $('setup-date').value = isoDay(new Date());
  }
  const listed = new Set(setupRows.map((r) => setupKey(r.account, r.asset)));
  const replaceable = d.items.filter((i) => i.active && i.category !== 'cash');
  if (!setupOff) setupOff = new Set(replaceable.filter((i) => !/cash/i.test(i.name) && !listed.has(setupKey(i.source || '', i.name))).map((i) => i.id));
  const accounts = [...new Set(setupRows.map((r) => r.account).concat(d.items.filter((i) => i.category !== 'cash').map((i) => i.source)).filter(Boolean))];
  $('setup-accounts').innerHTML = accounts.map((a) => `<option value="${esc(a)}">`).join('');
  const cats = CATS.filter((c) => c.id !== 'cash');
  $('setup-rows').innerHTML = '<tr><th>Account</th><th>Asset</th><th>Group</th><th>Units</th><th>Total cost, US$ (optional)</th><th></th></tr>' + setupRows.map((r, i) => `<tr data-i="${i}">
    <td><input data-k="account" list="setup-accounts" value="${esc(r.account)}" placeholder="e.g. Saxo" aria-label="Account"></td>
    <td><input data-k="asset" value="${esc(r.asset)}" placeholder="${r.cat === 'crypto' ? 'e.g. SOL' : 'e.g. VWRA'}" aria-label="Asset"></td>
    <td><select data-k="cat" aria-label="Group">${cats.map((c) => `<option value="${c.id}" ${r.cat === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select></td>
    <td><input class="num" data-k="units" inputmode="decimal" value="${esc(r.units)}" aria-label="Units"></td>
    <td><input class="num" data-k="cost" inputmode="decimal" value="${esc(r.cost)}" aria-label="Total cost in US dollars"></td>
    <td><button type="button" data-remove="${i}" aria-label="Remove this row">×</button></td></tr>`).join('');
  $('setup-off').innerHTML = replaceable.length
    ? replaceable.map((i) => `<label><input type="checkbox" data-off="${esc(i.id)}" ${setupOff.has(i.id) ? 'checked' : ''}><span class="dot" style="--c:var(--${i.category})"></span>${esc(holdingName(i))}</label>`).join('')
    : '<p class="hint">Nothing to switch off.</p>';
  checkSetup();
}

const setupFilled = () => setupRows.filter((r) => String(r.units).trim() !== '');
function checkSetup() {
  const d = api.data, date = $('setup-date').value, last = d.months.at(-1), filled = setupFilled();
  const keys = filled.map((r) => setupKey(r.account, r.asset)), twice = filled.find((r, i) => keys.indexOf(keys[i]) !== i);
  let warn = '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) warn = 'Enter the date these holdings are for.';
  else if (filled.some((r) => !(parse(r.units) > 0))) warn = 'Units must be numbers above zero.';
  else if (filled.some((r) => String(r.cost).trim() !== '' && !(parse(r.cost) >= 0))) warn = 'Total cost must be a number, or left empty.';
  else if (filled.some((r) => !r.account.trim() || !r.asset.trim())) warn = 'Each row with units needs an account and an asset.';
  else if (twice) warn = `${twice.asset.trim()} at ${twice.account.trim()} is listed twice. Put its units in one row.`;
  else if (last && setupOff.size && nextMonth(last.month) < date.slice(0, 7)) warn = `Save ${monthLong(nextMonth(last.month))} on the Update tab first. Once the totals are switched off, that month would have neither them nor these holdings.`;
  $('setup-warn').textContent = warn;
  $('setup-warn').hidden = !warn;
  $('setup-save').disabled = !!warn || !filled.length || !api.online;
  $('setup-save').textContent = filled.length ? `Save ${filled.length} ${filled.length === 1 ? 'holding' : 'holdings'}` : 'Save holdings';
}

async function saveSetup() {
  checkSetup();
  if ($('setup-save').disabled) return;
  const holdings = setupFilled().map((r) => {
    const h = { name: r.asset.trim(), source: r.account.trim(), category: r.cat, currency: 'USD', units: parse(r.units) };
    if (parse(r.cost) != null) h.amount = parse(r.cost);
    return h;
  });
  $('setup-save').disabled = true;
  try {
    await api.setupHoldings({ date: $('setup-date').value, holdings, switch_off: [...setupOff] });
    toast(`Saved ${holdings.length} ${holdings.length === 1 ? 'holding' : 'holdings'}`);
    setupRows = setupOff = null;
    renderActivity(api.data);
  } catch (e) { toast(saveError(e), true); checkSetup(); }
}

let activityWired = false;
function showActivity(d) {
  renderOwed(d);
  const on = Array.isArray(d.movements);
  $('act-off').hidden = on;
  $('act-body').hidden = !on;
  if (!on) return;
  if (!activityWired) {
    activityWired = true;
    $('act-date').value = isoDay(new Date());
    for (const id of ['act-type', 'act-item']) $(id).onchange = syncActForm;
    $('act-form').addEventListener('input', syncActForm);
    $('act-form').addEventListener('submit', addMovement);
    $('setup-rows').addEventListener('input', (ev) => {
      const tr = ev.target.closest('tr[data-i]');
      if (!tr || !ev.target.dataset.k) return;
      setupRows[+tr.dataset.i][ev.target.dataset.k] = ev.target.value;
      checkSetup();
    });
    $('setup-rows').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-remove]');
      if (!b) return;
      setupRows.splice(+b.dataset.remove, 1);
      renderSetup(api.data);
    });
    $('setup-addrow').onclick = () => {
      setupRows.push({ account: '', asset: '', cat: 'stocks', units: '', cost: '' });
      renderSetup(api.data);
      $('setup-rows').querySelector(`tr[data-i="${setupRows.length - 1}"] [data-k="account"]`).focus();
    };
    $('setup-off').addEventListener('change', (ev) => {
      const id = ev.target.dataset.off;
      if (!id) return;
      if (ev.target.checked) setupOff.add(id); else setupOff.delete(id);
      checkSetup();
    });
    $('setup-date').addEventListener('input', checkSetup);
    $('setup-save').onclick = saveSetup;
    $('act-list').addEventListener('click', deleteMovement);
    $('act-list').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-edit]'); if (b) startEdit(+b.dataset.edit); });
    $('act-cancel').onclick = endEdit;
  }
  renderActivity(d);
}

// Changing a movement reuses the add form with its kind and holding fixed (supabase/006_reconcile.sql).
let editing = null;
function startEdit(id) {
  const d = api.data, v = d.movements.find((x) => x.id === id);
  if (!v) return;
  const pair = v.transfer_id && d.movements.find((x) => x.transfer_id === v.transfer_id && x.id !== v.id);
  const out = v.type === 'transfer_in' && pair ? pair : v, into = v.transfer_id ? (v.type === 'transfer_in' ? v : pair) : null;
  editing = out;
  $('act-type').value = out.transfer_id ? 'transfer' : out.type;
  $('act-item').value = out.item_id;
  if (into) $('act-to').value = into.item_id;
  $('act-date').value = out.date;
  $('act-units').value = plain(Math.abs(Number(out.units)), 10);
  $('act-amount').value = out.amount == null ? '' : plain(Number(out.amount), 10);
  $('act-fee').value = Number(out.fee) ? plain(Number(out.fee), 10) : '';
  $('act-note').value = out.note || '';
  for (const id of ['act-type', 'act-item', 'act-to']) $(id).disabled = true;
  $('act-legend').textContent = 'Change a movement';
  $('act-add').textContent = 'Save changes';
  $('act-cancel').hidden = false;
  syncActForm();
  $('act-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function endEdit() {
  editing = null;
  for (const id of ['act-type', 'act-item', 'act-to']) $(id).disabled = false;
  for (const id of ['act-units', 'act-amount', 'act-fee', 'act-note']) $(id).value = '';
  $('act-legend').textContent = 'Add a movement';
  $('act-add').textContent = 'Add';
  $('act-cancel').hidden = true;
  syncActForm();
}

async function saveEdit() {
  const t = $('act-type').value, f = MOVE_FORM[t], date = $('act-date').value, units = parse($('act-units').value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Enter the date it happened.', true);
  if (!(units > 0)) return toast('Enter the number of units, more than zero.', true);
  const u = { id: editing.id, date, units, note: $('act-note').value.trim() };
  if (f.amount) u.amount = $('act-amount').value.trim() === '' ? '' : parse($('act-amount').value);
  if (f.fee) u.fee = parse($('act-fee').value) || 0;
  $('act-add').disabled = true;
  try {
    await api.applyMovements({ update: [u] });
    toast('Saved');
    endEdit();
    renderActivity(api.data);
  } catch (e) { toast(saveError(e), true); }
  $('act-add').disabled = false;
}

async function addMovement(ev) {
  ev.preventDefault();
  if (editing) return saveEdit();
  const d = api.data, t = $('act-type').value, f = MOVE_FORM[t], item = $('act-item').value, date = $('act-date').value;
  const units = parse($('act-units').value), amount = f.amount ? parse($('act-amount').value) : null, fee = f.fee ? parse($('act-fee').value) : null;
  if (!item) return toast('Add a holding first, under Update, Accounts and holdings.', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Enter the date it happened.', true);
  if (!(units > 0)) return toast('Enter the number of units, more than zero.', true);
  if (t === 'transfer' && $('act-to').value === item) return toast('Pick a different holding to move it to.', true);
  if (f.need && amount == null) return toast(`Enter the ${f.amount.toLowerCase()}.`, true);
  if (['sell', 'transfer', 'fee'].includes(t)) {
    const had = unitsAt(d, item, date) || 0;
    if (units > had + 1e-9) return toast(`Only ${plain(had)} were held on ${date}. Check the units and the date.`, true);
    const later = goesNegative([...(d.movements || []), { item_id: item, date, units: -units }]);
    if (later) return toast(`${belowZero(d, later)} Check the units and the date.`, true);
  }
  const m = { date, type: t, item_id: item, units, note: $('act-note').value.trim() };
  if (t === 'transfer') m.to_item_id = $('act-to').value;
  if (amount != null) m.amount = amount;
  if (fee) m.fee = fee;
  $('act-add').disabled = true;
  try {
    await api.saveMovements([m]);
    for (const id of ['act-units', 'act-amount', 'act-fee', 'act-note']) $(id).value = '';
    toast('Added');
    renderActivity(api.data);
  } catch (e) { toast(saveError(e), true); }
  $('act-add').disabled = false;
}

async function deleteMovement(ev) {
  const b = ev.target.closest('button[data-del]');
  if (!b) return;
  const id = +b.dataset.del, moves = api.data.movements || [], v = moves.find((x) => x.id === id);
  const left = goesNegative(moves.filter((x) => x.id !== id && !(v && v.transfer_id && x.transfer_id === v.transfer_id)));
  if (left) return toast(`${belowZero(api.data, left)} Delete the later movement first.`, true);
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
  try {
    await api.deleteMovement(id);
    toast('Deleted');
    renderActivity(api.data);
  } catch (e) { toast(saveError(e), true); }
}

// ---------- Kraken ledger import ----------
// Reads a Kraken ledger export in the browser (the CSV, or the PDF statement whose amounts are
// rounded to 4 decimal places) and proposes the movements that bring the Kraken holdings in line
// with it. Nothing is saved until confirmed; refs (kraken:…) stop entries being added twice.
const KRAKEN_CODES = { XBT: 'BTC', XXBT: 'BTC', XETH: 'ETH', ETH2: 'ETH', ZUSD: 'USD', XXDG: 'DOGE', XDG: 'DOGE' };
const krakenCoin = (code) => { const c = String(code).trim().toUpperCase().replace(/\.(F|S|M|B|P)$/, ''); return KRAKEN_CODES[c] || c; };
const r10 = (v) => Math.round(v * 1e10) / 1e10;
const hasRefs = (d) => (d.movements || []).some((v) => 'ref' in v);

function csvRows(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c !== '"') f += c; else if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0]);
}

function readKrakenCsv(text) {
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
  if (!['refid', 'time', 'type', 'asset', 'amount', 'fee', 'balance'].every((k) => head.includes(k))) {
    return { error: "This doesn't look like a Kraken ledger export: it needs the columns refid, time, type, asset, amount, fee and balance. In Kraken, export Ledgers as CSV." };
  }
  const col = (r, k) => (head.includes(k) ? (r[head.indexOf(k)] ?? '').trim() : '');
  const num = (s) => (s === '' ? null : Number(s));
  const entries = rows.slice(1).map((r) => ({
    id: col(r, 'txid'), group: col(r, 'refid'), date: col(r, 'time').slice(0, 10), time: col(r, 'time'),
    type: col(r, 'type').toLowerCase(), subtype: col(r, 'subtype').toLowerCase(), code: col(r, 'asset'), coin: krakenCoin(col(r, 'asset')),
    wallet: col(r, 'wallet').toLowerCase(), amount: num(col(r, 'amount')), fee: num(col(r, 'fee')) || 0, balance: num(col(r, 'balance')),
    usd: num(col(r, 'amountusd')), feeUsd: num(col(r, 'feeusd')),
  }));
  if (!entries.length) return { error: 'This ledger has no entries.' };
  if (entries.some((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !isFinite(e.amount) || !isFinite(e.balance))) return { error: 'Some rows of this ledger could not be read. Export it from Kraken again as CSV.' };
  return { entries, precise: true, source: 'Kraken' };
}

// Binance's transaction history (Time, Account, Operation, Coin, Change) has no running balance, so
// balances are added up from the first row; the export must start at the account's first
// transaction. Rows at the same second are one trade. The User ID column is never read.
function readBinanceCsv(text) {
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const at = (k) => head.indexOf(k);
  if (['time', 'operation', 'coin', 'change'].some((k) => at(k) < 0)) return { error: "This doesn't look like a Binance transaction history export." };
  const run = {};
  const entries = rows.slice(1).map((r) => {
    const op = r[at('operation')].trim(), coin = r[at('coin')].trim().toUpperCase(), amount = Number(r[at('change')]), time = r[at('time')].trim();
    const wallet = (at('account') >= 0 ? r[at('account')] : 'spot').trim().toLowerCase();
    const type = /^transaction|convert|small assets/i.test(op) ? 'trade' : /^deposit/i.test(op) ? 'deposit' : /^withdraw/i.test(op) ? 'withdrawal'
      : /interest|reward|airdrop|distribution|cashback|bonus|staking/i.test(op) ? 'earn' : op.toLowerCase();
    return { id: '', group: time, date: time.slice(0, 10), time, type, subtype: type === 'earn' ? 'reward' : op.toLowerCase(), code: coin, coin, wallet, amount, text: r[at('change')].trim(), fee: 0, usd: null, feeUsd: null };
  }).sort((a, b) => a.time.localeCompare(b.time) || b.amount - a.amount);
  if (!entries.length) return { error: 'This history has no entries.' };
  if (entries.some((e) => !/^\d{4}-\d{2}-\d{2}/.test(e.date) || !isFinite(e.amount))) return { error: 'Some rows of this history could not be read. Export it from Binance again.' };
  // Added up exactly, in units of 10^-12, so large counts such as BONK don't pick up rounding errors.
  const exact = (n) => { const [w, f = ''] = String(n).replace('-', '').split('.'); const v = BigInt(w + f.padEnd(12, '0').slice(0, 12)); return String(n).startsWith('-') ? -v : v; };
  const decimal = (v) => { const s = (v < 0n ? -v : v).toString().padStart(13, '0'); return Number(`${v < 0n ? '-' : ''}${s.slice(0, -12)}.${s.slice(-12)}`); };
  for (const e of entries) {
    const k = e.code + '|' + e.wallet;
    run[k] = (run[k] || 0n) + exact(e.text);
    e.balance = decimal(run[k]);
    if (run[k] < -10000n) return { error: `This history doesn't start at your first Binance transaction (${e.coin} would go below zero on ${e.date}). Export every year, from when the account was opened.` };
  }
  return { entries, precise: true, source: 'Binance' };
}

function readKrakenPdf(lines) {
  if (!lines.some((l) => /Kraken/i.test(l.text))) return { error: "This doesn't look like a Kraken ledger statement." };
  const head = /^(\d{4}-\d{2}-\d{2}) ([A-Za-z]+)(?: ([A-Za-z ]+))?$/;
  const body = /^(L[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}) ([A-Z0-9.]+) (.+?) (-?[\d,]+(?:\.\d+)?) (-?[\d,]+(?:\.\d+)?) (-?[\d,]+(?:\.\d+)?)$/;
  const num = (s) => Number(s.replace(/,/g, ''));
  const out = [];
  let cur = null, m;
  for (const l of lines) {
    if ((m = head.exec(l.text))) { cur = { date: m[1], time: '', type: m[2].toLowerCase(), subtype: (m[3] || '').toLowerCase() }; out.push(cur); }
    else if (cur && !cur.code && (m = body.exec(l.text))) Object.assign(cur, { id: m[1], code: m[2], coin: krakenCoin(m[2]), wallet: m[3].toLowerCase(), amount: num(m[4]), fee: num(m[5]), balance: num(m[6]) });
    else if (cur && /^\d{2}:\d{2}:\d{2}/.test(l.text)) { cur.time = `${cur.date} ${l.text.slice(0, 8)}`; if (!cur.subtype) cur.subtype = l.text.slice(8).trim().toLowerCase(); }
  }
  if (!out.length || out.some((e) => !e.code)) return { error: 'Some entries in this PDF could not be read. Export the ledger from Kraken as CSV instead.' };
  return { entries: out.map((e) => ({ ...e, group: `${e.time} ${e.type}`, usd: null, feeUsd: null })), precise: false, source: 'Kraken' };
}

// Kraken's balance of each coin at the end of a day: the last resulting balance of every asset and
// wallet, added up by coin. Before an asset's first entry, it's that entry's balance less its change.
function krakenTotals(entries, day) {
  const last = {};
  for (const e of entries) {
    const k = e.code + '|' + e.wallet;
    if (e.date <= day) last[k] = { coin: e.coin, v: e.balance };
    else if (!(k in last)) last[k] = { coin: e.coin, v: e.balance - (e.amount - e.fee) };
  }
  const out = {};
  for (const { coin, v } of Object.values(last)) out[coin] = r10((out[coin] || 0) + v);
  return out;
}

// The changes that bring each Kraken holding (with movements) in line with the ledger after the
// holding's start: the opening corrected, staking rewards one per month, trades, deposits and
// withdrawals (the other account is chosen), and anything else as a reward or fee.
function krakenPlan(d, k) {
  const first = k.entries[0].date, last = k.entries.at(-1).date, src = k.source, pre = src.toLowerCase();
  const moves = d.movements || [];
  const byRef = Object.fromEntries(moves.filter((v) => v.ref).map((v) => [v.ref, v]));
  const holdings = d.items.filter((i) => i.kind === 'holding' && i.source && i.source.toLowerCase().includes(pre) && moves.some((v) => v.item_id === i.id));
  const coins = new Set(k.entries.map((e) => e.coin));
  // The PDF rounds to 4 decimal places, so smaller differences are rounding, not changes.
  const tol = k.precise ? 1e-9 : 5e-4;
  const changes = [], rows = [], notes = [];
  for (const h of holdings) {
    const coin = String(h.name).toUpperCase(), mine = moves.filter((v) => v.item_id === h.id);
    const opening = mine.find((v) => v.type === 'opening'), start = (opening || mine[0]).date;
    const row = { h, coin, start, none: !coins.has(coin) };
    rows.push(row);
    if (row.none) continue;
    row.ledgerStart = krakenTotals(k.entries, start)[coin] || 0;
    row.trackerStart = unitsAt(d, h.id, start) || 0;
    const diff = r10(row.ledgerStart - row.trackerStart);
    if (opening && Math.abs(diff) > tol && first <= start) {
      changes.push({ h, coin, date: start, delta: diff, on: true, label: `Opening on ${dayMonth(start)}: ${src} had ${plain(row.ledgerStart, 8)}, the tracker has ${plain(row.trackerStart, 8)}`, update: { id: opening.id, units: r10(Number(opening.units) + diff) } });
    } else if (Math.abs(diff) > tol) notes.push(`${coin}: ${src} had ${plain(row.ledgerStart, 8)} on ${dayMonth(start)} but the tracker has ${plain(row.trackerStart, 8)}. This file starts after then, so the opening wasn't changed.`);

    const groups = new Map();
    for (const e of k.entries) if (e.coin === coin && e.date > start) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group).push(e); }
    const rewards = {};
    for (const [g, es] of groups) {
      const net = r10(es.reduce((t, e) => t + e.amount - e.fee, 0));
      if (Math.abs(net) < 1e-12) continue;
      const date = es.at(-1).date, type = es[0].type, sub = es[0].subtype;
      const usd = es.every((e) => e.usd != null) ? es.reduce((t, e) => t + e.usd - (e.feeUsd || 0), 0) : null;
      const ref = `${pre}:${g}:${coin}`;
      if ((type === 'earn' && sub === 'reward') || type === 'staking') {
        const m = date.slice(0, 7), r = rewards[m] || (rewards[m] = { units: 0, usd: 0, priced: true, date });
        r.units = r10(r.units + net); r.date = date;
        if (usd == null) r.priced = false; else r.usd += usd;
      } else if (['trade', 'spend', 'receive', 'instant'].includes(type)) {
        if (byRef[ref]) continue;
        const cash = k.entries.find((e) => e.group === g && e.coin !== coin && ['USD', 'USDT', 'USDC'].includes(e.coin));
        const amount = cash ? Math.abs(cash.amount) : usd != null ? Math.abs(usd) : null, fee = cash ? cash.fee : 0;
        const t = net > 0 ? 'buy' : 'sell';
        changes.push({ h, coin, date, delta: net, on: true, label: `${t === 'buy' ? 'Bought' : 'Sold'} ${plain(Math.abs(net), 8)} ${coin}${amount != null ? ` for US$${nf2.format(amount)}` : ''}, ${dayMonth(date)}`,
          add: { date, type: t, item_id: h.id, units: Math.abs(net), amount, fee, note: `${src} ${t === 'buy' ? 'buy' : 'sale'}`, ref } });
      } else if (['deposit', 'withdrawal', 'transfer'].includes(type)) {
        if (byRef[ref]) continue;
        const others = d.items.filter((i) => i.kind === 'holding' && i.id !== h.id && String(i.name).toUpperCase() === coin);
        changes.push({ h, coin, date, delta: net, on: false, transfer: { ref, others, choice: '' }, label: `${net > 0 ? 'Deposited' : 'Withdrew'} ${plain(Math.abs(net), 8)} ${coin}, ${dayMonth(date)}` });
      } else {
        if (byRef[ref]) continue;
        changes.push({ h, coin, date, delta: net, on: true, label: `${type}${sub ? ' ' + sub : ''}: ${net > 0 ? '+' : '−'}${plain(Math.abs(net), 8)} ${coin}, ${dayMonth(date)}`,
          add: { date, type: net > 0 ? 'reward' : 'fee', item_id: h.id, units: Math.abs(net), amount: net > 0 && usd != null ? Math.abs(usd) : null, note: `${src} ${type}${sub ? ' ' + sub : ''}`, ref } });
      }
    }
    for (const [m, r] of Object.entries(rewards)) {
      const ref = `${pre}:reward:${coin}:${m}`, have = byRef[ref], amount = r.priced ? cents(r.usd) : null;
      const label = `${src === 'Kraken' ? 'Staking' : 'Rewards'}, ${monthLong(m)}: +${plain(r.units, 8)} ${coin}${amount != null ? ` (US$${nf2.format(amount)})` : ''}`;
      if (!have) changes.push({ h, coin, date: r.date, delta: r.units, on: true, label, add: { date: r.date, type: 'reward', item_id: h.id, units: r.units, amount, note: `${src} ${src === 'Kraken' ? 'staking' : 'rewards'}, ${monthLong(m)}`, ref } });
      else if (Math.abs(Number(have.units) - r.units) > Math.max(tol, 1e-10)) changes.push({ h, coin, date: r.date, delta: r10(r.units - Number(have.units)), on: true, label: `${label}, was +${plain(Number(have.units), 8)}`, update: { id: have.id, units: r.units, date: r.date, amount } });
    }
    row.end = last > start ? last : start;
    row.ledgerNow = krakenTotals(k.entries, row.end)[coin] || 0;
    row.trackerNow = unitsAt(d, h.id, row.end) || 0;
  }
  const tracked = new Set(rows.map((r) => r.coin));
  const held = krakenTotals(k.entries, last);
  const extra = Object.entries(held).filter(([c, v]) => v > 1e-8 && !tracked.has(c));
  if (extra.length) notes.push(`${src} also holds ${extra.map(([c, v]) => `${plain(v, 8)} ${c}`).join(', ')}, which ${extra.length === 1 ? "isn't" : "aren't"} a ${src} holding in the tracker.`);
  return { first, last, rows, changes, notes, precise: k.precise, src };
}

// Month-end Kraken balances, with the stored units of ETH and BTC across all accounts beside them.
function krakenHistory(d, k) {
  const coins = [...new Set(k.entries.map((e) => e.coin))], tol = k.precise ? 1e-8 : 5e-4;
  const out = [];
  for (let m = k.entries[0].date.slice(0, 7); m <= k.entries.at(-1).date.slice(0, 7); m = nextMonth(m)) {
    const t = Object.fromEntries(Object.entries(krakenTotals(k.entries, monthEnd(m))).filter(([, v]) => Math.abs(v) > tol));
    const saved = d.months.find((x) => x.month === m), stored = {};
    if (saved) for (const [id, e] of Object.entries(saved.entries)) {
      const it = d.items.find((i) => i.id === id);
      if (it && it.kind === 'holding' && it.category === 'crypto') { const g = coinGroup(it); if (g !== 'Others') stored[g] = (stored[g] || 0) + Number(e[0] || 0); }
    }
    out.push({ month: m, t, stored: saved ? stored : null });
  }
  return { coins: coins.filter((c) => out.some((r) => r.t[c])), rows: out };
}

let kraken = null;
async function importKraken(file) {
  showKraken({ busy: true });
  let k;
  try {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') k = readKrakenPdf(await pdfLines(new Uint8Array(await file.arrayBuffer())));
    else { const text = await file.text(), top = text.slice(0, 300).toLowerCase(); k = top.includes('operation') && top.includes('change') ? readBinanceCsv(text) : readKrakenCsv(text); }
  } catch (e) { k = { error: `Could not read that file (${e && e.message ? e.message : e}).` }; }
  if (k.error) return showKraken(k);
  k.entries.sort((a, b) => (a.time || a.date).localeCompare(b.time || b.date));
  kraken = { k, plan: krakenPlan(api.data, k), history: krakenHistory(api.data, k) };
  showKraken(kraken);
}

function showKraken(s) {
  const el = $('kraken');
  el.hidden = false;
  el.classList.toggle('error', !!s.error);
  const close = '<button class="btn" type="button" data-kraken="close">Close</button>';
  if (s.busy) { el.innerHTML = '<p>Reading the ledger in this browser…</p>'; return; }
  if (s.error) { el.innerHTML = `<h2>Ledger not imported</h2><p class="err">${esc(s.error)}</p><p class="actions">${close}</p>`; return; }
  const p = s.plan, on = p.changes.filter((c) => c.on && (!c.transfer || c.transfer.choice));
  const after = (r) => r10(r.trackerNow + on.filter((c) => c.h === r.h).reduce((t, c) => t + c.delta, 0));
  const rowsHtml = p.rows.map((r) => r.none
    ? `<tr><td class="desc">${esc(holdingName(r.h))}</td><td colspan="4" class="muted">No entries for ${esc(r.coin)} in this file; left as it is.</td></tr>`
    : `<tr><td class="desc">${esc(holdingName(r.h))}</td><td>${plain(r.ledgerStart, 8)}</td><td>${plain(r.trackerStart, 8)}</td><td>${plain(r.ledgerNow, 8)}</td>
       <td>${plain(after(r), 8)} ${Math.abs(after(r) - r.ledgerNow) < (p.precise ? 1e-8 : 5e-4) ? '<span class="ok">✓</span>' : '<span class="down">differs</span>'}</td></tr>`).join('');
  const changesHtml = p.changes.length ? `<div class="scroll"><table><tr><th></th><th class="desc">Change</th><th class="desc">Holding</th><th class="desc">Other account</th></tr>${p.changes.map((c, i) => `<tr>
      <td><input type="checkbox" data-kchange="${i}" ${c.on ? 'checked' : ''} aria-label="Include this change"></td><td class="desc">${esc(c.label)}</td><td class="desc">${esc(holdingName(c.h))}</td>
      <td class="desc">${c.transfer ? `<select data-kother="${i}" aria-label="The other account"><option value="">Skip</option>${c.transfer.others.map((o) => `<option value="${esc(o.id)}" ${c.transfer.choice === o.id ? 'selected' : ''}>${c.delta > 0 ? 'from' : 'to'} ${esc(holdingName(o))}</option>`).join('')}</select>` : ''}</td></tr>`).join('')}</table></div>`
    : '<p>The tracker already matches this ledger. Nothing to change.</p>';
  const canSave = hasRefs(api.data);
  const h = s.history;
  const histHtml = h.rows.length > 1 ? `<details><summary>${p.src} month by month</summary>
    <p class="hint">${p.src}'s balance of each coin at the end of each month. For ETH and BTC, "all accounts" is what the tracker stored for that month across every account, so the difference was held elsewhere, such as on Ledger.</p>
    <div class="scroll"><table><tr><th>Month</th>${h.coins.map((c) => `<th>${esc(c)}</th>${['ETH', 'BTC'].includes(c) ? `<th>${esc(c)}, all accounts</th>` : ''}`).join('')}</tr>
    ${[...h.rows].reverse().map((r) => `<tr><td>${monthShort(r.month)}</td>${h.coins.map((c) => `<td>${r.t[c] ? plain(r.t[c], p.precise ? 8 : 4) : ''}</td>${['ETH', 'BTC'].includes(c) ? `<td class="muted">${r.stored && r.stored[c] != null ? plain(r.stored[c], 8) : ''}</td>` : ''}`).join('')}</tr>`).join('')}</table></div></details>` : '';
  el.innerHTML = `<h2>${p.src} ledger, ${dayMonth(p.first)} ${p.first.slice(0, 4)} to ${dayMonth(p.last)} ${p.last.slice(0, 4)}</h2>
    ${p.precise ? '' : '<p class="err">This PDF rounds amounts to 4 decimal places, so small differences can remain. The CSV export is exact.</p>'}
    <div class="scroll"><table><tr><th class="desc">Holding</th><th>${p.src} at start</th><th>Tracker at start</th><th>${p.src} at end</th><th>Tracker after these changes</th></tr>${rowsHtml}</table></div>
    <p class="hint">"Start" is each holding's opening date; "end" is the last day in the file, or the opening date if the file ends before it.</p>
    ${p.notes.map((n) => `<p class="err">${esc(n)}</p>`).join('')}
    <h3>Changes</h3>${changesHtml}
    <p class="actions">${p.changes.length && canSave ? `<button class="btn primary" type="button" data-kraken="save" ${on.length ? '' : 'disabled'}>Save ${on.length} ${on.length === 1 ? 'change' : 'changes'}</button> ` : ''}${close}</p>
    ${p.changes.length && !canSave ? '<p class="err">Run supabase/006_reconcile.sql in the Supabase SQL Editor to save changes from a ledger.</p>' : ''}
    ${histHtml}`;
}

async function saveKraken() {
  const on = kraken.plan.changes.filter((c) => c.on && (!c.transfer || c.transfer.choice));
  const update = on.filter((c) => c.update).map((c) => c.update);
  const add = on.filter((c) => c.add).map((c) => c.add).concat(on.filter((c) => c.transfer).map((c) => {
    const x = c.transfer.choice, out = c.delta < 0;
    return { date: c.date, type: 'transfer', item_id: out ? c.h.id : x, to_item_id: out ? x : c.h.id, units: Math.abs(c.delta), note: `${kraken.plan.src} ${out ? 'withdrawal' : 'deposit'}`, ref: c.transfer.ref };
  }));
  try {
    await api.applyMovements({ update, add });
    toast(`Saved ${on.length} ${on.length === 1 ? 'change' : 'changes'}`);
    kraken.plan = krakenPlan(api.data, kraken.k);
    kraken.history = krakenHistory(api.data, kraken.k);
    renderActivity(api.data);
    showKraken(kraken);
  } catch (e) { toast(saveError(e), true); }
}

$('kraken-btn').onclick = () => $('kraken-file').click();
$('kraken-file').onchange = async (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) await importKraken(f); };
$('kraken').addEventListener('click', (ev) => {
  const a = ev.target.dataset.kraken;
  if (a === 'close') $('kraken').hidden = true;
  if (a === 'save') saveKraken();
});
$('kraken').addEventListener('change', (ev) => {
  const i = ev.target.dataset.kchange ?? ev.target.dataset.kother;
  if (i == null || !kraken) return;
  const c = kraken.plan.changes[+i];
  if (ev.target.dataset.kchange != null) c.on = ev.target.checked;
  else { c.transfer.choice = ev.target.value; c.on = !!ev.target.value; }
  showKraken(kraken);
});

// ---------- money owed back: payments that will be given back, and the repayments ----------
const owedLines = (d) => d.items.filter((i) => i.category === 'cash' && i.kind === 'balance' && (i.active || (d.owed || []).some((o) => o.item_id === i.id)));
const sgd2 = (v) => (v < 0 ? '−' : '') + 'S$' + nf2.format(Math.abs(v));
let owedWired = false;

function renderOwed(d) {
  const on = Array.isArray(d.owed);
  $('owed-sec').hidden = !on;
  if (!on) return;
  if (!owedWired) {
    owedWired = true;
    $('owed-date').value = isoDay(new Date());
    $('owed-form').addEventListener('submit', addOwed);
    $('owed-list').addEventListener('click', deleteOwed);
  }
  const lines = owedLines(d), withRecords = [...new Set(d.owed.map((o) => o.item_id))];
  const name = (id) => (d.items.find((i) => i.id === id) || { name: id }).name;
  const el = $('owed-item'), was = el.value;
  const pick = lines.find((i) => withRecords.includes(i.id)) || lines.find((i) => /repaid/i.test(i.name)) || lines[0];
  el.innerHTML = lines.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
  el.value = lines.some((i) => i.id === was) ? was : pick ? pick.id : '';
  $('owed-now').innerHTML = withRecords.length
    ? withRecords.map((id) => `<div><dt>${esc(name(id))}</dt><dd>${sgd2(owedAt(d, id, '9999-12-31'))}</dd></div>`).join('')
    : '<div><dt>Nothing owed back.</dt><dd></dd></div>';
  const run = {};
  const rowsHtml = d.owed.map((o) => {
    run[o.item_id] = (run[o.item_id] || 0) + Number(o.amount);
    const v = Number(o.amount);
    return `<tr><td>${esc(o.date)}</td><td>${v > 0 ? 'Paid' : 'Given back'}${withRecords.length > 1 ? ` <span class="muted">${esc(name(o.item_id))}</span>` : ''}</td>
      <td>${v > 0 ? '+' : '−'}${sgd2(Math.abs(v))}</td><td>${sgd2(run[o.item_id])}</td>
      <td class="note">${esc(o.note)}${o.created_by === 'dashboard' ? ' <span class="muted">(added outside the site)</span>' : ''}</td>
      <td><button type="button" data-del="${o.id}">Delete</button></td></tr>`;
  }).reverse();
  $('owed-none').hidden = d.owed.length > 0;
  $('owed-list').innerHTML = d.owed.length ? '<tr><th>Date</th><th>What</th><th>Amount</th><th>Still owed after</th><th>Note</th><th></th></tr>' + rowsHtml.join('') : '';
}

async function addOwed(ev) {
  ev.preventDefault();
  const kind = $('owed-kind').value, date = $('owed-date').value, item = $('owed-item').value, amount = parse($('owed-amount').value);
  if (!item) return toast('Add a cash line for it first, under Update, Accounts and holdings, as a single amount in SGD.', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Enter the date it happened.', true);
  if (!(amount > 0)) return toast('Enter the amount, more than zero.', true);
  $('owed-add').disabled = true;
  try {
    await api.saveOwed({ date, kind, amount, item_id: item, note: $('owed-note').value.trim() });
    $('owed-amount').value = $('owed-note').value = '';
    toast('Added');
    renderOwed(api.data);
  } catch (e) { toast(saveError(e), true); }
  $('owed-add').disabled = false;
}

async function deleteOwed(ev) {
  const b = ev.target.closest('button[data-del]');
  if (!b) return;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
  try {
    await api.deleteOwed(+b.dataset.del);
    toast('Deleted');
    renderOwed(api.data);
  } catch (e) { toast(saveError(e), true); renderOwed(api.data); }
}

// ---------- home: house commitments and the mortgage (supabase/007_home.sql) ----------
const CPF_OA_RATE = 0.025; // a year, for the estimate of CPF used plus accrued interest
const addMonths = (iso, k) => {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDay(new Date(y, m - 1 + k, Math.min(d, new Date(y, m + k, 0).getDate())));
};
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const longDate = (iso) => `${+iso.slice(8)} ${MONTH_NAMES[+iso.slice(5, 7) - 1].slice(0, 3)} ${iso.slice(0, 4)}`;
const annuity = (balance, r, n) => (n <= 0 ? balance : r === 0 ? balance / n : (balance * r) / (1 - Math.pow(1 + r, -n)));
const rateOn = (rates, iso) => rates.reduce((cur, x) => (x.from_date <= iso ? x : cur), rates[0]);

// One row per instalment, the first a month after drawdown. Monthly rest: interest is the balance
// times rate/12. The instalment is set by the annuity formula over the remaining months at the
// start and whenever the rate changes. CPF pays up to cpf_monthly of each instalment; cpfAccrued
// estimates what has to go back to CPF: CPF used plus 2.5% a year, compounded monthly.
function amortise(loan) {
  const rates = [...(loan.rates || [])].sort((a, b) => a.from_date.localeCompare(b.from_date));
  const n = Number(loan.tenure_months), cpfMonthly = Number(loan.cpf_monthly) || 0, rows = [];
  let balance = Number(loan.principal), instalment = 0, rate = null, cpfUsed = 0, cpfAccrued = 0;
  for (let i = 1; i <= n && rates.length; i++) {
    const r = Number(rateOn(rates, addMonths(loan.start_date, i - 1)).rate);
    if (r !== rate) { rate = r; instalment = annuity(balance, r / 1200, n - i + 1); }
    const interest = balance * r / 1200, principal = instalment - interest;
    balance -= principal;
    const cpf = Math.min(cpfMonthly, instalment), cash = instalment - cpf;
    cpfUsed += cpf;
    cpfAccrued = cpfAccrued * (1 + CPF_OA_RATE / 12) + cpf;
    const date = addMonths(loan.start_date, i);
    rows.push({ month: date.slice(0, 7), date, rate: r, instalment, interest, principal, balance, cpf, cash, cpfUsed, cpfAccrued });
  }
  return rows;
}

(function checkAmortise() {
  const rows = amortise({ principal: 1000000, start_date: '2026-01-01', tenure_months: 360, cpf_monthly: 0, rates: [{ rate: 3, from_date: '2026-01-01' }] });
  const first = Math.round(rows[0].instalment * 100) / 100, last = rows.at(-1).balance;
  if (rows.length !== 360 || first !== 4216.04 || Math.abs(last) >= 0.01) console.warn(`amortise() self-check failed: instalment ${first} (expected 4216.04), final balance ${last}`);
})();

// The instalment this month, or the first if it hasn't started, or the last if it has ended.
const loanIndex = (rows, today) => { const i = rows.findIndex((r) => r.month >= today.slice(0, 7)); return i < 0 ? rows.length - 1 : i; };

// A warning when the current rate period's lock-in ends within 90 days.
function repricing(loan, today) {
  const rates = [...(loan.rates || [])].sort((a, b) => a.from_date.localeCompare(b.from_date));
  const cur = rates.length && rateOn(rates, today);
  if (!cur || !cur.lock_in_end) return null;
  const days = daysBetween(today, cur.lock_in_end);
  return days >= 0 && days <= 90 ? { days, text: `The lock-in on ${loan.label} ends on ${longDate(cur.lock_in_end)}, ${days === 0 ? 'today' : `in ${days} ${days === 1 ? 'day' : 'days'}`}. Compare repricing offers before then.` } : null;
}

let homeWired = false, payingId = null, loanSel = null, loanRates = [];

function showHome(d) {
  const on = Array.isArray(d.commitments);
  $('home-off').hidden = on;
  $('home-body').hidden = !on;
  if (!on) return;
  if (!homeWired) {
    homeWired = true;
    $('com-date').value = isoDay(new Date());
    $('com-form').addEventListener('submit', addCommitment);
    $('com-list').addEventListener('click', commitmentClick);
    $('loan-form').addEventListener('submit', saveLoan);
    $('loan-addrate').onclick = () => { readRates(); const last = loanRates.at(-1); loanRates.push({ rate: '', from_date: last ? last.from_date : $('loan-start').value, lock_in_end: '' }); renderRates(); };
    $('loan-rates').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-rm]'); if (!b) return; readRates(); loanRates.splice(+b.dataset.rm, 1); renderRates(); });
    $('loan-pick').onchange = (ev) => { loanSel = ev.target.value; fillLoanForm(api.data); renderLoan(api.data); };
    $('loan-delete').onclick = deleteLoan;
  }
  renderCommitments(d);
  if (loanSel == null || (loanSel !== 'new' && !d.loans.some((l) => String(l.id) === loanSel))) loanSel = d.loans.length ? String(d.loans[0].id) : 'new';
  fillLoanForm(d);
  renderLoan(d);
}

function renderCommitments(d) {
  const planned = d.commitments.filter((c) => c.status === 'planned');
  const sum = (from) => planned.filter((c) => c.paid_from === from).reduce((t, c) => t + Number(c.amount), 0);
  $('com-totals').innerHTML = `<div><dt>From cash</dt><dd>${sgd2(sum('cash'))}</dd></div><div><dt>From CPF</dt><dd>${sgd2(sum('cpf'))}</dd></div>`;
  const list = [...d.commitments].sort((a, b) => b.date_due.localeCompare(a.date_due) || b.id - a.id);
  $('com-none').hidden = list.length > 0;
  $('com-list').innerHTML = list.length ? '<tr><th>Due</th><th>What</th><th>Amount</th><th>From</th><th>Status</th><th></th></tr>' + list.map((c) => {
    const paid = c.status === 'paid';
    const status = paid ? `Paid ${longDate(c.paid_on)}${c.owed_id ? ' <span class="muted">· owed back recorded</span>' : ''}` : 'Planned';
    const actions = payingId === c.id
      ? `<input type="date" data-paydate="${c.id}" value="${isoDay(new Date())}" aria-label="Date paid"> <button type="button" data-payok="${c.id}">Confirm</button> <button type="button" data-paycancel="1">Cancel</button>`
      : `${paid ? '' : `<button type="button" data-pay="${c.id}">Mark paid</button> `}<button type="button" data-del="${c.id}">Delete</button>`;
    return `<tr class="${paid ? 'paid' : ''}"><td>${longDate(c.date_due)}</td>
      <td>${esc(c.label)}${c.repayable ? ' <span class="muted">· will be paid back</span>' : ''}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td>
      <td>${sgd2(Number(c.amount))}</td><td>${c.paid_from === 'cpf' ? 'CPF' : 'Cash'}</td><td>${status}</td><td>${actions}</td></tr>`;
  }).join('') : '';
}

async function addCommitment(ev) {
  ev.preventDefault();
  const date = $('com-date').value, label = $('com-label').value.trim(), amount = parse($('com-amount').value), from = $('com-from').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Enter the date it is due.', true);
  if (!label) return toast('Say what the payment is for.', true);
  if (!(amount > 0)) return toast('Enter the amount, more than zero.', true);
  $('com-add').disabled = true;
  try {
    await api.saveCommitment({ date_due: date, label, amount, paid_from: from, repayable: from === 'cash' && $('com-back').checked, note: $('com-note').value.trim() });
    for (const id of ['com-label', 'com-amount', 'com-note']) $(id).value = '';
    $('com-back').checked = false;
    toast('Added');
    renderCommitments(api.data);
  } catch (e) { toast(saveError(e), true); }
  $('com-add').disabled = false;
}

async function commitmentClick(ev) {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.pay) { payingId = +b.dataset.pay; return renderCommitments(api.data); }
  if (b.dataset.paycancel) { payingId = null; return renderCommitments(api.data); }
  if (b.dataset.payok) {
    const day = $('com-list').querySelector(`[data-paydate="${b.dataset.payok}"]`).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return toast('Enter the date it was paid.', true);
    try { await api.payCommitment(+b.dataset.payok, day); payingId = null; toast('Marked paid'); renderCommitments(api.data); }
    catch (e) { toast(saveError(e), true); }
    return;
  }
  if (b.dataset.del) {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
    try { await api.deleteCommitment(+b.dataset.del); toast('Deleted'); } catch (e) { toast(saveError(e), true); }
    renderCommitments(api.data);
  }
}

function fillLoanForm(d) {
  const loan = d.loans.find((l) => String(l.id) === loanSel);
  $('loan-pickrow').hidden = !d.loans.length;
  $('loan-pick').innerHTML = d.loans.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('') + '<option value="new">Add another loan</option>';
  $('loan-pick').value = loanSel;
  const v = (x) => (x == null ? '' : plain(Number(x), 6));
  $('loan-label').value = loan ? loan.label : '';
  $('loan-principal').value = loan ? v(loan.principal) : '';
  $('loan-start').value = loan ? loan.start_date : '';
  $('loan-tenure').value = loan ? loan.tenure_months : '';
  $('loan-cpf').value = loan ? v(loan.cpf_monthly) : '';
  $('loan-base').value = loan ? v(loan.base_rate) : '';
  $('loan-adverse').value = loan ? v(loan.adverse_rate) : '';
  $('loan-note').value = loan ? loan.note : '';
  loanRates = loan ? loan.rates.map((r) => ({ rate: plain(Number(r.rate), 6), from_date: r.from_date, lock_in_end: r.lock_in_end || '' })) : [{ rate: '', from_date: '', lock_in_end: '' }];
  $('loan-delete').hidden = !loan;
  delete $('loan-delete').dataset.armed;
  $('loan-delete').textContent = 'Delete this loan';
  if (!loan) $('loan-edit').open = true;
  renderRates();
}

function renderRates() {
  $('loan-rates').innerHTML = '<tr><th>Rate, % a year</th><th>From</th><th>Lock-in ends (optional)</th><th></th></tr>' + loanRates.map((r, i) => `<tr data-i="${i}">
    <td><input inputmode="decimal" data-k="rate" value="${esc(r.rate)}" aria-label="Rate, % a year"></td>
    <td><input type="date" data-k="from_date" value="${esc(r.from_date)}" aria-label="Rate from"></td>
    <td><input type="date" data-k="lock_in_end" value="${esc(r.lock_in_end)}" aria-label="Lock-in ends"></td>
    <td>${loanRates.length > 1 ? `<button type="button" data-rm="${i}" aria-label="Remove this period">×</button>` : ''}</td></tr>`).join('');
}
const readRates = () => { loanRates = [...$('loan-rates').querySelectorAll('tr[data-i]')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((x) => [x.dataset.k, x.value.trim()]))); };

async function saveLoan(ev) {
  ev.preventDefault();
  readRates();
  const d = {
    label: $('loan-label').value.trim(), principal: parse($('loan-principal').value), start_date: $('loan-start').value,
    tenure_months: parseInt($('loan-tenure').value, 10), cpf_monthly: parse($('loan-cpf').value) || 0,
    base_rate: parse($('loan-base').value), adverse_rate: parse($('loan-adverse').value), note: $('loan-note').value.trim(),
    rates: loanRates.map((r) => ({ rate: parse(r.rate), from_date: r.from_date, lock_in_end: r.lock_in_end || null })),
  };
  if (!d.label) return toast('Give the loan a name.', true);
  if (!(d.principal > 0)) return toast('Enter the loan amount.', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start_date)) return toast('Enter the drawdown date.', true);
  if (!(d.tenure_months > 0)) return toast('Enter the tenure in months.', true);
  if (d.rates.some((r) => r.rate == null || !r.from_date)) return toast('Give every rate period a rate and a start date.', true);
  if (loanSel !== 'new') d.id = +loanSel;
  $('loan-save').disabled = true;
  try {
    const before = new Set(api.data.loans.map((l) => l.id));
    await api.saveLoan(d);
    if (loanSel === 'new') { const added = api.data.loans.find((l) => !before.has(l.id)); if (added) loanSel = String(added.id); }
    toast('Saved');
    fillLoanForm(api.data);
    renderLoan(api.data);
  } catch (e) { toast(saveError(e), true); }
  $('loan-save').disabled = false;
}

async function deleteLoan() {
  const b = $('loan-delete');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
  try { await api.deleteLoan(+loanSel); loanSel = null; toast('Deleted'); showHome(api.data); }
  catch (e) { toast(saveError(e), true); }
}

function renderLoan(d) {
  const loan = d.loans.find((l) => String(l.id) === loanSel), today = isoDay(new Date());
  const alert = loan && repricing(loan, today);
  $('loan-alert').hidden = !alert;
  $('loan-alert').textContent = alert ? alert.text : '';
  if (!loan) { $('loan-view').innerHTML = `<p class="hint">${d.loans.length ? 'Fill in the new loan below.' : 'No mortgage yet. Enter its terms below.'}</p>`; return; }
  const rows = amortise(loan);
  if (!rows.length) { $('loan-view').innerHTML = '<p class="hint">Add a rate period to see the schedule.</p>'; return; }
  const i = loanIndex(rows, today), r = rows[i], started = today.slice(0, 7) >= rows[0].month;
  const remaining = i === 0 ? Number(loan.principal) : rows[i - 1].balance, months = rows.length - i;
  const line = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
  const cpf = Number(loan.cpf_monthly) > 0;
  const card = [['Current rate', r.rate], ['Base rate', loan.base_rate], ['Adverse rate', loan.adverse_rate]].filter(([, x]) => x != null)
    .map(([k, x]) => { const inst = annuity(remaining, Number(x) / 1200, months); return line(`${k}, ${plain(Number(x), 3)}%`, sgd2(inst) + (cpf ? ` <span class="muted">· ${sgd2(Math.max(0, inst - Number(loan.cpf_monthly)))} cash</span>` : '')); }).join('');
  const years = {};
  for (const x of rows) {
    const y = years[x.month.slice(0, 4)] || (years[x.month.slice(0, 4)] = { n: 0, instalments: 0, interest: 0, principal: 0, cpf: 0, cash: 0, balance: 0 });
    y.n++; y.instalments += x.instalment; y.interest += x.interest; y.principal += x.principal; y.cpf += x.cpf; y.cash += x.cash; y.balance = x.balance;
  }
  const end = rows.at(-1);
  $('loan-view').innerHTML = `<div class="loancards">
    <div class="summary"><h3>${started ? `This month, ${monthLong(r.month)}` : `First instalment, ${longDate(r.date)}`}</h3><dl class="flow">
      ${line('Instalment', sgd2(r.instalment), 'total')}
      ${line('Interest', sgd2(r.interest))}${line('Principal', sgd2(r.principal))}
      ${cpf ? line('From CPF', sgd2(r.cpf)) + line('From cash', sgd2(r.cash)) : ''}
      ${line('Owed after this instalment', sgd2(Math.max(0, r.balance)))}
      ${line('Instalments left', `${months} of ${rows.length}`)}
      ${cpf ? line('CPF used so far', sgd2(r.cpfUsed)) + line('CPF to return with interest', `${sgd2(r.cpfAccrued)} <span class="muted">estimate</span>`) : ''}
    </dl></div>
    <div class="summary"><h3>Rate card</h3><p class="fine">Instalment over the remaining ${sgd2(remaining)} and ${months} months${cpf ? ', and the cash part after CPF' : ''}.</p><dl class="flow">${card}</dl>
      <p class="fine">Total interest over the loan at the current schedule: ${sgd2(rows.reduce((t, x) => t + x.interest, 0))}. Last instalment ${monthLong(end.month)}.</p></div>
  </div>
  <details><summary>Schedule by year</summary><div class="scroll"><table>
    <tr><th>Year</th><th>Instalments</th><th>Paid</th><th>Interest</th><th>Principal</th>${cpf ? '<th>CPF</th><th>Cash</th>' : ''}<th>Owed at year end</th></tr>
    ${Object.entries(years).map(([y, x]) => `<tr><td>${y}</td><td>${x.n}</td><td>${money(x.instalments)}</td><td>${money(x.interest)}</td><td>${money(x.principal)}</td>${cpf ? `<td>${money(x.cpf)}</td><td>${money(x.cash)}</td>` : ''}<td>${money(Math.max(0, x.balance))}</td></tr>`).join('')}
  </table></div></details>`;
}

// The Overview's "Due soon" card: planned commitments due within 90 days (and any overdue),
// nearest first, and any mortgage repricing reminder.
function renderDueSoon(d) {
  const el = $('due-soon');
  if (!Array.isArray(d.commitments)) { el.hidden = true; return; }
  const today = isoDay(new Date());
  const due = d.commitments.filter((c) => c.status === 'planned' && daysBetween(today, c.date_due) <= 90).sort((a, b) => a.date_due.localeCompare(b.date_due));
  const alerts = (d.loans || []).map((l) => repricing(l, today)).filter(Boolean);
  el.hidden = !due.length && !alerts.length;
  if (el.hidden) return;
  const when = (iso) => { const n = daysBetween(today, iso); return n === 0 ? 'due today' : n > 0 ? `in ${n} ${n === 1 ? 'day' : 'days'}` : `${-n} ${n === -1 ? 'day' : 'days'} overdue`; };
  el.innerHTML = `<h2>Due soon</h2><ul>${due.map((c) => `<li><b>${esc(c.label)}</b> <span>${sgd2(Number(c.amount))} from ${c.paid_from === 'cpf' ? 'CPF' : 'cash'}</span>
    <span class="when${daysBetween(today, c.date_due) < 0 ? ' alert' : ''}">${longDate(c.date_due)}, ${when(c.date_due)}</span></li>`).join('')}
    ${alerts.map((a) => `<li class="alert">${esc(a.text)}</li>`).join('')}</ul>`;
}

// ---------- spending: itemised card and bank outflows ----------
// Rows, trips, rules and statements come from 008_spending.sql. Statements are read in this
// browser and never uploaded or kept: card and account numbers are dropped, Ref No values are cut
// off and statement text goes through scrub(). Every total, average and standout is worked out
// here from nw_load(); nothing derived is stored.
const SPEND_SOURCES = { citi_card: 'Citi cards', uob_card: 'UOB cards', citi_bank: 'Citibank account', manual: 'Added by hand' };
const SPEND_KINDS = [['recurring', 'Recurring'], ['travel', 'Travel'], ['one_off', 'One-off'], ['reimbursed', 'Paid back'], ['excluded', 'Excluded']];
const kindName = (k) => (SPEND_KINDS.find(([id]) => id === k) || [k, k])[1];
const SPEND_CATS = [
  ['Dining', 'dining', ['Coffee, bakery and snacks', 'Everyday meals (S$25 or less)', 'Casual restaurants (S$25–80)', 'Dinners and group meals (over S$80)']],
  ['Groceries', 'groceries', []],
  ['Transport', 'transport', ['Public transport', 'Ride-hailing', 'Driving']],
  ['Bills', 'bills', ['Utilities', 'Internet and mobile', 'Work and AI software', 'Streaming and app subscriptions', 'Insurance', 'Card fees', 'Fines']],
  ['Fitness', 'fitness', ['Gym and classes', 'Sports kit']],
  ['Health', 'health', ['Dental', 'Physio and TCM', 'Pharmacy', 'Eyewear']],
  ['Shopping', 'shopping', ['Clothes', 'Electronics', 'Home', 'Online', 'Gifts']],
  ['Entertainment', 'fun', ['Concerts and events', 'Movies and attractions']],
  ['Household', 'household', ['Helper', 'Family home', 'Transfers to family']],
  ['Tax', 'tax', ['Income tax', 'Property tax']],
  ['Travel', 'travel', ['Flights', 'Hotels and stays', 'Food and drink', 'Shopping', 'Activities', 'Local transport', 'Visas and fees']],
  ['Cash withdrawals', 'cashout', []],
  ['Transfers', 'transfers', ['Card payments', 'Own accounts', 'Investments']],
  ['Uncategorised', 'uncat', []],
];
const CAT_NAMES = SPEND_CATS.map((c) => c[0]);
// The categories to offer: the built-in ones, then any others in the data or the user's rules.
const allCats = (d) => [...CAT_NAMES, ...new Set([...d.expenses.map((r) => r.category), ...d.expense_rules.map((r) => r.category)].filter((c) => c && !CAT_NAMES.includes(c)))];
// Moving money between your own accounts or into investments is never spending.
const NOT_SPENDING = /^(Transfers|Investments)$/;
const catVar = (c) => '--sp-' + (SPEND_CATS.find((x) => x[0] === c) || SPEND_CATS.at(-1))[1];
const subsOf = (c) => (SPEND_CATS.find((x) => x[0] === c) || [0, 0, []])[2];
const TRAVEL_SUBS = subsOf('Travel');
// Dining that no rule matches is guessed from the amount: up to S$25, up to S$80, then more.
const DINING_BANDS = [[25, 'Everyday meals (S$25 or less)'], [80, 'Casual restaurants (S$25–80)'], [Infinity, 'Dinners and group meals (over S$80)']];
const BIG_ONE = 300, FIRST_TIME = 150;
// What a purchase abroad counts as within travel, by the category it would have at home.
const TRAVEL_SUB = { Dining: 'Food and drink', Groceries: 'Food and drink', Transport: 'Local transport', Shopping: 'Shopping', Entertainment: 'Activities', Fitness: 'Activities', Health: 'Shopping' };

// Built-in rules: generic names only (chains, airlines, apps, government bodies). Personal rules
// live in nw_expense_rules and run first. Tested on the merchant key and the description.
const rule = (re, cat, sub = '', o = {}) => ({ re, cat, sub, ...o });
const SPEND_RULES = [
  rule(/\bSP DIGITAL\b|\bSP SERVICES\b/, 'Bills', 'Utilities'),
  rule(/\bSINGTEL\b|\bSTARHUB\b|\bM1 |\bCIRCLES\b|\bMYREPUBLIC\b|\bSIMBA\b|\bGOMO\b/, 'Bills', 'Internet and mobile'),
  rule(/OPENAI|ANTHROPIC|CLAUDE|CURSOR|GITHUB|LINKEDIN|NOTION|FIGMA/, 'Bills', 'Work and AI software'),
  rule(/NETFLIX|SPOTIFY|DISNEY\+|YOUTUBE|APPLE\.COM\/BILL|KINDLE|AUDIBLE|PLAYSTATION/, 'Bills', 'Streaming and app subscriptions'),
  rule(/ANNUAL MEMBER|MEMBERSHIP FEE|CCY CONVERSION FEE|LATE CHARGE|FINANCE CHARGE|INTEREST CHARGE|CASH REBATE/, 'Bills', 'Card fees'),
  rule(/TRAFFIC POLICE|LTA FINE|\bURA\b/, 'Bills', 'Fines'),
  rule(/INSURANCE|\bETIQA\b|\bAIA\b|PRUDENTIAL|GREAT EASTERN|SINGLIFE/, 'Bills', 'Insurance'),
  rule(/\bSAXO\b|\bKRAKEN\b|\bBINANCE\b|COINBASE|\bGEMINI\b|CRYPTO\.COM|TIGER BROKERS|\bMOOMOO\b|\bFUTU\b|\bIBKR\b|INTERACTIVE BROKERS|\bENDOWUS\b|\bSYFE\b|STASHAWAY|\bWEBULL\b/, 'Transfers', 'Investments', { kind: 'excluded' }),
  rule(/TIME DEPOSIT|FIXED DEPOSIT/, 'Transfers', 'Own accounts', { kind: 'excluded' }),
  rule(/ATM WITHDRAWAL|CASH WITHDRAWAL/, 'Cash withdrawals'),
  rule(/BUS\/MRT|SIMPLYGO|EZ-LINK/, 'Transport', 'Public transport'),
  rule(/\bGRAB\b|\bTADA\b|\bGOJEK\b|\bGOPAY\b|\bCDG\b|COMFORTDELGRO|\bZIG\b|\bRYDE\b|\bUBER\b|\bBOLT\b/, 'Transport', 'Ride-hailing'),
  rule(/\bSHELL\b|\bESSO\b|\bCALTEX\b|\bSPC\b|SINOPEC|PARKING|CARPARK|\bGETGO\b|\bBLUESG\b/, 'Transport', 'Driving'),
  rule(/SINGAPORE ?AIR|SINGAPOR\d|\bSCOOT\b|AIRASIA|JETSTAR|ZIPAIR|CATHAY PACIFIC|AIR CHINA|LUFTHANSA|NORWEGIAN|\bKLM\b|QATAR|EMIRATES|TURKISH|\bJAL\b|\bANA\b/, 'Travel', 'Flights'),
  rule(/TRAVELOKA|TRIP\.COM|EXPEDIA|JETTZY|AGODA|BOOKING\.COM|AIRBNB|PRICELN|HOTEL|RESORT|HOSTEL|NOVOTEL|\bIBIS\b|MARRIOTT|HILTON|HYATT|ACCOR/, 'Travel', 'Hotels and stays', { air: true }),
  rule(/VISA FEE|\bETA\b|\bESTA\b/, 'Travel', 'Visas and fees'),
  rule(/FAIRPRICE|\bNTUC\b|FP XTRA|COLD STORAGE|CS FRESH|\bFINEST\b|SHENG SIONG|\bGIANT\b|DON DON DONKI|\bJASONS\b|MARKET PLACE|7-ELEVEN|REDMART/, 'Groceries'),
  rule(/STARBUCKS|TOAST BOX|YA KUN|BREADTALK|BENGAWAN SOLO|FLASH COFFEE|LUCKIN|COFFEE|\bCAFE\b|ROASTERY|BAKERY|\bKOPI\b|CHICHA|\bLIHO\b|GONG CHA|IJOOZ/, 'Dining', 'Coffee, bakery and snacks'),
  rule(/VIRGIN ACTIVE|ANYTIME FITNESS|FITNESS FIRST|PURE FITNESS|\bCLIMB|BOULDER|\bGYM\b|CLASSPASS|\bYOGA\b|PILATES|ACTIVESG/, 'Fitness', 'Gym and classes'),
  rule(/DECATHLON|\bNIKE\b|ADIDAS|LULULEMON|UNDER ARMOUR|\bASICS\b/, 'Fitness', 'Sports kit'),
  rule(/GUARDIAN|WATSONS|\bUNITY\b/, 'Health', 'Pharmacy'),
  rule(/DENTAL/, 'Health', 'Dental'),
  rule(/PHYSIO|\bTCM\b/, 'Health', 'Physio and TCM'),
  rule(/OWNDAYS|OPTICAL|SPECTACLE/, 'Health', 'Eyewear'),
  rule(/SISTIC|TICKETMASTER|KLOOK/, 'Entertainment', 'Concerts and events'),
  rule(/\bGV\b|GOLDEN VILLAGE|\bSHAW\b|CATHAY CINEPLEX|MANDAI/, 'Entertainment', 'Movies and attractions'),
  rule(/SHOPEE|LAZADA|AMAZON|TAOBAO/, 'Shopping', 'Online', { online: true }),
  rule(/UNIQLO|\bZARA\b|H&M|\bCOS\b/, 'Shopping', 'Clothes'),
  rule(/CHALLENGER|BEST DENKI|HARVEY NORMAN|APPLE\.COM\/SG|APPLE STORE/, 'Shopping', 'Electronics'),
  rule(/\bIKEA\b|\bCOURTS\b/, 'Shopping', 'Home'),
  rule(/INLAND REVENUE|\bIRAS\b/, 'Tax', 'Income tax'),
  rule(/\bAXS\b/, 'Tax', 'Property tax'),
  rule(/\bMCST\b/, 'Household', 'Family home'),
];

const ISO2 = new Set(('AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
  'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NZ OM PA PE PF PG PH PK PL PR PS PT ' +
  'PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VN VU WS YE ZA ZM ZW').split(' '));
const ISO3 = { SGP: 'SG', MYS: 'MY', IDN: 'ID', THA: 'TH', JPN: 'JP', KOR: 'KR', CHN: 'CN', HKG: 'HK', TWN: 'TW', VNM: 'VN', PHL: 'PH', AUS: 'AU', NZL: 'NZ', USA: 'US',
  GBR: 'GB', IRL: 'IE', FRA: 'FR', DEU: 'DE', ITA: 'IT', ESP: 'ES', NLD: 'NL', CHE: 'CH', CAN: 'CA', IND: 'IN', ARE: 'AE', NOR: 'NO', SWE: 'SE', DNK: 'DK', LUX: 'LU', PRT: 'PT', TUR: 'TR' };
// Currency names on Citi's FOREIGN AMOUNT lines, and the country a currency points to.
const FX_NAMES = [[/RUPIAH/, 'IDR'], [/U\.?\s?S\.? DOLLAR/, 'USD'], [/RINGGIT/, 'MYR'], [/YEN/, 'JPY'], [/EURO/, 'EUR'], [/STERLING|POUND/, 'GBP'], [/AUSTRALIAN/, 'AUD'],
  [/HONG KONG/, 'HKD'], [/BAHT/, 'THB'], [/WON/, 'KRW'], [/TAIWAN/, 'TWD'], [/YUAN|RENMINBI/, 'CNY'], [/SWISS/, 'CHF'], [/NORWEGIAN/, 'NOK'], [/SWEDISH/, 'SEK'], [/DANISH/, 'DKK'],
  [/CANADIAN/, 'CAD'], [/NEW ZEALAND/, 'NZD'], [/PESO/, 'PHP'], [/DONG/, 'VND'], [/INDIAN RUPEE/, 'INR'], [/DIRHAM/, 'AED']];
const FX_COUNTRY = { IDR: 'ID', MYR: 'MY', JPY: 'JP', THB: 'TH', KRW: 'KR', TWD: 'TW', CNY: 'CN', HKD: 'HK', AUD: 'AU', NZD: 'NZ', GBP: 'GB', CHF: 'CH', NOK: 'NO', SEK: 'SE',
  DKK: 'DK', CAD: 'CA', PHP: 'PH', VND: 'VN', INR: 'IN', AED: 'AE', USD: 'US' };

const addDays = (iso, k) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + k)).toISOString().slice(0, 10);
const shiftMonth = (m, k) => { const t = +m.slice(0, 4) * 12 + +m.slice(5) - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const titleCase = (s) => String(s).toLowerCase().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const regionName = (c) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c; } catch { return c; } };
const netOf = (r) => Number(r.amount) - Number(r.reimbursed || 0);
const isAbroad = (r) => (!!r.country && r.country !== 'SG') || (!!r.fx_currency && r.fx_currency !== 'SGD');
const ruleRe = (p) => { try { return new RegExp(p, 'i'); } catch { return null; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The merchant key: upper case, without Ref No, booking codes after "*" (a word after "* ", or one
// with digits), runs of 4 or more digits and scrubbed references, spaces collapsed. Rules, recurring
// charges and first visits use it.
function merchantKey(s) {
  return String(s || '').split('\n')[0].toUpperCase()
    .replace(/REF NO.*$/, '')
    .replace(/\*\s+\S+/g, ' ').replace(/\*[A-Z0-9-]*\d[A-Z0-9-]*/g, ' ').replace(/\*/g, ' ')
    .replace(/\d{4,}/g, ' ').replace(/…/g, ' ')
    .replace(/^[\s\-/.,@_]+|[\s\-/.,@_]+$/g, '')
    .replace(/\s+/g, ' ').trim();
}
// Descriptions compared by their letters only, to reuse the key a merchant already has.
const descLetters = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

// A Citibank account line's payee: the transfer type, references, phone and UEN codes, purpose
// codes and bank names are dropped, leaving the name.
function bankMerchant(desc) {
  const s = String(desc || '').toUpperCase();
  if (/^ATM WITHDRAWAL/.test(s)) return 'ATM WITHDRAWAL';
  const rest = s
    .replace(/^(?:PAYNOW|FAST|GIRO|MEPS)?\s*(?:EXTERNAL|INCOMING|OUTGOING)?\s*TRANSFER\b/, ' ')
    .replace(/^INTERNAL TRANSFER (?:DR|CR)\b/, ' ').replace(/^INCOMING GIRO FROM\b/, ' ')
    .replace(/\S*…\S*/g, ' ').replace(/\b[A-Z]{3,6}\d{4,}[A-Z0-9]*\b/g, ' ').replace(/_?\d{4,}/g, ' ')
    .replace(/\bMSISDN\s*\S*/g, ' ').replace(/\bUEN\s+\S+/g, ' ').replace(/\b[A-Z]{4,6}-[A-Z]+\b/g, ' ')
    .replace(/\b(?:DBS BANK LTD|UOB UNITED OVERSEAS BANK LTD|UNITED OVERSEAS BANK LTD|OCBC OVERSEA-CHINESE BANKING CORPN|MARIBANK SINGAPORE PTE LTD|STANDARD CHARTERED BANK SINGAPORE LTD|BANK OF AMERICA, NA|FR CITIBANK)\b/g, ' ');
  return merchantKey(rest.split(/\s+/).filter(Boolean).slice(0, 5).join(' ')) || 'TRANSFER';
}

// The country at the end of a statement line, from the cells after the merchant: its own 2-letter
// code, a 3-letter one (UOB's "SGP"), or two capitals glued to the city ("SAN FRANCISCOUS").
function splitCountry(rest) {
  if (!rest.length) return { country: null };
  const last = rest.at(-1).trim(), tok = last.split(/\s+/).at(-1).toUpperCase();
  if (/^[A-Z]{2}$/.test(tok) && ISO2.has(tok)) return { country: tok };
  if (/^[A-Z]{3}$/.test(tok) && ISO3[tok]) return { country: ISO3[tok] };
  const glued = last.length > 3 && /[A-Za-z]([A-Z]{2})$/.exec(last);
  return { country: glued && ISO2.has(glued[1]) ? glued[1] : null };
}

// Category, subcategory, kind and who labelled it, for a new row. The user's rules come first
// (a rule without a kind keeps the detected one), then the built-in rules, then travel detection,
// then a guess: Dining by amount for a local card purchase, otherwise Uncategorised.
function categorise(row, rules = []) {
  const found = detectCategory(row);
  for (const r of rules) {
    const re = ruleRe(r.pattern);
    if (re && (re.test(row.merchant || '') || re.test(row.description || ''))) {
      return { category: r.category, subcategory: r.subcategory || '', kind: r.kind || (r.category === 'Travel' ? 'travel' : found.kind), labelled_by: 'rule' };
    }
  }
  return found;
}
function detectCategory(row) {
  const out = (category, subcategory = '', kind = 'recurring', labelled_by = 'rule') => ({ category, subcategory, kind, labelled_by });
  const hay = `${row.merchant || ''} ${String(row.description || '').toUpperCase()}`, abroad = isAbroad(row);
  for (const b of SPEND_RULES) {
    if (!b.re.test(hay)) continue;
    if (b.cat === 'Travel') return out('Travel', b.air && /\bAIR|FLIGHT/.test(hay) ? 'Flights' : b.sub, 'travel');
    if (abroad && TRAVEL_SUB[b.cat] && !b.online) return out('Travel', TRAVEL_SUB[b.cat], 'travel');
    return out(b.cat, b.sub, b.kind);
  }
  if (abroad) {
    const online = /\.COM\b|\.IO\b|\.AI\b|WWW\.|ONLINE|PAYPAL|GOOGLE|MICROSOFT|ADOBE|SUBSCR|\*/.test(row.merchant || '') && ['US', 'IE', 'GB', 'NL', 'LU', 'CA'].includes(row.country);
    return online ? out('Shopping', 'Online', 'recurring', 'guess') : out('Travel', 'Food and drink', 'travel');
  }
  if (row.amount < 0 || row.source === 'citi_bank' || row.amount >= BIG_ONE) return out('Uncategorised', '', 'recurring', 'guess');
  return out('Dining', DINING_BANDS.find(([max]) => row.amount <= max)[1], 'recurring', 'guess');
}

// Refs: source, date, amount, merchant key and a count of identical rows in the same file, so two
// identical rides on one day are two rows and importing a file again adds nothing.
function withRefs(rows) {
  const n = {};
  return rows.map((r) => {
    const key = `${r.source}:${r.date}:${r.amount.toFixed(2)}:${r.merchant}`;
    n[key] = (n[key] || 0) + 1;
    return { ...r, ref: `${key}:${n[key]}` };
  });
}

// ----- Citi credit card statement (PDF) -----
// Card statements set each character on its own. Characters closer than a fifth of the text height
// join, a wider gap is a space, and a gap wider than about two spaces starts a new cell, so the
// merchant, city, country, amount and anything in the margin come out as cells of their own.
function cardLines(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) <= 2.5) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows.map((row) => {
    const cells = [];
    let cur = '', prev = null;
    for (const it of row.items.sort((a, b) => a.x - b.x)) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0, h = it.h || 8;
      if (prev && gap > 0.45 * h) { if (cur.trim()) cells.push(cur.trim()); cur = ''; } else if (prev && gap > 0.2 * h) cur += ' ';
      cur += it.s;
      prev = it;
    }
    if (cur.trim()) cells.push(cur.trim());
    return { cells, text: cells.join(' ') };
  });
}

const MONEY = /^\(?-?\d{1,3}(?:,?\d{3})*\.\d{2}\)?$/;
const moneyVal = (s) => (/^\(.*\)$/.test(s) ? -1 : 1) * +s.replace(/[(),]/g, '');
const CARD_DATE = /^(\d{1,2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\s*(.*)$/i;
function citiCardLabel(name) {
  const n = String(name).replace(/[^A-Za-z]/g, '').toUpperCase();
  if (n.includes('PREMIERMILES')) return 'Citi PremierMiles';
  if (n.includes('REWARDS')) return n.includes('VISA') ? 'Citi Rewards Visa' : 'Citi Rewards';
  if (n.includes('CASHBACK')) return 'Citi Cash Back';
  return 'Citi ' + titleCase(String(name).replace(/\d.*$/, '').replace(/\bCITI\b|\bCARD\b/gi, ''));
}

// Reads a Citibank Singapore credit card statement, one card or several. Payments are counted but
// not kept; masked card lines, subtotals and page furniture are skipped. Rows keep their day and
// month; datedRows() adds the year from the statement date.
function readCitiCard(lines) {
  const dateOf = (re) => {
    for (const l of lines) { const m = re.exec(l.text); if (m && monthIndex(m[1])) return isoDate(+m[3], monthIndex(m[1]), +m[2]); }
    return null;
  };
  const stmtDate = dateOf(/STATEMENT\s*DATE:?\s*([A-Za-z]{3,9})\s*(\d{1,2}),?\s*(\d{4})/i);
  const due = dateOf(/PAYMENT\s*DUE\s*DATE:?\s*([A-Za-z]{3,9})\s*(\d{1,2}),?\s*(\d{4})/i);
  const pageOf = lines.map((l) => /PAGE\s*\d+\s*OF\s*(\d+)/i.exec(l.text)).find(Boolean);
  const cards = [], summaries = {};
  const cardFor = (label) => cards.find((c) => c.card === label) || (cards.push({ card: label, rows: [], payments: 0, paid: 0, payDays: [] }), cards.at(-1));
  let head = null, wantSummary = null, card = null, last = null;
  for (const l of lines) {
    const sq = l.text.replace(/\s+/g, '').toUpperCase();
    if (/^CITI/.test(sq) && /PAYMENTDUEDATE/.test(sq)) { head = citiCardLabel(l.text.split(/\d|payment/i)[0]); continue; }
    if (/^PREVIOUSPAYMENTSPURCHASES/.test(sq)) { wantSummary = head; continue; }
    const nums = l.text.match(/\(?\d[\d,]*\.\d{2}\)?/g);
    if (wantSummary && nums && nums.length >= 6 && /^[\d,.()\s-]+$/.test(l.text)) { summaries[wantSummary] = nums.slice(0, 6).map(moneyVal); wantSummary = null; continue; }
    const tf = /^TRANSACTIONSFOR(.+)$/.exec(sq);
    if (tf) { card = cardFor(citiCardLabel(tf[1])); last = null; continue; }
    if (!card) continue;
    if (/GRANDTOTAL/.test(sq)) { card = null; continue; }
    const fx = /^FOREIGN\s*AMOUNT\s*(.+?)\s*(\d[\d,]*\.\d{2})/i.exec(l.text);
    if (fx) {
      if (last) { const f = FX_NAMES.find(([re]) => re.test(fx[1].toUpperCase())); last.fx_currency = f ? f[1] : null; last.fx_amount = +fx[2].replace(/,/g, ''); }
      continue;
    }
    let cells = l.cells, date = CARD_DATE.exec(cells[0] || '');
    if (date && date[3]) cells = [cells[0].slice(0, cells[0].length - date[3].length).trim(), date[3], ...cells.slice(1)];
    else if (!date && /^\d{1,2}$/.test(cells[0] || '') && (date = CARD_DATE.exec(`${cells[0]} ${cells[1] || ''}`))) cells = [`${cells[0]} ${cells[1]}`, ...cells.slice(2)];
    if (!date) continue;
    let end = -1;
    for (let i = cells.length - 1; i > 0; i--) if (MONEY.test(cells[i])) { end = i; break; }
    if (end < 1) continue;
    const amount = moneyVal(cells[end]), middle = cells.slice(1, end).filter((c) => !MONEY.test(c)), text = middle.join(' ');
    if (!text) continue;
    if (amount < 0 && /^PAYMENT\b/i.test(text)) { card.payments++; card.paid = cents(card.paid - amount); card.payDays.push({ day: +date[1], mon: monthIndex(date[2]) }); last = null; continue; }
    last = { day: +date[1], mon: monthIndex(date[2]), description: scrub(text), merchant: merchantKey(middle[0]) || merchantKey(text) || 'CARD TRANSACTION', amount, fx_currency: null, fx_amount: null, ...splitCountry(middle.slice(1)) };
    card.rows.push(last);
  }
  for (const c of cards) c.summary = summaries[c.card] || null;
  return { stmtDate, due, pages: pageOf ? +pageOf[1] : null, cards };
}

// Without a statement date, it's about 25 days before the due date, moved to the day of the month
// the other statements close on when that's within 6 days.
function statementDateFromDue(due, closeDays) {
  const est = addDays(due, -25), count = {};
  for (const d of closeDays) count[d] = (count[d] || 0) + 1;
  const day = +Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  if (!day) return est;
  const tries = [-1, 0, 1].map((k) => { const m = shiftMonth(est.slice(0, 7), k); return isoDate(+m.slice(0, 4), +m.slice(5), Math.min(day, +monthEnd(m).slice(8))); });
  const best = tries.sort((a, b) => Math.abs(daysBetween(a, est)) - Math.abs(daysBetween(b, est)))[0];
  return Math.abs(daysBetween(best, est)) <= 6 ? best : est;
}

// A card's rows with full dates. Lines have no year: they take the statement's, or the year before
// when their month is later than the statement's (December lines on a January statement).
function datedRows(card, stmtDate) {
  const y = +stmtDate.slice(0, 4), m = +stmtDate.slice(5, 7);
  return card.rows.map(({ day, mon, ...r }) => ({ ...r, date: isoDate(mon > m ? y - 1 : y, mon, day) })).filter((r) => r.date);
}

// Checks a card's lines against its summary: purchases against the other positive lines, credits
// (less payments) against the other refunds, and fees and interest against the fee lines. Citi nets
// a fee reversal into fees, so that column is taken from the balance: current − previous +
// payments and credits − purchases. A mismatch is a warning, not a refusal: pdf.js can drop a line.
const FEE_LINE = /CCY ?CONVERSION FEE|ANNUAL MEMBER|MEMBERSHIP FEE|GST ON|LATE CHARGE|FINANCE CHARGE|INTEREST CHARGE/i;
function reconcileCard(card) {
  if (!card.summary) return { ok: null, text: 'No summary for this card in the file, so its lines could not be checked.' };
  const [prev, payCred, purchases, , , current] = card.summary;
  const sum = (f) => cents(card.rows.filter(f).reduce((t, r) => t + r.amount, 0));
  const diffs = [
    ['purchases', cents(sum((r) => r.amount > 0 && !FEE_LINE.test(r.description)) - purchases)],
    ['refunds', cents(-sum((r) => r.amount < 0 && !FEE_LINE.test(r.description)) - (payCred - card.paid))],
    ['fees and interest', cents(sum((r) => FEE_LINE.test(r.description)) - (current - prev + payCred - purchases))],
  ].filter(([, d]) => Math.abs(d) >= 0.005);
  if (!diffs.length) return { ok: true, text: 'Adds up with the statement summary.' };
  return { ok: false, text: `Doesn't add up: ${diffs.map(([k, d]) => `${k} are ${sgd2(Math.abs(d))} ${d < 0 ? 'short of' : 'over'} the summary`).join(', and ')}. A line may not have been read; you can still save.` };
}

// ----- UOB card transaction history (.xls) -----
// Rows come from SheetJS as arrays. The account number row is never read; the description keeps
// only its first line (the Ref No goes) and splits on runs of spaces into merchant, city, country.
function readUob(rows) {
  const find = (label) => rows.find((r) => String(r[0] || '').trim().toLowerCase() === label);
  const h = rows.findIndex((r) => /^transaction date$/i.test(String(r[0] || '').trim()));
  if (h < 0) return { error: "Couldn't find the transactions table (a row starting Transaction Date) in this file." };
  const col = (re) => rows[h].findIndex((c) => re.test(String(c)));
  const cPost = col(/posting/i), cDesc = col(/description/i), cFxT = col(/foreign currency type/i), cFxA = col(/amount\s*\(foreign\)/i), cAmt = col(/amount\s*\(local\)/i);
  if (cDesc < 0 || cAmt < 0) return { error: "Couldn't find the Description and Transaction Amount(Local) columns." };
  const day = (v) => { const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(String(v || '').trim()); return m && monthIndex(m[2]) ? isoDate(+m[3], monthIndex(m[2]), +m[1]) : null; };
  const type = find('account type:'), period = find('statement date:');
  const pm = period && /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s*to\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i.exec(String(period[1] || ''));
  const out = { card: 'UOB ' + (titleCase(String(type && type[1] || '').replace(/\bCARD\b/i, '')) || 'card'), start: pm && day(pm[1]), end: pm && day(pm[2]), rows: [], payments: 0, paid: 0 };
  for (const r of rows.slice(h + 1)) {
    const date = day(r[0]);
    if (!date) continue;
    const raw = String(r[cDesc] || '').split('\n')[0].trim(), amount = cents(Number(String(r[cAmt]).replace(/,/g, '')));
    if (!raw || !isFinite(amount) || !amount) continue;
    if (amount < 0 && /^PAYMT\b|^PAYMENT\b/i.test(raw)) { out.payments++; out.paid = cents(out.paid - amount); continue; }
    const segs = raw.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const fxCur = String(cFxT >= 0 && r[cFxT] || '').trim().toUpperCase(), fxAmt = Number(String(cFxA >= 0 && r[cFxA] || '').replace(/,/g, ''));
    let { country } = splitCountry(segs.slice(1));
    if (!country && FX_COUNTRY[fxCur]) country = FX_COUNTRY[fxCur];
    out.rows.push({ date, posted: day(cPost >= 0 ? r[cPost] : ''), description: scrub(segs.join(' ')), merchant: merchantKey(segs[0]) || 'CARD TRANSACTION', amount, country,
      fx_currency: /^[A-Z]{3}$/.test(fxCur) && fxCur !== 'SGD' ? fxCur : null, fx_amount: fxCur && fxCur !== 'SGD' && isFinite(fxAmt) && fxAmt ? fxAmt : null });
  }
  if (!out.start || !out.end) { const ds = out.rows.map((x) => x.date).sort(); out.start = out.start || ds[0]; out.end = out.end || ds.at(-1); }
  if (!out.start) return { error: 'No transactions with dates in this file.' };
  return out;
}

// ----- Citibank account outflows (from readCiti) -----
// Withdrawals become rows, except card bill payments. Deposits are left out unless they come from a
// payee paid before (a refund). Only S$ accounts are read.
const CARD_BILL = /PAYMENT TO CITI CREDIT CARD|CITI\s?CARD|CREDIT CARD PAYMENT|UOB CARD|BILL PAYMENT.*CARD/i;
function bankParts(r, paidBefore) {
  const parts = [];
  for (const a of r.accounts.filter((x) => x.currency === 'SGD' && x.details)) {
    const part = { source: 'citi_bank', card: a.name, start: r.start || r.end.slice(0, 8) + '01', end: r.end, rows: [], payments: 0, paid: 0 };
    const payees = new Set(paidBefore);
    for (const t of a.txs.filter((x) => x.signed < 0)) {
      if (CARD_BILL.test(t.desc)) { part.payments++; part.paid = cents(part.paid - t.signed); continue; }
      const merchant = bankMerchant(t.desc);
      payees.add(merchant);
      part.rows.push({ date: t.date, description: scrub(t.desc) || merchant, merchant, amount: cents(-t.signed), country: null });
    }
    for (const t of a.txs.filter((x) => x.signed > 0)) {
      const merchant = bankMerchant(t.desc);
      if (payees.has(merchant) && !/SALARY|INTEREST/i.test(t.desc)) part.rows.push({ date: t.date, description: scrub(t.desc) || merchant, merchant, amount: cents(-t.signed), country: null });
    }
    parts.push(part);
  }
  return parts;
}

function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return loadXlsx.p || (loadXlsx.p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { loadXlsx.p = null; reject(new Error('The spreadsheet reader did not load. Reload the page and try again.')); };
    document.head.appendChild(s);
  }));
}

// The type is told from the content: a PDF with "TRANSACTIONS FOR CITI" is a card statement,
// another PDF is tried as a Citibank account statement, and an Excel file as a UOB export.
async function readSpendFile(bytes) {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    const pages = await pdfPages(bytes), lines = pages.flatMap(cardLines);
    if (lines.some((l) => /TRANSACTIONS\s*FOR\s*CITI/i.test(l.text))) {
      const r = readCitiCard(lines);
      return r.cards.length ? { kind: 'citi_card', ...r } : { error: "This looks like a Citi card statement, but no card's transactions could be read." };
    }
    const r = readCiti(pages.flatMap(textLines));
    return r.error ? { error: `Not a Citi card statement, and not readable as a Citibank account statement: ${r.error}` } : { kind: 'citi_bank', bank: r };
  }
  if ((bytes[0] === 0xd0 && bytes[1] === 0xcf) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const X = await loadXlsx(), wb = X.read(bytes, { type: 'array' });
    const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    const u = readUob(rows);
    return u.error ? { error: `Not a UOB card transaction history: ${u.error}` } : { kind: 'uob_card', uob: u };
  }
  return { error: 'Pick a Citi card statement PDF, a Citibank account statement PDF or a UOB card export (.xls).' };
}

// ----- import: preview, then save -----
let spendImport = null;
async function importSpending(files) {
  spendImport = { busy: true };
  renderSpendImport();
  const list = [];
  for (const f of files) {
    try { list.push({ name: scrub(f.name), ...(await readSpendFile(new Uint8Array(await f.arrayBuffer()))) }); }
    catch (e) { list.push({ name: scrub(f.name), error: `Couldn't read this file (${e && e.message ? e.message : e}).` }); }
  }
  const cards = list.filter((x) => x.kind === 'citi_card');
  const closeDays = [...api.data.statements.filter((s) => s.source === 'citi_card').map((s) => +s.period_end.slice(8)), ...cards.filter((x) => x.stmtDate).map((x) => +x.stmtDate.slice(8))];
  for (const f of cards) if (!f.stmtDate && f.due) f.stmtDate = statementDateFromDue(f.due, closeDays);
  // A card with nothing due has no dates on its statement. It takes the date of another file from
  // the same statement (same page count): the earliest one its lines and payments fit. Otherwise it asks.
  for (const f of cards.filter((x) => !x.stmtDate)) {
    const days = f.cards.flatMap((c) => [...c.rows, ...c.payDays]);
    const fits = (sd) => days.length && days.every(({ day, mon }) => { const y = +sd.slice(0, 4) - (mon > +sd.slice(5, 7) ? 1 : 0), dt = isoDate(y, mon, day); return dt && dt <= sd && dt >= addDays(sd, -62); });
    const sib = cards.filter((x) => x !== f && x.stmtDate && x.pages && x.pages === f.pages && fits(x.stmtDate)).sort((a, b) => a.stmtDate.localeCompare(b.stmtDate))[0];
    if (sib) { f.stmtDate = sib.stmtDate; f.borrowed = true; }
  }
  spendImport = { files: list };
  buildSpendImport();
  renderSpendImport();
}

// Lines already stored are found by ref, or by the same card, date and amount (each stored line
// matching once), since lines imported another way may have other merchant keys. A matched line takes
// the stored ref, so the database skips it. A new line from a merchant already stored keeps its key.
function buildSpendImport() {
  const d = api.data, rules = d.expense_rules || [], known = new Set(d.expenses.map((e) => e.ref)), seen = new Set();
  const paidBefore = new Set(d.expenses.filter((e) => e.source === 'citi_bank' && Number(e.amount) > 0).map((e) => e.merchant));
  const slot = (r) => `${r.source}|${r.card}|${r.date}|${Number(r.amount).toFixed(2)}`, free = {}, keyOf = {};
  for (const e of d.expenses) {
    (free[slot(e)] = free[slot(e)] || []).push(e.ref);
    keyOf[e.source + '|' + descLetters(e.description)] = e.merchant;
  }
  const part = (source, card, start, end, rows, payments, check) => ({ statement: { source, card, period_start: start, period_end: end }, payments, check,
    rows: rows.map((r) => ({ posted: null, fx_currency: null, fx_amount: null, country: null, ...r, source, card, amount: cents(r.amount) })) });
  for (const f of spendImport.files) {
    f.parts = [];
    if (f.error) continue;
    if (f.kind === 'citi_card') {
      if (!f.stmtDate) continue;
      for (const c of f.cards) f.parts.push(part('citi_card', c.card, addDays(addMonths(f.stmtDate, -1), 1), f.stmtDate, datedRows(c, f.stmtDate), c.payments, reconcileCard(c)));
    } else if (f.kind === 'uob_card') {
      const u = f.uob;
      f.parts.push(part('uob_card', u.card, u.start, u.end, u.rows, u.payments, { ok: null, text: 'The export has no totals to check against.' }));
    } else {
      for (const p of bankParts(f.bank, paidBefore)) f.parts.push(part('citi_bank', p.card, p.start, p.end, p.rows, p.payments, { ok: true, text: 'The account added up when read.' }));
    }
    // Identical lines are counted across the whole file, so the refs match whichever way it's split.
    const refs = withRefs(f.parts.flatMap((p) => p.rows)).map((r) => r.ref);
    let i = 0;
    for (const p of f.parts) {
      p.dupes = 0;
      p.rows = p.rows.map((r) => {
        let ref = refs[i++], dupe = known.has(ref) || seen.has(ref);
        const merchant = keyOf[r.source + '|' + descLetters(r.description)] || r.merchant;
        if (!dupe && free[slot(r)] && free[slot(r)].length) { seen.add(ref); ref = free[slot(r)].shift(); dupe = true; }
        if (known.has(ref) && free[slot(r)]) { const k = free[slot(r)].indexOf(ref); if (k >= 0) free[slot(r)].splice(k, 1); }
        if (dupe) p.dupes++;
        seen.add(ref);
        const row = { ...r, merchant, ref };
        return { ...row, ...categorise(row, rules) };
      });
      Object.assign(p.statement, { purchases: cents(p.rows.reduce((t, r) => t + (r.amount > 0 ? r.amount : 0), 0)), credits: cents(p.rows.reduce((t, r) => t + (r.amount < 0 ? -r.amount : 0), 0)), lines: p.rows.length });
    }
  }
}

function renderSpendImport() {
  const el = $('spend-import');
  if (!spendImport) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.classList.remove('error');
  if (spendImport.busy) { el.innerHTML = '<p>Reading the files in this browser…</p>'; return; }
  let fresh = 0, stmts = 0;
  const files = spendImport.files.map((f, i) => {
    if (f.error) return `<h3>${esc(f.name)}</h3><p class="err">${esc(f.error)}</p>`;
    if (f.kind === 'citi_card' && !f.stmtDate) {
      return `<h3>${esc(f.name)}</h3><p>This statement shows no statement or due date (nothing was due). Enter its statement date to read it:
        <input type="date" data-sdate="${i}"> <button class="btn" type="button" data-usedate="${i}">Use this date</button></p>`;
    }
    const parts = f.parts.map((p) => {
      const n = p.rows.length - p.dupes;
      fresh += n; stmts++;
      const check = p.check.ok === false ? `<span class="down">${esc(p.check.text)}</span>` : p.check.ok ? `<span class="ok">${esc(p.check.text)}</span>` : `<span class="muted">${esc(p.check.text)}</span>`;
      return `<tr><td class="desc">${esc(p.statement.card)}</td><td>${longDate(p.statement.period_start)} to ${longDate(p.statement.period_end)}</td><td>${p.rows.length}</td>
        <td>${sgd2(p.statement.purchases)}</td><td>${sgd2(p.statement.credits)}</td><td>${p.payments}</td><td>${p.dupes ? `${p.dupes} already in` : 'none'}</td><td class="desc">${check}</td></tr>`;
    }).join('');
    return `<h3>${esc(f.name)}${f.borrowed ? ' <span class="muted">(dated from another file of the same statement)</span>' : ''}</h3>
      <table><tr><th class="desc">Card or account</th><th>Period</th><th>Lines</th><th>Purchases</th><th>Credits</th><th>Bill payments left out</th><th>Duplicates</th><th class="desc">Check</th></tr>${parts}</table>`;
  }).join('');
  el.innerHTML = `<h2>Import statements</h2><p>Nothing is saved until you choose Save. Card numbers, account numbers and references are left out.</p>${files}
    <p class="actions"><button class="btn primary" type="button" data-spendsave ${fresh || stmts ? '' : 'disabled'}>Save ${fresh} new line${fresh === 1 ? '' : 's'}</button>
    <button class="btn" type="button" data-spendcancel>Cancel</button></p>`;
}

async function saveSpendImport() {
  const payload = spendImport.files.flatMap((f) => f.parts || []).map((p) => ({ statement: p.statement, rows: p.rows.map(({ ref, ...r }) => ({ ...r, ref })) }));
  if (!payload.length) return;
  try {
    const d = await api.saveExpenses(payload);
    spendImport = null;
    toast(`Added ${d.added} line${d.added === 1 ? '' : 's'}${d.skipped ? `; ${d.skipped} were already in` : ''}`);
    showSpending(d);
  } catch (e) { toast(saveError(e), true); }
}

// ----- analysis: pure functions over the rows -----
// Totals by month, category and subcategory, by transaction date, net of anything paid back.
function spendMonthly(rows) {
  const out = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7), v = netOf(r), o = out[m] || (out[m] = { total: 0, cats: {}, subs: {} });
    o.total += v;
    o.cats[r.category] = (o.cats[r.category] || 0) + v;
    const k = r.category + '|' + (r.subcategory || '');
    o.subs[k] = (o.subs[k] || 0) + v;
  }
  return out;
}

// Months each source's statements cover in full (its periods joined end to end).
function coverage(stmts) {
  const per = {}, full = {};
  for (const s of stmts) (per[s.source] = per[s.source] || []).push([s.period_start, s.period_end]);
  for (const [src, list] of Object.entries(per)) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
    const merged = [];
    for (const [a, b] of list) { const l = merged.at(-1); if (l && a <= addDays(l[1], 1)) { if (b > l[1]) l[1] = b; } else merged.push([a, b]); }
    full[src] = new Set();
    for (const [a, b] of merged) for (let m = a.slice(0, 7); m <= b.slice(0, 7); m = nextMonth(m)) if (a <= m + '-01' && b >= monthEnd(m)) full[src].add(m);
  }
  return full;
}

// The average over the 12 months up to each month, dividing by the months covered in that window.
function rolling12(months, value, covered) {
  return months.map((m) => {
    let t = 0, n = 0;
    for (let k = 0; k < 12; k++) { const w = shiftMonth(m, -k); if (covered(w)) { t += value(w); n++; } }
    return n ? t / n : null;
  });
}

// Rows worth a second look, each with its reasons. History before the period counts for medians,
// first visits and duplicates. Only rows still counted as recurring are checked (travel, one-offs
// and paid-back rows are already labelled), and rows marked "not a standout" are left out.
function standouts(all, from, to) {
  const live = all.filter((r) => r.kind !== 'excluded' && !NOT_SPENDING.test(r.category)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const byM = {}, byCat = {}, first = live.length ? live[0].date : null;
  for (const r of live) {
    (byM[r.merchant] = byM[r.merchant] || []).push(r);
    if (r.amount > 0) (byCat[r.category] = byCat[r.category] || []).push(r.amount);
  }
  const p95 = {};
  for (const [c, v] of Object.entries(byCat)) if (v.length >= 20) p95[c] = quantile(v, 0.95);
  const out = [];
  for (const r of live) {
    const m = r.date.slice(0, 7);
    if (m < from || m > to || r.amount <= 0 || r.kind !== 'recurring' || /not a standout/i.test(r.note || '')) continue;
    const hist = byM[r.merchant], before = hist.slice(0, hist.indexOf(r)), paid = before.filter((x) => x.amount > 0), reasons = [];
    if (r.amount >= BIG_ONE && !['Bills', 'Tax', 'Household'].includes(r.category)) reasons.push(`${sgd2(r.amount)} in one go`);
    const med = paid.length >= 3 ? median(paid.map((x) => x.amount)) : null, routine = ['Bills', 'Tax', 'Household'].includes(r.category);
    if (med && r.amount > 3 * med && r.amount >= 50) reasons.push(`${(r.amount / med).toFixed(1)}× the usual ${sgd2(med)} here`);
    else if (p95[r.category] && r.amount > p95[r.category] && r.amount >= 100 && !routine && !reasons.length) reasons.push(`More than 95% of ${r.category.toLowerCase()} purchases`);
    if (!before.length && r.amount >= FIRST_TIME && daysBetween(first, r.date) >= 90) reasons.push('First time at this merchant');
    const twin = before.find((x) => x.amount === r.amount && daysBetween(x.date, r.date) <= 2);
    if (twin && r.amount >= 20) reasons.push(`Same amount here on ${dayMonth(twin.date)}: charged twice?`);
    if (reasons.length) out.push({ row: r, reasons });
  }
  return out;
}

// Merchants charged in at least 3 of the 4 months up to `to`, at a similar amount (within 15%).
// A latest charge more than 10% off the earlier ones is a price change.
function recurringCharges(rows, to) {
  const months = [shiftMonth(to, -3), shiftMonth(to, -2), shiftMonth(to, -1), to], by = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (r.kind !== 'recurring' || r.amount <= 0 || !months.includes(m)) continue;
    const g = by[r.merchant] || (by[r.merchant] = { months: {}, count: 0, last: null });
    g.months[m] = (g.months[m] || 0) + r.amount;
    g.count++;
    if (!g.last || r.date > g.last.date) g.last = r;
  }
  const out = [];
  for (const [merchant, g] of Object.entries(by)) {
    const present = months.filter((m) => g.months[m]);
    if (present.length < 3 || g.count > present.length * 2) continue;
    const vals = present.map((m) => g.months[m]), earlier = vals.slice(0, -1), med = median(earlier), latest = vals.at(-1);
    if (!earlier.every((v) => Math.abs(v - med) <= 0.15 * med)) continue;
    const change = Math.abs(latest - med) > 0.1 * med ? { from: med, to: latest } : null;
    out.push({ merchant, last: g.last, monthly: latest, yearly: latest * 12, change });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

// Travel by trip: one line per trip, plus bookings paid ahead from Singapore (not in a trip yet)
// and travel abroad that isn't in a trip. Columns are the travel subcategories.
function tripTable(rows, trips) {
  const lines = new Map(), byId = Object.fromEntries(trips.map((t) => [t.id, t]));
  const line = (key, name, trip) => {
    if (!lines.has(key)) lines.set(key, { key, name, trip, subs: {}, total: 0, days: trip && trip.start_date && trip.end_date ? daysBetween(trip.start_date, trip.end_date) + 1 : null });
    return lines.get(key);
  };
  for (const r of rows) {
    const sub = r.category === 'Travel' ? (TRAVEL_SUBS.includes(r.subcategory) ? r.subcategory : 'Food and drink') : TRAVEL_SUB[r.category] || 'Shopping';
    const t = r.trip_id && byId[r.trip_id];
    const l = t ? line('t' + t.id, t.name, t) : isAbroad(r) ? line('unassigned', 'Unassigned travel') : line('upcoming', 'Upcoming (paid ahead)');
    l.subs[sub] = (l.subs[sub] || 0) + netOf(r);
    l.total += netOf(r);
  }
  const order = (l) => (l.trip ? l.trip.start_date || '9' : l.key === 'upcoming' ? '~1' : '~2');
  return [...lines.values()].sort((a, b) => (order(b) > order(a) ? 1 : -1)).sort((a, b) => (a.trip ? 0 : 1) - (b.trip ? 0 : 1));
}

// Travel abroad not yet in a trip, grouped by date: a gap of more than 3 days starts a new trip.
// Each is named after its most common country and the month it starts.
function suggestTrips(all, trips) {
  const inTrip = (r) => r.trip_id || trips.some((t) => t.start_date && t.end_date && r.date >= t.start_date && r.date <= t.end_date);
  const pts = all.filter((r) => r.kind === 'travel' && r.country && r.country !== 'SG' && !inTrip(r)).sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  for (const r of pts) {
    const g = groups.at(-1);
    if (g && daysBetween(g.end, r.date) <= 3) { g.end = r.date; g.rows.push(r); } else groups.push({ start: r.date, end: r.date, rows: [r] });
  }
  return groups.map((g) => {
    const count = {};
    for (const r of g.rows) count[r.country] = (count[r.country] || 0) + 1;
    const c = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    return { ...g, name: `${regionName(c)}, ${MONTH_NAMES[+g.start.slice(5, 7) - 1].slice(0, 3)} ${g.start.slice(0, 4)}`, total: g.rows.reduce((t, r) => t + netOf(r), 0) };
  });
}

// ----- the tab -----
const spendState = Object.assign({ range: '12', from: '', to: '', kinds: { recurring: true, travel: true, one_off: false, reimbursed: false, excluded: false }, off: {} }, prefs.get('spend', {}));
const saveSpendState = () => prefs.set('spend', spendState);
let spendWired = false, spendOpen = new Set(), spendPick = null, spendChart = null, tripDraft = null, payBackId = null, tripPickId = null;

// Everything the views need for the chosen period, kinds and sources.
function spendView(d) {
  const all = d.expenses.map((r) => ({ ...r, amount: Number(r.amount), reimbursed: Number(r.reimbursed) || 0 }));
  const key = (r) => `${r.source}|${r.card}`;
  const sources = [...new Set([...d.statements.map(key), ...all.map(key)])].sort();
  const srcOn = (r) => !spendState.off[key(r)];
  const latest = all.reduce((m, r) => (r.date > m ? r.date : m), '').slice(0, 7) || isoDay(new Date()).slice(0, 7);
  const mine = all.filter(srcOn), rows = mine.filter((r) => spendState.kinds[r.kind]);
  // A month is covered when any source's statements cover all of it, and complete when every source
  // that had started by then does (a card counts from its first statement on).
  const stmts = d.statements.filter(srcOn), cov = coverage(stmts), covSets = Object.values(cov), began = {};
  for (const s of stmts) if (!began[s.source] || s.period_start < began[s.source]) began[s.source] = s.period_start;
  const withRows = new Set(mine.map((r) => r.date.slice(0, 7)));
  const covered = (m) => (covSets.length ? covSets.some((s) => s.has(m)) : withRows.has(m));
  const complete = (m) => {
    if (!covSets.length) return withRows.has(m);
    const live = Object.keys(cov).filter((src) => began[src] <= monthEnd(m));
    return live.length > 0 && live.every((src) => cov[src].has(m));
  };
  // The period ends on the latest complete month (a month still coming in would look low).
  let to = latest, from;
  for (let m = latest, k = 0; k < 3; m = shiftMonth(m, -1), k++) if (complete(m)) { to = m; break; }
  if (spendState.range === 'custom' && /^\d{4}-\d{2}$/.test(spendState.from) && /^\d{4}-\d{2}$/.test(spendState.to) && spendState.from <= spendState.to) { from = spendState.from; to = spendState.to; }
  else if (spendState.range === 'year') from = to.slice(0, 4) + '-01';
  else from = shiftMonth(to, -(+spendState.range || 12) + 1);
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  const monthly = spendMonthly(rows), recurring = spendMonthly(mine.filter((r) => r.kind === 'recurring'));
  const val = (mo, m) => (mo[m] ? mo[m].total : 0);
  const avgOver = (mo, list, pick = (x) => (x ? x.total : 0)) => { const c = list.filter(covered); return c.length ? c.reduce((t, m) => t + pick(mo[m]), 0) / c.length : null; };
  return { d, all, mine, rows, sources, key, from, to, months, cov, covered, complete, monthly, recurring, val, avgOver, inRange: (r) => r.date.slice(0, 7) >= from && r.date.slice(0, 7) <= to };
}

function setSpendBadge(d, v) {
  const n = Array.isArray(d.expenses) && v ? reviewItems(v).length : 0;
  $('tab-spending').textContent = n ? `Spending (${n})` : 'Spending';
}

function showSpending(d) {
  const on = Array.isArray(d.expenses);
  $('spend-off').hidden = on;
  $('spend-body').hidden = !on;
  if (!on) { setSpendBadge(d); return; }
  wireSpending();
  const v = spendView(d);
  setSpendBadge(d, v);
  renderSpendImport();
  renderSpendFilters(v);
  renderSpendHead(v);
  renderSpendChart(v);
  renderSpendCats(v);
  renderSpendTxs(v);
  renderStandouts(v);
  renderRecurring(v);
  renderTravel(v);
  renderReview(v);
  renderImported(v);
  renderRules(v);
}

function renderSpendFilters(v) {
  const s = spendState, chip = (attr, id, label, on, color) => `<button type="button" class="chip" ${attr}="${esc(id)}" aria-pressed="${on}"${color ? ` style="--c:var(${color})"` : ''}><span class="dot"></span>${esc(label)}</button>`;
  const ranges = [['12', 'Last 12 months'], ['24', 'Last 24 months'], ['year', 'This year'], ['custom', 'Pick months']];
  $('spend-filters').innerHTML = `
    <div class="seg" id="spend-range">${ranges.map(([id, n]) => `<button type="button" data-range="${id}" aria-pressed="${s.range === id}">${n}</button>`).join('')}</div>
    ${s.range === 'custom' ? `<label class="muted">From <input type="month" id="spend-from" value="${esc(s.from || v.from)}"></label><label class="muted">to <input type="month" id="spend-to" value="${esc(s.to || v.to)}"></label>` : ''}
    <div class="chips">${SPEND_KINDS.map(([id, n]) => chip('data-kind', id, n, !!s.kinds[id], id === 'travel' ? '--sp-travel' : '--ink-3')).join('')}</div>
    ${v.sources.length > 1 ? `<div class="chips">${v.sources.map((k) => { const [src, card] = k.split('|'); return chip('data-src', k, card || SPEND_SOURCES[src] || src, !s.off[k], '--accent'); }).join('')}</div>` : ''}`;
}

function renderSpendHead(v) {
  const { to, monthly, recurring, val, mine, d } = v;
  const last12 = [];
  for (let k = 11; k >= 0; k--) last12.push(shiftMonth(to, -k));
  const base = v.avgOver(recurring, last12);
  const travel = mine.filter((r) => r.kind === 'travel' && r.date.slice(0, 7) >= last12[0] && r.date.slice(0, 7) <= to).reduce((t, r) => t + netOf(r), 0);
  // Coverage per card or account: first and last month, and any month missing in between.
  const byKey = {};
  for (const s of d.statements) (byKey[v.key(s)] = byKey[v.key(s)] || []).push(s);
  const cov = Object.entries(byKey).map(([k, list]) => {
    const months = coverage(list)[list[0].source] || new Set(), sorted = [...months].sort();
    if (!sorted.length) return `${esc(k.split('|')[1] || k)}: part of a month only`;
    const gaps = [];
    for (let m = sorted[0]; m <= sorted.at(-1); m = nextMonth(m)) if (!months.has(m)) gaps.push(monthShort(m));
    return `${esc(k.split('|')[1])}: ${monthShort(sorted[0])} to ${monthShort(sorted.at(-1))}${gaps.length ? `, missing ${gaps.slice(0, 4).join(', ')}${gaps.length > 4 ? '…' : ''}` : ''}`;
  });
  // Itemised spending against the spending worked out from cash, for the latest month that has both.
  const inferred = compute(d).filter((r) => r.spending != null && monthly[r.month]);
  const pair = inferred.find((r) => r.month === to) || inferred.at(-1);
  const itemised = pair && mine.filter((r) => r.date.slice(0, 7) === pair.month && r.kind !== 'excluded').reduce((t, r) => t + netOf(r), 0);
  const card = (label, value, sub) => `<div class="class"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('spend-head').innerHTML = [
    card(`Spent in ${monthLong(to)}`, money(val(monthly, to)), v.complete(to) ? 'the kinds shown' : 'not every card or account covers this month yet'),
    card('Usual month', base == null ? '–' : money(base), 'recurring spending, 12-month average'),
    card('Travel, last 12 months', money(travel), ''),
    pair ? card(`Against cash, ${monthShort(pair.month)}`, money(itemised), `worked out from cash: ${money(pair.spending)}, a gap of ${signed(itemised - pair.spending)}`) : '',
    card('Statements cover', '', cov.length ? cov.join('<br>') : 'nothing yet: import statements to start'),
  ].join('');
}

function renderSpendChart(v) {
  const months = v.months.slice(-24), cats = allCats(v.d).filter((c) => months.some((m) => v.monthly[m] && v.monthly[m].cats[c]));
  const lighten = (hex) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + '59' : hex);
  const incomplete = months.filter((m) => !v.complete(m));
  $('spend-charttitle').textContent = 'Spending by category, month by month';
  $('spend-chartnote').textContent = (incomplete.length ? `Paler bars: months not every card or account covers yet (${incomplete.map(monthShort).join(', ')}). ` : '') + 'The line is the 12-month average of what is shown.';
  $('spend-legend').innerHTML = cats.map((c) => `<span class="legend" style="--c:var(${catVar(c)})"><span class="dot"></span>${esc(c)}</span>`).join('');
  const avg = rolling12(months, (m) => v.val(v.monthly, m), v.covered);
  const datasets = cats.map((c) => {
    const color = css(catVar(c));
    return { type: 'bar', label: c, stack: 'cats', data: months.map((m) => (v.monthly[m] && v.monthly[m].cats[c]) || 0), backgroundColor: months.map((m) => (v.complete(m) ? color : lighten(color))), borderRadius: 2, maxBarThickness: 28 };
  });
  datasets.push({ type: 'line', label: '12-month average', stack: 'avg', data: avg, borderColor: css('--ink'), backgroundColor: css('--ink'), borderWidth: 2, pointRadius: 0, tension: 0.2 });
  const grid = css('--line'), tick = css('--ink-2');
  spendChart?.destroy();
  spendChart = new Chart($('spend-chart'), {
    type: 'bar',
    data: { labels: months.map(monthShort), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: grid }, ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { stacked: true, grid: { color: grid }, border: { display: false }, ticks: { color: tick, callback: compact, maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--ink'), titleColor: css('--bg'), bodyColor: css('--bg'), footerColor: css('--bg'), padding: 10, boxPadding: 4,
          filter: (i) => i.parsed.y != null && Math.abs(i.parsed.y) >= 0.5,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: (items) => monthLong(months[items[0].dataIndex]),
            label: (i) => ` ${i.dataset.label}  ${money(i.parsed.y)}`,
            footer: (items) => 'Total  ' + money(v.val(v.monthly, months[items[0].dataIndex])),
          },
        },
      },
    },
  });
  $('spend-chart').setAttribute('aria-label', 'Spending by category for each month, with the 12-month average');
}

const spark = (vals, cssVar) => {
  const max = Math.max(...vals, 1), pts = vals.map((x, i) => `${(i * 72) / Math.max(1, vals.length - 1) + 1},${19 - (Math.max(0, x) / max) * 17}`).join(' ');
  return `<svg class="spark" width="74" height="20" viewBox="0 0 74 20" aria-hidden="true" style="color:var(${cssVar})"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
};

function renderSpendCats(v) {
  const { to, monthly } = v, prev = shiftMonth(to, -1);
  const last3 = [to, prev, shiftMonth(to, -2)], last12 = Array.from({ length: 12 }, (_, k) => shiftMonth(to, k - 11));
  const pick = (k, sub) => (x) => (x ? (sub ? x.subs[k] : x.cats[k]) || 0 : 0);
  const row = (label, k, sub, cssVar, depth) => {
    const p = pick(k, sub), now = p(monthly[to]), before = p(monthly[prev]), a3 = v.avgOver(monthly, last3, p), a12 = v.avgOver(monthly, last12, p);
    if (!now && !before && !a12) return '';
    const diff = a12 == null ? null : now - a12, cls = diff == null ? '' : diff > 0 ? 'down' : 'up';
    const name = depth ? `<button type="button" class="link" data-pick="${esc(k)}">${esc(label || 'Other')}</button>`
      : `<button type="button" class="link" data-open="${esc(k)}" aria-expanded="${spendOpen.has(k)}"><span class="dot" style="--c:var(${cssVar})"></span>${esc(label)}</button>`;
    return `<tr class="${depth ? 'sub' : ''}"><td>${name}</td><td>${money(now)}</td><td>${money(before)}</td><td>${money(a3)}</td><td>${money(a12)}</td>
      <td class="${cls}">${diff == null ? '–' : `${signed(diff)} <span class="muted">${a12 ? signedPct(diff / a12, 0) : ''}</span>`}</td><td>${spark(last12.map((m) => p(monthly[m])), cssVar)}</td></tr>`;
  };
  let html = `<tr><th>Category</th><th>${monthShort(to)}</th><th>${monthShort(prev)}</th><th>3-month avg</th><th>12-month avg</th><th>Against 12-month avg</th><th>Last 12 months</th></tr>`;
  for (const c of allCats(v.d)) {
    html += row(c, c, false, catVar(c), 0);
    if (!spendOpen.has(c)) continue;
    const subs = new Set([...subsOf(c), ...Object.keys(Object.assign({}, ...Object.values(monthly).map((x) => x.subs))).filter((k) => k.startsWith(c + '|')).map((k) => k.split('|')[1])]);
    for (const s of subs) html += row(s, c + '|' + s, true, catVar(c), 1);
    html += `<tr class="sub"><td><button type="button" class="link" data-pick="${esc(c)}">All ${esc(c.toLowerCase())}</button></td><td colspan="6"></td></tr>`;
  }
  html += `<tr class="total"><td>Total</td><td>${money(v.val(monthly, to))}</td><td>${money(v.val(monthly, prev))}</td><td>${money(v.avgOver(monthly, last3))}</td><td>${money(v.avgOver(monthly, last12))}</td><td></td><td></td></tr>`;
  $('spend-cats').innerHTML = v.rows.length ? html : '<tr><td class="muted">Nothing to show for these kinds and cards. Import statements, or turn on more kinds above.</td></tr>';
}

// Editors for one row: category, subcategory, kind, paid back, trip and note. Each change saves.
function txEditors(r, trips, cats) {
  const opt = (val, label, on) => `<option value="${esc(val)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  const subs = subsOf(r.category);
  return `<td><select data-f="category">${cats.map((c) => opt(c, c, c === r.category)).join('')}</select></td>
    <td><select data-f="subcategory">${opt('', '–', !r.subcategory)}${[...new Set([...subs, ...(r.subcategory ? [r.subcategory] : [])])].map((s) => opt(s, s, s === r.subcategory)).join('')}</select></td>
    <td><select data-f="kind">${SPEND_KINDS.map(([k, n]) => opt(k, n, k === r.kind)).join('')}</select></td>
    <td><input data-f="reimbursed" inputmode="decimal" value="${r.reimbursed ? plain(r.reimbursed, 2) : ''}" placeholder="0" aria-label="Paid back"></td>
    <td><select data-f="trip_id">${opt('', '–', !r.trip_id)}${trips.map((t) => opt(t.id, t.name, t.id === r.trip_id)).join('')}</select></td>
    <td><input data-f="note" value="${esc(r.note)}" placeholder="note" aria-label="Note"></td>`;
}

function renderSpendTxs(v) {
  const el = $('spend-txs');
  if (!spendPick) { el.innerHTML = ''; return; }
  const [cat, sub] = spendPick.split('|');
  const list = spendPick === 'unassigned'
    ? v.mine.filter((r) => v.inRange(r) && r.kind === 'travel' && !r.trip_id)
    : v.mine.filter((r) => v.inRange(r) && r.category === cat && (sub === undefined || (r.subcategory || '') === sub));
  list.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const title = spendPick === 'unassigned' ? 'Travel not in a trip' : sub === undefined ? cat : `${cat} · ${sub || 'Other'}`;
  const shown = list.slice(0, 300);
  el.innerHTML = `<div class="txhead"><h3>${esc(title)}, ${monthShort(v.from)} to ${monthShort(v.to)}: ${list.length} line${list.length === 1 ? '' : 's'}, ${money(list.reduce((t, r) => t + netOf(r), 0))}</h3>
    <button class="btn" type="button" data-closetx>Close</button></div>
    <p class="hint">Every kind is listed here, whatever the filters. A change is saved straight away and kept when you import again.</p>
    <div class="scroll"><table class="txs"><tr><th>Date</th><th class="desc">Description</th><th>Amount</th><th>Category</th><th>Subcategory</th><th>Kind</th><th>Paid back</th><th>Trip</th><th>Note</th></tr>
    ${shown.map((r) => `<tr data-id="${r.id}"><td>${dayMonth(r.date)} ${r.date.slice(2, 4)}</td><td class="desc">${esc(r.description)}<div class="muted">${esc(r.card)}${r.country && r.country !== 'SG' ? ' · ' + esc(r.country) : ''}${r.labelled_by === 'guess' ? ' · guessed' : ''}</div></td>
      <td>${sgd2(r.amount)}</td>${txEditors(r, v.d.trips, allCats(v.d))}</tr>`).join('')}</table></div>${list.length > shown.length ? `<p class="fine">Showing the latest ${shown.length}.</p>` : ''}`;
}

async function updateRows(changes) {
  try { const d = await api.updateExpenses(changes); showSpending(d); }
  catch (e) { toast(saveError(e), true); showSpending(api.data); }
}

function renderStandouts(v) {
  const rows = standouts(v.mine, v.from, v.to).filter((s) => s.row.labelled_by !== 'user');
  const prices = recurringCharges(v.mine, v.to).filter((x) => x.change && x.last.labelled_by !== 'user' && !/not a standout/i.test(x.last.note || ''));
  const last12 = Array.from({ length: 12 }, (_, k) => shiftMonth(v.to, k - 12));
  const catJumps = allCats(v.d).filter((c) => !NOT_SPENDING.test(c)).map((c) => {
    const now = (v.monthly[v.to] && v.monthly[v.to].cats[c]) || 0, avg = v.avgOver(v.monthly, last12, (x) => (x ? x.cats[c] || 0 : 0));
    return avg != null && now > 1.5 * avg && now - avg > 200 ? `${c} in ${monthShort(v.to)} is ${money(now)}, ${money(now - avg)} above its 12-month average.` : null;
  }).filter(Boolean);
  const btns = (r) => payBackId === r.id
    ? `<span class="inline">Paid back S$ <input id="spend-payback" inputmode="decimal" value="${plain(r.amount, 2)}"> <button class="btn" type="button" data-sact="payok" data-id="${r.id}">Save</button> <button class="btn" type="button" data-sact="paycancel">Cancel</button></span>`
    : tripPickId === r.id
      ? `<span class="inline"><select data-sact="tripto" data-id="${r.id}"><option value="">Choose a trip</option>${v.d.trips.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select> <button class="btn" type="button" data-sact="tripcancel">Cancel</button></span>`
      : `${v.d.trips.length ? `<button type="button" data-sact="trip" data-id="${r.id}">Trip</button>` : ''}<button type="button" data-sact="one_off" data-id="${r.id}">One-off</button><button type="button" data-sact="recurring" data-id="${r.id}">Recurring</button><button type="button" data-sact="payback" data-id="${r.id}">Paid back</button><button type="button" data-sact="dismiss" data-id="${r.id}">Not a standout</button>`;
  const item = (r, reasons) => `<li><div><b>${esc(r.description)}</b> <span class="muted">${dayMonth(r.date)} ${r.date.slice(0, 4)} · ${esc(r.category)} · ${kindName(r.kind)}</span></div>
    <div class="amt">${sgd2(r.amount)}</div><div class="why">${reasons.map(esc).join('; ')}</div><div class="acts">${btns(r)}</div></li>`;
  const list = [...rows.sort((a, b) => b.row.date.localeCompare(a.row.date)).map((s) => item(s.row, s.reasons)),
    ...prices.map((x) => item(x.last, [`Price changed from ${sgd2(x.change.from)} to ${sgd2(x.change.to)}`]))];
  $('spend-standouts').innerHTML = (catJumps.length ? `<ul class="jumps">${catJumps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '')
    + (list.length ? `<ul class="standouts">${list.join('')}</ul>` : '<p class="hint">Nothing stands out in this period.</p>');
}

async function standoutAction(b) {
  const act = b.dataset.sact, id = +b.dataset.id, r = api.data.expenses.find((x) => x.id === id);
  if (act === 'paycancel' || act === 'tripcancel') { payBackId = tripPickId = null; return showSpending(api.data); }
  if (act === 'payback') { payBackId = id; tripPickId = null; return showSpending(api.data); }
  if (act === 'trip') { tripPickId = id; payBackId = null; return showSpending(api.data); }
  if (act === 'payok') {
    const amt = +String($('spend-payback').value).replace(/[^\d.]/g, '');
    if (!(amt > 0)) return toast('Enter how much was paid back.', true);
    payBackId = null;
    return updateRows([{ id, kind: amt >= Number(r.amount) - 0.005 ? 'reimbursed' : r.kind, reimbursed: Math.min(amt, Number(r.amount)) }]);
  }
  if (act === 'dismiss') return updateRows([{ id, note: [r.note, 'not a standout'].filter(Boolean).join(' · ') }]);
  if (act === 'one_off' || act === 'recurring') return updateRows([{ id, kind: act }]);
}

function renderRecurring(v) {
  const list = recurringCharges(v.mine, v.to);
  $('spend-recurring').innerHTML = list.length
    ? `<tr><th>Merchant</th><th class="desc">Category</th><th>A month</th><th>Last charge</th><th>A year</th></tr>` + list.map((x) =>
      `<tr><td>${esc(x.merchant)}</td><td class="desc">${esc(x.last.category)}${x.last.subcategory ? ' · ' + esc(x.last.subcategory) : ''}</td><td>${sgd2(x.monthly)}</td>
      <td>${dayMonth(x.last.date)} ${x.last.date.slice(2, 4)}, ${sgd2(x.last.amount)}${x.change ? ` <span class="down">was ${sgd2(x.change.from)}</span>` : ''}</td><td>${money(x.yearly)}</td></tr>`).join('')
      + `<tr class="total"><td>Total</td><td></td><td>${sgd2(list.reduce((t, x) => t + x.monthly, 0))}</td><td></td><td>${money(list.reduce((t, x) => t + x.yearly, 0))}</td></tr>`
    : '<tr><td class="muted">None yet: this needs at least 3 of the last 4 months imported.</td></tr>';
}

function renderTravel(v) {
  const rows = v.mine.filter((r) => r.kind === 'travel' && v.inRange(r)), lines = tripTable(rows, v.d.trips).filter((l) => Math.abs(l.total) >= 0.5);
  const totals = {};
  for (const l of lines) for (const [k, x] of Object.entries(l.subs)) totals[k] = (totals[k] || 0) + x;
  const all = lines.reduce((t, l) => t + l.total, 0), n = v.months.filter(v.covered).length;
  const cells = (subs) => TRAVEL_SUBS.map((s) => `<td>${subs[s] ? money(subs[s]) : ''}</td>`).join('');
  $('spend-travel').innerHTML = lines.length
    ? `<tr><th>Trip</th>${TRAVEL_SUBS.map((s) => `<th>${esc(s)}</th>`).join('')}<th>Total</th><th>Per day</th></tr>` + lines.map((l) =>
      `<tr><td>${l.key === 'unassigned' ? `<button type="button" class="link" data-pick="unassigned">${esc(l.name)}</button>` : esc(l.name)}${l.trip && l.trip.start_date ? `<div class="muted">${longDate(l.trip.start_date)} to ${longDate(l.trip.end_date)}</div>` : ''}</td>
      ${cells(l.subs)}<td>${money(l.total)}</td><td>${l.days ? money(l.total / l.days) : ''}</td></tr>`).join('')
      + `<tr class="total"><td>${monthShort(v.from)} to ${monthShort(v.to)}</td>${cells(totals)}<td>${money(all)}</td><td></td></tr>`
      + `<tr><td class="muted">A month on average</td>${TRAVEL_SUBS.map((s) => `<td class="muted">${totals[s] && n ? money(totals[s] / n) : ''}</td>`).join('')}<td class="muted">${n ? money(all / n) : ''}</td><td></td></tr>`
    : '<tr><td class="muted">No travel in this period.</td></tr>';
  renderTripSuggestions(v);
  renderTrips(v);
}

function renderTripSuggestions(v) {
  const fresh = suggestTrips(v.all, v.d.trips), sig = fresh.map((g) => g.start + g.end).join();
  if (!tripDraft || tripDraft.sig !== sig) tripDraft = { sig, list: fresh };
  const list = tripDraft.list;
  $('spend-tripsugg').innerHTML = list.length ? `<h3>Suggested trips</h3><p class="hint">Purchases abroad grouped by date. Accept to save a trip: travel in its dates is linked to it, including flights and hotels paid from Singapore during the trip.</p>
    <table class="trips">${list.map((g, i) => `<tr><td><input data-tname="${i}" value="${esc(g.name)}" aria-label="Trip name"></td><td>${longDate(g.start)} to ${longDate(g.end)}</td><td>${g.rows.length} lines</td><td>${money(g.total)}</td>
      <td><button class="btn" type="button" data-tacc="${i}">Accept</button> ${i < list.length - 1 ? `<button class="btn" type="button" data-tmerge="${i}">Merge with next</button>` : ''} ${new Set(g.rows.map((r) => r.date)).size > 1 ? `<button class="btn" type="button" data-tsplit="${i}">Split</button>` : ''} <button class="btn" type="button" data-tdrop="${i}">Not a trip</button></td></tr>`).join('')}</table>` : '';
}

function renderTrips(v) {
  const trips = v.d.trips;
  $('spend-trips-edit').hidden = !trips.length;
  $('spend-trips').innerHTML = trips.length ? `<table class="trips">${trips.map((t) => `<tr data-trip="${t.id}"><td><input data-tf="name" value="${esc(t.name)}" aria-label="Trip name"></td>
    <td><input type="date" data-tf="start_date" value="${t.start_date || ''}" aria-label="Start"></td><td><input type="date" data-tf="end_date" value="${t.end_date || ''}" aria-label="End"></td>
    <td><button class="btn" type="button" data-tsave="${t.id}">Save</button> <button class="btn danger" type="button" data-tdel="${t.id}">Delete</button></td></tr>`).join('')}</table>` : '';
}

async function tripAction(b) {
  const list = tripDraft ? tripDraft.list : [];
  if (b.dataset.tacc != null) {
    const g = list[+b.dataset.tacc], name = ($('spend-tripsugg').querySelector(`[data-tname="${b.dataset.tacc}"]`).value || g.name).trim();
    try { const d = await api.saveTrip({ name, start_date: g.start, end_date: g.end }); tripDraft = null; toast(`Saved ${name}`); showSpending(d); } catch (e) { toast(saveError(e), true); }
    return;
  }
  if (b.dataset.tmerge != null) {
    const i = +b.dataset.tmerge, a = list[i], c = list[i + 1];
    list.splice(i, 2, { ...a, end: c.end, rows: [...a.rows, ...c.rows], total: a.total + c.total });
  } else if (b.dataset.tsplit != null) {
    const i = +b.dataset.tsplit, g = list[i], dates = [...new Set(g.rows.map((r) => r.date))].sort();
    let at = 1;
    for (let k = 1; k < dates.length; k++) if (daysBetween(dates[k - 1], dates[k]) > daysBetween(dates[at - 1], dates[at])) at = k;
    const part = (rows) => ({ ...g, start: rows[0].date, end: rows.at(-1).date, rows, total: rows.reduce((t, r) => t + netOf(r), 0) });
    list.splice(i, 1, part(g.rows.filter((r) => r.date < dates[at])), part(g.rows.filter((r) => r.date >= dates[at])));
  } else if (b.dataset.tdrop != null) list.splice(+b.dataset.tdrop, 1);
  else if (b.dataset.tsave != null) {
    const tr = b.closest('tr'), val = (f) => tr.querySelector(`[data-tf="${f}"]`).value;
    try { const d = await api.saveTrip({ id: +b.dataset.tsave, name: val('name'), start_date: val('start_date'), end_date: val('end_date') }); toast('Trip saved'); showSpending(d); } catch (e) { toast(saveError(e), true); }
    return;
  } else if (b.dataset.tdel != null) {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
    try { const d = await api.deleteTrip(+b.dataset.tdel); toast('Trip deleted'); showSpending(d); } catch (e) { toast(saveError(e), true); }
    return;
  }
  renderTripSuggestions(spendView(api.data));
}

// The review queue: merchants whose rows were guessed or are uncategorised (one item per merchant,
// so one choice can cover them all), and standouts not yet labelled.
function reviewItems(v) {
  const groups = {};
  for (const r of v.mine) {
    if (r.labelled_by === 'user' || r.kind === 'excluded' || (r.labelled_by !== 'guess' && r.category !== 'Uncategorised')) continue;
    const g = groups[r.merchant] || (groups[r.merchant] = { merchant: r.merchant, rows: [], total: 0 });
    g.rows.push(r);
    g.total += netOf(r);
  }
  const outs = standouts(v.mine, v.from, v.to).filter((s) => s.row.labelled_by !== 'user');
  return [...Object.values(groups).sort((a, b) => b.total - a.total), ...outs.map((s) => ({ standout: s }))];
}

function renderReview(v) {
  const items = reviewItems(v), groups = items.filter((x) => x.merchant), outs = items.length - groups.length;
  const opt = (val, label, on) => `<option value="${esc(val)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  $('spend-review').innerHTML = (outs ? `<p class="hint">${outs} standout${outs === 1 ? '' : 's'} above to label.</p>` : '')
    + (groups.length ? `<p class="hint">Merchants nothing recognised, guessed from the amount, or left uncategorised. Pick a category once; "Apply to all" saves a rule so future imports follow it.</p>
    <div class="scroll"><table class="review">${groups.slice(0, 40).map((g, i) => {
      const r = g.rows[0];
      return `<tr data-merchant="${esc(g.merchant)}"><td class="desc"><b>${esc(g.merchant)}</b><div class="muted">${g.rows.length} line${g.rows.length === 1 ? '' : 's'}, latest ${dayMonth(g.rows.at(-1).date)} ${g.rows.at(-1).date.slice(2, 4)} · ${esc(r.description)}</div></td><td>${money(g.total)}</td>
        <td><select data-rf="category">${allCats(v.d).map((c) => opt(c, c, c === r.category)).join('')}</select></td>
        <td><select data-rf="subcategory">${opt('', '–', !r.subcategory)}${subsOf(r.category).map((s) => opt(s, s, s === r.subcategory)).join('')}</select></td>
        <td><label class="check"><input type="checkbox" data-rf="all" checked> Apply to all from this merchant</label></td>
        <td><button class="btn" type="button" data-rsave="${i}">Save</button></td></tr>`;
    }).join('')}</table></div>${groups.length > 40 ? `<p class="fine">Showing the 40 largest of ${groups.length}.</p>` : ''}`
      : outs ? '' : '<p class="hint">Nothing to review.</p>');
}

async function reviewSave(b) {
  const tr = b.closest('tr'), merchant = tr.dataset.merchant, get = (f) => tr.querySelector(`[data-rf="${f}"]`);
  const category = get('category').value, subcategory = get('subcategory').value, kind = NOT_SPENDING.test(category) ? 'excluded' : null;
  const rows = api.data.expenses.filter((r) => r.merchant === merchant && r.labelled_by !== 'user');
  try {
    if (get('all').checked) {
      const d = await api.saveRule({ pattern: `^${escapeRe(merchant)}$`, category, subcategory, kind, priority: 100, note: 'Added from To review' });
      const d2 = await api.applyRule(d.rule_id);
      toast(`Saved a rule; ${d2.changed} line${d2.changed === 1 ? '' : 's'} changed`);
      showSpending(d2);
    } else await updateRows(rows.map((r) => ({ id: r.id, category, subcategory, ...(kind ? { kind } : {}) })));
  } catch (e) { toast(saveError(e), true); }
}

function renderImported(v) {
  const { expenses: rows, statements: stmts } = v.d;
  const dates = rows.map((r) => r.date).sort();
  $('spend-summary').textContent = rows.length ? `${rows.length.toLocaleString('en-SG')} lines, ${monthLong(dates[0].slice(0, 7))} to ${monthLong(dates.at(-1).slice(0, 7))}.` : 'Nothing imported yet.';
  const count = {};
  for (const r of rows) if (r.statement_id) count[r.statement_id] = (count[r.statement_id] || 0) + 1;
  $('spend-statements').innerHTML = stmts.length ? `<tr><th>From</th><th class="desc">Card or account</th><th>Period</th><th>Lines kept</th><th></th></tr>` + stmts.slice().reverse().map((s) =>
    `<tr><td>${SPEND_SOURCES[s.source] || esc(s.source)}</td><td class="desc">${esc(s.card)}</td><td>${longDate(s.period_start)} to ${longDate(s.period_end)}</td><td>${count[s.id] || 0}</td>
    <td><button class="btn" type="button" data-undo="${s.id}">Undo import</button></td></tr>`).join('') : '';
}

function renderRules(v) {
  const rules = v.d.expense_rules;
  $('spend-rules').innerHTML = rules.length ? `<tr><th>Priority</th><th class="desc">Pattern</th><th class="desc">Category</th><th>Kind</th><th></th></tr>` + rules.map((r) =>
    `<tr><td>${r.priority}</td><td class="desc"><code>${esc(r.pattern)}</code></td><td class="desc">${esc(r.category)}${r.subcategory ? ' · ' + esc(r.subcategory) : ''}</td><td>${r.kind ? kindName(r.kind) : 'as detected'}</td>
    <td><button class="btn" type="button" data-rdel="${r.id}">Delete</button></td></tr>`).join('') : '<tr><td class="muted">No rules of your own yet.</td></tr>';
}

function wireSpending() {
  if (spendWired) return;
  spendWired = true;
  $('spend-btn').onclick = () => $('spend-file').click();
  $('spend-file').onchange = async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (files.length) await importSpending(files);
  };
  $('spend-import').onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.spendcancel != null) { spendImport = null; renderSpendImport(); }
    else if (b.dataset.spendsave != null) await saveSpendImport();
    else if (b.dataset.usedate != null) {
      const f = spendImport.files[+b.dataset.usedate], val = $('spend-import').querySelector(`[data-sdate="${b.dataset.usedate}"]`).value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return toast('Enter the statement date.', true);
      f.stmtDate = val;
      buildSpendImport();
      renderSpendImport();
    }
  };
  $('spend-filters').onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.range) spendState.range = b.dataset.range;
    if (b.dataset.kind) spendState.kinds[b.dataset.kind] = !spendState.kinds[b.dataset.kind];
    if (b.dataset.src) spendState.off[b.dataset.src] = !spendState.off[b.dataset.src];
    saveSpendState();
    showSpending(api.data);
  };
  $('spend-filters').onchange = (ev) => {
    if (ev.target.id === 'spend-from') spendState.from = ev.target.value;
    if (ev.target.id === 'spend-to') spendState.to = ev.target.value;
    saveSpendState();
    showSpending(api.data);
  };
  $('spend-cats').onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.open) { if (spendOpen.has(b.dataset.open)) spendOpen.delete(b.dataset.open); else spendOpen.add(b.dataset.open); }
    if (b.dataset.pick) spendPick = b.dataset.pick;
    showSpending(api.data);
    if (b.dataset.pick) $('spend-txs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('spend-travel').onclick = (ev) => {
    const b = ev.target.closest('button[data-pick]');
    if (!b) return;
    spendPick = b.dataset.pick;
    showSpending(api.data);
    $('spend-txs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('spend-txs').onclick = (ev) => { if (ev.target.closest('[data-closetx]')) { spendPick = null; showSpending(api.data); } };
  $('spend-txs').onchange = (ev) => {
    const f = ev.target.dataset.f, tr = ev.target.closest('tr[data-id]');
    if (!f || !tr) return;
    let value = ev.target.value;
    const change = { id: +tr.dataset.id };
    if (f === 'reimbursed') { value = +String(value).replace(/[^\d.]/g, '') || 0; }
    if (f === 'trip_id') value = value ? +value : null;
    change[f] = value;
    if (f === 'category') change.subcategory = '';
    if (f === 'category' && NOT_SPENDING.test(value)) change.kind = 'excluded';
    updateRows([change]);
  };
  $('spend-standouts').onclick = (ev) => { const b = ev.target.closest('button[data-sact]'); if (b) standoutAction(b); };
  $('spend-standouts').onchange = async (ev) => {
    const s = ev.target.closest('select[data-sact="tripto"]');
    if (!s || !s.value) return;
    const t = api.data.trips.find((x) => x.id === +s.value);
    tripPickId = null;
    try { const d = await api.saveTrip({ id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date, note: t.note, expense_ids: [+s.dataset.id] }); toast(`Moved to ${t.name}`); showSpending(d); }
    catch (e) { toast(saveError(e), true); }
  };
  $('spend-tripsugg').onclick = (ev) => { const b = ev.target.closest('button'); if (b) tripAction(b); };
  $('spend-trips').onclick = (ev) => { const b = ev.target.closest('button'); if (b) tripAction(b); };
  $('spend-review').onclick = (ev) => { const b = ev.target.closest('button[data-rsave]'); if (b) reviewSave(b); };
  $('spend-review').onchange = (ev) => {
    if (ev.target.dataset.rf !== 'category') return;
    const sub = ev.target.closest('tr').querySelector('[data-rf="subcategory"]');
    sub.innerHTML = '<option value="">–</option>' + subsOf(ev.target.value).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  };
  $('spend-statements').onclick = async (ev) => {
    const b = ev.target.closest('button[data-undo]');
    if (!b) return;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to remove its lines'; return; }
    try { const d = await api.deleteExpenses({ statement_id: +b.dataset.undo }); toast(`Removed ${d.deleted} line${d.deleted === 1 ? '' : 's'}`); showSpending(d); } catch (e) { toast(saveError(e), true); }
  };
  $('spend-rules').onclick = async (ev) => {
    const b = ev.target.closest('button[data-rdel]');
    if (!b) return;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
    try { const d = await api.deleteRule(+b.dataset.rdel); toast('Rule deleted; lines keep their category until a rule changes them'); showSpending(d); } catch (e) { toast(saveError(e), true); }
  };
}

// Self-tests on made-up data, in the exact layouts the importers read; console only.
(function checkSpending() {
  const fails = [], ok = (c, label) => { if (!c) fails.push(label); };
  ok(merchantKey('Grab* A-9LKN8B9WX4LNAV') === 'GRAB', 'merchant key drops booking codes');
  ok(merchantKey('BUS/MRT 000000000') === 'BUS/MRT' && merchantKey('TEST CAFE\nRef No: 12345678901') === 'TEST CAFE', 'merchant key drops numbers and Ref No');
  ok(bankMerchant('PAYNOW EXTERNAL TRANSFER MBKFT00000000D00 TEST PERSON OTHR-OTHER') === 'TEST PERSON', 'bank payee');
  ok(splitCountry(['SAN FRANCISCOUS']).country === 'US' && splitCountry(['Singapore', 'SG']).country === 'SG' && splitCountry(['SINGAPORE', 'SGP']).country === 'SG'
    && splitCountry(['Johor BMY']).country === 'MY' && splitCountry(['SGD']).country === null, 'country codes');
  const cat = (o) => categorise({ source: 'citi_card', description: o.merchant, country: 'SG', ...o }, o.rules);
  ok(cat({ merchant: 'GRAB', amount: 12 }).subcategory === 'Ride-hailing' && cat({ merchant: 'GRAB', amount: 12, country: 'JP' }).subcategory === 'Local transport', 'ride-hailing at home and abroad');
  ok(cat({ merchant: 'TEST BISTRO', amount: 40 }).subcategory === 'Casual restaurants (S$25–80)' && cat({ merchant: 'TEST BISTRO', amount: 40 }).labelled_by === 'guess', 'dining guessed by amount');
  ok(cat({ merchant: 'TEST BISTRO', amount: 400 }).category === 'Uncategorised', 'large unknown is uncategorised');
  ok(cat({ merchant: 'TEST BISTRO', amount: 40, rules: [{ pattern: '^TEST BISTRO$', category: 'Groceries', subcategory: '' }] }).category === 'Groceries', 'user rule first');
  ok(cat({ merchant: 'APPLE.COM/BILL', amount: 4, country: 'IE' }).category === 'Bills', 'subscriptions abroad stay bills');

  const L = (...cells) => ({ cells, text: cells.join(' ') });
  const card = readCitiCard([
    L('Statement Date January 15, 2026'),
    L('CITI REWARDS WORLD MASTERCARD 0000 0000 0000 0000 Payment Due Date: February 09, 2026'),
    L('PREVIOUS PAYMENTS PURCHASES INTEREST FEES CURRENT'),
    L('10.00 15.00 80.00 0.00 0.29 75.29'),
    L('TRANSACTIONS FOR CITI REWARDS WORLD MASTERCARD'),
    L('BALANCE PREVIOUS STATEMENT', '10.00'),
    L('03 JAN', 'PAYMENT - ATM/INTERNET', '(10.00)'),
    L('SUB-TOTAL:', '(10.00)'),
    L('28 DEC', 'TEST CAFE', 'TOKYO', 'JP', '30.00'),
    L('FOREIGN AMOUNT JAPANESE YEN 3,200.00'),
    L('XXXX-XXXX-XXXX-0000'),
    L('29 DEC', 'CCY CONVERSION FEE', 'SGD', '30.00', '0.29'),
    L('05 JAN', 'Grab* A-0TESTCODE0AV', 'Singapore', 'SG', '50.00', '4'),
    L('06 JAN', 'TEST SHOP', 'SAN FRANCISCOUS', '(5.00)'),
    L('GRAND TOTAL', '75.29'),
  ]);
  const c0 = card.cards[0], rows = c0 ? datedRows(c0, card.stmtDate) : [];
  ok(card.stmtDate === '2026-01-15' && c0 && c0.card === 'Citi Rewards' && rows.length === 4 && c0.payments === 1, 'card statement read');
  ok(rows[0] && rows[0].date === '2025-12-28' && rows[0].country === 'JP' && rows[0].fx_currency === 'JPY' && rows[0].fx_amount === 3200, 'December line dated the year before, with its foreign leg');
  ok(rows[1] && rows[1].amount === 0.29 && rows[2] && rows[2].merchant === 'GRAB' && rows[2].amount === 50 && rows[3] && rows[3].amount === -5 && rows[3].country === 'US', 'fee, margin noise and refund');
  ok(c0 && reconcileCard(c0).ok === true, 'card adds up');
  ok(!JSON.stringify(rows).includes('0000 0000'), 'no card number kept');

  const uob = readUob([['Account Number:', '0000'], ['Account Type:', 'TEST CARD'], ['Statement Date:', '01 Jan 2026 To 31 Jan 2026'], [],
    ['Transaction Date', 'Posting Date', 'Description', 'Foreign Currency Type', 'Transaction Amount(Foreign)', 'Local Currency Type', 'Transaction Amount(Local)'],
    ['20 Jan 2026', '', 'TEST MART - MALL    SINGAPORE     SGP', '', '', 'SGD', 12.5],
    ['18 Jan 2026', '19 Jan 2026', 'TEST VILLA           TEST TOWN - AREAID\nRef No: 00000000000', 'IDR', '100,000', 'SGD', 8.6],
    ['16 Jan 2026', '16 Jan 2026', 'PAYMT THRU E-BANK/HOMEB/CYBERB (EP00)', '', '', 'SGD', -50],
    ['', '', 'Previous Balance', '', '', 'SGD', 50]]);
  ok(uob.card === 'UOB Test' && uob.rows.length === 2 && uob.payments === 1 && uob.start === '2026-01-01', 'UOB export read');
  ok(uob.rows[0] && uob.rows[0].merchant === 'TEST MART - MALL' && uob.rows[0].country === 'SG' && uob.rows[0].posted === null, 'UOB pending line');
  ok(uob.rows[1] && uob.rows[1].merchant === 'TEST VILLA' && uob.rows[1].country === 'ID' && uob.rows[1].fx_amount === 100000 && !/Ref No/i.test(uob.rows[1].description), 'UOB foreign line without Ref No');

  let id = 0;
  const x = (date, merchant, amount, o = {}) => ({ id: ++id, date, merchant, description: merchant, amount, reimbursed: 0, kind: 'recurring', category: 'Dining', subcategory: '', source: 'manual', card: '', note: '', labelled_by: 'rule', ...o });
  const data = [
    x('2026-01-05', 'TEST STREAM', 15.99, { category: 'Bills' }), x('2026-02-05', 'TEST STREAM', 15.99, { category: 'Bills' }),
    x('2026-03-05', 'TEST STREAM', 15.99, { category: 'Bills' }), x('2026-04-05', 'TEST STREAM', 17.99, { category: 'Bills' }),
    x('2026-01-10', 'TEST CAFE', 10), x('2026-02-10', 'TEST CAFE', 20, { reimbursed: 5 }), x('2026-04-20', 'TEST TV', 1200, { category: 'Shopping' }),
    x('2026-03-01', 'TEST RAMEN', 30, { kind: 'travel', category: 'Travel', subcategory: 'Food and drink', country: 'JP' }),
    x('2026-03-03', 'TEST TAXI', 20, { kind: 'travel', category: 'Travel', subcategory: 'Local transport', country: 'JP' }),
    x('2026-03-20', 'TEST TAXI', 10, { kind: 'travel', category: 'Travel', subcategory: 'Local transport', country: 'JP' }),
  ];
  const mo = spendMonthly(data);
  ok(Math.abs(mo['2026-02'].total - 30.99) < 1e-9 && mo['2026-03'].cats.Travel === 60, 'monthly totals net of paid back');
  const avg = rolling12(['2026-03'], (m) => (mo[m] ? mo[m].total : 0), (m) => m >= '2026-01');
  ok(Math.abs(avg[0] - (25.99 + 30.99 + 75.99) / 3) < 1e-9, 'rolling average divides by months covered');
  const rec = recurringCharges(data, '2026-04');
  ok(rec.length === 1 && rec[0].merchant === 'TEST STREAM' && rec[0].change && rec[0].change.to === 17.99, 'recurring charge and price change');
  ok(standouts(data, '2026-04', '2026-04').some((s) => s.row.merchant === 'TEST TV'), 'big purchase stands out');
  const trips = suggestTrips(data, []);
  ok(trips.length === 2 && trips[0].start === '2026-03-01' && trips[0].end === '2026-03-03' && /Japan, Mar 2026/.test(trips[0].name), 'trips suggested by gaps');
  const tt = tripTable(data.filter((r) => r.kind === 'travel'), [{ id: 1, name: 'T', start_date: '2026-03-01', end_date: '2026-03-03' }].map((t) => t)).find((l) => l.key === 'unassigned');
  ok(tt && tt.total === 60, 'travel outside a trip is unassigned');
  if (fails.length) console.warn('Spending self-check failed: ' + fails.join('; '));
})();

// ---------- tabs and start-up ----------
const TABS = { overview: showOverview, activity: showActivity, spending: showSpending, home: showHome, update: showUpdate };
let stale = { overview: true, activity: true, spending: true, home: true, update: true };
function showTab(name) {
  for (const t of Object.keys(TABS)) {
    $('page-' + t).hidden = t !== name;
    const b = $('tab-' + t);
    if (t === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  try { history.replaceState(null, '', '#' + name); } catch {}
  if (api.data && stale[name]) { stale[name] = false; TABS[name](api.data); }
}
const currentTab = () => Object.keys(TABS).find((t) => !$('page-' + t).hidden) || 'overview';
function paint() {
  stale = { overview: true, activity: true, spending: true, home: true, update: true };
  showTab(currentTab());
  if (api.data && currentTab() !== 'spending') setSpendBadge(api.data, Array.isArray(api.data.expenses) ? spendView(api.data) : null);
}
// A save on one tab changes what the others show.
// Activity and Update redraw themselves after their own saves; the Overview never saves, so it's
// redrawn here if it's the tab on screen.
const wrap = (name) => { const f = api[name].bind(api); api[name] = async (...a) => {
  const d = await f(...a);
  for (const t in stale) stale[t] = true;
  if (name === 'saveMonth') state.month = a[0].month;
  const on = currentTab();
  if (on === 'overview') { stale.overview = false; showOverview(d); } else stale[on] = false;
  noteFresh();
  return d;
}; };
['saveMonth', 'deleteMonth', 'saveItem', 'saveMovements', 'deleteMovement', 'setupHoldings', 'saveOwed', 'deleteOwed', 'applyMovements',
  'saveCommitment', 'payCommitment', 'deleteCommitment', 'saveLoan', 'deleteLoan',
  'saveExpenses', 'updateExpenses', 'deleteExpenses', 'saveTrip', 'deleteTrip', 'saveRule', 'deleteRule', 'applyRule'].forEach(wrap);
function noteFresh() { const m = api.data && api.data.months.at(-1); $('sync').textContent = m && m.updated_by && m.updated_by !== 'dashboard' ? 'Last saved by ' + memberName(m.updated_by) + (m.updated_at ? ', ' + clock(m.updated_at) : '') : ''; }



async function refresh() {
  setStatus(api.data ? '' : 'Loading your figures…');
  try { await api.load(); }
  catch (e) {
    api.online = false;
    setStatus('<b>' + esc(explain(e)) + '</b>' + (api.data ? ' Saving is off until it answers.' : ''), true, 'Try again', refresh);
    if (api.data) safePaint();
    return;
  }
  setStatus(''); noteFresh(); safePaint();
  if (saxoBack) finishSaxo();
}
function safePaint() {
  try { paint(); } catch (e) { setStatus('<b>Part of the page could not be drawn.</b> ' + esc(e && e.message), true, 'Try again', refresh); }
}

// ---------- signing in ----------
function showSignedOut() {
  $('app').hidden = true; $('signin').hidden = false; $('who').hidden = true; $('tabs').hidden = true; $('sync').textContent = ''; setStatus('');
  $('passkeyblock').hidden = !passkeysSupported;
}
async function showSignedIn(session) {
  $('signin').hidden = true; $('app').hidden = false; $('who').hidden = false; $('tabs').hidden = false;
  $('password').value = ''; $('signinmsg').textContent = '';
  $('whoemail').textContent = session.user.email;
  $('addpasskey').hidden = !passkeysSupported;
  if (!api.data) refresh();
}

// Passkeys are tied to the site's domain (set under Authentication, Passkeys in Supabase), so
// they work on the live site but not on a local preview; the password works everywhere.
const passkeysSupported = !!window.PublicKeyCredential;
function explainPasskey(error) {
  const code = String(error.code || ''), msg = String(error.message || '');
  if (code === 'ERROR_CEREMONY_ABORTED') return '';
  if (/passkey_disabled|not enabled/i.test(code + ' ' + msg)) return 'Passkeys are not turned on in Supabase yet. Use your password for now.';
  if (/ERROR_INVALID_(DOMAIN|RP_ID)|origin|rp.?id/i.test(code + ' ' + msg)) return `Passkeys are not set up for ${location.host}. Use your password here.`;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a passkey for this site.';
  if (code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' || error.cause?.name === 'NotAllowedError') return null;
  return `Supabase said: ${msg}`;
}
$('usepasskey').onclick = async () => {
  $('usepasskey').disabled = true; $('signinmsg').textContent = '';
  const { error } = await sb.auth.signInWithPasskey();
  $('usepasskey').disabled = false;
  if (!error) return;
  const text = explainPasskey(error);
  $('signinmsg').textContent = text ?? 'No passkey was used. If this device has none yet, sign in with your password, then choose Add passkey at the top.';
};
$('addpasskey').onclick = async () => {
  $('addpasskey').disabled = true;
  const { error } = await sb.auth.registerPasskey();
  $('addpasskey').disabled = false;
  if (!error) return toast('Passkey added. Next time, choose Sign in with a passkey.');
  const text = explainPasskey(error);
  if (text !== '') toast(text ?? 'No passkey was added. Try again and confirm the prompt.', true);
};
$('signinform').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('email').value.trim().toLowerCase(), password = $('password').value;
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) return ($('signinmsg').textContent = 'Enter your email address and password.');
  $('signinbtn').disabled = true; $('signinmsg').textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $('signinbtn').disabled = false;
  if (!error) return;
  $('signinmsg').textContent = /invalid login credentials/i.test(error.message) ? 'That email and password do not match. Check both and try again.'
    : /not confirmed/i.test(error.message) ? `${email} is not confirmed in Supabase yet. Confirm it under Authentication, Users.`
    : /rate|seconds|too many/i.test(error.message) ? 'Too many attempts. Wait a few minutes and try again.'
    : `Supabase said: ${error.message}`;
});
$('signout').onclick = async () => { await sb.auth.signOut(); api.data = null; location.hash = ''; showSignedOut(); };

(async function start() {
  for (const t of Object.keys(TABS)) $('tab-' + t).onclick = () => showTab(t);
  const q = new URLSearchParams(location.search);
  if (q.has('state') && (q.has('code') || q.has('error'))) {
    saxoBack = { code: q.get('code'), state: q.get('state'), error: q.get('error_description') || q.get('error') };
    history.replaceState(null, '', location.pathname + '#update');
  }
  showTab(TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');
  sb.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) showSignedIn(session);
    if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) showSignedOut();
  });
})();
