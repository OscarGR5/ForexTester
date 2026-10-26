// One-time offline import. Never copies sessions or calls the provider.
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LegacyHistoryCache } from '../backend/src/history.js'
import { providerCachePaths } from '../backend/src/projectPaths.js'

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
export async function migrateCache(source: string, destination: string) {
  source = await realpath(source)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const stat = await lstat(destination)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Destination must be a real directory.')
  destination = await realpath(destination)
  const inside = (a: string, b: string) => { const r = relative(a, b); return !r || !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) }
  if (inside(source, destination) || inside(destination, source)) throw Error('Source and destination must be separate cache directories.')
  const locks: { path: string; file: Awaited<ReturnType<typeof open>> }[] = []
  let stage: string | undefined
  try {
    for (const root of [source, destination]) {
      const path = join(root, 'download.lock')
      locks.push({ path, file: await open(path, 'wx', 0o600) })
    }
    const names = (await readdir(source)).filter(name => name !== 'download.lock').sort()
    if (!names.includes('verification-budget.json') || !names.some(name => name.endsWith('.ref.json'))) throw Error('Source must contain daily data and its original spending ledger.')
    if (names.some(name => !/^(verification-budget|\d{4}-\d{2}-\d{2}\.ref|[a-f0-9]{64})\.json$/.test(name))) throw Error('Unexpected source file. Refusing to import anything beyond daily cache data and its ledger.')
    // Stop on any destination conflict before publishing anything, including a different ledger.
    for (const name of await readdir(destination)) {
      if (name === 'download.lock') continue
      if (!names.includes(name) || !(await readFile(join(source, name))).equals(await readFile(join(destination, name)))) throw Error(`Destination conflict: ${name}. Original files retained.`)
    }
    stage = await mkdtemp(join(dirname(destination), '.databento-import-'))
    const hashes: Record<string, string> = {}
    for (const name of names) {
      if (!(await lstat(join(source, name))).isFile()) throw Error(`Source is not a regular file: ${name}`)
      await copyFile(join(source, name), join(stage, name), constants.COPYFILE_EXCL)
      const original = await readFile(join(source, name)), copied = await readFile(join(stage, name))
      if (!original.equals(copied)) throw Error(`Copy verification failed: ${name}`)
      hashes[name] = digest(copied)
      const file = await open(join(stage, name), 'r'); try { await file.sync() } finally { await file.close() }
    }
    const verified = new LegacyHistoryCache(stage)
    const dates = names.filter(name => name.endsWith('.ref.json')).map(name => name.slice(0, 10))
    for (const from of dates) await verified.readCached(from, new Date(Date.parse(from) + 86400000).toISOString().slice(0, 10))
    const ledger = JSON.parse(await readFile(join(stage, 'verification-budget.json'), 'utf8'))
    if (ledger.version !== 1 || !Array.isArray(ledger.reservations) || ledger.reservations.some((r: {reservedUsd: number; estimatedUsd: number}) => !Number.isFinite(r.reservedUsd) || r.reservedUsd < 0 || !Number.isFinite(r.estimatedUsd) || r.estimatedUsd < 0)) throw Error('Invalid legacy spending ledger.')
    // Publish data before the ledger under the shared paid-work lock; never overwrite.
    for (const name of [...names.filter(name => name !== 'verification-budget.json'), 'verification-budget.json']) {
      try { await link(join(stage, name), join(destination, name)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (digest(await readFile(join(destination, name))) !== hashes[name] || digest(await readFile(join(source, name))) !== hashes[name]) throw Error(`Publication conflict: ${name}. Original files retained.`)
    }
    const folder = await open(destination, 'r'); try { await folder.sync() } finally { await folder.close() }
    return { source, destination, dates: dates.length, files: names.length, ledgerSha256: hashes['verification-budget.json'], hashes }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    for (const lock of locks.reverse()) { await lock.file.close(); await unlink(lock.path) }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2]
  if (!source) throw Error('Usage: node --import tsx scripts/databento-cache-migrate.mts /absolute/source/databento [/absolute/destination/databento]')
  const destination = process.argv[3] ?? (await providerCachePaths()).cacheFolderPath
  const result = await migrateCache(source, destination)
  console.log(JSON.stringify(result, null, 2))
}
