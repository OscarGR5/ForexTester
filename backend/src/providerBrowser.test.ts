import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { projectRoot } from './projectPaths.js'
import { checkProviderBrowser } from './providerBrowser.js'
import { classifyHistoryError } from './historyCoverage.js'
it('selects the configured Linux browser while stripping upstream sandbox-disabling flags',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'forex-browser-wrapper-')),file=join(dir,'browser')
 try{
  await writeFile(file,'#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n');await chmod(file,0o700)
  const {stdout}=await promisify(execFile)(join(projectRoot,'scripts/provider-browser.sh'),['--no-sandbox','--disable-setuid-sandbox','--headless','--remote-debugging-pipe'],{env:{...process.env,DUKASCOPY_CHROME_PATH:file}})
  expect(stdout.trim().split('\n')).toEqual(['--headless','--remote-debugging-pipe'])
 }finally{await rm(dir,{recursive:true,force:true})}
})
it('classifies an actual failed browser launch separately from provider authorization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'forex-missing-browser-'))
 vi.stubEnv('DUKASCOPY_CHROME_PATH',join(dir,'missing-chromium'))
 try{
  for(let attempt=0;attempt<2;attempt++){
   const error=await checkProviderBrowser().catch(error=>error)
   expect(classifyHistoryError(error).code).toBe('BROWSER_UNAVAILABLE')
   expect(error.cause).toBeInstanceOf(Error)
  }
 }finally{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true})}
})
