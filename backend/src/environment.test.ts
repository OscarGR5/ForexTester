import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import { build } from 'vite'
import { projectRoot } from './projectPaths.js'

const directories: string[] = []
const fileKey = 'test-only-file-key-never-a-provider-credential'
const explicitKey = 'test-only-explicit-key-never-a-provider-credential'
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'forextester-env-'))
  directories.push(root)
  return root
}

// Execute the actual startup source in isolated projects, without starting an API
// or instantiating a provider. Both source and compiled layouts use real root discovery.
async function startup(mode: 'development' | 'production', contents: string | null, overrides: NodeJS.ProcessEnv = {}, expectedKey: string | undefined = contents === null ? undefined : fileKey) {
  const root = await temporaryRoot(), cwd = join(root, 'elsewhere')
  await mkdir(cwd)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'forextester', workspaces: ['frontend', 'backend'], type: 'module' }))
  if (contents !== null) await writeFile(join(root, '.env'), contents)
  await writeFile(join(cwd, '.env'), 'DATABENTO_API_KEY=wrong-working-directory-key\nPORT=9999\n')
  const source = mode === 'development', directory = join(root, source ? 'backend/src' : 'backend/dist/backend/src')
  await mkdir(directory, { recursive: true })
  for (const name of ['server', 'environment', 'projectPaths']) {
    const text = await readFile(join(projectRoot, 'backend/src', `${name}.ts`), 'utf8')
    await writeFile(join(directory, `${name}.${source ? 'ts' : 'js'}`), source ? text : stripTypeScriptTypes(text))
  }
  await writeFile(join(directory, 'sessionStorage.js'), 'export class SessionStorage { async close() {} }')
  await writeFile(join(directory, 'app.js'), `export function createApp() {
    const key = process.env.DATABENTO_API_KEY;
    console.log(JSON.stringify({ keyMatches: key === ${JSON.stringify(expectedKey) ?? 'undefined'}, configured: !!key, dataDirectory: process.env.FOREXTESTER_DATA_DIR ?? null }));
    return { listen(port, host, callback) { console.log(JSON.stringify({ port, host })); callback(); return { close(callback) { callback() } } } };
  }`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DATABENTO_') && !key.startsWith('FOREXTESTER_') && !['PORT', 'NODE_OPTIONS', 'NODE_ENV'].includes(key)))
  const stdout = execFileSync(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), join(directory, `server.${source ? 'ts' : 'js'}`)], { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 })
  expect(stdout).not.toContain(fileKey)
  expect(stdout).not.toContain(explicitKey)
  expect(stdout).not.toContain('wrong-working-directory-key')
  return stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
}

for (const mode of ['development', 'production'] as const) {
  it(`${mode}: loads only the project-root file before creating backend services`, async () => {
    const [config, listener] = await startup(mode, `DATABENTO_API_KEY=${fileKey}\nPORT=43210\nFOREXTESTER_DATA_DIR=/tmp/from-file\n`)
    expect(config).toEqual({ keyMatches: true, configured: true, dataDirectory: '/tmp/from-file' })
    expect(listener).toEqual({ port: 43210, host: '127.0.0.1' })
  })
  it.each([explicitKey, ''])(`${mode}: preserves an explicitly provided key (%s), port and storage directory`, async key => {
    const [config, listener] = await startup(mode, `DATABENTO_API_KEY=${fileKey}\nPORT=43210\nFOREXTESTER_DATA_DIR=/tmp/from-file\n`, { DATABENTO_API_KEY: key, PORT: '43211', FOREXTESTER_DATA_DIR: '/tmp/explicit' }, key)
    expect(config).toEqual({ keyMatches: true, configured: !!key, dataDirectory: '/tmp/explicit' })
    expect(listener.port).toBe(43211)
  })
  it(`${mode}: starts without an environment file or credentials`, async () => {
    const [config, listener] = await startup(mode, null, {}, undefined)
    expect(config).toEqual({ keyMatches: true, configured: false, dataDirectory: null })
    expect(listener.port).toBe(3001)
  })
}

it('keeps private environment files ignored and the example credential-free', async () => {
  for (const path of ['.env', '.env.local', '.env.production', 'backend/.env', '.env.secret']) {
    // .env and .env.* are existing repository safeguards; do not stage fixtures.
    expect(execFileSync('git', ['check-ignore', '--no-index', path], { cwd: projectRoot, encoding: 'utf8' }).trim()).toBe(path)
  }
  const example = await readFile(join(projectRoot, '.env.example'), 'utf8')
  expect(example).toMatch(/^DATABENTO_API_KEY=$/m)
  expect(example).not.toMatch(/^VITE_/m)
  expect(execFileSync('git', ['ls-files', '--', '.env', '.env.*'], { cwd: projectRoot, encoding: 'utf8' }).trim()).toBe('.env.example')
})

it('excludes the project-root environment and API key from the real frontend build', async () => {
  const root = await temporaryRoot(), frontend = join(root, 'frontend')
  const { cp } = await import('node:fs/promises')
  await mkdir(frontend)
  for (const name of ['src', 'index.html', 'vite.config.ts', 'package.json']) await cp(join(projectRoot, 'frontend', name), join(frontend, name), { recursive: true })
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(join(root, '.env'), `DATABENTO_API_KEY=${fileKey}\nVITE_ROOT_ENV_MUST_NOT_LOAD=root-env-is-backend-only\n`)
  await build({ root: frontend, configFile: join(frontend, 'vite.config.ts'), logLevel: 'silent', plugins: [{ name: 'verify-backend-environment-boundary', configResolved(config) {
    expect(config.env).not.toHaveProperty('DATABENTO_API_KEY')
    expect(config.env).not.toHaveProperty('VITE_ROOT_ENV_MUST_NOT_LOAD')
  } }] })
  const assets = join(frontend, 'dist/assets')
  const output = (await Promise.all((await readdir(assets)).map(name => readFile(join(assets, name), 'utf8')))).join('\n')
  expect(output).not.toContain(fileKey)
  expect(output).not.toContain('root-env-is-backend-only')
  expect(output).not.toContain('DATABENTO_API_KEY')
  expect(output).not.toContain('loadEnvFile')
})
