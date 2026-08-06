import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { SyncStatus } from './SyncStatus'
import { DocPanel } from './DocPanel'
import { AiPanel } from './AiPanel'
import { NotificationPrompt } from './NotificationPrompt'
import { DemoSeedPrompt } from './DemoSeedPrompt'
import { useUIStore } from '../store/ui'
import { syncEngine } from '../sync/engine'
import { db } from '../db'
import { checkAndNotifyDueDocs } from '../sync/notifications'
import { fetchAiSettings } from '../lib/ai'

// Desktop layout widths - all in viewport-percentage units
const SIDEBAR_PCT    = 18   // vw when expanded
const AI_PCT         = 20   // vw when expanded
const PANEL_MIN_PCT  = 30   // vw minimum for doc/empty panel
const PANEL_MAX_PCT  = 50   // vw maximum for doc/empty panel
const PANEL_DEF_PCT  = 40   // vw default
const DOCLIST_MIN_PCT = 20  // vw minimum for the doc list column

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return mobile
}

function EmptyState() {
  const [aiKeySet, setAiKeySet] = useState<boolean | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetchAiSettings()
      .then(s => setAiKeySet(s.api_key_set))
      .catch(() => setAiKeySet(true))
  }, [])

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
      <svg className="w-14 h-14 text-gray-300 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-[220px]">
        {'Digital Brain, augmented with your '}
        {aiKeySet === false ? (
          <button
            onClick={() => navigate('/settings?section=ai')}
            className="underline text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
          >
            choice of AI
          </button>
        ) : (
          <span>choice of AI</span>
        )}
        {'.'}
      </p>
    </div>
  )
}

export function Layout() {
  const { sidebarOpen, sidebarPinned, toggleSidebar, panelDocId, openPanel, closePanel, syncInterval } = useUIStore()
  const isMobile = useIsMobile()

  const [panelVw, setPanelVw] = useState(PANEL_DEF_PCT)
  const [aiOpen,  setAiOpen]  = useState(false)
  const [wakeLockOn, setWakeLockOn] = useState(false)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const mainColRef  = useRef<HTMLDivElement>(null)
  const swipeStart  = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const showPanel         = panelDocId !== null
  const wakeLockAvailable = 'wakeLock' in navigator

  // Clamp panelVw whenever sidebar or AI state changes
  useEffect(() => {
    const sidebarW = sidebarOpen ? SIDEBAR_PCT : 0
    const aiW      = aiOpen      ? AI_PCT      : 0
    const available = 100 - sidebarW - aiW
    const maxPct    = Math.min(PANEL_MAX_PCT, available - DOCLIST_MIN_PCT)
    setPanelVw(v => Math.max(PANEL_MIN_PCT, Math.min(maxPct, v)))
  }, [sidebarOpen, aiOpen])

  useEffect(() => {
    syncEngine.setBackgroundIntervalMs(syncInterval)
  }, [syncInterval])

  // ── Wake lock ──────────────────────────────────────────────────────────────
  const acquireWakeLock = async () => {
    try {
      const wl = await navigator.wakeLock.request('screen')
      wakeLockRef.current = wl
      setWakeLockOn(true)
      wl.addEventListener('release', () => { setWakeLockOn(false); wakeLockRef.current = null })
    } catch { setWakeLockOn(false) }
  }
  const releaseWakeLock = () => {
    wakeLockRef.current?.release()
    wakeLockRef.current = null
    setWakeLockOn(false)
  }
  const toggleWakeLock = () => { if (wakeLockOn) releaseWakeLock(); else acquireWakeLock() }

  useEffect(() => {
    if (!wakeLockOn) return
    const handler = () => { if (document.visibilityState === 'visible') acquireWakeLock() }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [wakeLockOn]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Notification scheduler ─────────────────────────────────────────────────
  useEffect(() => {
    const run = async () => {
      const docs = await db.docs.toArray()
      await checkAndNotifyDueDocs(docs)
    }
    run()
    const id = setInterval(run, 30 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // ── Swipe gestures (mobile) ────────────────────────────────────────────────
  useEffect(() => {
    const el = mainColRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - swipeStart.current.x
      const dy = Math.abs(e.changedTouches[0].clientY - swipeStart.current.y)
      const mostly = dy < 80 && Math.abs(dx) > 60
      if (!sidebarOpen && mostly && dx > 0 && swipeStart.current.x < 20) { toggleSidebar(); return }
      if (sidebarOpen  && mostly && dx < 0) toggleSidebar()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend',   onTouchEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend',   onTouchEnd)
    }
  }, [sidebarOpen, toggleSidebar])

  // ── Panel drag-resize (percentage-based) ───────────────────────────────────
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX   = e.clientX
    const startPct = panelVw
    const sidebarW  = sidebarOpen ? SIDEBAR_PCT : 0
    const aiW       = aiOpen      ? AI_PCT      : 0
    const available = 100 - sidebarW - aiW
    const maxPct    = Math.min(PANEL_MAX_PCT, available - DOCLIST_MIN_PCT)

    const onMove = (ev: MouseEvent) => {
      const deltaPct = (startX - ev.clientX) / window.innerWidth * 100
      setPanelVw(Math.max(PANEL_MIN_PCT, Math.min(maxPct, startPct + deltaPct)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }

  // ── AI toggle: auto-collapse sidebar unless pinned ─────────────────────────
  const handleAiToggle = () => {
    const next = !aiOpen
    if (next && sidebarOpen && !sidebarPinned) toggleSidebar()
    setAiOpen(next)
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 pt-safe pl-safe pr-safe pb-safe">
      <DemoSeedPrompt />

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={toggleSidebar} />
      )}

      {/* Sidebar ─────────────────────────────────────────────────────────── */}
      {/* Mobile: fixed overlay translated in/out */}
      {/* Desktop: inline flex item whose width transitions 0 ↔ SIDEBAR_PCT% */}
      <aside
        className={[
          'fixed inset-y-0 left-0 md:relative md:inset-auto z-30 md:z-auto md:h-full',
          'flex-shrink-0 overflow-hidden',
          'bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800',
          'transition-all duration-200',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
        style={isMobile
          ? { width: 256 }
          : { width: sidebarOpen ? `${SIDEBAR_PCT}%` : 0, minWidth: 0 }
        }
      >
        {/* Inner wrapper keeps content at SIDEBAR_PCT vw so it isn't crushed during collapse */}
        <div style={isMobile ? undefined : { width: `${SIDEBAR_PCT}vw`, minWidth: 192 }} className="h-full">
          <Sidebar />
        </div>
      </aside>

      {/* Main column ─────────────────────────────────────────────────────── */}
      <div ref={mainColRef} className="flex-1 flex flex-col min-w-0 overflow-hidden">

        <NotificationPrompt />

        {/* Top bar */}
        <header className="flex items-center gap-2 px-4 h-14 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <span className="font-semibold text-indigo-600 dark:text-indigo-400 text-sm tracking-wide flex-shrink-0">
            Productive
            <span className="ml-1.5 text-[0.6rem] font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded-full align-middle">v2</span>
          </span>

          <div className="flex-1" />

          <SyncStatus />

          {/* AI assistant toggle */}
          <button
            onClick={handleAiToggle}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
              aiOpen
                ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50'
                : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
            title={aiOpen ? 'Close AI assistant' : 'Open AI assistant'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            <span className="text-xs font-medium">AI (beta)</span>
          </button>

          {/* Wake lock toggle - desktop only */}
          {wakeLockAvailable && (
            <button
              onClick={toggleWakeLock}
              className={`hidden md:flex items-center p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                wakeLockOn
                  ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/30'
                  : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              title={wakeLockOn ? 'Screen kept awake - click to allow sleep' : 'Click to prevent tab from sleeping'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="4" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            </button>
          )}

          {/* New doc - desktop header button */}
          <button
            onClick={() => openPanel()}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New doc
          </button>
        </header>

        {/* Content row ────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0 overflow-hidden relative">

          {/* Doc list - flex-1 fills remaining width, never below DOCLIST_MIN_PCT */}
          <main
            className="flex-1 overflow-y-auto p-4 md:p-6 min-w-0"
            style={{ minWidth: `${DOCLIST_MIN_PCT}%` }}
          >
            <Outlet />
          </main>

          {/* Mobile: FAB */}
          {!showPanel && (
            <button
              onClick={() => openPanel()}
              className="md:hidden fixed bottom-6 right-6 z-40 w-14 h-14 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-full shadow-lg flex items-center justify-center transition-colors"
              aria-label="New doc"
              style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}

          {/* Mobile: full-screen overlays */}
          {isMobile && showPanel && (
            <div className="fixed inset-0 z-50">
              <DocPanel
                docId={panelDocId === 'new' ? undefined : panelDocId}
                onClose={closePanel}
              />
            </div>
          )}
          {isMobile && aiOpen && !showPanel && (
            <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900">
              <AiPanel onClose={() => setAiOpen(false)} />
            </div>
          )}

          {/* Desktop: drag handle + doc/empty panel + AI panel ─────────────── */}
          {!isMobile && (
            <>
              {/* Drag handle - left edge of the right panel */}
              <div
                onMouseDown={startResize}
                className="w-1.5 flex-shrink-0 cursor-col-resize flex items-center justify-center hover:bg-indigo-50 dark:hover:bg-indigo-900/20 group transition-colors"
                title="Drag to resize"
              >
                <div className="w-0.5 h-8 rounded-full bg-gray-200 dark:bg-gray-700 group-hover:bg-indigo-400 transition-colors" />
              </div>

              {/* Right panel: doc view or empty state */}
              <div
                className="flex-shrink-0 flex flex-col h-full border-l border-gray-200 dark:border-gray-800"
                style={{ width: `${panelVw}%` }}
              >
                {showPanel ? (
                  <DocPanel
                    docId={panelDocId === 'new' ? undefined : panelDocId}
                    onClose={closePanel}
                  />
                ) : (
                  <EmptyState />
                )}
              </div>

              {/* AI Panel */}
              {aiOpen && (
                <div
                  className="flex-shrink-0 flex flex-col h-full border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
                  style={{ width: `${AI_PCT}%` }}
                >
                  <AiPanel onClose={() => setAiOpen(false)} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
