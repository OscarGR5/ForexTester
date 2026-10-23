import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 3001)

createApp().listen(port, '127.0.0.1', () => {
  console.log(`ForexTester API listening on http://127.0.0.1:${port}`)
})
