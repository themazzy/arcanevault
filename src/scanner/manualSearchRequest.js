export function isCurrentManualSearchRequest({ mounted, activeRequestId, requestId }) {
  return mounted && activeRequestId === requestId
}
