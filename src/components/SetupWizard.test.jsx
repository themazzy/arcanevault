// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupWizardProvider, useSetupWizard } from './SetupWizard'

vi.mock('./SettingsContext', () => ({
  useSettings: () => ({
    theme: 'shadow',
    premium: false,
    save: vi.fn(),
  }),
  THEMES: {},
  PREMIUM_THEMES: new Set(),
}))

vi.mock('../lib/scryfall', () => ({
  PRICE_SOURCES: [],
  sfGet: vi.fn(),
}))

function PersonalizationTrigger() {
  const { open } = useSetupWizard()
  return <button onClick={open}>Personalize</button>
}

afterEach(() => cleanup())

describe('SetupWizardProvider', () => {
  it('stays closed until personalization is explicitly requested', () => {
    render(
      <SetupWizardProvider>
        <PersonalizationTrigger />
      </SetupWizardProvider>,
    )

    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Personalize' }))

    expect(screen.getByRole('dialog', { name: 'Personalize DeckLoom' })).toBeTruthy()
    expect(screen.queryByText(/pick your nickname/i)).toBeNull()
  })
})
