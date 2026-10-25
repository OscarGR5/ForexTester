// Production ResultsCharts with deterministic display fixtures. No session or provider access.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = 'docs/results-chart-continuity', directory = await mkdtemp(join(tmpdir(), 'results-continuity-'))
await mkdir(output, { recursive: true })
const harness = await mkdtemp(join(resolve('frontend'), '.continuity-'))
await writeFile(join(harness, 'entry.tsx'), `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ResultsCharts } from '/src/ResultsCharts.tsx';
  import { resultsContinuityFixture } from '/@fs/${resolve('tests/resultsContinuityFixture.ts')}';
  import { createEquityLedger } from '/src/equity.ts';
  const fixture = resultsContinuityFixture();
  window.fixtureBefore = JSON.stringify(fixture);
  window.fixture = fixture;
  const root = createRoot(document.getElementById('root'));
  window.renderFixture = (detail = false) => {
    const points = detail ? fixture.points.filter(p => p.timestamp >= Date.parse('2024-01-08T00:00Z') && p.timestamp <= Date.parse('2024-01-08T00:10Z')) : fixture.points;
    let ledger = createEquityLedger(10000);
    for (const point of points) ledger = { ...ledger, count: ledger.count + 1, tail: { point, previous: ledger.tail } };
    root.render(React.createElement(ResultsCharts, { ledger, positions: fixture.positions, referenceBalance: 10000, observations: [], start: points[0].timestamp, endpoint: points.at(-1).timestamp }));
  };
  window.renderFixture();
`)
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
  plugins: [{ name: 'continuity-fixture', configureServer(server) {
    server.middlewares.use('/continuity-fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head>
        <body><main id="root" style="padding:24px"></main>
        <script type="module" src="/@fs/${join(harness, 'entry.tsx')}"></script></body></html>`)
    })
  } }],
  server: { host: '127.0.0.1', port: 5197, strictPort: true, watch: null, hmr: false, fs: { allow: [resolve('.')] } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ??
  '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
const evidence: any = { screenshots: [], checks: [], errors: [], forbiddenRequests: [] }
page.on('pageerror', error => { evidence.errors.push(error.message); console.error(error.message) })
await page.route('**/*', route => {
  const url = new URL(route.request().url())
  if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) {
    evidence.forbiddenRequests.push(url.href); return route.abort()
  }
  return route.continue()
})
try {
  await page.goto('http://127.0.0.1:5197/continuity-fixture')
  await page.locator('.results-timeline').first().waitFor()
  for (const width of [1100, 1440]) for (const detail of [false, true]) {
    await page.setViewportSize({ width, height: 950 })
    await page.evaluate(detail => (window as any).renderFixture(detail), detail)
    await page.waitForTimeout(150)
    const originalUnit = await page.getByRole('button', { name: '%', exact: true }).getAttribute('aria-pressed')
    if (originalUnit !== 'true') await page.getByRole('button', { name: '%', exact: true }).click()
    for (const unit of ['percent', 'usd']) {
      if (unit === 'usd') await page.getByRole('button', { name: 'USD', exact: true }).click()
      const result = await page.locator('.results-timeline').evaluateAll(charts => charts.map(chart => {
        const paths = [...chart.querySelectorAll('path')].map(path => ({
          d: path.getAttribute('d') ?? '', bridge: path.classList.contains('results-gap-bridge'),
          dash: getComputedStyle(path).strokeDasharray, opacity: getComputedStyle(path).strokeOpacity,
        }))
        return { paths, axes: [...chart.querySelectorAll(':scope > text')].map(t => t.textContent),
          width: chart.getBoundingClientRect().width, viewWidth: (chart as SVGSVGElement).viewBox.baseVal.width }
      }))
      assert.deepEqual(result[0].axes, result[1].axes)
      if (!detail) assert.equal(result[0].axes[0], '2024-01-04')
      for (const chart of result) {
        assert.ok(Math.abs(chart.width - chart.viewWidth) < 2)
        for (let index = 0; index < chart.paths.length; index += 2) {
          const solid = chart.paths[index], bridge = chart.paths[index + 1]
          assert.equal((bridge.d.match(/L/g) ?? []).length, detail ? 2 : 4)
          assert.equal((solid.d.match(/L/g) ?? []).length + (bridge.d.match(/L/g) ?? []).length, detail ? 5 : 11)
          assert.ok(!/NaN|Infinity/.test(solid.d + bridge.d))
          assert.equal(solid.dash, 'none'); assert.equal(bridge.dash, '3px, 4px'); assert.equal(bridge.opacity, '0.65')
        }
      }
      await page.locator('.results-timeline').first().focus()
      await page.keyboard.press('End')
      const times = await page.locator('.results-chart-readout time').allTextContents()
      assert.equal(times.length, 2); assert.equal(times[0], times[1])
      await page.keyboard.press('ArrowLeft')
      assert.equal(await page.locator('.results-crosshair').count(), 2)
      await page.keyboard.press('Escape')
      await page.locator('.results-timeline').first().evaluate(el => (el as SVGElement).blur())
      const screenshot = `${output}/${detail ? 'm1-detail' : 'weekends'}-${unit}-${width}.png`
      await page.screenshot({ path: screenshot, fullPage: true })
      evidence.screenshots.push(screenshot)
      evidence.checks.push({ width, detail, unit, result })
    }
    // Pointer in an exposed weekend stays unavailable; flat weekend selects a real endpoint.
    if (!detail) {
      const chart = page.locator('.results-timeline').first(), box = (await chart.boundingBox())!
      const viewWidth = await chart.evaluate(el => (el as SVGSVGElement).viewBox.baseVal.width)
      for (const [date, count] of [['2024-01-06', 0], ['2024-01-13', 2]] as const) {
        const ratio = (Date.parse(date) - Date.parse('2024-01-04')) / (Date.parse('2024-01-15T00:01Z') - Date.parse('2024-01-04'))
        await page.mouse.move(box.x + (80 + ratio * (viewWidth - 96)) / viewWidth * box.width, box.y + 70)
        assert.equal(await page.locator('.results-chart-readout time').count(), count)
      }
    }
  }
  assert.equal(await page.evaluate(() => JSON.stringify((window as any).fixture) === (window as any).fixtureBefore), true)
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.forbiddenRequests, [])
  await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ variants: evidence.checks.length, screenshots: evidence.screenshots, errors: evidence.errors, forbiddenRequests: evidence.forbiddenRequests }, null, 2))
} finally {
  await browser.close(); await vite.close(); await rm(harness, { recursive: true, force: true })
}
