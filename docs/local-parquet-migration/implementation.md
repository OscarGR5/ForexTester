# Local Forex Parquet migration

The project lead resolved the inspection gate: EURUSD OHLC prices are **mid**,
`TS` is **UTC Unix seconds**, and it marks the **start of the minute**. The file
has no producer metadata confirming those semantics; the lead's confirmation is
the normalization contract. No bid/ask series or spread is fabricated.

## Preservation and delivery scope

`archive/databento-2026-10-26` is pushed and independently verified at
`853500c84c1c536a12265787b2ece038dbce7504`, the current GitHub main at the start
of the work. The original working tree was clean. Local main was two commits
behind and was not moved. Work remains on `feat/local-parquet-forex`.

The archive preserves tracked code only. Existing Databento caches and spending
ledgers, `.env`, Dukascopy data, and user sessions were not deleted or rewritten.
Browser verification uses separate temporary session directories. The supplied
source in Downloads is retained byte for byte.

## Source and normalization

The [inspection report](inspection.md) and [machine-readable scan](inspection.json)
record the exact schema, all row groups, checks, precision, samples and gaps.
The source is 110,028,526 bytes, SNAPPY compressed, with 65 row groups and
7,945,468 rows. Exact columns are nullable `TS: int64`, `O: double`, `H: double`,
`L: double`, `C: double`. There is one OHLC series and no volume.

Coverage is **2005-03-09 14:35 UTC** through **2026-09-25 20:59 UTC**, inclusive.
SHA-256 is `b7952ececc3677fa32606fac5ad125ca92a4fcdc83f1901088ae7cc6233bbb64`.
The full scan found no nulls, duplicate timestamps, out-of-order observations,
nonpositive/nonfinite prices, invalid OHLC or off-minute timestamps. All 5,589
observed gaps remain gaps, including the recurring 15-minute omissions. Gap
counts include closures and cannot identify the cause of an absent observation.

Normalization version 1 converts validated integer seconds to exact integer
milliseconds. Import rejects nulls, invalid OHLC, duplicate/out-of-order rows,
off-minute values, future timestamps and incorrect schema. The engine also checks
physical file row numbers while streaming, so validation does not sort or repair
the source. Prices are retained as binary64 without rounding. Chart formatting
uses seven decimal places for local Forex; legacy defaults remain unchanged.

## Storage and import

The installed durable root is `/home/admin/.local/share/forextester`, selected
through the existing `dataDirectory()` rules and `FOREXTESTER_DATA_DIR` override.
The root must remain outside Git, including symlink destinations.

```text
<durable-root>/
  market-data/
    sources/EURUSD/<source-sha256>/source.parquet
    manifests/EURUSD.json
    cache/                         # no converted or partitioned copies
  history/<session-fingerprint>.json.gz
  sessions/                        # existing session pointers
  checkpoints/                     # existing immutable checkpoints
  equity/                          # existing incremental ledger chunks
```

The CLI importer is `scripts/import-local-forex.mts`. It loads the same root `.env`
configuration as the backend, honoring explicit process environment overrides.
It checks read/write permissions and free disk capacity before copying, hashes
the copy in flight, and verifies that the original file did not change. It stages
inside the symbol directory, flushes the file, validates every observation, and
builds calendar/H4 summaries without retaining all M1 rows in Node memory.

Only after validation does an atomic directory rename publish the immutable raw
object. A separately flushed manifest is published with an exclusive hard link.
An incomplete staging directory or unreferenced source is never discoverable as
an installed dataset. Interrupted imports can be repeated. An identical dataset
is accepted; conflicting content or metadata is rejected without replacement.
Temporary staging files created by the importer are removed on a normal failure.
Crash leftovers are hidden and cannot become active datasets.

The checksum-protected manifest records source identity, byte count, exact schema,
normalization/manifest versions, instrument metadata, price basis, minute-open UTC
convention, row count, temporal bounds, gaps and per-day observed H4 summaries.
Sources are checked for safe file types and verified by SHA-256 on first access
and whenever their filesystem signature changes. A source changing during a
range read is rejected. Missing/corrupt sources produce explicit errors.

Raw Parquet is excluded from Git. The original source is not removed. Existing
session history snapshots still use the established compressed immutable format,
so saved sessions remain independent of the currently installed raw archive.

Additional pairs can be registered with explicit symbol, base/quote currencies,
pip size, price decimals and units per lot. Only EURUSD trading is enabled. JPY
and other quote currencies cannot enter USD sizing/PnL calculations accidentally.

## Reader, API and frontend

Added the exact backend dependency `@duckdb/node-api@2.0.0-r.1`, with its native
bindings. This is the embedded [DuckDB Node API](https://duckdb.org/docs/2.0/clients/node_neo/overview).
It reads Parquet directly with parameterized timestamp predicates. One embedded
instance uses one thread and a 256 MB DuckDB memory limit; each operation has its
own connection. Online extension installation/loading is disabled. Python,
PostgreSQL, online services, and conversion/partitioning layers are not required
by the application.

Direct queries were fast enough that no partitioning or additional index was
introduced. Import streams bounded chunks; normal loads materialize only the
requested range, at most 90 days plus 30 days of pre-roll. M1 uniqueness bounds
that result to at most 172,800 observations.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/history/datasets` | Installed instruments, source identity, mid basis, verified coverage and trading eligibility |
| `GET /api/history/coverage` | Same local discovery metadata |
| `GET /api/history/calendar?symbol=EURUSD` | Verified daily observation counts, explicit zero-observation days and actual H4 summaries |
| `GET /api/history?symbol=EURUSD&from=2015-03-02&tradingFrom=2015-04-01&to=2015-06-30` | Only the selected M1 interval plus the mandatory 30-day pre-roll |

`from` and `to` are inclusive/exclusive UTC date boundaries for the returned
history. `tradingFrom` identifies the selected trading start and must be exactly
30 days after `from`. The backend enforces the 90-day trading maximum, completed
UTC dates and installed coverage. Symbol and date validation prevent browser
paths, SQL input or arbitrary file access. History responses never contain a
filesystem path. The existing storage API retains its separate session controls.
Pricing and paid-download endpoints return 404; no provider client remains.

Setup discovers EURUSD automatically, retains the 7/30/90-day presets and UTC
controls, and uses coverage-derived date limits. Since the first source day is
partial, full pre-roll is available for trading starts on April 9, 2005 or later.
Missing observations within verified coverage remain visible without treating
market closures as missing source files. Timeline day tooltips give actual M1
counts; futures markers, provider limits, quotes, credits and payment controls
are removed. Execution limitations are visible in Setup and Trading.

New histories use `format: local-forex-v1`, `source: local-parquet`, separate
instrument/source identities, `priceBasis: mid`, `executionModel:
single-price-m1-v1`, `timestampConvention: utc-minute-open`, and normalization
version 1. `local-forex-fingerprint-v1` hashes their canonical validated identity,
range, pre-roll boundary and all candles. It cannot reuse the original futures
JSON fingerprint or legacy Dukascopy binary fingerprint.

Trading uses the existing simplified single-price transition, selected by the
history representation rather than the symbol. It retains next-observed-M1-open
entries/manual exits, high/low stops, gap-open fills, two independent positions,
USD commissions, risk sizing, and the 100,000 EUR standard-lot convention. New
Forex candles have no contract identity, mappings, rollover blocker, implied
futures volume, or contract-dependent reset. All timeframe aggregation remains
limited to revealed M1 observations. No spread, ticks, intrabar order, slippage,
swaps or financing is modeled.

Trading and Results retain their chart navigation, keyboard controls, stop
controls, journal, statistics and Balance & Equity. Changes there distinguish
mid-price Forex from restored bid/ask or futures sessions and use quote
representation when selecting stop/mark prices. Financial formulas are unchanged.

## Compatibility and retired provider code

Both original history parsers and fingerprint algorithms remain. Saved Dukascopy
bid/ask and Databento futures histories restore from their saved objects, without
provider access, timestamp recomputation, order re-execution, or financial
rewrites. Existing futures contract and rollover semantics remain exclusive to
those histories. A saved symbol alone no longer selects the execution model.

Missing/corrupt legacy objects require the original history from backup; they
cannot be repaired using the Forex dataset. New local-history repair still
requires an exact original fingerprint. The read-only `LegacyHistoryCache` and
offline cache/ledger copying tool remain available. Existing compatibility tests
for legacy fingerprints, saved histories, migrations, executions and rollover
remain in the suite.

Removed the provider HTTP client, download/pricing/credit/confirmation service,
paid dialog/client/styles, and verification scripts coupled to that retired API.
Their exact versions remain on the archive branch. Paid-workflow assertions were
replaced with local import/API/Setup tests; legacy session assertions were kept.
The consolidated current browser check is `scripts/local-parquet-browser.mts`.

## Verification and measurements

Full suite: **59 files, 777 tests passed**, `npm test -- --maxWorkers=2`, 101.96 s.
A further targeted legacy-cache check passed all seven tests after its final
read-only cleanup. After final chart precision formatting, all 154 production
workflow, legacy chart-interaction, static-Setup and environment checks passed in
targeted runs. The legacy chart mock now supplies the native `applyOptions`
method; its financial and replay assertions are unchanged. Typecheck, production
build and `git diff --check` passed.
Vite retains the pre-existing warning for a bundle larger than 500 kB; build
succeeds. No historical Parquet is tracked by Git.

[Import evidence](import-benchmark.json): complete copy, hash, row validation,
calendar construction and publication took **13.680 s**, peak process RSS
**330.73 MiB**, on a repeat import of the actual file. The initial import took
10.995 s / 354.14 MiB. These are whole-process memory high-water marks, not just
incremental allocations or the DuckDB memory limit.

[Node measurements](node-benchmarks.json), each in a fresh Node process with warm
OS filesystem cache, include checksum/manifest verification and normalized range
loading. Timing excludes subsequent digest construction and UI/HTTP transfer.

| Trading period, end exclusive | With pre-roll | M1 observations | Seconds | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: |
| 2005-05-01 → 2005-07-30 | from 2005-04-01 | 120,382 | 0.354 | 350.88 |
| 2015-04-01 → 2015-06-30 | from 2015-03-02 | 122,565 | 0.357 | 346.37 |
| 2025-04-01 → 2025-06-30 | from 2025-03-02 | 121,125 | 0.369 | 341.36 |

Each selected trading period is 90 days. The 2005 period starts later than the
initial inspection benchmark so that its entire pre-roll exists. The earlier
April 1 query is correctly rejected for insufficient source coverage.

An independent PyArrow predicate reader reproduced **every timestamp and every
OHLC value** in all three Node results. [Oracle evidence](oracle-verification.json)
records matching SHA-256 digests over row-major, little-endian binary64 values;
integer milliseconds are exactly representable here. This checks full result
contents, not only lengths or sampled endpoints.

[Chromium evidence](browser-verification.json) passed at **1100 × 800** and
**1440 × 1000** using the actual installed 2005 archive and isolated temporary
sessions. It checked archive navigation across years, date selection, automatic
paused startup, two independent entries, next-open fills, commissions, one manual
close, Results/Balance & Equity, finish/resume consistency, full reload/restore,
keyboard advance and history review. Each run made one history load, zero
external requests, zero pricing/download calls, and produced no page errors or
horizontal overflow. Tests retain deterministic stop-drag, independent navigation,
no-lookahead, gap and futures-rollover coverage. Browser screenshots cover Setup,
Trading and Results at both widths.

Reproduction commands:

```sh
node --import tsx scripts/import-local-forex.mts /home/admin/Downloads/eurusd_1min.parquet
node --import tsx scripts/local-parquet-benchmark.mts
python3 docs/local-parquet-migration/audit_parquet.py --verify-node \
  /home/admin/Downloads/eurusd_1min.parquet docs/local-parquet-migration/node-benchmarks.json
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/local-parquet-browser.mts
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
git ls-files '*.parquet' '*.pq'
```

Playwright was installed outside the repository for verification only; Chromium
was already available. PyArrow/NumPy were already installed and serve only as
inspection/oracle tools. Neither is an application runtime dependency.

## Limits and remaining decisions

No decisions remain for this EURUSD migration. The originating feed and any
upstream empty-minute filling policy were not supplied; the application makes
no claims about either and does not repair the observations. Performance numbers
are single-run warm-cache measurements on this machine. Other quote currencies,
other price representations, spread/slippage/financing models, and online data
acquisition remain outside this milestone. Browser verification covers Chromium
at the requested desktop widths, not other browsers or mobile layouts.
