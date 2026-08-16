// Browsers only re-check the service worker script on navigation, throttled
// to roughly once per 24h — a tab left open for a while can sit on a stale
// deploy indefinitely. This forces `registration.update()` on a timer and
// whenever the tab regains focus, so `autoUpdate` (skipWaiting + clientsClaim
// in vite.config.js) actually gets a chance to kick in sooner. Silent by
// design, matching the app's existing no-prompt auto-update behavior.
const CHECK_INTERVAL_MS = 20 * 60 * 1000
const MIN_FOCUS_CHECK_GAP_MS = 5 * 60 * 1000

// Fired when a new build has taken control. Listened for in Layout, which
// turns it into a "Reload" toast.
//
// The silent auto-update is the reason this event has to exist. skipWaiting +
// clientsClaim swap the worker underneath a running page, but the JS already
// executing in that page is still the old build — so the app keeps behaving
// exactly as before while the user, reasonably, believes they have reloaded
// into the fix. There is no way to tell "not deployed" from "not fixed"
// without being told, and a single reload cannot resolve it either: the first
// one is what lets the new worker take over, and only a second one runs the
// new code.
export const SW_UPDATE_EVENT = 'av:sw-update-ready'

export function startServiceWorkerUpdateChecks() {
  if (!('serviceWorker' in navigator)) return

  const announce = () => window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT))

  // controllerchange fires when the new worker takes over an already-controlled
  // page. The controller guard matters: on a first-ever visit there is no
  // previous controller, and announcing "new version" for the build the user
  // just opened would be nonsense.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', announce, { once: true })
  }

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
