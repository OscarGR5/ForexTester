import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const dir = await mkdtemp(join(tmpdir(), 'forex-provider-'))
const server = createApp(undefined, undefined, new SessionStorage({ directory: dir }))
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const evidence: unknown[] = []
try {
  for (const [from,to] of [['2024-01-09','2024-01-10'],['2024-02-05','2024-02-07']]) {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${port}/api/history?symbol=EURUSD&from=${from}&to=${to}`)
    const data = await response.json()
    if (!response.ok) throw Error(JSON.stringify(data))
    assert.ok(data.bid.length > 0 && data.ask.length > 0)
    evidence.push({from,to,ms:Date.now()-started,bid:data.bid.length,ask:data.ask.length,firstBid:data.bid[0],firstAsk:data.ask[0],lastBid:data.bid.at(-1),lastAsk:data.ask.at(-1)})
    console.log(JSON.stringify(evidence.at(-1)))
  }
  evidence.push(await (await fetch(`http://127.0.0.1:${port}/api/history/coverage`)).json())
  await writeFile('docs/task-20/provider-verification.json', JSON.stringify(evidence,null,2))
} finally { await new Promise<void>(r=>server.close(()=>r())); await rm(dir,{recursive:true,force:true}) }
