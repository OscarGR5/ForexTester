# Four charts and trade overlays

The fourth chart mode uses row order H1, D1, M5, H4. Each mode retains its own timeframe and indicator edits. Existing three-slot workspace records remain valid; the fourth mode uses four slots. Viewport validation now accepts pane ID 3, including durable saves and restores.

Executions and SL History use the existing per-session UI preference envelope and default off. Each toggle affects all panes. They do not modify session execution records, replay, orders, valuation, or financial calculations.

The chart primitive renders buy executions as green upward triangles and sell executions as red downward triangles. A closed buy therefore has a green entry and red exit; a closed sell has a red entry and green exit. Completed trades receive subtle dashed directional connectors. Open positions have entries only. Pending orders have no execution marker.

Recorded M1 execution timestamps retain their fractional position within larger timeframe candles. Candle timestamps anchor coordinates even when indicator whitespace adds chart time slots. Historical review suppresses unrevealed entries, exits, and SL replacements.

SL history shows the original and subsequent retired levels as horizontal rays extending to both chart edges for currently open positions only. They remain visible when panning beyond their original time intervals. A pending close request keeps these lines visible until execution; closing removes them from every pane without deleting stored SL history. An unchanged open position has no retired level. Thin dashed lines use 28% opacity, without axis labels, drag targets, or autoscale changes. Existing active SL lines and annotations remain unchanged. Overlay data is not derived while both toggles are off; rendering clips and culls offscreen records.

## Verification

- `npm test -- --maxWorkers=2`: 924 tests passed across 67 files.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- Four-mode defaults, independent edits, legacy workspace compatibility, disk restoration, fourth-pane viewport validation, replay navigation and pane independence.
- Open/closed buy and sell markers, multiple trades, original and multiple modified SLs, restored records, rendering toggles, actual-time coordinates across all six supported stored timeframes, and historical-review cutoff behavior.
- Production-bundle Chromium checks at 1100 × 800 and 1440 × 1000. The harness uses synthetic bid/ask history and isolated temporary disk sessions; it does not access user sessions or a history provider.
- Browser checks cover switching 1/2/3/4 layouts, 2×2 placement, all visible timeframe choices in every pane, indicators, drawing toggles, restored preferences, synchronized replay cursors, historical review, zero optional drawing when disabled, no horizontal overflow, no external requests, and no page errors.

Reproduce browser checks after `npm run build`:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/chart-overlays-browser.mts
```

Machine-readable evidence is in `browser-verification.json`; screenshots show overlays off, four charts with both overlays on, and the Indicators menu at both viewport sizes.

## Display limitations

Coincident executions share their exact chart location and may overlap. Short executions and SL intervals compress at coarse timeframes. Historical levels outside the current price range are clipped, preserving the existing chart scale. Execution timing is limited to the precision stored in the original M1 records; no intraminute fill time is inferred.

The production build retains the existing Vite warning for a JavaScript chunk above 500 kB. No dependencies were added.
