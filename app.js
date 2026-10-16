import { FIDELITY, ROTH_LIMIT, DEFAULT_STRATEGY, DEFAULT_SIM, DEFAULT_PLAN, DEFAULT_PROJECTION } from './config.js';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n, d = 2) => n == null || !isFinite(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n, d = 1) => n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%`;
const tone = n => n == null ? '' : n >= 0 ? 'up' : 'down';
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const store = {
  get(k, d) { try { const v = localStorage.getItem('roth:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('roth:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const fidLinks = s => `<span class="row-links"><a href="${FIDELITY.quote(s)}" target="_blank" rel="noopener">Quote</a><a class="trade" href="${FIDELITY.tradeSymbol(s)}" target="_blank" rel="noopener">Trade ↗</a></span>`;

// ---------- state ----------
const S = {
  strategy: { ...DEFAULT_STRATEGY, ...store.get('strategy', {}) },
  sim: { ...DEFAULT_SIM, ...store.get('sim', {}) },
  plan: { ...DEFAULT_PLAN, ...store.get('plan', {}) },
  proj: { ...DEFAULT_PROJECTION, ...store.get('proj', {}) },
  finnhubKey: store.get('finnhubKey', ''),
  selected: null,
  live: false,
};
let MARKET = null;
let AN = {};
let SIM = null;
const charts = {};

// ---------- indicators ----------
function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function rsi(a, n = 14) {
  const out = new Array(a.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i < n) continue; g /= n; l /= n; }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

const ret = (a, i, n) => i >= n ? a[i] / a[i - n] - 1 : null;

// Runs the alert state machine over one symbol's history.
function analyze(d, p) {
  const c = d.adj, n = c.length;
  const f = sma(c, p.fast), s = sma(c, p.slow), t = sma(c, p.trend), r = rsi(c);
  const inPos = new Array(n).fill(false), peak = new Array(n).fill(null), mom = new Array(n).fill(0);
  const events = [];
  let holding = false, pk = 0;
  for (let i = 1; i < n; i++) {
    const r21 = ret(c, i, 21), r63 = ret(c, i, 63), r126 = ret(c, i, 126);
    mom[i] = 0.2 * (r21 ?? 0) + 0.4 * (r63 ?? 0) + 0.4 * (r126 ?? 0);
    if (t[i] == null || s[i - 1] == null || f[i - 1] == null) continue;
    if (!holding) {
      const cross = f[i] > s[i] && f[i - 1] <= s[i - 1];
      let prevHigh = null;
      if (i >= p.breakout) { prevHigh = -Infinity; for (let j = i - p.breakout; j < i; j++) prevHigh = Math.max(prevHigh, c[j]); }
      const breakout = prevHigh != null && c[i] > prevHigh && f[i] > s[i];
      if ((cross || breakout) && c[i] > t[i] && r[i] < p.rsiMax) {
        holding = true; pk = c[i];
        events.push({ i, type: 'BUY', price: c[i], reason: cross ? `${p.fast}/${p.slow}-day MA crossover` : `New ${p.breakout}-day high` });
      }
    } else {
      pk = Math.max(pk, c[i]);
      let reason = null;
      if (c[i] <= pk * (1 - p.trailStop / 100)) reason = `${p.trailStop}% trailing stop hit`;
      else if (c[i] < t[i]) reason = `Closed below ${p.trend}-day MA`;
      else if (f[i] < s[i] && f[i - 1] >= s[i - 1]) reason = `${p.fast}/${p.slow}-day MA crossed down`;
      if (reason) { holding = false; events.push({ i, type: 'SELL', price: c[i], reason }); }
    }
    inPos[i] = holding;
    peak[i] = holding ? pk : null;
  }
  const L = n - 1;
  const status = inPos[L] ? 'HOLD' : (c[L] > t[L] && f[L] > s[L]) ? 'WATCH' : 'AVOID';
  return { f, s, t, r, inPos, peak, mom, events, status, last: events[events.length - 1] };
}

function analyzeAll() {
  AN = {};
  for (const [sym, d] of Object.entries(MARKET.symbols)) AN[sym] = analyze(d, S.strategy);
}

// ---------- simulator ----------
function defaultStart() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function simulate() {
  const p = S.sim;
  const B = MARKET.symbols[MARKET.benchmark];
  const dates = B.dates;
  const minStart = dates[Math.min(dates.length - 2, S.strategy.trend + S.strategy.breakout)];
  const start = (p.startDate || defaultStart()) < minStart ? minStart : (p.startDate || defaultStart());
  const k0 = Math.max(0, dates.findIndex(d => d >= start));
  const syms = Object.keys(AN);
  const idx = {};
  for (const s of syms) { const m = new Map(); MARKET.symbols[s].dates.forEach((d, i) => m.set(d, i)); idx[s] = m; }
  const priceAt = (s, d) => { const i = idx[s].get(d); return i == null ? null : MARKET.symbols[s].adj[i]; };
  const momAt = (s, d) => { const i = idx[s].get(d); return i == null ? -Infinity : AN[s].mom[i]; };
  // Is the symbol in an active BUY alert as of the close we're allowed to act on?
  const activeAt = (s, d) => { const i = idx[s].get(d); const j = i == null ? -1 : i - (p.execNextDay ? 1 : 0); return j >= 0 && AN[s].inPos[j]; };

  // Schedule each alert on the day it gets filled.
  const sched = new Map(), pending = [];
  for (const s of syms) {
    const sd = MARKET.symbols[s].dates;
    for (const e of AN[s].events) {
      const ei = e.i + (p.execNextDay ? 1 : 0);
      const ev = { ...e, sym: s, signalDate: sd[e.i] };
      if (ei >= sd.length) { pending.push(ev); continue; }
      if (sd[ei] < dates[k0]) continue;
      if (!sched.has(sd[ei])) sched.set(sd[ei], []);
      sched.get(sd[ei]).push(ev);
    }
  }
  const initial = p.enterExisting ? syms.filter(s => { const i = idx[s].get(dates[k0]); return i > 0 && AN[s].inPos[i - 1]; }) : [];

  const pos = {}, trades = [], skipped = [], labels = [], equity = [], bench = [];
  let cash = +p.capital;
  const buyInto = (list, d) => {
    const seen = new Set();
    list = list.filter(b => !pos[b.sym] && !seen.has(b.sym) && seen.add(b.sym));
    list.sort((a, b) => momAt(b.sym, d) - momAt(a.sym, d));
    for (const b of list) {
      const free = p.maxPositions - Object.keys(pos).length;
      const px = priceAt(b.sym, d);
      if (free <= 0 || !px) { skipped.push({ ...b, date: d }); continue; }
      const amt = cash / free;
      const sh = p.fractional ? Math.floor(amt / px * 1000) / 1000 : Math.floor(amt / px);
      if (sh <= 0) { skipped.push({ ...b, date: d }); continue; }
      cash -= sh * px;
      pos[b.sym] = { shares: sh, entryPrice: px, entryDate: d, reason: b.reason, last: px };
    }
  };

  for (let k = k0; k < dates.length; k++) {
    const d = dates[k], evs = sched.get(d) || [];
    for (const e of evs) {
      if (e.type !== 'SELL' || !pos[e.sym]) continue;
      const h = pos[e.sym], px = priceAt(e.sym, d) ?? h.last;
      cash += h.shares * px;
      trades.push({ sym: e.sym, entryDate: h.entryDate, entryPrice: h.entryPrice, exitDate: d, exitPrice: px, shares: h.shares, ret: px / h.entryPrice - 1, pnl: (px - h.entryPrice) * h.shares, reason: e.reason });
      delete pos[e.sym];
    }
    let buys = evs.filter(e => e.type === 'BUY').map(e => ({ sym: e.sym, reason: e.reason }));
    if (k === k0) buys = initial.map(s => ({ sym: s, reason: 'Already in a BUY alert at start' })).concat(buys);
    buyInto(buys, d);
    if (p.refill && Object.keys(pos).length < p.maxPositions)
      buyInto(syms.filter(s => !pos[s] && activeAt(s, d)).map(s => ({ sym: s, reason: 'Active BUY alert, refilling an open slot' })), d);
    let eq = cash;
    for (const s in pos) { const px = priceAt(s, d); if (px) pos[s].last = px; eq += pos[s].shares * pos[s].last; }
    labels.push(d); equity.push(eq); bench.push(p.capital * B.adj[k] / B.adj[k0]);
  }

  // What following the alerts means at the next session.
  const lastDay = dates[dates.length - 1];
  const actions = [];
  if (p.execNextDay) {
    const sells = pending.filter(e => e.type === 'SELL' && pos[e.sym]);
    let cashAfter = cash + sells.reduce((a, e) => a + pos[e.sym].shares * pos[e.sym].last, 0);
    let held = Object.keys(pos).length - sells.length;
    sells.forEach(e => actions.push({ type: 'SELL', sym: e.sym, reason: e.reason, signalDate: e.signalDate, shares: pos[e.sym].shares, value: pos[e.sym].shares * pos[e.sym].last }));
    pending.filter(e => e.type === 'BUY' && !pos[e.sym])
      .sort((a, b) => momAt(b.sym, lastDay) - momAt(a.sym, lastDay))
      .forEach(e => {
        const free = p.maxPositions - held;
        if (free <= 0) { actions.push({ type: 'SKIP', sym: e.sym, reason: `${e.reason}, but all ${p.maxPositions} slots are full`, signalDate: e.signalDate }); return; }
        const amt = cashAfter / free;
        actions.push({ type: 'BUY', sym: e.sym, reason: e.reason, signalDate: e.signalDate, value: amt, price: MARKET.symbols[e.sym].price });
        cashAfter -= amt; held++;
      });
    if (p.refill) {
      const L = s => AN[s].inPos.length - 1;
      const taken = new Set([...Object.keys(pos), ...actions.map(a => a.sym)]);
      syms.filter(s => !taken.has(s) && AN[s].inPos[L(s)])
        .sort((a, b) => momAt(b, lastDay) - momAt(a, lastDay))
        .forEach(s => {
          const free = p.maxPositions - held;
          if (free <= 0) return;
          const amt = cashAfter / free;
          actions.push({ type: 'BUY', sym: s, reason: 'Active BUY alert, refilling an open slot', signalDate: MARKET.symbols[s].dates[AN[s].events.at(-1).i], value: amt, price: MARKET.symbols[s].price });
          cashAfter -= amt; held++;
        });
    }
  } else {
    for (const t of trades.filter(t => t.exitDate === lastDay)) actions.push({ type: 'SELL', sym: t.sym, reason: t.reason, signalDate: lastDay, shares: t.shares, value: t.shares * t.exitPrice });
    for (const [s, h] of Object.entries(pos)) if (h.entryDate === lastDay) actions.push({ type: 'BUY', sym: s, reason: h.reason, signalDate: lastDay, value: h.shares * h.entryPrice, price: h.entryPrice });
  }

  let peakEq = -Infinity, maxDD = 0;
  for (const v of equity) { peakEq = Math.max(peakEq, v); maxDD = Math.min(maxDD, v / peakEq - 1); }
  const final = equity[equity.length - 1];
  const years = (new Date(lastDay) - new Date(dates[k0])) / (365.25 * 864e5);
  return {
    start: dates[k0], minStart, labels, equity, bench, trades, skipped, pos, cash, actions, maxDD,
    final, totalRet: final / p.capital - 1, benchRet: bench[bench.length - 1] / p.capital - 1,
    cagr: years > 0.25 ? (final / p.capital) ** (1 / years) - 1 : null, years,
  };
}

// ---------- rendering ----------
function renderStatus() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const mins = (+parts.hour % 24) * 60 + +parts.minute;
  const open = !['Sat', 'Sun'].includes(parts.weekday) && mins >= 570 && mins < 960;
  const el = $('#mkt-status');
  el.textContent = open ? '● Market open' : 'Market closed';
  el.className = 'pill ' + (open ? 'open' : 'closed');
  const upd = new Date(MARKET.updated);
  $('#updated').textContent = `Data ${S.live ? 'live via Finnhub · ' : ''}updated ${upd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  return open;
}

function dayChange(d) { return d.prevClose ? d.price / d.prevClose - 1 : null; }

function renderTape() {
  const order = [MARKET.benchmark, ...Object.keys(MARKET.symbols).filter(s => s !== MARKET.benchmark)];
  $('#tape').innerHTML = order.map(s => {
    const d = MARKET.symbols[s], ch = dayChange(d);
    return `<span><b>${esc(s)}</b>${usd(d.price)} <span class="${tone(ch)}">${pct(ch, 2)}</span></span>`;
  }).join('');
}

function renderActions() {
  const box = $('#actions');
  const acts = SIM.actions;
  const held = Object.keys(SIM.pos);
  if (!acts.length) {
    box.innerHTML = `<div class="ticket HOLD"><div class="t-head"><span class="t-sym">No trades</span><span class="badge WATCH">HOLD</span></div>
      <p>No new alerts for the next session. Keep holding${held.length ? ': ' + held.map(esc).join(', ') : ''}.</p>
      <span class="row-links"><a class="trade" href="${FIDELITY.positions}" target="_blank" rel="noopener">Check positions in Fidelity ↗</a></span></div>`;
    return;
  }
  box.innerHTML = acts.map(a => `
    <div class="ticket ${a.type === 'SKIP' ? 'HOLD' : a.type}">
      <div class="t-head"><span class="t-sym">${esc(a.sym)}</span><span class="badge ${a.type === 'SKIP' ? 'WATCH' : a.type}">${a.type === 'SKIP' ? 'NO SLOT' : a.type}</span></div>
      <p>${esc(a.reason)} · signal ${fmtDate(a.signalDate)}</p>
      ${a.type === 'BUY' ? `<span class="amt">Buy ≈ ${usd(a.value)}${a.price ? ` (~${(a.value / a.price).toFixed(3)} sh @ ${usd(a.price)})` : ''}</span>` : ''}
      ${a.type === 'SELL' ? `<span class="amt">Sell all ${a.shares} sh ≈ ${usd(a.value)}</span>` : ''}
      ${fidLinks(a.sym)}
    </div>`).join('');
}

function renderAlerts() {
  const rows = [];
  for (const [s, a] of Object.entries(AN)) {
    const dates = MARKET.symbols[s].dates;
    for (const e of a.events) if (e.i >= dates.length - 30) rows.push({ ...e, sym: s, date: dates[e.i] });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.sym.localeCompare(b.sym));
  $('#alerts-table').innerHTML = rows.length ? `
    <thead><tr><th>Date</th><th>Alert</th><th>Symbol</th><th class="num">Price</th><th>Why</th><th class="num">Since</th><th>Fidelity</th></tr></thead>
    <tbody>${rows.map(r => {
      const d = MARKET.symbols[r.sym], since = d.adj[d.adj.length - 1] / r.price - 1;
      return `<tr><td>${fmtDate(r.date)}</td><td><span class="badge ${r.type}">${r.type}</span></td><td><b>${esc(r.sym)}</b></td>
        <td class="num">${usd(r.price)}</td><td>${esc(r.reason)}</td><td class="num ${tone(since)}">${pct(since)}</td><td>${fidLinks(r.sym)}</td></tr>`;
    }).join('')}</tbody>` : `<tbody><tr><td class="empty">No alerts in the last 30 sessions.</td></tr></tbody>`;
}

function renderMarket() {
  const syms = Object.keys(MARKET.symbols).sort((a, b) => {
    const A = AN[a], B = AN[b];
    return B.mom[B.mom.length - 1] - A.mom[A.mom.length - 1];
  });
  $('#market-table').innerHTML = `
    <thead><tr><th>Symbol</th><th class="num">Price</th><th class="num">Day</th><th class="num">1M</th><th class="num">3M</th><th class="num">6M</th><th class="num">RSI</th><th class="num">vs ${S.strategy.trend}d MA</th><th>Signal</th><th>Last alert</th><th>Fidelity</th></tr></thead>
    <tbody>${syms.map(s => {
      const d = MARKET.symbols[s], a = AN[s], c = d.adj, L = c.length - 1, ch = dayChange(d);
      const vsT = a.t[L] ? c[L] / a.t[L] - 1 : null;
      const last = a.last ? `<span class="badge ${a.last.type}">${a.last.type}</span> ${fmtDate(d.dates[a.last.i])}` : '—';
      return `<tr data-sym="${esc(s)}" class="${S.selected === s ? 'sel' : ''}">
        <td class="sym"><b>${esc(s)}</b><span>${esc(d.name)}</span></td>
        <td class="num">${usd(d.price)}</td><td class="num ${tone(ch)}">${pct(ch, 2)}</td>
        <td class="num ${tone(ret(c, L, 21))}">${pct(ret(c, L, 21))}</td>
        <td class="num ${tone(ret(c, L, 63))}">${pct(ret(c, L, 63))}</td>
        <td class="num ${tone(ret(c, L, 126))}">${pct(ret(c, L, 126))}</td>
        <td class="num">${a.r[L]?.toFixed(0) ?? '—'}</td>
        <td class="num ${tone(vsT)}">${pct(vsT)}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td>
        <td>${last}</td><td>${fidLinks(s)}</td></tr>`;
    }).join('')}</tbody>`;
  $$('#market-table tbody tr').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    S.selected = tr.dataset.sym;
    $$('#market-table tbody tr').forEach(x => x.classList.toggle('sel', x === tr));
    renderDetail();
  }));
}

function chartDefaults() {
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}

function upsertChart(key, canvas, config) {
  charts[key]?.destroy();
  charts[key] = new Chart(canvas, config);
}

function renderDetail() {
  const s = S.selected || Object.keys(MARKET.symbols).sort((a, b) => AN[b].mom.at(-1) - AN[a].mom.at(-1))[0];
  S.selected = s;
  const d = MARKET.symbols[s], a = AN[s];
  const from = Math.max(0, d.adj.length - 252);
  const sl = arr => arr.slice(from);
  const marks = type => d.adj.map((v, i) => a.events.some(e => e.i === i && e.type === type) ? v : null).slice(from);
  $('#detail-title').innerHTML = `${esc(s)} <span class="muted">· ${esc(d.name)} · 1 year</span> <span class="badge ${a.status}">${a.status}</span>`;
  $('#detail-links').innerHTML = fidLinks(s);
  const accent = css('--accent'), down = css('--down'), text = css('--text');
  upsertChart('detail', $('#detail-chart'), {
    type: 'line',
    data: {
      labels: sl(d.dates),
      datasets: [
        { label: 'Price', data: sl(d.adj), borderColor: text, borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
        { label: `${S.strategy.fast}d MA`, data: sl(a.f), borderColor: '#3b82f6', borderWidth: 1, pointRadius: 0 },
        { label: `${S.strategy.slow}d MA`, data: sl(a.s), borderColor: '#f59e0b', borderWidth: 1, pointRadius: 0 },
        { label: `${S.strategy.trend}d MA`, data: sl(a.t), borderColor: '#a855f7', borderWidth: 1, borderDash: [4, 3], pointRadius: 0 },
        { label: 'BUY', data: marks('BUY'), showLine: false, pointStyle: 'triangle', pointRadius: 7, backgroundColor: accent, borderColor: accent },
        { label: 'SELL', data: marks('SELL'), showLine: false, pointStyle: 'triangle', rotation: 180, pointRadius: 7, backgroundColor: down, borderColor: down },
      ],
    },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { filter: i => i.raw != null, callbacks: { label: c => `${c.dataset.label}: ${usd(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8, callback(v) { return fmtDate(this.getLabelForValue(v)); } }, grid: { display: false } }, y: { ticks: { callback: v => usd(v, 0) } } },
    },
  });
}

function kpi(label, value, sub = '', cls = '', hero = false) {
  return `<div class="kpi ${hero ? 'hero' : ''}"><div class="l">${label}</div><div class="v ${cls}">${value}</div><div class="s">${sub}</div></div>`;
}

function renderSim() {
  const r = SIM, p = S.sim;
  const wins = r.trades.filter(t => t.ret > 0).length;
  const edge = r.totalRet - r.benchRet;
  $('#kpis').innerHTML = [
    kpi('Model Roth value', usd(r.final), `from ${usd(+p.capital, 0)} on ${fmtDate(r.start)}`, '', true),
    kpi('Total return', pct(r.totalRet), r.cagr != null ? `${pct(r.cagr)} annualized` : '', tone(r.totalRet)),
    kpi(`vs ${MARKET.benchmark} buy & hold`, pct(edge), `${MARKET.benchmark} did ${pct(r.benchRet)}`, tone(edge)),
    kpi('Max drawdown', pct(r.maxDD), 'worst peak-to-trough', 'down'),
    kpi('Closed trades', r.trades.length, r.trades.length ? `${Math.round(wins / r.trades.length * 100)}% winners` : ''),
    kpi('Cash', usd(r.cash), `${Object.keys(r.pos).length}/${p.maxPositions} slots used`),
  ].join('');

  upsertChart('equity', $('#equity-chart'), {
    type: 'line',
    data: {
      labels: r.labels,
      datasets: [
        { label: 'Following the alerts', data: r.equity, borderColor: css('--accent'), backgroundColor: css('--accent') + '22', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.1 },
        { label: `${MARKET.benchmark} buy & hold`, data: r.bench, borderColor: css('--chart-bench'), borderWidth: 1.5, pointRadius: 0, borderDash: [5, 4] },
      ],
    },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10 } }, tooltip: { callbacks: { title: i => fmtDate(i[0].label), label: c => `${c.dataset.label}: ${usd(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8, callback(v) { return fmtDate(this.getLabelForValue(v)); } }, grid: { display: false } }, y: { ticks: { callback: v => usd(v, 0) } } },
    },
  });

  const held = Object.entries(r.pos);
  const total = r.final;
  $('#holdings-table').innerHTML = held.length ? `
    <thead><tr><th>Symbol</th><th class="num">Shares</th><th>Bought</th><th class="num">Cost</th><th class="num">Now</th><th class="num">Value</th><th class="num">Weight</th><th class="num">P/L</th><th class="num">Stop (sell below)</th><th>Fidelity</th></tr></thead>
    <tbody>${held.map(([s, h]) => {
      const a = AN[s], pk = a.peak[a.peak.length - 1];
      const val = h.shares * h.last, pl = h.last / h.entryPrice - 1;
      return `<tr><td><b>${esc(s)}</b></td><td class="num">${h.shares}</td><td>${fmtDate(h.entryDate)}</td>
        <td class="num">${usd(h.entryPrice)}</td><td class="num">${usd(h.last)}</td><td class="num">${usd(val)}</td>
        <td class="num">${(val / total * 100).toFixed(1)}%</td><td class="num ${tone(pl)}">${pct(pl)}</td>
        <td class="num">${pk ? usd(pk * (1 - S.strategy.trailStop / 100)) : '—'}</td><td>${fidLinks(s)}</td></tr>`;
    }).join('')}
    <tr><td><b>Cash</b></td><td colspan="4"></td><td class="num">${usd(r.cash)}</td><td class="num">${(r.cash / total * 100).toFixed(1)}%</td><td colspan="3"></td></tr></tbody>`
    : `<tbody><tr><td class="empty">All cash: no open BUY alerts right now.</td></tr></tbody>`;

  const tr = [...r.trades].reverse();
  $('#trades-table').innerHTML = tr.length ? `
    <thead><tr><th>Symbol</th><th>Bought</th><th class="num">Entry</th><th>Sold</th><th class="num">Exit</th><th class="num">Return</th><th class="num">P/L</th><th>Exit reason</th></tr></thead>
    <tbody>${tr.map(t => `<tr><td><b>${esc(t.sym)}</b></td><td>${fmtDate(t.entryDate)}</td><td class="num">${usd(t.entryPrice)}</td>
      <td>${fmtDate(t.exitDate)}</td><td class="num">${usd(t.exitPrice)}</td><td class="num ${tone(t.ret)}">${pct(t.ret)}</td>
      <td class="num ${tone(t.pnl)}">${usd(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td class="empty">No closed trades yet.</td></tr></tbody>`;

  const sd = $('#sim-form [name=startDate]');
  sd.min = r.minStart; sd.max = MARKET.symbols[MARKET.benchmark].dates.at(-2);
  sd.value = r.start;
}

function renderProjection() {
  const p = S.proj;
  const years = Math.max(0, p.retireAge - p.age), rate = p.rate / 100;
  const startBal = SIM ? SIM.final : ROTH_LIMIT;
  const labels = [], bal = [], contrib = [];
  let b = startBal, c = startBal;
  for (let y = 0; y <= years; y++) {
    labels.push(p.age + y); bal.push(b); contrib.push(c);
    b = b * (1 + rate) + +p.contribution; c += +p.contribution;
  }
  const fv = bal.at(-1), paid = contrib.at(-1);
  $('#proj-kpis').innerHTML = [
    kpi(`Roth at ${p.retireAge}`, usd(fv, 0), `${p.rate}% a year for ${years} years`, '', true),
    kpi('You put in', usd(paid, 0), `${usd(startBal, 0)} today + ${usd(+p.contribution, 0)}/yr`),
    kpi('Tax-free growth', usd(fv - paid, 0), 'never taxed if qualified', 'up'),
  ].join('');
  upsertChart('proj', $('#proj-chart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Roth balance', data: bal, borderColor: css('--accent'), backgroundColor: css('--accent') + '22', fill: true, pointRadius: 0, borderWidth: 2 },
      { label: 'Contributions', data: contrib, borderColor: css('--chart-bench'), pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4] },
    ] },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { title: i => `Age ${i[0].label}`, label: c => `${c.dataset.label}: ${usd(c.raw, 0)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: v => usd(v, 0) } } },
    },
  });
  $('#rate-model').textContent = SIM?.cagr != null ? `Model's pace (${(SIM.cagr * 100).toFixed(1)}%)` : "Model's pace";
}

// ---------- start-today planner ----------
function buildPlan() {
  const p = S.plan, ts = S.strategy.trailStop / 100;
  const picks = Object.keys(AN)
    .filter(s => AN[s].status === 'HOLD')
    .sort((a, b) => AN[b].mom.at(-1) - AN[a].mom.at(-1))
    .slice(0, Math.max(1, p.positions));
  const slot = p.amount / Math.max(1, p.positions);
  const rows = picks.map(s => {
    const d = MARKET.symbols[s], a = AN[s], L = d.adj.length - 1;
    const shares = p.fractional ? Math.floor(slot / d.price * 1000) / 1000 : Math.floor(slot / d.price);
    const lastBuy = [...a.events].reverse().find(e => e.type === 'BUY');
    return {
      sym: s, name: d.name, price: d.price, shares, cost: shares * d.price,
      r126: ret(d.adj, L, 126), rsi: a.r[L],
      why: lastBuy ? `${lastBuy.reason} on ${fmtDate(d.dates[lastBuy.i])}` : 'Active BUY alert',
      stop: d.price * (1 - ts),
    };
  });
  const invested = rows.reduce((t, r) => t + r.cost, 0);
  const watch = Object.keys(AN).filter(s => AN[s].status === 'WATCH').sort((a, b) => AN[b].mom.at(-1) - AN[a].mom.at(-1)).slice(0, 5);
  return { rows, invested, cash: p.amount - invested, emptySlots: p.positions - rows.length, watch };
}

function renderPlan() {
  const P = buildPlan(), p = S.plan;
  $('#plan-kpis').innerHTML = [
    kpi('Buy now', `${P.rows.length} holding${P.rows.length === 1 ? '' : 's'}`, `≈ ${usd(p.amount / p.positions, 0)} each`, '', true),
    kpi('Invested', usd(P.invested), `${(P.invested / p.amount * 100).toFixed(0)}% of ${usd(+p.amount, 0)}`),
    kpi('Left in cash', usd(P.cash), P.emptySlots > 0 ? `${P.emptySlots} slot${P.emptySlots === 1 ? '' : 's'} waiting for a BUY alert` : 'leftover from rounding'),
  ].join('');
  $('#plan-table').innerHTML = P.rows.length ? `
    <thead><tr><th>#</th><th>Buy</th><th class="num">Price</th><th class="num">Shares</th><th class="num">Cost</th><th class="num">Weight</th><th class="num">6M</th><th>Why</th><th class="num">Sell if below</th><th>Fidelity</th></tr></thead>
    <tbody>${P.rows.map((r, i) => `<tr>
      <td class="muted">${i + 1}</td>
      <td class="sym"><b>${esc(r.sym)}</b><span>${esc(r.name)}</span></td>
      <td class="num">${usd(r.price)}</td><td class="num"><b>${r.shares}</b></td><td class="num">${usd(r.cost)}</td>
      <td class="num">${(r.cost / p.amount * 100).toFixed(1)}%</td>
      <td class="num ${tone(r.r126)}">${pct(r.r126)}</td><td>${esc(r.why)}</td>
      <td class="num">${usd(r.stop)}</td><td>${fidLinks(r.sym)}</td></tr>`).join('')}
      <tr><td></td><td><b>Cash</b><span class="muted"> stays in your Fidelity core position</span></td><td colspan="2"></td><td class="num">${usd(P.cash)}</td><td class="num">${(P.cash / p.amount * 100).toFixed(1)}%</td><td colspan="4"></td></tr></tbody>`
    : `<tbody><tr><td class="empty">Nothing is in an active BUY alert right now, so the rules say stay in cash and wait. ${P.watch.length ? `Closest to a BUY: ${P.watch.map(esc).join(', ')}.` : ''}</td></tr></tbody>`;
  $('#plan-rules').innerHTML = `
    <h3>After you buy</h3>
    <ul>
      <li><b>Sell</b> a holding if it closes below its "Sell if below" price (${S.strategy.trailStop}% under your buy price). As it rises, that line moves up to ${S.strategy.trailStop}% under its highest close. The <b>Model Roth</b> tab shows the updated level.</li>
      <li>Also sell if a SELL alert fires for it (trend breaks). It shows up under <b>Do this next</b>.</li>
      <li>When you sell, or if you have an empty slot, put that cash into the next stock in a BUY alert.</li>
      <li>Prices move during the day, so check the live price in Fidelity. A <b>limit order</b> near the price shown avoids surprises.</li>
    </ul>
    ${P.watch.length ? `<p class="muted">Uptrending, not a BUY yet: ${P.watch.map(esc).join(', ')}.</p>` : ''}`;
  return P;
}

function copyPlan() {
  const P = buildPlan();
  const lines = P.rows.map(r => `BUY ${r.shares} ${r.sym} @ ~${usd(r.price)} (${usd(r.cost)}) | sell if below ${usd(r.stop)}`);
  lines.push(`Cash left: ${usd(P.cash)}`);
  const done = () => { $('#plan-copied').textContent = 'Copied'; setTimeout(() => $('#plan-copied').textContent = '', 2000); };
  navigator.clipboard?.writeText(lines.join('\n')).then(done, () => { $('#plan-copied').textContent = 'Copy blocked by the browser'; });
}

// ---------- forms ----------
function bindForm(form, obj, key, onChange) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in obj)) continue;
    if (el.type === 'checkbox') el.checked = !!obj[el.name];
    else if (el.name !== 'startDate') el.value = obj[el.name];
  }
  form.addEventListener('change', e => {
    const el = e.target;
    if (!el.name) return;
    obj[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
    store.set(key, obj);
    onChange();
  });
}

function recompute() {
  analyzeAll();
  SIM = simulate();
  renderPlan(); renderActions(); renderAlerts(); renderMarket(); renderDetail(); renderSim(); renderProjection();
}

function exportCSV() {
  const rows = [['symbol', 'entry_date', 'entry_price', 'exit_date', 'exit_price', 'shares', 'return_pct', 'pnl', 'exit_reason']];
  for (const t of SIM.trades) rows.push([t.sym, t.entryDate, t.entryPrice.toFixed(2), t.exitDate, t.exitPrice.toFixed(2), t.shares, (t.ret * 100).toFixed(2), t.pnl.toFixed(2), t.reason]);
  for (const [s, h] of Object.entries(SIM.pos)) rows.push([s, h.entryDate, h.entryPrice.toFixed(2), 'OPEN', h.last.toFixed(2), h.shares, ((h.last / h.entryPrice - 1) * 100).toFixed(2), ((h.last - h.entryPrice) * h.shares).toFixed(2), '']);
  const blob = new Blob([rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `roth-model-trades-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- live data ----------
async function loadMarket() {
  const res = await fetch(`data/market.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`data/market.json → HTTP ${res.status}`);
  const next = await res.json();
  // Keep Finnhub's fresher quotes if we already have them.
  if (MARKET && S.live) for (const [s, d] of Object.entries(next.symbols)) {
    const old = MARKET.symbols[s];
    if (old) { d.price = old.price; d.prevClose = old.prevClose; }
  }
  MARKET = next;
}

async function pollFinnhub() {
  if (!S.finnhubKey || !MARKET) return;
  let ok = 0;
  for (const s of Object.keys(MARKET.symbols)) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(S.finnhubKey)}`);
      if (!res.ok) throw new Error(res.status);
      const q = await res.json();
      if (q.c) { MARKET.symbols[s].price = q.c; MARKET.symbols[s].prevClose = q.pc; ok++; }
    } catch { /* skip this symbol */ }
  }
  S.live = ok > 0;
  $('#key-status').textContent = S.live ? `Live: ${ok} quotes updated ${new Date().toLocaleTimeString()}` : 'Key saved, but no quotes came back. Check the key.';
  renderStatus(); renderTape(); renderMarket(); renderPlan();
}

// ---------- boot ----------
function wireStatic() {
  $('#fid-login').href = FIDELITY.login;
  $('#fid-positions').href = FIDELITY.positions;
  $('#fid-trade').href = FIDELITY.trade;
  $('#fid-foot').href = FIDELITY.rothIRA;
  $('#finnhub-key').value = S.finnhubKey;
  $('#save-key').addEventListener('click', () => {
    S.finnhubKey = $('#finnhub-key').value.trim();
    store.set('finnhubKey', S.finnhubKey);
    if (!S.finnhubKey) { S.live = false; $('#key-status').textContent = 'Key cleared.'; return; }
    $('#key-status').textContent = 'Fetching…';
    pollFinnhub();
  });
  $('#export-csv').addEventListener('click', exportCSV);
  $('#strat-reset').addEventListener('click', () => {
    Object.assign(S.strategy, DEFAULT_STRATEGY); store.set('strategy', S.strategy);
    for (const el of $('#strat-form').elements) if (el.name in S.strategy) el.value = S.strategy[el.name];
    recompute();
  });
  $('#proj-form').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const rate = b.id === 'rate-model' ? (SIM?.cagr != null ? Math.round(SIM.cagr * 1000) / 10 : null) : +b.dataset.rate;
    if (rate == null) return;
    S.proj.rate = rate; store.set('proj', S.proj);
    $('#proj-form [name=rate]').value = rate;
    renderProjection();
  });
  bindForm($('#strat-form'), S.strategy, 'strategy', recompute);
  bindForm($('#sim-form'), S.sim, 'sim', () => { SIM = simulate(); renderActions(); renderSim(); renderProjection(); });
  bindForm($('#proj-form'), S.proj, 'proj', renderProjection);
  bindForm($('#plan-form'), S.plan, 'plan', renderPlan);
  $('#plan-copy').addEventListener('click', copyPlan);

  // Highlight the tab for the section in view.
  const tabs = $$('#tabs a');
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) tabs.forEach(t => t.classList.toggle('active', t.hash === '#' + en.target.id));
  }), { rootMargin: '-40% 0px -55% 0px' });
  $$('main section').forEach(sec => io.observe(sec));
}

async function boot() {
  wireStatic();
  chartDefaults();
  try {
    await loadMarket();
  } catch (e) {
    const box = $('#load-error');
    box.hidden = false;
    box.innerHTML = `Couldn't load market data (${esc(e.message)}). Run <code>node scripts/fetch-data.mjs</code> locally, or wait for the GitHub Action to finish its first run.`;
    return;
  }
  renderStatus(); renderTape(); recompute();
  if (S.finnhubKey) pollFinnhub();

  // Refresh: rebuilt data every 5 min, Finnhub quotes every minute, both only while the market is open.
  setInterval(async () => {
    if (!renderStatus()) return;
    try { await loadMarket(); renderTape(); recompute(); } catch { /* keep current data */ }
  }, 5 * 60 * 1000);
  setInterval(() => { if (renderStatus() && S.finnhubKey) pollFinnhub(); }, 60 * 1000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { chartDefaults(); recompute(); });
}

boot();
