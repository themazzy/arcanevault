import { sb } from './supabase'

// The nickname doubles as the public profile URL segment (/profile/:username),
// so the charset is what survives a URL unescaped and still reads as a handle.
// 24 is the cap the Settings field has always enforced, and what
// generate_nickname is built to stay under (see nicknameGenerator.js).
export const NICKNAME_MAX_LENGTH = 24

const NICKNAME_RE = /^[a-zA-Z0-9_-]*$/

// Pure. Surrounding whitespace is not part of a handle and is trimmed away —
// pasting " Jane " should work. Whitespace INSIDE one is a real character and is
// rejected, so "jan mazanek" is an error rather than a silent "janmazanek".
// Everything else in this module trims too; keep them agreeing.
//
// `required` is true on both surfaces that edit a nickname. Every account is
// given one at signup (assign_default_user_settings), and the handle is the
// address a public profile, trade post, and follower links all resolve
// through — so there is no longer a state where clearing it means anything.
export function validateNickname(value = '', { required = false } = {}) {
  const trimmed = value.trim()
  if (!trimmed) {
    return required
      ? { ok: false, value: '', error: 'Pick a nickname — it is your profile address.' }
      : { ok: true, value: '', error: '' }
  }
  if (!NICKNAME_RE.test(trimmed)) {
    return { ok: false, value: trimmed, error: 'Only letters, numbers, hyphens, and underscores are allowed.' }
  }
  if (trimmed.length > NICKNAME_MAX_LENGTH) {
    return { ok: false, value: trimmed, error: `Keep it to ${NICKNAME_MAX_LENGTH} characters or fewer.` }
  }
  return { ok: true, value: trimmed, error: '' }
}

// Handles are case-insensitively unique (user_settings_lower_nickname_idx), so
// re-casing your own is not a change and must not be sent for an availability
// check — the RPC would report your own handle as taken.
export function isSameNickname(a = '', b = '') {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
}

// Throws on a failed lookup rather than answering false, so a caller can tell
// "this handle is taken" apart from "we could not reach the server" — the first
// is the user's problem to fix, the second is not.
export async function isNicknameAvailable(nickname, { client = sb } = {}) {
  const { data, error } = await client.rpc('is_username_available', { p_username: (nickname || '').trim() })
  if (error) throw error
  return data === true
}

// The unique index on user_settings.nickname. Nothing else a profile/settings
// update touches can collide, so a 23505 back from one means exactly one thing.
export function isNicknameTakenError(error) {
  return error?.code === '23505'
}

// The full pre-write guard, shared so the profile editor and Settings cannot
// drift into enforcing different rules: validate, skip the round trip when the
// handle is unchanged, then ask the server.
//
// `reason` separates the three ways this fails, because they need different
// words: 'invalid' is a rule the user broke, 'taken' is someone else's handle,
// 'unreachable' is not the user's fault at all and must not be reported as if
// the name were rejected.
export async function checkNicknameForSave(value, { current = '', client = sb } = {}) {
  const check = validateNickname(value, { required: true })
  if (!check.ok) return { ok: false, value: check.value, error: check.error, reason: 'invalid' }

  if (isSameNickname(check.value, current)) return { ok: true, value: check.value, changed: false }

  try {
    if (!await isNicknameAvailable(check.value, { client })) {
      return { ok: false, value: check.value, error: 'That nickname is taken.', reason: 'taken' }
    }
  } catch {
    return {
      ok: false, value: check.value, reason: 'unreachable',
      error: 'Could not check that nickname. Try again.',
    }
  }
  return { ok: true, value: check.value, changed: true }
}
