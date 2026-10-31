# Replay keyboard update-depth regression

The paused-navigation path repeatedly scheduled updates whose values were already
current. `App` cleared an already-empty keyboard notice, and the autosave effect
set `Saving` for every paused snapshot while a save was already pending. Sustained
native key events accumulated these effect-originated updates until React's
nested-update check fired. The next setter in the keyboard path appeared in the
stack, so `App.tsx:155` identified the trigger rather than the whole cycle.

Chromium reproduced the original failure with rapid and repeated keydown events
for both Shift+Arrow and Ctrl+Shift+Arrow. Removing only the notice clear moved
the failure into `useReplay.navigate`. Guarding the autosave status transition
removes the remaining redundant effect update. The effect's triggers and save
queue timing stay unchanged, including failure and retry behavior.

`useReplay` resets only on source changes and guards duplicate navigation against
the rendered session. `useTrading` processes each newly revealed M1 observation
before children render, then stops at its execution cursor. Historical review
does not advance that cursor. The synchronizer's bounds effect and chart data
effects have bounded inputs; changing them was unnecessary.

The regression checks cover native events outside `act()`, a pending checkpoint
write, repeated forward and backward navigation, chart synchronization, M1
overrides on a higher-timeframe pane, immutable execution during review, playback
feedback clearing on pause, and durable reload. The browser harness allows the
existing duplicate-event guard to coalesce events received before a commit; it
checks committed cursors against the exact permitted candle boundaries.

Run the deterministic suite and both Chromium modes:

```sh
npm test -- --maxWorkers=2
npm run typecheck
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/replay-keyboard-browser.mts
REPLAY_BROWSER_MODE=production PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/replay-keyboard-browser.mts
git diff --check
```

The browser harness uses the installed local archive and temporary session
storage at 1100 × 800 and 1440 × 1000. Each viewport sends 400 forward burst
events, 320 backward burst events, and single-step review/return checks, without
delays between keys. It rejects React depth errors and page errors, verifies
reloads, and asserts that the initial history HEAD still returns 404. Reports
and screenshots are written to `/tmp/forextester-replay-keyboard` by default.
LastPass and unrelated DevTools messages are outside this change.

Verified October 31, 2026: all 928 tests in 67 files passed, along with typecheck,
build, and both Chromium modes at both viewport sizes. All four browser runs
reported no React/page errors or external requests and retained the history HEAD
404 response.
