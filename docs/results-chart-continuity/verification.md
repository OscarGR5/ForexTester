# Results chart continuity

The previous renderer started a new SVG subpath at every clock gap except a proven constant account with no intervening exposure. That deliberately left weekends with held positions disconnected, even when both endpoint valuations existed. Null or invalid valuations also discarded the last valid endpoint instead of connecting it to the recovery.

Each series now renders ordinary connections and a separate set of subtle dashed straight bridges. Confirmed flat gaps remain solid. Clock gaps with exposure, missing M1 observations, and unavailable series values connect their nearest valid endpoints with dashed bridges. A clock gap records elapsed time, not a market calendar, so exposed market closures use the same treatment as other missing intermediate marks. No intermediate observations are generated. Below-start drawdown now reserves dashes for missing observations too.

Downsampling retains both sides of equity and drawdown validity transitions, including nonfinite equity. It still retains financial extrema and clock-gap neighbors. Both charts share the original domain, filtered observations, and hover timestamp. Exposed clock-gap interiors remain unavailable on hover; flat gaps select a real endpoint. The domain still begins the UTC day before the first executed trade.

Financial production code, trade records, persistence, and provider code are unchanged.

## Verification

- Complete suite: 57 files, 775 tests pass, using `npm test -- --maxWorkers=2`.
- `npm run typecheck`, `npm run build`, and `git diff --check` pass. Vite reports its existing bundle-size advisory.
- Deterministic fixtures cover held and flat weekends, missing M1 observations, unavailable marks, changed equity, distinct peak and starting-balance drawdowns, and nonzero drawdown on both sides of gaps.
- Unit checks verify one rendered edge per consecutive valid observation, real endpoint timestamps and values, unchanged ledger and KPIs, no extrapolation without two valid endpoints, and retained validity transitions under downsampling.
- Browser checks render the production ResultsCharts component and stylesheet without the App, backend, session storage, or providers. API and external network requests are blocked. All eight width/unit/range combinations pass, with no page errors or forbidden requests.
- DOM checks verify connection counts for every series, solid ordinary paths, subtle dashed bridges, shared axes, real synchronized keyboard readouts, preserved pointer behavior, immutable fixture data, and SVG sizing.
- Screenshots were visually inspected at 1100px and 1440px. All bridgeable gaps connect, including the exposed weekend slope and the two changed-value bridges in the M1 detail view. The flat weekend is horizontal and solid in all series. Distinct nonzero drawdown lines remain connected.

Reproduce the browser check using the existing verification-only Playwright installation:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chromium node --import tsx scripts/results-continuity-browser.mts
```

The script creates and removes a temporary entry module, uses a temporary Vite cache, and writes only the evidence in this directory. It never opens or changes saved sessions.

| View | 1100px | 1440px |
| --- | --- | --- |
| Weekends, % | [Screenshot](weekends-percent-1100.png) | [Screenshot](weekends-percent-1440.png) |
| Weekends, USD | [Screenshot](weekends-usd-1100.png) | [Screenshot](weekends-usd-1440.png) |
| M1 gaps, % | [Screenshot](m1-detail-percent-1100.png) | [Screenshot](m1-detail-percent-1440.png) |
| M1 gaps, USD | [Screenshot](m1-detail-usd-1100.png) | [Screenshot](m1-detail-usd-1440.png) |

Machine-readable DOM evidence: [browser-evidence.json](browser-evidence.json).
