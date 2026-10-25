# Direct stop dragging and compact trading toolbar

Branch: `feat/direct-stop-drag-compact-toolbar`. Based on latest `main`, merged PR #31 (`60f21bee`). No engine, provider, cache, session schema, execution timing or financial calculation changes.

Confirmed stops now use the specific rendered annotation first, then the closest actual line within 7px. The canvas primitive records the exact rectangles painted from `stopLabelRows`, including text measurement, clipping and separated rows. A coincident shared line does not select an arbitrary position. Each drag locks its position and pointer IDs; displaced label drags preserve their grab offset.

Open toolbar records contain only B1/B2 or S1/S2, lots, estimated net USD/percentage and Close. Pending records contain identity, allocated risk and Cancel. Full IDs remain in state, DOM identity and accessible action labels. Removed the overlap chooser, position disclosures/popups, inline stop details, Modify SL and Choose another level. Initial placement retains live pip distance, selected-line adjustment, keyboard entry, the chart confirmation tick, Confirm order and Cancel placement.

## Automated verification

- `npm test -- --maxWorkers=2`: **681 tests passed across 53 files**.
- `npm run typecheck`: passed for frontend and backend.
- `npm run build`: passed for frontend and backend.
- `git diff --check`: passed.

Tests cover nearest-line targeting, both separated rendered annotations, coincident prices, locked IDs and pointer ownership, Escape/pointer cancellation/lost capture/blur, replay/placement permission changes, invalid releases, preserving the other position, label-bound invalidation, compact buy/sell and pending records, signed USD/percentage styling, full action IDs, real Close/Cancel handlers, persistence, and the existing execution/risk/session/provider regressions.

The initial unrestricted `npm test` run had one 5-second timeout in the unchanged indicator comparison in `replayBars.test.ts`; the other 678 tests passed. The full run with two workers passed without changing tests or timeouts. The production build retains the existing JavaScript chunk-size warning. The design scan flagged only existing Inter font and warning-border styles outside this change.

## Chromium verification

Run the current verification with:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/direct-stop-toolbar-browser.mts
```

Uses the existing offline daily history and an isolated temporary session directory. No application dependencies were added. Verification-only Vite transforms expose chart APIs, rendered annotation bounds and trading observations; all drag actions use real Chromium mouse input. Pointer-cancellation coverage dispatches a cancellation event while a real mouse drag is active.

Every pane is exercised in each chart-count/viewport combination, with 73 successful nearby-stop drags across the matrix. Each case starts with two stops less than 7px apart, independently drags each actual line, then independently drags each painted annotation. Assertions check the chosen ID, live price/risk preview, no durable preview mutation, one valid modification, unchanged other position, effective-after timestamp and unchanged independent chart time ranges.

| Charts | 1440 × 1000 | 1100 × 800 | 1000 × 800 |
| --- | --- | --- | --- |
| 1 | [Toolbar and lines](after-1-1440.png), [SL 2 drag](label-sl2-1-1440.png) | [Toolbar and lines](after-1-1100.png), [SL 2 drag](label-sl2-1-1100.png) | [Toolbar and lines](after-1-1000.png), [SL 2 drag](label-sl2-1-1000.png) |
| 2 | [Toolbar and lines](after-2-1440.png), [SL 2 drag](label-sl2-2-1440.png) | [Toolbar and lines](after-2-1100.png), [SL 2 drag](label-sl2-2-1100.png) | [Toolbar and lines](after-2-1000.png), [SL 2 drag](label-sl2-2-1000.png) |
| 3 | [Toolbar and lines](after-3-1440.png), [SL 2 drag](label-sl2-3-1440.png) | [Toolbar and lines](after-3-1100.png), [SL 2 drag](label-sl2-3-1100.png) | [Toolbar and lines](after-3-1000.png), [SL 2 drag](label-sl2-3-1000.png) |

The toolbar remains 39px high with one row, both position records alongside Risk/Buy/Sell/slots, and no full-page horizontal overflow. Both sample records fit even at 1000px; the existing position-only overflow rules remain available for longer content.

Baseline captures from `60f21bee`: [1440px](before-1440.png), [1100px](before-1100.png), [1000px](before-1000.png). `scripts/direct-stop-before.mts` captures the baseline against that revision.

Additional captures: [initial selected draft adjustment](initial-draft-drag.png), [one pending](one-pending.png), [mixed open/pending](mixed-open-pending.png), [two pending](two-pending.png), [coincident stops](coincident-stops.png), [Escape preview](escape-preview.png), [invalid-side preview](invalid-preview.png), [invalid-risk preview](invalid-risk-preview.png), [restored session](restored.png).

Additional assertions cover both coincident annotations and an inert shared line, Escape and pointer cancellation, wrong-side and combined-risk rejection, initial keyboard entry and chart-tick submission, historical-review restrictions, playback restrictions, actual Close and pending Cancel actions, and identical trading state after reload/resume.

## Offline evidence and limits

See [browser-evidence.json](browser-evidence.json) for layout measurements, pointer coordinates, position IDs, modification outcomes, previews, screenshots, isolated session location and the SHA-256 historical-cache manifest. [before-evidence.json](before-evidence.json) records the baseline captures and network counters.

Provider requests: **0**. Paid submissions: **0**. Historical cache: **unchanged**, verified against the full before/after manifest. Browser page errors: **0**.

Browser coverage uses Chromium mouse input and the existing cached 6E session. Buy/sell presentation and legacy bid/ask execution are covered by automated tests. No manual touch-device or other-browser run was performed.
