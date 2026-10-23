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
- Use a TradingView-inspired dark chart template and indicator styling.
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

## Market replay

The initial chart view shows the full loaded history. Choose **Start Replay** to hide that history and enter replay paused at the first available M1 bid candle. The toolbar shows the simulation timestamp in UTC, status (**Ready**, **Playing**, **Paused**, or **Complete**), and revealed/total M1 candle count.

- **Play** advances one available M1 candle every 250 ms.
- **Pause** freezes the revealed market state.
- **Next Candle** advances exactly one available M1 candle while paused.
- **Restart** returns the current dataset to its first candle, paused.

Playback stops automatically at the final candle and shows **Complete**. Controls are disabled when their actions are unavailable. A dataset containing one candle is complete immediately on starting replay. There is no speed selector or saved replay session.

All charts share one simulation clock, regardless of their timeframes or the number of charts displayed. Timeframe and layout changes preserve the clock, playing/paused state, and revealed history. Loading a historical period clears the session and returns to the full-history viewer; start a new replay explicitly. Editing date inputs alone does not load data or reset replay. Missing M1 minutes and weekend closures are skipped directly, without synthetic candles or waiting through the missing period.

During replay, chart data is built only from the revealed M1 prefix. Each M1 candle is revealed as a whole OHLC bar at its candle-open timestamp; this is candle replay, not a reconstruction of intraminute ticks. M5, M15, H1, and H4 buckets use UTC boundaries and evolve using only those revealed bars. At 10:32 UTC, for example, the current H1 candle starts at 10:00 and the current H4 candle at 08:00; neither can use M1 data later than 10:32. Buckets at the beginning or end of a loaded period may also be incomplete.

Chart instances remain alive while replay advances or timeframes change. The current series candle is updated and new buckets are appended. The synchronized view follows the latest revealed data when viewing the replay edge. Scrolling back preserves an older view while playback continues; navigating back to the edge resumes following. Zooming, scrolling, and crosshairs have access only to revealed prices. Different candle spacing and minimum zoom limits can still produce slightly different views on coarse timeframes, especially early in replay when only one bucket exists.

Replay inherits the historical-data limitations below: EURUSD bid charts only, provider gaps and availability, completed UTC days, and at most seven days per request. Simulated market entries and manual exits use this same clock, as described below. Tick replay, automatic SL/TP execution, performance statistics, journaling, and replay persistence are not implemented.

## Simulated trading

The **Simulated trading** panel accepts a positive, finite position volume in standard FX lots, initially **0.01**. One EURUSD lot represents **100,000 EUR** of base-currency exposure. Choose **Buy** or **Sell** while replay is active and paused. Trading is disabled in the full-history viewer, during playback, and at the final candle. There must be a later M1 bid candle available to advance to; the application does not look ahead for future quote availability.

At most **two position slots** can be in use. Pending entries and open positions both consume slots, including positions with a pending close. Each entry keeps its own volume. **Cancel** removes an unfilled entry and releases its slot. **Close** queues a manual exit; duplicate close requests are disabled. Pending entries can be cancelled during playback or after history ends. Entry, open, pending-close, and closed states are labeled separately.

Each revealed M1 OHLC bar is treated as an observed, completed candle for trading decisions, although its replay timestamp is the candle’s opening timestamp. An order requested after observing candle N can execute only at a later available M1 opening, never inside candle N. **Next Candle** or **Play** advances the shared clock and processes pending orders chronologically, including all intervening bars when React batches several clock updates. Visual zoom, scrolling, crosshairs, timeframes, and layouts never control execution.

Execution uses historical EURUSD prices, with both bid and ask candles required at exactly the same timestamp:

| Action | Fill price |
| --- | --- |
| Buy entry | Ask open |
| Sell entry | Bid open |
| Close Buy | Bid open |
| Close Sell | Ask open |

Multiple queued orders fill independently at that opening. High, low, and close never select an execution price. Missing minutes and weekend/overnight gaps advance directly to the next available bid candle. If its ask is missing or has a different timestamp, orders remain pending until a later synchronized quote appears. Ask-only timestamps do not advance the bid replay clock. Prices are never invented or interpolated.

Open positions show their entry time/price, direction, volume, current closing-side price, and unrealized PnL. Buys are valued at the revealed **bid close** and sells at the revealed **ask close**. The current observed candle must have synchronized bid and ask data; otherwise current price and PnL show **unavailable**, without carrying a stale valuation forward. Closed trades show their actual entry and exit prices/times and realized PnL.

For EURUSD, **1 pip = 0.0001**. Signed price difference is exit or current price minus entry for buys, and entry minus exit or current price for sells. **Pips = signed difference / 0.0001**; **gross USD PnL = signed difference × 100,000 × lots**. For example, a 0.01-lot buy at 1.10020 closed at bid 1.10120 yields 10.0 pips and $1.00 gross. All PnL is **gross, before commissions, swaps, and financing**, not net PnL or account equity.

Calculations retain JavaScript number precision. Display values use fixed decimal rounding: **5 decimals for prices, 1 for pips, 2 for USD**. Volumes retain the entered numeric value, and values that round to zero display without a minus sign. All timestamps are UTC to the minute.

**Restart**, including at the first replay candle, clears pending entries, open positions, and closed trades. Loading a dataset also clears all trading records and returns to the full-history viewer. Timeframe/layout changes preserve positions and pending orders. At the final candle, remaining positions are labeled **open at end of available history**. Unfilled entries or close requests stay pending. No position is force-closed and no exit price is assumed.

Trading state is session-only, in memory. The pure TypeScript engine in `frontend/src/trading.ts` owns execution rules and transitions; `useTrading.ts` consumes the existing replay clock and processes every newly revealed bid candle with its matching ask. Chart components do not own trading state. IDs are deterministic and unique within and across replay sessions on the current page. Automated tests use local fixtures and controlled timers, with no live-data dependency.

Current limitations: EURUSD only; M1 candle replay, with no intraminute or tick-price assumptions. **Automatic SL/TP, commissions, swaps, financing, risk-based sizing, margin/leverage simulation, account balances/equity, equity curves, full performance statistics, strategy signals, and persistence are not implemented.** The historical-data backend and its seven-day request limit are unchanged.

## Chart appearance

The TradingView-inspired template uses a dark navy canvas, white bull bodies, blue bear bodies, white borders/wicks, hidden grid lines, light gray scale text, a light pane separator, and subtle dashed gray crosshairs. TradingView attribution remains enabled. The toolbar and vertically stacked 1 / 2 / 3 chart layouts retain their existing behavior. Styling is an approximation of the approved reference summary, with further fine-tuning possible.

## Technical indicators

Open **Indicators** in a chart's toolbar, check an indicator, and edit its numeric fields. Valid changes apply immediately. Each chart initializes a timeframe with its automatic preset on first selection:

| Timeframe | Enabled indicators |
| --- | --- |
| M1 | None |
| M5, M15 | BB #1 (20/2), BB #2 (20/1), slow Stochastic (30/10/10) |
| H1, H4 | Ichimoku (9/26/52/26) |

Each chart remembers separate settings for every visited timeframe. Returning to a timeframe restores its manual edits, including enabled indicators, numeric parameters, and line visibility. New panes use their selected timeframe’s preset. Users can enable any indicator on any timeframe. Settings survive layout changes, replay restarts, and date reloads within the session. They are not saved across page refreshes. Styling and line visibility defaults remain as listed below. Indicator changes do not reset replay or request more history. Uncheck an indicator to remove its lines, pane, and drawing resources.

| Indicator | Initial parameters | Display |
| --- | --- | --- |
| BB #1 | Close length 20; standard deviation multiplier 2; SMA basis | White upper/lower lines and visible blue basis over price |
| BB #2 | Close length 20; standard deviation multiplier 1; SMA basis | White upper/lower lines; blue basis hidden by default |
| Slow Stochastic | %K length 30; %K SMA smoothing 10; %D SMA smoothing 10 | Separate resizable pane below price, 0–100 scale, blue %K, orange %D, reference levels 80 and 40 (no 50 line) |
| Ichimoku | Tenkan 9; Kijun 26; Span B 52; displacement 26 | Light blue Tenkan, green Kijun, yellow-lime Chikou, gray leading spans and translucent gray-blue/gray cloud |

Periods, smoothing, and displacement accept whole numbers from 1 to 10000. Bollinger's multiplier accepts positive decimals up to 100. Invalid edits show an error and leave the last valid setting applied. Both Bollinger overlays can coexist, with independent lengths, multipliers, and Basis/Upper/Lower visibility controls per chart. Source is fixed to close and basis MA to SMA. The TradingView-inspired appearance remains provisional; color fine-tuning may follow. Temporary line and cloud colors are centralized in `frontend/src/indicatorSeries.ts` and `frontend/src/ichimokuCloud.ts`.

Calculations use `technicalindicators` 3.1.0 independently of chart rendering. Bollinger Bands use the population standard deviation. Slow Stochastic first calculates raw %K from rolling highs/lows, smooths it with an SMA, then smooths slow %K with another SMA for %D. A flat high/low window makes raw %K undefined; it is omitted and smoothing restarts. The package's Ichimoku helper delays all components until its longest lookback, so the application uses its rolling Highest/Lowest calculations to calculate each component as soon as its own window is available.

There are no filled or invented warm-up values. Default Bollinger Bands need 20 available chart candles. Stochastic %K first appears at candle 39 and %D at candle 48. Ichimoku Tenkan needs 9 candles, Kijun and Span A need 26, and Span B and the paired cloud need 52. Chikou plots known closes 26 candle positions earlier, skipping positions before the loaded history. Missing minutes and closures remain missing.

Ichimoku Span A is the average of Tenkan and Kijun; Span B is the midpoint of the 52-period high/low. They plot 26 candle positions ahead. Within known history, displacement follows actual candle positions across gaps. Beyond the revealed edge, timestamps extend by the selected timeframe interval, using whitespace time slots without OHLC data. As a gap becomes known, projected timestamps are realigned to the newly revealed candle positions. Cloud fill is split at interpolated Span A/B intersections so its color changes at the crossover. The chart reserves room for the projected horizon at the current edge; synchronized crosshairs still require a real price candle.

During replay, all indicators use only the revealed M1 prefix aggregated to the selected timeframe. The current incomplete higher-timeframe candle recalculates as M1 candles arrive. Forward Ichimoku positions contain calculations from known candles only, and Chikou uses already known closing prices. Restart clears prior indicator observations and recalculates from the first revealed candle. Timeframe changes recalculate from the available prefix; loading dates returns to the full-history viewer. Indicators do not request additional history.

The seven-day backend limit remains in place. Short ranges and coarse timeframes may never provide enough candles for default settings, especially around market closures. In particular, seven calendar days contain at most 42 H4 positions, so default H4 Span B/cloud cannot warm up in one request. Reduce periods to inspect shorter histories; the application does not pad them or fetch extra data.

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

To run a live integration check, start the backend and run the `curl` command above. Confirm that both `bid` and `ask` contain candles. The automated `npm test` suite uses deterministic fixtures, mocked provider responses, and controlled replay timers; it needs no network access. Dukascopy availability, data gaps, and rate limits are outside the application's control. If Dukascopy presents a WAF challenge, `dukascopy-node` needs Chromium. Install its browser helper with `npx dukascopy-node --install-browser`, or set `DUKASCOPY_CHROME_PATH` to an existing Chromium or Chrome executable before starting the backend. If the browser is unavailable during a challenge, the API returns HTTP 502.

## Current status

The React/Vite frontend displays one to three synchronized historical EURUSD bid candlestick charts using TradingView Lightweight Charts. The Node.js backend exposes `GET /api/health` and `GET /api/history`. Charts preserve market gaps. The full-history viewer remains available until replay starts; manual replay then progressively reveals M1 data with synchronized partial higher-timeframe candles. Bollinger Bands, slow Stochastic, and Ichimoku Cloud are available independently on each chart, including during replay. Automatic indicator presets and simulated market orders are available. Automatic SL/TP execution, statistics, and journaling are not implemented yet.
