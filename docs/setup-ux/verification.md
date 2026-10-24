# Setup UX verification

The `feat/setup-ux-overhaul` branch was created from current `main`. No merge was performed. All browser sessions used a separate temporary durable-storage directory. The user's saved sessions were never opened or modified.

## Authentic cache test

Chromium ran at desktop 1440 × 1000 and mobile 390 × 844 against the existing validated December 2, 2023 through March 30, 2024 inclusive cache (internal end March 31). It selected the 90-day preset without entering dates, pressed **Start backtest** once, reached a paused chart, saved, refreshed, and restored the original replay timestamp and indices. Startup took about 2.9 seconds on this machine.

- Selected trading dates: **January 1 through March 30, 2024 inclusive**.
- Automatically calculated replay start: **January 5, 2024 at 16:00 UTC**.
- Replay index: **30,678** in the full cached M1 history.
- Warm-up: **78 completed observed H4 candles from the same contiguous contract segment**. No current H4 bucket or candles from another contract contributed.
- Visible same-contract history at startup: 17,216 M1 candles, 3,505 M5 candles, 1,169 M15 candles, 293 H1 candles, and 79 H4 candles. These include the revealed replay candle; only 78 H4 candles were completed before replay began.
- Default enabled indicators were ready on M5, M15, H1, and H4. M1 defaults have no indicators enabled. The application reports additional warm-up for larger edited settings.
- Databento credentials: absent from the test client. Provider methods throw and count attempts. **Zero provider requests and zero paid submissions** occurred.
- A SHA-256 manifest of every provider-cache file before and after the browser run matched exactly, including the spending ledger. No budget or lock file was created or changed.
- Real Chromium mouse dragging, keyboard arrows, and CDP-dispatched touch gestures changed slider values. No manual date or replay-time entry was used to launch.
- Both widths had zero horizontal document overflow and a visible Start button. No browser page errors occurred.

Machine-readable evidence: [browser-evidence.json](browser-evidence.json). Reproduce with an existing authentic cache and externally installed Playwright:

```sh
PLAYWRIGHT_MODULE=/tmp/forextester-browser-tools/node_modules/playwright-core/index.mjs node --import tsx scripts/setup-ux-browser.mts
```

The script does not provision dependencies, obtain credentials, or make paid requests. It reads the configured `FOREXTESTER_CACHE_DIR` (default user cache directory) and creates isolated temporary session storage.

## Screenshots

- [Desktop Setup](setup-1440.png)
- [Mobile Setup](setup-390.png)
- [Desktop chart immediately after one-click start](trading-1440.png)
- [Mobile chart immediately after one-click start](trading-390.png)
- [H4 indicator history](trading-h4-history-1440.png), after changing timeframe and zooming out with the mouse. The initial shared viewport follows the existing chart synchronization behavior; the full permitted pre-roll is installed even when outside the visible viewport.

## Checks

**559 tests passed across 43 test files**, including all existing tests with updated production-workflow expectations. New tests cover daily cache gaps and corruption, empty closure days, 30-day pre-roll, cached presets, UTC/leap boundaries, observed completed H4 warm-up, contract resets, no future-price dependence, invalid/manual ranges, edited indicator requirements, duplicate startup, cancellation, expired quotes, saved start preservation, replacement dataset persistence, and the production rollover blocker. Existing paid approval, spending guards, cache integrity, execution, persistence, and rollover tests remain enabled.

Typecheck, production build, and `git diff --check` passed. Vite retains its advisory for a client bundle above 500 kB; this task adds no dependencies or bundle-splitting infrastructure.

## Visual finish review

Independent finish review: **PASS**.

| Material finding | Disposition |
| --- | --- |
| Selection controls and readable UTC period | Resolved |
| Persistent primary action at 1440 px and 390 px | Resolved |
| Responsive control layout and legibility | Resolved |
| Visible chart history and indicator readiness | Resolved |
| Cached launch and session restoration | Resolved by Chromium evidence |
| Material partial or unresolved findings | None |

The mechanical design detector reported the existing pinned Inter font and a 2 px colored rollover boundary on the timeline. Both match the supplied terminal design and meaningful timeline markings. The review did not independently verify paid-approval or advanced/account states from screenshots; those paths are covered by deterministic tests.

## Limits

The 90-day selection starts trading on January 5 because earlier selected minutes lack sufficient same-contract completed H4 history. This is stated before Start. Replay continues to pause at the next contract change; no rollover or synthetic continuous-price policy was introduced. Cached closure days do not fabricate market observations.

Only missing dates are quoted when the user deliberately starts an uncached interval. Provider availability can still reject that interval, and paid requests remain subject to credentials, credits, quote expiry, the persisted spending lock, and the $5 verification budget. No real paid download was performed for this change.

The cache calendar validates local daily references when opened/refreshed. Starting revalidates the complete selected interval and its pre-roll, so external cache changes cannot silently trigger a paid download. Long archives are browsed in 120-day windows; individual presets remain capped at 90 calendar days.
