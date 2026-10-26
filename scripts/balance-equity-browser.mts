// Bundled production ResultsDashboard, isolated synthetic sessions, no API access.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, preview } from 'vite'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = 'docs/balance-equity', directory = await mkdtemp(join(tmpdir(), 'balance-equity-'))
const harness = await mkdtemp(join(resolve('frontend'), '.balance-equity-'))
await mkdir(output, { recursive: true })
await writeFile(join(harness, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><title>Balance & Equity verification</title></head><body><main id="root" class="app-shell phase-finished"></main><script type="module" src="./entry.tsx"></script></body></html>')
await writeFile(join(harness, 'entry.tsx'), `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ResultsDashboard } from '/src/ResultsDashboard.tsx';
  import { balanceEquityFixture } from '/@fs/${resolve('tests/balanceEquityFixture.ts')}';
  import { equityObservations } from '/src/equityDisplay.ts';
  import { equityPerformance } from '/src/resultsAnalytics.ts';
  import '/src/style.css';
  const root = createRoot(document.getElementById('root'));
  window.renderSession = (kind, detail = false) => {
    const fixture = balanceEquityFixture(kind, !detail);
    window.fixture = fixture;
    window.fixtureBefore = JSON.stringify(fixture);
    window.points = equityObservations(fixture.ledger);
    window.kpisBefore = JSON.stringify(equityPerformance(fixture.ledger, 10000));
    window.unchanged = () => JSON.stringify(fixture) === window.fixtureBefore && JSON.stringify(equityPerformance(fixture.ledger, 10000)) === window.kpisBefore;
    root.render(React.createElement(ResultsDashboard, { key: kind + detail, ...fixture, singlePrice: false, onSave: () => {}, onResume: () => {}, reviewOnly: false, resumeDisabled: false }));
  };
  window.renderSession('closed');
`)
await build({ configFile: false, root: 'frontend', logLevel: 'warn', build: { outDir: join(directory, 'dist'), emptyOutDir: true, rollupOptions: { input: join(harness, 'index.html') } } })
const server = await preview({ configFile: false, root: 'frontend', build: { outDir: join(directory, 'dist') }, preview: { host: '127.0.0.1', port: 5198, strictPort: true } })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
await page.addInitScript('globalThis.__name = target => target')
const evidence: any = { mode: 'Vite production bundle of unchanged production ResultsDashboard and synthetic engine/ledger sessions; no provider or persistence instantiated', screenshots: [], checks: [], errors: [], forbiddenRequests: [] }
page.on('pageerror', error => evidence.errors.push(error.message))
await page.route('**/*', route => {
  const url = new URL(route.request().url())
  if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) { evidence.forbiddenRequests.push(url.href); return route.abort() }
  return route.continue()
})
const account = page.locator('.results-account-chart'), timeline = account.locator('.results-timeline')
async function capture(name: string) {
  const path = `${output}/${name}.png`
  await account.screenshot({ path }); evidence.screenshots.push(path)
}
async function inspect(index: number) {
  await timeline.focus(); await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight')
  const result = await page.evaluate(index => {
    const p = (window as any).points[index]
    return { timestamp: p.timestamp, cash: p.cashUsd, equity: p.equityUsd,
      readout: document.querySelector('.results-chart-readout')!.textContent,
      times: [...document.querySelectorAll('.results-chart-readout time')].map(el => el.textContent) }
  }, index)
  assert.equal(result.times.length, 2); assert.equal(result.times[0], result.times[1])
  return result
}
try {
  await page.goto(`http://127.0.0.1:5198/${harness.split('/').at(-1)}/index.html`)
  await timeline.waitFor()
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 1100 })
    for (const kind of ['closed', 'open', 'missing', 'empty']) {
      await page.evaluate(kind => (window as any).renderSession(kind), kind)
      await page.waitForTimeout(100)
      const kpis = await page.locator('.results-primary-metrics').innerText()
      assert.deepEqual(await account.locator('.results-chart-legend span').allTextContents(), ['Balance', 'Equity'])
      const drawdownBefore = await page.locator('[aria-label="Drawdown Comparison"] path').evaluateAll(paths => paths.map(p => p.getAttribute('d')))
      for (const unit of ['percent', 'usd']) {
        await page.getByRole('button', { name: unit === 'percent' ? '%' : 'USD', exact: true }).click()
        const geometry = await timeline.evaluate(el => {
          const path = (cls: string) => el.querySelector<SVGPathElement>(cls)!
          const balance = path('.results-balance-line'), equity = path('.results-equity-line')
          const box = el.getBoundingClientRect()
          return { balance: balance.getAttribute('d')!, equity: equity.getAttribute('d')!,
            balanceStyle: { stroke: getComputedStyle(balance).stroke, width: parseFloat(getComputedStyle(balance).strokeWidth) },
            equityStyle: { stroke: getComputedStyle(equity).stroke, width: parseFloat(getComputedStyle(equity).strokeWidth) },
            width: box.width, viewWidth: (el as SVGSVGElement).viewBox.baseVal.width,
            invalid: [...el.querySelectorAll('path')].some(p => /NaN|Infinity/.test(p.getAttribute('d')!)) }
        })
        assert.ok(geometry.balance.length > 0); assert.ok(geometry.equity.length > 0)
        assert.ok(geometry.balanceStyle.width > geometry.equityStyle.width); assert.notEqual(geometry.balanceStyle.stroke, geometry.equityStyle.stroke)
        assert.equal(geometry.invalid, false); assert.ok(Math.abs(geometry.width - geometry.viewWidth) < 2)
        const index = kind === 'missing' ? 16 : kind === 'open' ? 20 : kind === 'empty' ? 5 : 45
        const readout = await inspect(index)
        assert.match(readout.readout!, /Balance \$/)
        if (kind === 'missing') assert.match(readout.readout!, /Equity N\/A \(N\/A\) · Floating PnL N\/A/)
        await capture(`${kind}-${unit}-${width}`)
        // Pointer inspection on an actual observation must match keyboard output.
        const box = (await timeline.boundingBox())!
        const ratio = await page.evaluate(index => { const points = (window as any).points; return (points[index].timestamp - points[0].timestamp) / (points.at(-1).timestamp - points[0].timestamp) }, index)
        await page.mouse.move(box.x + (80 + ratio * (geometry.viewWidth - 96)) / geometry.viewWidth * box.width, box.y + box.height / 2)
        assert.equal(await account.locator('.results-chart-readout').textContent(), readout.readout)
        assert.equal(await page.locator('.results-primary-metrics').innerText(), kpis)
        assert.deepEqual(await page.locator('[aria-label="Drawdown Comparison"] path').evaluateAll(paths => paths.map(p => p.getAttribute('d'))), drawdownBefore)
        assert.equal(await page.evaluate(() => (window as any).unchanged()), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        evidence.checks.push({ width, kind, unit, readout, geometry })
      }
      if (kind === 'closed') {
        // Recover overlap after the final close, then inspect diverging/crossing marks.
        for (const [name, index] of [['overlap', 60], ['divergence', 4], ['crossing', 11]] as const) {
          await inspect(index); await capture(`${name}-${width}`)
        }
      }
    }
    // A continuous M1 session makes execution steps, crossings and overlap
    // readable at full chart width alongside the market-closure checks above.
    for (const kind of ['closed', 'missing']) {
      await page.evaluate(kind => (window as any).renderSession(kind, true), kind)
      await page.waitForTimeout(100)
      for (const unit of ['percent', 'usd']) {
        await page.getByRole('button', { name: unit === 'percent' ? '%' : 'USD', exact: true }).click()
        const readout = await inspect(kind === 'missing' ? 16 : 30)
        await capture(`m1-${kind}-${unit}-${width}`)
        evidence.checks.push({ width, kind, unit, detail: true, readout })
      }
    }
  }
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.results-crosshair').count(), 0)
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.forbiddenRequests, [])
  await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ variants: evidence.checks.length, screenshots: evidence.screenshots.length, errors: evidence.errors, forbiddenRequests: evidence.forbiddenRequests }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
  await rm(harness, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true })
}
