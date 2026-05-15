import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { sb } from './supabase'

export const NATIVE_OAUTH_REDIRECT = 'deckloom://auth/callback'

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() } catch { return false }
}

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
  await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
}

let registered = false

export function registerNativeAuthDeepLinkHandler() {
  if (registered || !isNativeApp()) return
  registered = true

  App.addListener('appUrlOpen', async ({ url }) => {
    if (!url || !url.startsWith('deckloom://auth/callback')) return

    try {
      const parsed = new URL(url)
      const code = parsed.searchParams.get('code')
      const errorDescription =
        parsed.searchParams.get('error_description') ||
        parsed.searchParams.get('error')

      if (errorDescription) {
        console.error('[nativeAuth] provider error:', errorDescription)
      } else if (code) {
        const { error } = await sb.auth.exchangeCodeForSession(url)
        if (error) console.error('[nativeAuth] exchangeCodeForSession failed:', error)
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
