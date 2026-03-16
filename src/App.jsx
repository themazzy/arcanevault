import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth, LoginPage } from './components/Auth'
import { SettingsProvider } from './components/SettingsContext'
import Layout from './components/Layout'
import CollectionPage from './pages/Collection'
import FoldersPage from './pages/Folders'
import ListsPage from './pages/Lists'
import StatsPage from './pages/Stats'
import SharePage from './pages/Share'
import SettingsPage from './pages/Settings'

function PrivateApp() {
  const { user } = useAuth()
  if (!user) return <LoginPage />
  return (
    <SettingsProvider>
      <Layout>
        <Routes>
          <Route path="/"         element={<CollectionPage />} />
          <Route path="/decks"    element={<FoldersPage type="deck" />} />
          <Route path="/binders"  element={<FoldersPage type="binder" />} />
          <Route path="/lists"    element={<ListsPage />} />
          <Route path="/stats"    element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*"         element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    </SettingsProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/*" element={<PrivateApp />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
