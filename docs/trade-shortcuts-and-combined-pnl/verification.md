# Buy/Sell keyboard shortcuts and combined open PnL

Base: `main` at `281dd39` (merged PR #32). Branch: `feat/trade-shortcuts-and-combined-pnl`.

## Behavior

`B`/`b` and `S`/`s` click the real Buy/Sell buttons. Risk capture, setup selection, sizing and submission stay in their existing handlers. Choosing or dragging an SL does not submit an order. Confirmation queues the order; entry waits for the next eligible M1 candle.

The handler checks `:disabled`, including disabled ancestor fieldsets, and shares the existing replay keyboard editing/panel guard. Repeats, Ctrl/Alt/Meta, composition, already-handled events, drafts, confirmed-stop dragging, review, management, loading/confirmation and storage restrictions leave keyboard defaults alone. The listener uses current committed props and cleans up on unmount, including StrictMode remounts. Shift + Arrow behavior is preserved.

`combinedOpenPnl()` sums unrounded `markPosition().estimatedNetPnlUsd` for `state.positions` only, including paid entry commission and estimated exit commission. The percentage divides summed USD by the account reference balance. Any missing/nonfinite valuation makes the total unavailable. No open positions means no total. Account equity, Account PnL, journal and persistence calculations are unchanged.

`Open total` sits outside the scrolling position strip. The strip retains native horizontal scrolling and keyboard focus; its scrollbar is hidden to preserve the original toolbar height.

## Automated verification

- `npm test -- --maxWorkers=2`: **721 tests passed across 54 files**, [log](tests.txt).
- `npm run typecheck`: passed for frontend and backend, [log](typecheck.txt).
- `npm run build`: passed for frontend and backend, [log](build.txt).
- `git diff --check`: passed.

New tests cover both cases of both shortcut keys, current risk, initial and second entry confirmation, no submission before confirmation, direction/slot limits, repeats/modifiers/composition, focused editors, open overlays, permission changes, disabled ancestor fieldsets, drafts, confirmed-stop dragging, session guards, outstanding finish confirmation, StrictMode cleanup and finished lifecycle. Existing Shift + Arrow tests remain active.

Deterministic PnL tests cover one/two positions, opposite outcomes and different lot sizes, commissions, the reference-balance denominator, zero, fractional cents, missing/nonfinite marks, pending/completed closes, and exclusion of pending/closed/cancelled/rejected entries. Production App tests verify individual/combined updates, Account PnL, the journal and restored sessions.

## Chromium verification

Run with existing verification tooling, without adding dependencies:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/trade-shortcuts-pnl-browser.mts
```

The script uses the offline 6E cache and a temporary session directory. A verification-only Vite transform exposes state and public chart APIs for observation and price-coordinate mapping. Keyboard and mouse interactions drive the application; a synthetic repeated keydown additionally checks the repeat flag. Outbound browser traffic is blocked. The backend provider client throws on every provider method, with a $0 download budget.

All **27 layout measurements** passed: empty, two-open and one-open states in each of the nine combinations below. Controls and total remain in one row, with no page overflow. At 1000px, native ArrowRight input scrolls the two-position strip by 35px, and Tab reaches both Close buttons. The total stays fully visible outside the strip.

| Charts | 1440 × 1000 | 1100 × 800 | 1000 × 800 |
| --- | --- | --- | --- |
| 1 | [1440 × 39px toolbar](two-open-1-1440.png) | [1100 × 39px toolbar](two-open-1-1100.png) | [1000 × 39px toolbar](two-open-1-1000.png) |
| 2 | [1440 × 39px toolbar](two-open-2-1440.png) | [1100 × 39px toolbar](two-open-2-1100.png) | [1000 × 39px toolbar](two-open-2-1000.png) |
| 3 | [1440 × 39px toolbar](two-open-3-1440.png) | [1100 × 39px toolbar](two-open-3-1100.png) | [1000 × 39px toolbar](two-open-3-1000.png) |

The recorded workflow demonstrates Sell placement and Escape cancellation; Buy at 0.5% risk with chart selection, dragging, pip preview and chart-tick confirmation; first fill; blocked Sell, playback, review and confirmed-stop dragging shortcuts; second Buy at 0.35% risk with toolbar confirmation and fill in the same setup; slot enforcement; and live PnL updates.

Individual marks change from `-$39.82` and `-$42.42` to `-$401.82` and `-$244.42`; the total changes from `-$82.24 (-0.08%)` to `-$646.24 (-0.65%)`. Reload/resume restores identical trading state, individual PnL, combined PnL and Account PnL. Closing one position changes the total to the remaining position's `-$269.67 (-0.27%)`; closing all positions hides it. The script also confirms and fills a Sell after the Buy setup resolves.

[browser-evidence.json](browser-evidence.json) contains **57 keydown records** with handled status, repeats, modifiers and targets, plus draft/pending observations, PnL values, geometry, isolated session path and the SHA-256 cache manifest. [chromium.txt](chromium.txt) records the passing run.

Additional screenshots: [first Buy draft](buy-keyboard-first-draft.png), [second Buy draft](buy-keyboard-second-draft.png), [Sell draft](sell-keyboard-draft.png), [Sell confirmation](sell-keyboard-confirmation.png), [restored positions](restored-two-open.png), [after closing one position](one-open-after-close.png).

Provider requests: **0**. Paid submissions: **0**. Browser page errors: **0**. All **241** historical-cache files are unchanged.

## Limitations

Browser verification uses Chromium and cached 6E prices. Automated tests also cover legacy bid/ask execution, missing marks and positive/zero outcomes. Firefox, Safari and touch input were not exercised.

The production build retains the existing bundle-size warning. The [design scan](design-scan.json) reports only the existing Inter font and amber warning-border rules outside this change. Both match the established terminal design.
