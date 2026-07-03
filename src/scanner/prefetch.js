/**
 * prefetch.js — idle-time warmup of scanner assets
 *
 * Called from the app shell (main.jsx) via requestIdleCallback, only for
 * devices that have opened the scanner before (localStorage flag set in
 * CardScanner) and not on Save-Data connections. Makes the next scanner
 * open effectively instant: hash-pack chunks → IndexedDB (skips ones
 * already cached).
 */

import { loadManifest, loadChunkBuffer } from './packLoader'

export const SCANNER_USED_KEY = 'arcanevault_scanner_used'

export async function maybePrefetchScannerAssets() {
  try {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(SCANNER_USED_KEY) !== '1') return
    if (navigator.connection?.saveData) return

    const resolved = await loadManifest({ timeoutMs: 10000 }).catch(() => null)
    if (!resolved) return
    for (const chunk of resolved.manifest.chunks) {
      await loadChunkBuffer(chunk, { hashVersion: resolved.manifest.hashVersion }).catch(() => {})
    }
  } catch { /* best-effort */ }
}
