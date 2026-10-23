import { expect, it } from 'vitest'
import { historyRequestBody } from './historyRequestBody'
import { sessionHistory } from './sessionFixtures'

it.each([0, 2, 4097])('encodes %s candles without losing side membership or metadata', async (count) => {
  const history = sessionHistory(count)
  history.ask = history.ask.slice(0, Math.max(0, count - 1))
  expect(JSON.parse(await (await historyRequestBody(history)).text())).toEqual(history)
})

it('rejects noncanonical historical date bounds before hashing or storage', async () => {
  const { validatedHistory } = await import('./sessionCodec')
  expect(() => validatedHistory({ ...sessionHistory(2), from: '2023-12-02T00:00:00Z' })).toThrow('corrupt')
})
