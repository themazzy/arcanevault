import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadFxRates, convertCurrency } from './lib/fx'
import { injectFxConverter } from './lib/scryfall'

// Register Service Worker for image caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => reg.active?.postMessage('trim'))
      .catch(() => {})
  })
}

// Load FX rates and inject converter into scryfall.js
loadFxRates().then(() => {
  injectFxConverter(convertCurrency)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
