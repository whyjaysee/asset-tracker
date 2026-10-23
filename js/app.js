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

function toast(text, isError) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = text;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 2600);
}


// ---------- data: Supabase, signed in as a household member ----------
const sb = window.supabase.createClient(window.NW_CONFIG.supabaseUrl, window.NW_CONFIG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'implicit' } });
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

function renderHoldings() {
  const r = selected();
  $('holdtitle').textContent = `What you held in ${monthLong(r.month)}`;
  const order = Object.fromEntries(CATS.map((c, i) => [c.id, i]));
  const lines = r.lines.filter((l) => Math.abs(l.value) > 0.5).sort((a, b) => order[a.item.category] - order[b.item.category] || b.value - a.value);
  $('holdings').innerHTML = '<tr><th>Holding</th><th>Units</th><th>Price</th><th>Value</th><th>Share</th></tr>' + lines.map((l) => {
    const h = l.item.kind === 'holding';
    const native = l.item.currency === 'USD' && !h ? ` <span class="muted">US$${plain(l.amount, 0)}</span>` : '';
    return `<tr><td><span class="dot" style="--c:var(--${l.item.category})"></span>${esc(l.item.name)}${native}</td>
      <td>${h ? plain(l.amount, 4) : ''}</td><td>${h ? 'US$' + plain(l.price, 2) : ''}</td>
      <td>${money(l.value)}</td><td class="muted">${pct(l.value / r.net)}</td></tr>`;
  }).join('') + `<tr><td class="muted" colspan="5" style="border:0">US$ converted at S$1 = US$${r.fx}</td></tr>`;
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

function renderMonth() { renderHeadline(); renderHoldings(); renderFlow(); }
function renderControls() {
  seg($('views'), VIEWS, state.view, (v) => { state.view = v; prefs.set('view', v); renderControls(); buildChart(); });
  seg($('ranges'), RANGES, state.range, (v) => { state.range = v; prefs.set('range', v); renderControls(); buildChart(); });
}

let overviewWired = false;
function showOverview(d) {
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

let data = null, draft = null, base = null, exists = false, dirty = false, tracked = new Set();

const parse = (s) => { const v = parseFloat(String(s).replace(/[, ]/g, '')); return isNaN(v) ? null : v; };
const sym = (cur) => (cur === 'USD' ? 'US$' : 'S$');

function startDraft(month) {
  const found = data.months.find((m) => m.month === month);
  base = [...data.months].reverse().find((m) => m.month < month) || null;
  exists = !!found; dirty = false;
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
    const u = it.kind === 'holding' ? unitsAt(data, it.id, monthEnd(draft.month)) : null;
    if (u == null) continue;
    tracked.add(it.id);
    const e = draft.entries[it.id] || (draft.entries[it.id] = [null, null]);
    if (exists && e[0] !== u) differs.push(it.name);
    e[0] = u;
  }
  return differs;
}

function field(key, value, prefix, label, cls = '') {
  return `<div class="field ${cls}"><span>${prefix}</span><input inputmode="decimal" data-key="${key}" value="${value == null ? '' : plain(value)}" aria-label="${esc(label)}"></div>`;
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
        const price = row(`${dot}${esc(it.name)} price`, field(`e.${it.id}.1`, e[1], sym(it.currency), `${it.name} price`, 'span2'), b ? 'was ' + plain(b[1], 2) : '');
        (it.monthly ? now : carried).push(price);
        if (tracked.has(it.id)) {
          carried.push(row(`${dot}${esc(it.name)} units held`, `<div class="field quiet span2"><input value="${plain(e[0])}" readonly aria-label="${esc(it.name)} units held, from Activity"></div>`, 'from Activity'));
        } else {
          carried.push(row(`${dot}${esc(it.name)} units held`, field(`e.${it.id}.0`, e[0], '', `${it.name} units held`, 'span2'), b ? 'was ' + plain(b[0]) : ''));
          names.push(`${it.name} units`);
        }
      } else {
        const r = row(`${dot}${esc(it.name)}`, field(`e.${it.id}.0`, e[0], sym(it.currency), it.name, 'span2'), b ? 'was ' + plain(b[0], 0) : '');
        (it.monthly ? now : carried).push(r);
        if (!it.monthly) names.push(it.name);
      }
    }
    if (now.length) h += `<fieldset><legend><span class="step">${++step}</span>${esc(g.name)} <span class="sum" data-sum="${esc(g.name)}"></span></legend>${now.join('')}</fieldset>`;
  }
  carried.push(row('S$1 buys', field('m.fx', draft.fx, 'US$', 'US dollars per Singapore dollar', 'span2'), base ? 'was ' + base.fx : ''));
  carried.push(row('Salary', field('m.salary', draft.salary, 'S$', 'Salary', 'span2'), base ? 'was ' + plain(base.salary, 0) : ''));
  names.push('exchange rate', 'salary');
  h += `<details class="carried" ${base ? '' : 'open'}>
    <summary>Carried over${base ? ' from ' + monthName(base.month) : ''} <span class="sum">${esc(names.join(', '))}</span></summary>
    <p class="hint">These keep last month's value until you change them.</p>
    ${carried.join('')}
    <h3>Only when it happens</h3>
    ${row('Bonus', field('m.bonus', draft.bonus || null, 'S$', 'Bonus', 'span2'))}
    ${row('Added to stocks', field('m.stock_added', draft.stock_added || null, 'US$', 'New money into stocks', 'span2'))}
    ${row('Added to crypto', field('m.crypto_added', draft.crypto_added || null, 'US$', 'New money into crypto', 'span2'))}
    ${row('One-off in (+) or out (−)', field('m.other_flow', draft.other_flow || null, 'S$', 'One-off amount', 'span2'))}
    ${row('What it was', `<div class="field text span2"><input data-key="note" value="${esc(draft.note)}" placeholder="e.g. house payment, gift" aria-label="Note"></div>`)}
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
      <td>${units}</td><td>${amount}</td><td class="note">${esc(v.note)}</td><td><button type="button" data-del="${v.id}">Delete</button></td></tr>`;
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
  }
  renderActivity(d);
}

async function addMovement(ev) {
  ev.preventDefault();
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

// ---------- tabs and start-up ----------
const TABS = { overview: showOverview, activity: showActivity, update: showUpdate };
let stale = { overview: true, activity: true, update: true };
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
function paint() { stale = { overview: true, activity: true, update: true }; showTab(currentTab()); }
// A save on one tab changes what the others show.
const wrap = (name) => { const f = api[name].bind(api); api[name] = async (...a) => { const d = await f(...a); for (const t in stale) stale[t] = true; stale[currentTab()] = false; if (name === 'saveMonth') state.month = a[0].month; noteFresh(); return d; }; };
['saveMonth', 'deleteMonth', 'saveItem', 'saveMovements', 'deleteMovement', 'setupHoldings'].forEach(wrap);
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
  showTab(TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');
  sb.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) showSignedIn(session);
    if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) showSignedOut();
  });
})();
