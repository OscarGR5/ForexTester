import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { HistoryService } from '../backend/src/history.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { cacheDirectory } from '../backend/src/projectPaths.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share')
await mkdir(dataHome, { recursive: true })
const directory = await mkdtemp(join(dataHome, 'forextester-cache-reuse-verification-'))
const cache = cacheDirectory()
const source = await new HistoryService(undefined, join(cache, 'databento')).readCached('2023-12-02', '2024-03-31')
const boundary = source.candles.findIndex((bar, index) => index > 0 && bar.timestamp >= Date.parse('2024-03-18') && bar.instrumentId !== source.candles[index - 1].instrumentId)
assert.ok(boundary > 5)
const replayStart = new Date(source.candles[boundary - 5].timestamp).toISOString().slice(0,16)
const evidence: any = { source: 'Authentic cached Databento 6E M1', isolatedSessionDirectory: directory, cacheDirectory: cache, replayStart, boundary: source.candles[boundary].timestamp,
  browserErrors: [], consoleErrors: [], paidApiCalls: 0, screenshots: [], timeframes: [], checks: {} }
const backendEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DATABENTO_')))
const guard = join(directory, 'provider-tripwire.mjs'), attempts = join(directory, 'provider-attempts.txt')
await writeFile(attempts, '')
await writeFile(guard, `import { appendFileSync } from 'node:fs'; const original = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.hostname.endsWith('databento.com')) { appendFileSync(${JSON.stringify(attempts)}, url.pathname + '\\n'); throw Error('Provider network disabled during zero-cost smoke test'); } return original(input, init); };`)
evidence.fingerprint = await historyFingerprint({ ...source, tradingFrom: '2024-01-01' })
evidence.contracts = source.contracts
evidence.candles = source.candles.length
evidence.startupCommand = 'npm run dev:backend'
evidence.apiKeyConfigured = false

let backend: ChildProcess | undefined
async function startBackend() {
  backend = spawn('npm', ['run', 'dev:backend'], { detached: true, env: { ...backendEnv, FOREXTESTER_DATA_DIR: join(directory, 'sessions'), PORT: '5195', NODE_OPTIONS: `--import=${guard}` }, stdio: 'ignore' })
  for (let i=0; i<100; i++) {
    try { if ((await fetch('http://127.0.0.1:5195/api/health')).ok) return } catch {}
    await new Promise(r=>setTimeout(r,100))
  }
  throw Error('Isolated backend did not start')
}
async function stopBackend() { if (backend && backend.exitCode === null) { const ended=once(backend,'exit');process.kill(-backend.pid!, 'SIGTERM');await ended } }
await startBackend()
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory,'vite'), optimizeDeps: { include: ['react','react-dom/client','lightweight-charts','technicalindicators'] }, server: { watch: null, hmr: false, host: '127.0.0.1', port: 5194, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5195', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ channel:'chromium', chromiumSandbox:true, env: backendEnv })
const page = await browser.newPage({ viewport: { width:1440, height:1000 } })
page.on('pageerror',e=>evidence.browserErrors.push(e.message))
page.on('console',message=>{if(message.type()==='error')evidence.consoleErrors.push({text:message.text(),location:message.location()})})
    const expectedProbes = new Set<string>()
    page.on('response', response => { if (response.request().method() === 'HEAD' && response.status() === 404 && response.headers()['x-storage-error-code'] === 'HISTORY_MISSING') expectedProbes.add(response.url()) })
page.on('request',r=>{if(new URL(r.url()).pathname==='/api/history/download') evidence.paidApiCalls++})
page.on('dialog',d=>d.accept())
await page.addInitScript('globalThis.__name = target => target; globalThis.__forexReplayPerformance = { samples: {}, counts: {} }')
const button = (name:string) => page.getByRole('button',{name,exact:true})
const saved = () => page.waitForFunction(()=>document.querySelector('.save-state')?.textContent === 'Saved', null, {timeout:30000})
async function screenshot(name:string) { const path=`docs/databento/cache-reuse-${name}.png`;await page.screenshot({path,fullPage:true});evidence.screenshots.push(path) }
async function sessions() { return (await (await fetch('http://127.0.0.1:5195/api/storage/sessions')).json()).sessions }
try {
  await page.goto('http://127.0.0.1:5194')
  await page.getByLabel('Backtest name',{exact:true}).fill('Databento rollover verification')
  await page.getByLabel('From',{exact:true}).fill('2024-01-01')
  await page.getByLabel('Through',{exact:true}).fill('2024-03-30')
  await page.getByLabel('Replay start (UTC)',{exact:true}).fill(replayStart)
  for (const [width,height] of [[1440,1000],[390,844]]) {
    await page.setViewportSize({width,height});await screenshot(`setup-${width}`)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)
  }
  await page.setViewportSize({width:1440,height:1000})
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled)
  const started=performance.now()
  await button('Load historical data').click()
  await page.locator('.data-ready').waitFor({timeout:30000}); await saved()
  evidence.loadAndStoreDurationMs=performance.now()-started
  assert.match(await page.locator('.data-ready').innerText(),/110,383/)
  assert.match(await page.locator('.cached-history-status').innerText(),/Fully cached/); assert.equal(await page.getByRole('dialog', {name:'Approve paid history download'}).count(), 0)
  evidence.quote = await (await fetch('http://127.0.0.1:5195/api/history/estimate?symbol=6E&from=2024-01-01&to=2024-03-31')).json()
  assert.equal(evidence.quote.estimatedUsd, 0); assert.equal(evidence.quote.cached, true)
  const loaded = await (await fetch('http://127.0.0.1:5195/api/history?symbol=6E&from=2023-12-02&to=2024-03-31')).json()
  assert.deepEqual(loaded, source)
  evidence.checks.exactOriginalOhlcvAndContracts = true
  assert.equal(await page.getByLabel('Backtest name',{exact:true}).inputValue(),'Databento rollover verification')
  assert.equal(await page.getByLabel('Replay start (UTC)',{exact:true}).inputValue(),replayStart)
  for (const [width,height] of [[1440,1000],[390,844]]) { await page.setViewportSize({width,height});await screenshot(`setup-cached-${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width) }
  await page.setViewportSize({width:1440,height:1000})
  await button('Start backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved()
  for (const tf of ['M1','M5','M15','H1','H4']) {
    await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption(tf)
    await page.waitForTimeout(100)
    assert.ok(await page.locator('.chart-canvas canvas').count()>0)
    evidence.timeframes.push(tf)
  }
  for (const count of [1,2,3]) { await page.locator(`input[name="chart-count"][value="${count}"]`).check();assert.equal(await page.locator('.chart-pane').count(),count) }
  await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('M1')
  await screenshot('trading-1440')
  await page.setViewportSize({width:390,height:844});await screenshot('trading-390');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390)
  await page.setViewportSize({width:1440,height:1000})
  const current=source.candles[boundary-5], stop=current.close-.01
  await button('Buy').click();await page.getByText('Enter price with keyboard',{exact:true}).click();await page.getByLabel('SL price',{exact:true}).fill(String(stop));await button('Confirm order').click()
  await saved();let record=(await sessions())[0];assert.equal(record.checkpoint.trading.pending.length,1)
  await button('Next Candle').click();await saved();record=(await sessions())[0]
  assert.equal(record.checkpoint.trading.positions[0].entryPrice,source.candles[boundary-4].open)
  evidence.checks.nextCandleEntry=true
  const positionId=record.checkpoint.trading.positions[0].id
  await page.getByLabel(`Close ${positionId}`,{exact:true}).click();await button('Next Candle').click();await saved();record=(await sessions())[0]
  assert.equal(record.checkpoint.trading.closed[0].exitPrice,source.candles[boundary-3].open)
  evidence.checks.manualClose=true
  // A short on the final old-contract bars remains frozen at rollover.
  await button('Sell').click();await page.getByText('Enter price with keyboard',{exact:true}).click();await page.getByLabel('SL price',{exact:true}).fill(String(source.candles[boundary-3].close+.01));await button('Confirm order').click()
  await button('Next Candle').click();await button('Next Candle').click();await saved()
  assert.match(await page.getByLabel('Replay status',{exact:true}).innerText(),/Rollover blocked/)
  assert.equal(await button('Next Candle').isDisabled(),true)
  record=(await sessions())[0]
  assert.equal(record.checkpoint.replay.timestamp,source.candles[boundary-1].timestamp)
  assert.equal(record.checkpoint.trading.positions.length,1)
  assert.equal(record.checkpoint.trading.closed.length,1)
  evidence.checks.rolloverBlockedWithPosition=true
  await screenshot('rollover-block')
  const before=JSON.stringify(record.checkpoint.trading)
  const savedState = (checkpoint:any) => ({ trading:checkpoint.trading, replay:checkpoint.replay, executionCursor:checkpoint.executionCursor, equity:checkpoint.equity })
  const beforeState = savedState(record.checkpoint)
  assert.equal(record.historyId, evidence.fingerprint)
  evidence.durableStorage = await (await fetch('http://127.0.0.1:5195/api/storage/status')).json()
  await page.reload();await button('Resume session').click();await saved()
  evidence.checks.refreshRestore=JSON.stringify((await sessions())[0].checkpoint.trading)===before
  assert.deepEqual(savedState((await sessions())[0].checkpoint), beforeState)
  await stopBackend();await startBackend()
  await page.reload();await button('Resume session').click();await saved()
  assert.equal(JSON.stringify((await sessions())[0].checkpoint.trading),before)
  assert.deepEqual(savedState((await sessions())[0].checkpoint), beforeState)
  evidence.checks.exactReplayEquityAndExecutionCursorRestored=true
  evidence.checks.backendRestartWithoutCredentials=true
  await button('Finish backtest').click();await page.getByLabel('Backtest results',{exact:true}).waitFor();await saved()
  await screenshot('results-1440')
  await page.setViewportSize({width:390,height:844});await screenshot('results-390');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390)
  evidence.providerNetworkAttempts = (await readFile(attempts, 'utf8')).trim()
  assert.equal(evidence.providerNetworkAttempts, ''); assert.equal(evidence.paidApiCalls,0);assert.deepEqual(evidence.browserErrors,[]); evidence.expectedMissingHistoryProbes = [...expectedProbes].map(url=>new URL(url).pathname); evidence.unexpectedConsoleErrors = evidence.consoleErrors.filter((error:any)=>!expectedProbes.has(error.location.url)); assert.deepEqual(evidence.unexpectedConsoleErrors,[])
  evidence.checks.restorePaidRequests=0
  console.log(JSON.stringify({checks:evidence.checks,paidApiCalls:evidence.paidApiCalls,browserErrors:evidence.browserErrors}))
} finally {
  await writeFile('docs/databento/cache-reuse-browser-verification.json',JSON.stringify(evidence,null,2)+'\n')
  await browser.close();await vite.close();await stopBackend()
}
