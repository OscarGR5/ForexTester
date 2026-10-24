import { loadEnvFile } from 'node:process'
import { join } from 'node:path'
import { projectRoot } from './projectPaths.js'

// Backend startup only. Node preserves variables explicitly supplied by the caller.
try {
  loadEnvFile(join(projectRoot, '.env'))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
