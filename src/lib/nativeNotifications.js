import { Capacitor } from '@capacitor/core'
import { isNativeApp } from './nativeAuth'

/**
 * System notifications on the phone, via @capacitor/local-notifications.
 *
 * WHAT THIS DOES AND DOES NOT DO. These are raised by the app while it is
 * running or backgrounded — they land in the Android shade and stay there to be
 * tapped later, which is the point. They are NOT delivered while the app is
 * fully closed: that needs either FCM push or a periodic background task, and
 * neither exists yet.
 *
 * The plugin is imported lazily. The same JS bundle is served to the web (the
 * native WebView loads deckloom.app — see capacitor.config.json), so a
 * top-level import would pull plugin code into every browser session for a
 * feature only Android can use.
 */

const CHANNEL_ID = 'price_alerts'

let modulePromise = null

/**
 * Resolves to the MODULE, never to the plugin itself. A Capacitor plugin is a
 * Proxy that answers every property — `then` included — so resolving a promise
 * with it makes the promise treat it as a thenable and call `plugin.then()`.
 * That is not a native method, the call rejects where nobody is listening, and
 * the outer promise never settles. Every await on it hung: the permission check
 * never finished and tapping "Show on Phone" did nothing at all.
 */
function loadModule() {
  if (!modulePromise) {
    modulePromise = import('@capacitor/local-notifications').catch(() => null)
  }
  return modulePromise
}

/** True when system notifications are possible at all on this device. */
export function nativeNotificationsSupported() {
  return isNativeApp()
}

/**
 * True when the installed APK actually contains the native plugin.
 *
 * The WebView loads the deployed web bundle (server.url), so new JS reaches a
 * phone long before a new APK does. An APK built before the plugin was added
 * runs this code with no native side: every call rejects as "not implemented",
 * and without this check that rejection read as "denied" — the toggle showed
 * on, and once turned off could never be turned back on.
 */
function pluginInstalled() {
  try { return Capacitor.isPluginAvailable('LocalNotifications') } catch { return false }
}

/**
 * Collapses the plugin's PermissionState to the four cases the UI acts on.
 * 'prompt-with-rationale' (Android after one refusal) can still be asked.
 */
function normalizePermission(display, fallback) {
  if (display === 'granted' || display === 'denied') return display
  if (display === 'prompt' || display === 'prompt-with-rationale') return 'prompt'
  return fallback
}

/**
 * Current permission, without prompting: 'granted' | 'denied' | 'prompt' |
 * 'unavailable' (native app, but this APK has no plugin) | 'unsupported'.
 *
 * Checked rather than assumed because Android 13 introduced a runtime prompt
 * for POST_NOTIFICATIONS, so an install that predates a grant is silently
 * unable to notify.
 */
export async function notificationPermission() {
  if (!nativeNotificationsSupported()) return 'unsupported'
  if (!pluginInstalled()) return 'unavailable'
  const plugin = (await loadModule())?.LocalNotifications
  if (!plugin) return 'unavailable'
  try {
    const { display } = await plugin.checkPermissions()
    return normalizePermission(display, 'prompt')
  } catch {
    return 'unavailable'
  }
}

/**
 * Shows the Android prompt if it can still be shown. Returns the resulting
 * state; once Android has a permanent refusal it answers 'denied' without any
 * dialog, and only the system settings can undo that.
 */
export async function requestNotificationPermission() {
  if (!nativeNotificationsSupported()) return 'unsupported'
  if (!pluginInstalled()) return 'unavailable'
  const plugin = (await loadModule())?.LocalNotifications
  if (!plugin) return 'unavailable'
  try {
    const { display } = await plugin.requestPermissions()
    return normalizePermission(display, 'denied')
  } catch {
    return 'denied'
  }
}

/**
 * What the "Show on Phone" row shows, from our setting and the OS permission.
 *
 * On only when both agree. The setting defaults to true, so reading it alone
 * showed the row on for a fresh install that had never been asked and could
 * not notify — and tapping that "on" row turned the setting off instead of
 * asking. With the permission folded in, an un-asked install shows off, and the
 * tap that turns it on is the one that raises the prompt.
 */
export function phoneNotificationRow(enabled, permission) {
  const on = !!enabled && permission === 'granted'
  let description = 'Also raise price alerts as notifications on this device.'
  if (permission === 'denied') {
    description = 'Blocked in Android settings. Allow notifications for DeckLoom there, then come back here.'
  } else if (permission === 'unavailable') {
    description = 'This version of the app cannot post notifications. Install the latest APK to turn this on.'
  } else if (!on) {
    description = 'Also raise price alerts as notifications on this device. Android will ask for permission.'
  }
  return { on, description }
}

/**
 * Android needs a channel before anything can be posted to it, and the channel
 * carries the importance — a channel created at default importance can never be
 * promoted later without a new channel id, so it is created at HIGH once.
 */
async function ensureChannel(plugin) {
  if (!plugin.createChannel) return
  try {
    await plugin.createChannel({
      id: CHANNEL_ID,
      name: 'Price alerts',
      description: 'Cards in your collection that moved sharply in price',
      importance: 4,
      visibility: 1,
    })
  } catch {
    // Channel creation is iOS-absent and can fail on older Android; posting
    // still works on the default channel.
  }
}

/**
 * Raises one notification summarising a batch of price alerts.
 *
 * One notification, not one per card: a user holding several movers wants a
 * glanceable "three cards moved", not three separate buzzes. `extra` carries
 * the deep link so tapping it can open the right card when there is only one.
 */
export async function notifyPriceAlerts(alerts, { symbol = '€' } = {}) {
  if (!alerts?.length || !nativeNotificationsSupported()) return false
  const plugin = (await loadModule())?.LocalNotifications
  if (!plugin) return false

  const perm = await notificationPermission()
  if (perm !== 'granted') return false

  await ensureChannel(plugin)

  const [first] = alerts
  const rose = first.delta > 0
  const money = v => `${symbol}${Math.abs(v).toFixed(2)}`

  const title = alerts.length === 1
    ? `${first.name || 'A card you own'} ${rose ? 'rose' : 'fell'} ${Math.abs(first.pct).toFixed(0)}%`
    : `${alerts.length} cards moved in price`

  const body = alerts.length === 1
    ? `${rose ? 'Up' : 'Down'} to ${money(first.price_to)}${first.qty > 1 ? ` · ${first.qty} copies` : ''}`
    : alerts.slice(0, 3)
        .map(a => `${a.name}: ${a.delta > 0 ? '+' : '−'}${money(a.delta)}`)
        .join('\n')

  try {
    await plugin.schedule({
      notifications: [{
        // Stable per batch so a repeat on the same day replaces rather than
        // stacks. Android ids must be a 32-bit int.
        id: Math.abs(hashString(alerts.map(a => a.key).join('|'))) % 2147483647,
        channelId: CHANNEL_ID,
        title,
        body,
        smallIcon: 'ic_stat_icon_config_sample',
        extra: alerts.length === 1
          ? { scryfall_id: first.scryfall_id, finish: first.finish }
          : {},
      }],
    })
    return true
  } catch {
    return false
  }
}

/** Small, stable, non-cryptographic — only needs to be deterministic. */
function hashString(input) {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return hash
}
