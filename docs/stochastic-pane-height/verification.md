# Stochastic pane height persistence

Each saved session's existing UI preference envelope stores `stochasticPane:<chart slot>` as the Stochastic pane's share of the combined pane height. The share is common to that slot's timeframes and 1/2/3-chart layouts. Missing or invalid values use the existing 3:1 price/Stochastic split. No durable session schema or calculation changed.

The chart retains native separator handling. The hook compares public pane stretch factors at gesture start and completion and writes only a changed proportion. It restores after indicator creation and clamps the displayed split to the native 30 px drag minimum when space permits. Container resizing, initialization and indicator recreation never persist their temporary proportions. When space returns, the saved intended proportion returns.

Verification on October 28, 2026:

- All 887 tests passed across 64 files with `npm test -- --maxWorkers=2`.
- Workspace typechecks and production builds passed. The existing Vite warning for a bundle above 500 kB remains.
- Chromium performed actual separator drags in every chart slot of every layout and verified independent proportions, reload, complete browser shutdown/relaunch with the same profile, saved-backtest switching, timeframe changes, Stochastic disable/re-enable, replay updates, browser resizing, and minimum-height clamping/recovery.
- Browser checks reported no page errors or external requests. History, sessions and the Chromium profile were temporary test fixtures.

Run the browser regression with existing local Playwright/Chromium installations:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chrome \
node --import tsx scripts/stochastic-pane-height-browser.mts
```

[Measured results](verification.json), [independent resized panes](resized-three.png), [browser reopened](browser-reopened.png), [one chart](layout-1.png), [two charts](layout-2.png), [three charts](layout-3.png), [default split](default-three.png).
