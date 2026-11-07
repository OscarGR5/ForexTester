import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import type { ChartCandle } from '../frontend/src/indicators'

export const pineSource = readFileSync(new URL('./untaken-highs-lows.pine', import.meta.url), 'utf8')
export interface Settings {
  showHighs: boolean; showLows: boolean; maxHighs: number; maxLows: number
  showDaily: boolean; showWeekly: boolean
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
  return source.replace(/\b(high|low|time)\[(\d+)\]/g, 'history_$1_$2')
    .replace(/\btime\("(1D|1W)"\)/g, 'periodTime("$1")')
    .replace(/request\.security\(syminfo\.tickerid, "(1D|1W)", confirmedReferences\(\), lookahead = barmerge\.lookahead_on\)/g, 'request.security("$1")')
    .replace(/array\.new<\w+>\(\)/g, 'array.new()')
    .replace(/\bna\(/g, 'isNa(').replace(/\bna\b/g, 'null')
    .replace(/\bint\(/g, 'Math.trunc(')
    .replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!')
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
    const persistent = code.match(/^var (?:array<\w+>|float|int|bool|table) (\w+) = (.+)$/)
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
    } else if (/^(?:array<\w+>|float|int|bool|string) \w+ = /.test(code)) {
      body.push(expression(code.replace(/^(?:array<\w+>|float|int|bool|string) /, 'let ')) + ';')
    } else if (/^\[[\w, ]+\] = /.test(code)) {
      body.push('let ' + expression(code) + ';')
    } else if (code.startsWith('[')) {
      body.push('return ' + expression(code) + ';')
    } else if (/^\w+ (?::=|\+=|-=) /.test(code) || /^(?:array\.(?:push|pop)|line\.delete|table\.(?:cell|cell_set_text_color))\(/.test(code)) {
      body.push(expression(code.replace(':=', '=')) + ';')
    } else {
      throw new Error(`Unsupported Pine statement: ${raw}`)
    }
  }
  while (blocks.length) { body.push('}'); blocks.pop() }
  return { initialize: new Script(initialize.join('\n')), execute: new Script(`(function() {\n${body.join('\n')}\n})()`), stateNames, defaults }
}

// The request expression is executed in a separate modeled native-timeframe
// context. Preserve its actual source; do not replace it with a TS pivot model.
const referenceMatch = pineSource.match(/^confirmedReferences\(\) =>\n((?:(?:    .*|)\n)+)/m)
if (!referenceMatch) throw new Error('Missing native reference function')
const helpers = pineSource.split('\n').filter(line => /^\w+\(.*\) => .+/.test(line)).join('\n')
const referenceProgram = adapt(helpers + '\n' + referenceMatch[1].replace(/^    /gm, ''))
const program = adapt(pineSource.replace(referenceMatch[0], ''))
function checked<T>(values: T[], index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error(`Array index ${index}/${values.length}`)
  return values[index]
}

const arrayApi = {
  new: () => [], size: (a: unknown[]) => a.length, copy: (a: unknown[]) => a.slice(),
  get: checked, last: (a: unknown[]) => checked(a, a.length - 1),
  pop: (a: unknown[]) => { checked(a, a.length - 1); return a.pop() },
  push: (a: unknown[], value: unknown) => { if (a.length >= 100_000) throw new Error('Array limit'); a.push(value) },
}
export type ReferenceTimeframe = '1D' | '1W'
export type Feeds = Partial<Record<ReferenceTimeframe, readonly ChartCandle[]>>
export type ReferenceSnapshot = [number[], number[], number[], number[], number]

export function confirmedReferenceSnapshot(candles: readonly ChartCandle[], currentIndex: number): ReferenceSnapshot {
  const context = createContext({ Math, math: Math, isNa: (v: unknown) => v === null, array: arrayApi })
  referenceProgram.initialize.runInContext(context)
  let result: ReferenceSnapshot = [[], [], [], [], 0]
  for (let i = 0; i <= currentIndex; i++) {
    context.time = Number(candles[i].time) * 1000
    for (const offset of [1, 2]) {
      for (const field of ['high', 'low', 'time'] as const) {
        const value = candles[i - offset]?.[field]
        context[`history_${field}_${offset}`] = value === undefined ? null : Number(value) * (field === 'time' ? 1000 : 1)
      }
    }
    result = referenceProgram.execute.runInContext(context, { timeout: 1000 }) as ReferenceSnapshot
  }
  return structuredClone(result)
}

function seconds(tf: string): number {
  if (tf === '1D') return 86400
  if (tf === '1W') return 604800
  if (tf === '1M') return 30 * 86400
  if (!/^\d+$/.test(tf)) throw new Error(`Unsupported test timeframe ${tf}`)
  return Number(tf) * 60
}

function nativeIndex(candles: readonly ChartCandle[], timestamp: number): number {
  for (let i = candles.length - 1; i >= 0; i--) if (Number(candles[i].time) * 1000 <= timestamp) return i
  return -1
}

export class PineHarness {
  readonly settings: Settings
  private drawings = new Map<number, Ray>()
  private nextId = 0
  private context
  private committed
  peakLineCount = 0
  readonly requests: { timeframe: ReferenceTimeframe; time: number; lastClosedTime: number | null }[] = []

  constructor(settings: Partial<Settings> = {}, private chartTimeframe = '1', private feeds: Feeds = {}) {
    this.settings = { ...program.defaults, ...settings } as unknown as Settings
    this.context = createContext({
      ...this.settings, Math, math: Math, isNa: (value: unknown) => value === null,
      xloc: { bar_time: 'bar_time' }, extend: { right: 'right' },
      array: arrayApi,
      timeframe: {
        in_seconds: (tf = this.chartTimeframe) => seconds(tf),
        change: (tf: ReferenceTimeframe) => this.context.previousTime !== null && this.period(tf, this.context.time) !== this.period(tf, this.context.previousTime),
      },
      periodTime: (tf: ReferenceTimeframe) => this.period(tf, this.context.time),
      request: { security: (tf: ReferenceTimeframe) => {
        if (seconds(tf) <= seconds(this.chartTimeframe)) throw new Error('Unexpected equal/lower timeframe security request')
        const candles = this.feeds[tf] ?? []
        const index = nativeIndex(candles, this.context.time)
        this.requests.push({ timeframe: tf, time: this.context.time, lastClosedTime: index > 0 ? Number(candles[index - 1].time) * 1000 : null })
        return index < 0 ? [null, null, null, null, null] : confirmedReferenceSnapshot(candles, index)
      } },
      position: { top_right: 'top_right' }, chart: { fg_color: '#ffffff' },
      table: {
        new: () => ({ message: '' }),
        cell: (table: { message: string }, _col: number, _row: number, message: string) => { table.message = message },
        cell_set_text_color: () => {},
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

  private period(tf: ReferenceTimeframe, timestamp: number): number {
    const candles = this.feeds[tf] ?? []
    const candle = candles[nativeIndex(candles, timestamp)]
    if (candle) return Number(candle.time) * 1000
    const width = seconds(tf) * 1000, monday = tf === '1W' ? 4 * 86400_000 : 0
    return Math.floor((timestamp - monday) / width) * width + monday
  }

  private snapshot() {
    return structuredClone({ state: Object.fromEntries(program.stateNames.map(name => [name, this.context[name]])), drawings: this.drawings, nextId: this.nextId })
  }

  execute(candle: ChartCandle, index: number, previous: ChartCandle | undefined, confirmed: boolean, last = true, lastConfirmedHistory = false): Ray[] {
    const rollback = structuredClone(this.committed)
    Object.assign(this.context, rollback.state, {
      high: candle.high, low: candle.low, close: candle.close, time: Number(candle.time) * 1000, time_close: Number(candle.time) * 1000 + seconds(this.chartTimeframe) * 1000,
      history_high_1: previous?.high ?? null, history_low_1: previous?.low ?? null,
      previousTime: previous ? Number(previous.time) * 1000 : null,
      bar_index: index, barstate: { isfirst: index === 0, isconfirmed: confirmed, islast: last, islastconfirmedhistory: lastConfirmedHistory },
    })
    this.drawings = rollback.drawings; this.nextId = rollback.nextId
    program.execute.runInContext(this.context, { timeout: 1000 })
    if (confirmed) this.committed = this.snapshot()
    return (this.context.rays as number[]).map(id => this.drawings.get(id)!)
  }

  get state() { return this.snapshot().state }
  get message(): string { return this.context.referenceStatus.message }
}
