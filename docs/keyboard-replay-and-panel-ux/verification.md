# Risk-only entry, keyboard replay, and panel dismissal

New entries use **Risk per entry (%)**, initially 1%. The existing engine sizes each fill independently, rounds down to 0.01 lots, and enforces combined risk and two-position limits. Existing numeric/manual-lot records still load through the same saved-session reader and engine.

While replay is paused, Shift + Right completes the active chart's current partial timeframe candle, or advances one further actual candle when the current candle is complete. UTC bucket boundaries are unchanged. Missing observations and closures are traversed without synthetic candles. The trading hook processes the complete newly revealed M1 prefix in chronological order, including fills, stops, close requests, commissions, and equity. Contract rollover remains a hard boundary.

Shift + Left performs **non-destructive historical review, not trade-execution rewind**. It changes a transient display cursor shared by the visible panes. The active pane's timeframe determines each backward or forward review step. All panes stop at that cutoff; current entry/SL annotations and position records are hidden. Placement, stop modification, playback, and ordinary Next Candle are disabled. The header clock and account PnL continue to describe the authoritative replay; the review strip labels its separate UTC cutoff. Shift + Right returns through reviewed candles to the authoritative cursor; only a subsequent press advances execution. Return to current replay exits review immediately. Review state is cleared on restart, history replacement, and session restore and is never added to the durable session format.

Clicking, panning, wheel input over the plot or price axis, or changing timeframe selects the active chart. Its header has a thin aqua accent. The selected chart persists beyond the existing 1.5-second viewport activation window. Removing it falls back to Chart 1.

The shortcut listener ignores editors, open dialogs/disclosures, drafts, SL drags, startup, and storage conflicts/operations. Playback reports that replay must be paused. Only handled navigation prevents the browser's arrow behavior. StrictMode cleanup prevents duplicate replay listeners.

Execution details and Indicators retain native details/summary keyboard behavior. The shared outside-interaction hook dismisses on an outside pointer press plus click and on Escape. Interactions begun inside do not dismiss on release outside. Escape returns focus to the disclosure control. Indicators share a native disclosure group, so opening another closes the first without shifting chart headers. Settings remain applied. Optional management uses the same hook with native modal backdrop geometry; required or busy dialogs cannot dismiss this way, and dismissal returns focus to the opener. Paid approval dialogs are unchanged.

## Automated checks

The full Vitest suite covers risk-only UI submissions, two independent sizes, persisted manual lots, chart activation and fallback, M5/M15/H1/H4/D1 boundaries, partial buckets, missing observations/weekends, chronological execution with stop fills and commissions, rollover, review state immutability and return, editor/dialog/draft/drag guards, StrictMode listener cleanup, dismissal, and settings preservation.

Required commands:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

## Chromium evidence

Run with an external verification-only Playwright installation and the existing local cache:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/keyboard-replay-browser.mts
```

The script starts an offline backend with provider methods that throw, a $0 test budget, and temporary durable session storage. It blocks nonlocal browser requests and the paid-download endpoint. Public chart APIs and replay/trading state are observed through verification-only Vite transforms; production builds have no inspection globals. Every keyboard advance is compared with sequential M1 engine execution, and execution/equity observation counts must match the full traversed prefix.

`browser-evidence.json` records UTC timestamps, M1 observation counts, cutoff/state checks, restoration, and provider/paid-request counters. Screenshots include each 1/2/3-chart layout, historical review, Indicators, and management at **1440 × 1000** and **1100 × 800**, followed by a risk-only draft, executed trade, and saved/refreshed/restored session. The H1/M5 demonstration checks active-chart selection, stepping, backward/forward review, return to current replay, and restored trading availability. A cache manifest comparison requires every cached file to remain byte-identical.

## Recorded result

- **639 tests passed across 51 files**; both workspace typechecks, both production builds, and `git diff --check` passed.
- Chromium passed all six layout/viewport combinations and produced 27 screenshots with no browser errors. Provider requests: 0. Paid submissions: 0. Cache bytes: unchanged.
- In the two-chart desktop demonstration, M5 advanced 5 actual M1 observations, then H1 completed its remaining 55 observations. A later H1 step traversed 52 actual observations over missing minutes. The trade-execution step crossed the weekend using 59 observations, and the restored session retained its one risk-sized position and exact authoritative timestamp.
- One earlier concurrent suite/browser run exceeded an existing 5-second indicator-test timeout. The final complete suite passed with Chromium stopped; no test timeout or production indicator behavior was changed.
- The UI detector reported only existing stylesheet findings (the incumbent Inter stack and an unrelated paid-confirmation border); no new finding was introduced.
