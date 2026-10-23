# ForexTester

ForexTester is a personal, browser-based forex backtesting application for Linux. The MVP focuses on manually replaying EURUSD price action, placing simulated trades, and reviewing backtest results.

## MVP requirements

- Support EURUSD initially.
- Retrieve historical forex data automatically, without MT5 or manual imports.
- Provide multiple selectable timeframes.
- Display one, two, or three synchronized charts at once, including vertically stacked layouts.
- Include Ichimoku Cloud, Bollinger Bands, and Stochastic Oscillator indicators with configurable settings.
- Allow manual simulated buy and sell orders.
- Support multiple simultaneous positions, each with an independent stop-loss (SL). Take-profit functionality is intentionally excluded because the trading workflow uses stop-losses and manual profit-taking only.
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

Replay inherits the historical-data limitations below: EURUSD bid charts only, provider gaps and availability, completed UTC days, and at most seven days per request. Simulated market entries and manual exits use this same clock, as described below. The session-only Trading Journal and performance dashboard use only executions already revealed by replay. Tick replay and replay persistence are not implemented. Independent automatic stop-loss execution uses the same revealed M1 clock.

## Simulated trading

The **Simulated trading** panel defaults to **Risk %** sizing, initially **1%**, with a required positive, finite **SL price** entered as an absolute EURUSD price. **Manual Lots** preserves the positive, finite volume workflow, initially **0.01 lots**. The SL field starts blank; the application never derives a fixed pip distance. One EURUSD lot represents **100,000 EUR** of base-currency exposure. Choose **Buy** or **Sell** while replay is active and paused. Trading is disabled in the full-history viewer, during playback, and at the final candle. There must be a later M1 bid candle available to advance to; the application does not look ahead for future quote availability.

At most **two position slots** can be in use. Pending entries and open positions both consume slots, including positions with a pending close. Each entry keeps its own sizing request and SL. Risk-based entries determine their final volume only at execution. At the actual opening fill, a Buy SL must be strictly below its ask entry price, and a Sell SL strictly above its bid entry price. Invalid protected entries become rejected-order records with an explicit reason and release their slots. Stops attach immediately to valid fills. **Cancel** removes an unfilled entry and releases its slot. **Close** queues a manual exit; duplicate close requests are disabled. Pending entries can be cancelled during playback or after history ends. Entry, open, pending-close, and closed states are labeled separately.

Each revealed M1 OHLC bar is treated as an observed, completed candle for trading decisions, although its replay timestamp is the candle’s opening timestamp. An order requested after observing candle N can execute only at a later available M1 opening, never inside candle N. **Next Candle** or **Play** advances the shared clock and processes pending orders chronologically, including all intervening bars when React batches several clock updates. Visual zoom, scrolling, crosshairs, timeframes, and layouts never control execution.

Execution uses historical EURUSD prices, with both bid and ask candles required at exactly the same timestamp:

| Action | Fill price |
| --- | --- |
| Buy entry | Ask open |
| Sell entry | Bid open |
| Close Buy | Bid open |
| Close Sell | Ask open |

Queued orders are evaluated in submission order at that opening, subject to the combined planned-risk cap. High, low, and close never select a market entry or manual exit price. Automatic stop exits use the rules below. Missing minutes and weekend/overnight gaps advance directly to the next available bid candle. If its ask is missing or has a different timestamp, orders remain pending until a later synchronized quote appears. Ask-only timestamps do not advance the bid replay clock. Prices are never invented or interpolated.

Open positions show their entry time/price, direction, volume, current closing-side price, and unrealized PnL. Buys are valued at the revealed **bid close** and sells at the revealed **ask close**. The current observed candle must have synchronized bid and ask data; otherwise current price and PnL show **unavailable**, without carrying a stale valuation forward. Closed trades show their actual entry and exit prices/times and realized PnL.

For EURUSD, **1 pip = 0.0001**. Signed price difference is exit or current price minus entry for buys, and entry minus exit or current price for sells. **Pips = signed difference / 0.0001**; **gross USD PnL = signed difference × 100,000 × lots**. For example, a 0.01-lot buy at 1.10020 closed at bid 1.10120 yields 10.0 pips and $1.00 gross. Price-based pips and gross USD PnL retain these calculations. Net USD PnL subtracts recorded entry and exit commissions, as described below. Neither value is account equity. Swaps and financing are not modeled.

Calculations retain JavaScript number precision. Display values use fixed decimal rounding: **5 decimals for prices, 1 for pips, 2 for USD**. Manual volumes retain the entered numeric value; automatic volumes use 0.01-lot increments, and values that round to zero display without a minus sign. All timestamps are UTC to the minute.

**Restart**, including at the first replay candle, clears pending entries, open positions, and closed trades. Loading a dataset also clears all trading records and returns to the full-history viewer. Timeframe/layout changes preserve positions and pending orders. At the final candle, remaining positions are labeled **open at end of available history**. Unfilled entries or close requests stay pending. No position is force-closed and no exit price is assumed.

Trading state is session-only, in memory. The pure TypeScript engine in `frontend/src/trading.ts` owns execution rules and transitions; `useTrading.ts` consumes the existing replay clock and processes every newly revealed bid candle with its matching ask. Chart components do not own trading state. IDs are deterministic and unique within and across replay sessions on the current page. Automated tests use local fixtures and controlled timers, with no live-data dependency.

Take-profit functionality is intentionally excluded because the trading workflow uses stop-losses and manual profit-taking only.

Current limitations: EURUSD only; M1 candle replay, with no intraminute or tick-price assumptions. **Automatic trailing stops and break-even rules, swaps, financing, margin/leverage simulation, dynamic account balances/equity, full mark-to-market equity curves, strategy signals, and persistence are not implemented.** The historical-data backend and its seven-day request limit are unchanged.

### Risk-based position sizing and combined exposure

**Account settings · USD** starts with a **$100,000 reference balance** and **2% maximum combined planned risk**, or **$2,000**. Edit these before starting replay. Positive finite balances and percentages greater than 0 and at most 100% are required. Session settings lock while replay is active, including after the final candle. Restart clears trading records and retains settings; loading history clears records, retains settings, and unlocks configuration. The reference balance is a fixed sizing input, not simulated cash or equity. USD is the only accounting currency; there is no EUR account conversion.

In **Risk %** mode, enter a percentage and an absolute SL, then choose Buy or Sell. Risk per new entry defaults to 1% and can change while paused without altering existing allocations. The request stores its direction, SL, percentage, and USD budget, without a final volume. Only an eligible future synchronized M1 opening supplies the actual entry: **ask open for Buy, bid open for Sell**. No future candle is inspected at submission and the observed close is never used for final sizing.

```text
Risk budget USD = reference balance × risk percentage / 100
Risk per standard lot USD = abs(actual entry price − SL) × 100,000
Automatic lots = floor((risk budget USD / risk per standard lot USD) / 0.01) × 0.01
```

For example, $100,000 × 1% = $1,000. A Buy at ask 1.10020 with SL 1.09820 has a 20-pip distance and $200 risk per lot, producing **5.00 lots**. A 30-pip distance produces **3.33 lots**, or **$999** planned risk. If the future entry gaps to 1.10220 with that same SL, the distance becomes 40 pips and the volume becomes **2.50 lots**. Spread is included through the actual execution-side entry. Sizes below **0.01 lots** are rejected rather than rounded up. An SL invalid against the actual entry is rejected through the existing rejected-order records. Floating-point comparisons allow representation noise only; they do not grant additional spending capacity.

The combined cap measures **concurrent gross planned stop-loss exposure**, excluding commissions, plus percentage-order reservations:

```text
Long planned USD risk = max(0, entry price − current SL) × 100,000 × lots
Short planned USD risk = max(0, current SL − entry price) × 100,000 × lots
Available budget = reference balance × maximum risk % / 100
                   − open planned exposure − pending percentage allocations
```

Two independent 1% allocations fit within the default 2% cap. A new percentage request exceeding available capacity is refused. Each pending percentage order reserves its full requested USD budget, including any rounding remainder, until it fills, is cancelled, or is rejected. On fill, its actual rounded entry risk replaces the reservation and unused risk is released. Execution rechecks the cap against open positions and all other pending percentage allocations. Already reserved allocations remain protected even when a manual order was submitted earlier. Otherwise orders compete in submission order. Manual exits execute before entries at the opening; automatic stops run after entries, so exposure from an intrabar stop is released after that candle's entry checks.

**Manual Lots** never resizes the entered volume. The panel and pending manual orders show estimates from currently revealed synchronized closing quotes where calculable. Manual entries reserve no USD budget because their future entry risk is unknown. The engine calculates actual planned USD risk and percentage at execution and rejects a fill exceeding the cap. Estimates are labeled and are not guaranteed future fills. Missing synchronized quotes leave orders pending and keep percentage reservations intact. Both pending modes continue to consume one of the two position slots.

A pending manual close keeps the position's exposure until the exit executes. Closed positions release their exposure. Moving an SL closer to entry reduces current planned risk; break-even or profit stops have **zero gross planned downside under the SL-level assumption**. Widening a stop increases exposure and is rejected if open exposure plus reservations would exceed the cap. Existing current-price validation, future-candle effectiveness, stop history, and coverage records still apply. SL changes never resize a position. Each filled position stores its original planned USD risk, original percentage, and sizing reference balance separately from current planned exposure, preserving the entry risk for later R-multiple statistics.

Planned risk is **not a guaranteed maximum realized loss**. Adverse gaps can fill beyond the SL and produce larger losses; OHLC history cannot reconstruct intraminute paths, and slippage is not modeled. Sizing currently excludes **commissions, swaps, financing, and margin requirements**. There is no leverage, liquidation, currency conversion, or dynamic equity model. The seven-day historical-data limit is unchanged.

### Configurable commissions and net USD PnL

Before starting replay, enter **Round-trip commission (USD per standard lot)** in Account settings. The default is **$0.00**. This is a user-entered USD amount, not a broker tariff. Zero and nonnegative finite decimal rates are accepted; negative, NaN, infinite, and empty inputs are rejected, with the previous valid displayed rate retained. EUR-denominated fees are not converted or treated as USD. USD is the only accounting currency.

The symmetrical model charges half the round-trip rate at each actual execution:

```text
Entry commission USD = lots × (round-trip USD per lot / 2)
Exit commission USD  = lots × (round-trip USD per lot / 2)
Total commission USD = entry commission + exit commission
Net realized USD PnL = gross realized USD PnL − total commission
```

For **2.00 lots at $7.00 per standard lot round-trip**, entry costs **$7.00**, exit costs **$7.00**, and total commission is **$14.00**. A Buy at ask 1.10020 closed at bid 1.10120 earns **10 pips and $200.00 gross**, or **$186.00 net**. Exiting at 1.09920 gives **−10 pips, −$200.00 gross, and −$214.00 net**. Exiting at the entry price gives **0 pips, $0.00 gross, and −$14.00 net**. Pips describe price movement and are never called net of commissions.

Entry commission becomes an incurred cost only when a pending entry fills. Pending, cancelled, and rejected entries incur no fee. Manual closes and automatic stops charge exit commission using the position's recorded rate; gross PnL uses the actual exit fill, including adverse gap-through openings. Entry and SL on the same candle charge each side once. Open positions at the end of history retain their entry costs, without an actual exit fee or invented closing trade.

Each executed position stores its USD rate and actual entry commission. Each closed record additionally stores gross USD PnL, exit commission, total commission, and net USD PnL independently. A single pure engine closing transition handles both manual and stop exits. The compact realized summary totals **closed positions only**: count, gross PnL, their entry plus exit commissions, and net PnL. Entry fees on positions still open remain visible on those positions and are excluded from that closed-position summary. Calculations retain number precision internally; USD display values round to two decimals, so displayed per-side amounts may not sum exactly to displayed totals for small volumes.

Open positions show gross unrealized PnL, the incurred entry commission, estimated exit commission, and **estimated net PnL (mark-to-close)**:

```text
Estimated net USD PnL = gross unrealized USD PnL
                       − recorded entry commission − estimated exit commission
```

This is an estimate of closing at the latest revealed **bid close for a Buy or ask close for a Sell**, not realized net PnL or a guaranteed next-opening fill. Both current bid and ask candles must be available at the replay timestamp. If they are unavailable, gross unrealized and estimated net valuation show unavailable, while the recorded entry fee and known estimated exit fee stay visible. No stale quote is carried forward.

**Spread is already incorporated through actual historical bid/ask executions.** Buy entries use ask, Sell entries use bid, Buy exits use bid, and Sell exits use ask. No synthetic spread charge, second spread subtraction, or configurable spread override is applied. Historical ask spikes can still trigger short stops.

Commissions do not change requested gross risk percentages, future-opening sizing, manual volumes, 0.01-lot automatic rounding, reservations, original risk fields, or the **gross planned risk cap**. A separate informational estimate adds expected fees to original planned SL risk:

```text
Estimated total loss at initial SL = initialRiskUsd + expected round-trip commission
Estimated total downside at current SL = max(0, −gross USD PnL at current SL
                                               + incurred entry fee + expected exit fee)
```

For 5.00 lots with $1,000 original gross SL risk and $7.00 per lot round-trip, estimated initial total loss is **$1,035**. Two such positions still fit a **$2,000 gross cap**, even though their combined fee-adjusted estimate is $2,070. A break-even price stop on 2.00 lots has zero gross planned risk but **$14** estimated net downside. A profit stop can offset some or all fees. These SL estimates assume a normal fill at the configured level, not a maximum guaranteed loss; adverse gaps can increase the realized loss. They are separate from realized PnL and current gross planned exposure.

The rate locks for the entire active replay, including pauses and completion. **Restart** clears all execution records, position fees, and summary totals while keeping the rate locked and unchanged. History reload also clears records and totals, retains the rate, and unlocks settings before the next replay. Chart layout, timeframe, and indicator changes preserve fees. React StrictMode and batched playback process chronological candle transitions idempotently. Settings and records are memory-only and do not survive a page refresh.

This simple symmetrical model may differ from a real broker because of **minimum ticket fees, broker-side rounding, account-currency denomination, tiered fee schedules, or other broker-specific charging practices**. No broker preset, FX conversion, swaps, overnight financing, extra slippage, dynamic balance/equity, or margin/leverage simulation is added. Configurations must be finite; a fill whose commission overflows JavaScript's numeric range is rejected without charging a fee. Historical data, M1 OHLC limitations, stop coverage warnings, and the seven-day history limit still apply.

### Independent stop-loss execution

Each newly revealed M1 candle is processed in this order: eligible synchronized manual closes at the opening, eligible market entries at the opening, automatic stops for all remaining positions including new entries, then current quote/PnL valuation. Stops operate during both **Play** and **Next Candle**, without pausing playback. Batched clock updates process every newly revealed candle chronologically. No unrevealed candle can trigger a stop.

| Position | Triggering quote side | Intrabar level trigger | Gap-through opening fill |
| --- | --- | --- | --- |
| Buy | Bid | Bid low at or below SL: fill at SL | Bid open below SL: fill at bid open |
| Sell | Ask at the current bid-clock timestamp | Ask high at or above SL: fill at SL | Ask open above SL: fill at ask open |

An opening quote exactly equal to SL is a level fill. A stop is not a guaranteed exit price: adverse gaps use the actual opening quote, and realized pips/USD use that fill. Temporary spread widening can trigger a short's SL through ask alone even when the bid chart never touches it. Stop monitoring does not require the irrelevant quote side, even though market entries and manual closes continue to require synchronized bid and ask candles.

An entry at an M1 opening is protected throughout that same candle. It may enter and stop out with the same timestamp. Exit times identify the **triggering M1 candle**, not a known intraminute execution time. A synchronized manual close eligible at the opening has priority over the stop on that candle. If missing quotes prevent the manual close, the position's stop remains active whenever its required side is observable.

Open positions display their IDs and current stops. Edit **Replacement SL** and choose **Update SL** while replay is active, paused, and has another candle available. A Buy replacement must be below the current available bid close; a Sell replacement must be above the current available ask close. The required current quote must exist, and prices must be positive and finite. Break-even and profit stops are allowed. Changes apply only from the next available M1 candle and never re-evaluate a previously observed bar. Records retain each old/new level and the simulation timestamp of the change. Playback and the end of history disable modifications. Stops never move automatically.

Every displayed chart shows horizontal SL lines labeled with position IDs and five-decimal prices. Different positions use different colors and line patterns; coincident levels label both IDs. Updates change the existing lines without recreating charts. Lines disappear on closure, restart, or history reload. Layout, timeframe, and indicator changes preserve execution state and SL modifications.

Missing or invalid required quote-side observations produce persistent **SL coverage uncertain** warnings with the side and inclusive affected M1 timestamps. Skipped bid-clock intervals, including weekend closures, are also recorded as uncertain clock gaps for positions held across them. No stop evaluation or fill is invented inside a missing interval. When quotes resume, the engine evaluates the available opening for an adverse gap before evaluating that candle's range. A resumed quote on the safe side cannot prove the stop was never crossed during the gap; the warning remains on open and closed records. Ask-only timestamps never advance replay. If the entire bid dataset is empty, replay cannot start. Existing synchronized-quote valuation rules still apply.

Closed records retain SL, modification history, coverage warnings, actual exit price, triggering candle timestamp, exit reason (**manual** or **stop_loss**), and stop fill type (**level** or **gap-through opening**). Rejections, stops, positions, orders, modifications, warnings, and closed records reset with the trading session. Positions still open at the final candle remain open; no forced exit is assumed.

These are M1 OHLC assumptions, not tick reconstruction: normal intrabar crossings fill at SL without modeling intraminute sequence, liquidity, or slippage beyond adverse opening gaps. Missing periods remain uncertain. Bid charts cannot display ask spikes. There are no take profits, trailing stops, automatic break-even adjustments, swaps, financing, simulated account balances, or persistence. The seven-day historical request limit is unchanged.

## Trading Journal and setup grouping

A **position** is one executed entry with its own volume, entry, SL, original risk, SL modifications, commissions, exit, and coverage warnings. A **setup** is one trading idea containing one or two entries in EURUSD with the same direction. Entries in a setup can have different volumes, stops, entry times, and exits. Grouping never changes pricing, risk sizing, commission charges, or the independent two-concurrent-position limit.

The order panel's **Setup** selector defaults to **New setup**. Submitting a valid request creates a stable setup ID and associates the pending entry with it. To group a second entry, explicitly select **Add entry to [setup ID]** before Buy or Sell. The opposite direction is disabled. Only setups with a pending or open entry and fewer than two submitted slots are eligible. Closed entries still consume their setup slots; cancelled and rejected requests release theirs. Completed setups cannot be reopened. Entries submitted close together are separate setups unless explicitly associated.

The separate **Trading Journal** section defaults to **Setup view**, with one row per idea. It shows combined original risk for executed entries, realized results for closed positions, and pending/open/partially closed/completed/rejected-cancelled status. A setup is complete only after at least one execution and no pending or open entries remain. One closed member plus a pending or open member is **partially closed**. Results for an incomplete setup are labeled **partial realized PnL**, and final setup R and final exit time remain unavailable. A setup with only cancelled/rejected requests is never a completed trade.

Choose **Details / notes** to inspect individual executions, entry/exit prices and UTC times, SL changes, commission breakdowns, exit reasons, original risk, R, and coverage warnings. Edit the optional title, free-text strategy/model tag, and plain-text notes here, including after completion. **Position view** lists all executed open and closed positions separately. Rejected/cancelled requests have their own expandable inspection area and are excluded from completed statistics and CSV position rows.

The journal is **session only and not permanently saved**. Timeframe/layout changes, playback, pauses, and indicator edits preserve it. Restart, history reload, and page refresh clear setups, notes, executions, and derived statistics. The existing reference balance and commission settings survive replay restarts/history reloads, retaining their existing configuration semantics. Export CSV before resetting. There is no LocalStorage, IndexedDB, database, cloud saving, or cross-session analytics.

### Performance statistics

**Statistics scope** defaults to **Completed setups** and can switch to **Closed positions** independently of the journal view. Setup observations combine all of their executed members; incomplete setups are excluded. Position observations include closed positions even when their setup is incomplete. Totals show gross realized PnL, entry-plus-exit commissions, and net realized PnL in USD. Zero-observation totals are $0; averages, win rate, and undefined ratios display **Unavailable**.

- Net PnL = gross PnL − entry commission − exit commission. Every win/loss classification uses this net result at full internal precision.
- Win rate = number of strictly positive net observations ÷ all completed observations × 100. Exactly zero is a non-winner and stays in the denominator. Four wins, three losses, and one zero give 50%.
- Non-winners include strictly negative and exactly zero outcomes; both counts are displayed. Average loser and largest loser use strictly negative results only. Average/largest winners use strictly positive results.
- Profit factor = sum of positive net PnL ÷ absolute sum of negative net PnL. Zero contributes to neither sum. Wins without losses display **∞ (no net losses)**; only losses give 0; empty or zero-only outcomes are unavailable.
- Position net R = net realized PnL ÷ original planned gross SL risk recorded at entry. For example, $2,000 gross − $35 commission over $1,000 original risk = 1.965R.
- Completed setup net R = combined member net PnL ÷ combined member original gross risk. A $750 net result over $1,000 + $500 risk is 0.5R, not an average of position R values. SL changes never change this denominator, and adverse gap-through fills can lose more than 1R. Nonpositive/nonfinite denominators return unavailable.
- Average net R averages valid observation R values; total net R is their **sum**, not total PnL divided by total session risk. The number of valid denominators is disclosed.
- Holding duration is entry-to-exit for a position, or earliest member entry to final member exit for a completed setup. Average holding duration is displayed in minutes.
- Net return = selected observations' net PnL ÷ fixed reference balance × 100. This does not compound or alter sizing.

**More statistics and calculation conventions** contains the winner/loser averages and extremes, average/total R, holding duration, and reference-balance return.

### Realized PnL and drawdown

The performance chart always uses **closed-position events**, independent of the KPI scope. It starts at $0 cumulative net PnL, adds each closed position's net result once, and orders events by exit timestamp, preserving deterministic engine execution order within the same M1 timestamp. The horizontal axis is closure event number, rather than elapsed time, so simultaneous exits remain distinct. The responsive SVG charts add no dependency or market-chart subscriptions. Point tooltips and the expandable event table retain exact UTC timestamps. The table includes the starting baseline, cumulative net PnL, realized balance, high-water mark, and drawdown for each event.

Realized balance = fixed reference balance + cumulative closed-position net PnL. The high-water mark starts at the initial reference balance and rises only when realized balance makes a new peak. Drawdown USD = high-water mark − current realized balance. Drawdown % = drawdown USD ÷ positive high-water mark × 100. Maximum dollar and percentage drawdowns are tracked across chronological events, including early losses and multiple exits at one timestamp. If realized balance reaches zero or below, USD drawdown remains valid; affected percentage observations and maximum percentage reporting become **unavailable**, with an explicit warning.

This is a **closed-trade-only realized balance curve, not full mark-to-market account equity**. Open-position valuations do not enter it. Entry commissions on still-open positions have already been incurred, but enter the curve with the position's full net result only when it closes. Realized drawdown therefore has a closed-position event basis even when the dashboard counts completed setups. Coverage warnings remain on execution records; the chart cannot reconstruct missing prices or intraminute equity. Nothing looks ahead to unrevealed exits or forces open positions closed at the end of history.

### Journal CSV schema

**Export Journal CSV** downloads all executed position records in the current session, including open positions. There is one header row and one row per executed position, ordered by entry timestamp and stable position ID. Requests that never executed are excluded. The filename contains the session ID.

```csv
setup_id,position_id,symbol,direction,volume_lots,entry_timestamp_utc,entry_price,exit_timestamp_utc,exit_price,exit_reason,initial_sl,final_sl,original_risk_usd,gross_pnl_usd,entry_commission_usd,exit_commission_usd,total_commission_usd,net_pnl_usd,net_r,setup_label,setup_tag,setup_notes,status,coverage_warnings
```

Timestamps use ISO 8601 UTC (`2024-01-09T00:01:00.000Z`); prices are EURUSD, risk/PnL/commissions are USD, and volume is standard lots. Numbers retain the engine's full JavaScript precision without UI rounding. `initial_sl` is the original stop recorded at execution; `final_sl` is the latest stop. `status` is `open`, `pending close`, or `closed`. Exit reason is `manual` or `stop_loss`. `coverage_warnings` is a JSON array with side, reason, and inclusive `from`/`to` ISO UTC timestamps. Empty arrays are `[]`.

For open positions, exit timestamp/price/reason, exit and total realized commission, gross/net realized PnL, and net R are blank. Incurred entry commission and known execution/risk fields remain populated. Invalid R denominators are blank. Open-position results and exit fees are never estimated for export.

CSV uses CRLF record separators, double-quoted fields, doubled embedded quotes, and preserves commas/newlines inside notes. User-entered labels, tags, and notes starting with `=`, `+`, `-`, or `@`, including after leading whitespace/control characters, receive a leading apostrophe to prevent spreadsheet formulas. This export-only protection preserves original in-memory text. CSV import is not implemented.

The existing bid/ask spread, gross risk cap, percentage/manual sizing, per-lot commission model, and seven-day history limit are unchanged. No take profits, new order types/pairs, compounding, swaps, financing, or automatic strategies are introduced.

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

The React/Vite frontend displays one to three synchronized historical EURUSD bid candlestick charts using TradingView Lightweight Charts. The Node.js backend exposes `GET /api/health` and `GET /api/history`. Charts preserve market gaps. The full-history viewer remains available until replay starts; manual replay then progressively reveals M1 data with synchronized partial higher-timeframe candles. Bollinger Bands, slow Stochastic, and Ichimoku Cloud are available independently on each chart, including during replay. Automatic indicator presets and simulated market orders are available. Independent adjustable stop-losses execute on revealed M1 bid/ask data, with gap-through fills and coverage warnings. Configurable USD per-lot commissions, gross/net PnL, open mark-to-close estimates, explicit setup grouping, session-only journal metadata, setup/position analytics, realized PnL/drawdown, and safe CSV export are available. Take profits and persistent records are intentionally excluded.
