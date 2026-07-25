import { describe, it, expect } from 'vitest'
import { SNAP_INSET, seatAtPoint, seatCentre } from './seatGeometry'
import { layoutsFor } from '../../lib/lifeGame'

// Build a tiled grid of cells the way the real layouts do: no gaps in the maths,
// so any point inside the grid falls in exactly one cell. That is precisely why a
// full-cell snap target misbehaved on diagonals.
function tile(cols, rows, width = 360, height = 300) {
  const w = width / cols
  const h = height / rows
  const rects = {}
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c
      const left = c * w
      const top = r * h
      rects[index] = { left, top, width: w, height: h, cx: left + w / 2, cy: top + h / 2 }
    }
  }
  return rects
}

// Sample a straight drag path and collect every seat it snaps to along the way.
function pathHits(rects, from, to, steps = 400) {
  const hits = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const hit = seatAtPoint(rects, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
    if (hit != null && hits[hits.length - 1] !== hit) hits.push(hit)
  }
  return hits
}

describe('seatAtPoint', () => {
  const rects = tile(2, 2)

  it('hits a seat at its centre', () => {
    expect(seatAtPoint(rects, rects[0].cx, rects[0].cy)).toBe(0)
    expect(seatAtPoint(rects, rects[3].cx, rects[3].cy)).toBe(3)
  })

  it('leaves the outer edge of a cell dead', () => {
    // Just inside cell 0's box, but outside its central region.
    expect(seatAtPoint(rects, 2, 2)).toBeNull()
    expect(seatAtPoint(rects, rects[0].cx, 2)).toBeNull()
  })

  it('accepts a generous area around the centre', () => {
    const r = rects[0]
    const padX = r.width * SNAP_INSET
    const padY = r.height * SNAP_INSET
    expect(seatAtPoint(rects, r.left + padX + 1, r.top + padY + 1)).toBe(0)
    expect(seatAtPoint(rects, r.left + r.width - padX - 1, r.top + r.height - padY - 1)).toBe(0)
    expect(seatAtPoint(rects, r.left + padX - 2, r.cy)).toBeNull()
  })

  it('returns null outside the grid and for junk coordinates', () => {
    expect(seatAtPoint(rects, -50, -50)).toBeNull()
    expect(seatAtPoint(rects, 9999, 9999)).toBeNull()
    expect(seatAtPoint(rects, NaN, 10)).toBeNull()
    expect(seatAtPoint(null, 10, 10)).toBeNull()
  })
})

describe('diagonal drags do not clip the seats in between', () => {
  it('2×2, corner to opposite corner: only the two endpoints', () => {
    const rects = tile(2, 2)
    expect(pathHits(rects, { x: rects[0].cx, y: rects[0].cy }, { x: rects[3].cx, y: rects[3].cy }))
      .toEqual([0, 3])
  })

  it('2×2, the other diagonal', () => {
    const rects = tile(2, 2)
    expect(pathHits(rects, { x: rects[1].cx, y: rects[1].cy }, { x: rects[2].cx, y: rects[2].cy }))
      .toEqual([1, 2])
  })

  it('3×2, top-left to bottom-right across the middle of the table', () => {
    const rects = tile(3, 2)
    expect(pathHits(rects, { x: rects[0].cx, y: rects[0].cy }, { x: rects[5].cx, y: rects[5].cy }))
      .toEqual([0, 5])
  })

  it('3×2, top-left to bottom-middle', () => {
    const rects = tile(3, 2)
    expect(pathHits(rects, { x: rects[0].cx, y: rects[0].cy }, { x: rects[4].cx, y: rects[4].cy }))
      .toEqual([0, 4])
  })

  it('2×3 portrait, top-left to bottom-right', () => {
    const rects = tile(2, 3)
    expect(pathHits(rects, { x: rects[0].cx, y: rects[0].cy }, { x: rects[5].cx, y: rects[5].cy }))
      .toEqual([0, 5])
  })

  it('tolerates a wandering finger, where a full-cell target would not', () => {
    // A real drag is never a perfect centre-to-centre line. This is the case the
    // bug was actually reported from: a diagonal that drifts off the ideal path.
    const rects = tile(2, 2)
    const from = { x: rects[0].cx, y: rects[0].cy }
    const to = { x: rects[3].cx, y: rects[3].cy }
    const wander = (t) => ({
      x: from.x + (to.x - from.x) * t + Math.sin(t * Math.PI) * 26,
      y: from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 14,
    })

    const walk = (inset) => {
      const hits = []
      for (let i = 0; i <= 400; i++) {
        const p = wander(i / 400)
        const hit = seatAtPoint(rects, p.x, p.y, inset)
        if (hit != null && hits[hits.length - 1] !== hit) hits.push(hit)
      }
      return hits
    }

    expect(walk(SNAP_INSET)).toEqual([0, 3])
    // inset 0 == the whole cell: the old behaviour, which snapped to seat 1 on the
    // way past.
    expect(walk(0)).toContain(1)
  })

  it('adjacent seats in a row still hand over directly, with no dead drag', () => {
    // Horizontal drags pass through the shared edge, so a brief gap between the two
    // regions is expected and fine — what matters is that nothing else is hit.
    const rects = tile(3, 2)
    expect(pathHits(rects, { x: rects[0].cx, y: rects[0].cy }, { x: rects[1].cx, y: rects[1].cy }))
      .toEqual([0, 1])
  })
})

// Every layout the app actually ships, derived from its grid-template-areas so the
// real cell aspect ratios are exercised. This is what stops SNAP_INSET being tuned
// back down: lowering it makes one of these fail.
describe('every shipped layout', () => {
  const layoutRects = (layout, width, height) => {
    const rows = layout.areas.trim().split('"').filter(s => s.trim()).map(s => s.trim().split(/\s+/))
    const cols = rows[0].length
    const cellW = width / cols
    const cellH = height / rows.length

    const rects = {}
    layout.seats.forEach((seat, index) => {
      let minC = Infinity; let maxC = -Infinity; let minR = Infinity; let maxR = -Infinity
      rows.forEach((row, r) => row.forEach((name, c) => {
        if (name !== seat.area) return
        minC = Math.min(minC, c); maxC = Math.max(maxC, c)
        minR = Math.min(minR, r); maxR = Math.max(maxR, r)
      }))
      const left = minC * cellW
      const top = minR * cellH
      const w = (maxC - minC + 1) * cellW
      const h = (maxR - minR + 1) * cellH
      rects[index] = { left, top, width: w, height: h, cx: left + w / 2, cy: top + h / 2 }
    })
    return rects
  }

  // A tall phone, a wide phone in landscape, and a squarer tablet.
  const viewports = [[380, 640], [700, 340], [760, 700]]

  for (let count = 2; count <= 6; count++) {
    for (const layout of layoutsFor(count)) {
      for (const [width, height] of viewports) {
        it(`${layout.id} at ${width}×${height}: a drag ends on what it is over`, () => {
          const rects = layoutRects(layout, width, height)
          for (let a = 0; a < count; a++) {
            for (let b = 0; b < count; b++) {
              if (a === b) continue
              const hits = pathHits(
                rects,
                { x: rects[a].cx, y: rects[a].cy },
                { x: rects[b].cx, y: rects[b].cy },
              )
              // Starts on the source and finishes on the target. Anything hit in
              // between is a seat genuinely dragged over — unavoidable when three
              // seats are collinear, and correct.
              expect(hits[0]).toBe(a)
              expect(hits[hits.length - 1]).toBe(b)
            }
          }
        })
      }
    }
  }

  it('never snaps to a seat a diagonal merely passes near', () => {
    // Restricted to the grids where no third seat centre lies on the segment.
    const cases = [
      [4, '4-table', 0, 3], [4, '4-table', 1, 2],
      [4, '4-handheld', 0, 3], [4, '4-handheld', 1, 2],
      [6, '6-handheld', 0, 5], [6, '6-handheld', 1, 4],
      [6, '6-table', 0, 5], [6, '6-table', 2, 3],
    ]
    for (const [count, id, a, b] of cases) {
      const layout = layoutsFor(count).find(l => l.id === id)
      for (const [width, height] of viewports) {
        const rects = layoutRects(layout, width, height)
        const hits = pathHits(rects, { x: rects[a].cx, y: rects[a].cy }, { x: rects[b].cx, y: rects[b].cy })
        expect(hits, `${id} ${width}×${height} ${a}→${b}`).toEqual([a, b])
      }
    }
  })
})

describe('seatCentre', () => {
  it('returns the measured centre', () => {
    const rects = tile(2, 2, 400, 200)
    expect(seatCentre(rects, 0)).toEqual({ x: 100, y: 50 })
    expect(seatCentre(rects, 3)).toEqual({ x: 300, y: 150 })
  })

  it('is null for an unknown seat', () => {
    expect(seatCentre(tile(2, 2), 9)).toBeNull()
    expect(seatCentre(null, 0)).toBeNull()
  })
})
