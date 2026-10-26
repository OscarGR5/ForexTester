# 365-day backtest verification

## Design

`MAX_BACKTEST_DAYS`, `HISTORY_PREROLL_DAYS`, and the preset list are shared from `frontend/src/history.ts`. The frontend validator, cache coverage, session validation, local-archive API, and Setup copy therefore use one 365-day limit while keeping the existing 30-day pre-roll.

The timeline keeps its 120-day window for shorter ranges. For longer ranges it expands to the selected duration plus the 30-day pre-roll, capped at 395 displayed calendar days. A 365-day selection therefore places the start handle at day 30 and the inclusive Through handle at day 394. The explicit From and Through labels remain visible, and archive navigation still moves in 90-day steps.

No history, execution, aggregation, indicator, equity, or saved-session format changed. Weekend and closure behavior remains observation-driven.

## Installed archive benchmark

Measured on 26 October 2026 against the installed EURUSD archive, using 26 September 2025 through 25 September 2026 plus pre-roll from 27 August 2025. The range contained 399,885 observed M1 candles. No external data request was made.

| Measurement | Result |
| --- | ---: |
| DuckDB range query | 557 ms |
| JSON API body | 36,003,289 bytes (34.34 MiB) |
| Local HTTP history request, Chromium | 966 ms at 1100 px; 1,033 ms at 1440 px |
| JSON parse | 248 ms |
| History validation/candle parse | 60 ms |
| Initial three-pane chart and indicator preparation | 80 ms |
| Three-pane preparation at a restored 90% cursor | 519 ms |
| Browser time to trading workspace | 2.37 s at 1100 px; 2.46 s at 1440 px |
| Browser time through first durable save | 8.18 s at 1100 px; 7.96 s at 1440 px |
| Browser JS heap after load | about 347 MiB used |
| Backend/Vite verification-process peak RSS | 1.22 GiB |

The 34.34 MiB uncompressed history is below the existing 64 MiB history request and decompression limits. Its stored gzip object was 4,754,388 bytes. The limit was retained.

The peak RSS figure is from the verification harness, which hosts the backend, Vite, DuckDB, response serialization, and session-storage parsing in one Node process. It is a conservative combined figure, not a clean production-backend-only measurement. Memory is the main remaining constraint for future multi-year support.

## Replay, persistence, and results

Chromium with three charts advanced exactly 4, 40, and 400 observations in roughly 1.2 seconds at 1x, 10x, and 100x. Core M5 chart/indicator update samples remained below 9 ms at all three speeds.

A deterministic 90%-progress run saved 331,681 equity observations in 18 incremental checkpoints. Mean checkpoint time was 267 ms, maximum checkpoint time was 942 ms, and cold restore took 3.58 s. The restored replay timestamp and every equity observation matched the saved checkpoint. The display preparation for Balance & Equity reduced the full ledger to 5,677 display points in 164 ms without truncating stored observations.

Real Chromium save/reload/resume took 4.05 s at 1100 px and 3.09 s at 1440 px. Results and Balance & Equity rendered in 270 ms and 216 ms respectively. Both widths had no horizontal overflow, page errors, or external requests.

The browser and Node evidence is recorded in `browser-verification.json` and `node-benchmark.json`. The PNG files capture Setup with the unclipped 395-day timeline and the Results dashboard at both required widths.

## Regression coverage

Deterministic coverage includes 1-, 7-, 30-, 90-, and 365-day validation; 366-day rejection; leap-year pre-roll; the 365-day cached preset; unclipped timeline handles; full local-Parquet loading; UTC aggregation; market gaps; pending orders and manual closes across gaps; stop fills at adverse observed openings; indicator warm-up without future data; incremental session persistence; legacy history restoration; and Balance & Equity continuity.

The complete suite passed 783 tests across 60 files. Type checking, the production build, and `git diff --check` also passed. The build retains the existing nonfatal warning for a JavaScript chunk larger than 500 kB.
