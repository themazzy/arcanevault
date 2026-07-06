import { describe, it, expect, vi, beforeEach } from 'vitest'

// Test env is 'node' (see vite.config.js), which has no global `window`.
// nativeAuth.js dispatches its error event on `window`, so stub a minimal
// EventTarget-backed one for these tests to listen on.
if (typeof window === 'undefined') {
  globalThis.window = new EventTarget()
}

// Capture the appUrlOpen callback Capacitor would register, and spy on the
// supabase code exchange. Names are `mock`-prefixed so vitest's vi.mock hoisting
// allows referencing them inside the (hoisted) factories.
const mockExchangeCodeForSession = vi.fn()
const mockSignInWithOAuth = vi.fn()
let mockAppUrlOpenCb = null
let mockBrowserFinishedCb = null

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (name, cb) => {
      if (name === 'appUrlOpen') mockAppUrlOpenCb = cb
      return { remove: vi.fn() }
    },
  },
}))
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    addListener: (name, cb) => {
      if (name === 'browserFinished') mockBrowserFinishedCb = cb
      return { remove: vi.fn() }
    },
  },
}))
vi.mock('./supabase', () => ({
  sb: { auth: { exchangeCodeForSession: mockExchangeCodeForSession, signInWithOAuth: mockSignInWithOAuth } },
}))

describe('registerNativeAuthDeepLinkHandler', () => {
  beforeEach(() => {
    vi.resetModules() // resets the module-level `registered` guard
    mockAppUrlOpenCb = null
    mockBrowserFinishedCb = null
    mockExchangeCodeForSession.mockReset().mockResolvedValue({ error: null })
    mockSignInWithOAuth.mockReset().mockResolvedValue({ data: { url: 'https://provider/authorize' }, error: null })
  })

  it('exchanges the bare auth code, not the full deep-link URL', async () => {
    const { registerNativeAuthDeepLinkHandler } = await import('./nativeAuth')
    registerNativeAuthDeepLinkHandler()
    expect(mockAppUrlOpenCb).toBeTypeOf('function')

    await mockAppUrlOpenCb({ url: 'deckloom://auth/callback?code=XYZ123' })

    // The whole bug: it must pass 'XYZ123', not the full URL string.
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('XYZ123')
    expect(mockExchangeCodeForSession).not.toHaveBeenCalledWith(
      'deckloom://auth/callback?code=XYZ123',
    )
  })

  it('ignores deep links that are not the auth callback', async () => {
    const { registerNativeAuthDeepLinkHandler } = await import('./nativeAuth')
    registerNativeAuthDeepLinkHandler()

    await mockAppUrlOpenCb({ url: 'deckloom://something/else?code=ABC' })

    expect(mockExchangeCodeForSession).not.toHaveBeenCalled()
  })

  it('emits a native auth error if the in-app browser closes before the deep link arrives', async () => {
    const { registerNativeAuthDeepLinkHandler, openNativeOAuth, NATIVE_AUTH_ERROR_EVENT } = await import('./nativeAuth')
    registerNativeAuthDeepLinkHandler()
    expect(mockBrowserFinishedCb).toBeTypeOf('function')

    const onError = vi.fn()
    window.addEventListener(NATIVE_AUTH_ERROR_EVENT, onError)
    try {
      await openNativeOAuth('google')
      mockBrowserFinishedCb() // user backed out without completing the OAuth flow

      expect(onError).toHaveBeenCalledTimes(1)
      expect(mockExchangeCodeForSession).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(NATIVE_AUTH_ERROR_EVENT, onError)
    }
  })

  it('does not emit a native auth error when the browser closes normally after a successful deep link', async () => {
    const { registerNativeAuthDeepLinkHandler, openNativeOAuth, NATIVE_AUTH_ERROR_EVENT } = await import('./nativeAuth')
    registerNativeAuthDeepLinkHandler()

    const onError = vi.fn()
    window.addEventListener(NATIVE_AUTH_ERROR_EVENT, onError)
    try {
      await openNativeOAuth('google')
      await mockAppUrlOpenCb({ url: 'deckloom://auth/callback?code=XYZ123' })
      mockBrowserFinishedCb() // Browser.close() from the appUrlOpen handler triggers this too

      expect(onError).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(NATIVE_AUTH_ERROR_EVENT, onError)
    }
  })
})
