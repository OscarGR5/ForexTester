import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { createApp } from './app.js'

let server: Server | undefined

afterEach(() => server?.close())

describe('health endpoint', () => {
  it('returns JSON status', async () => {
    server = createApp().listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ status: 'ok' })
  })
})
