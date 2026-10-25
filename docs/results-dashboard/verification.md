# Results dashboard verification

Implemented on `feat/unified-results-dashboard` from `origin/main` at `0e5b6078fd85064b28529e4e1d1f39c3b8567de4`. The unrelated local `main` styling commit remains on local `main` and is excluded from this feature.

One scrolling Results page replaces Overview, Journal and Equity navigation. It contains six primary metrics, account-equity and setup-R charts, drawdown comparison, monthly realized contributions, secondary statistics and a collapsed setup breakdown. Save and the unchanged CSV export are in the header.

## Financial conventions

Completed setups are the fixed statistical unit. Results reuse `journalSetups`, `completedObservations`, `performanceStats`, original position risk and the real equity ledger. Combined setup net R is combined net PnL / combined original executed risk; unequal risks, lot rounding, fees and SL changes do not redefine that denominator. A setup with a still-open or pending entry is excluded from completed statistics. Invalid risk leaves affected aggregate R unavailable.

Account return includes incurred fees and currently available unrealized PnL. Below-start deficit uses fixed initial capital; peak drawdown uses the existing high-water marks and nonpositive-equity rules. Full-resolution ledger observations determine maxima and their associated timestamps. Monthly realized contribution is completed-setup net PnL / initial capital, attributed once at final UTC exit. It is noncompounded and differs from calendar-month equity return. Secondary commissions and position counts cover completed setups only.

## Source boundaries

- `frontend/src/App.tsx`: mount the dashboard for finished sessions; remove Results navigation and scope handlers.
- `frontend/src/ResultsDashboard.tsx`: metrics, notices, header actions, statistics and setup breakdown.
- `frontend/src/ResultsCharts.tsx`: responsive charts, shared sampling, keyboard/pointer inspection, accessible calculation help, R pagination and monthly table.
- `frontend/src/resultsAnalytics.ts`: completed-setup ordering, R statistics, full-resolution below-start drawdown and monthly attribution using existing analytics.
- `frontend/src/resultsFormatting.ts`: finite currency/percentage/R formatting, durations and signs.
- `frontend/src/TradingJournal.tsx`: export the existing read-only position detail component for reuse.
- `frontend/src/style.css`: terminal dashboard layout and desktop resizing; remove obsolete Results navigation styles.
- `frontend/src/resultsAnalytics.test.ts`, `ResultsDashboard.test.tsx`, `workflow.test.tsx`, `tests/resultsFixture.ts`, and browser scripts: regression coverage and deterministic verification.
- `README.md` and `DESIGN.md`: Results behavior and reporting conventions.

## Checks

- Full suite: `npm test -- --maxWorkers=2`, **56 files / 749 tests passed**. [Log](tests-bounded.txt).
- Additional exact +1.10R example and percentage-vs-dollar drawdown maximum context: targeted Results suite, **21 tests passed**. [Log](results-tests.txt).
- TypeScript: `npm run typecheck`, both workspaces passed. [Log](typecheck.txt).
- Production: `npm run build`, frontend and backend passed. Existing Vite bundle-size warning remains; no runtime dependency was added. [Log](build.txt).
- `git diff --check`: passed.
- Chromium: `scripts/results-dashboard-browser.mts` passed all checks at **1000, 1100, 1440 and 1728 px**. [Structured evidence](browser-evidence.json), [run output](browser.txt).

The initial unrestricted full-suite run exhausted concurrent worker resources and timed out in unrelated storage/environment tests. That run was stopped; the complete suite passed with two workers. Browser scripts were run with external verification-only Playwright at `/tmp/forextester-keyboard-tools/node_modules/playwright-core/index.mjs`; no project dependency was added.

Browser checks verify no page or Results horizontal overflow, all six primary metrics in the first viewport, measured SVG resizing, fewer than 100 timeline SVG nodes for 93,600 observations, no invalid path coordinates, digest-verified v1 finished-session restoration, migration through existing persistence, ignored old position-scope preferences, identical metrics/chart paths and financial state after reload, USD/% toggle, synchronized keyboard hover, collapsed setup breakdown, appropriate individual position details, metadata preservation, CSV schema/row counts/formula safety, header save, empty state, and finishing/restoring open, partially completed and pending setups without changing positions or the ledger.

Formula and integration tests cover weighted two-position R, unequal rounded original risk, partial completion, one-position setups, fee-adjusted outcomes, modified stops, invalid risk, all PF edges, breakevens in win rate and streaks, R averages/extrema, holding time, UTC month/year boundaries, final-exit attribution, empty months, intratrade and peak drawdown, entry fees/unrealized PnL, missing marks, clock gaps, full-resolution extrema, nonpositive equity, zero-range charts, paging, session compatibility and existing CSV behavior. Existing engine, persistence, equity and replay regression tests remain intact.

## Fixture identity and screenshots

All screenshots show real rendered application output with **synthetic data**, never user trading results. `tests/resultsFixture.ts` generates deterministic 6E weekday M1 prices, weekends as clock gaps, one fixed synthetic contract, $100,000 initial capital, 2% combined risk, and $7/lot round-trip fees. It exercises risk-sized entries, rounded execution, SL changes, separate exits and stored metadata through the existing engine.

- Populated: 2024-01-01 00:00 to 2024-03-29 23:59 UTC; 93,600 M1 observations, 22 completed setups and 44 positions. The checkpoint is seeded as v1 with position-scope preferences, then restored by the real app.
- Empty: 201 observations, no setups or positions; account equity remains displayed.
- Unfinished: 801 observations; one closed position in a partial setup, one open position and one independent pending setup. Clicking the real Finish action leaves all financial state unchanged.

The browser backend exposes only isolated storage and an empty coverage calendar. Any history/provider route returns an error; external requests and paid submission routes are blocked and counted. The evidence records zero external/history requests, zero paid submissions and no browser errors.

| Screenshot | Purpose |
|---|---|
| [Populated 1100 px](populated-1100.png) | Narrow desktop viewport |
| [Populated 1440 px](populated-1440.png) | Primary desktop viewport |
| [Populated 1728 px](populated-1728.png) | Wide desktop viewport |
| [Populated 1000 px](populated-1000.png) | Application minimum width |
| [Complete populated dashboard](populated-dashboard.png) | Entire scrolling surface |
| [Expanded setup breakdown](expanded-setup-breakdown.png) | Real scrolled viewport with two position details |
| [Complete expanded dashboard](expanded-dashboard.png) | Full table and position details |
| [Empty session](empty-session.png) | No completed setups with recorded equity |
| [Unfinished session](unfinished-session.png) | Real equity with completed-setup metrics unavailable |

Full-dashboard captures temporarily remove the scroll-height constraint to capture the entire rendered surface. Viewport screenshots and layout measurements use the normal bounded application shell and scrolling Results container.

## UI review

Fresh Impeccable finish review: **PASS**, no material findings. The first screenshots showed harmless positive axis headroom on drawdown; final captures use a 0% ceiling. The detector reported the explicitly required Inter font and an existing amber border outside this change's scope; neither changes the approved design.

| Area | Verdict |
|---|---|
| Approved layout and content | Pass |
| Desktop composition | Pass |
| Empty and unfinished states | Pass |
| Expanded position details | Pass |
| Material defects | None |
| Finish disposition | Pass |

## Preserved behavior and limits

Trading execution, stops, risk sizing, commission mechanics, provider identity/behavior, rollover restrictions, replay stepping, no-lookahead behavior, paid-download logic, credentials, `.env`, historical cache and saved-user data were **not modified**. Persistence schema and CSV schema are unchanged; browser verification writes only temporary isolated fixture sessions. Existing legacy Journal/Equity components remain available to older regression harnesses, but the production Results surface has one fixed setup scope and no old tabs.

M1 observations cannot reconstruct intraminute equity. Missing valuations remain unavailable; peak drawdown percentages remain unavailable after nonpositive equity. R charts show 40 setups per page with all outcomes retained in analysis. The application remains desktop-only. Screen-reader behavior is supported through semantic controls, descriptions and live readouts but was not tested with a separate screen-reader application. No paid/provider/cache workflow was invoked during this task.
