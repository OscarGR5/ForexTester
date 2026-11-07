# Untaken Highs/Lows for TradingView (experimental)

Copyable Pine Script v6 port of ForexTester's Untaken Highs/Lows. It draws red high rays and green low rays on the chart's own timeframe, including provisional extremes. Only surviving levels are drawn, from their original candle timestamps to the right.

The production ForexTester implementation is unchanged. This experiment is based on `main` at `6df8faf`, including [PR #46](https://github.com/OscarGR5/ForexTester/pull/46) and [PR #48](https://github.com/OscarGR5/ForexTester/pull/48). No Pine compiler or TradingView runtime verification has been performed.

## Install

1. Open [untaken-highs-lows.pine](./untaken-highs-lows.pine) and copy the **entire file**, beginning with `//@version=6`.
2. Open a TradingView chart with standard, time-based candlesticks and choose your symbol and timeframe.
3. Open **Pine Editor**, create a new indicator, select all template text, and replace it with the copied script.
4. Save it as **Untaken Highs/Lows (ForexTester experiment)** and select **Add to chart**.
5. Open the indicator's settings to adjust the inputs below. Compilation errors or runtime errors still need to be reported and resolved during this experimental review.

Only the `.pine` file is needed. No imports, libraries, data connection, or other repository files are required in TradingView.

## Settings

| Input | Default | Behavior |
| --- | --- | --- |
| Show untaken highs | On | Draw high rays; high history still gets processed when hidden. |
| Show untaken lows | On | Draw low rays; low history still gets processed when hidden. |
| Maximum displayed highs | 10 | Nearest distinct highs strictly above the latest close, including provisional levels. Range 1–250. |
| Maximum displayed lows | 10 | Nearest distinct lows strictly below the latest close, including provisional levels. Range 1–250. |
| High line color | Red `#ef5350` | Matches ForexTester's default red. |
| Low line color | Green `#26a69a` | Matches ForexTester's default green. |
| Line width | 1 | Width in TradingView units, from 1 to 4. |

Highs and lows have separate display budgets. A level equal to the latest close is hidden without consuming a slot. The limit does not delete older levels from the calculation. When nearer levels are taken, older surviving levels become visible again. Provisional and confirmed rays use the same style, as in ForexTester.

## Source-of-truth rules

Reviewed sources: [`UntakenLevels`](../frontend/src/untakenLevels.ts), [its tests](../frontend/src/untakenLevels.test.ts), [`ChartPane`](../frontend/src/ChartPane.tsx), [`ReplayBars`](../frontend/src/replayBars.ts), the [drawing primitive](../frontend/src/UntakenLevelsPrimitive.ts), [workflow tests](../frontend/src/workflow.test.tsx), and the [browser fixture](../scripts/untaken-levels-browser.mts). PR #46 introduced three-candle extrema and provisional levels. PR #48 superseded its rejection of neighboring equal prices with the plateau behavior below.

**Local detection.** A single-candle high is a wick high strictly greater than the immediately preceding and following candle highs. A low reverses those comparisons. Confirmation requires the right candle to close. There is no configurable strength, lookback window, ATR threshold, or requirement to exceed a more distant swing. The first loaded candle has no left neighbor and cannot qualify on its own. Open and close do not determine detection.

**Provisional levels.** A candle with a high strictly above the previous candle's high creates a provisional high immediately, including while forming. A low strictly below the previous low creates a provisional low. The mutable candle's growing extreme updates its own price without taking itself. After that candle closes, the level remains pending until a strictly weaker right candle closes, or a stricter extreme replaces it. A weaker forming right candle alone does not confirm it.

**Equal-price plateaus.** Consecutive exact equal highs extend one pending high; equal lows extend one pending low. The anchor is always the first qualifying candle of that contiguous sequence, regardless of plateau length. Each side is tracked independently. An initial equal sequence without a strictly weaker preceding wick does not qualify. Equality during the forming right candle still extends the plateau. A breakout takes the pending level and starts a new provisional extreme at the breakout candle.

**Confirmation and takes.** On each closed candle, first invalidate existing levels, then confirm surviving pending extremes if this candle's wick is strictly weaker, then detect new pending extremes against the preceding candle. Confirmed highs are removed on any subsequent `high >= level`; confirmed lows on `low <= level`, including unfinished candles. Pending highs are removed only on `high > level`, pending lows only on `low < level`. Equality after a weaker candle has **closed** therefore takes the confirmed level. That same touching candle can create a new provisional level at the same price with a new origin. Confirmation keeps the origin and price unchanged and creates no second visible ray.

**History and replay.** ForexTester processes every loaded, revealed candle in each chart's own timeframe. It aggregates revealed M1 observations, considers the final higher-timeframe candle completed when its last minute is revealed, and uses the latest close for display filtering. Forward processing is incremental. Backward review, source replacement, or a chart/timeframe rebuild resets the tracker and replays only revealed history. Nothing is inferred from unrevealed candles. The Pine script reconstructs from every bar TradingView supplies and uses `barstate.isconfirmed` for completion, including the final historical bar.

**Ordering and hidden levels.** Surviving confirmed highs form a strictly decreasing price stack; lows form a strictly increasing stack. The newest end is nearest to current price. Display selection visits the latest provisional first, then confirmed levels from nearest to farthest, highs followed by lows. Equal confirmed prices cannot coexist because a later touch takes the old price first. No age cutoff or display-count pruning is applied to the stored stacks.

Existing tests also cover smaller swings under older extremes, independent plateau boundaries, tiny strict price differences, current-price exclusions, later repeated-price origins, forming breakouts, backward review across formation/confirmation, and hidden historical levels returning under the nearest-N cap. The experimental tests exercise these same behaviors against the unchanged tracker.

## Execution and resource handling

Persistent arrays contain prices and original timestamps. They retain all surviving historical levels; only visible levels use line objects. On the last bar, old line objects are explicitly deleted before the selected rays are drawn. Thus there are no accumulated historical drawings or duplicate confirmation rays, and creation never temporarily exceeds the 500-line budget. Historical bars build state without drawing intermediate snapshots.

The script uses `var` state and Pine's normal rollback. Each tick starts from the previous close, invalidates against the current full wick, and recomputes the forming candidates. Pending levels enter the confirmed stacks only on a closed right candle. It does not use `varip`, future bars, or external-timeframe data. Provisional prices and visibility intentionally change while a candle forms. A provisional ray can appear at an earlier anchor after confirmation, but it was not confirmed at that anchor's time. No promise of immutable provisional signals is made.

Rays use `xloc.bar_time` and stored opening timestamps, avoiding the historical `bar_index` drawing restriction. The second point uses the current bar's `time_close`, so even a new provisional ray has distinct endpoints on a standard time-based candle. The rays extend right and are requested behind candles.

Price comparisons use the integer sign of `a - b`, with no tick rounding or tolerance. This avoids direct float comparisons' documented nine-fractional-digit rounding. The adapter tests include ForexTester's `1e-12` difference case, but this workaround's native numeric behavior remains unverified.

Relevant TradingView documentation: [execution and rollback](https://www.tradingview.com/pine-script-docs/language/execution-model/), [lines and drawing limits](https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/), [array limits](https://www.tradingview.com/pine-script-docs/language/arrays/), and [numeric types](https://www.tradingview.com/pine-script-docs/language/type-system/).

## Automated verification

Run from the repository root with the existing dependencies installed:

```sh
npm test -- tradingview/untaken-highs-lows.test.ts frontend/src/untakenLevels.test.ts frontend/src/UntakenLevelsPrimitive.test.ts
npm test -- frontend/src/workflow.test.tsx -t 'shows provisional M5 pivots|retains the first M5 plateau anchor'
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node tradingview/pine-harness.ts tradingview/untaken-highs-lows.test.ts
npm run typecheck
```

Verified locally: 48 focused tests across the experimental, existing tracker, and drawing-primitive suites passed; both selected M5 workflow tests passed. Workspace typechecking, the experimental harness/test typecheck, and the staged whitespace check passed. The full repository suite and production build were not run for this standalone addition.

[`pine-harness.ts`](./pine-harness.ts) reads the actual `.pine` file and adapts its limited statement syntax into JavaScript. It mocks arrays and lines, enforces object limits and array bounds, and explicitly restores state and drawings before unfinished-bar executions. Unsupported statements fail rather than being skipped. It compares resulting rays with the actual ForexTester `UntakenLevels` tracker on identical OHLC input at each observation. [`plateau-events.json`](./fixtures/plateau-events.json) also records explicit expected origin/price events for the manual sequence below.

This is a deterministic source-level parity check, **not Pine compilation or TradingView execution**. It uses JavaScript numeric semantics and modeled rollback. It cannot prove Pine type inference, floating-point details, resource timing, chart rendering, or native replay behavior.

Coverage includes single-candle pivots, 2/3/8-candle plateaus, first anchors, pending/confirmed transitions, equality and crossing takes, immediate next-bar takes, multiple levels, unequal side limits, hidden-level recovery, visibility, current-price filtering, 500-ray deletion/recreation, more than 10,000 bars of history, reload and backward reconstruction, and deterministic smooth/plateau/negative-price sequences with several ticks per bar.

## Reproducible manual cases

### Deterministic plateau and cap fixture

Use a **separate copy** of the indicator in Pine Editor on a paused replay chart or when the market is closed, with at least eight loaded bars. The fixture deliberately substitutes synthetic prices, so its rays will be near 89–111 regardless of the symbol. Use a symbol priced near 100 or adjust the chart's price scale manually.

1. In this test copy only, replace whole-word occurrences of `high`, `low`, and `close` with `fixtureHigh`, `fixtureLow`, and `fixtureClose`. Do not replace substrings such as `highPrices`, `time_close`, or `xloc.bar_time`. With regex replacement, use `\bhigh\b`, `\blow\b`, and `\bclose\b`.
2. Replace the four occurrences of `bar_index > 0` with `fixtureIndex > 0`.
3. After those replacements, insert this block immediately after the `lineWidth` input. Leave `time` and `time_close` unchanged so rays anchor to real chart candles:

```pine
int fixtureStep = input.int(7, "Fixture step", minval = 0, maxval = 7)
var array<float> fixtureHighs = array.from(101.0, 110.0, 110.0, 110.0, 101.0, 105.0, 110.0, 111.0)
var array<float> fixtureLows = array.from(99.0, 90.0, 90.0, 90.0, 99.0, 95.0, 90.0, 89.0)
int fixtureIndex = bar_index - last_bar_index + fixtureStep
float fixtureHigh = fixtureIndex >= 0 ? array.get(fixtureHighs, fixtureIndex) : 101.0
float fixtureLow = fixtureIndex >= 0 ? array.get(fixtureLows, fixtureIndex) : 99.0
float fixtureClose = 100.0
```

4. Save and add this test copy. Reload if a new market bar has appeared. Change **Fixture step** to each value in the table. Each setting rebuild places sequence candle `step` at the rightmost bar, so origin 1 is `step - 1` bars before the rightmost bar. Prior candles outside the fixture are flat and produce no levels.

| Step | High / low | Expected rays with caps 10 | Reason |
| --- | --- | --- | --- |
| 0 | 101 / 99 | None | No qualifying left neighbor. |
| 1 | 110 / 90 | 110 and 90 at origin 1 | Provisional extremes. |
| 2–3 | 110 / 90 | Same two rays at origin 1 | Equal plateau extends without moving the anchor. |
| 4 | 101 / 99 | Same two rays at origin 1 | Weaker close confirms the plateau. |
| 5 | 105 / 95 | Highs 105 at origin 5, 110 at origin 1; lows 95 at origin 5, 90 at origin 1 | New provisional and old confirmed levels coexist. |
| 6 | 110 / 90 | 110 and 90 at origin 6 | Equal touches remove the confirmed origins and create new provisional ones. |
| 7 | 111 / 89 | 111 and 89 at origin 7 | Breakout replaces pending extremes. |

At step 5, set both caps to 1. Only 105 and 95 should remain visible. Restore caps to 2; 110 and 90 must return at origin 1. Toggle each side and change colors/width; verify the chosen side and line appearance. Remove this fixture copy afterward and install the original script again.

### Realtime unfinished candles

On the original script during an open market, use a liquid symbol and a short standard timeframe. Find a forming candle exceeding the immediately previous high or low. Record its opening time, provisional price, and previous candle's wick before proceeding.

- As its wick extends, the ray should move in price but keep that candle's time. If the latest close equals the wick extreme, the strict current-price filter hides that side until price moves back inside the candle.
- A weaker following candle must leave that ray at the recorded origin during formation and through its close. An equal following wick before confirmation must preserve the first anchor. A crossing wick must replace it at the crossing candle.
- After a weaker following candle has closed, a later equal touch must remove the old origin immediately. A new provisional at the same price is possible; inspect the anchor to distinguish replacement from survival.
- Repeated ticks must not duplicate rays. After the active bar closes, remove and re-add the script and compare surviving prices and anchors.

Historical OHLC and normal closed-bar replay cannot reproduce the original tick path. This case requires native live updates to verify rollback.

### History, replay, and limits

Use TradingView Bar Replay on standard candles. Advance through a visible local extreme, its weaker right candle, and a later taking wick. Compare prices and anchors against the same OHLC in ForexTester, then restart replay before the extreme and repeat. Check that levels appear only after their qualifying left comparison, retain their anchors through confirmation, and disappear on takes. Reload and change timeframes; each timeframe must independently rebuild its own levels. Use a long chart history to check rays anchored more than 10,000 bars back where such untaken levels exist. Try the maximum caps and monitor for object-limit or execution-time errors.

## Known differences and remaining verification

- TradingView supplies its own symbol feed, session boundaries, price precision, and loaded history. ForexTester uses its loaded/revealed data and M1 aggregation. Exact parity requires identical OHLC and completion boundaries. The script cannot recover levels preceding TradingView's first available bar.
- ForexTester permits any positive safe-integer count and has one shared cap and visibility toggle. This port defaults both sides on, offers independent caps/toggles as requested, and caps each side at 250 to fit Pine's 500 lines. Selection within each cap follows the existing nearest-price behavior.
- ForexTester retains levels without a platform array cap. Pine limits an array to 100,000 elements and imposes execution/memory limits. This script does not silently discard surviving old levels; exceeding platform resources will raise a TradingView runtime error.
- Pine numeric precision differs from JavaScript. The sign-based comparison aims to preserve strict equality semantics, but full numerical equivalence is unproven, particularly at subprecision differences.
- ForexTester's M1 replay reveals complete minute OHLC. TradingView indicators update on native ticks; historical bars contain final OHLC only. Provisional intrabar paths cannot be reconstructed from historical OHLC. Backward reconstruction relies on TradingView replay/recalculation rather than ForexTester's explicit reset API.
- Standard time-based candlesticks are the supported target. Synthetic/nonstandard charts and tick/range charts are not verified; `time_close` may be unavailable on some unfinished non-time-based bars.
- ForexTester's custom primitive explicitly excludes rays from autoscaling. Pine native lines may affect chart scaling or layering differently. Verify the visual result and adjust TradingView chart scaling if needed.
- Still requiring TradingView verification: v6 compilation, native rollback and drawing deletion, the strict-difference numeric workaround, first-anchor rendering (including current and very old candles), replay restart behavior, maximum-cap performance, and display appearance behind candles.
