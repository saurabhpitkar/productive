import { NavLink, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState, useEffect, useRef } from 'react'
import { db } from '../db'
import { createList, renameList, deleteList } from '../sync/engine'
import { useUIStore } from '../store/ui'
import { useAuthStore } from '../store/auth'
import { fetchReviews } from '../lib/hitl'
import { ConfirmDialog } from './ConfirmDialog'


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

type ListMenu = { id: string; name: string; x: number; y: number }
type DeleteConfirm = { id: string; name: string; count: number }

export function Sidebar() {
  const { toggleSidebar, sidebarPinned, toggleSidebarPin } = useUIStore()
  const { user } = useAuthStore()

  const closeOnMobile = () => {
    if (window.innerWidth < 768) toggleSidebar()
  }
  const lists = useLiveQuery(async () => {
    const arr = await db.lists.toArray()
    return arr.sort((a, b) => a.list_name.localeCompare(b.list_name))
  }, [])

  const docCounts = useLiveQuery(async () => {
    const docs = await db.docs.filter(d => !!d.list_id && d.status !== 'archived').toArray()
    const counts: Record<string, number> = {}
    for (const d of docs) counts[d.list_id!] = (counts[d.list_id!] ?? 0) + 1
    return counts
  }, [])
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [pendingReviews, setPendingReviews] = useState(0)
  const navigate = useNavigate()

  // List context menu state
  const [listMenu, setListMenu] = useState<ListMenu | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null)

  // Long-press tracking (one timer shared across all list items)
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>()
  const longPressMoved = useRef(false)

  useEffect(() => {
    const load = () => fetchReviews().then(r => setPendingReviews(r.length)).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  // Close list menu on outside click / scroll
  useEffect(() => {
    if (!listMenu) return
    const close = () => setListMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('touchstart', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('touchstart', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [listMenu])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const list = await createList(name)
    setNewName('')
    setAdding(false)
    navigate(`/lists/${list.id}`)
    closeOnMobile()
  }

  const openListMenu = (id: string, name: string, x: number, y: number) => {
    setListMenu({ id, name, x, y })
  }

  const handleListContextMenu = (e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault()
    openListMenu(id, name, e.clientX, e.clientY)
  }

  const handleListTouchStart = (e: React.TouchEvent, id: string, name: string) => {
    longPressMoved.current = false
    const t = e.touches[0]
    longPressTimer.current = setTimeout(() => {
      if (!longPressMoved.current) openListMenu(id, name, t.clientX, t.clientY)
    }, 500)
  }

  const handleListTouchMove = () => {
    clearTimeout(longPressTimer.current)
    longPressMoved.current = true
  }

  const handleListTouchEnd = () => clearTimeout(longPressTimer.current)

  const startRename = (id: string, name: string) => {
    setListMenu(null)
    setRenamingId(id)
    setRenameValue(name)
  }

  const commitRename = async () => {
    if (renamingId && renameValue.trim()) {
      await renameList(renamingId, renameValue)
    }
    setRenamingId(null)
    setRenameValue('')
  }

  const requestDelete = (id: string, name: string) => {
    setListMenu(null)
    const count = docCounts?.[id] ?? 0
    setDeleteConfirm({ id, name, count })
  }

  const confirmDelete = async () => {
    if (!deleteConfirm) return
    await deleteList(deleteConfirm.id, true)
    setDeleteConfirm(null)
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

      <div className="mt-4 mb-1 px-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Lists</span>
        <button
          onClick={() => setAdding(true)}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          title="New list"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {lists?.map(list => (
        <div
          key={list.id}
          onContextMenu={e => handleListContextMenu(e, list.id, list.list_name)}
          onTouchStart={e => handleListTouchStart(e, list.id, list.list_name)}
          onTouchMove={handleListTouchMove}
          onTouchEnd={handleListTouchEnd}
        >
          {renamingId === list.id ? (
            <div className="flex gap-1 px-1 my-0.5">
              <input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') { setRenamingId(null); setRenameValue('') }
                }}
                className="flex-1 px-2 py-1.5 text-sm border border-indigo-300 dark:border-indigo-700 rounded-lg bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          ) : (
            <NavLink
              to={`/lists/${list.id}`}
              onClick={closeOnMobile}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                }`
              }
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span className="truncate flex-1">{list.list_name}</span>
              <span className="ml-auto text-xs text-gray-400">{docCounts?.[list.id] ?? 0}</span>
            </NavLink>
          )}
        </div>
      ))}

      {adding && (
        <div className="flex gap-1 px-1">
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setAdding(false) }}
            placeholder="List name"
            className="flex-1 px-2 py-1.5 text-sm border border-indigo-300 dark:border-indigo-700 rounded-lg bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button onClick={handleCreate} className="px-2 py-1 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Add</button>
        </div>
      )}

      </div>{/* end scrollable section */}

      {/* Footer: user profile + Settings - absolute-pinned to bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {user && (
          <NavLink to="/settings?section=profile" onClick={closeOnMobile}
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

      {/* List context menu popup (right-click / long-press) */}
      {listMenu && (
        <div
          style={{
            position: 'fixed',
            top: Math.min(listMenu.y, window.innerHeight - 120),
            left: Math.min(listMenu.x, window.innerWidth - 180),
            zIndex: 250,
            width: 172,
          }}
          className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl p-1.5"
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        >
          <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 truncate border-b border-gray-100 dark:border-gray-800 mb-1">
            {listMenu.name}
          </p>
          <button
            type="button"
            onMouseDown={e => { e.stopPropagation(); startRename(listMenu.id, listMenu.name) }}
            onTouchStart={e => { e.stopPropagation(); startRename(listMenu.id, listMenu.name) }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Rename
          </button>
          <button
            type="button"
            onMouseDown={e => { e.stopPropagation(); requestDelete(listMenu.id, listMenu.name) }}
            onTouchStart={e => { e.stopPropagation(); requestDelete(listMenu.id, listMenu.name) }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </div>
      )}

      {/* Delete list confirmation */}
      {deleteConfirm && (
        <ConfirmDialog
          title={`Delete "${deleteConfirm.name}"?`}
          message={
            deleteConfirm.count > 0
              ? `This will permanently delete the list and all ${deleteConfirm.count} doc${deleteConfirm.count === 1 ? '' : 's'} in it. This cannot be undone.`
              : 'This will permanently delete the list. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </nav>
  )
}
