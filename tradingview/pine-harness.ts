import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import type { ChartCandle } from '../frontend/src/indicators'

export const pineSource = readFileSync(new URL('./untaken-highs-lows.pine', import.meta.url), 'utf8')
export interface Settings {
  showHighs: boolean; showLows: boolean; maxHighs: number; maxLows: number
  highColor: string; lowColor: string; lineWidth: number
}
export interface Ray {
  x1: number; y1: number; x2: number; y2: number; xloc: string
  extend: string; color: string; style: string; width: number
}

// A deliberately small source adapter for THIS script, not a Pine compiler.
// Execute its actual statements with native JS numbers, mocked arrays/lines,
// and explicit close/rollback snapshots. TradingView must verify Pine semantics.
function expression(source: string): string {
  return source.replace(/\b(high|low)\[1\]/g, 'previous_$1')
    .replace(/array\.new<\w+>\(\)/g, 'array.new()')
    .replace(/\bna\(/g, 'isNa(').replace(/\bna\b/g, 'null')
    .replace(/\bint\(/g, 'Math.trunc(')
    .replace(/\band\b/g, '&&').replace(/\bnot\b/g, '!')
}

function adapt(source: string) {
  const initialize: string[] = [], body: string[] = [], stateNames: string[] = []
  const defaults: Record<string, unknown> = {}, blocks: number[] = []
  for (const raw of source.split('\n')) {
    const code = raw.trim()
    if (!code || code.startsWith('//')) continue
    if (/^indicator\(/.test(code)) continue
    const input = code.match(/^(?:bool|int|color) (\w+) = input\.(?:bool|int|color)\((true|false|\d+|#[\da-f]+), /i)
    if (input) {
      defaults[input[1]] = input[2].startsWith('#') ? input[2] : JSON.parse(input[2])
      continue
    }
    const fn = code.match(/^(\w+)\((.*)\) => (.+)$/)
    if (fn) {
      initialize.push(`function ${fn[1]}(${fn[2].replace(/\bfloat /g, '')}) { return ${expression(fn[3])}; }`)
      continue
    }
    const persistent = code.match(/^var (?:array<\w+>|float|int) (\w+) = (.+)$/)
    if (persistent) {
      stateNames.push(persistent[1])
      initialize.push(`var ${persistent[1]} = ${expression(persistent[2])};`)
      continue
    }
    const indent = raw.length - raw.trimStart().length
    while (blocks.length && indent < blocks.at(-1)!) { body.push('}'); blocks.pop() }
    if (indent !== (blocks.at(-1) ?? 0)) throw new Error(`Unsupported indentation: ${raw}`)
    const block = code.match(/^(if|while) (.+)$/)
    if (block) {
      body.push(`${block[1]} (${expression(block[2])}) {`)
      blocks.push(indent + 4)
    } else if (/^(?:float|int) \w+ = /.test(code)) {
      body.push(expression(code.replace(/^(?:float|int) /, 'let ')) + ';')
    } else if (/^\w+ (?::=|\+=|-=) /.test(code) || /^(?:array\.(?:push|pop)|line\.delete)\(/.test(code)) {
      body.push(expression(code.replace(':=', '=')) + ';')
    } else {
      throw new Error(`Unsupported Pine statement: ${raw}`)
    }
  }
  while (blocks.length) { body.push('}'); blocks.pop() }
  return { initialize: new Script(initialize.join('\n')), execute: new Script(`(function() {\n${body.join('\n')}\n})()`), stateNames, defaults }
}

const program = adapt(pineSource)
function checked<T>(values: T[], index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error(`Array index ${index}/${values.length}`)
  return values[index]
}

export class PineHarness {
  readonly settings: Settings
  private drawings = new Map<number, Ray>()
  private nextId = 0
  private context
  private committed
  peakLineCount = 0

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...program.defaults, ...settings } as unknown as Settings
    this.context = createContext({
      ...this.settings, Math, math: Math, isNa: (value: unknown) => value === null,
      xloc: { bar_time: 'bar_time' }, extend: { right: 'right' },
      array: {
        new: () => [], size: (a: unknown[]) => a.length,
        get: checked, last: (a: unknown[]) => checked(a, a.length - 1),
        pop: (a: unknown[]) => { checked(a, a.length - 1); return a.pop() },
        push: (a: unknown[], value: unknown) => { if (a.length >= 100_000) throw new Error('Array limit'); a.push(value) },
      },
      line: {
        style_solid: 'solid',
        new: (x1: number, y1: number, x2: number, y2: number, xloc: string, extend: string, color: string, style: string, width: number) => {
          if (this.drawings.size >= 500) throw new Error('Line limit exceeded before deletion')
          this.drawings.set(++this.nextId, { x1, y1, x2, y2, xloc, extend, color, style, width })
          this.peakLineCount = Math.max(this.peakLineCount, this.drawings.size)
          return this.nextId
        },
        delete: (id: number) => { if (!this.drawings.delete(id)) throw new Error(`Unknown line ${id}`) },
      },
    })
    program.initialize.runInContext(this.context)
    this.committed = this.snapshot()
  }

  private snapshot() {
    return structuredClone({ state: Object.fromEntries(program.stateNames.map(name => [name, this.context[name]])), drawings: this.drawings, nextId: this.nextId })
  }

  execute(candle: ChartCandle, index: number, previous: ChartCandle | undefined, confirmed: boolean, last = true): Ray[] {
    const rollback = structuredClone(this.committed)
    Object.assign(this.context, rollback.state, {
      high: candle.high, low: candle.low, close: candle.close, time: Number(candle.time) * 1000, time_close: Number(candle.time) * 1000 + 60_000,
      previous_high: previous?.high ?? null, previous_low: previous?.low ?? null,
      bar_index: index, barstate: { isconfirmed: confirmed, islast: last },
    })
    this.drawings = rollback.drawings; this.nextId = rollback.nextId
    program.execute.runInContext(this.context, { timeout: 1000 })
    if (confirmed) this.committed = this.snapshot()
    return (this.context.rays as number[]).map(id => this.drawings.get(id)!)
  }

  get state() { return this.snapshot().state }
}
