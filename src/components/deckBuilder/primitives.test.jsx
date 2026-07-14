// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ManaCostInline } from './primitives'

afterEach(cleanup)

describe('ManaCostInline', () => {
  it('renders the separator between split-card mana costs', () => {
    render(<ManaCostInline cost="{1}{W} // {2}{U}" />)

    expect(screen.getByText('//')).toBeTruthy()
    expect(screen.getByAltText('{1}')).toBeTruthy()
    expect(screen.getByAltText('{U}')).toBeTruthy()
  })
})
