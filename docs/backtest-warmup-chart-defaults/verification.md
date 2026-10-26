# Backtest setup, warm-up, and chart defaults verification

## Implementation

New backtests use a $7 USD per-standard-lot round-trip commission and open with two charts: H4 Ichimoku and D1 Ichimoku. One-chart mode initializes as D1 Ichimoku. Three-chart mode initializes as M5 with both Bollinger Bands and Stochastic, plus H4 and H1 with Ichimoku. Each chart-count mode keeps its own edited timeframes and indicator settings after first initialization. Saved workspaces without the new per-mode map remain valid and are not rewritten with new defaults.

The D1 Ichimoku warm-up requirement is derived from the active settings as `max(Tenkan 9, Kijun 26, Span B 52) + displacement 26 = 78` completed D1 candles. The setup calendar aggregates genuine cached observations, counts only completed timeframe buckets strictly before the replay boundary, and resets at an instrument/contract change. Replay remains start-inclusive and end-exclusive; warm-up is loaded separately and does not reduce the selected 7, 30, 90, 180, or 365 calendar days.

Random Range enumerates each cached calendar date as a possible 120-day start. A candidate is eligible only when every replay calendar day has a verified cache entry, invalid days are absent, an actual replay observation exists inside the window, and all active indicator requirements are satisfied before the start. Explicit gap entries remain valid market closures and do not manufacture candles. Prepared day and timeframe indexes keep the scan linear in the practical archive size. Selection is uniform across the resulting start dates, including dates in separate eligible intervals.

Random selection reads the already loaded local cache calendar only. It makes no history request when selecting dates. Starting the replay performs one request to the local backend for the already installed Parquet range, including the validated warm-up start. There is no external provider, pricing, estimate, download, or purchase path in this flow.

## Automated verification

- Full suite: `npm test -- --run --reporter=dot --maxWorkers=1` passed, 60 files and 786 tests.
- Type checking: `npm run typecheck` passed for frontend and backend.
- Production build: `npm run build` passed. Vite retained its existing warning that the main minified chunk exceeds 500 kB.
- Chromium: `scripts/backtest-defaults-browser.mts` passed at 1100 × 800 and 1440 × 1000 with zero page errors, external requests, paid-request routes, or horizontal overflow.
- Browser checks confirmed the visible $7 commission, default chart count, 180-day control, cached-only Random Range selection, every default indicator/timeframe layout, and restoration of a customized one-chart mode after switching layouts.
- The final Impeccable UI detector reported no findings for `frontend/src/App.tsx`.

Machine-readable results: [browser-verification.json](browser-verification.json).

## Screenshots

Setup history controls: [1100px](setup-1100.png) · [1440px](setup-1440.png)

Visible backtest name and commission: [1100px](setup-details-1100.png) · [1440px](setup-details-1440.png)

One chart: [1100px](charts-1-1100.png) · [1440px](charts-1-1440.png)

Two charts: [1100px](charts-2-1100.png) · [1440px](charts-2-1440.png)

Three charts: [1100px](charts-3-1100.png) · [1440px](charts-3-1440.png)

## Limitations

Browser verification covers installed local EURUSD Parquet history in Chromium at the supported desktop widths. It does not add or exercise an external provider, and it does not claim coverage for mobile or other browser engines.
