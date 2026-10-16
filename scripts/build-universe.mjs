// Builds universe.json: every current S&P 500 member with the date it joined the
// index, plus a set of broad and sector ETFs. The join date lets backtests count a
// stock only from when it was actually in the index, which removes most of the
// "we only picked winners" bias of a hand-made watchlist.
// Usage: node scripts/build-universe.mjs
import { writeFile } from 'node:fs/promises';

const ETFS = {
  SPY: 'Broad market', QQQ: 'Broad market', DIA: 'Broad market', IWM: 'Broad market',
  XLK: 'Information Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Health Care',
  XLY: 'Consumer Discretionary', XLP: 'Consumer Staples', XLI: 'Industrials', XLB: 'Materials',
  XLU: 'Utilities', XLRE: 'Real Estate', XLC: 'Communication Services',
  SMH: 'Semiconductors', GLD: 'Gold', TLT: 'Treasury bonds',
};

const decode = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\[\d+\]/g, '').trim();

const html = await (await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', {
  headers: { 'User-Agent': 'roth-ira-tracker/1.0 (GitHub Pages hobby project)' },
})).text();
const table = html.slice(html.indexOf('id="constituents"'));
const body = table.slice(0, table.indexOf('</table>'));
const rows = body.split(/<tr[^>]*>/).slice(1).map(r => [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => decode(m[1])));
const head = rows[0].map(h => h.toLowerCase());
const col = name => head.findIndex(h => h.includes(name));
const [cSym, cName, cSector, cAdded] = [col('symbol'), col('security'), col('gics sector'), col('date added')];
if ([cSym, cName, cSector, cAdded].some(i => i < 0)) throw new Error(`Unexpected Wikipedia table header: ${head.join(' | ')}`);

const stocks = {};
for (const r of rows.slice(1)) {
  if (!r[cSym]) continue;
  const sym = r[cSym].replace('.', '-'); // BRK.B -> BRK-B (Yahoo format)
  const added = (r[cAdded].match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
  stocks[sym] = { name: r[cName], sector: r[cSector], since: added || '1900-01-01' };
}
if (Object.keys(stocks).length < 480) throw new Error(`Only parsed ${Object.keys(stocks).length} S&P 500 members`);

const etfs = Object.fromEntries(Object.entries(ETFS).map(([s, sector]) => [s, { sector, since: '1900-01-01', etf: true }]));
await writeFile(new URL('../universe.json', import.meta.url), JSON.stringify({ source: 'S&P 500 (Wikipedia) + ETFs', built: new Date().toISOString().slice(0, 10), stocks, etfs }, null, 1));
console.log(`universe.json: ${Object.keys(stocks).length} S&P 500 stocks + ${Object.keys(etfs).length} ETFs`);
