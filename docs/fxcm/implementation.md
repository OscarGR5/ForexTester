# FXCM historical data

FXCM is an explicitly selected provider for new personal-use EURUSD backtests. Dukascopy remains the default. There is no provider fallback. Saved sessions restore their saved observations, regardless of the current Setup selection.

## Loading and validation

Setup, Trading, Results and saved-session rows identify the provider. Switching provider aborts the current load and clears readiness. A loaded or saved setup opens a fresh session before switching, preserving the original checkpoint and dataset. A provider mismatch cannot start replay. Each New session returns to the Dukascopy default; FXCM must be selected explicitly for that new session.

`/api/history` and `/api/history/coverage` accept `provider=dukascopy` or `provider=fxcm`. Unknown identifiers return 400. Omitting the parameter retains legacy Dukascopy retrieval and the original history response format. Explicit requests return versioned provenance. Health and last observed dates are isolated by provider.

The frontend retains two workers, seven-day API chunks, 30 calendar days of pre-roll and a 90-calendar-day selection limit. One provider is pinned across every chunk. UTC date selection and exclusive API ends are unchanged. Coverage labels remain provisional; the latest calendar date eligible for selection does not prove publication. An observed latest timestamp is evidence of that observation, not an inventory of every intervening date.

FXCM downloads use the fixed public `https://candledata.fxcorporate.com/m1/EURUSD/` origin. The adapter groups requested days into Sunday-to-Sunday UTC trading weeks, then checks filename hints around the following Monday's ISO week: offsets 0, -1, +1, -2, +2, plus adjacent-year 52/53 or 1/2 at the boundary. This is a discovery budget, not an asserted filename formula. Each candidate must be a valid single-week archive whose actual timestamps belong to the required UTC week. At most seven candidate filenames per week and two weeks per seven-day API interval are examined. No complete supported-year mapping is claimed. An archive outside this search budget produces an explicit missing-archive error.

Downloads have a 25-second timeout, reject redirects, and are limited to 2 MiB compressed and 8 MiB decompressed. At most two downloads run concurrently per adapter instance. A complete weekly file must pass gzip/CRC decoding, the exact nine-column CSV header, strict UTC minute timestamps, increasing unique observations, positive finite numeric prices, independent OHLC invariants, corresponding bid <= ask, and a single trading-week boundary. Identical and conflicting duplicate rows both fail. No prices, spreads or missing minutes are synthesized. A published archive can establish an empty weekend interval; a missing archive cannot establish an empty interval. Missing recent weeks are classified separately when their normal Monday publication is still ahead.

Successful raw archives are cached in the existing external cache root's `fxcm/` directory with symbol, M1 and normalization version in their filenames. Dukascopy keeps its original directory. In-flight requests share weekly downloads, including overlapping pre-roll/API chunks. Only validated archives are published atomically; 404 bodies are not cached. Memory holds at most 24 archives. Frontend chunks also include provider, normalization version and range in the key. An aborted frontend request cannot publish a partial dataset. Existing backend work can finish and supply validated cache entries for retry.

A damaged local FXCM cache file fails validation without silently fetching a replacement. If local corruption is confirmed, the disposable `fxcm/` provider cache can be removed while the backend is stopped. Durable session history is a separate directory and must be preserved.

## Dataset identity and recovery

New datasets carry provenance version 2, provider and `m1-bid-ask-v1` normalization. FXCM also records archive filenames, SHA-256 of compressed bytes, observed first/last timestamps and retrieval times. Filenames resolve against the fixed public origin above.

The new fingerprint prefix is `EURUSD/M1/v2/<provider>/<normalization>/<from>/<tradingFrom>/<to>/`, followed by the original little-endian side-length and IEEE-754 observation encoding. Both independent price sides, their timestamps, gaps and date boundaries participate. Retrieval time and compressed archive hashes are audit metadata, excluded from normalized dataset identity.

Legacy datasets retain their exact `EURUSD/M1/v1/...` prefix and numeric encoding. No inferred metadata is added on reading or migration. Schema-1 and schema-2 record digests are verified before interpretation. New provider-aware checkpoints use schema 3; legacy histories keep schema 2 when subsequently saved. IndexedDB structure remains version 1. Checkpoint validation binds record provider/normalization to saved history. Disk and IndexedDB writes cannot change an existing session's dataset or provider.

Restoration uses stored history with fingerprint verification. Explicit repair chooses the saved provider. Legacy repair requests use the original Dukascopy convention. Every replacement must reproduce the saved fingerprint; a different provider with identical normalized price rows still has a different v2 identity. Disk migration verifies and preserves original browser digests and leaves the source untouched.

No trading engine, execution, stop-loss, risk, commissions, replay, equity/statistics or indicator algorithms changed. The original FXCM bid/ask observations enter the existing engine directly.

## Provider terms and publication

FXCM documents personal use subject to its linked EULA, weekly M1 publication normally on Mondays, UTC timestamps, and indicative prices based on Active Trader spreads. These observations can differ from the user's actual broker spreads and executable prices. Commercial redistribution or shared hosting rights are not established by this integration. No agreement was accepted and no provider account was created.

Sources: [FXCM CandleData documentation](https://github.com/fxcm/MarketData/blob/master/CandleData/README.md), [FXCM sample downloader](https://github.com/fxcm/MarketData/blob/master/CandleData/CandleData%28pandas%29.py), [linked EULA](https://www.fxcm.com/uk/forms/eula/). The documented ISO filename example is not used as a universal mapping.
