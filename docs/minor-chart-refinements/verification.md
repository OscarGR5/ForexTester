# Minor chart refinements verification

Verified in headless Chromium on October 25, 2026, using the existing local historical cache and isolated temporary sessions. Provider methods throw if called; the browser also blocks paid-download submissions and requests outside localhost. Provider calls: **0**. Paid submissions: **0**. Cache hashes are unchanged.

All five Ichimoku series render at 2 CSS px with their existing colors. Bollinger and stochastic lines remain 1 px. Calculations, cloud rendering, projection, series order and candle data are unchanged. The blue Trade badge is removed from 6E headers; the instrument remains EURUSD 6E. Legacy EURUSD retains Bid.

Lightweight Charts' native wheel setting scales time, while its native price-axis setting supports dragging. The existing wheel handler therefore routes candle price-axis input through public price-scale range APIs. See the [native wheel implementation](https://github.com/tradingview/lightweight-charts/blob/v5.2.0/src/gui/chart-widget.ts#L550). Wheel-up narrows the price range and expands candle movement; wheel-down widens the range and compresses movement. Scaling keeps the range midpoint fixed, normalizes wheel units and bounds individual wheel deltas. Manual ranges use the existing per-session, per-chart, per-timeframe preferences.

## Chromium checks

All 12 workspace panes across one-, two- and three-chart layouts at 1440 × 1000 and 1100 × 800 passed:

- Five 2 px Ichimoku lines; no Trade badge; no header overlap or viewport overflow.
- Real wheel input over each price axis expands and compresses vertically without changing logical time ranges or candle data.
- Other charts retain their price/time ranges and candle data.
- Plot wheel zoom remains horizontal, right-anchored and independent.
- Native axis dragging, double-click autoscale reset, plot dragging and crosshairs remain functional.
- A wheel-created manual price range survives reload and session resume; replay time and trading state remain unchanged.

An 80-pixel upward wheel event reduced the price span to 85.2144% of its previous value. The opposite event restored that span. No browser errors occurred. Measurements are in [browser-evidence.json](browser-evidence.json).

| Layout | Desktop | Laptop |
| --- | --- | --- |
| 1 chart | [1440 px](1-charts-1440.png) | [1100 px](1-charts-1100.png) |
| 2 charts | [1440 px](2-charts-1440.png) | [1100 px](2-charts-1100.png) |
| 3 charts | [1440 px](3-charts-1440.png) | [1100 px](3-charts-1100.png) |

[Expanded vertically](axis-wheel-expanded.png) and [compressed vertically](axis-wheel-compressed.png) show the same horizontal time window. The desktop single-chart screenshot also shows all five thicker lines and the instrument without the Trade badge.

## Automated checks

- `npm test -- --maxWorkers=2`: **618 passed**, 48 test files.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite reports a JavaScript chunk above 500 kB.
- `git diff --check`: passed.
- Impeccable mechanical scan of the changed implementation: no findings.

Reproduce the browser check with the existing external Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/minor-chart-refinements-browser.mts
```

Set `CHROMIUM_PATH` if Chromium is installed elsewhere. The script needs the existing cached 90-day preset and writes its evidence here.

## Limits

Vertical wheel scaling targets the candle pane's right price axis. The stochastic axis and time axis retain their existing behavior. Desktop/laptop Chromium was verified; mobile layouts are outside the application's supported scope. No provider, historical cache, execution, journal, durable session format or spending-safeguard implementation was changed.
