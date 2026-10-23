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

The chart automatically loads EURUSD M1 bid candles for January 9, 2024 (inclusive) through January 10, 2024 (exclusive). Use **Start date** and **End date**, then **Load Data**, to choose another period. Dates are UTC, and the end date must be no later than the current UTC date. Each request covers at most seven completed days.

Choose **1**, **2**, or **3** charts with the **Charts** control. Multiple charts stack vertically with equal initial heights; the workspace scrolls when they cannot fit. Each chart has its own **Timeframe** selector: M1, M5, M15, H1, or H4. Charts may use the same timeframe. The initial selections are M1, M5, and H1, and selections remain when switching layouts.

All timeframes come from the loaded M1 bid candles in the browser. Aggregated candles use UTC-aligned bucket starts, the first available open, highest high, lowest low, and last available close. Missing minutes and market closures stay missing; a bucket with some missing minutes still uses its available candles. The original M1 bid and ask data remain in the API response. Changing a timeframe or layout does not request more history. Changing the date range reloads history once for all charts.

Zooming and horizontal scrolling synchronize the visible UTC period across displayed charts. The crosshair follows the corresponding existing candle bucket when one is available. Synchronization maps each chart's view through candle timestamps rather than matching candle indexes. Around gaps and on very coarse timeframes, the view can differ slightly because each chart has its own candle spacing and Lightweight Charts limits its zoom. A crosshair is cleared on a chart if its corresponding bucket has no candle. Charts do not create candles in missing periods.

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

The React/Vite frontend displays one to three synchronized historical EURUSD bid candlestick charts using TradingView Lightweight Charts. The Node.js backend exposes `GET /api/health` and `GET /api/history`. Charts preserve market gaps and do not hide future candles; replay will handle that later. Indicators, replay, trading, and statistics features listed above are not implemented yet. The approved future stack includes `technicalindicators`; that package is deferred until indicators are built.
