// Email-link redemption helpers (password recovery + signup confirmation).
//
// The Supabase client runs flowType: 'pkce' (see src/lib/supabase.js) so that
// native OAuth works. The downside of PKCE is that the classic `?code=` email
// link can only be exchanged on the *same* browser that requested it (it needs
// the locally-stored code_verifier). When a recovery/confirmation email is
// opened on a different device — the normal case — that exchange fails and the
// app ends up with no session ("Auth session missing!" on updateUser).
//
// The fix is to redeem the link via verifyOtp({ token_hash, type }) instead.
// token_hash carries no code_verifier requirement, so the link works on any
// device. The matching email templates must point at:
//   {{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery
//
// These helpers are pure (they accept a location-like object) so the parsing is
// unit-testable without a DOM.

function paramsFrom(locationLike) {
  const search = locationLike?.search || ''
  const rawHash = locationLike?.hash || ''
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const h = new URLSearchParams(hash)
  // Prefer the query string (PKCE token_hash links), fall back to the hash
  // (legacy implicit-flow links).
  return { get: (key) => q.get(key) ?? h.get(key) }
}

// Parse an email-OTP redemption from the URL. Returns { tokenHash, type } when
// a token_hash link is present, otherwise null.
export function parseEmailOtpParams(locationLike) {
  const p = paramsFrom(locationLike)
  const tokenHash = p.get('token_hash')
  const type = p.get('type')
  if (!tokenHash || !type) return null
  return { tokenHash, type }
}

// True when the URL represents a password-recovery redirect, whether it arrived
// as a PKCE token_hash link (?type=recovery) or a legacy implicit hash
// (#type=recovery).
export function isRecoveryRedirect(locationLike) {
  return paramsFrom(locationLike).get('type') === 'recovery'
}

// Redeem a token_hash email link for a session. No-op-safe wrapper around
// verifyOtp so callers can stay declarative.
export function redeemEmailOtp(sb, { tokenHash, type }) {
  return sb.auth.verifyOtp({ type, token_hash: tokenHash })
}

// Strip sensitive OTP params from the address bar after redemption so a refresh
// or shared URL can't re-trigger verifyOtp (which would then fail as "already
// used") and the raw token isn't left visible. Recovery-mode persistence is
// handled separately via the localStorage pending flag, not the URL.
export function stripOtpParamsFromUrl(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win?.location || !win.history?.replaceState) return
  try {
    const url = new URL(win.location.href)
    let changed = false
    for (const key of ['token_hash', 'token', 'type']) {
      if (url.searchParams.has(key)) { url.searchParams.delete(key); changed = true }
    }
    if (changed) win.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // Best-effort cleanup; never block auth on a URL-parse failure.
  }
}
