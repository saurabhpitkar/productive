import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { Doc } from '../types'
import type { SortBy } from '../lib/docFilters'

type FilterPriority = NonNullable<Doc['priority']>
type Status = Doc['status']

const STATUS_LABELS: [Status | '', string][] = [
  ['',            'All'],
  ['todo',        'Todo'],
  ['in_progress', 'In progress'],
  ['done',        'Done'],
  ['cancelled',   'Cancelled'],
  ['archived',    'Archived'],
]
const PRIORITIES: [FilterPriority | '', string][] = [
  ['',       'Any priority'],
  ['high',   'High'],
  ['medium', 'Medium'],
  ['low',    'Low'],
]
const SORT_OPTIONS: [SortBy, string][] = [
  ['last_modified', 'Last Modified'],
  ['priority',      'Priority'],
  ['due_date',      'Due date'],
  ['name',          'Name'],
]

interface MenuPos { top: number; left: number }

function calcPos(el: HTMLElement, menuW: number): MenuPos {
  const r = el.getBoundingClientRect()
  return {
    top:  r.bottom + 4,
    left: Math.min(r.left, window.innerWidth - menuW - 8),
  }
}

const Checkmark = () => (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
  </svg>
)

export interface FilterToolbarProps {
  search:     string
  onSearch:   (v: string) => void
  status:     Status | ''
  onStatus:   (v: Status | '') => void
  priority:   FilterPriority | ''
  onPriority: (v: FilterPriority | '') => void
  sortBy:     SortBy
  onSort:     (v: SortBy) => void
}

export function FilterToolbar({
  search, onSearch, status, onStatus, priority, onPriority, sortBy, onSort,
}: FilterToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [sortOpen,   setSortOpen]   = useState(false)
  const [filterPos,  setFilterPos]  = useState<MenuPos | null>(null)
  const [sortPos,    setSortPos]    = useState<MenuPos | null>(null)

  const searchRef     = useRef<HTMLInputElement>(null)
  const filterBtnRef  = useRef<HTMLButtonElement>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const sortBtnRef    = useRef<HTMLButtonElement>(null)
  const sortMenuRef   = useRef<HTMLDivElement>(null)

  const hasFilter = !!status || !!priority

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setFilterOpen(false); setSortOpen(false) }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!filterBtnRef.current?.contains(t) && !filterMenuRef.current?.contains(t)) setFilterOpen(false)
      if (!sortBtnRef.current?.contains(t)   && !sortMenuRef.current?.contains(t))   setSortOpen(false)
    }
    document.addEventListener('keydown',    onKey)
    document.addEventListener('mousedown',  onDown)
    return () => {
      document.removeEventListener('keydown',   onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  const closeSearch = () => { onSearch(''); setSearchOpen(false) }

  const toggleFilter = () => {
    if (!filterOpen && filterBtnRef.current) setFilterPos(calcPos(filterBtnRef.current, 210))
    setFilterOpen(v => !v)
  }
  const toggleSort = () => {
    if (!sortOpen && sortBtnRef.current) setSortPos(calcPos(sortBtnRef.current, 170))
    setSortOpen(v => !v)
  }

  const iconCls = (active: boolean) =>
    `relative flex items-center justify-center w-8 h-8 rounded-lg border transition-colors flex-shrink-0 ${
      active
        ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300'
        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-200'
    }`

  const menuCls  = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg py-1 overflow-hidden'
  const itemBase = 'w-full text-left px-3 py-1.5 text-sm flex items-center justify-between transition-colors'
  const itemCls  = (on: boolean) => `${itemBase} ${
    on
      ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300'
      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

  return (
    <div className="flex items-center gap-1.5 mb-3">

      {/* ── Search ────────────────────────────────────────────────────────── */}
      {searchOpen ? (
        <div className="flex-1 flex items-center gap-1.5 min-w-0 bg-white dark:bg-gray-900 border border-indigo-400 dark:border-indigo-500 rounded-lg px-2.5 py-1.5">
          <svg className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" strokeWidth={1.5} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={searchRef}
            value={search}
            onChange={e => onSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && closeSearch()}
            placeholder="Search…"
            className="flex-1 min-w-0 text-sm bg-transparent focus:outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
          />
          <button type="button" onClick={closeSearch} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <button type="button" onClick={openSearch} className={iconCls(!!search)} title="Search">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" strokeWidth={1.5} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-4.35-4.35" />
          </svg>
        </button>
      )}

      {/* ── Filter / abacus-sliders icon ──────────────────────────────────── */}
      <button
        ref={filterBtnRef}
        type="button"
        onClick={toggleFilter}
        className={iconCls(filterOpen || hasFilter)}
        title="Filter"
      >
        {/* HeroIcons adjustments-horizontal */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0M9.75 12H3.75" />
        </svg>
        {hasFilter && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-indigo-500" />
        )}
      </button>

      {/* ── Sort / up-down arrows ─────────────────────────────────────────── */}
      <button
        ref={sortBtnRef}
        type="button"
        onClick={toggleSort}
        className={iconCls(sortOpen)}
        title="Sort"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          {/* Left column: arrow pointing up */}
          <path d="M7 20V4M3 8l4-4 4 4" />
          {/* Right column: arrow pointing down */}
          <path d="M17 4v16m-4-4 4 4 4-4" />
        </svg>
      </button>

      {/* ── Filter dropdown (portaled) ────────────────────────────────────── */}
      {filterOpen && filterPos && createPortal(
        <div
          ref={filterMenuRef}
          className={menuCls}
          style={{ position: 'fixed', top: filterPos.top, left: filterPos.left, zIndex: 9999, width: '13rem' }}
        >
          <p className="text-xs font-medium text-gray-400 dark:text-gray-500 px-3 pt-2 pb-1 uppercase tracking-wide">Status</p>
          {STATUS_LABELS.map(([val, label]) => (
            <button key={val} type="button" onClick={() => onStatus(val as Status | '')} className={itemCls(status === val)}>
              {label}
              {status === val && <Checkmark />}
            </button>
          ))}
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <p className="text-xs font-medium text-gray-400 dark:text-gray-500 px-3 pt-1 pb-1 uppercase tracking-wide">Priority</p>
          {PRIORITIES.map(([val, label]) => (
            <button key={val} type="button" onClick={() => onPriority(val as FilterPriority | '')} className={itemCls(priority === val)}>
              {label}
              {priority === val && <Checkmark />}
            </button>
          ))}
          {hasFilter && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
              <button
                type="button"
                onClick={() => { onStatus(''); onPriority('') }}
                className={`${itemBase} text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30`}
              >
                Clear filters
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* ── Sort dropdown (portaled) ──────────────────────────────────────── */}
      {sortOpen && sortPos && createPortal(
        <div
          ref={sortMenuRef}
          className={menuCls}
          style={{ position: 'fixed', top: sortPos.top, left: sortPos.left, zIndex: 9999, width: '10.5rem' }}
        >
          <p className="text-xs font-medium text-gray-400 dark:text-gray-500 px-3 pt-2 pb-1 uppercase tracking-wide">Sort by</p>
          {SORT_OPTIONS.map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => { onSort(val); setSortOpen(false) }}
              className={itemCls(sortBy === val)}
            >
              {label}
              {sortBy === val && <Checkmark />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
