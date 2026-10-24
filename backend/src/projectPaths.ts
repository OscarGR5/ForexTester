import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Works from source and the compiled directory, including a source archive
// without .git. Shared validators change the compiler's output root.
let root = dirname(fileURLToPath(import.meta.url))
while (true) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; workspaces?: unknown }
    if (pkg.name === 'forextester' && Array.isArray(pkg.workspaces)) break
  } catch { /* Continue toward the workspace root. */ }
  const parent = dirname(root)
  if (parent === root) throw new Error('Cannot locate the ForexTester workspace package.json.')
  root = parent
}
export const projectRoot = root

function outsideRepository(path: string) {
  const inside = relative(projectRoot, path)
  if (!inside || !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) throw new Error('FOREXTESTER_CACHE_DIR must be outside the Git repository, including symlinks.')
}
export function cacheDirectory(env = process.env, home = homedir()) {
  const path = resolve(env.FOREXTESTER_CACHE_DIR || join(env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'), 'forextester'))
  outsideRepository(path)
  return path
}
async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalDestination(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
  }
}
export async function providerCachePaths(env = process.env, home = homedir(), name: 'dukascopy' | 'fxcm' = 'dukascopy') {
  const root = cacheDirectory(env, home)
  // Resolve existing ancestors before mkdir, so a symlink cannot create cache
  // directories inside the repository before it is rejected.
  const canonical = await canonicalDestination(root)
  outsideRepository(canonical)
  const durable = await canonicalDestination(resolve(env.FOREXTESTER_DATA_DIR || join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local/share'), 'forextester')))
  const overlaps = (a: string, b: string) => { const r = relative(a, b); return !r || !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) }
  if (overlaps(durable, canonical) || overlaps(canonical, durable)) throw new Error('Provider cache and durable session storage must use separate directories.')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const provider = join(root, name)
  await mkdir(provider, { recursive: true, mode: 0o700 })
  const info = await lstat(provider)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Provider cache directory must not be a symlink.')
  outsideRepository(await realpath(provider))
  return { cacheFolderPath: provider + sep, wafTokenCachePath: join(provider, 'waf-token.json') }
}
