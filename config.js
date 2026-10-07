// Everything you might want to tweak lives here.

// Fidelity deep links — all Fidelity URLs in the app come from this object,
// so if Fidelity changes a path you only fix it once.
export const FIDELITY = {
  login: 'https://digital.fidelity.com/prgw/digital/login/full-page',
  positions: 'https://digital.fidelity.com/ftgw/digital/portfolio/positions',
  trade: 'https://digital.fidelity.com/ftgw/digital/trade-equity/index/orderEntry',
  tradeSymbol: s => `https://digital.fidelity.com/ftgw/digital/trade-equity/index/orderEntry?SYMBOL=${encodeURIComponent(s)}`,
  quote: s => `https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=${encodeURIComponent(s)}`,
  rothIRA: 'https://www.fidelity.com/retirement-ira/roth-ira',
};

// 2026 IRS Roth IRA contribution limit (under age 50).
export const ROTH_LIMIT = 7500;

// Alert engine (trend-following momentum). Periods are in trading days.
export const DEFAULT_STRATEGY = {
  fast: 20,        // fast moving average
  slow: 50,        // slow moving average
  trend: 200,      // long-term trend filter — only buy above it, sell below it
  breakout: 55,    // new N-day closing high also triggers a BUY in an uptrend
  rsiMax: 80,      // skip BUYs when RSI(14) is above this (too stretched)
  trailStop: 12,   // SELL if price falls this % from its high since the BUY
};

// Model Roth IRA simulator defaults.
export const DEFAULT_SIM = {
  capital: ROTH_LIMIT,
  maxPositions: 5,
  startDate: '',       // blank = one year ago
  fractional: true,    // Fidelity supports fractional shares on most US stocks/ETFs
  execNextDay: true,   // fill at the next session's close (no hindsight)
  enterExisting: true, // on day one, buy what's already flagged HOLD
  refill: true,        // when a slot frees up, buy the strongest symbol still in a BUY alert
};

export const DEFAULT_PROJECTION = {
  age: 20,
  retireAge: 65,
  contribution: ROTH_LIMIT,
  rate: 8,
};
