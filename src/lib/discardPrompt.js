/**
 * Generic "are you sure you want to throw this away?" model, for dialogs whose
 * unsaved work is simple enough not to need wording of its own. Dialogs with
 * something specific to say keep their own model beside the feature —
 * `addCardDiscard.js`, `importDiscard.js`, `feedbackDiscard.js`.
 *
 * Note the deliberate narrowness: a confirm dialog is friction, and it only
 * earns that friction when closing would destroy work that cannot be rebuilt
 * from what is on screen. A dialog that persists as you go, or whose fields
 * save on blur, should use `closeOnOverlay={false}` instead — that stops the
 * accidental click without making every deliberate exit cost two clicks.
 *
 * @param {object}  o
 * @param {string}  o.subject  – what is being discarded, as an object phrase
 * @param {boolean} o.hasWork  – whether anything would actually be lost
 * @param {string}  [o.keepLabel]
 */
export function getDiscardModel({ subject, hasWork = false, keepLabel = 'Keep editing' } = {}) {
  if (!hasWork || !subject) return { needsConfirm: false }
  return {
    needsConfirm: true,
    message: `Discard ${subject}? It hasn't been saved.`,
    keepLabel,
    discardLabel: 'Discard',
    discardVariant: 'danger',
  }
}
