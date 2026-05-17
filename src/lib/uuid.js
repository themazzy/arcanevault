// RFC4122 v4 UUID from crypto.getRandomValues. Used as a polyfill for
// crypto.randomUUID, which is missing on:
//   - Android WebView < 92 (pre-July 2021)
//   - Browsers without secure-context (file://, http:// on non-localhost)
// In those environments the native randomUUID call throws synchronously,
// aborting card-row saves with no toast — so we install this as a global
// shim from src/main.jsx instead of touching every call site.
export function uuidV4() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10
  const hex = []
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'))
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  )
}

// Idempotent install — safe to call multiple times.
export function installRandomUUIDPolyfill() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return
  if (!globalThis.crypto) globalThis.crypto = {}
  globalThis.crypto.randomUUID = uuidV4
}
