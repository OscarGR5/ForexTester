"""Read-only investigation, not an application parser or runtime dependency.

Usage: python3 docs/local-parquet-migration/audit_parquet.py SOURCE > inspection.json
Requires the inspection environment's existing PyArrow and NumPy installations.
UTC labels below are explicitly conditional on TS representing Unix seconds.
"""

import collections
import datetime as dt
import hashlib
import json
import os
import platform
import subprocess
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


def utc(seconds):
    return dt.datetime.fromtimestamp(int(seconds), dt.timezone.utc).isoformat()


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def peak_rss_mib():
    # /proc reflects this exec's high-water mark rather than inherited rusage.
    with open('/proc/self/status') as status:
        for line in status:
            if line.startswith('VmHWM:'):
                return round(int(line.split()[1]) / 1024, 2)
    raise RuntimeError('Linux VmHWM unavailable')


def range_read(path, year, days):
    start = int(dt.datetime(year, 4, 1, tzinfo=dt.timezone.utc).timestamp())
    end = start + 90 * 86400
    start -= (days - 90) * 86400
    started = time.perf_counter()
    parquet = pq.ParquetFile(path)
    groups = []
    selected_rows = decoded_rows = compressed_bytes = 0
    first = last = None
    for i in range(parquet.num_row_groups):
        group = parquet.metadata.row_group(i)
        stats = group.column(0).statistics
        if stats.max < start or stats.min >= end:
            continue
        groups.append(i)
        decoded_rows += group.num_rows
        compressed_bytes += sum(group.column(j).total_compressed_size
                                for j in range(group.num_columns))
        table = parquet.read_row_group(i)
        selected = table.filter(pc.and_(pc.greater_equal(table["TS"], start),
                                       pc.less(table["TS"], end)))
        selected_rows += selected.num_rows
        if selected.num_rows:
            first = first if first is not None else selected["TS"][0].as_py()
            last = selected["TS"][-1].as_py()
    return {"year": year, "days": days, "range_start_inferred_utc": utc(start),
            "range_end_exclusive_inferred_utc": utc(end), "row_groups": groups,
            "decoded_rows": decoded_rows, "selected_rows": selected_rows,
            "compressed_column_bytes": compressed_bytes,
            "first_ts": first, "last_ts": last,
            "elapsed_seconds": round(time.perf_counter() - started, 6),
            "process_peak_rss_mib": peak_rss_mib()}


def inspect(path):
    started = time.perf_counter()
    before = os.stat(path)
    initial_hash = checksum(path)
    parquet = pq.ParquetFile(path)
    meta = parquet.metadata
    out = {
        "source": os.path.abspath(path), "bytes": before.st_size,
        "sha256_before": initial_hash, "rows": meta.num_rows,
        "row_groups": meta.num_row_groups, "created_by": meta.created_by,
        "parquet_version": meta.format_version, "footer_bytes": meta.serialized_size,
        "key_value_metadata": None if meta.metadata is None else
            {k.decode(): v.decode() for k, v in meta.metadata.items()},
        "schema": str(parquet.schema).split("\n", 1)[1],
        "arrow_schema": str(parquet.schema_arrow),
        "environment": {"python": platform.python_version(), "pyarrow": pa.__version__,
                        "numpy": np.__version__, "platform": platform.platform()},
        "row_group_details": [], "nulls": {name: 0 for name in parquet.schema.names},
    }
    names = parquet.schema.names
    quality = collections.Counter()
    gaps = collections.Counter()
    weekdays = collections.Counter()
    years = collections.Counter()
    precision = collections.Counter()
    largest_gaps = []
    samples = {}
    invalid_samples = []
    previous_ts = previous_record = None
    offset = 0
    sample_indices = {0, 1, 2, meta.num_rows // 2 - 1, meta.num_rows // 2,
                      meta.num_rows // 2 + 1, meta.num_rows - 3,
                      meta.num_rows - 2, meta.num_rows - 1}
    for i in range(parquet.num_row_groups):
        group = meta.row_group(i)
        stat = group.column(0).statistics
        out["row_group_details"].append({
            "index": i, "rows": group.num_rows, "ts_min": stat.min, "ts_max": stat.max,
            "ts_statistics_nulls": stat.null_count,
            "uncompressed_bytes": group.total_byte_size,
            "compressed_bytes": sum(group.column(j).total_compressed_size for j in range(group.num_columns)),
            "compression": sorted({group.column(j).compression for j in range(group.num_columns)}),
        })
        table = parquet.read_row_group(i)
        for name in names:
            out["nulls"][name] += table[name].null_count
        if any(table[name].null_count for name in names):
            raise ValueError("Nulls require a separate inspection path; no repairs permitted")
        arrays = {name: table[name].combine_chunks().to_numpy() for name in names}
        ts = arrays["TS"]
        o, h, l, c = (arrays[name] for name in ["O", "H", "L", "C"])
        prices = np.column_stack([o, h, l, c])
        def record(j):
            return {"row_index": offset + j, **{name: arrays[name][j].item() for name in names},
                    "inferred_utc": utc(ts[j])}
        differences = np.diff(ts, prepend=previous_ts if previous_ts is not None else ts[0] - 60)
        quality["adjacent_duplicate_timestamps"] += int(np.count_nonzero(differences == 0))
        quality["out_of_order_steps"] += int(np.count_nonzero(differences < 0))
        quality["non_m1_aligned_timestamps"] += int(np.count_nonzero(ts % 60))
        bad = (~np.isfinite(prices).all(axis=1) | (prices <= 0).any(axis=1)
               | (h < l) | (h < o) | (h < c) | (l > o) | (l > c))
        quality["invalid_ohlc_rows"] += int(np.count_nonzero(bad))
        quality["nonfinite_price_values"] += int(np.count_nonzero(~np.isfinite(prices)))
        quality["nonpositive_price_values"] += int(np.count_nonzero(prices <= 0))
        quality["flat_ohlc_rows"] += int(np.count_nonzero((o == h) & (h == l) & (l == c)))
        for j in np.flatnonzero(bad)[:max(0, 10 - len(invalid_samples))]:
            invalid_samples.append(record(int(j)))
        digits = np.full(prices.shape, 11, dtype=np.int8)
        for d in range(11):
            digits[(digits == 11) & (np.abs(prices - np.round(prices, d)) <= 1e-12)] = d
        precision.update({int(k): int(v) for k, v in zip(*np.unique(digits, return_counts=True))})
        day = ts // 86400
        weekday = (day + 3) % 7  # Unix epoch was Thursday; Monday = 0.
        weekdays.update({int(k): int(v) for k, v in zip(*np.unique(weekday, return_counts=True))})
        year = ts.astype('datetime64[s]').astype('datetime64[Y]').astype(int) + 1970
        years.update({int(k): int(v) for k, v in zip(*np.unique(year, return_counts=True))})
        gap_indices = np.flatnonzero(differences > 60)
        gaps.update({int(k): int(v) for k, v in zip(*np.unique(differences[gap_indices], return_counts=True))})
        for j in gap_indices:
            j = int(j)
            largest_gaps.append({"seconds": int(differences[j]),
                                 "before": record(j - 1) if j else previous_record,
                                 "after": record(j)})
        largest_gaps = sorted(largest_gaps, key=lambda g: g["seconds"], reverse=True)[:20]
        for target in sample_indices:
            if offset <= target < offset + table.num_rows:
                samples[str(target)] = record(target - offset)
        for day_number, label in [(5, "saturday"), (6, "sunday")]:
            positions = np.flatnonzero(weekday == day_number)
            if len(positions) and label not in samples:
                j = int(positions[0])
                samples[label] = [record(k) for k in range(max(0, j - 1), min(table.num_rows, j + 2))]
        for label, condition in [("first_short_gap", (differences > 60) & (differences < 3600)),
                                 ("first_weekend_length_gap", differences >= 172800)]:
            positions = np.flatnonzero(condition)
            if len(positions) and label not in samples:
                j = int(positions[0])
                samples[label] = [record(j - 1) if j else previous_record, record(j)]
        previous_ts = int(ts[-1])
        previous_record = record(len(ts) - 1)
        offset += table.num_rows
    if quality["out_of_order_steps"]:
        # Exact fallback for global duplicates when adjacency is not sufficient.
        timestamps = pq.read_table(path, columns=["TS"])["TS"].combine_chunks().to_numpy()
        quality["duplicate_timestamp_rows"] = len(timestamps) - len(np.unique(timestamps))
    else:
        quality["duplicate_timestamp_rows"] = quality["adjacent_duplicate_timestamps"]
    out.update({"quality": dict(quality), "invalid_samples": invalid_samples,
                "gap_step_seconds_histogram": dict(sorted(gaps.items())),
                "gap_count": sum(gaps.values()),
                "missing_minute_slots_between_endpoints": sum((k // 60 - 1) * v for k, v in gaps.items()),
                "largest_gaps": largest_gaps, "samples": samples,
                "inferred_utc_weekday_counts_monday_zero": dict(sorted(weekdays.items())),
                "inferred_utc_year_counts": dict(sorted(years.items())),
                "minimum_decimal_places_histogram_tolerance_1e_12": dict(sorted(precision.items())),
                "scan_seconds_including_initial_checksum": round(time.perf_counter() - started, 6),
                "scan_process_peak_rss_mib": peak_rss_mib()})
    out["range_benchmarks"] = [json.loads(subprocess.check_output(
        [sys.executable, __file__, "--range", path, str(year), str(days)], text=True))
        for days in [90, 120] for year in [2005, 2015, 2025]]
    out["sha256_after"] = checksum(path)
    after = os.stat(path)
    out["source_unchanged"] = (initial_hash == out["sha256_after"]
                               and before.st_size == after.st_size
                               and before.st_mtime_ns == after.st_mtime_ns)
    return out


if __name__ == "__main__":
    if sys.argv[1] == "--range":
        result = range_read(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    else:
        result = inspect(sys.argv[1])
    print(json.dumps(result, indent=2, sort_keys=True))
