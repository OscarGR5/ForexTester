# Task 20: chart-first workflow

The interface operates as a trading terminal. Preserve the slate palette (#10151d, #131722, #1e2935), light text (#e5eaf0), muted aqua actions (#75c4b5) and restrained loss red (#e2a2a6). System sans handles controls; tabular numerals handle time, prices and PnL. No new fonts or runtime dependencies.

## Setup
```
ForexTester                                      Sessions
Set up a backtest
[Name                    ]
Historical period (UTC)          Account (USD)
Advertised first / eligible last [Balance] [Risk cap] [Fees]
[From] [Through inclusive]        [Replay start UTC]
[7 days] [30 days] [90 days]       [Initial chart layout]
[Load historical data]  chunks / cancel / retry
Warm-up warning; available observations
                                    [Start backtest]
```
The calendar range is inclusive in the interface only. Storage, cache identity and APIs keep exclusive `to`. Native date fields allow direct year editing. New sessions never download without an explicit action.

## Trading
```
ForexTester  session · saved          Account PnL $ / %   Sessions
EURUSD  UTC clock  Play Pause Next Speed  Layout           Finish
┌─────────────────────────────────────────────────────────────┐
│ Chart timeframe / indicator settings                       │
│                                                             │
│                    PRICE WORKSPACE                          │
│           SL1 - - - -        SL2 · · · ·                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
Sizing / Setup / Buy / Sell        Place SL → review → confirm
Open or pending slot 1                    Open or pending slot 2
```
One, two or three charts share a fixed-height workspace. Stop drafts are transient React state. Public chart click/crosshair APIs map pane 0 Y coordinates through the candlestick series. A click selects a price only. Confirmation alone calls the existing order API. Replay start, restart, session changes and unmount discard drafts.

## Results
```
ForexTester  session · saved                              Sessions
Backtest results                        Account PnL $ / %
Open/pending disclosure (no invented exits)
[Overview] [Journal] [Equity & drawdown]
Overview: setup/position statistics + realized curve
Journal: scope / CSV / editable metadata
Equity: cash, equity and drawdown
```
Finish pauses replay, saves a checkpoint, asks confirmation with open/pending counts, then persists the finished lifecycle before showing Results. Natural exhaustion stays in Trading until Review Results. Journal and analytics mount only in Results.

## Persistence
Record schema v2 adds checkpoint lifecycle. V1 digest and financial validation run before interpreting lifecycle. Missing lifecycle maps unstarted → setup, started → trading, complete → finished. The next successful checkpoint writes v2 atomically; source financial data, dataset fingerprint and exclusive ranges remain unchanged. IndexedDB layout stays v1. Old browser migration receipts remain based on original records. Restores are paused; drafts are never serialized.
