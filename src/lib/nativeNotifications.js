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

let pluginPromise = null

function loadPlugin() {
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/local-notifications')
      .then(m => m.LocalNotifications)
      .catch(() => null)
  }
  return pluginPromise
}

/** True when system notifications are possible at all on this device. */
export function nativeNotificationsSupported() {
  return isNativeApp()
}

/**
 * Current permission, without prompting: 'granted' | 'denied' | 'prompt' |
 * 'unsupported'.
 *
 * Checked rather than assumed because Android 13 introduced a runtime prompt
 * for POST_NOTIFICATIONS, so an install that predates a grant is silently
 * unable to notify.
 */
export async function notificationPermission() {
  if (!nativeNotificationsSupported()) return 'unsupported'
  const plugin = await loadPlugin()
  if (!plugin) return 'unsupported'
  try {
    const { display } = await plugin.checkPermissions()
    return display || 'prompt'
  } catch {
    return 'unsupported'
  }
}

/** Prompts if it has not been asked yet. Returns the resulting state. */
export async function requestNotificationPermission() {
  if (!nativeNotificationsSupported()) return 'unsupported'
  const plugin = await loadPlugin()
  if (!plugin) return 'unsupported'
  try {
    const { display } = await plugin.requestPermissions()
    return display || 'denied'
  } catch {
    return 'denied'
  }
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
  const plugin = await loadPlugin()
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
