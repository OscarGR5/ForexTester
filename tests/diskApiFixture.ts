import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionApi } from '../backend/src/sessionApi.js'
import { SessionStorage, type StorageOptions } from '../backend/src/sessionStorage.js'

const nativeFetch = globalThis.fetch
export async function diskApiFixture(options: Omit<StorageOptions, 'directory'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forextester-test-'))
  const storage = new SessionStorage({ directory, ...options })
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!await sessionApi(req, res, storage)) { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`
  return { storage, directory, origin,
    fetch: (path: string, init?: RequestInit) => nativeFetch(`${origin}${path}`, { ...init, headers: { Origin: origin, ...init?.headers } }),
    close: async () => { await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); server.closeIdleConnections() }); await storage.close(); await rm(directory, { recursive: true, force: true }) },
  }
}
