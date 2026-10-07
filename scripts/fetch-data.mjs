// Pulls daily price history for every ticker in watchlist.json and writes
// data/market.json. Runs in GitHub Actions on a schedule; run it locally too.
// Usage: node scripts/fetch-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const RANGE = '3y';
const UA = 'Mozilla/5.0'; // a full browser UA string gets rate-limited (429)

const watch = JSON.parse(await readFile(new URL('../watchlist.json', import.meta.url), 'utf8'));
const tickers = [...new Set([watch.benchmark, ...watch.tickers].map(t => t.trim().toUpperCase()))];

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchYahoo(symbol) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d&includeAdjustedClose=true&events=div%2Csplit`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json.chart?.result?.[0];
      if (!r?.timestamp) throw new Error(json.chart?.error?.description || 'no data');
      const m = r.meta;
      const closes = r.indicators.quote[0].close;
      const adj = r.indicators.adjclose?.[0]?.adjclose ?? closes;
      const dates = [], adjOut = [];
      r.timestamp.forEach((ts, i) => {
        if (adj[i] == null || closes[i] == null) return;
        dates.push(new Date((ts + m.gmtoffset) * 1000).toISOString().slice(0, 10));
        adjOut.push(round(adj[i]));
      });
      // Previous session close = second-to-last daily bar (unadjusted).
      const valid = closes.filter(c => c != null);
      return {
        name: m.longName || m.shortName || symbol,
        type: m.instrumentType,
        price: m.regularMarketPrice,
        prevClose: valid.length > 1 ? round(valid[valid.length - 2]) : m.chartPreviousClose,
        high52: m.fiftyTwoWeekHigh,
        low52: m.fiftyTwoWeekLow,
        marketTime: new Date(m.regularMarketTime * 1000).toISOString(),
        dates,
        adj: adjOut,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const symbols = {};
const failed = [];
for (const t of tickers) {
  try {
    symbols[t] = await fetchYahoo(t);
    console.log(`ok   ${t.padEnd(6)} ${symbols[t].dates.length} bars  $${symbols[t].price}`);
  } catch (e) {
    failed.push(t);
    console.warn(`FAIL ${t}: ${e.message}`);
  }
  await sleep(250);
}

if (!symbols[watch.benchmark]) {
  console.error(`Benchmark ${watch.benchmark} failed to load; not writing data.`);
  process.exit(1);
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/market.json', import.meta.url),
  JSON.stringify({ updated: new Date().toISOString(), benchmark: watch.benchmark, failed, symbols })
);
console.log(`Wrote data/market.json (${Object.keys(symbols).length} symbols, ${failed.length} failed)`);
