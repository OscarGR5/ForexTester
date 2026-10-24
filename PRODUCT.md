# ForexTester
<!-- impeccable:product-schema: 1 -->
## Platform
web
## Product and audience
Personal discretionary strategy research for the project lead using CME 6E futures trade OHLCV from Databento. New execution uses M1 trade prices and hypothetical forex-style sizing. Legacy EURUSD bid/ask sessions keep their original datasets and execution rules; higher chart timeframes are analysis views.
## Core workflow
Choose a UTC historical period from the validated daily cache timeline or cache-based 7-, 30-, and 90-day presets, which include coverage for the 30-day indicator pre-roll. Review readiness, configure the account, then use one Start backtest action to load the selected data and open a paused replay at the earliest eligible minute with 78 completed H4 candles from the same contract. Missing data requires explicit paid-download consent before proceeding. Restoring a saved session preserves its replay timestamp without recomputing the start.

Place manual orders with chart-selected independent stops, finish and review results.
## Constraints
Dark trading terminal. Chart dominates. No automated strategies, signals, take-profit orders, broker integration or unapproved financial formula changes. No fabricated spread or prices; stop replay at contract rollover. Preserve durable sessions, historical fingerprints, local chart preferences and no-lookahead behavior.
