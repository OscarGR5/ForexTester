# Untaken Highs/Lows for TradingView (experimental)

Standalone Pine Script v6 port of ForexTester's **confirmed-only** Untaken Highs/Lows indicator, with independent Daily and Weekly reference levels. Red rays represent unbroken local highs, green rays unbroken local lows. A last candle's extreme is never plotted merely because it exceeds the preceding candle.

Earlier commits on this branch updated the ForexTester tracker to confirmed-only rules. This Daily/Weekly extension changes only the experimental script, tests, and documentation. Native Pine compilation and TradingView runtime validation of this extension have not been performed.

## Install

1. Open [untaken-highs-lows.pine](./untaken-highs-lows.pine) and copy the whole file, including `//@version=6`.
2. In TradingView, open a standard time-based candlestick chart and select **Pine Editor**.
3. Create a new indicator, replace the template, save, and select **Add to chart**.
4. Adjust the normal high/low visibility, level limits, line colors and width, and the independent Daily/Weekly toggles in the indicator settings.
5. Report any Pine compilation/runtime error with the exact message and line number.

No external libraries or imports are required. Daily/Weekly data comes from TradingView's native `request.security()` for the chart's current symbol.

## Detection and display rules

- **Single-candle high:** `previous high < candidate high > following high`. The following candle **must close** before the candidate becomes a ray. Low: `previous low > candidate low < following low`.
- **Equal-price plateau:** Consecutive exact equal high/low wicks form one candidate. Its first candle is the anchor. A weaker candle must occur immediately before and immediately after the plateau, with the right-side candle closed. Each side is tracked independently.
- **Latest candle:** Never marked as a pivot without a confirmed right neighbor, even when already closed. Candidates and forming plateaus are internal state only, not visible rays. A weaker *forming* right candle does not confirm anything.
- **Invalidation:** A confirmed high is taken immediately when a subsequent wick reaches or exceeds its price; a low is taken on a wick at or below its price. This also applies to the realtime forming candle. A newly forming candidate at the same price does not replace the ray until independently confirmed later.
- **Selection:** Display nearest untaken confirmed highs strictly above the latest close, and nearest confirmed lows strictly below it. Hidden old levels remain tracked. Selection budgets are per side and do not change detection.
- **History/replay:** Normal levels use loaded chart candles; references also use TradingView's available native Daily/Weekly history. Pine uses `barstate.isconfirmed` for normal realtime right neighbors and offset closed inputs for higher-timeframe requests. ForexTester processes revealed candles and its timeframe aggregation separately. No future candles may influence historical snapshots.

## Settings

| Setting | Default | Details |
| --- | --- | --- |
| Show untaken highs | On | Independent visibility toggle |
| Show untaken lows | On | Independent visibility toggle |
| Maximum displayed highs | 10 | 1–248, closest eligible normal confirmed levels |
| Maximum displayed lows | 10 | 1–248, closest eligible normal confirmed levels |
| Show Daily untaken levels | On | Most recent surviving Daily high and low, fixed 2 px |
| Show Weekly untaken levels | On | Most recent surviving Weekly high and low, fixed 3 px |
| High line color | Red `#ef5350` | Pine line color |
| Low line color | Green `#26a69a` | Pine line color |
| Line width | 1 | Normal rays only, range 1–4 |

The Pine drawing limit is 500 line IDs. The indicator reserves four slots for references: `248 + 248 + 4 = 500`. It deletes previous lines before redrawing and stores hidden historical levels as arrays, not line objects. It draws on both the last chart bar and the last confirmed historical boundary.

## Daily and Weekly references

Daily and Weekly each track their own three-candle extrema and equal-price plateaus, using their native OHLC history. A weaker closed right candle confirms the first candle of the candidate or plateau. No pending candidate is displayed. The selected reference is the most recent surviving **pivot candle time**, with its original Daily/Weekly opening timestamp as the ray origin. Taking that pivot immediately reveals the next most recent survivor, including an origin older than the chart's first loaded intraday bar, when available in the requested history.

These toggles are independent of normal high/low visibility and limits. Turning normal highs or lows off does not hide references. Daily uses the existing high/low colors at 2 px; Weekly uses them at 3 px. The normal width input cannot change those widths.

At an equal price, only the highest-priority enabled ray is drawn: **Weekly, then Daily, then normal**. Its own original timestamp is preserved even when another timeframe's anchor differs. A suppressed normal duplicate still occupies its normal nearest-N selection slot, so overlap removal does not change which normal levels qualify under the existing cap. References do not consume normal slots.

### Confirmation, requests, and rollback

For a higher-timeframe request, `confirmedReferences()` processes only `high[1]`, `low[1]`, and `time[1]`, comparing them with the preceding `[2]` wicks. Its state therefore contains only completed native candles. The two `request.security(syminfo.tickerid, ...)` calls use `barmerge.lookahead_on`. Offsetting the **inputs to the whole state machine** is equivalent to requesting the preceding confirmed calculation; no developing Daily/Weekly price enters detection. The current period's opening time is returned only to identify the boundary and is not a pivot anchor.

The confirmed higher-timeframe snapshot becomes available at the first chart bar of the **following** Daily/Weekly period. For example, a Daily pivot whose right neighbor closes Tuesday is published at Wednesday's first chart bar. This is the intentional timing of the confirmed-offset request pattern, including when a session gap separates those bars. If the chart itself is D1 or W1, its matching reference uses the normal confirmed chart tracker and appears directly on the right candle's closing update.

Complete surviving stacks are copied into chart state on period boundaries, allowing immediate fallback without waiting for another Daily/Weekly close. Requests are evaluated on those boundaries and on the first loaded bar to avoid returning full collection copies on every intraday bar and to establish the requested contexts before live updates. Chart wicks invalidate these copies on every execution, including unfinished candles. `var` state and line objects use normal Pine rollback; no `varip` state or future OHLC is used.

An initially partial Daily/Weekly period can contain taking wicks before the chart's first loaded candle. The script does not invent that earlier path. That reference waits until the next **loaded period boundary**, with an on-chart message. Loading enough chart history to include a Daily/Weekly boundary resolves this startup condition. Native history before that boundary supplies older surviving pivots; a short chart does not need to reproduce all older candidate candles itself.

### Supported chart timeframes

| Chart timeframe | Daily references | Weekly references |
| --- | --- | --- |
| Intraday | Confirmed offset D1 history | Confirmed offset W1 history |
| D1 | Confirmed chart tracker, 2 px | Confirmed offset W1 history |
| W1 | Disabled, with an on-chart notice | Confirmed chart tracker, 3 px |
| Above W1 | Disabled, with an on-chart notice | Disabled, with an on-chart notice |

This version deliberately does not reconstruct references from lower-timeframe intrabar arrays. `request.security()` would otherwise sample only one Daily candle per Weekly chart bar, which is insufficient for Daily pivots and correct intrabar invalidation. Higher-than-reference charts continue to display their normal levels. Disable the unsupported reference toggle to dismiss its notice. Standard intraday, D1, and W1 charts are the verification targets; other multi-day chart periods are not covered by the fixture model.

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

### Daily/Weekly reference checks

1. On D1, locate a confirmed untaken high and low, including a plateau if available. Record their prices and first-candle timestamps. Repeat on W1. Use the most recent surviving pivot in time on each side.
2. Switch to an intraday chart with at least one loaded Weekly boundary. With normal highs/lows hidden, verify up to four references at those prices and original timestamps: Daily 2 px, Weekly 3 px. A higher-timeframe confirmation becomes visible only in the next period, as described above. Check Replay before and after that boundary; it must not appear early.
3. Set normal limits to 1 and normal width to 4, then toggle normal levels on. The reference prices, counts, and widths must not change. Toggle Daily and Weekly separately. Where prices overlap, verify Weekly priority and that toggling it off reveals the appropriate Daily/normal ray.
4. Advance until a chart wick takes a reference. The next most recent surviving pivot must appear immediately; if all candidates are taken, that side must disappear. Check a live taking wick, repeated ticks, a new period, and a chart reload for duplicate rays or a resurrected taken level.
5. On D1, verify the Daily ray appears on its right neighbor's close, with no duplicate normal ray at the same price. On W1, verify the corresponding Weekly behavior and the explicit Daily-unavailable notice.
6. If the chart starts mid-period and a waiting message appears, load older chart history through a period boundary. Check long histories and maximum caps for collection-memory, execution-time, or line-limit errors. Report native errors with the exact message and line.

## Test commands

From the ForexTester repository root, with existing dependencies:

```sh
npm test -- frontend/src/untakenLevels.test.ts frontend/src/UntakenLevelsPrimitive.test.ts tradingview/untaken-highs-lows.test.ts tradingview/reference-levels.test.ts
npm test -- frontend/src/workflow.test.tsx -t 'closed M5 right neighbor|equal-price M5 plateau'
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node tradingview/pine-harness.ts tradingview/untaken-highs-lows.test.ts tradingview/reference-levels.test.ts
npm run typecheck
npm run build
```

The Pine parity harness executes adapted Pine statements using JavaScript and compares rays against the unchanged TypeScript tracker on identical candles, including rollback modeling. It also executes the actual `confirmedReferences()` function body in separate modeled native contexts. Requests are mocked with timestamped Daily/Weekly fixtures, including future fixture data that must remain inaccessible. It checks closed prefixes, plateau origins, recent-by-time selection, fallback, widths, independent toggles/caps, equal/lower timeframe routing, overlap priority, historical/live reconstruction, and 500-ray redraws. **It is not a Pine compiler or a native implementation of TradingView's request engine, sessions, or exchange calendars.**

Local verification for this extension: 77 focused tests and both selected M5 workflow tests passed. The experimental harness/tests and both workspaces passed typechecking; frontend/backend production builds and the whitespace check passed. The full repository test suite was not run. Native request behavior, resource use, and chart rendering still require TradingView inspection.

## Known limitations

- TradingView and ForexTester may differ in provider OHLC, sessions, price precision, available history, and right-candle completion timing. Compare identical sequences before concluding a port is incorrect.
- The Pine script imposes independent 248-line normal caps per side; ForexTester uses one global saved count. The four references are a Pine-only addition. Lines are anchored with `xloc.bar_time`, which avoids the 10,000-bar `bar_index` drawing restriction.
- The script keeps full stacks and requests copies of native surviving levels. Exceptionally long histories may hit Pine collection-memory, execution, or array limits. Boundary-only requests reduce collection copies; native resource performance remains unverified.
- Initial partial periods wait for a loaded boundary. Daily references are unavailable above D1 and Weekly references above W1. Requested history is limited by TradingView's data availability and account resources.
- Price comparisons use the sign of the numeric difference to avoid Pine's direct-float comparison rounding. Native TradingView confirmation of edge-case precision is outstanding.
- Standard time-based candlesticks are the supported target. Nonstandard synthetic chart types, realtime rollback, first/old anchor rendering, and maximum-object performance still require manual TradingView verification.
- ForexTester's rays do not participate in autoscaling, while Pine's native lines may render/scalewise behave differently.

Official references: [Pine execution model](https://www.tradingview.com/pine-script-docs/language/execution-model/), [confirmed higher-timeframe requests and intrabar limitations](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/), and [lines and drawing limits](https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/).
