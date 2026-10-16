# Roth Alert Tracker

A static website for a Roth IRA competition. It:

- **Scans the whole market**: every S&P 500 stock plus sector ETFs (521 symbols), ranked by momentum score, with price, day change, 1/3/6-month returns, RSI, trend, and a chart with moving averages and BUY/SELL markers. Search for any ticker, or filter to the top 50 or your watchlist.
- **Suggests what to buy** (*Start today*): enter a cash amount and get share counts, sell levels and Fidelity Trade links. It backtests two approaches on 5 years of prices and uses whichever did better. It ranks stocks by a risk-adjusted momentum score and shows that score's month-by-month track record against SPY.
- **Reads the news from 6 sources**: Yahoo Finance, Google News, Seeking Alpha and Nasdaq for the top 40 ranked names and your watchlist, plus CNBC and MarketWatch for market-wide news. Duplicate stories are merged, and keyword tone can nudge the ranking.
- **Generates alerts**: trend-following momentum rules (MA crossovers, breakouts, trailing stop). Long-only, so it works in a Roth.
- **Models your Roth IRA**: starts with your balance on a date, follows every alert, and shows the equity curve vs SPY, current holdings with stop levels, the trade log, and **what to do next session**.
- **Projects retirement**: tax-free value at retirement from yearly contributions.
- **Links to Fidelity**: every symbol has *Quote* and *Trade* buttons. The header links to Fidelity login, positions, and the trade ticket. All Fidelity URLs live in `config.js`.

No backend and no API key are needed. A GitHub Action rebuilds the S&P 500 list from Wikipedia, pulls 5 years of prices and the latest headlines (about 40 seconds), and redeploys the site to GitHub Pages. It's scheduled every 15 minutes during market hours, but GitHub often skips scheduled runs on free accounts. Run `gh workflow run deploy.yml` to refresh on demand.

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
| Universe | `scripts/build-universe.mjs` (S&P 500 from Wikipedia + the ETF list in that file) |
| Your watchlist / extra tickers | `watchlist.json` (anything outside the S&P 500 is tracked but not ranked) |
| Alert rules, sim defaults, Fidelity links | `config.js` |
| Strategy params on the fly | **Strategy** section of the site (saved in your browser) |
| Real-time quotes | Paste a free [Finnhub](https://finnhub.io) key in **Strategy** (stored only in your browser, never commit it) |

## How the model works

**Momentum rotation**: every 21 trading days, score each stock by (0.4 × 12-1-month return + 0.35 × 6-month + 0.25 × 3-month) ÷ 3-month volatility. Keep the ones above their 200-day MA, and hold the top N equal-weight.

Picks are capped at 2 per sector by default (*Max per sector*, 0 = no cap). Without the cap, picks cluster in whatever sector is hot, which historically earned more but with deeper drops.

**Avoiding hindsight bias**: the backtest uses the whole S&P 500 instead of a hand-picked list, and each stock counts only from the date it joined the index (from Wikipedia's "Date added"), so the model can't favor stocks it "knows" will soar. Remaining bias: companies later dropped from the index (bought out, went bankrupt) aren't in the free price data, so results still lean a little optimistic. The planner shows the score's real edge: how much the top-scored picks beat the lowest-scored ones each month.

**Trend alerts**:

- **BUY**: price above the trend MA (200d), RSI(14) under the cap, and either the fast MA (20d) crosses above the slow MA (50d) or a new 55-day closing high.
- **SELL**: 12% trailing stop from the high since entry, a close below the 200d MA, or the 20d MA crossing back under the 50d MA.
- Portfolio: up to N equal-weight positions. When several alerts fire together, the strongest momentum wins. Empty slots refill with the strongest stock still in a BUY alert. By default, fills happen at the next session's close, so there's no hindsight.
- Prices are dividend-adjusted, so dividends are reinvested.

*Educational tool, not investment advice. Backtests are hypothetical and past returns don't predict future results.*
