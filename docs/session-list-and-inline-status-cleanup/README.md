# Session list and inline trading status

Base: main at `3deb751` (merged PR #33).

Saved backtest labels now open an inline rename form. Enter or **Confirm rename** commits the trimmed label; Escape and **Cancel rename** discard it. Session IDs, checkpoints, and historical fingerprints are retained. The trash icon opens an inline confirmation naming the backtest and explaining removal from this computer's local storage. Cancellation restores the trash button's focus. Successful deletion focuses the next saved label, the previous label, or **New backtest**.

Placement guidance, observed-price estimates, errors, confirmation, cancellation, and keyboard SL entry share the main trading row. The status and position areas scroll horizontally as needed. Risk, Buy, Sell, combined open PnL, and Close all remain in the row. Compact placement controls keep their explicit accessible names.

**Close all** calls the existing close action for each position without a close request, sorted by entry ID. Permission checks match individual Close, pending entries remain untouched, and execution still occurs on the next M1 candle. Default styling has a caution border; hover and keyboard focus use the red danger state. No confirmation was added.

## Toolbar height

| Viewport | Before: SL placement | After: selecting SL | After: keyboard price | After: selected SL | After: two open positions |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440 × 1000 | 93 px | 39 px | 39 px | 39 px | 39 px |
| 1100 × 800 | 93 px | 39 px | 39 px | 39 px | 39 px |
| 1000 × 800 | 93 px | 39 px | 39 px | 39 px | 39 px |

The 54 px reduction applies while placing a stop. The baseline toolbar without placement remains 39 px. Measurements cover one, two, and three chart layouts. Each state checks page width and keeps the fixed controls within the toolbar bounds.

## Screenshots

- Chooser: [before](before-chooser.png), [after at 1440 px](after-chooser-1440.png), [1100 px](after-chooser-1100.png), [1000 px](after-chooser-1000.png).
- Session actions: [inline rename](inline-rename.png), [delete confirmation](delete-confirmation.png), [after deletion](after-delete.png).
- Placement: [baseline at 1000 px](before-placement-1000.png), [inline selection](selecting-sl-1000.png), [keyboard price](keyboard-sl-1000.png), [selected stop](selected-sl-1000.png).
- Positions: [two open positions](two-open-1000.png), [Close all default](close-all-default.png), [Close all hover](close-all-hover.png).
- Persistence and journal: [restored after Close all](restored-after-close-all.png), [journal](journal-after-close-all.png).

## Verification

Passed: 728 deterministic tests across 54 files, workspace typecheck, production build, and `git diff --check`. Chromium passed 53 checks and captured 25 after screenshots plus four baseline screenshots. Provider requests: 0. Paid submissions: 0. Browser errors: 0. Cache manifest unchanged.

Deterministic tests cover rename entry, confirmation, Escape/cancellation, blank names, durable identity, delete confirmation/cancellation, focus restoration, inline placement and keyboard price entry, deterministic Close all ordering, permission guards, pending-order exclusion, individual Close, combined PnL, commissions, journal, and session restoration.

The Chromium script uses temporary session storage and existing Databento cache files. Provider methods throw, the paid-download route is blocked, and external browser requests are blocked. A before/after SHA-256 manifest verifies that cache contents are unchanged. The after run uses the cached 30-day preset, including the existing indicator pre-roll. Baseline captures used the cached 90-day preset before edits.

```bash
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
PLAYWRIGHT_MODULE=/tmp/forextester-keyboard-tools/node_modules/playwright-core/index.mjs \
  node_modules/.bin/tsx scripts/session-list-inline-status-browser.mts
```

Evidence: [baseline measurements](before-evidence.json) and [Chromium results](browser-evidence.json).

Long placement text and position records intentionally scroll within the toolbar. No new runtime dependencies were added. The existing build warning for a frontend chunk above 500 kB remains. The design scan only flagged the existing Inter font and paid-download warning border; both are outside this change.
