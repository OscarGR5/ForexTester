# Startup session selection and preference cleanup

Verified on October 24, 2026. Branch: `feat/session-startup-cleanup`, based on `main` at `7fd7ba4` (merged PRs #18 and #20).

## Behavior

Disk sessions open a centered, 740px startup selector. Each entry shows its name, exclusive-end historical period in UTC, status, replay percentage, last save and candle counts. Resume restores the existing checkpoint through the existing recovery path. New opens a separate Setup without changing saved records. Renaming/deleting are secondary disclosures. Multiple sessions scroll inside the list; the overall selector also scrolls in short viewports. The heading receives initial focus and the next Tab reaches Resume. Trading and Results retain the native right-side Sessions / settings dialog.

No disk sessions opens Setup. Optional legacy discovery runs after disk initialization, so pending IndexedDB/migration discovery cannot delay Setup or disk session selection. Disk initialization errors display Retry storage connection. Existing history repair, migration, conflict and disk-file maintenance workflows remain available.

## Exact Local Storage behavior

After a successful backend deletion, the app attempts to remove only `forextester:ui:v1:<deleted-id>`. It reads the complete legacy inventory, including originals already imported to disk. A retained legacy original with that ID keeps the preference key. Backend deletion failure never removes preferences. Cleanup exceptions are reported separately and do not turn a successful backtest deletion into a failure. A competing app tab or unavailable Web Locks retains the key for later manual maintenance.

Sessions / settings → Storage maintenance → Clean up unused UI preferences creates a preview. It reads authoritative disk and legacy inventories, protects the current session even if unsaved, and inspects only the exact `forextester:ui:v1:` prefix. An empty ID is retained. Unreadable disk records, unavailable inventories or unavailable cross-tab exclusion prevent classification and removal.

Every app tab holds a shared Web Lock before initializing its workspace. Preview and confirmation temporarily request an exclusive, nonwaiting lock. Any other open tab, including a suspended tab or one with an unsaved Setup, prevents cleanup. New tabs cannot initialize while the exclusive operation is running. This coordination applies to tabs running this version; close or reload tabs left open on an older build before maintenance.

The preview lists the safe candidate count. Removal requires explicit confirmation and reacquires exclusion, rereads both inventories and the active ID, and checks each candidate's original value. Newly created keys and changed values are retained. Only unchanged, still-orphaned preview candidates are removed. The result reports successful removals and any Local Storage failures. Repeating cleanup is safe. There is no automatic startup bulk cleanup.

UI preference maintenance has no disk-delete, history-delete or market-data calls. Existing disk-file cleanup is a separate, unchanged control.

## Automated verification

- `npm test -- --maxWorkers=2`: **531 tests passed, 41 files**.
- `npm run typecheck`: passed for frontend and backend.
- `npm run build`: passed for frontend and backend.
- `git diff --check`: passed.

Added coverage includes zero/one/multiple saved sessions, initial focus, separate New, restored checkpoint/trading/equity/replay state, ordinary management, initialization errors, pending optional discovery, backend-confirmed deletion ordering, failed deletion, retained legacy originals, Local Storage exceptions, confirmation cancellation, protected active/saved/legacy/unrelated entries, unchanged-preview revalidation, unavailable inventories, unreadable records, unsupported Web Locks and idempotence.

## Chromium verification

Run with existing external verification tooling, without adding dependencies:

```sh
PLAYWRIGHT_MODULE=/tmp/forextester-browser-tools/node_modules/playwright-core/index.mjs \
  node --import tsx scripts/session-startup-browser.mts
```

`CHROMIUM_PATH` optionally overrides the installed Chromium executable. The runner creates a temporary backend storage directory and a fresh browser context. Its only backend is the storage API; all history coverage responses are mocked. No history service, data provider or paid client is constructed. The user's saved sessions, browser profile, data/cache directories and Databento spending ledger are untouched.

The [browser report](browser-verification.json) records real Chromium checks at **1440 × 900** and **390 × 844**: horizontal/vertical centering, list scrolling, heading focus, visible keyboard focus, no horizontal overflow, exact restored trading/equity/replay state, separate New, ordinary right-side management, confirmation cancellation, protected preference entries, repeat cleanup, a second tab with an unsaved session, unavailable disk inventory and confirmed deletion with real Web Locks. No browser errors or paid calls occurred.

Screenshots use deterministic offline fixture data:

- [Single saved session, desktop](startup-single-1440.png)
- [Multiple saved sessions, desktop](startup-1440.png)
- [Multiple saved sessions, mobile](startup-390.png)
- [Ordinary management during Trading, desktop](management-trading-1440.png)
- [Ordinary management during Trading, mobile](management-trading-390.png)

The design detector reported only the existing Inter font warning. Inter is explicitly required by `DESIGN.md`; the font stack was preserved.

## Independent visual review

**PASS**. A fresh reviewer inspected all five screenshots and the relevant styles. The documentation pass confirmed this is an ordinary extension; `DESIGN.md` and its sidecar remain unchanged.

| Material requirement | Status |
|---|---|
| Centered selector within 650–800px | Resolved |
| Clear Resume and New actions | Resolved |
| Readable session information | Resolved |
| Multiple-session scrolling and mobile layout | Resolved |
| Existing management dialog retained | Resolved |
| Open material findings | None |

The production build still reports Vite's 500 kB chunk-size advisory. It completes successfully; code splitting is outside this task's scope.
