import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth, LoginPage } from './components/Auth'
import { SettingsProvider } from './components/SettingsContext'
import { SetupWizardProvider } from './components/SetupWizard'
import { ToastProvider } from './components/ToastContext'
import { queryClient } from './lib/queryClient'
import Layout from './components/Layout'

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
const PrivacyPage = lazy(() => import('./pages/Privacy'))
const StorageNoticePage = lazy(() => import('./pages/StorageNotice'))
const CreditsPage = lazy(() => import('./pages/Credits'))
const DeleteAccountPage = lazy(() => import('./pages/DeleteAccount'))
const LifeTrackerPage = lazy(() => import('./pages/LifeTracker'))
const BuilderPage = lazy(() => import('./pages/Builder'))
const DeckBuilderPage = lazy(() => import('./pages/DeckBuilder'))
const DeckViewPage = lazy(() => import('./pages/DeckView'))
const TradingPage = lazy(() => import('./pages/Trading'))
const TournamentsPage = lazy(() => import('./pages/Tournaments'))
const ScannerPage = lazy(() => import('./pages/Scanner'))
const PokemonCollectionPage = lazy(() => import('./pages/PokemonCollection'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const RulebookPage = lazy(() => import('./pages/Rulebook'))

function PrivateApp() {
  const { user, authEvent } = useAuth()
  if (authEvent === 'PASSWORD_RECOVERY') return <LoginPage forcedMode="recovery" />
  if (!user) return <LoginPage />
  return (
    <SettingsProvider>
      <SetupWizardProvider>
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
            <Route path="/pokemon"     element={<PokemonCollectionPage />} />
            <Route path="/settings"    element={<SettingsPage />} />
            <Route path="/help"        element={<HelpPage />} />
            <Route path="/rules"       element={<RulebookPage />} />
            <Route path="/admin"       element={<AdminPage />} />
            <Route path="/builder"     element={<BuilderPage />} />
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
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/legal" element={<LegalPage />} />
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
    </BrowserRouter>
  )
}
