# Results chart window, continuity, and resume verification

Changes target PR #35 on `feat/unified-results-dashboard`.

Account Equity and Drawdown Comparison share an explicit UTC domain starting at midnight on the day before the earliest executed entry, clamped to the first ledger timestamp. Sessions without fills retain their full timeline. Filtering precedes downsampling; no observations are synthesized. Full-resolution KPI calculations, ledger records, monthly attribution, setup R, and storage schemas are unchanged.

Clock gaps connect only when the real full-resolution neighbors have valid, equal cash/equity, zero unrealized PnL, no missing required quotes, and executed entry/exit intervals establish no exposure during the gap. Exposure is checked independently of endpoint PnL. Both drawdown series use the same confirmed gaps; unavailable series values still break their paths. Pointer inspection selects actual observations and displays their original timestamps.

Results offers **Resume Backtest** before Save now and Export trades. It pauses replay, uses the existing save queue, changes only the lifecycle, and retains the replay/trading hooks and chart synchronizer. Failed lifecycle saves restore Results and surface the existing storage error. Complete or rollover-blocked sessions show **Return to charts**, retain execution restrictions, and offer **Review Results** in Trading.

## Automated checks

```sh
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

All 773 tests passed across 57 files. Both workspace typechecks and production builds passed; `git diff --check` was clean.

Targeted regressions cover first-fill timing, open-only and unordered executed positions, no fills, the first real observation, a holiday without a midnight observation, shared chart domains, full-resolution KPIs, flat weekend/holiday connections, intervening exposure and cash changes, unavailable valuations, genuine hover timestamps, and a 129,600-observation ledger with bounded path geometry.

Production-App tests cover finish/resume/new-trade/finish, exact trading and equity-prefix preservation, modified stops and pending orders, different chart timeframes and a manual viewport, finished-session reload and resumed-session reload, conflicting saves, failed lifecycle persistence, natural exhaustion, rollover blocking, and single next-candle execution.

The existing Vite warning about a bundle over 500 kB remains. No dependencies were added.

## Chromium

Run `scripts/results-dashboard-browser.mts` with `tsx`, setting `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` to existing local installations when needed. The runner uses synthetic weekday M1 history and isolated temporary filesystem sessions. It exposes no provider implementation, blocks paid/external requests, and does not read or modify user history/cache.

[Browser evidence](browser-evidence.json) records checks at **1100px and 1440px**, zero browser errors, zero provider/history requests, zero external requests, and zero paid submissions.

The populated fixture retains 93,600 observations from January 1 through March 29, 2024. Its first executed entry is January 11 at 00:01 UTC; both chart domains begin January 10. All three paths have one continuous segment because this fixture is flat during each weekend. The two charts use 27 SVG child nodes combined. Separate regressions preserve gaps during exposure and missing valuations.

The unfinished fixture has 801 observations, one closed position, one open position, and one pending order. Browser verification finishes and reloads it, resumes paused with matching trading records, replay cursor, equity summary, chunk hashes, and workspace preferences, then reloads Trading. Only an explicit Next Candle executes the pending order and appends one observation. Existing closed trades remain unchanged.

| Screenshot | Evidence |
|---|---|
| [Entire dashboard](populated-dashboard.png) | Shortened Account Equity and Drawdown Comparison domains; connected flat intervals |
| [Results at 1100px](populated-1100.png) | Narrow desktop chart and header layout |
| [Results at 1440px](populated-1440.png) | Wide desktop chart and header layout |
| [Resume at 1100px](resume-action-1100.png) | Primary Resume Backtest action before save/export |
| [Resume at 1440px](resume-action-1440.png) | Same action with an unfinished backtest |
| [Trading at 1100px](resumed-trading-1100.png) | Paused, preserved timestamp and trades, two charts and separate timeframes |
| [Trading at 1440px](resumed-trading-1440.png) | Preserved chart viewport, indicators, open position, and pending order |

Full-dashboard screenshots temporarily expand the scrolling Results surface for capture. Viewport screenshots and layout measurements use the ordinary application shell. Visual inspection found no material layout defects; the UI detector reported no findings.
