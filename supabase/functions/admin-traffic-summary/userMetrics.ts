// Activation and retention rates.
//
// Kept separate from the handler so the denominators — the part that decides
// what the numbers mean — are pinned by tests rather than asserted in a comment.

export type UserTotals = {
  accounts?: number
  activated?: number
  returning?: number
  [key: string]: unknown
}

function percent(part: number, whole: number): number | null {
  // Null rather than 0: on a fresh install "0% came back" reads as a product
  // failure, when the truth is that there is nothing to measure yet. The UI
  // renders null as an em dash.
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.round((part / whole) * 100)
}

export function computeUserRates(totals: UserTotals | null | undefined) {
  const accounts = Number(totals?.accounts) || 0
  const activated = Number(totals?.activated) || 0
  const returning = Number(totals?.returning) || 0

  return {
    // Of everyone who signed up, how many ever created anything at all.
    activation_rate: percent(activated, accounts),
    // Of the people who actually started, how many came back on another day.
    //
    // Measured against `activated`, NOT against all accounts. Someone who
    // signed up and never opened anything has not churned from the product —
    // they never tried it. Folding them into the denominator conflates a
    // marketing problem with a retention problem, and the two need different
    // fixes.
    return_rate: percent(returning, activated),
  }
}
