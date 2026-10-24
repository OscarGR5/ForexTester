import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let checked: { path: string; promise: Promise<void> } | null = null
// Match the provider's own Playwright version. A successful sandboxed launch is
// cached for this backend process; failures remain retryable after local setup.
export function checkProviderBrowser(): Promise<void> {
  const providerRequire = createRequire(require.resolve('dukascopy-node'))
  const { chromium } = providerRequire('playwright-core') as { chromium: {
    executablePath(): string
    launch(options: { executablePath: string; headless: boolean; chromiumSandbox: boolean }): Promise<{ close(): Promise<void> }>
  } }
  const path = process.env.DUKASCOPY_CHROME_PATH || chromium.executablePath()
  if (checked?.path === path) return checked.promise
  const promise = chromium.launch({ executablePath: path, headless: true, chromiumSandbox: true })
    .then(browser => browser.close())
    .catch(error => {
      checked = null
      const message = error instanceof Error ? error.message : String(error)
      if (/shared libraries|\.so.*not found|Host system is missing dependencies/i.test(message)) throw new Error(`Browser system dependencies are missing. ${message}`)
      throw new Error(`Could not launch browser executable with sandbox enabled. ${message}`)
    })
  checked = { path, promise }
  return promise
}
