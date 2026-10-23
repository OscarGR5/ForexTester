import { memo, useEffect, useId, useState } from 'react'
import { validateIndicatorSettings, type IndicatorSettings } from './indicators'

const FIELDS = {
  bollinger: [['length', 'Length'], ['stdDev', 'Std. deviation']],
  bollinger2: [['length', 'Length'], ['stdDev', 'Std. deviation']],
  stochastic: [['length', '%K length'], ['smoothK', '%K smoothing'], ['smoothD', '%D smoothing']],
  ichimoku: [['tenkan', 'Tenkan'], ['kijun', 'Kijun'], ['spanB', 'Span B'], ['displacement', 'Displacement']],
} as const
const NAMES = { bollinger: 'BB #1', bollinger2: 'BB #2', stochastic: 'Stochastic', ichimoku: 'Ichimoku' }
function Parameter({ label, ariaLabel, value, fractional, onChange }: { label: string; ariaLabel: string; value: number; fractional: boolean; onChange: (value: number) => void }) {
  const errorId = useId()
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setDraft(String(value)); setInvalid(false) }, [value])
  return <label className="indicator-parameter">{label}<input type="number" aria-label={ariaLabel} value={draft}
    min={fractional ? 0 : 1} max={fractional ? 100 : 10000} step={fractional ? 'any' : 1} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
    onChange={(event) => {
      const raw = event.target.value, next = Number(raw)
      const valid = raw !== '' && Number.isFinite(next) && next > 0 && next <= (fractional ? 100 : 10000) && (fractional || Number.isInteger(next))
      setDraft(raw); setInvalid(!valid)
      if (valid) onChange(next)
    }} />{invalid && <span id={errorId} className="parameter-error">{fractional ? 'Use > 0 to 100.' : 'Use 1–10000, whole numbers.'} Last valid value is applied.</span>}</label>
}
export const IndicatorControls = memo(function IndicatorControls({ id, settings, onChange }: { id: number; settings: IndicatorSettings; onChange: (settings: IndicatorSettings) => void }) {
  const update = (next: IndicatorSettings) => { if (!validateIndicatorSettings(next)) onChange(next) }
  return <details className="indicator-controls"><summary>Indicators</summary>
    <div className="indicator-options" aria-label={`Chart ${id + 1} indicators`}>
      {(Object.keys(FIELDS) as (keyof typeof FIELDS)[]).map((group) => <fieldset key={group}>
        <legend><label><input type="checkbox" checked={settings[group].enabled} aria-label={`Chart ${id + 1} ${NAMES[group]}`}
          onChange={(event) => update({ ...settings, [group]: { ...settings[group], enabled: event.target.checked } })} />{NAMES[group]}</label></legend>
        {FIELDS[group].map(([key, label]) => <Parameter key={key} label={label} ariaLabel={`Chart ${id + 1} ${group === 'bollinger' || group === 'bollinger2' ? `${NAMES[group]} ` : ''}${label}`}
          value={(settings[group] as unknown as Record<string, number>)[key]} fractional={key === 'stdDev'}
          onChange={(value) => update({ ...settings, [group]: { ...settings[group], [key]: value } })} />)}
        {(group === 'bollinger' || group === 'bollinger2') && <>
          <p className="indicator-source">Source: Close · Basis: SMA</p>
          {(['basisVisible', 'upperVisible', 'lowerVisible'] as const).map((key) => <label key={key} className="indicator-visibility">
            <input type="checkbox" checked={settings[group][key]} aria-label={`Chart ${id + 1} ${NAMES[group]} ${key === 'basisVisible' ? 'Basis' : key === 'upperVisible' ? 'Upper' : 'Lower'}`}
              onChange={(event) => update({ ...settings, [group]: { ...settings[group], [key]: event.target.checked } })} />
            {key === 'basisVisible' ? 'Basis' : key === 'upperVisible' ? 'Upper' : 'Lower'}
          </label>)}
        </>}
      </fieldset>)}
    </div>
  </details>
})
