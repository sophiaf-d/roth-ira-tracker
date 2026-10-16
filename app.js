import { FIDELITY, ROTH_LIMIT, DEFAULT_STRATEGY, DEFAULT_SIM, DEFAULT_PLAN, DEFAULT_PROJECTION } from './config.js?v=__V__';

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
  newsFilter: store.get('newsFilter', 'picks'),
  selected: null,
  live: false,
};
let MARKET = null;
let AN = {};
let SIM = null;
let ROT = null;     // momentum rotation over the user's window
let CMP = null;     // full-history comparison + evidence
let IDX = {};       // symbol -> Map(date -> bar index)
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
  // Risk-adjusted momentum score: 12-1, 6- and 3-month returns divided by 3-month volatility.
  const score = new Array(n).fill(null);
  for (let i = 252; i < n; i++) {
    let s1 = 0, s2 = 0;
    for (let j = i - 62; j <= i; j++) { const x = c[j] / c[j - 1] - 1; s1 += x; s2 += x * x; }
    const vol = Math.sqrt(Math.max(0, (s2 - s1 * s1 / 63) / 62) * 252);
    const m = 0.4 * (c[i - 21] / c[i - 252] - 1) + 0.35 * (c[i] / c[i - 126] - 1) + 0.25 * (c[i] / c[i - 63] - 1);
    score[i] = m / Math.max(vol, 0.1);
  }
  const L = n - 1;
  const status = inPos[L] ? 'HOLD' : (c[L] > t[L] && f[L] > s[L]) ? 'WATCH' : 'AVOID';
  return { f, s, t, r, inPos, peak, mom, score, events, status, last: events[events.length - 1] };
}

function analyzeAll() {
  AN = {};
  IDX = {};
  for (const [sym, d] of Object.entries(MARKET.symbols)) {
    AN[sym] = analyze(d, S.strategy);
    IDX[sym] = new Map(d.dates.map((x, i) => [x, i]));
  }
}

const pxAt = (s, d) => { const i = IDX[s].get(d); return i == null ? null : MARKET.symbols[s].adj[i]; };

// Symbols ranked by momentum score on a date. Eligible = above the trend MA with a positive score.
function rankAt(d, eligibleOnly = true) {
  const out = [];
  for (const s of Object.keys(AN)) {
    const i = IDX[s].get(d), a = AN[s];
    if (i == null || a.score[i] == null) continue;
    const ok = MARKET.symbols[s].adj[i] > a.t[i] && a.score[i] > 0;
    if (ok || !eligibleOnly) out.push({ sym: s, score: a.score[i], ok });
  }
  return out.sort((x, y) => y.score - x.score);
}

// ---------- simulator ----------
function defaultStart() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function simulate(opts = {}) {
  const p = { ...S.sim, ...opts };
  const B = MARKET.symbols[MARKET.benchmark];
  const dates = B.dates;
  const minStart = dates[Math.min(dates.length - 2, S.strategy.trend + S.strategy.breakout)];
  const start = (p.startDate || defaultStart()) < minStart ? minStart : (p.startDate || defaultStart());
  const k0 = Math.max(0, dates.findIndex(d => d >= start));
  const syms = Object.keys(AN);
  const idx = IDX, priceAt = pxAt;
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

function perfDD(series) {
  let pk = -Infinity, dd = 0;
  for (const v of series) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
  return dd;
}

function perf(equity, bench, capital, start, end) {
  let pk = -Infinity, maxDD = 0;
  for (const v of equity) { pk = Math.max(pk, v); maxDD = Math.min(maxDD, v / pk - 1); }
  const final = equity.at(-1), years = (new Date(end) - new Date(start)) / (365.25 * 864e5);
  return { final, maxDD, years, totalRet: final / capital - 1, benchRet: bench.at(-1) / capital - 1,
    cagr: years > 0.25 ? (final / capital) ** (1 / years) - 1 : null };
}

// Momentum rotation: every `rebal` sessions, hold the top N eligible stocks equal-weight.
function simulateRotation(o) {
  const B = MARKET.symbols[MARKET.benchmark], dates = B.dates;
  const k0 = Math.max(dates.findIndex(d => d >= o.start), 253);
  let cash = o.capital, hold = {}, switches = 0;
  const last = {}, labels = [], equity = [], bench = [];
  for (let k = k0; k < dates.length; k++) {
    const d = dates[k];
    for (const s in hold) { const px = pxAt(s, d); if (px) last[s] = px; }
    if ((k - k0) % o.rebal === 0) {
      const sig = o.execNextDay ? dates[k - 1] : d;
      const picks = rankAt(sig).map(x => x.sym).filter(s => pxAt(s, d)).slice(0, o.N);
      const eq = cash + Object.entries(hold).reduce((t, [s, sh]) => t + sh * last[s], 0);
      switches += picks.filter(s => !hold[s]).length;
      hold = {}; cash = eq;
      for (const s of picks) { last[s] = pxAt(s, d); hold[s] = eq / o.N / last[s]; cash -= eq / o.N; }
    }
    labels.push(d);
    equity.push(cash + Object.entries(hold).reduce((t, [s, sh]) => t + sh * last[s], 0));
    bench.push(o.capital * B.adj[k] / B.adj[k0]);
  }
  const nextIn = o.rebal - ((dates.length - 1 - k0) % o.rebal);
  return { start: dates[k0], labels, equity, bench, hold, switches, nextIn, ...perf(equity, bench, o.capital, dates[k0], dates.at(-1)) };
}

// Track record of the score: every month, did the top N go on to beat SPY over the next month?
function evidence(N, h = 21) {
  const B = MARKET.symbols[MARKET.benchmark], dates = B.dates;
  const mean = xs => xs.reduce((t, x) => t + x, 0) / xs.length;
  let n = 0, beat = 0, sumP = 0, sumB = 0, sumBot = 0, nBot = 0;
  for (let k = 253; k + h < dates.length; k += h) {
    const d = dates[k], d2 = dates[k + h];
    const fwd = s => { const x = pxAt(s, d), y = pxAt(s, d2); return x && y ? y / x - 1 : null; };
    const top = rankAt(d).slice(0, N).map(x => fwd(x.sym)).filter(v => v != null);
    if (!top.length) continue;
    const bot = rankAt(d, false).slice(-N).map(x => fwd(x.sym)).filter(v => v != null);
    const p = mean(top), b = B.adj[k + h] / B.adj[k] - 1;
    n++; if (p > b) beat++; sumP += p; sumB += b;
    if (bot.length) { sumBot += mean(bot); nBot++; }
  }
  return { n, beatPct: n ? beat / n : null, avgPick: sumP / n, avgBench: sumB / n, avgBottom: nBot ? sumBot / nBot : null, from: dates[253] };
}

// Run both approaches over all available history and pick the one that did better.
function compareStrategies() {
  const N = Math.max(1, S.plan.positions);
  const dates = MARKET.symbols[MARKET.benchmark].dates;
  const start = dates[Math.min(dates.length - 2, Math.max(253, S.strategy.trend + S.strategy.breakout))];
  const alerts = simulate({ startDate: start, maxPositions: N, capital: 10000 });
  const rotation = simulateRotation({ start, capital: 10000, N, rebal: S.sim.rebalDays, execNextDay: S.sim.execNextDay });
  return { start, alerts, rotation, best: rotation.totalRet >= alerts.totalRet ? 'rotation' : 'alerts', ev: evidence(N) };
}

// ---------- news ----------
const POS_WORDS = new Set('beat beats tops topped surge surges soar soars soaring jump jumps rally rallies record upgrade upgraded upgrades raise raises raised outperform strong stronger growth bullish gain gains win wins approval approved approves partnership expands expansion boost boosts higher rise rises climbs climb breakthrough profit profits buyback beating backing'.split(' '));
const NEG_WORDS = new Set('miss misses missed plunge plunges fall falls falling drop drops slump slumps downgrade downgraded downgrades cut cuts lawsuit sue sued probe investigation recall weak weaker bearish loss losses decline declines sinks sink tumble tumbles crash crashes warning warns warn layoffs fraud ban tariff tariffs delay delays fizzles crisis selloff sell-off lower slammed worries worry fears fear risk risks antitrust fine fined halt halts slashes slash bubble'.split(' '));

function headlineTone(title) {
  let p = 0, n = 0;
  for (const w of title.toLowerCase().match(/[a-z-]+/g) || []) { if (POS_WORDS.has(w)) p++; if (NEG_WORDS.has(w)) n++; }
  return p + n ? (p - n) / (p + n) : 0;
}

function newsFor(sym, days = 4) {
  const cutoff = new Date(MARKET.updated) - days * 864e5;
  return (MARKET.news || []).filter(x => x.tickers.includes(sym) && new Date(x.time) >= cutoff);
}

function sentimentOf(sym) {
  const items = newsFor(sym);
  if (!items.length) return { n: 0, score: 0, label: 'None', cls: '' };
  const score = items.reduce((t, x) => t + headlineTone(x.title), 0) / items.length;
  const label = score >= 0.15 ? 'Positive' : score <= -0.15 ? 'Negative' : 'Mixed';
  return { n: items.length, score, label, cls: label === 'Positive' ? 'HOLD' : label === 'Negative' ? 'AVOID' : 'WATCH', top: items[0] };
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
        { label: 'Momentum rotation', data: ROT.equity, borderColor: '#3b82f6', borderWidth: 1.5, pointRadius: 0 },
        { label: `${MARKET.benchmark} buy & hold`, data: r.bench, borderColor: css('--chart-bench'), borderWidth: 1.5, pointRadius: 0, borderDash: [5, 4] },
      ],
    },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10 } }, tooltip: { callbacks: { title: i => fmtDate(i[0].label), label: c => `${c.dataset.label}: ${usd(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8, callback(v) { return fmtDate(this.getLabelForValue(v)); } }, grid: { display: false } }, y: { ticks: { callback: v => usd(v, 0) } } },
    },
  });

  const row = (name, x, note = '') => `<tr><td><b>${name}</b>${note}</td><td class="num ${tone(x.totalRet)}">${pct(x.totalRet)}</td><td class="num">${x.cagr != null ? pct(x.cagr) : '—'}</td><td class="num down">${pct(x.maxDD)}</td></tr>`;
  const benchLine = x => ({ totalRet: x.benchRet, cagr: x.years > 0.25 ? (1 + x.benchRet) ** (1 / x.years) - 1 : null, maxDD: perfDD(x.bench) });
  const star = k => CMP.best === k ? ' <span class="badge HOLD">best</span>' : '';
  $('#compare').innerHTML = `
    <thead><tr><th>Approach</th><th class="num">Your window</th><th class="num">/yr</th><th class="num">Max drop</th></tr></thead>
    <tbody>${row('Trend alerts', r)}${row('Momentum rotation', ROT)}${row(`${MARKET.benchmark} buy &amp; hold`, benchLine(r))}
    <tr><th colspan="4">Full history since ${fmtDate(CMP.start)} (${CMP.alerts.years.toFixed(1)} yrs, ${S.plan.positions} holdings)</th></tr>
    ${row('Trend alerts', CMP.alerts, star('alerts'))}${row('Momentum rotation', CMP.rotation, star('rotation'))}${row(`${MARKET.benchmark} buy &amp; hold`, benchLine(CMP.alerts))}</tbody>`;

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
const METHOD_NAME = { rotation: 'Momentum rotation', alerts: 'Trend alerts' };

function buildPlan() {
  const p = S.plan, N = Math.max(1, p.positions), ts = S.strategy.trailStop / 100;
  const method = p.method === 'auto' ? CMP.best : p.method;
  const lastDay = MARKET.symbols[MARKET.benchmark].dates.at(-1);
  const ranked = rankAt(lastDay, false);
  const rankOf = Object.fromEntries(ranked.map((x, i) => [x.sym, i + 1]));
  let cands = method === 'rotation'
    ? ranked.filter(x => x.ok)
    : ranked.filter(x => AN[x.sym].status === 'HOLD');
  // News nudges the order: strongly positive headlines lift a stock, strongly negative ones push it down.
  cands = cands.map(x => {
    const news = sentimentOf(x.sym);
    const adj = p.useNews && news.n ? x.score * (1 + 0.3 * news.score) : x.score;
    return { ...x, news, adj };
  }).sort((x, y) => y.adj - x.adj);
  const picks = cands.slice(0, N);
  const slot = p.amount / N;
  const rows = picks.map(x => {
    const s = x.sym, d = MARKET.symbols[s], A = AN[s], L = d.adj.length - 1;
    const shares = p.fractional ? Math.floor(slot / d.price * 1000) / 1000 : Math.floor(slot / d.price);
    const lastBuy = [...A.events].reverse().find(e => e.type === 'BUY');
    const trendLine = A.t[L] * d.price / d.adj[L];
    return {
      sym: s, name: d.name, price: d.price, shares, cost: shares * d.price, rank: rankOf[s], news: x.news,
      r126: ret(d.adj, L, 126),
      why: method === 'rotation'
        ? `#${rankOf[s]} of ${ranked.length} by momentum score`
        : (lastBuy ? `${lastBuy.reason} on ${fmtDate(d.dates[lastBuy.i])}` : 'Active BUY alert'),
      stop: method === 'rotation' ? trendLine : d.price * (1 - ts),
    };
  });
  const invested = rows.reduce((t, r) => t + r.cost, 0);
  const bench = cands.slice(N, N + 4).map(x => x.sym);
  return { method, rows, invested, cash: p.amount - invested, emptySlots: N - rows.length, bench, N };
}

function newsBadge(n) {
  if (!n.n) return '<span class="muted">—</span>';
  const t = n.top ? ` title="${esc(n.top.title)}"` : '';
  return `<span class="badge ${n.cls}"${t}>${n.label}</span> <span class="muted">${n.n}</span>`;
}

function renderPlan() {
  const P = buildPlan(), p = S.plan, C = CMP, ev = C.ev;
  const other = P.method === 'rotation' ? C.alerts : C.rotation;
  const mine = P.method === 'rotation' ? C.rotation : C.alerts;
  $('#plan-why').innerHTML = `
    <div class="why-grid">
      <div><div class="l">Approach</div><div class="v">${METHOD_NAME[P.method]}</div>
        <div class="s">${p.method === 'auto' ? `Picked automatically: ${pct(mine.totalRet, 0)} since ${fmtDate(C.start)} vs ${pct(other.totalRet, 0)} for ${METHOD_NAME[P.method === 'rotation' ? 'alerts' : 'rotation'].toLowerCase()} and ${pct(mine.benchRet, 0)} for ${MARKET.benchmark}.` : 'Chosen by you.'}</div></div>
      <div><div class="l">Score track record</div><div class="v">${ev.beatPct != null ? Math.round(ev.beatPct * 100) + '%' : '—'} of months</div>
        <div class="s">the top ${P.N} by score beat ${MARKET.benchmark} the following month (${ev.n} months since ${fmtDate(ev.from)}). Avg ${pct(ev.avgPick)}/mo vs ${pct(ev.avgBench)} for ${MARKET.benchmark}${ev.avgBottom != null ? ` and ${pct(ev.avgBottom)} for the ${P.N} lowest-scored` : ''}.</div></div>
      <div><div class="l">News</div><div class="v">${(MARKET.news || []).length} headlines</div>
        <div class="s">${p.useNews ? 'Headlines from the last 4 days nudge the ranking.' : 'Shown for context, not used in the ranking.'} News isn't part of the backtest.</div></div>
    </div>
    <p class="caveat">Read the backtest with care: the watchlist was chosen today, already knowing which stocks went on to soar, so every approach looks better than it would have in real time.${ev.avgBottom != null && ev.avgPick - ev.avgBottom < 0.01 ? ` The top-scored picks only beat the lowest-scored ones by ${pct(ev.avgPick - ev.avgBottom)} a month, so most of the gain came from the watchlist itself, not the ranking.` : ''} Past results don't guarantee future returns.</p>`;
  $('#plan-kpis').innerHTML = [
    kpi('Buy now', `${P.rows.length} holding${P.rows.length === 1 ? '' : 's'}`, `≈ ${usd(p.amount / P.N, 0)} each`, '', true),
    kpi('Invested', usd(P.invested), `${(P.invested / p.amount * 100).toFixed(0)}% of ${usd(+p.amount, 0)}`),
    kpi('Left in cash', usd(P.cash), P.emptySlots > 0 ? `${P.emptySlots} slot${P.emptySlots === 1 ? '' : 's'} with nothing qualifying` : 'leftover from rounding'),
  ].join('');
  $('#plan-table').innerHTML = P.rows.length ? `
    <thead><tr><th>#</th><th>Buy</th><th class="num">Price</th><th class="num">Shares</th><th class="num">Cost</th><th class="num">6M</th><th>Why</th><th>News</th><th class="num">Sell if below</th><th>Fidelity</th></tr></thead>
    <tbody>${P.rows.map((r, i) => `<tr>
      <td class="muted">${i + 1}</td>
      <td class="sym"><b>${esc(r.sym)}</b><span>${esc(r.name)}</span></td>
      <td class="num">${usd(r.price)}</td><td class="num"><b>${r.shares}</b></td><td class="num">${usd(r.cost)}</td>
      <td class="num ${tone(r.r126)}">${pct(r.r126)}</td><td>${esc(r.why)}</td><td>${newsBadge(r.news)}</td>
      <td class="num">${usd(r.stop)}</td><td>${fidLinks(r.sym)}</td></tr>`).join('')}
      <tr><td></td><td><b>Cash</b><span class="muted"> stays in your Fidelity core position</span></td><td colspan="2"></td><td class="num">${usd(P.cash)}</td><td colspan="5"></td></tr></tbody>`
    : `<tbody><tr><td class="empty">Nothing qualifies right now, so the rules say stay in cash and wait.</td></tr></tbody>`;
  const rules = P.method === 'rotation' ? `
      <li><b>Check once a month</b> (next check in about ${C.rotation.nextIn} trading days). Sell anything that's no longer in the top ${P.N} and buy the new names so each is about the same size.</li>
      <li><b>Sell early</b> if a holding closes below its "Sell if below" price (its ${S.strategy.trend}-day average). That means its uptrend broke.</li>` : `
      <li><b>Sell</b> if it closes below its "Sell if below" price (${S.strategy.trailStop}% under your buy price). As it rises, that line moves up to ${S.strategy.trailStop}% under its highest close.</li>
      <li>Also sell if a SELL alert fires for it. It shows up under <b>Do this next</b>. Put the cash into the next stock in a BUY alert.</li>`;
  $('#plan-rules').innerHTML = `
    <h3>After you buy</h3>
    <ul>${rules}
      <li>Check the <b>News</b> column before you buy. A "Negative" badge means recent headlines lean bad, so read them first. Hover the badge to see the latest one.</li>
      <li>Prices move during the day, so check the live price in Fidelity. A <b>limit order</b> near the price shown avoids surprises.</li>
    </ul>
    ${P.bench.length ? `<p class="muted">Next in line if one of these doesn't work for you: ${P.bench.map(esc).join(', ')}.</p>` : ''}`;
  return P;
}

function copyPlan() {
  const P = buildPlan();
  const lines = P.rows.map(r => `BUY ${r.shares} ${r.sym} @ ~${usd(r.price)} (${usd(r.cost)}) | sell if below ${usd(r.stop)}`);
  lines.push(`Cash left: ${usd(P.cash)}`);
  const done = () => { $('#plan-copied').textContent = 'Copied'; setTimeout(() => $('#plan-copied').textContent = '', 2000); };
  navigator.clipboard?.writeText(lines.join('\n')).then(done, () => { $('#plan-copied').textContent = 'Copy blocked by the browser'; });
}

function renderNews() {
  const all = MARKET.news || [];
  const picks = new Set(buildPlan().rows.map(r => r.sym));
  const items = S.newsFilter === 'picks' ? all.filter(x => x.tickers.some(t => picks.has(t))) : all;
  $$('#news-filter .chip').forEach(b => b.classList.toggle('on', b.dataset.f === S.newsFilter));
  const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 6e4); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  $('#news-list').innerHTML = items.length ? items.slice(0, 80).map(x => {
    const tone = headlineTone(x.title), cls = tone > 0 ? 'HOLD' : tone < 0 ? 'AVOID' : '';
    return `<li><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>
      <div class="meta">${x.tickers.map(t => `<span class="tick">${esc(t)}</span>`).join('')}
      ${cls ? `<span class="badge ${cls}">${tone > 0 ? 'Positive' : 'Negative'}</span>` : ''}
      <span class="muted">${esc(x.publisher)} · ${ago(x.time)}</span></div></li>`;
  }).join('') : '<li class="empty">No recent headlines.</li>';
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
  ROT = simulateRotation({ start: SIM.start, capital: +S.sim.capital, N: S.sim.maxPositions, rebal: S.sim.rebalDays, execNextDay: S.sim.execNextDay });
  CMP = compareStrategies();
  renderPlan(); renderNews(); renderActions(); renderAlerts(); renderMarket(); renderDetail(); renderSim(); renderProjection();
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
  bindForm($('#sim-form'), S.sim, 'sim', recompute);
  bindForm($('#proj-form'), S.proj, 'proj', renderProjection);
  bindForm($('#plan-form'), S.plan, 'plan', () => { CMP = compareStrategies(); renderPlan(); renderNews(); renderSim(); });
  $('#news-filter').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    S.newsFilter = b.dataset.f; store.set('newsFilter', S.newsFilter); renderNews();
  });
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
