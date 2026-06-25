import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the appUrlOpen callback Capacitor would register, and spy on the
// supabase code exchange. Names are `mock`-prefixed so vitest's vi.mock hoisting
// allows referencing them inside the (hoisted) factories.
const mockExchangeCodeForSession = vi.fn()
let mockAppUrlOpenCb = null

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
  Browser: { open: vi.fn(), close: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('./supabase', () => ({
  sb: { auth: { exchangeCodeForSession: mockExchangeCodeForSession, signInWithOAuth: vi.fn() } },
}))

describe('registerNativeAuthDeepLinkHandler', () => {
  beforeEach(() => {
    vi.resetModules() // resets the module-level `registered` guard
    mockAppUrlOpenCb = null
    mockExchangeCodeForSession.mockReset().mockResolvedValue({ error: null })
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
})
