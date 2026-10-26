# PR #41 fixes

The reviewed commit was `d164d7b8055ddae93f37a5040e49788d992a0ec4` on
`feat/backtest-warmup-chart-defaults`.

## Zero indicator warm-up

`replayReadiness()` rejected an empty list of positive warm-up requirements.
Three additional boundaries also required `history.from < tradingFrom`:
`HistoryLoader`, the HTTP history route / archive reader, and saved-history
validation. Changing readiness alone would still fail loading or restoration.

With no positive requirements, readiness now returns the first real observation
inside the requested replay interval, `count: 0`, `required: 0`, `timeframe: null`,
`checks: []`, and `warmupFrom: range.from`. Loading accepts equal history and
replay starts and requests no preceding days. A replay still needs an actual
observation. The omitted-boundary legacy 30-day fallback remains for existing
callers. Enabled indicators still require their original completed observed
candles, including 78 D1 candles for default Ichimoku, entirely before replay.

Saved-history validation accepts equal boundaries without changing fingerprint
formats, saved indicator settings, account settings, commissions, or historical
objects. New zero-indicator sessions and existing sessions use the same disk and
browser validators.

## Full-day gaps

Previously, every calendar entry except `invalid` counted as available. Archive
import uses `gap` for every empty UTC day, without knowing why observations are
absent. This let unexplained empty trading days pass readiness.

The shared coverage check now accepts:

- Cached days with positive observation counts.
- Full UTC Saturday or Sunday closures supported by the installed archive's
  repeated weekend pattern. That weekday must have at least two entries, all
  explicitly empty gaps, across the archive. Any observations on that weekend
  weekday prevent automatic full-day closure classification. This keeps a
  provider's Sunday trading distinct from a Monday-to-Friday archive.
- Explicit dataset calendar closure evidence: an empty `gap` with a nonblank
  `closure.reason` and `closure.source`. This is installed calendar metadata,
  not a browser request parameter or a guessed holiday name.

Missing entries, invalid days, empty cached days, unexplained weekdays, and
unverified weekend gaps are rejected. Random Range, duration presets, manual
readiness, warm-up coverage, and backend replay reads share this policy. Replay
failures have their own count and UI/API error, separate from insufficient or
missing warm-up history. The existing uniform index selection over all eligible
start dates remains unchanged.

The installed archive has no reliable holiday calendar or holiday provenance.
This patch adds no holiday labels to it. Its 31 empty weekdays remain unverified.
No calendar, provider, pricing, or download request is made. No M1 source or saved
historical object is rewritten, and no candle is filled or manufactured.

## Limits

A weekday holiday without dataset-specific evidence is rejected, even if its
name looks familiar. Weekend schedule inference is conservative across the whole
installed archive: a change in provider hours can leave an otherwise legitimate
empty weekend day unverified. The policy checks full-day absence; positive daily
counts do not certify intraday feed completeness. Existing intraday gaps remain
unchanged.

## Verification

Regression coverage includes first-date zero-indicator replay for 1, 2, and 3
charts, a single M1 chart, readiness when switching chart modes, the exact
77/78-candle D1 boundary, equal-boundary loader/API requests, saved-session
restoration with original commission, normal weekends, documented weekday
closures, unexplained trading-day gaps, independent cached intervals, and uniform
selection over eligible starts.

The real installed archive still has eligible 7-, 30-, 90-, 180-, and 365-day
presets, plus 3,324 eligible default-indicator 120-day random starts. Its latest
valid 365-day replay is 2021-12-25 through 2022-12-24 inclusive. Presets can select
an earlier valid interval when recent history contains an unverified gap.

Browser verification uses temporary session directories, the real installed
archive, Chromium, and viewports of 1100 × 800 and 1440 × 1000. Original default
layouts and the $7 commission are checked separately from restored $3.75
zero-indicator sessions. Every first-date load must have `from === tradingFrom`
and replay index 0. Reload must use the saved historical object without another
history-range read. Browser request logs check for provider/download routes,
external requests, page errors, and horizontal overflow.

Reproduce with the installed Chromium and Playwright paths configured as needed:

```sh
npm test -- --maxWorkers=1 --reporter=dot
npm run typecheck
npm run build
git diff --check
BROWSER_OUTPUT=docs/pr41-fixes/defaults node --import tsx scripts/backtest-defaults-browser.mts
node --import tsx scripts/pr41-regressions-browser.mts
```

## Files changed

Production changes are limited to `frontend/src/cacheCalendar.ts`,
`frontend/src/historyLoader.ts`, `frontend/src/sessionCodec.ts`,
`frontend/src/App.tsx`, `backend/src/localArchive.ts`, and `backend/src/app.ts`.

Regressions are in `frontend/src/cacheCalendar.test.ts`,
`frontend/src/historyLoader.test.ts`, `frontend/src/workflow.test.tsx`,
`backend/src/localArchive.test.ts`, `backend/src/app.test.ts`, and
`backend/src/singlePricePersistence.test.ts`. `tests/localForexFixture.ts` now
uses explicit UTC when generating weekend closures; DuckDB otherwise applied
the host timezone and created Sunday observations after daylight saving began.
The workflow fixture now describes its real replay observations instead of
relying on unexplained empty replay weekdays. Its invalid-range check uses a
start just over the 365-day limit; the previous 2000-to-2024 range rendered about
24 years of timeline markers and exceeded the unchanged five-second test limit.
The assertion still checks rejection without a history request.

`scripts/backtest-defaults-browser.mts` checks every duration preset and supports
a separate evidence directory. `scripts/pr41-regressions-browser.mts` checks
first-date zero-indicator setup, start, and restore for every layout at both
widths. Screenshots and JSON reports are under `docs/pr41-fixes/`.

## Final results

- `npm test -- --maxWorkers=1 --reporter=dot`: 60 files, 803 tests passed,
  including 17 new regression cases. The five-second per-test limit is unchanged.
- `npm run typecheck`: passed for both workspaces.
- `npm run build`: passed for both workspaces. Vite still reports the existing
  bundle size warning; some UI tests emit React `act` warnings.
- `git diff --check`: passed.
- Default setup, every duration preset, cached-only Random Range, and all default
  chart layouts: passed in Chromium at both requested widths. See
  [default workflow report](defaults/browser-verification.json).
- Zero-indicator setup, mode switching, first-date start, and reload for all three
  layouts at both widths: passed. See
  [zero-indicator report](zero-indicator-browser.json).
- Browser page errors, external requests, paid/download requests, and horizontal
  overflow: none.

No new dependencies, market-data downloads, calendar requests, saved-object
rewrites, merge actions, or auto-merge changes were introduced.
