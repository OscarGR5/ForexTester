import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Works from source and the compiled directory, including a source archive
// without .git. Shared validators change the compiler's output root.
let root = dirname(fileURLToPath(import.meta.url))
while (true) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; workspaces?: unknown }
    if (pkg.name === 'forextester' && Array.isArray(pkg.workspaces)) break
  } catch { /* Continue toward the workspace root. */ }
  const parent = dirname(root)
  if (parent === root) throw new Error('Cannot locate the ForexTester workspace package.json.')
  root = parent
}
export const projectRoot = root
