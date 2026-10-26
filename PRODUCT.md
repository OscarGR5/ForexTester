# ForexTester
<!-- impeccable:product-schema: 1 -->
## Platform
web
## Product and audience
Personal discretionary strategy research for the project lead using installed EURUSD Forex Parquet history. New execution uses mid-price M1 OHLC and USD-denominated hypothetical standard-lot sizing. Legacy Dukascopy bid/ask and Databento futures sessions keep their original datasets and execution rules; higher chart timeframes are analysis views.
## Core workflow
Choose a UTC historical period from the verified local archive timeline or 7-, 30-, and 90-day presets, which include coverage for the 30-day indicator pre-roll. Review readiness, configure the account, then use one Start backtest action to load the selected data and open a paused replay at the earliest eligible minute with 78 completed H4 candles from observed history. Dates outside installed coverage are unavailable; source gaps stay visible and no candles are fabricated. Restoring a saved session preserves its replay timestamp without recomputing the start.

Place up to two same-direction entries in one automatically assigned setup, manage independent stops with dragging or keyboard entry, then finish and review results. Navigate each chart independently; crosshairs synchronize UTC time and pointer price. D1 is an analysis view and reports incomplete Ichimoku warm-up honestly.
## Constraints
Dark trading terminal. Chart dominates. No automated strategies, signals, take-profit orders, broker integration or unapproved financial formula changes. No fabricated spread or prices. Only legacy futures sessions stop at contract rollover. No online data downloads or paid confirmations. Preserve durable sessions, historical fingerprints, local chart preferences and no-lookahead behavior.
