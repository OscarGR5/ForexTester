# ForexTester

ForexTester is a personal, browser-based forex backtesting application for Linux. The MVP focuses on manually replaying EURUSD price action, placing simulated trades, and reviewing backtest results.

## MVP requirements

- Support EURUSD initially.
- Retrieve historical forex data automatically, without MT5 or manual imports.
- Provide multiple selectable timeframes.
- Display one, two, or three synchronized charts at once, including vertically stacked layouts.
- Include Ichimoku Cloud, Bollinger Bands, and Stochastic Oscillator indicators with configurable settings.
- Allow manual simulated buy and sell orders.
- Support multiple simultaneous positions, each with independent stop-loss (SL) and take-profit (TP) levels.
- Provide controls to replay a backtest.
- Show performance statistics and trade history when a backtest finishes.
- Base chart appearance and indicator styling on TradingView references to be supplied later.
- Run as a browser-based application compatible with Linux.

## Prerequisites

- Linux desktop with a current browser
- Node.js 22.12+ (22.x) or 24.x and npm

## Installation

```sh
npm install
```

## Start locally on Linux

Run these commands in separate terminals from the repository root:

```sh
npm run dev:backend
npm run dev:frontend
```

Open the URL printed by Vite, normally http://127.0.0.1:5173. The API health check is at http://127.0.0.1:3001/api/health. Keep both servers running: Vite forwards same-origin `/api` requests to the backend at `http://127.0.0.1:3001`.

The chart automatically loads EURUSD M1 bid candles for January 9, 2024 (inclusive) through January 10, 2024 (exclusive). Use **Start date** and **End date**, then **Load Data**, to choose another period. Dates are UTC, and the end date must be no later than the current UTC date. Each request covers at most seven completed days. The chart supports zoom, horizontal scrolling, and a crosshair; it fits each loaded period on screen and resizes with the window.

## Development commands

```sh
npm run typecheck
npm run test
npm run build
npm run start --workspace backend # starts the built API after npm run build
```

## Historical EURUSD data

The backend downloads EURUSD 1-minute bid and ask OHLC candles from Dukascopy through `dukascopy-node` when a historical period is requested. No broker connection or file import is needed. Dates are UTC calendar dates: `from` is inclusive and `to` is exclusive. Both dates must use `YYYY-MM-DD`, and the end date must be no later than the current UTC date, so only completed days are requested. A temporary 7-day maximum per request limits downloads during testing.

With the backend running, request one day:

```sh
curl 'http://127.0.0.1:3001/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-10'
```

Response shape (candles shortened for display):

```json
{
  "symbol": "EURUSD",
  "resolution": "M1",
  "from": "2024-01-09",
  "to": "2024-01-10",
  "bid": [{ "timestamp": 1704758400000, "open": 1.09497, "high": 1.09504, "low": 1.09492, "close": 1.09501 }],
  "ask": [{ "timestamp": 1704758400000, "open": 1.09499, "high": 1.09509, "low": 1.09496, "close": 1.09504 }]
}
```

`timestamp` is the candle-open time in Unix milliseconds. Bid and ask are separate chronological arrays with no duplicate timestamps. Empty arrays mean the provider returned no candles for that side. Missing minutes, including weekend market closures, are left missing. The API returns HTTP 400 for invalid requests and HTTP 502 with a generic message when the provider fails or returns inconsistent candle data.

The library's filesystem cache is enabled at `.cache/dukascopy/` in the repository root. It stores provider responses by instrument, side, and day. Repeating a completed historical request reads those files instead of downloading the same data again. The directory is Git-ignored and can be deleted to force a fresh download. A WAF token, if acquired, is also stored there.

To run a live integration check, start the backend and run the `curl` command above. Confirm that both `bid` and `ask` contain candles. The automated `npm test` suite uses mocked provider responses and needs no network access. Dukascopy availability, data gaps, and rate limits are outside the application's control. If Dukascopy presents a WAF challenge, `dukascopy-node` needs Chromium. Install its browser helper with `npx dukascopy-node --install-browser`, or set `DUKASCOPY_CHROME_PATH` to an existing Chromium or Chrome executable before starting the backend. If the browser is unavailable during a challenge, the API returns HTTP 502.

## Current status

The React/Vite frontend displays one historical EURUSD M1 bid candlestick chart using TradingView Lightweight Charts. The Node.js backend exposes `GET /api/health` and `GET /api/history`. The chart preserves market gaps and does not hide future candles; replay will handle that later. Additional timeframes and charts, indicators, replay, trading, and statistics features listed above are not implemented yet. The approved future stack includes `technicalindicators`; that package is deferred until indicators are built.
