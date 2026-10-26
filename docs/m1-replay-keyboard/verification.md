# M1 replay keyboard navigation

Branch: `feat/m1-replay-keyboard-shortcuts`, based on latest `main`
(`9ca482a`).

## Implementation

Ctrl + Shift + Left/Right passes an explicit `M1` override from
`useReplayKeyboard` into the existing `replay.navigate()` call in `App`.
Plain Shift + Left/Right continues using the focused chart timeframe.
The existing pause, editing, overlay, placement, and session guards are shared.
Alt, Meta, composition, already-handled events, arrows without Shift, and
unrequested directions remain ignored.

The replay engine, candle navigation helpers, execution logic, and chart
synchronizer are unchanged. The existing chart offset still bounds review.
There is no second replay clock or synthetic minute data.

The main header button is named **Next Min** and still calls `replay.next()`.
Execution Details explains both combinations and that backward navigation only
reviews history without rewinding trade execution.

## Regression coverage

- Plain Shift still completes focused M5, M15, H1, H4, and D1 candles.
- Ctrl + Shift moves one available M1 observation on those timeframes.
- Backward review is bounded, hides unrevealed data, and returns to the executed
  cursor before any further execution advances.
- Sparse M1 timestamps cross missing minutes and a weekend using real rows only.
- Replay end and futures rollover boundaries remain enforced.
- H4/D1 App tests check both displayed charts after forward and backward
  navigation, retain focused pane/timeframes, and preserve an executed position,
  trading state, equity ledger, and execution cursor during review.
- Both shortcut combinations retain playback, busy/inactive, typing, overlay,
  indicator, execution-panel, and order-placement restrictions.
- Next Min has the new visible/accessibility name and still advances one M1 row.

## Chromium

The existing browser verification harness was extended and run against the real
production App and installed archive, with isolated temporary session storage.
At 1100 × 800 and 1440 × 1000, it checks Ctrl + Shift on focused H4 and D1 panes,
backward review without changing the saved execution state, returning to the
current cursor, Next Min advancing exactly one observation, plain Shift H4
stepping, and Execution Details text.

Both viewports passed without page errors, external requests, paid/download
requests, or horizontal overflow. See [browser report](browser-verification.json)
and screenshots [1100px](charts-2-1100.png) and [1440px](charts-2-1440.png).

## Changed files

- Production: `frontend/src/App.tsx`, `frontend/src/useReplayKeyboard.ts`.
- Tests: `frontend/src/useReplayKeyboard.test.tsx`, `frontend/src/workflow.test.tsx`.
- Browser harness: `scripts/backtest-defaults-browser.mts`.
- Button selectors: `scripts/chart-replay-browser.mts`,
  `scripts/chart-replay-verification.ts`, `scripts/local-parquet-browser.mts`,
  `scripts/results-dashboard-browser.mts`.
- Verification evidence: `docs/m1-replay-keyboard/`.

The separate historical `RegressionWorkspace` test fixture retains its own
button text; production App tests and browser selectors use Next Min.

## Results

- Focused navigation tests: 29 passed across keyboard, replay, and candle navigation.
- Focused App tests: 5 passed for H4/D1 M1 navigation, shared guards, and rollover.
- Full suite: 60 files, 821 tests passed, including 18 new regression cases.
- Typechecking and production build: passed for both workspaces.
- `git diff --check`: passed.
- Chromium: both viewports passed, with no page errors or external requests.

Commands:

```sh
npm test -- frontend/src/useReplayKeyboard.test.tsx frontend/src/useReplay.test.tsx frontend/src/candleNavigation.test.tsx --maxWorkers=1 --reporter=dot
npm test -- frontend/src/workflow.test.tsx -t 'M1 shortcuts|blocks replay shortcuts|production rollover' --maxWorkers=1 --reporter=dot
npm test -- --maxWorkers=1 --reporter=dot
npm run typecheck
npm run build
git diff --check
BROWSER_OUTPUT=docs/m1-replay-keyboard node --import tsx scripts/backtest-defaults-browser.mts
```

The browser command uses the existing verification-only Playwright installation
via `PLAYWRIGHT_MODULE` and Chromium via `CHROMIUM_PATH` where needed; no dependency
was added. UI tests emit React `act` warnings and Vite reports its existing bundle
size warning; all checks complete successfully.
