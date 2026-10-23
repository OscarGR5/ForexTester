import { performanceSample } from './replayPerformance.js'
import { StrictMode, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {globalThis.__forexReplayPerformance ? <Profiler id="app" onRender={(_id, _phase, duration) => performanceSample('react.commit', duration)}><App /></Profiler> : <App />}
  </StrictMode>,
)
