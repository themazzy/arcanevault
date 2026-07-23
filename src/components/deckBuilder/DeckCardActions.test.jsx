// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeckCard } from './DeckCard'
import { DeckCardActionsMenuBody } from './DeckCardRow'

afterEach(cleanup)

const card = {
  id: 'deck-card-1',
  name: 'Sol Ring',
  qty: 2,
  board: 'main',
  foil: false,
}

function renderActions(overrides = {}) {
  const props = {
    dc: card,
    isEDH: true,
    formatId: 'commander',
    onSetCommander: vi.fn(),
    onToggleFoil: vi.fn(),
    onPickVersion: vi.fn(),
    onMoveBoard: vi.fn(),
    onOpenCategoryPicker: vi.fn(),
    onChangeQty: vi.fn(),
    onRemove: vi.fn(),
    close: vi.fn(),
    builderSfMap: {},
    ...overrides,
  }
  render(<DeckCardActionsMenuBody {...props} />)
  return props
}

describe('DeckCardActionsMenuBody', () => {
  it('provides named quantity controls', () => {
    const props = renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Decrease Sol Ring quantity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Sol Ring quantity' }))

    expect(props.onChangeQty).toHaveBeenNthCalledWith(1, card.id, -1)
    expect(props.onChangeQty).toHaveBeenNthCalledWith(2, card.id, 1)
  })

  it('offers named removal and closes before removing', () => {
    const order = []
    renderActions({
      close: vi.fn(() => order.push('close')),
      onRemove: vi.fn(() => order.push('remove')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sol Ring from deck' }))

    expect(order).toEqual(['close', 'remove'])
  })
})

function renderImageCard(view) {
  const props = {
    view,
    dc: card,
    legalityWarnings: [],
    warningTitle: '',
    isWarningTarget: false,
    canHover: false,
    lastInputWasTouch: true,
    priceLabel: '€1.00',
    ownership: { ownedQty: 0, ownedFoilAlt: 0, ownedAlt: 0, ownedInDeck: false, inCollDeck: false },
    isEDH: true,
    formatId: 'commander',
    builderSfMap: {},
    stackContext: { group: 'Artifacts', idx: 0 },
    stackHoverState: null,
    touchActiveStack: view === 'stacks' ? { group: 'Artifacts', stackIdx: 0, id: card.id } : null,
    setStackHoverState: vi.fn(),
    setTouchActiveStack: vi.fn(),
    onChangeQty: vi.fn(),
    onRemove: vi.fn(),
    onOpenDetail: vi.fn(),
    onContextMenu: vi.fn(),
    onDragStart: vi.fn(),
    onHoverEnter: vi.fn(),
    onHoverLeave: vi.fn(),
    onHoverMove: vi.fn(),
    onPickVersion: vi.fn(),
    onToggleFoil: vi.fn(),
    onSetCommander: vi.fn(),
    onMoveBoard: vi.fn(),
    onOpenCategoryPicker: vi.fn(),
  }
  render(<DeckCard {...props} />)
  return props
}

describe.each(['grid', 'stacks'])('DeckCard %s quantity controls', view => {
  it('keeps decrease and increase directly accessible', () => {
    const props = renderImageCard(view)

    fireEvent.click(screen.getByRole('button', { name: 'Decrease Sol Ring quantity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Sol Ring quantity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sol Ring from deck' }))

    expect(props.onChangeQty).toHaveBeenNthCalledWith(1, card.id, -1)
    expect(props.onChangeQty).toHaveBeenNthCalledWith(2, card.id, 1)
    expect(props.onRemove).toHaveBeenCalledWith(card.id)
    expect(props.onOpenDetail).not.toHaveBeenCalled()
  })
})
