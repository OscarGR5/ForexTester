import { join } from 'node:path'
import { parquetConnection } from '../backend/src/localArchive.js'
export async function parquetFixture(directory: string, suffix = '', query?: string, days = 121) {
  const path = join(directory, `fixture${suffix}.parquet`)
  const connection = await parquetConnection()
  const start = Date.UTC(2024, 0, 1) / 1000
  const sql = query ?? `SELECT (${start} + i * 60)::BIGINT TS, 1.1::DOUBLE O, 1.1004::DOUBLE H, 1.0996::DOUBLE L, 1.1001::DOUBLE C
    FROM range(${days} * 1440) t(i) WHERE i NOT IN (600, 601) AND dayofweek(to_timestamp(${start} + i * 60) AT TIME ZONE 'UTC') NOT IN (0,6)`
  try { await connection.run(`COPY (${sql}) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 2048)`) }
  finally { connection.closeSync() }
  return path
}
