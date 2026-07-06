import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { sb } from './supabase'

export const NATIVE_OAUTH_REDIRECT = 'deckloom://auth/callback'

// Fired when a native OAuth round-trip fails (provider error, or the deep-link
// code exchange failed). The login UI listens for this to clear its spinner and
// show a message instead of hanging forever.
export const NATIVE_AUTH_ERROR_EVENT = 'deckloom:native-auth-error'

function emitNativeAuthError(message) {
  try {
    window.dispatchEvent(new CustomEvent(NATIVE_AUTH_ERROR_EVENT, { detail: message }))
  } catch { /* no-op outside a DOM */ }
}

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() } catch { return false }
}

// True while the in-app browser is open for an OAuth round-trip — cleared
// either by the deep-link callback firing or by the browser closing without
// one ever arriving (user backed out / dismissed it manually).
let oauthPending = false

export async function openNativeOAuth(provider) {
  const { data, error } = await sb.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: NATIVE_OAUTH_REDIRECT,
      skipBrowserRedirect: true,
    },
  })
  if (error) throw error
  if (!data?.url) throw new Error('No OAuth URL returned')
  oauthPending = true
  await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
}

let registered = false

export function registerNativeAuthDeepLinkHandler() {
  if (registered || !isNativeApp()) return
  registered = true

  // The user closed the in-app browser (back gesture / X) before the OAuth
  // provider ever redirected to our deep link. Without this, `oauthPending`
  // stays true and the login button's spinner never clears.
  Browser.addListener('browserFinished', () => {
    if (!oauthPending) return
    oauthPending = false
    emitNativeAuthError('Sign-in was cancelled.')
  })

  App.addListener('appUrlOpen', async ({ url }) => {
    if (!url || !url.startsWith('deckloom://auth/callback')) return
    oauthPending = false

    try {
      const parsed = new URL(url)
      const code = parsed.searchParams.get('code')
      const errorDescription =
        parsed.searchParams.get('error_description') ||
        parsed.searchParams.get('error')

      if (errorDescription) {
        console.error('[nativeAuth] provider error:', errorDescription)
        emitNativeAuthError(errorDescription)
      } else if (code) {
        // exchangeCodeForSession expects the bare auth code, NOT the full URL —
        // it sends the argument straight through as `auth_code`. Passing the
        // whole deep-link URL makes the server reject it (no matching flow
        // state), so the login silently never completes.
        const { error } = await sb.auth.exchangeCodeForSession(code)
        if (error) {
          console.error('[nativeAuth] exchangeCodeForSession failed:', error)
          emitNativeAuthError(error.message || 'Sign-in could not be completed.')
        }
      } else if (parsed.hash) {
        // Fallback for implicit-flow providers; let supabase-js parse the fragment.
        const fakeUrl = `${window.location.origin}/${parsed.hash}`
        try { window.history.replaceState(null, '', fakeUrl) } catch {}
      }
    } catch (err) {
      console.error('[nativeAuth] deep-link handling failed:', err)
    } finally {
      try { await Browser.close() } catch {}
    }
  })
}
