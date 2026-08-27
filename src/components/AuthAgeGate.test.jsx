// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const signUp = vi.fn(async () => ({ error: null }))
const signInWithOAuth = vi.fn(async () => ({ error: null }))
const openNativeOAuth = vi.fn()

vi.mock('../lib/supabase', () => ({
  sb: {
    auth: {
      signUp: (...args) => signUp(...args),
      signInWithOAuth: (...args) => signInWithOAuth(...args),
      signInWithPassword: vi.fn(async () => ({ error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ error: null })),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: (cb) => {
        // The provider renders a loading state until a session resolves, so the
        // listener has to actually fire for the form to mount.
        setTimeout(() => cb('INITIAL_SESSION', null), 0)
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
    },
  },
}))

vi.mock('../lib/nativeAuth', () => ({
  isNativeApp: () => false,
  openNativeOAuth: (...args) => openNativeOAuth(...args),
  NATIVE_AUTH_ERROR_EVENT: 'av:native-auth-error',
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}))

vi.mock('../lib/accountReset', () => ({ reconcileActiveUser: () => false }))
vi.mock('../lib/authRecovery', () => ({
  parseEmailOtpParams: () => null,
  isRecoveryRedirect: () => false,
  redeemEmailOtp: vi.fn(),
  stripOtpParamsFromUrl: vi.fn(),
}))
vi.mock('./SettingsContext', () => ({ applyTheme: vi.fn() }))
vi.mock('../lib/deckBuilderApi', () => ({ fetchCardsByNames: vi.fn(async () => []) }))

const { AuthProvider, LoginPage } = await import('./Auth')

// LoginPage renders the marketing landing page first; the signup form is
// revealed by the hero CTA.
async function openSignupForm() {
  const { container } = render(<AuthProvider><LoginPage /></AuthProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /start building/i }))
  await screen.findByRole('checkbox')
  return container.querySelector('form')
}

// "Sign in" also appears on the landing page, so scope tab clicks to the tabs.
const tab = (name) =>
  within(screen.getByRole('group', { name: /account action/i })).getByRole('button', { name })

const ageBox = () => screen.getByRole('checkbox')

beforeEach(() => {
  // jsdom has no layout, so the form's reveal animation would throw.
  Element.prototype.scrollIntoView = vi.fn()
  signUp.mockClear()
  signInWithOAuth.mockClear()
})
afterEach(() => cleanup())

describe('signup age gate', () => {
  it('starts unticked — a pre-ticked box is not an affirmative act', async () => {
    await openSignupForm()
    expect(ageBox().checked).toBe(false)
  })

  it('blocks account creation while unticked, and says why', async () => {
    const form = await openSignupForm()
    fireEvent.submit(form)

    expect(signUp).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/16 or older/i)
  })

  it('blocks OAuth signup while unticked — those buttons bypass the form', async () => {
    await openSignupForm()
    fireEvent.click(screen.getByLabelText(/sign in with google/i))

    expect(signInWithOAuth).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/16 or older/i)
  })

  it('clears the tick when leaving the signup tab, so it is never carried over', async () => {
    await openSignupForm()
    fireEvent.click(ageBox())
    expect(ageBox().checked).toBe(true)

    fireEvent.click(tab(/^sign in$/i))
    fireEvent.click(tab(/create account/i))
    expect(ageBox().checked).toBe(false)
  })
})
