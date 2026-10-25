# Replay header and auto-follow verification

Verified October 25, 2026, against the existing local Databento cache with isolated temporary sessions. Base: `0600db9`, merged PR #29. No changes to provider/download logic, execution, history fingerprints, cache files, user sessions or saved-session formats.

Replay actions, speed, chart count, compact status/progress and Finish backtest now occupy the application header. The lower toolbar is dedicated to risk, order entry and full-width position management. Readiness uses the existing calculation inside each Indicators dropdown.

## Checks

- `npm test -- --maxWorkers=2`: 658 tests passed across 51 files.
- `npm run typecheck`: frontend and backend passed.
- `npm run build`: frontend and backend passed. Vite retains its existing bundle-size warning.
- `git diff --check`: passed.
- Impeccable layout scan: no findings on the changed interface files.

The deterministic additions cover header placement, native disabled fieldsets for initialization/storage/conflicts/startup/finishing, modal disabling, readiness settings/timeframes/progress, paused views, visibility thresholds, projection margins, unchanged OHLC, higher timeframes, 1/10/100-observation batches, per-pane independence, historical review and viewport restoration. Existing execution, gap, rollover, stop and session tests remain in the complete suite.

## Chromium

Run from the repository root with the existing cache and an external verification-only Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/replay-header-browser.mts
```

The script refuses all provider methods and paid submissions. Browser requests are restricted to the local test server. Sessions and Vite cache use a new temporary directory. The complete cache, including its spending ledger, is hashed before and after verification.

The final run recorded **0 provider requests, 0 paid submissions, 0 page errors, and an unchanged cache manifest**. All 1/2/3-chart combinations were measured at 1440 × 1000, 1100 × 800 and 1000 × 800. The header uses one row at 1440px and a controlled second replay row at smaller widths. Bounding rectangles confirm that header groups and replay controls do not overlap. An additional PnL text stress check uses `$-12345.67 · -12.35%`. Opening Indicators preserves toolbar geometry; Escape hides readiness with the panel. Execution details stays inside the viewport at every measured size.

Real mouse and keyboard interactions cover pan while playing, pan while paused, Next Candle, Shift + Right, Shift + Left, higher-timeframe partial updates, 100× playback, independent manual views, Save now, refresh/resume, pending/open positions and stop dragging. During an actual stop drag every replay action, speed and chart-count control is disabled; Escape restores them. Management also disables the entire replay fieldset.

## Latest-candle coordinates

Coordinates use `timeScale().timeToCoordinate(lastCandle.time)` and `timeScale().width()`. Width excludes the right price axis. A visible candle must satisfy `0 < x < plotWidth - 1`.

| Scenario | Before x (px) | After x (px) | Plot width (px) |
|---|---:|---:|---:|
| 1 chart, Next Candle | 2199.23 | 277.23 | 1358 |
| 2 charts, Next Candle | 1088.94 | 130.94 | 644 |
| 3 charts, H1 partial update | 1088.94 | 130.94 | 644 |
| Partial H4 candle | 1432.67 | 471.67 | 1358 |
| Partial D1 candle | 1680.86 | 719.86 | 1358 |

Before values beyond the plot width deliberately reproduce the invisible-candle failure. After values are inside the plot. The same logical span is retained and only the affected manual pane resumes following.

A separate running test began with the newest candle still visible at **1258.65px / 1358px** after a real pan. Replay continued without another chart click, then recovered at **1231.65px / 1358px** with the normal **12-bar** future margin and the same **134.43-bar** span. Following continued afterward. H4 and D1 partial tests retained the plotted bar count while updating the current candle. Another H1 case advanced without changing OHLC at all.

Historical review kept the manual viewport and its cutoff authoritative; returning to the live cursor recovered visibility. Save/refresh/resume preserved all three panes' time ranges, follow flags and price-scale settings, including a vertical range adjusted with a real price-axis wheel interaction.

The cached replay was then advanced with real D1 shortcuts through market gaps to its contract rollover block at **2024-03-17T23:10:00+00:00**. All three charts remained within the revealed prefix. Play and Next Candle were disabled, and an additional Shift + Right left the execution cursor, trading state and replay timestamp unchanged.

## Screenshots and raw evidence

| Evidence | Links |
|---|---|
| Header before | [1440px](before-1440.png), [1100px](before-1100.png), [1000px](before-1000.png) |
| Header after, 1 chart | [1440px](after-1-1440.png), [1100px](after-1-1100.png), [1000px](after-1-1000.png) |
| Header after, 2 charts | [1440px](after-2-1440.png), [1100px](after-2-1100.png), [1000px](after-2-1000.png) |
| Header after, 3 charts | [1440px](after-3-1440.png), [1100px](after-3-1100.png), [1000px](after-3-1000.png) |
| Indicator readiness | [Open Indicators panel](indicators-readiness.png) |
| Running boundary recovery | [Before boundary](running-before-boundary.png), [After recovery](running-after-boundary.png) |
| Running pan recovery | [1 chart](auto-follow-recovered-1.png), [2 charts](auto-follow-recovered-2.png), [3 charts](auto-follow-recovered-3.png) |
| Fast replay and review | [100× recovery](100x-recovery.png), [Historical review](historical-review.png) |
| Active/pending positions | [1440px](positions-1440.png), [1100px](positions-1100.png), [1000px](positions-1000.png) |
| Guards and rollover | [Stop-drag guard](stop-drag-header-disabled.png), [Rollover block](rollover-blocked.png) |
| Measurements | [browser-evidence.json](browser-evidence.json) |

## Limits

Chromium desktop verification only; the documented 1000px minimum remains. At extreme zoom a full Ichimoku projection margin can exceed the visible span, so the future margin shrinks enough to keep the market candle visible while preserving zoom. Projected indicator data and existing manual right-margin limits remain unchanged. Verification instrumentation exists only in the browser script's Vite transform, with no production debug API or new dependency.
