import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheDirectory, providerCachePaths, projectRoot } from './projectPaths.js'
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'forextester-cache-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
it('selects absolute XDG cache, fallback and explicit override outside the repository', () => {
  expect(cacheDirectory({ XDG_CACHE_HOME: join(directory, 'xdg') }, directory)).toBe(join(directory, 'xdg/forextester'))
  expect(cacheDirectory({}, directory)).toBe(join(directory, '.cache/forextester'))
  expect(cacheDirectory({ XDG_CACHE_HOME: 'relative' }, directory)).toBe(join(directory, '.cache/forextester'))
  expect(cacheDirectory({ FOREXTESTER_CACHE_DIR: join(directory, 'override'), XDG_CACHE_HOME: join(directory, 'xdg') }, directory)).toBe(join(directory, 'override'))
})
it('creates private cache directories, for Databento without changing legacy caches', async () => {
  const paths = await providerCachePaths({ XDG_CACHE_HOME: join(directory, 'xdg') }, directory)
  expect(paths).toEqual({ cacheFolderPath: join(directory, 'xdg/forextester/databento') + '/' })
  expect((await lstat(paths.cacheFolderPath)).isDirectory()).toBe(true)
  expect((await lstat(paths.cacheFolderPath)).mode & 0o077).toBe(0)
  expect(await providerCachePaths({ XDG_CACHE_HOME: join(directory, 'xdg') }, directory)).toEqual(paths)
})
it('rejects repository paths and existing symlink ancestors before creating directories', async () => {
  expect(() => cacheDirectory({ FOREXTESTER_CACHE_DIR: projectRoot })).toThrow('outside')
  expect(() => cacheDirectory({ XDG_CACHE_HOME: projectRoot })).toThrow('outside')
  await symlink(projectRoot, join(directory, 'repository'))
  await expect(providerCachePaths({ FOREXTESTER_CACHE_DIR: join(directory, 'repository/task18-must-not-exist') }, directory)).rejects.toThrow('outside')
  await expect(lstat(join(projectRoot, 'task18-must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects symlinked provider subdirectories and overlap with durable saved sessions', async () => {
  await mkdir(join(directory, 'cache')); await symlink(directory, join(directory, 'cache/databento'))
  await expect(providerCachePaths({ FOREXTESTER_CACHE_DIR: join(directory, 'cache') }, directory)).rejects.toThrow('symlink')
  for (const cache of ['data', 'data/cache', '']) await expect(providerCachePaths({ FOREXTESTER_DATA_DIR: join(directory, 'data'), FOREXTESTER_CACHE_DIR: join(directory, cache) }, directory)).rejects.toThrow('separate')
})
