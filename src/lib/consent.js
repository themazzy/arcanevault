const CONSENT_KEY = 'arcanevault_consent_v1'

export const CONSENT_CATEGORIES = {
  necessary: 'necessary',
  analytics: 'analytics',
  marketing: 'marketing',
  preferences: 'preferences',
}

export function getConsentPreferences() {
  try {
    const raw = localStorage.getItem(CONSENT_KEY)
    if (!raw) {
      return {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        updatedAt: null,
      }
    }
    const parsed = JSON.parse(raw)
    return {
      necessary: true,
      analytics: !!parsed.analytics,
      marketing: !!parsed.marketing,
      preferences: !!parsed.preferences,
      updatedAt: parsed.updatedAt || null,
    }
  } catch {
    return {
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      updatedAt: null,
    }
  }
}

export function saveConsentPreferences(patch) {
  const next = {
    ...getConsentPreferences(),
    ...patch,
    necessary: true,
    updatedAt: new Date().toISOString(),
  }
  localStorage.setItem(CONSENT_KEY, JSON.stringify(next))
  return next
}

export function hasConsent(category) {
  if (category === CONSENT_CATEGORIES.necessary) return true
  return !!getConsentPreferences()[category]
}

export function shouldShowConsentPrompt({ usesNonEssential = false } = {}) {
  if (!usesNonEssential) return false
  const prefs = getConsentPreferences()
  return !prefs.updatedAt
}
