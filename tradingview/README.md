# Untaken Highs/Lows for TradingView (experimental)

Standalone Pine Script v6 port of ForexTester's **confirmed-only** Untaken Highs/Lows indicator. Red rays represent unbroken local highs, green rays unbroken local lows. A last candle's extreme is never plotted merely because it exceeds the preceding candle.

This branch also updates the ForexTester tracker to the same rules. Neither implementation has been verified inside TradingView yet.

## Install

1. Open [untaken-highs-lows.pine](./untaken-highs-lows.pine) and copy the whole file, including `//@version=6`.
2. In TradingView, open a standard time-based candlestick chart and select **Pine Editor**.
3. Create a new indicator, replace the template, save, and select **Add to chart**.
4. Adjust the high/low visibility, level limits, line colors and width in the indicator settings.
5. Report any Pine compilation/runtime error with the exact message and line number.

No external libraries, data sources, or imports are required.

## Detection and display rules

- **Single-candle high:** `previous high < candidate high > following high`. The following candle **must close** before the candidate becomes a ray. Low: `previous low > candidate low < following low`.
- **Equal-price plateau:** Consecutive exact equal high/low wicks form one candidate. Its first candle is the anchor. A weaker candle must occur immediately before and immediately after the plateau, with the right-side candle closed. Each side is tracked independently.
- **Latest candle:** Never marked as a pivot without a confirmed right neighbor, even when already closed. Candidates and forming plateaus are internal state only, not visible rays. A weaker *forming* right candle does not confirm anything.
- **Invalidation:** A confirmed high is taken immediately when a subsequent wick reaches or exceeds its price; a low is taken on a wick at or below its price. This also applies to the realtime forming candle. A newly forming candidate at the same price does not replace the ray until independently confirmed later.
- **Selection:** Display nearest untaken confirmed highs strictly above the latest close, and nearest confirmed lows strictly below it. Hidden old levels remain tracked. Selection budgets are per side and do not change detection.
- **History/replay:** Only loaded historical candles participate. Pine evaluates closed historical bars and uses `barstate.isconfirmed` to confirm realtime right neighbors. ForexTester processes revealed candles and its timeframe aggregation separately. No future candles may influence historical snapshots.

## Settings

| Setting | Default | Details |
| --- | --- | --- |
| Show untaken highs | On | Independent visibility toggle |
| Show untaken lows | On | Independent visibility toggle |
| Maximum displayed highs | 10 | 1–250, closest eligible confirmed levels |
| Maximum displayed lows | 10 | 1–250, closest eligible confirmed levels |
| High line color | Red `#ef5350` | Pine line color |
| Low line color | Green `#26a69a` | Pine line color |
| Line width | 1 | Range 1–4 |

The Pine drawing limit is 500 line IDs. The indicator explicitly deletes previous lines before redrawing the last-bar snapshot and stores offscreen historical levels as arrays, not line objects.

## Manual verification

### Small three-candle case

For a sequence with highs `101, 110, 101` and lows `99, 90, 99`, with candle closes near `100`:

1. After candle 1 closes, there must be no rays.
2. While candle 2 is forming with the weaker high/low, there must still be no rays.
3. When candle 2 closes, rays at high `110` and low `90` appear, anchored to candle 1.
4. A subsequent forming candle touching `110` or `90` immediately invalidates the respective confirmed ray.

### Exact equal-high/low plateau fixture

The fixture in [fixtures/plateau-events.json](./fixtures/plateau-events.json) records expected **forming** and **closed** snapshots for this sequence:

| Step | High / low | Rays after step closes | Reason |
| --- | --- | --- | --- |
| 0 | 101 / 99 | None | No left neighbor |
| 1 | 110 / 90 | None | Candidate has no right neighbor |
| 2–3 | 110 / 90 | None | Unconfirmed equal-price plateau |
| 4 | 101 / 99 | 110 and 90 anchored at step 1 | Weaker right candle closes |
| 5 | 105 / 95 | Same two confirmed rays | New latest-bar extremes are not drawn |
| 6 | 110 / 90 | None | Equal wick touch takes both old rays |
| 7 | 111 / 89 | None | No right candle has confirmed a new pivot |

At step 4, the rays remain absent **during** formation and appear only when that step closes. Test both sides with independent settings. Reset and replay from before step 1 to check that the old origin does not appear early. A longer plateau works the same way, anchored to the first equal candle.

The JSON fixture is used by the automated parity test. For manual TradingView testing, use Bar Replay on a market sequence with the same high/low pattern and compare the timing and anchor behavior. Do not expect the exact example prices on a different market.

### Live and long-history tests

On a live short-timeframe chart, verify that a forming candle may **take** confirmed rays but cannot create new ones. Check a three-candle pivot, several equal-price plateau candles, right-candle confirmation, and immediate equality invalidation. Reload and use Bar Replay to verify the same origins appear without look-ahead. Use varied settings to check nearest-level selection and stable, nonduplicated drawings.

## Test commands

From the ForexTester repository root, with existing dependencies:

```sh
npm test -- frontend/src/untakenLevels.test.ts frontend/src/UntakenLevelsPrimitive.test.ts tradingview/untaken-highs-lows.test.ts
npm test -- frontend/src/workflow.test.tsx -t 'closed M5 right neighbor|equal-price M5 plateau'
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node tradingview/pine-harness.ts tradingview/untaken-highs-lows.test.ts
npm run typecheck
npm run build
```

The Pine parity harness executes adapted Pine statements using JavaScript and compares rays against the TypeScript tracker on identical candles, including rollback modeling. **It is not a Pine compiler**. These updated tests require a fresh run; previous experimental passing results apply only to the earlier provisional indicator.

## Known limitations

- TradingView and ForexTester may differ in provider OHLC, sessions, price precision, available history, and right-candle completion timing. Compare identical sequences before concluding a port is incorrect.
- The Pine script imposes independent 250-line caps per side; ForexTester uses one global saved count. Lines are anchored with `xloc.bar_time`, which avoids the 10,000-bar `bar_index` drawing restriction.
- The script keeps arrays of all surviving confirmed levels; exceptionally long histories may hit Pine runtime/array limits.
- Price comparisons use the sign of the numeric difference to avoid Pine's direct-float comparison rounding. Native TradingView confirmation of edge-case precision is outstanding.
- Standard time-based candlesticks are the supported target. Nonstandard synthetic chart types, realtime rollback, first/old anchor rendering, and maximum-object performance still require manual TradingView verification.
- ForexTester's rays do not participate in autoscaling, while Pine's native lines may render/scalewise behave differently.

Official references: [Pine execution model](https://www.tradingview.com/pine-script-docs/language/execution-model/) and [lines and drawing limits](https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/).
