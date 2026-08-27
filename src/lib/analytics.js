// Cloudflare Web Analytics beacon.
//
// Chosen over GA4/Plausible because it is free, already on the zone the domain
// is proxied through, and — the part that matters legally — entirely cookieless:
// it writes nothing to the device, so under GDPR/ePrivacy it needs no consent
// banner. That is why this deliberately does NOT gate on `src/lib/consent.js`'s
// `analytics` category: that flag defaults to false and no UI exists to grant
// it, so gating on it would silently disable the beacon forever. If a tracker
// that DOES store on the device is ever added, it must be gated there — this
// one genuinely doesn't need to be.
//
// Reports page views, referrers, countries and Core Web Vitals. It also picks
// up SPA route changes on its own, which is why it sees things zone-level
// analytics can't: at the edge, /collection -> /builder/x is not a request.

import { Capacitor } from '@capacitor/core'

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js'
const PROD_HOST = 'deckloom.app'

let injected = false

export function shouldLoadBeacon({ token, hostname, isNative }) {
  if (!token) return false
  // Native traffic is app usage, not web traffic, and would pollute the web
  // numbers. This MUST be a runtime check: capacitor.config.json sets
  // server.url to deckloom.app, so the native WebView loads the deployed web
  // bundle — where the build-time VITE_CAPACITOR flag is false and the hostname
  // is the production host. Both other guards therefore pass under Capacitor.
  if (isNative) return false
  // Never report dev servers, preview builds or *.github.io fallbacks.
  return hostname === PROD_HOST
}

function isNativePlatform() {
  try { return Capacitor.isNativePlatform() } catch { return false }
}

export function initAnalytics() {
  if (injected || typeof document === 'undefined') return false

  const token = import.meta.env.VITE_CF_BEACON_TOKEN
  const ok = shouldLoadBeacon({
    token,
    hostname: window.location.hostname,
    isNative: isNativePlatform(),
  })
  if (!ok) return false

  const script = document.createElement('script')
  script.defer = true
  script.src = BEACON_SRC
  script.setAttribute('data-cf-beacon', JSON.stringify({ token }))
  document.head.appendChild(script)
  injected = true
  return true
}
