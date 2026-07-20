// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FILTERS, FilterBar } from './CardComponents'

afterEach(cleanup)

describe('FilterBar', () => {
  it('opens and closes its filters without recreating the chevron component', async () => {
    const user = userEvent.setup()
    render(
      <FilterBar
        search=""
        setSearch={vi.fn()}
        sort="name"
        setSort={vi.fn()}
        filters={{ ...EMPTY_FILTERS }}
        setFilters={vi.fn()}
        mode="lookup"
      />,
    )

    const toggle = screen.getByRole('button', { name: 'Filters' })
    await user.click(toggle)
    expect(screen.getByText('Colors')).toBeTruthy()

    await user.click(toggle)
    expect(screen.queryByText('Colors')).toBe(null)
  })

  it('shows Wishlist-relevant filters and omits owned-card fields', async () => {
    const user = userEvent.setup()
    render(
      <FilterBar
        search=""
        setSearch={vi.fn()}
        sort="name"
        setSort={vi.fn()}
        filters={{ ...EMPTY_FILTERS }}
        setFilters={vi.fn()}
        mode="wishlist"
        sets={['lea', 'neo']}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Filters' }))

    expect(screen.getAllByText('Set').length).toBeGreaterThan(0)
    expect(screen.queryByText('Condition')).toBe(null)
    expect(screen.queryByText('Language')).toBe(null)
    expect(screen.queryByText('Location')).toBe(null)
    expect(screen.queryByRole('option', { name: /Profit/ })).toBe(null)
  })
})
