# Live draft SL distance and inline positions

Base: `aef2952` (main, merged PR #30). Verification uses Chromium, the existing offline Databento cache, and temporary isolated durable sessions. No provider calls or paid submissions were made. Cache filenames and SHA-256 checksums match before and after.

## Behavior

Draft labels update during native pointer movement without React renders or trading-state mutations. Selection and completed draft drags update only the draft. The exact price remains on the price axis. Confirm order, Confirm SL change, and the on-chart tick retain the existing validation. A synchronous confirmation guard prevents duplicate submissions from the toolbar and tick. Escape cancels placement; pointer cancellation or focus loss restores the selected draft price during a drag. Existing confirmed-stop dragging still applies on valid release.

Distance is absolute price difference / 0.0001, formatted to one decimal. 6E uses the current observed trade close. Legacy entries use observed ask for Buy and bid for Sell; modifications use bid for Buy and ask for Sell. Entry-to-SL risk continues to use the actual entry. Missing references show `Distance unavailable`; invalid sides have both text and color. Crosshair synchronization cannot create another pane's draft preview. Hover previews clear on leaving the pane, while selected drafts remain visible.

Risk, Buy, Sell, Slots and positions share one row. Position summaries retain lots, stop identity/price/pips, estimated net USD/percentage PnL and management actions. Native details expose full direction, position/setup IDs, entry price and the complete stop outcome. Pending summaries retain risk/stop information and Cancel entry. Keyboard focus scrolls actions into view, the region accepts native keyboard scrolling, and the native horizontal scrollbar supports mouse and trackpad input.

## Chromium measurements

All values are CSS pixels. These dimensions were checked with two open positions in **each** 1-, 2- and 3-chart layout. The 10 px native horizontal scrollbar is enabled in Chromium verification.

| Viewport | Before toolbar | After toolbar | Position strip | Content width | Page width |
| --- | --- | --- | --- | --- | --- |
| 1440 × 1000 | 1440 × 77 | 1440 × 39 | 1140.33 × 30 | Fits without scrolling | 1440 |
| 1100 × 800 | 1100 × 119 | 1100 × 49 | 800.33 × 40 | 1004 | 1100 |
| 1000 × 800 | 1000 × 119 | 1000 × 49 | 700.33 × 40 | 1004 | 1000 |

The controls and both position records have bounds within the toolbar's single row. At 1100 and 1000 only the position strip overflows. There is no page-wide horizontal overflow. Pending-only, one open and mixed pending/open states were also measured. Draft placement, critical errors and historical review retain their temporary separate strips.

Live pointer evidence, before any selection or confirmation:

| Direction | First draft price / distance | Second draft price / distance | Observed reference |
| --- | --- | --- | --- |
| Buy | 1.09997 / 9.8 pips | 1.09896 / 19.9 pips | 1.10095 |
| Sell | 1.10198 / 10.3 pips | 1.10299 / 20.4 pips | 1.10095 |

Pixel-to-price rounding means pointer targets and selected prices can differ by a few price ticks. Assertions compare each rendered distance with its actual draft price and observed reference. Both directions were exercised in all chart topologies. Modification hover and label containment at the top/bottom/right plot edges were checked across all nine viewport/layout combinations. Draft drags did not change durable trading state; invalid drags disabled both confirmation paths. Confirmed stops still drag, and a double-clicked confirmation produced one modification. Pending cancellation, manual close, session reload and historical review passed. Playback retained the single row and disabled position actions at 1440 and 1000. Horizontal wheel input moved the strip by 204/240 px, ArrowRight by 40 px, and mouse clicks on the native scrollbar by 40 px at the two smaller widths in every chart layout. No browser errors occurred.

Machine-readable results: [before measurements](before-evidence.json) and [final browser evidence](browser-evidence.json).

## Screenshots

| State | Evidence |
| --- | --- |
| Before, two positions | [1440](before-1440.png), [1100](before-1100.png), [1000](before-1000.png) |
| After, two positions | [1440](inline-1-1440.png), [1100](inline-1-1100.png), [1000](inline-1-1000.png) |
| Buy draft, two pointer levels | [Near](live-buy-near-0.png), [Far](live-buy-far-0.png) |
| Sell draft, two pointer levels | [Near](live-sell-near-0.png), [Far](live-sell-far-0.png) |
| Invalid draft sides | [Buy](invalid-buy-0.png), [Sell](invalid-sell-0.png) |
| Compact three-chart draft | [1000](draft-3-1000.png) |
| SL modification | [Live](modify-sl-live.png), [Selected and dragged](modify-sl-selected.png) |
| Pending and mixed | [One pending](one-pending.png), [Two pending](two-pending.png), [Mixed](mixed-open-pending.png) |
| Restoration and review | [Restored](restored.png), [Historical review](historical-review.png) |

The directory also contains screenshots for every chart-layout/viewport combination.

## Automated checks

- Full Vitest suite: 52 files, 670 tests passed.
- Workspace typecheck and production build passed.
- `git diff --check` passed.
- New deterministic tests cover quote references, missing quotes, modification risk versus market distance, live Buy/Sell movement without React renders, selected draft dragging, cancellation, invalid sides, and duplicate confirmation through both buttons. Workflow tests cover inline pending/mixed/open states and management actions. Existing confirmed-stop, saved-session, legacy execution and historical-review suites also passed.
- Impeccable's mechanical scan reported only the existing Inter font and paid-download warning border. Both belong to the established visual system outside this task.

Reproduce with an external verification-only Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/live-draft-toolbar-browser.mts
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

The browser script refuses provider methods and paid endpoints, hashes the cache before/after, and creates temporary sessions. It does not regenerate the historical before screenshots.

## Limits

Chromium desktop verification covers the supported 1000 px minimum and larger specified widths. Legacy quote routing and missing quotes use deterministic fixtures; the browser session uses authentic cached 6E observations. Pointer and horizontal wheel behavior use Chromium input, rather than a physical trackpad. Large or unusually long values may require position-strip scrolling even at 1440; values are retained rather than truncated. The production build retains its existing advisory about a JavaScript chunk larger than 500 kB. No execution, sizing, commission, persisted session schema or provider code changed.
