export function getDiscardDialogModel({ queueCount = 0, hasProgress = false } = {}) {
  const hasQueuedCards = queueCount > 0
  const hasUnsavedWork = hasQueuedCards || hasProgress

  return {
    message: hasQueuedCards
      ? `Discard ${queueCount} queued card${queueCount !== 1 ? 's' : ''}? This can't be undone.`
      : hasProgress
        ? "Discard your in-progress card? This can't be undone."
        : 'Close without adding a card?',
    keepLabel: hasUnsavedWork ? 'Keep editing' : 'Cancel',
    discardLabel: hasQueuedCards ? 'Discard queue' : hasProgress ? 'Discard' : 'Close',
    discardVariant: hasUnsavedWork ? 'danger' : 'default',
  }
}
