// Offline provider fixture behind the real local Node API. Never use real user storage.
import { createApp } from '../backend/src/app.ts'
if (!process.env.FOREXTESTER_DATA_DIR?.includes('forextester-browser-')) throw new Error('An isolated browser-test directory is required.')
const start = Date.UTC(2024, 0, 9)
createApp(async (config) => {
  const ask = config.priceType === 'ask' ? .0002 : 0
  return Array.from({ length: 240 }, (_, i) => ({ timestamp: start + i * 60000, open: 1.1 + i % 10 * .00001 + ask,
    high: 1.1008 + ask, low: 1.0995 + ask, close: 1.1001 + ask, volume: 1 }))
    .filter((bar) => bar.timestamp >= config.dates.from.getTime() && bar.timestamp < config.dates.to.getTime())
}).listen(3017, '127.0.0.1', () => console.log('ready'))
