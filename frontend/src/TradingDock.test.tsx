// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TradingDock } from './TradingDock'
import type { useTrading } from './useTrading'
import { createTradingState, observeCandle, requestAutomaticEntry } from './trading'
import { stopOverlays } from './stopOverlays'
const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 }
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
 host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it.each(['buy', 'sell'] as const)('keeps compact %s identities, signed USD, styling and full action IDs', async direction => {
 let state = observeCandle({ ...createTradingState(), symbol: '6E' }, candle, undefined, 'single')
 for (const stop of direction === 'buy' ? [1.05,1.04] : [1.15,1.16]) state = requestAutomaticEntry(state,direction,{mode:'risk',riskPercent:1},stop,permission)
 const cancel=vi.fn(), close=vi.fn(), setDraft=vi.fn()
 const render=()=>act(async()=>root.render(<TradingDock trading={{state,permission,cancel,close} as unknown as ReturnType<typeof useTrading>} draft={null} setDraft={setDraft} stops={stopOverlays(state)} onConfirm={()=>{}}/>))
 await render()
 const identity=direction==='buy'?'B':'S'
 expect([...host.querySelectorAll('.active-positions > div')].map(el=>el.textContent)).toEqual([`Pending ${identity}11% riskCancel`,`Pending ${identity}21% riskCancel`])
 const pending=state.pending[1]
 await act(async()=>host.querySelector<HTMLButtonElement>(`[aria-label="Cancel entry ${pending.id}"]`)!.click())
 expect(cancel).toHaveBeenCalledExactlyOnceWith(pending.id)
 state=observeCandle(state,{...candle,timestamp:120000},undefined,'single')
 // Mark through a losing and a winning quote without changing position identity.
 for (const closePrice of [1.099,1.101]) {
  state={...state,quote:{priceModel:'single',trade:{...candle,close:closePrice}}}
  await render()
  const losing=direction==='buy'?closePrice<1.1:closePrice>1.1
  const records=[...host.querySelectorAll('.active-positions > div')]
  expect(records).toHaveLength(2)
  for (const [index,record] of records.entries()) {
   expect(record.querySelector('strong')!.textContent).toBe(`${identity}${index+1}`)
   expect(record.querySelector(losing?'.negative':'.positive')!.textContent).toMatch(losing?/^Est\. net -\$\d+\.\d{2} \(-\d+\.\d{2}%\)$/:/^Est\. net \$\d+\.\d{2} \(\d+\.\d{2}%\)$/)
   expect(record.textContent).not.toMatch(/SL|pips|Modify|Setup/)
   expect(record.querySelectorAll('details, summary')).toHaveLength(0)
   expect(record.querySelectorAll('button')).toHaveLength(1)
   expect(record.getAttribute('data-setup-id')).toBe(state.positions[index].setupId)
  }
 }
 const position=state.positions[0]
 await act(async()=>host.querySelector<HTMLButtonElement>(`[aria-label="Close ${position.id}"]`)!.click())
 expect(close).toHaveBeenCalledExactlyOnceWith(position.id); expect(setDraft).not.toHaveBeenCalled()
})
