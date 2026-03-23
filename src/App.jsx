import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth, LoginPage } from './components/Auth'
import { SettingsProvider } from './components/SettingsContext'
import Layout from './components/Layout'
import HomePage from './pages/Home'
import CollectionPage from './pages/Collection'
import FoldersPage from './pages/Folders'
import ListsPage from './pages/Lists'
import StatsPage from './pages/Stats'
import SharePage from './pages/Share'
import SettingsPage from './pages/Settings'
import LifeTrackerPage from './pages/LifeTracker'
import BuilderPage from './pages/Builder'
import DeckBuilderPage from './pages/DeckBuilder'
import DeckViewPage from './pages/DeckView'

function PrivateApp() {
  const { user } = useAuth()
  if (!user) return <LoginPage />
  return (
    <SettingsProvider>
      <Layout>
        <Routes>
          <Route path="/"            element={<HomePage />} />
          <Route path="/collection"  element={<CollectionPage />} />
          <Route path="/decks"       element={<FoldersPage key="decks"   type="deck" />} />
          <Route path="/binders"     element={<FoldersPage key="binders" type="binder" />} />
          <Route path="/lists"       element={<ListsPage />} />
          <Route path="/stats"       element={<StatsPage />} />
          <Route path="/life"        element={<LifeTrackerPage />} />
          <Route path="/settings"    element={<SettingsPage />} />
          <Route path="/builder"     element={<BuilderPage />} />
          <Route path="/builder/:id" element={<DeckBuilderPage />} />
          <Route path="*"            element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    </SettingsProvider>
  )
}

export default function App() {
  return (
    /* Added basename="/arcanevault" here */
    <BrowserRouter 
      basename="/arcanevault"
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/d/:id" element={<DeckViewPage />} />
          <Route path="/*" element={<PrivateApp />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
