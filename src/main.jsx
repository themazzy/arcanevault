import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Capture recent console errors/warnings for bug reports
window.__arcaneErrors = []
const _origConsoleError = console.error.bind(console)
const _origConsoleWarn = console.warn.bind(console)
const _pushArcaneError = (level, args) => {
  window.__arcaneErrors.push({
    level,
    ts: new Date().toISOString(),
    msg: args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '),
  })
  if (window.__arcaneErrors.length > 20) window.__arcaneErrors.shift()
}
console.error = (...args) => { _pushArcaneError('error', args); _origConsoleError(...args) }
console.warn  = (...args) => { _pushArcaneError('warn',  args); _origConsoleWarn(...args)  }
window.addEventListener('error', e => _pushArcaneError('uncaught', [e.error || e.message]))
window.addEventListener('unhandledrejection', e => _pushArcaneError('unhandledrejection', [e.reason]))

// Register Service Worker for image caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => reg.active?.postMessage('trim'))
      .catch(() => {})
  })
}


createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
