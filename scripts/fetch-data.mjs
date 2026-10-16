// Pulls 5 years of daily prices for the whole universe (S&P 500 + ETFs + your
// watchlist) and recent news from several sources, then writes data/market.json.
// Runs in GitHub Actions on a schedule; run it locally too.
// Usage: node scripts/fetch-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const RANGE = '5y';            // 1 year of indicator warm-up + ~4 years of backtest
const UA = 'Mozilla/5.0';      // a full browser UA string gets rate-limited (429)
const CONCURRENCY = 6;
const NEWS_DAYS = 5;
const NEWS_TOP = 40;           // news is pulled for the top-ranked names plus your watchlist

const readJSON = async f => JSON.parse(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'));
const watch = await readJSON('watchlist.json');
const universe = await readJSON('universe.json');

const meta = {};
for (const [s, m] of Object.entries(universe.stocks)) meta[s] = { ...m, member: true };
for (const [s, m] of Object.entries(universe.etfs)) meta[s] = { ...m, member: true };
for (const s of [watch.benchmark, ...watch.tickers].map(t => t.trim().toUpperCase())) meta[s] ??= { sector: '', since: '1900-01-01', member: false };
const tickers = Object.keys(meta);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = x => x >= 10 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000;

async function getJSON(url, tries = 3) {
  for (let a = 1; ; a++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    if (a >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status}`);
    await sleep(1500 * a);
  }
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); await sleep(120); }
  }));
}

// ---------- prices ----------
async function fetchChart(symbol) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d&includeAdjustedClose=true&events=div%2Csplit`);
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(j.chart?.error?.description || 'no data');
  const m = r.meta, closes = r.indicators.quote[0].close;
  const adj = r.indicators.adjclose?.[0]?.adjclose ?? closes;
  const bars = new Map();
  r.timestamp.forEach((ts, i) => {
    if (adj[i] != null && closes[i] != null) bars.set(new Date((ts + m.gmtoffset) * 1000).toISOString().slice(0, 10), adj[i]);
  });
  const valid = closes.filter(c => c != null);
  return { name: m.longName || m.shortName || symbol, price: m.regularMarketPrice, prevClose: valid.length > 1 ? valid.at(-2) : m.chartPreviousClose, bars };
}

const raw = {}, failed = [];
await pool(tickers, async t => {
  try { raw[t] = await fetchChart(t); } catch (e) { failed.push(t); console.warn(`FAIL ${t}: ${e.message}`); }
});
console.log(`prices: ${Object.keys(raw).length} ok, ${failed.length} failed`);
if (!raw[watch.benchmark]) { console.error(`Benchmark ${watch.benchmark} failed; not writing data.`); process.exit(1); }

// Align every series to the benchmark's trading calendar (forward-fill rare gaps) so one shared
// date array serves all symbols; each symbol stores only an offset into it.
const dates = [...raw[watch.benchmark].bars.keys()];
const symbols = {};
for (const [s, d] of Object.entries(raw)) {
  const first = dates.findIndex(x => d.bars.has(x));
  if (first < 0) continue;
  const adj = [];
  let last = null;
  for (let i = first; i < dates.length; i++) { last = d.bars.get(dates[i]) ?? last; adj.push(round(last)); }
  const m = meta[s];
  symbols[s] = { name: m.name || d.name, sector: m.sector, since: m.since, member: m.member, etf: !!m.etf, price: d.price, prevClose: round(d.prevClose), off: first, adj };
}

// ---------- news ----------
// Rank by the same momentum score the site uses, to know which names need headlines.
function score(adj) {
  const n = adj.length, i = n - 1;
  if (n < 253) return -Infinity;
  let s1 = 0, s2 = 0;
  for (let j = i - 62; j <= i; j++) { const x = adj[j] / adj[j - 1] - 1; s1 += x; s2 += x * x; }
  const vol = Math.sqrt(Math.max(0, (s2 - s1 * s1 / 63) / 62) * 252);
  return (0.4 * (adj[i - 21] / adj[i - 252] - 1) + 0.35 * (adj[i] / adj[i - 126] - 1) + 0.25 * (adj[i] / adj[i - 63] - 1)) / Math.max(vol, 0.1);
}
const ranked = Object.keys(symbols).filter(s => symbols[s].member).sort((a, b) => score(symbols[b].adj) - score(symbols[a].adj));
const newsTickers = [...new Set([...ranked.slice(0, NEWS_TOP), ...watch.tickers.map(t => t.toUpperCase())])].filter(s => symbols[s]);

const unxml = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
const tag = (item, t) => unxml((item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);

function parseRSS(xml, source) {
  return xml.split(/<item[\s>]/).slice(1).map(item => {
    let title = tag(item, 'title'), publisher = tag(item, 'source') || source;
    // Google News appends " - Publisher" to titles.
    if (source === 'Google News') { const k = title.lastIndexOf(' - '); if (k > 0) { publisher = title.slice(k + 3); title = title.slice(0, k); } }
    return { title, link: tag(item, 'link') || tag(item, 'guid'), time: new Date(tag(item, 'pubDate')).getTime(), publisher, via: source };
  });
}

const SOURCES = {
  'Yahoo Finance': async t => (await getJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t)}&quotesCount=0&newsCount=10`)).news?.map(n => ({
    title: n.title, link: n.link, time: n.providerPublishTime * 1000, publisher: n.publisher, via: 'Yahoo Finance',
    tickers: (n.relatedTickers ?? []).filter(x => symbols[x]),
  })).filter(n => n.tickers.includes(t)) ?? [],
  'Google News': async t => parseRSS(await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`${t} stock when:${NEWS_DAYS}d`)}&hl=en-US&gl=US&ceid=US:en`), 'Google News').slice(0, 10),
  'Seeking Alpha': async t => parseRSS(await getText(`https://seekingalpha.com/api/sa/combined/${encodeURIComponent(t)}.xml`), 'Seeking Alpha').slice(0, 10),
  'Nasdaq': async t => parseRSS(await getText(`https://www.nasdaq.com/feed/rssoutbound?symbol=${encodeURIComponent(t)}`), 'Nasdaq').slice(0, 10),
};
const MARKET_FEEDS = {
  CNBC: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
  MarketWatch: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
};

const cutoff = Date.now() - NEWS_DAYS * 864e5;
const news = new Map();
const keyOf = title => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
function addNews(items, ticker) {
  for (const n of items) {
    if (!n.title || !n.link?.startsWith('https://') || !(n.time >= cutoff)) continue;
    const k = keyOf(n.title), tickers = [...new Set([...(n.tickers ?? []), ...(ticker ? [ticker] : [])])];
    const prev = news.get(k);
    if (prev) { prev.tickers = [...new Set([...prev.tickers, ...tickers])]; prev.sources = [...new Set([...prev.sources, n.via])]; continue; }
    news.set(k, { title: n.title, link: n.link, publisher: n.publisher, time: new Date(n.time).toISOString(), tickers, sources: [n.via] });
  }
}
const newsJobs = newsTickers.flatMap(t => Object.keys(SOURCES).map(src => ({ t, src })));
const srcCount = {};
await pool(newsJobs, async ({ t, src }) => {
  try { const items = await SOURCES[src](t); addNews(items, t); srcCount[src] = (srcCount[src] || 0) + items.length; }
  catch (e) { console.warn(`news FAIL ${src} ${t}: ${e.message}`); }
});
for (const [src, url] of Object.entries(MARKET_FEEDS)) {
  try { const items = parseRSS(await getText(url), src); addNews(items, null); srcCount[src] = items.length; }
  catch (e) { console.warn(`news FAIL ${src}: ${e.message}`); }
}
const newsList = [...news.values()].sort((a, b) => b.time.localeCompare(a.time));
console.log(`news: ${newsList.length} unique headlines`, srcCount);

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/market.json', import.meta.url), JSON.stringify({
  updated: new Date().toISOString(), benchmark: watch.benchmark, watchlist: watch.tickers.map(t => t.toUpperCase()),
  universe: universe.source, failed, dates, symbols, news: newsList,
}));
console.log(`Wrote data/market.json (${Object.keys(symbols).length} symbols, ${dates.length} days)`);
