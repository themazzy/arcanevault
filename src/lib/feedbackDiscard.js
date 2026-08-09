/**
 * Copy model for the "you're about to throw away your feedback" dialog.
 *
 * A written bug report is the least reconstructable content in the app —
 * unlike a decklist or a card search, nothing on screen can rebuild it, and the
 * person writing one is by definition already having a bad time. A stray click
 * on the overlay used to bin it with no prompt.
 *
 * Mirrors `importDiscard.js` and `addCardDiscard.js`; kept pure so the wording
 * is testable without mounting the modal.
 *
 * @param {object}  o
 * @param {'bug'|'feature'} o.type
 * @param {boolean} o.hasDescription – the main body has been written
 * @param {boolean} o.hasContact     – optional contact details entered
 * @param {boolean} o.hasScreenshot  – a screenshot has been attached
 */
export function getFeedbackDiscardModel({
  type = 'bug',
  hasDescription = false,
  hasContact = false,
  hasScreenshot = false,
} = {}) {
  const noun = type === 'feature' ? 'feature request' : 'bug report'

  if (hasDescription) {
    return {
      needsConfirm: true,
      message: `Discard your ${noun}? It hasn't been sent.`,
      keepLabel: 'Keep writing',
      discardLabel: 'Discard',
      discardVariant: 'danger',
    }
  }

  // No body yet, but something was still done — attaching a screenshot is the
  // expensive half of a bug report, so losing it silently is the same mistake.
  if (hasScreenshot || hasContact) {
    return {
      needsConfirm: true,
      message: hasScreenshot
        ? "Discard the screenshot you attached? It hasn't been sent."
        : "Discard what you've entered? It hasn't been sent.",
      keepLabel: 'Keep writing',
      discardLabel: 'Discard',
      discardVariant: 'danger',
    }
  }

  return { needsConfirm: false }
}
