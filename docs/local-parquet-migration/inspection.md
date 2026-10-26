# Local Parquet migration inspection

Inspected October 26, 2026. The execution-semantics gate was subsequently resolved
by the project lead in this conversation: prices are **mid**, `TS` is **UTC Unix
seconds**, and each timestamp labels the **start** of its minute. OHLC column
meanings and minute alignment were also confirmed. These are supplied semantics;
the Parquet file itself has no corresponding metadata. Implementation proceeds
using the simplified single-price model without a spread. The observations below
preserve the original inspection evidence; its conditional UTC labels are now
confirmed by the lead.

The file contains one structurally valid OHLC series, but does not identify its
price basis, timestamp timezone/origin, or whether timestamps label candle opens
or closes. This uncertainty originally blocked implementation; the project lead subsequently
provided the required semantics above. A candle close
timestamp treated as an open timestamp would change information availability and
next-observation fills.

## Preservation and scope

The initial working tree was clean on `feat/balance-equity-chart`, HEAD
`853500c84c1c536a12265787b2ece038dbce7504`. Local `main` was
`7ef4888cfb0a30e1351b003f5a5a9d516b5c18dd`, two commits behind GitHub's main.
Local and remote branches were inspected, then `git fetch origin` confirmed
`origin/main` at `853500c84c1c536a12265787b2ece038dbce7504`. The local main commit
is its ancestor. Local `main` was left unchanged.

Created `archive/databento-2026-10-26` from the verified current GitHub main and
pushed it. An independent `git ls-remote --heads origin
archive/databento-2026-10-26` returned exactly:

```text
853500c84c1c536a12265787b2ece038dbce7504 refs/heads/archive/databento-2026-10-26
```

Created `feat/local-parquet-forex` from the same commit. The archive remains
independently checkoutable with `git switch archive/databento-2026-10-26`.
The branch only preserves tracked files. No external caches, spending ledger,
environment files, saved sessions, or source data were deleted, migrated, or
backed up by this branch operation.

Read `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, workspace manifests, and ignore rules.
At the initial inspection checkpoint, no application code, financial formulas, session fingerprints, dependencies,
storage layout, or API was changed. Application-module investigation and design
are deferred until the inspection gate is resolved. The Python script in this
directory is a reproducible read-only investigation tool, not an application
parser or required application runtime.

## File and schema

Source: `/home/admin/Downloads/eurusd_1min.parquet`.

| Property | Observed value |
| --- | --- |
| File size | 110,028,526 bytes, 104.931 MiB |
| Rows | 7,945,468 |
| Row groups | 65: 64 × 122,880 rows, then 81,148 rows |
| Compression | SNAPPY for every column in every row group |
| Format version | Parquet 1.0 |
| Writer | `DuckDB version v2.0.0 (build d54cbbe3df)` |
| Footer size | 36,992 bytes |
| Column chunks, compressed | 105,710,974 bytes total |
| Column chunks, uncompressed | 138,782,989 bytes total |
| Key/value metadata | Absent |
| SHA-256 | `b7952ececc3677fa32606fac5ad125ca92a4fcdc83f1901088ae7cc6233bbb64` |

Exact schema, with all five fields nullable in the schema:

```text
required group field_id=-1 duckdb_schema {
  optional int64 field_id=-1 TS (Int(bitWidth=64, isSigned=true));
  optional double field_id=-1 O;
  optional double field_id=-1 H;
  optional double field_id=-1 L;
  optional double field_id=-1 C;
}
```

Arrow types are `TS: int64`, `O: double`, `H: double`, `L: double`, `C: double`.
`TS` has an integer logical annotation, not a timestamp annotation. Price fields
are IEEE 754 binary64, with no decimal scale or price-side annotation.

## Time interpretation and coverage

Observed minimum `TS`: **1110378900**. Observed maximum: **1790369940**.
Values are strictly increasing across every row and row-group boundary. Every
value is divisible by 60. Adjacent changes are integer multiples of 60, with
ordinary minute observations separated by 60.

Interpreting these integers as Unix seconds produces **2005-03-09 14:35:00 UTC**
through **2026-09-25 20:59:00 UTC**, inclusive. That interpretation is strongly
consistent with M1 history; interpreting the same integers as milliseconds,
microseconds, or nanoseconds produces dates near the Unix epoch rather than a
multi-year series. This is an inference from magnitudes and deltas, not a
documented producer contract.

The file contains no timezone, epoch definition, offset convention, or indication
of open-time versus close-time labeling. Integer epoch-shaped values alone cannot
rule out local wall times encoded as if UTC. All UTC labels, weekdays, yearly
counts, range benchmarks, and gap examples below are conditional on the Unix
seconds interpretation. No timestamp was converted through floating-point values.

The JSON evidence contains per-year counts for 2005–2026 and exact min/max values
for all 65 row groups. Neither verified UTC coverage nor eligible trading dates
should be published to the application until timestamp semantics are approved.

## Price representation and volume

There is exactly one `O/H/L/C` series. There are no separate bid and ask fields,
spread fields, trades, ticks, contract mappings, or volume fields. No volume
semantics apply. All observed OHLC values satisfy the expected high/low bounds.

**Price basis remains unidentified:** bid, ask, mid, last, or another derived
series cannot be determined from these numbers. Fractional price increments do
not prove mid prices. The filename is the supplied EURUSD identity; the file has
no symbol or provenance metadata independently confirming that identity. The
writer string identifies the Parquet writer, not the originating market feed.
No matching EURUSD sidecar was present beside the supplied file.

Values require up to seven decimal places to represent their observed decimal
grid within an absolute tolerance of `1e-12`. Across 31,781,872 price values:

| Minimum decimal places within tolerance | Values |
| --- | ---: |
| 0 | 46 |
| 1 | 2,139 |
| 2 | 22,126 |
| 3 | 260,987 |
| 4 | 3,173,780 |
| 5 | 12,186,220 |
| 6 | 16,050,400 |
| 7 | 86,174 |

This is observed numerical precision, not an instrument tick size or evidence of
price-side semantics. No prices were rounded, repaired, or synthesized.

## Full-row validation and gaps

The scan decoded one row group at a time and included transitions between groups.

| Check | Result |
| --- | ---: |
| Nulls in each of TS/O/H/L/C | 0 |
| Duplicate timestamps | 0 |
| Out-of-order timestamp transitions | 0 |
| Timestamps off minute boundaries | 0 |
| Nonfinite price values | 0 |
| Zero or negative price values | 0 |
| Invalid OHLC rows | 0 |
| Flat rows, O = H = L = C | 194,364 |
| Adjacent steps greater than 60 seconds | 5,589 |
| Unobserved minute slots between dataset endpoints | 3,387,717 |

Invalid OHLC means nonfinite/nonpositive values, H below L, H below O or C, or L
above O or C. Strict chronological order makes the duplicate check exhaustive:
any repeated timestamp would have to be adjacent. Duplicate full records are
therefore also absent. Flat candles are recorded observations; the file cannot
establish whether the producer filled any empty minutes upstream.

There are 72 distinct gap lengths. The JSON contains the complete histogram.
Notable lengths include 4,148 steps of 960 seconds, each leaving 15 missing M1
slots, and 983 steps of 173,760 seconds, each lasting 48 h 16 min. The longest
step is 270,060 seconds, 75 h 1 min, occurring eight times. Calendar closures,
maintenance, and missing feed data cannot be distinguished without provenance.
The missing-slot total includes weekends and holidays; it is not a count of
corrupt or missing expected trading observations.

Under the inferred UTC interpretation there are no Saturday records and 155,414
Sunday records. Weekday counts, Monday through Friday, are 1,583,762; 1,590,646;
1,591,528; 1,592,813; and 1,431,305. Preserve all observed gaps. Do not fill them
or treat a day containing some records as a complete trading day.

## Representative observations

Exact stored values from the beginning, middle, and end:

| Zero-based row | TS | Inferred UTC | O | H | L | C |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 0 | 1110378900 | 2005-03-09 14:35 | 1.3339 | 1.3339 | 1.3339 | 1.3339 |
| 1 | 1110378960 | 2005-03-09 14:36 | 1.3339 | 1.3339 | 1.3334 | 1.3335 |
| 3,972,733 | 1450703520 | 2015-12-21 13:12 | 1.08602 | 1.086175 | 1.08599 | 1.086175 |
| 3,972,734 | 1450703580 | 2015-12-21 13:13 | 1.086175 | 1.08653 | 1.086165 | 1.08651 |
| 7,945,466 | 1790369880 | 2026-09-25 20:58 | 1.139115 | 1.13914 | 1.139065 | 1.139105 |
| 7,945,467 | 1790369940 | 2026-09-25 20:59 | 1.139105 | 1.139195 | 1.13905 | 1.13918 |

The JSON includes neighboring observations and raw OHLC on both sides of unusual
intervals. Examples under the inferred UTC interpretation:

- First weekend: Friday 2005-03-11 21:59, C = 1.3458, to Monday 2005-03-14
  00:25, O = 1.3475. No intervening observations exist.
- Short interruption: 2005-03-17 21:59, C = 1.3378, to 22:45, O = 1.3382.
- Sunday reopening: Friday 2005-03-18 21:59, C = 1.33245, to Sunday
  2005-03-20 22:45, O = H = L = C = 1.331.
- Long holiday interval: 2005-12-23 21:59, C = 1.1868, to 2005-12-27 01:00,
  O = 1.18355. The timestamp step is 270,060 seconds.

## Direct interval-read measurements

Every row group has usable min/max statistics for TS. Group timestamp bounds are
ordered and nonoverlapping. The investigation reader uses these statistics to
select groups before decoding. All five columns are read only for selected
groups, then filtered to an inclusive start and exclusive end. This demonstrates
that the actual file supports bounded interval reads without decoding all
7.9 million rows. It does not measure DuckDB's Node API or JSON delivery costs.

Each benchmark used a fresh Python process, PyArrow 25.0.1 and NumPy 2.4.6 on
Python 3.14.8/Linux. Timing begins before opening the Parquet reader and includes
metadata inspection, selected-group reads, filtering, and counting; it excludes
interpreter startup. Memory is the process's Linux `/proc/self/status` VmHWM,
including interpreter/library overhead. These are single-run, warm filesystem
cache observations, taken while the baseline test suite was running.

Trading ranges are April 1 through June 30 exclusive in the specified year.
Pre-roll variants begin March 2, 30 days earlier, and retain the same end.

| Year | Requested days | Groups | Rows decoded | Candles selected | Elapsed s | Peak RSS MiB |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 2005 | 90 | 0 | 122,880 | 89,325 | 0.239 | 156.96 |
| 2015 | 90 | 30 | 122,880 | 91,155 | 0.260 | 166.11 |
| 2025 | 90 | 60 | 122,880 | 91,035 | 0.205 | 167.76 |
| 2005 | 120 | 0 | 122,880 | 111,620 | 0.193 | 163.75 |
| 2015 | 120 | 29–30 | 245,760 | 122,565 | 0.223 | 177.23 |
| 2025 | 120 | 59–60 | 245,760 | 121,125 | 0.222 | 179.14 |

The 2005 pre-roll query is intentionally clipped by available data: March 2–9
has no observations. A successful read does not imply a fully eligible pre-roll.
The three 90-day queries use nonoverlapping row groups from different years.
Only 1.19–2.06 MB of compressed column chunks is eligible for each of those
queries; this is metadata-derived column size, not measured disk I/O.

The full quality scan plus initial SHA-256 took 3.982 seconds and reached
243.57 MiB RSS. A second hash and unchanged size/mtime confirmed the source was
unchanged after inspection. The entire multi-year table was never decoded into
one in-memory table.

No measurements justify partitioning or conversion at this stage. DuckDB's Node
API evaluation, importer implementation, copy/import benchmark, final durable
storage structure, and backend memory measurements are deferred at the required
semantic stop. No dependencies were added. Python is used only for inspection.
The source is readable; the filesystem had approximately 369 GiB available.
No managed import or staging copy was performed.

## Reproduction and verification

Machine-readable results: [inspection.json](inspection.json). Reproduction tool:
[audit_parquet.py](audit_parquet.py). The tool only opens the source for reading;
stdout contains its JSON report. Do not redirect onto the source.

```bash
python3 docs/local-parquet-migration/audit_parquet.py \
  /home/admin/Downloads/eurusd_1min.parquet \
  > /tmp/forextester-parquet-inspection.json
git ls-remote --heads origin main archive/databento-2026-10-26
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
git ls-files '*.parquet' '*.pq'
```

Baseline verification on the unchanged application:

- `npm test -- --maxWorkers=2`: 58 test files and 795 tests passed, 100.47 seconds.
- `npm run typecheck`: passed in both workspaces.
- `npm run build`: passed in both workspaces. Vite retained its existing warning
  about a JavaScript chunk exceeding 500 kB; the build succeeded.
- `git diff --check` and the staged equivalent: passed.
- `git ls-files '*.parquet' '*.pq'`: no tracked data files.
- Independent `pyarrow.dataset` predicate reads reproduced candle counts and
  first/last timestamps for all six range benchmarks. Report totals for row
  groups, years, weekdays, and price precision reconcile with the full row count.

Browser verification at 1100px/1440px, execution integration, restored-session scenarios,
and end-to-end import/save/resume verification are deferred because no migration
has been implemented. Compatibility code and saved datasets remain unchanged;
that is not a claim that the future migration has passed compatibility testing.
The inspection made no application API calls or market-data requests. No Parquet
data is tracked by Git. The later implementation and its PR are covered by [implementation.md](implementation.md).

## Project-lead decision, now resolved

Provide producer documentation or an explicit approved interpretation identifying:

1. What O/H/L/C represent: bid, ask, mid, last, or a named derived price series.
2. Whether TS is Unix seconds in UTC and whether each value labels the M1
   interval's open or close. Include any provider timezone/offset conventions.
3. Provenance confirming EURUSD and explaining any upstream price transformation
   or empty-minute filling, if known.

Do not infer midpoint prices from decimal precision, invent bid/ask, or select
execution behavior merely from the EURUSD filename. The supplied request
explicitly requires stopping here before assumptions can alter backtest results.

The project lead supplied mid-price OHLC and UTC Unix seconds at minute start.
No producer identity or upstream empty-minute filling policy was supplied. Those
remain provenance limitations and are not inferred; observed gaps are retained.
See [implementation.md](implementation.md) for the completed migration and checks.
