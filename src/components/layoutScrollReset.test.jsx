// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'

vi.mock('../lib/supabase', () => ({ sb: { auth: { signOut: vi.fn() } } }))
vi.mock('./Auth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'tester@example.com' } }) }))
vi.mock('./SettingsContext', () => ({
  useSettings: () => ({ keep_screen_awake: false, premium: false, nickname: 'Tester' }),
  maskEmailAddress: () => 'masked',
}))
vi.mock('./ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('./FeedbackModal', () => ({ default: () => null }))
vi.mock('./FeedbackNudge', () => ({ default: () => null }))
vi.mock('./community/NotificationBell', () => ({ default: () => null }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }))

// <main> outlives every route change, so the reset is the only thing standing
// between a scrolled page and the next one opening mid-scroll.
function Page({ to, label }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>{label}</button>
}

function renderApp(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <Routes>
          <Route path="/stats" element={<Page to="/settings" label="go settings" />} />
          <Route path="/settings" element={<Page to="/stats" label="go stats" />} />
          <Route path="/builder" element={<Page to="/builder?tab=browser" label="go tab" />} />
        </Routes>
      </Layout>
    </MemoryRouter>
  )
}

afterEach(() => cleanup())

describe('Layout scroll reset on navigation', () => {
  it('sends the scroller back to the top when the path changes', () => {
    const { getByText } = renderApp('/stats')
    const main = document.getElementById('app-main')
    expect(main).toBeTruthy()

    main.scrollTop = 640
    fireEvent.click(getByText('go settings'))

    expect(main.scrollTop).toBe(0)
  })

  it('keeps the scroll position when only the query string changes', () => {
    const { getByText } = renderApp('/builder')
    const main = document.getElementById('app-main')

    main.scrollTop = 640
    fireEvent.click(getByText('go tab'))

    expect(main.scrollTop).toBe(640)
  })
})
