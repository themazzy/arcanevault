/**
 * Copy model for the "you're about to throw away an import" dialog.
 *
 * Import modals hold the most expensive input in the app — a pasted decklist or
 * a CSV export, sometimes thousands of lines, sometimes with printings the user
 * corrected by hand. A stray click on the overlay used to discard all of it
 * with no prompt. Mirrors `addCardDiscard.js`; kept pure so the wording is
 * testable without mounting either modal.
 *
 * @param {object}  o
 * @param {boolean} o.reviewing – past the paste step: rows are matched and on screen
 * @param {number}  o.rowCount  – rows waiting to be imported
 * @param {boolean} o.hasText   – something pasted or typed but not parsed yet
 */
export function getImportDiscardModel({ reviewing = false, rowCount = 0, hasText = false } = {}) {
  if (reviewing) {
    return {
      needsConfirm: true,
      message: rowCount
        ? `Discard this import? ${rowCount} row${rowCount === 1 ? ' is' : 's are'} matched and ready, and nothing has been saved yet.`
        : 'Discard this import? Nothing has been saved yet.',
      keepLabel: 'Keep reviewing',
      discardLabel: 'Discard import',
      discardVariant: 'danger',
    }
  }

  if (hasText) {
    return {
      needsConfirm: true,
      message: "Discard the list you pasted? It hasn't been imported yet.",
      keepLabel: 'Keep editing',
      discardLabel: 'Discard',
      discardVariant: 'danger',
    }
  }

  return { needsConfirm: false }
}
