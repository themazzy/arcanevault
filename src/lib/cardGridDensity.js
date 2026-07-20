export const DEFAULT_CARD_GRID_DENSITY = 'comfortable'

export const GRID_IMG_BORDER_PX = 2
export const MOBILE_CARD_GRID_BREAKPOINT = 430
export const MOBILE_CARD_GRID_GAP = 8

// One shared density contract for every full-card grid. `px` is the rendered
// image width; the grid column also includes the image container's border.
export const CARD_GRID_DENSITY = {
  cozy: { px: 244, min: 210, desktopGap: 3, mobileCols: 1 },
  comfortable: { px: 146, min: 130, desktopGap: 2, mobileCols: 2 },
  compact: { px: 122, min: 112, desktopGap: 1, mobileCols: 3 },
}

export function getCardGridDensity(density) {
  return CARD_GRID_DENSITY[density] || CARD_GRID_DENSITY[DEFAULT_CARD_GRID_DENSITY]
}

export function gridColumnsForDensity(density) {
  const spec = getCardGridDensity(density)
  return `repeat(auto-fill, minmax(${spec.min}px, ${spec.px + GRID_IMG_BORDER_PX}px))`
}

export function getDesktopCardGridMetrics(containerWidth, density, { sideInset = 0 } = {}) {
  const spec = getCardGridDensity(density)
  const availableWidth = Math.max(0, containerWidth - sideInset * 2)
  const targetColumnWidth = spec.px + GRID_IMG_BORDER_PX
  const columnGap = spec.desktopGap
  const columns = Math.max(1, Math.round((availableWidth + columnGap) / (targetColumnWidth + columnGap)))
  const columnWidth = Math.max(1, (availableWidth - columnGap * (columns - 1)) / columns)

  return {
    columns,
    columnWidth,
    columnGap,
    imageWidth: Math.max(1, columnWidth - GRID_IMG_BORDER_PX),
  }
}
