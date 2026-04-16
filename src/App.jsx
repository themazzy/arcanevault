import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth, LoginPage } from './components/Auth'
import { SettingsProvider } from './components/SettingsContext'
import { SetupWizardProvider } from './components/SetupWizard'
import Layout from './components/Layout'
import HomePage from './pages/Home'
import CollectionPage from './pages/Collection'
import FoldersPage from './pages/Folders'
import ListsPage from './pages/Lists'
import StatsPage from './pages/Stats'
import SharePage from './pages/Share'
import JoinGamePage from './pages/JoinGame'
import JoinTournamentPage from './pages/JoinTournament'
import SettingsPage from './pages/Settings'
import LifeTrackerPage from './pages/LifeTracker'
import BuilderPage from './pages/Builder'
import DeckBuilderPage from './pages/DeckBuilder'
import DeckViewPage from './pages/DeckView'
import TradingPage from './pages/Trading'
import TournamentsPage from './pages/Tournaments'
import ScannerPage from './pages/Scanner'
import PokemonCollectionPage from './pages/PokemonCollection'

function PrivateApp() {
  const { user, authEvent } = useAuth()
  if (authEvent === 'PASSWORD_RECOVERY') return <LoginPage forcedMode="recovery" />
  if (!user) return <LoginPage />
  return (
    <SettingsProvider>
      <SetupWizardProvider>
      <Layout>
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
          <Route path="/builder"     element={<BuilderPage />} />
          <Route path="/builder/:id" element={<DeckBuilderPage />} />
          <Route path="/scanner"     element={<ScannerPage />} />
          <Route path="*"            element={<Navigate to="/" />} />
        </Routes>
      </Layout>
      </SetupWizardProvider>
    </SettingsProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter
      basename={import.meta.env.VITE_CAPACITOR ? '/' : '/arcanevault'}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/d/:id" element={<DeckViewPage />} />
          <Route path="/join/:code" element={<JoinGamePage />} />
          <Route path="/join-tournament/:code" element={<JoinTournamentPage />} />
          <Route path="/*" element={<PrivateApp />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
