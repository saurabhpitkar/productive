import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout }     from './components/Layout'
import { ActiveDocs } from './pages/ActiveDocs'
import { AllTasks }   from './pages/AllTasks'
import { Today }      from './pages/Today'
import { Flagged }    from './pages/Flagged'
import { ListPage }   from './pages/ListPage'
import { DocDetail }  from './pages/DocDetail'
import { Settings }   from './pages/Settings'
import { Recent }     from './pages/Recent'
import { Reviews }    from './pages/Reviews'
import { Login }      from './pages/Login'
import { syncEngine } from './sync/engine'
import { useAuthStore, fetchMe } from './store/auth'

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, checked, setUser } = useAuthStore()
  const [loading, setLoading] = useState(!checked)

  useEffect(() => {
    if (checked) { setLoading(false); return }
    fetchMe().then(u => {
      setUser(u)
      setLoading(false)
    })
  }, [checked, setUser])

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const { user } = useAuthStore()

  useEffect(() => {
    if (!user) return
    navigator.storage?.persist?.()
    syncEngine.start(user.user_id)
    const onVisible = () => syncEngine.onVisibilityChange()
    const onOnline  = () => syncEngine.run()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      syncEngine.stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [user])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AuthGate><Layout /></AuthGate>}>
          <Route index              element={<ActiveDocs />} />
          <Route path="all"         element={<AllTasks />} />
          <Route path="today"       element={<Today />} />
          <Route path="flagged"     element={<Flagged />} />
          <Route path="lists/:listId" element={<ListPage />} />
          <Route path="docs/:id"    element={<DocDetail />} />
          <Route path="settings"    element={<Settings />} />
          <Route path="recent"      element={<Recent />} />
          <Route path="reviews"     element={<Reviews />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
