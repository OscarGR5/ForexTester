# Balance & Equity verification

The Results account chart uses the existing immutable M1 ledger: `cashUsd` for Balance and `equityUsd` for Equity. No financial formulas, execution rules, commission calculations, KPI inputs, or persistence formats changed.

Balance uses a 2.8px teal step line; Equity uses a 1.6px lavender line drawn above it. The teal edges remain visible during overlap. The legend lists Balance before Equity. Both series share the USD/percentage scale and starting-capital/zero-return reference. Percentage returns use fixed initial capital.

Cash validity is independent of equity validity. Every changed cash observation and its immediate predecessor survive display downsampling. Cash holds horizontally until the recorded execution timestamp. Across clock gaps, recorded position entry/exit times establish whether cash can remain solid, including when positions stay open. Unconfirmed equal cash endpoints receive a dashed horizontal bridge; differing unknown endpoints remain disconnected rather than assigning a fictional transaction time. Equity and Drawdown retain the PR #36 observed segments and dashed real-endpoint bridges.

UTC inspection reports Balance and Equity in USD and return %, plus Floating PnL in USD. Missing equity leaves known Balance visible and reports Equity and Floating PnL as N/A. Shared keyboard/pointer inspection retains real observation timestamps; exposed clock-gap interiors do not become observations.

## Regression coverage

`frontend/src/balanceEquity.test.tsx` uses real execution/ledger sessions from `tests/balanceEquityFixture.ts`, plus bounded display fixtures.

| Scenario | Verified behavior |
| --- | --- |
| Empty session without completed positions | Both flat series render; no fabricated trades |
| Closed positions | Final equity equals cash; both lines remain visible |
| Two open positions with fluctuating marks | Cash stays fixed while equity changes |
| Entry commissions | $3.50 + $1.75 deducted at entry, before either close |
| Independent exits | Realized gross PnL minus $3.50 / $1.75 exit fees at the respective recorded timestamps |
| Missing required ask | Known cash renders; Equity and Floating PnL show N/A |
| Held weekend | Cash stays horizontal; Equity retains its dashed bridge |
| Unknown intermediate transactions | No gradual cash ramp or invented execution timestamp |
| USD and percent | Both series switch together; inspection retains both units |
| Different extrema | Shared scale includes cash extrema even during missing equity |
| 90-day M1 sampling | Every cash change and preceding observation retained, including in the incremental display cache |
| Financial/persistence isolation | Full ledger and KPI results unchanged; saved equity suffix stays identical and restores all original points |

Existing equity, analytics, session-storage and timeline regressions also remain in the full suite. The continuity browser harness excludes the new Balance paths from its original Equity/Drawdown edge-count assertions; those original assertions remain unchanged.

Validation: `npm test -- --maxWorkers=2` passed all 795 tests across 58 files. `npm run typecheck`, `npm run build`, and `git diff --check` passed. The first full run had one transient save/resume workflow failure; that test passed in isolation and the subsequent full run passed. No workflow code was changed. Vite retains its existing warning about a bundle larger than 500 kB.

## Browser verification

`scripts/balance-equity-browser.mts` builds a production Vite bundle containing the production `ResultsDashboard`, real engine/ledger synthetic sessions, and the application stylesheet. It mounts the dashboard in a temporary harness, blocks API/external requests, and instantiates no provider or persistence service. User sessions are never opened or changed.

24 width/session/unit variants passed at 1100px and 1440px, producing 30 screenshots. Checks cover the ordered legend, selected toggle state, distinct series colors/widths, valid SVG geometry, synchronized real UTC readouts, pointer/keyboard agreement, missing valuations, unchanged KPI text and Drawdown paths during unit changes, immutable fixture data, and no horizontal page overflow. No page errors or forbidden requests occurred. Continuous M1 detail views make steps and crossings readable; the weekend variants retain true elapsed UTC spacing.

Representative captures:

| View | 1100px | 1440px |
| --- | --- | --- |
| M1 executions and crossing, USD | [Screenshot](m1-closed-usd-1100.png) | [Screenshot](m1-closed-usd-1440.png) |
| M1 executions and crossing, % | [Screenshot](m1-closed-percent-1100.png) | [Screenshot](m1-closed-percent-1440.png) |
| Missing equity, USD | [Screenshot](m1-missing-usd-1100.png) | [Screenshot](m1-missing-usd-1440.png) |
| Missing equity, % | [Screenshot](m1-missing-percent-1100.png) | [Screenshot](m1-missing-percent-1440.png) |
| Overlap after closing | [Screenshot](overlap-1100.png) | [Screenshot](overlap-1440.png) |
| Open positions across a weekend | [Screenshot](open-percent-1100.png) | [Screenshot](open-percent-1440.png) |

Machine-readable checks and paths: [browser-evidence.json](browser-evidence.json).

The existing PR #36 continuity harness also passed all eight width/unit/range combinations with zero page errors or forbidden requests. Its historical screenshot artifacts were left unchanged.

Reproduce with existing verification-only Playwright and Chromium, without adding project dependencies:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chromium node --import tsx scripts/balance-equity-browser.mts
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chromium node --import tsx scripts/results-continuity-browser.mts
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

## Performance and limits

A local Node measurement of 129,600 M1 observations at 700px retained 4,072 display points, with a cash change every 91 minutes and periodic missing equity. Six runs took 44–126 ms for gap classification/downsampling and 4–6 ms for both account-series paths. The paths totaled 139,061 characters. These are local measurements, not cross-device latency guarantees.

Preserving exact cash timing takes priority over a hard pixel-based point cap. Geometry therefore grows with execution count and validity transitions. The full ledger always remains available to statistics and persistence. M1 snapshots cannot reconstruct intraminute transactions, and dashed bridges do not provide intermediate valuations.

The mechanical design scan found only existing stylesheet warnings for the pinned Inter font and an unrelated amber side border. Neither is introduced by this change.
