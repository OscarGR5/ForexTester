# SL labels and confirmed pending visibility

Canvas annotations show SL 1 / SL 2, distance from entry in pips, and signed net outcome at the stop level. The exact chart price appears only in the existing Y-axis label; the dock retains its full label including price. Both confirmed lines are red. Pending lines are dashed; active lines are solid. Nearby annotation rows separate with connectors to their exact prices; built-in axis prices stay visible without duplicated axis titles.

The pip convention remains 0.0001 for EURUSD and the current 6E-derived forex-style simulation. Active amounts use actual entry, fixed lots, incurred entry commission and expected exit commission through the existing engine helpers. Positive outcomes remain positive when a stop locks in profit. Pending distance, size and money are explicitly observed-price estimates until execution establishes the fill. Gaps can change stop outcomes.

Pending visibility derives from the existing persisted pending entries, without a schema migration or execution changes. Lines retain their entry ID through fill. Cancelled, rejected and closed entries leave the overlay. SL numbers follow the original submission order within each setup, using existing persisted entry IDs across pending, open, closed, cancelled and rejected records. SL 2 retains its number when SL 1 closes or is cancelled, including after refresh and subsequent fill. No stored fields are added or migrated.

## Verification

- `npm test -- --maxWorkers=2`: 47 files, 597 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite reports a bundle larger than 500 kB.
- `git diff --check`: passed.
- Impeccable mechanical detector: no findings on the changed UI targets.
- Desktop Chromium at 1440 × 1000: real pointer placement, confirmation before candle advance, fill, second entry, overlapping labels, cancelled drag, committed drags, all three panes, two pending entries, backend restart, refresh, cancellation and subsequent fill passed. Focused regressions verified that canvas text omits the price while the axis retains it, and SL 2 keeps its identity after SL 1 closes or is cancelled, after restore and after fill. A 390 × 844 viewport check found no horizontal document overflow.
- Provider requests: 0. Paid submissions: 0. Browser errors: 0. Existing cache manifest unchanged. Durable test sessions used an isolated temporary directory.

Run the browser check with an installed verification-only Playwright module and Chromium, using `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` if their locations differ from the script defaults:

```sh
node_modules/.bin/tsx scripts/sl-labels-browser.mts
```

## Screenshots

- [One active SL](one-active-sl.png)
- [Two nearby active SLs](two-close-active-sls.png)
- [Confirmed pending SL before fill](one-pending-before-fill.png)
- [Active and pending stops together](active-and-pending.png)
- [Two SLs after dragging](two-modified-sls.png)
- [Two active SLs across three panes](two-sls-3-panes.png)
- [Two confirmed pending SLs before fill](two-pending-before-fill.png)
- [Pending SLs restored after backend restart and refresh](pending-restored-after-backend-restart.png)
- [SL 2 after SL 1 closes](sl-2-after-sl-1-close.png)
- [Pending SL 2 after SL 1 is cancelled](sl-2-after-sl-1-cancel.png)
- [SL 2 restored after cancellation](sl-2-restored-after-cancel.png)
- [SL 2 active after cancellation and fill](sl-2-filled-after-cancel.png)

The machine-readable [browser evidence](browser-evidence.json) records labels, stop values, line options and the verification checks.
