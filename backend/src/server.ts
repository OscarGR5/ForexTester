import './environment.js'
import { createApp } from './app.js'
import { SessionStorage } from './sessionStorage.js'

const port = Number(process.env.PORT ?? 3001)

const storage = new SessionStorage()
const server = createApp(undefined, undefined, storage).listen(port, '127.0.0.1', () => {
  console.log(`ForexTester API listening on http://127.0.0.1:${port}`)
})

function shutdown() {
  server.close(() => { void storage.close().then(() => process.exit(0), () => process.exit(1)) })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
