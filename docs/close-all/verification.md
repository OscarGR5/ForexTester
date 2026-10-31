# Atomic Close all

## Investigation

The reported intermittent no-op could not be reproduced at baseline commit
`0006100`. Before changing production code, two tests using the real
`TradingDock`, `useTrading` and `useReplay` passed with and without StrictMode.
The original action also queued and executed two positions in both the Vite
development browser and the production browser build.

The old handler filtered the rendered positions, sorted their IDs, and called
`trading.close(id)` for each. Each call already used a functional `setSession`
update. React batching therefore does not, by itself, discard the first close.
No stale-state or replay-timing failure was established. The user's clarification
that neither individual button changes to “Close pending” places the reported
symptom before successful request queuing, rather than in next-candle execution.
The original intermittent root cause remains unconfirmed; this change must not
be described as a proven causal fix for that symptom.

## Change and execution path

`TradingDock` now invokes `trading.closeAll()` once. `useTrading` applies
`requestCloseAll` to the latest previous trading state through one functional
`setSession` update and increments `actionVersion` once. Eligibility is decided
inside that transition. Every open position whose `closeRequestedAt` is null
gets the current observed M1 timestamp. Existing requests and pending entries
retain their objects and values. A denied, unobserved, or already queued state
is a no-op at the trading-state level.

The replay execution path is unchanged. `useTrading` processes every newly
revealed M1 candle, including all intervening candles during a timeframe jump
or batched playback. `observeCandle` executes a requested manual exit only when
the next eligible timestamp is strictly later than its request timestamp.
Legacy bid/ask execution waits for synchronized observations and uses bid opens
for longs and ask opens for shorts. Local single-price execution uses the next
observed mid open. Existing manual-exit precedence, financial calculations,
commission snapshots, equity recording and session codecs remain in use.

Individual Close, permission checks, button styling and placement are retained.
There are no new dependencies, storage schemas or confirmation dialogs.

## Regression coverage

`frontend/src/closeAll.test.ts` tests real pure trading transitions: two positions,
already pending closes across a missing ask, pending entry preservation,
permissions, repeated requests, synchronized next-M1 prices, and fees/PnL.

`frontend/src/closeAll.test.tsx` exercises the real dock, hook and replay state:
StrictMode and normal rendering, one bulk action version increment, individual
Close followed by Close all, pending entries, multiple replay/timeframe advances,
single-price execution, repeated requests, playback/review permissions, equity,
and actual IndexedDB save/recovery with execution after remounting.

The focused test run passed 36 tests across these two files and
`TradingDock.test.tsx`.

The full suite passed all 907 tests in 66 files. Both workspace TypeScript checks,
the frontend/backend production build, and `git diff --check` passed. Vite emitted
its existing bundle-size warning; the build succeeded.

`scripts/close-all-browser.mts` serves the production frontend build with the
real local archive and temporary filesystem sessions. It exercises three pairs
of positions at each of 1100 px and 1440 px, changes timeframes and advances
replay, verifies immediate “Close pending” controls, repeated clicks, saved
queued closes across reload/resume, and next-M1 execution with financial results.
It rejects external requests and unexpected dialogs. User sessions are untouched.

Production Chromium verification passed all six cycles, closing 12 positions.
Both widths restored a saved pair of queued requests before executing their
exits. There were no page errors, dialogs or external requests.

Reproduce after `npm run build`:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/close-all-browser.mts
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

Browser results are recorded in `browser-verification.json`; screenshots show
two open positions and the final closed state at both widths.
