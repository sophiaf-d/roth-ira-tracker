# Roth Alert Tracker

A static website for a Roth IRA competition. It:

- **Tracks the market**: a watchlist of stocks and ETFs with price, day change, 1/3/6-month momentum, RSI, trend, and a chart with moving averages and BUY/SELL markers.
- **Generates alerts**: trend-following momentum rules (MA crossovers, breakouts, trailing stop). Long-only, so it works in a Roth.
- **Models your Roth IRA**: starts with your balance on a date, follows every alert, and shows the equity curve vs SPY, current holdings with stop levels, the trade log, and **what to do next session**.
- **Projects retirement**: tax-free value at retirement from yearly contributions.
- **Links to Fidelity**: every symbol has *Quote* and *Trade* buttons. The header links to Fidelity login, positions, and the trade ticket. All Fidelity URLs live in `config.js`.

No backend and no API key are needed. A GitHub Action pulls prices from Yahoo Finance every 15 minutes during market hours and redeploys the site to GitHub Pages.

## Put it on GitHub

1. Create an empty repo on GitHub (for example `roth-ira-tracker`).
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<you>/roth-ira-tracker.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions → "Refresh market data & deploy" → Run workflow** (or just wait for the next push or schedule).
5. The site is live at `https://<you>.github.io/roth-ira-tracker/`.

> GitHub pauses scheduled workflows in repos with no activity for 60 days. Push any commit to wake it up. Scheduled runs can also start a few minutes late.

## Run locally

```bash
node scripts/fetch-data.mjs     # writes data/market.json
python3 -m http.server 8000     # then open http://localhost:8000
```

## Customize

| What | Where |
| --- | --- |
| Tickers | `watchlist.json` (the benchmark is used for the comparison line) |
| Alert rules, sim defaults, Fidelity links | `config.js` |
| Strategy params on the fly | **Strategy** section of the site (saved in your browser) |
| Real-time quotes | Paste a free [Finnhub](https://finnhub.io) key in **Strategy** (stored only in your browser, never commit it) |

## How the model works

- **BUY**: price above the trend MA (200d), RSI(14) under the cap, and either the fast MA (20d) crosses above the slow MA (50d) or a new 55-day closing high.
- **SELL**: 12% trailing stop from the high since entry, a close below the 200d MA, or the 20d MA crossing back under the 50d MA.
- Portfolio: up to N equal-weight positions. When several alerts fire together, the strongest momentum wins. Empty slots refill with the strongest stock still in a BUY alert. By default, fills happen at the next session's close, so there's no hindsight.
- Prices are dividend-adjusted, so dividends are reinvested.

*Educational tool, not investment advice. Backtests are hypothetical and past returns don't predict future results.*
