# Chart toolbar, panning, draft SL and entry references

Base: `main` at `f14c3e6dfc95da1e135c35cc5c37c3245017b9e1`. Before screenshots were captured from that source before implementation. Verification date: October 25, 2026.

## Behavior

Mouse drag pans each chart independently. Drag right to inspect earlier bars; drag left to return toward the latest bars. The left boundary is free, while the latest observed/projected time remains the right boundary. Manual ranges, including left whitespace, survive replay updates and durable restore. Reaching the latest edge resumes follow. Wheel zoom keeps its existing right anchor. The free crosshair and existing stop-drag interactions remain intact.

Bollinger and Ichimoku price lines use Lightweight Charts' public `setSeriesOrder` mechanism to render behind candle bodies and wicks. Their colors, price formats and calculations are unchanged. Stochastic remains in its own pane. The cloud keeps its existing bottom primitive layer.

After selecting a draft SL level, the chart shows a tick immediately to the left of its label. The tick and toolbar confirmation call the same validation/commit handler. Selecting a level, moving the pointer or cancelling does not commit a draft. Invalid levels keep the existing message and disable confirmation. The chart rendering lifecycle repositions the HTML control on scale changes and resize; it stays inside the plot, including at its edges. Escape cancels. Existing direct dragging of a confirmed stop retains its valid-release commit behavior.

Aqua entry references distinguish pending observed-price estimates (dotted) from actual fills (dashed). Matching fills share one line identifying both entries as B1 / B2 for buys or S1 / S2 for sells. Different fills have separate lines. Ordinals survive removal of the first entry. These references derive from existing session records without a schema change. Automatic scales include entry prices; manual fixed scales remain respected. Entry price is gross breakeven before commissions, as explained in Execution details.

Replay and trade entry now share the top workspace toolbar. The sizing mode, risk/volume, Buy/Sell, slot count, setup status and execution context remain labeled. Detailed assumptions are collapsed. Active position rows appear only while needed; there is no bottom dock. Controls wrap at narrow widths and the chart workspace scrolls.

## Validation

| Check | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 610 tests passed across 48 files |
| `npm run typecheck` | Passed, frontend and backend |
| `npm run build` | Passed, frontend and backend |
| `git diff --check` | Passed |
| Chromium, 1440 × 1000 and 390 × 844 | Passed all 1-, 2-, and 3-chart layouts without horizontal document overflow |
| Real mouse drags on every pane | Earlier/later ranges verified, other panes unchanged; paused replay steps preserve manual views |
| Price overlay ordering | Native series order verified on M5, M15, H1, H4 and D1; deterministic tests cover re-enabling overlays |
| Draft confirmation | Mouse click confirms pending entries; real mobile touch confirms an SL modification; Escape and invalid-draft validation verified; 44 px mobile touch target |
| Entry persistence | Pending refresh, fill, save, refresh and backend restart checked; entire trading checkpoint and viewport match |
| Existing chart UX browser regression | Passed: right-anchored wheel, free crosshair, long/short stop drags, Escape, invalid release, D1 readiness, setup journal grouping and restart restore |
| Provider requests / paid submissions | 0 / 0 in both browser runs; blank credentials and throwing provider stubs |
| Historical cache and spending ledger | Every file SHA-256 unchanged |

The one-chart flat canvas grows from 727 to 774 px on desktop (+47 px) and from 356 to 391 px on mobile (+35 px).

[Browser ranges, coordinates and restore evidence](browser-evidence.json) · [Before dimensions](before-evidence.json) · [Test output](tests.txt) · [Type checks](typecheck.txt) · [Build output](build.txt) · [Prior workflow browser evidence](regression-evidence.json).

The design detector reported only the existing Inter font and an unchanged paid-download warning border. The terminal's established design is retained.

## Screenshots

These screenshots capture the original implementation. A follow-up shortened entry labels to B1/B2 for buys and S1/S2 for sells, preserving the aqua color and pending estimate indicators.

| State | Desktop | Mobile |
| --- | --- | --- |
| Before | [Toolbar and chart](before-1440.png) | [Toolbar and chart](before-390.png) |
| After, flat | [One chart](after-1-charts-1440.png) | [One chart](after-1-charts-390.png) |
| Two charts | [Layout](after-2-charts-1440.png) | [Layout](after-2-charts-390.png) |
| Three charts | [Layout](after-3-charts-1440.png) | [Layout](after-3-charts-390.png) |
| Draft tick | [New entry](draft-sl-tick-desktop.png), [modify SL](draft-sl-tick-1440.png), [three panes](draft-sl-tick-three-charts.png) | [Tick scrolled into view](draft-sl-tick-390.png) |
| Entry references | [One pending](one-pending-entry.png), [two pending](two-pending-entries.png), [two filled](two-filled-entries.png) | [Two panes](entries-2-charts-390.png) |
| Entry references in every pane | [Three panes](entries-3-charts-1440.png) | [Three stacked panes](entries-3-charts-390.png) |
| Durable restore | [After backend restart](entries-restored-after-backend-restart.png) | |

[Pan toward earlier bars](pan-earlier-1-0.png) · [Pan back toward later bars](pan-later-1-0.png). Exact before/earlier/later ranges for every pane are in the browser JSON.

## Limits

- Pending market entries cannot know the next fill price. Their lines explicitly estimate from the current observed quote and switch to the real fill after execution.
- A manually fixed price range can put an entry line outside the visible area. Automatic scales include the references.
- Mobile panes stack and scroll. Expanded draft and position details can require scrolling to the on-chart tick.
- Vite reports a production JavaScript chunk above 500 kB. No dependency or bundling changes are included.
- Browser verification covers Chromium. Unit tests include legacy bid/ask sessions and existing saved-session formats; browser trading checks use the local 6E cache.

## Reproduce

Use the existing downloaded cache and Chromium installation. The script writes isolated temporary sessions and rejects every provider method. It does not use the user's saved sessions.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium \
node_modules/.bin/tsx scripts/chart-toolbar-browser.mts
```
