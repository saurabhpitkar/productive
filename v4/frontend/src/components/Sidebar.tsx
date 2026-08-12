import { NavLink, Link, useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '../store/ui'
import { useAuthStore } from '../store/auth'
import { fetchReviews } from '../lib/hitl'
import { api } from '../api/client'
import type { Theme } from '../types'


function NavItem({ to, icon, label, onClick }: { to: string; icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  )
}

function ActivitySection() {
  const { setActiveRoutingCount } = useUIStore()
  const [hasActive, setHasActive] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.listInbox()
      const routing = data.filter(e => e.status === 'routing').length
      setActiveRoutingCount(routing)
      setHasActive(routing > 0)
    } catch { /* ignore */ }
  }, [setActiveRoutingCount])

  useEffect(() => {
    load()
    let id: ReturnType<typeof setInterval>
    const schedule = () => {
      clearInterval(id)
      id = setInterval(() => { load().then(() => schedule()) }, hasActive ? 3000 : 30000)
    }
    schedule()
    return () => clearInterval(id)
  }, [load, hasActive])

  return (
    <div className="mt-4">
      <Link
        to="/activity-log"
        className="flex items-center px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Activity</span>
        {hasActive && (
          <span className="ml-auto w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
        )}
      </Link>
    </div>
  )
}

export function Sidebar({ onSearchOpen, onInboxOpen }: { onSearchOpen?: () => void; onInboxOpen?: () => void }) {
  const { toggleSidebar, sidebarPinned, toggleSidebarPin } = useUIStore()
  const { user } = useAuthStore()

  const closeOnMobile = () => {
    if (window.innerWidth < 768) toggleSidebar()
  }
  const [pendingReviews, setPendingReviews] = useState(0)
  const navigate = useNavigate()

  // Themes
  const [themes, setThemes] = useState<Theme[]>([])
  const [themesExpanded, setThemesExpanded] = useState(true)
  const [addingTheme, setAddingTheme] = useState(false)
  const [newThemeName, setNewThemeName] = useState('')

  useEffect(() => {
    const load = () => fetchReviews().then(r => setPendingReviews(r.length)).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    api.listThemes().then(setThemes).catch(() => {})
  }, [])

  const handleCreateTheme = async () => {
    const name = newThemeName.trim()
    if (!name) return
    const theme = await api.createTheme(name)
    setThemes(prev => [...prev, theme])
    setNewThemeName('')
    setAddingTheme(false)
    navigate(`/themes/${theme.id}`)
    closeOnMobile()
  }

  return (
    <nav className="h-full flex flex-col relative">
      {/* Scrollable top section - pb-20 leaves room for the absolute Settings footer */}
      <div
        className="flex-1 overflow-y-auto p-3 pb-28 flex flex-col gap-1 min-h-0"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
      <NavItem to="/" label="Active Docs" onClick={closeOnMobile} icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      } />
      <NavItem to="/today" label="Today" onClick={closeOnMobile} icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      } />
      <NavItem to="/flagged" label="Flagged" onClick={closeOnMobile} icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
        </svg>
      } />
      <NavItem to="/recent" label="Recent" onClick={closeOnMobile} icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      } />
      <NavItem to="/all" label="All Docs" onClick={closeOnMobile} icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      } />

      {/* Search */}
      <button
        onClick={onSearchOpen}
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 w-full text-left"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        Search
        <kbd className="ml-auto text-[0.6rem] font-mono text-gray-300 dark:text-gray-600">⌘K</kbd>
      </button>

      {/* Capture quick-capture */}
      <button
        onClick={onInboxOpen}
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 w-full text-left"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 4v16m8-8H4" />
        </svg>
        Capture
      </button>

      {/* Reviews - shows badge when agent writes are waiting for approval */}
      <NavLink
        to="/reviews"
        onClick={closeOnMobile}
        className={({ isActive }) =>
          `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive
              ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
          }`
        }
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <span className="flex-1">Reviews</span>
        {pendingReviews > 0 && (
          <span className="px-1.5 py-0.5 text-xs font-semibold bg-amber-500 text-white rounded-full leading-none">
            {pendingReviews}
          </span>
        )}
      </NavLink>

      {/* Themes section */}
      <div className="mt-4 mb-1 px-3 flex items-center justify-between">
        <button
          onClick={() => setThemesExpanded(e => !e)}
          className="flex items-center gap-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform duration-150 ${themesExpanded ? '' : '-rotate-90'}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          Themes
        </button>
        <button
          onClick={() => { setAddingTheme(true); setThemesExpanded(true) }}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          title="New theme"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {themesExpanded && (
        <>
          {themes.slice(0, 10).map(theme => (
            <NavLink
              key={theme.id}
              to={`/themes/${theme.id}`}
              onClick={closeOnMobile}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                }`
              }
            >
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" fill="currentColor" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="3" />
              </svg>
              <span className="truncate flex-1">{theme.title}</span>
            </NavLink>
          ))}
          {addingTheme && (
            <div className="flex gap-1 px-1">
              <input
                autoFocus
                value={newThemeName}
                onChange={e => setNewThemeName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateTheme()
                  if (e.key === 'Escape') { setAddingTheme(false); setNewThemeName('') }
                }}
                placeholder="Theme name"
                className="flex-1 px-2 py-1.5 text-sm border border-indigo-300 dark:border-indigo-700 rounded-lg bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button onClick={handleCreateTheme} className="px-2 py-1 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Add</button>
            </div>
          )}
        </>
      )}

      <ActivitySection />

      </div>{/* end scrollable section */}

      {/* Footer: user profile + Settings - absolute-pinned to bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {user && (
          <NavLink to="/settings?section=account" onClick={closeOnMobile}
            className="flex items-center gap-2.5 px-3 py-2 mt-1 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            {user.avatar ? (
              <img src={user.avatar} alt={user.name} className="w-6 h-6 rounded-full flex-shrink-0 object-cover" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-emerald-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                {user.name.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-xs text-gray-600 dark:text-gray-400 truncate flex-1">{user.name}</span>
          </NavLink>
        )}
        <div className="px-3 pb-1">
          {/* Settings row - pin icon is a small button at the right edge, desktop only */}
          <div className="relative group">
            <NavItem to="/settings" label="Settings" onClick={closeOnMobile} icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            } />
            {/* Pin icon - desktop only, right-aligned in the settings row */}
            <button
              onClick={toggleSidebarPin}
              title={sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar open'}
              className={`hidden md:flex absolute right-1.5 top-1/2 -translate-y-1/2 items-center justify-center w-6 h-6 rounded transition-all ${
                sidebarPinned
                  ? 'text-indigo-600 dark:text-indigo-400 opacity-100'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 opacity-0 group-hover:opacity-100'
              }`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75">
                <circle cx="12" cy="7" r="4" fill={sidebarPinned ? 'currentColor' : 'none'} />
                <line x1="12" y1="11" x2="12" y2="20" />
                <line x1="9" y1="20" x2="15" y2="20" />
              </svg>
            </button>
          </div>
        </div>
      </div>

    </nav>
  )
}
