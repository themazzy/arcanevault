// Browsers only re-check the service worker script on navigation, throttled
// to roughly once per 24h — a tab left open for a while can sit on a stale
// deploy indefinitely. This forces `registration.update()` on a timer and
// whenever the tab regains focus, so `autoUpdate` (skipWaiting + clientsClaim
// in vite.config.js) actually gets a chance to kick in sooner. Silent by
// design, matching the app's existing no-prompt auto-update behavior.
const CHECK_INTERVAL_MS = 20 * 60 * 1000
const MIN_FOCUS_CHECK_GAP_MS = 5 * 60 * 1000

export function startServiceWorkerUpdateChecks() {
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.ready.then(registration => {
    let lastCheck = Date.now()
    const check = () => {
      lastCheck = Date.now()
      registration.update().catch(() => {})
    }

    setInterval(check, CHECK_INTERVAL_MS)

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck < MIN_FOCUS_CHECK_GAP_MS) return
      check()
    })
  }).catch(() => {})
}
