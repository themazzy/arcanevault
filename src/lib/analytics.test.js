import { describe, expect, it } from 'vitest'
import { shouldLoadBeacon } from './analytics'

describe('shouldLoadBeacon', () => {
  const prod = { token: 'site-tag', hostname: 'deckloom.app', isNative: false }

  it('loads on the production host', () => {
    expect(shouldLoadBeacon(prod)).toBe(true)
  })

  it('does nothing without a site tag, so dev and forks stay silent', () => {
    expect(shouldLoadBeacon({ ...prod, token: '' })).toBe(false)
    expect(shouldLoadBeacon({ ...prod, token: undefined })).toBe(false)
  })

  it('never reports dev servers or preview hosts', () => {
    expect(shouldLoadBeacon({ ...prod, hostname: 'localhost' })).toBe(false)
    expect(shouldLoadBeacon({ ...prod, hostname: '127.0.0.1' })).toBe(false)
    expect(shouldLoadBeacon({ ...prod, hostname: 'themazzy.github.io' })).toBe(false)
  })

  it('excludes native — app usage is not web traffic', () => {
    // capacitor.config.json points server.url at deckloom.app, so the native
    // WebView loads the deployed web bundle: the hostname check passes and the
    // build-time VITE_CAPACITOR flag is false there. Only a runtime platform
    // check catches this, which is why isNative is passed in rather than read
    // from import.meta.env.
    expect(shouldLoadBeacon({ ...prod, isNative: true })).toBe(false)
  })
})
