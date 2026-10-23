import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionStorage, StorageFailure, validId, validHash } from './sessionStorage.js'
import type { SessionRecord } from '../../frontend/src/sessionTypes.js'
import type { LoadedHistory } from '../../frontend/src/historyLoader.js'

export async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new StorageFailure(415, 'Use application/json.')
  const length = Number(request.headers['content-length'] ?? 0)
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) { request.resume(); throw new StorageFailure(413, 'Storage request is too large.') }
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) { request.resume(); throw new StorageFailure(413, 'Storage request is too large.') }
    chunks.push(Buffer.from(chunk))
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value: unknown) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid JSON value')
      return value
    })
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
    return value as Record<string, unknown>
  } catch { throw new StorageFailure(400, 'Malformed storage JSON request.') }
}
export async function sessionApi(request: IncomingMessage, response: ServerResponse, storage: SessionStorage): Promise<boolean> {
  if (!request.url?.startsWith('/api/storage')) return false
  const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)) }
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const host = request.headers.host
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new StorageFailure(403, 'Localhost Host header required.')
    const origin = request.headers.origin
    if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new StorageFailure(403, 'Cross-origin storage access is forbidden.')
    if (!['GET', 'HEAD'].includes(request.method ?? '') && origin !== `http://${host}`) throw new StorageFailure(403, 'Same-origin Origin header required for storage changes.')
    const path = request.url.split('?')[0]
    if (path.includes('%') || path.includes('..') || path.includes('\\')) throw new StorageFailure(400, 'Invalid storage path.')
    if (request.method === 'GET' && path === '/api/storage/status') { send(200, await storage.status()); return true }
    if (request.method === 'GET' && path === '/api/storage/sessions') { send(200, await storage.list()); return true }
    const history = /^\/api\/storage\/history\/([^/]+)$/.exec(path)
    if (history) {
      validHash(history[1])
      if (request.method === 'GET') { send(200, await storage.getHistory(history[1])); return true }
      if (request.method === 'HEAD') { response.writeHead(await storage.hasHistory(history[1]) ? 200 : 404); response.end(); return true }
      if (request.method === 'PUT') { await storage.putHistory(history[1], await readJson(request, 64 * 1024 * 1024) as unknown as LoadedHistory); send(200, { stored: true }); return true }
    }
    const session = /^\/api\/storage\/sessions\/([^/]+)(\/(checkpoint|migration))?$/.exec(path)
    if (session) {
      const id = session[1]; validId(id)
      if (request.method === 'POST' && session[3] === 'migration') {
        const body = await readJson(request, 4096)
        await storage.confirmMigration(id, body.targetId as string, body.revision as number, body.sourceRevision as number, body.digest as string)
        send(200, { verified: true }); return true
      }
      if (request.method === 'GET' && session[3] === 'migration') { send(200, await storage.migration(id)); return true }
      if (request.method === 'GET' && !session[3]) { send(200, await storage.restore(id)); return true }
      if (request.method === 'PUT' && session[3] === 'checkpoint' || request.method === 'POST' && !session[3]) {
        const body = await readJson(request, 40 * 1024 * 1024)
        const record = body.record as SessionRecord
        if (!record || record.id !== id || !Array.isArray(body.chunks) || body.chunks.length > 200 || typeof body.expectedRevision !== 'number') throw new StorageFailure(400, 'Invalid checkpoint payload.')
        if (request.method === 'POST' && body.expectedRevision !== 0) throw new StorageFailure(400, 'New sessions require revision zero.')
        send(200, await storage.save(record, body.chunks, body.expectedRevision, body.migration as { digest: string; revision: number } | undefined)); return true
      }
      if (request.method === 'PATCH' || request.method === 'DELETE') {
        const body = await readJson(request, 4096)
        if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new StorageFailure(400, 'Invalid revision.')
        if (request.method === 'PATCH') send(200, await storage.rename(id, body.name as string, body.revision as number))
        else { await storage.delete(id, body.revision as number); send(200, { deleted: true }) }
        return true
      }
    }
    throw new StorageFailure(404, 'Storage endpoint not found.')
  } catch (error) {
    if (error instanceof StorageFailure) send(error.status, { error: error.message })
    else {
      const code = (error as NodeJS.ErrnoException).code
      const message = code === 'ENOSPC' || code === 'EDQUOT' ? 'Disk full. Checkpoint was not confirmed saved; free disk space and retry.'
        : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'Storage permission denied. Check directory permissions and retry.'
        : code === 'ENOENT' ? 'Required storage data is missing. Original committed files were kept.'
        : error instanceof Error && (error.message.includes('session') || error.message.includes('backend') || error.message.includes('writer.lock') || error.message.includes('fingerprint')) ? error.message
        : 'Filesystem storage failed. Check the storage directory and retry; original committed files were kept.'
      send(503, { error: message })
    }
  }
  return true
}
