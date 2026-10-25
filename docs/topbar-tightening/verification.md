# Compact workspace and future-side chart margin

Branch: `feat/topbar-tightening-and-chart-margin`, based on `7667850` from `main`. No automatic merge.

The toolbar now gives replay and chart controls one compact group, with sizing, risk, Buy/Sell and slots to its right. At 1100px, those groups use two compact rows. The header holds the UTC replay timestamp immediately left of Account PnL, plus an accessible Execution details info disclosure beside the session context. Contract mappings are nested inside that disclosure. Ready-for-setup and next-fill messages no longer occupy persistent workspace space. New 6E sessions display `EURUSD 6E`; legacy EURUSD sessions keep their original identity.

Readiness lives in the same grid row as instrument, timeframe and Indicators. It wraps inside its own column in narrow panes. Settings remain an absolutely positioned, scrollable overlay, so opening them cannot change the toolbar columns or canvas dimensions.

## Navigation

`ChartPane` disables the native fixed right edge and supplies a 12-bar `rightOffset`. `ChartSynchronizer` controls the visible logical range: replay-follow uses 12 bars or the larger existing indicator projection; manual panning allows up to 40% of the visible span as future-side margin, capped at 80 bars unless indicator projection requires more. This gives a useful margin without permitting arbitrarily empty canvases. Zoom retains its right anchor until the margin bound requires correction.

A manual margin beyond the normal follow offset disengages replay-follow. Returning within half a logical bar of that normal offset resumes following. Each pane retains independent navigation, including save/restore. No market observations or price values are added for whitespace. Existing Ichimoku projection and its future-axis times remain valid derived indicator output, not unrevealed candles.

## Verification

| Check | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 48 files, 614 tests passed |
| `npm run typecheck` | Passed, frontend and backend |
| `npm run build` | Passed, frontend and backend; existing >500 kB chunk warning |
| `git diff --check` | Passed |
| Chromium | 1440 × 1000 and 1100 × 800, all 1/2/3-chart layouts |
| Toolbar | 43px at 1440px; 77px at 1100px |
| Indicator settings | Timeframe, Indicators, readiness and canvas bounding boxes identical before opening, while open and after closing, every pane in all six layouts |
| Future margin | With entries/SLs, real drags create 80 bars / 484.7px on desktop and 67.4 bars / 408.8px on laptop; other panes retain their ranges and replay leaves manual ranges unchanged |
| No lookahead | Candle series data identical before/after panning; latest candle stays at/before the replay clock; no candle value under the crosshair in future margin |
| Overlays and persistence | Pending and filled entry lines, independent SLs, chart confirmation, keyboard validation, Escape, laptop confirmation, refresh and backend restart passed |
| Provider and cache | 0 provider requests; 0 paid submissions; SHA-256 manifest of the existing cache unchanged |

The deterministic additions cover normal follow offsets, bounded manual margins, independent views, replay ticks, viewport restoration, empty-margin crosshair behavior, legacy/6E display labels, header disclosure, timestamp placement and readiness membership in the control row. Existing execution, cost/credit, rollover, D1 and saved-session tests remain in the full passing suite.

[Raw Chromium measurements](browser-evidence.json) include toolbar geometry, every open/closed navbar comparison, logical right offsets, candle coordinates, entry-line evidence and restore results.

## Screenshots

| State | Desktop | Smaller laptop |
| --- | --- | --- |
| Before, main | [1440px](before-1440.png) | [1100px](before-1100.png) |
| After, one chart | [1440px](after-1-charts-1440.png) | [1100px](after-1-charts-1100.png) |
| After, two charts | [1440px](after-2-charts-1440.png) | [1100px](after-2-charts-1100.png) |
| After, three charts | [1440px](after-3-charts-1440.png) | [1100px](after-3-charts-1100.png) |
| Execution info | [1440px](execution-info-1440.png) | [1100px](execution-info-1100.png) |
| Indicators open | [1440px](indicators-open-1-1440.png) | [1100px](indicators-open-1-1100.png) |
| Margin, entries and SLs | [1440px](margin-with-stops-1440.png) | [1100px](margin-with-stops-1100.png) |

[Margin after dragging](future-margin-1-0.png), [three-pane margin](future-margin-3-2.png), [three-pane settings](indicators-open-3-1100.png), [draft stop confirmation](draft-sl-tick-1100.png), [restore after backend restart](entries-restored-after-backend-restart.png).

Before screenshots use unchanged `main` frontend sources with the same offline harness, cache and initial replay selection. Temporary sessions are isolated from the user's sessions. The harness rejects all provider methods and uses a zero-dollar test budget. Reproduce with:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/chart-toolbar-browser.mts
```

## Support and limitations

Smartphone-specific CSS, stacked-pane branches, phone-width Chromium checks and phone-only touch emulation have intentionally been removed. Current browser scripts use desktop/laptop widths instead. The shell has a 1000px minimum width; phone layouts are unsupported. Historical phone screenshots and reports remain as archived evidence.

Browser evidence is from Linux Chromium, not Firefox or Safari. Dense three-pane layouts wrap readiness inside its column. The future margin is controlled in logical bars rather than a new user setting. Existing large indicator projections can exceed the nominal whitespace cap. Native disclosures close through their summary controls; they do not dismiss automatically on outside clicks. The mechanical design scan flagged only the existing Inter font required by DESIGN.md and the existing amber timeline contract marker; both were retained.

Databento provider code, history/cache rules, financial formulas, journal outcomes, session schemas and rollover behavior were not changed. No paid request was made. No outstanding product decision is required for this scope.
