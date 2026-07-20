import { isNativeApp } from './nativeAuth'

export function shouldOfferCardScanner({
  native = isNativeApp(),
  matchMedia = typeof window !== 'undefined' ? window.matchMedia?.bind(window) : null,
} = {}) {
  if (native) return true
  return matchMedia?.('(pointer: coarse)').matches ?? false
}
