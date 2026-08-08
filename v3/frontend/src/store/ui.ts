import { create } from 'zustand'

const SYNC_INTERVAL_KEY  = 'pa:syncInterval'
const AUTO_SAVE_KEY      = 'pa:autoSave'
const SIDEBAR_PINNED_KEY = 'pa:sidebarPinned'

function getSavedInterval(): number {
  try {
    const s = localStorage.getItem(SYNC_INTERVAL_KEY)
    return s === '1800000' ? 1800000 : 180000
  } catch { return 180000 }
}

function getSavedAutoSave(): boolean {
  try { return localStorage.getItem(AUTO_SAVE_KEY) !== 'false' } catch { return true }
}

function getSavedSidebarPinned(): boolean {
  try { return localStorage.getItem(SIDEBAR_PINNED_KEY) === 'true' } catch { return false }
}

interface SyncStore {
  isSyncing:    boolean
  lastSync:     string | null
  failedCount:  number
  pendingCount: number
  syncError:    string | null
  setSyncing:     (v: boolean)       => void
  setLastSync:    (v: string)        => void
  setFailedCount: (v: number)        => void
  setPendingCount:(v: number)        => void
  setSyncError:   (v: string | null) => void
}

export const useSyncStore = create<SyncStore>(set => ({
  isSyncing:    false,
  lastSync:     null,
  failedCount:  0,
  pendingCount: 0,
  syncError:    null,
  setSyncing:      isSyncing    => set({ isSyncing }),
  setLastSync:     lastSync     => set({ lastSync }),
  setFailedCount:  failedCount  => set({ failedCount }),
  setPendingCount: pendingCount => set({ pendingCount }),
  setSyncError:    syncError    => set({ syncError }),
}))

interface UIStore {
  sidebarOpen:    boolean
  sidebarPinned:  boolean
  // null = panel closed; 'new' = create new doc; any other string = edit/view that docId
  panelDocId:     string | null
  syncInterval:   number   // ms: 180_000 (3 min) or 1_800_000 (30 min)
  autoSave:       boolean
  toggleSidebar:      () => void
  toggleSidebarPin:   () => void
  openPanel:          (docId?: string) => void
  closePanel:         () => void
  toggleSyncInterval: () => void
  toggleAutoSave:     () => void
}

export const useUIStore = create<UIStore>(set => ({
  sidebarOpen:    getSavedSidebarPinned(),  // open on load only if pinned
  sidebarPinned:  getSavedSidebarPinned(),
  panelDocId:     null,
  syncInterval:   getSavedInterval(),
  autoSave:       getSavedAutoSave(),
  toggleSidebar:    () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
  toggleSidebarPin: () => set(s => {
    const next = !s.sidebarPinned
    try { localStorage.setItem(SIDEBAR_PINNED_KEY, String(next)) } catch {}
    return { sidebarPinned: next, ...(next ? { sidebarOpen: true } : {}) }
  }),
  openPanel: docId => set(() => ({ panelDocId: docId ?? 'new' })),
  closePanel: () => set({ panelDocId: null }),
  toggleSyncInterval: () => set(s => {
    const next = s.syncInterval === 180000 ? 1800000 : 180000
    try { localStorage.setItem(SYNC_INTERVAL_KEY, String(next)) } catch { /* private browsing */ }
    return { syncInterval: next }
  }),
  toggleAutoSave: () => set(s => {
    const next = !s.autoSave
    try { localStorage.setItem(AUTO_SAVE_KEY, String(next)) } catch {}
    return { autoSave: next }
  }),
}))
