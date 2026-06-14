import { Component, Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth, LoginPage } from './components/Auth'
import { SettingsProvider } from './components/SettingsContext'
import { SetupWizardProvider } from './components/SetupWizard'
import { ToastProvider } from './components/ToastContext'
import { queryClient } from './lib/queryClient'
import { handleChunkLoadError, isChunkLoadError } from './lib/chunkRecovery'
import Layout from './components/Layout'
import MilestoneWatcher from './components/MilestoneWatcher'

class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    handleChunkLoadError(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    const isChunkError = isChunkLoadError(this.state.error)
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}>
        <div style={{
          maxWidth: 420,
          width: '100%',
          border: '1px solid var(--border)',
          borderTop: '3px solid var(--gold)',
          borderRadius: 8,
          background: 'var(--bg2)',
          padding: 20,
          boxShadow: '0 18px 50px rgba(0,0,0,0.24)',
        }}>
          <h1 style={{ margin: '0 0 8px', fontSize: '1.1rem' }}>
            {isChunkError ? 'Update needed' : 'Something went wrong'}
          </h1>
          <p style={{ margin: '0 0 16px', color: 'var(--text-dim)', lineHeight: 1.45 }}>
            {isChunkError
              ? 'DeckLoom was updated while this tab was open. Reload to fetch the latest files.'
              : 'Reload the app and try again.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: '1px solid var(--border-hi)',
              borderRadius: 6,
              background: 'var(--gold)',
              color: '#15120a',
              fontWeight: 700,
              padding: '10px 14px',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

const HomePage = lazy(() => import('./pages/Home'))
const CollectionPage = lazy(() => import('./pages/Collection'))
const FoldersPage = lazy(() => import('./pages/Folders'))
const ListsPage = lazy(() => import('./pages/Lists'))
const StatsPage = lazy(() => import('./pages/Stats'))
const SharePage = lazy(() => import('./pages/Share'))
const JoinGamePage = lazy(() => import('./pages/JoinGame'))
const JoinTournamentPage = lazy(() => import('./pages/JoinTournament'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const HelpPage = lazy(() => import('./pages/Help'))
const AdminPage = lazy(() => import('./pages/Admin'))
const LegalPage = lazy(() => import('./pages/Legal'))
const TermsPage = lazy(() => import('./pages/Terms'))
const PrivacyPage = lazy(() => import('./pages/Privacy'))
const StorageNoticePage = lazy(() => import('./pages/StorageNotice'))
const CreditsPage = lazy(() => import('./pages/Credits'))
const DeleteAccountPage = lazy(() => import('./pages/DeleteAccount'))
const LifeTrackerPage = lazy(() => import('./pages/LifeTracker'))
const BuilderPage = lazy(() => import('./pages/Builder'))
const DeckBuilderPage = lazy(() => import('./pages/DeckBuilder'))
const DeckGoldfishPage = lazy(() => import('./pages/DeckGoldfish'))
const DeckViewPage = lazy(() => import('./pages/DeckView'))
const TradingPage = lazy(() => import('./pages/Trading'))
const TournamentsPage = lazy(() => import('./pages/Tournaments'))
const ScannerPage = lazy(() => import('./pages/Scanner'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const RulebookPage = lazy(() => import('./pages/Rulebook'))
const DiscoverPage = lazy(() => import('./pages/Discover'))

function PrivateApp() {
  const { user, authEvent } = useAuth()
  if (authEvent === 'PASSWORD_RECOVERY') return <LoginPage forcedMode="recovery" />
  if (!user) return <LoginPage />
  return (
    <SettingsProvider>
      <SetupWizardProvider>
      <MilestoneWatcher />
      <Layout>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/"            element={<HomePage />} />
            <Route path="/collection"  element={<CollectionPage />} />
            <Route path="/decks"       element={<FoldersPage key="decks"   type="deck" />} />
            <Route path="/binders"     element={<FoldersPage key="binders" type="binder" />} />
            <Route path="/lists"       element={<ListsPage />} />
            <Route path="/trading"     element={<TradingPage />} />
            <Route path="/stats"       element={<StatsPage />} />
            <Route path="/life"        element={<LifeTrackerPage />} />
            <Route path="/tournaments" element={<TournamentsPage />} />
            <Route path="/settings"    element={<SettingsPage />} />
            <Route path="/help"        element={<HelpPage />} />
            <Route path="/rules"       element={<RulebookPage />} />
            <Route path="/admin"       element={<AdminPage />} />
            <Route path="/discover"    element={<DiscoverPage />} />
            <Route path="/builder"     element={<BuilderPage />} />
            <Route path="/builder/:id/playtest" element={<DeckGoldfishPage />} />
            <Route path="/builder/:id" element={<DeckBuilderPage />} />
            <Route path="/scanner"          element={<ScannerPage />} />
            <Route path="/profile/:username" element={<ProfilePage />} />
            <Route path="*"                 element={<Navigate to="/" />} />
          </Routes>
        </Suspense>
      </Layout>
      </SetupWizardProvider>
    </SettingsProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ChunkErrorBoundary>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <Suspense fallback={null}>
                <Routes>
                  <Route path="/legal" element={<LegalPage />} />
                  <Route path="/terms" element={<TermsPage />} />
                  <Route path="/privacy" element={<PrivacyPage />} />
                  <Route path="/storage" element={<StorageNoticePage />} />
                  <Route path="/credits" element={<CreditsPage />} />
                  <Route path="/delete-account" element={<DeleteAccountPage />} />
                  <Route path="/share/:token" element={<SharePage />} />
                  <Route path="/d/:id" element={<DeckViewPage />} />
                  <Route path="/join/:code" element={<JoinGamePage />} />
                  <Route path="/join-tournament/:code" element={<JoinTournamentPage />} />
                  <Route path="/*" element={<PrivateApp />} />
                </Routes>
              </Suspense>
            </ToastProvider>
          </QueryClientProvider>
        </AuthProvider>
      </ChunkErrorBoundary>
    </BrowserRouter>
  )
}
