export function scheduleInitialCardSelection(
  initialCardName,
  selectCard,
  { schedule = setTimeout, cancel = clearTimeout } = {},
) {
  if (!initialCardName) return () => {}

  const timer = schedule(() => {
    void selectCard(initialCardName)
  }, 0)

  return () => cancel(timer)
}
