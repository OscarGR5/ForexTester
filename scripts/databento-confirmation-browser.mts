// Every history endpoint in this runner is mocked. Real provider work is forbidden.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { HistoryService } from '../backend/src/history.js'
import { DatabentoClient } from '../backend/src/databento.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { fixtureHistory } from '../tests/databentoFixture.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'forextester-confirmation-'))
await mkdir(join(directory, 'cache'))
const backend = createApp(new HistoryService(new DatabentoClient(''), join(directory, 'cache')), undefined, new SessionStorage({directory: join(directory, 'sessions')}))
await new Promise<void>(resolve => backend.listen(5197, '127.0.0.1', resolve))
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'), optimizeDeps: { include: ['react','react-dom/client','lightweight-charts','technicalindicators'] }, server: { watch: null, hmr: false, host: '127.0.0.1', port: 5196, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5197', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
const report: any = { historyResponses: 'mocked only', paidBackendCalls: 0, checks: [], browserErrors: [], consoleErrors: [], screenshots: [] }
const expectedProbes = new Set<string>()
let realBackendHistoryCalls = 0
backend.on('request', req => { if (req.url?.startsWith('/api/history')) realBackendHistoryCalls++ })
try {
  for (const width of [1440, 1100]) {
    const context = await browser.newContext({ viewport: {width, height: width === 1100 ? 800 : 1000} })
    const page = await context.newPage()
    await page.addInitScript('globalThis.__name = target => target')
    page.on('pageerror', error => report.browserErrors.push(error.message))
    page.on('console', message => { if(message.type()==='error')report.consoleErrors.push({text:message.text(),location:message.location()}) })
    page.on('response', response => { if (response.request().method() === 'HEAD' && response.status() === 404 && response.headers()['x-storage-error-code'] === 'HISTORY_MISSING') expectedProbes.add(response.url()) })
    let state: 'cached' | 'partial' | 'empty' | 'blocked' = 'cached', paid = 0, quoteCount = 0, lastQuote: any
    const respond = (route: any, value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })
    await page.route('**/api/history/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/coverage')) return respond(route, { symbol:'6E', resolution:'M1', providerEarliestTimestamp:null,earliestSelectableDate:null,cachedFrom:'2023-12-10',cachedTo:'2024-01-11',cachedDates:32,latestEligibleDate:'2024-03-30',latestBoundaryProvisional:false,lastVerifiedAvailableDate:null,providerHealth:{status:'cache-validated'} })
      if (url.pathname.endsWith('/estimate')) {
        const tradingFrom = url.searchParams.get('from')!, to = url.searchParams.get('to')!
        const from = new Date(Date.parse(tradingFrom) - 30 * 86400000).toISOString().slice(0,10)
        lastQuote = { id:`mock-${++quoteCount}`, tradingFrom, from, to, cached:state==='cached', estimatedUsd:state==='cached'?0:.12345678,reservedUsd:state==='cached'?0:.24691356,remainingBudgetUsd:state==='blocked'?.01:4.19403091073,downloadAllowed:state!=='blocked',blockedReason:state==='blocked'?'The guarded estimate exceeds the remaining $0.010000 verification budget.':null,expiresAt:new Date(await page.evaluate(()=>Date.now())+5*60000).toISOString(),missingRanges:state==='cached'?[]:[{from:state==='partial'?tradingFrom:from,to}] }
        return respond(route,lastQuote)
      }
      if (url.pathname.endsWith('/download')) {
        paid++
        assert.deepEqual(route.request().postDataJSON(),{quoteId:lastQuote.id,confirm:true})
        await new Promise(resolve=>setTimeout(resolve,250))
        return respond(route,{...fixtureHistory(lastQuote.from,lastQuote.to),tradingFrom:lastQuote.tradingFrom})
      }
      throw Error(`Unexpected mocked endpoint ${url.pathname}`)
    })
    await page.route('**/api/history?*', route => { const url=new URL(route.request().url()); return respond(route,fixtureHistory(url.searchParams.get('from')!,url.searchParams.get('to')!)) })
    await page.goto('http://127.0.0.1:5196')
    const button=(name:string)=>page.getByRole('button',{name,exact:true})
    const load=async()=>{await button('Load historical data').click()}
    const dialog=page.getByRole('dialog',{name:'Approve paid history download'})
    const approve=()=>page.getByRole('button',{name:/^Approve paid download/})
    const acknowledge=()=>page.getByRole('checkbox',{name:'I understand that actual Databento billing can differ from this estimate.'})
    await page.getByText('Provider historical availability has not been verified.', {exact:false}).waitFor()
    assert.equal(await page.getByLabel('From',{exact:true}).getAttribute('min'),null)
    assert.equal(await page.getByText('Earliest advertised M1:',{exact:false}).count(),0)
    state='empty'
    await page.getByLabel('From',{exact:true}).fill('2022-01-03')
    await page.getByLabel('Through',{exact:true}).fill('2022-01-04')
    await load();await dialog.waitFor()
    assert.match(await dialog.innerText(),/2022-01-03 through 2022-01-04/)
    assert.match(await dialog.innerText(),/2021-12-04 through 2022-01-02/)
    await acknowledge().check();assert.equal(await approve().isEnabled(),true)
    await button('Cancel — No download').click();assert.equal(paid,0)
    report.checks.push(`${width}: unknown provider availability imposes no cache-derived minimum; earlier 2022 history reaches paid approval without downloading`)
    state='cached'
    await page.getByLabel('From',{exact:true}).fill('2024-01-09')
    await page.getByLabel('Through',{exact:true}).fill('2024-01-09')
    await load();await page.locator('.data-ready').waitFor()
    assert.equal(await dialog.count(),0);assert.equal(paid,0)
    report.checks.push(`${width}: fully cached loads without paid dialog or download`)
    state='partial';await load();await dialog.waitFor()
    assert.match(await dialog.innerText(),/30 calendar dates cached · 1 additional dates needed/)
    assert.equal(await approve().isDisabled(),true)
    assert.equal(await dialog.getByRole('heading',{name:'Approve paid history download'}).evaluate(el=>el===document.activeElement),true)
    await page.keyboard.press('Tab');assert.equal(await dialog.locator('summary').evaluate(el=>el===document.activeElement),true)
    await page.keyboard.press('Tab');assert.equal(await acknowledge().evaluate(el=>el===document.activeElement),true)
    await page.keyboard.press('Tab');assert.equal(await button('Cancel — No download').evaluate(el=>el===document.activeElement),true)
    await page.keyboard.press('Shift+Tab')
    await page.getByLabel('From',{exact:true}).evaluate(el=>(el as HTMLInputElement).focus())
    assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true)
    const snapshot=await dialog.ariaSnapshot()
    assert.match(snapshot,/dialog "Approve paid history download"/);assert.match(snapshot,/checkbox/)
    await dialog.getByText('Missing date ranges (1)',{exact:true}).click()
    assert.match(await dialog.locator('details').innerText(),/2024-01-09 through 2024-01-09/)
    const price=dialog.locator('.download-cost > strong')
    assert.ok(Number.parseFloat(await price.evaluate(el=>getComputedStyle(el).fontSize))>=30)
    await dialog.evaluate(el=>{el.scrollTop=0})
    const screenshot=`docs/databento/paid-confirmation-${width}.png`
    await page.screenshot({path:screenshot,fullPage:true});report.screenshots.push(screenshot)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(paid,0)
    report.checks.push(`${width}: cached/missing breakdown, ranges, prominent cost, labels, native focus trap, Escape and no overflow`)
    await load();await dialog.waitFor();await button('Cancel — No download').click();assert.equal(paid,0)
    report.checks.push(`${width}: cancel sends no paid request`)
    await load();await dialog.waitFor();await acknowledge().check();assert.equal(await approve().isEnabled(),true)
    await button('Cancel — No download').click()
    await page.getByLabel('From',{exact:true}).fill('2024-01-08')
    assert.equal(await dialog.count(),0)
    await load();await dialog.waitFor();assert.equal(await acknowledge().isChecked(),false);assert.match(await dialog.innerText(),/2024-01-08 through 2024-01-09/)
    await button('Cancel — No download').click()
    report.checks.push(`${width}: changed dates require a fresh quote and acknowledgement`)
    await page.clock.install()
    await load();await dialog.waitFor();await acknowledge().check();await page.clock.fastForward(5*60000+1000)
    await page.getByRole('alert').filter({hasText:'Quote expired.'}).waitFor();assert.equal(await approve().isDisabled(),true)
    await button('Cancel — No download').click()
    report.checks.push(`${width}: expired quote cannot be approved`)
    state='blocked';await load();await dialog.waitFor();await acknowledge().check();assert.equal(await approve().isDisabled(),true)
    assert.match(await dialog.innerText(),/exceeds the remaining.*verification budget/)
    await button('Cancel — No download').click();assert.equal(paid,0)
    report.checks.push(`${width}: insufficient budget has an actionable blocker`)
    state='empty';await load();await dialog.waitFor();assert.match(await dialog.innerText(),/No requested history cached/)
    assert.match(await dialog.innerText(),/0 calendar dates cached · 32 additional dates needed/)
    await acknowledge().check()
    await approve().evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click()})
    await page.locator('.data-ready').waitFor();await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved');assert.equal(paid,1)
    assert.equal(await page.locator('.critical-save').count(),0)
    report.checks.push(`${width}: acknowledgement gates approval; repeated clicks produce one mocked submission`)
    await context.close()
  }
  assert.equal(realBackendHistoryCalls,0);assert.deepEqual(report.browserErrors,[]);report.expectedMissingHistoryProbes = [...expectedProbes].map(url=>new URL(url).pathname); report.unexpectedConsoleErrors = report.consoleErrors.filter((error:any)=>!expectedProbes.has(error.location.url)); assert.deepEqual(report.unexpectedConsoleErrors,[])
  report.realBackendHistoryCalls=realBackendHistoryCalls
  console.log(JSON.stringify(report,null,2))
} finally {
  await writeFile('docs/databento/paid-confirmation-browser-verification.json',JSON.stringify(report,null,2)+'\n')
  await browser.close();await vite.close();await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()})
}
