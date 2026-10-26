// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TradingDock, type StopDraft } from './TradingDock'
import type { useTrading } from './useTrading'
import { combinedOpenPnl, createTradingState, observeCandle, requestAutomaticEntry } from './trading'
import { stopOverlays } from './stopOverlays'
const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 }
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
 host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})

async function key(key = 'b', init: KeyboardEventInit = {}, target: EventTarget = window) {
 const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
 await act(async () => target.dispatchEvent(event))
 return event
}
it.each(['b', 'B', 's', 'S'])('activates the real button with %s and captures current risk without submitting', async letter => {
 const state = observeCandle(createTradingState(), candle, undefined, 'single'), setDraft = vi.fn()
 await act(async () => root.render(<StrictMode><TradingDock trading={{ state, permission } as ReturnType<typeof useTrading>} draft={null} setDraft={setDraft} stops={[]} onConfirm={vi.fn()}/></StrictMode>))
 const input = host.querySelector('input')!
 await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '.35')
  input.dispatchEvent(new Event('input', { bubbles: true }))
 })
 const button = host.querySelector<HTMLButtonElement>(letter.toLowerCase() === 'b' ? '.buy-button' : '.sell-button')!
 const click = vi.spyOn(button, 'click')
 expect((await key(letter)).defaultPrevented).toBe(true)
 expect(click).toHaveBeenCalledTimes(1)
 expect(setDraft).toHaveBeenCalledExactlyOnceWith({ direction: letter.toLowerCase() === 'b' ? 'buy' : 'sell', sizing: { mode: 'risk', riskPercent: .35 }, setupId: null, slot: 1, price: null })
 expect(state.pending).toHaveLength(0)
 expect(state.positions).toHaveLength(0)
 await act(async () => root.render(<span/>))
 expect((await key(letter)).defaultPrevented).toBe(false)
 expect(setDraft).toHaveBeenCalledTimes(1)
})
it('obeys native button and ancestor fieldset states, permission changes, drafts, review and busy guards', async () => {
 const state = observeCandle(createTradingState(), candle, undefined, 'single'), setDraft = vi.fn()
 let disabled = false, blocked = false, reviewing = false, draft: StopDraft | null = null, currentPermission = permission
 const render = () => act(async () => root.render(<StrictMode><fieldset disabled={disabled}><TradingDock trading={{ state, permission: currentPermission } as ReturnType<typeof useTrading>} draft={draft} reviewing={reviewing} shortcutsBlocked={blocked} setDraft={setDraft} stops={[]} onConfirm={vi.fn()}/></fieldset></StrictMode>))
 const ignored = async () => { for (const letter of ['b', 's']) expect((await key(letter)).defaultPrevented).toBe(false); expect(setDraft).not.toHaveBeenCalled() }
 disabled = true; await render(); await ignored()
 disabled = false; blocked = true; await render(); await ignored()
 blocked = false; reviewing = true; await render(); await ignored()
 reviewing = false; draft = { direction: 'buy', sizing: 1, setupId: null, slot: 1, price: null }; await render(); await ignored()
 draft = null
 for (const next of [{ ...permission, active: false }, { ...permission, playing: true }, { ...permission, hasFuture: false }]) {
  currentPermission = next; await render(); await ignored()
 }
 currentPermission = permission; await render()
 host.querySelector<HTMLButtonElement>('.buy-button')!.disabled = true
 expect((await key()).defaultPrevented).toBe(false)
 expect(setDraft).not.toHaveBeenCalled()
 expect((await key('s')).defaultPrevented).toBe(true)
})
it('ignores repeats, modifier combinations, composition, handled events and unrelated keys', async () => {
 const setDraft = vi.fn(), state = createTradingState()
 await act(async () => root.render(<TradingDock trading={{ state, permission } as ReturnType<typeof useTrading>} draft={null} setDraft={setDraft} stops={[]} onConfirm={vi.fn()}/>))
 for (const init of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
  for (const letter of ['b', 's']) expect((await key(letter, init)).defaultPrevented).toBe(false)
 }
 expect((await key('ArrowRight', { shiftKey: true })).defaultPrevented).toBe(false)
 const event = new KeyboardEvent('keydown', { key: 'b', cancelable: true }); event.preventDefault()
 await act(async () => window.dispatchEvent(event))
 expect(setDraft).not.toHaveBeenCalled()
})
it.each(['input', 'number', 'textarea', 'select', 'contenteditable'])('ignores %s editors from both the target and active element', async type => {
 const setDraft = vi.fn(), state = createTradingState()
 await act(async () => root.render(<TradingDock trading={{ state, permission } as ReturnType<typeof useTrading>} draft={null} setDraft={setDraft} stops={[]} onConfirm={vi.fn()}/>))
 const editor = document.createElement(type === 'number' ? 'input' : type === 'contenteditable' ? 'div' : type)
 if (type === 'number') (editor as HTMLInputElement).type = 'number'
 if (type === 'contenteditable') { editor.setAttribute('contenteditable', 'true'); editor.tabIndex = 0 }
 host.append(editor)
 expect((await key('b', {}, editor)).defaultPrevented).toBe(false)
 editor.focus()
 expect((await key('s')).defaultPrevented).toBe(false)
 expect(setDraft).not.toHaveBeenCalled()
})
it.each(['dialog', 'role-dialog', 'indicator-controls', 'execution-details', 'placing-stop', 'stop-selector'])('ignores shortcuts with %s open', async type => {
 const setDraft = vi.fn(), state = createTradingState()
 await act(async () => root.render(<TradingDock trading={{ state, permission } as ReturnType<typeof useTrading>} draft={null} setDraft={setDraft} stops={[]} onConfirm={vi.fn()}/>))
 const overlay = document.createElement(type === 'dialog' ? 'dialog' : 'div')
 overlay.className = type; overlay.setAttribute('open', '')
 if (type === 'role-dialog') overlay.setAttribute('role', 'dialog')
 host.append(overlay)
 for (const letter of ['b', 's']) expect((await key(letter)).defaultPrevented).toBe(false)
 expect(setDraft).not.toHaveBeenCalled()
})
it('shows the total to the right of records and updates unavailable, zero and hidden states', async () => {
 let state = observeCandle(createTradingState(), candle, undefined, 'single')
 const render = () => act(async () => root.render(<TradingDock trading={{ state, permission } as ReturnType<typeof useTrading>} draft={null} setDraft={vi.fn()} stops={stopOverlays(state)} onConfirm={vi.fn()}/>))
 await render(); expect(host.querySelector('.open-total')).toBeNull()
 state = requestAutomaticEntry(state, 'buy', .1, 1.05, permission)
 await render(); expect(host.querySelector('.open-total')).toBeNull()
 state = observeCandle(state, { ...candle, timestamp: 120000 }, undefined, 'single')
 await render()
 expect(host.querySelector('.active-positions')!.nextElementSibling).toBe(host.querySelector('.open-total'))
 expect(host.querySelector('.open-total')!.textContent).toBe('Open total-$0.70 (-0.00%)')
 expect(host.querySelector('.open-total .negative')).not.toBeNull()
 state = { ...state, quote: null }; await render()
 expect(host.querySelector('.open-total')!.textContent).toBe('Open totalPnL unavailable')
 expect(combinedOpenPnl(state)).toBeNull()
 state = { ...state, positions: [] }; await render(); expect(host.querySelector('.open-total')).toBeNull()
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

it('Close all calls close once per eligible position in deterministic ID order, excluding pending entries', async () => {
 let state = observeCandle(createTradingState(), candle, undefined, 'single')
 for (const stop of [1.05, 1.04]) state = requestAutomaticEntry(state, 'buy', .1, stop, permission)
 const close = vi.fn(), render = (currentPermission = permission, reviewing = false) => act(async () => root.render(<TradingDock trading={{state, permission: currentPermission, close} as unknown as ReturnType<typeof useTrading>} reviewing={reviewing} draft={null} setDraft={vi.fn()} stops={stopOverlays(state)} onConfirm={vi.fn()}/>))
 await render(); expect(host.querySelector('.close-all')).toBeNull()
 state = observeCandle(state, {...candle,timestamp:120000}, undefined, 'single')
 state = {...state, positions: [...state.positions].reverse()}
 await render(); await act(async () => host.querySelector<HTMLButtonElement>('.close-all')!.click())
 expect(close.mock.calls.map(([id]) => id)).toEqual(state.positions.map(p => p.id).sort())
 close.mockClear()
 state = {...state, positions: state.positions.map((p,i) => i ? p : {...p, closeRequestedAt:120000})}
 await render(); await act(async () => host.querySelector<HTMLButtonElement>('.close-all')!.click())
 expect(close).toHaveBeenCalledExactlyOnceWith(state.positions[1].id)
 for (const denied of [{...permission,active:false},{...permission,playing:true},{...permission,hasFuture:false}]) {
  await render(denied); expect(host.querySelector<HTMLButtonElement>('.close-all')!.disabled).toBe(true)
 }
 await render(permission, true); expect(host.querySelector('.close-all')).toBeNull()
 state = {...state, positions:state.positions.map(p=>({...p,closeRequestedAt:120000}))}
 await render(); expect(host.querySelector<HTMLButtonElement>('.close-all')!.disabled).toBe(true)
})
