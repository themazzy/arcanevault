// Two jobs, one vocabulary of rules:
//
// 1. evaluatePassword() drives the live checklist under the password fields, so a user
//    sees what is still missing while typing rather than after a failed submit.
// 2. describePasswordProblem() translates a Supabase rejection. Supabase spells out a
//    weak password by dumping the raw required character sets, e.g.
//      "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz,
//       ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789."
//    Those 26-character runs have no wrap opportunity, so they overflow whatever box they
//    are rendered in, and they read as noise rather than as instructions.
//
// The `ruleIds` it returns are the same ids evaluatePassword() understands, so a server
// rejection can promote its rules into the live checklist: the password policy is
// configured server-side and is not otherwise discoverable by the client.

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const UPPERCASE = LOWERCASE.toUpperCase()
const DIGITS = '0123456789'

export const DEFAULT_MIN_PASSWORD_LENGTH = 8

const RULES = {
  lowercase: { label: 'One lowercase letter (a–z)', charSet: LOWERCASE, test: (pw) => /[a-z]/.test(pw) },
  uppercase: { label: 'One uppercase letter (A–Z)', charSet: UPPERCASE, test: (pw) => /[A-Z]/.test(pw) },
  digit: { label: 'One number (0–9)', charSet: DIGITS, test: (pw) => /[0-9]/.test(pw) },
  symbol: { label: 'One symbol (for example ! ? @ #)', charSet: null, test: (pw) => /[^A-Za-z0-9]/.test(pw) },
}

// Order the checklist is rendered in.
export const CHARACTER_RULE_IDS = ['lowercase', 'uppercase', 'digit', 'symbol']

/**
 * Live state of every rule for the password being typed.
 *
 * @param {string} password
 * @param {object} [options]
 * @param {number} [options.minLength]
 * @param {string|null} [options.confirmation] second field's value, or null when there isn't one
 * @param {string[]} [options.requiredRuleIds] character rules the server has told us are mandatory
 * @returns {{ required: Array<{id,label,met}>, suggested: Array<{id,label,met}>, allRequiredMet: boolean }}
 */
export function evaluatePassword(password, { minLength = DEFAULT_MIN_PASSWORD_LENGTH, confirmation = null, requiredRuleIds = [] } = {}) {
  const pw = typeof password === 'string' ? password : ''
  const required = [{ id: 'length', label: `At least ${minLength} characters`, met: pw.length >= minLength }]
  const suggested = []

  for (const id of CHARACTER_RULE_IDS) {
    const item = { id, label: RULES[id].label, met: RULES[id].test(pw) }
    if (requiredRuleIds.includes(id)) required.push(item)
    else suggested.push(item)
  }

  if (confirmation !== null) {
    required.push({ id: 'match', label: 'Both passwords match', met: pw.length > 0 && pw === confirmation })
  }

  return { required, suggested, allRequiredMet: required.every((rule) => rule.met) }
}

const errorMessage = (error) => {
  if (typeof error === 'string') return error
  return typeof error?.message === 'string' ? error.message : ''
}

// The symbol set Supabase lists contains commas, so the message cannot be split on them.
// Instead, strip the known alphabets and see whether any punctuation is left over.
function requiresSymbol(required) {
  const leftovers = required
    .replace(LOWERCASE, '')
    .replace(UPPERCASE, '')
    .replace(DIGITS, '')
  return /[^\s,.a-z0-9]/i.test(leftovers)
}

/**
 * @returns {{ title: string, requirements: string[], ruleIds: string[], minLength: number|null } | null}
 *   null when the error is not about password strength — render it as plain text instead.
 */
export function describePasswordProblem(error, { minLength = DEFAULT_MIN_PASSWORD_LENGTH } = {}) {
  const message = errorMessage(error)
  if (!message) return null

  const reasons = Array.isArray(error?.reasons) ? error.reasons : []
  const requirements = []
  const ruleIds = []
  let requiredLength = null

  const lengthMatch = message.match(/at least (\d+) characters/i)
  if (lengthMatch) requiredLength = Number(lengthMatch[1])
  else if (reasons.includes('length')) requiredLength = minLength
  if (requiredLength) requirements.push(`At least ${requiredLength} characters`)

  const classMatch = message.match(/one character of each:\s*([^]*?)(?:\.\s*$|\.\s|$)/i)
  if (classMatch) {
    const requiredChars = classMatch[1]
    for (const id of CHARACTER_RULE_IDS) {
      const { charSet, label } = RULES[id]
      const needed = charSet ? requiredChars.includes(charSet) : requiresSymbol(requiredChars)
      if (needed) {
        requirements.push(label)
        ruleIds.push(id)
      }
    }
  } else if (reasons.includes('characters')) {
    requirements.push('A mix of letters, numbers and symbols')
  }

  if (reasons.includes('pwned') || /known to be weak/i.test(message)) {
    requirements.push('A password you have not reused — this one appears in a known data breach')
  }

  if (!requirements.length) return null

  return {
    title: 'That password does not meet the requirements. It needs:',
    requirements,
    ruleIds,
    minLength: requiredLength,
  }
}
