import { useSyncStore } from '../store/ui'
import { syncEngine } from '../sync/engine'

export function SyncStatus() {
  const { isSyncing, lastSync, failedCount, pendingCount, syncError } = useSyncStore()

  const label = isSyncing
    ? 'Syncing…'
    : syncError
    ? 'Sync error'
    : lastSync
    ? `Synced ${new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Not synced'

  const colorCls = syncError
    ? 'text-red-500 hover:text-red-700'
    : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200'

  return (
    <div className="flex items-center gap-2">
      {failedCount > 0 && (
        <span className="text-xs text-red-500 font-medium">{failedCount} failed</span>
      )}
      {pendingCount > 0 && !isSyncing && (
        <span className="text-xs text-amber-500 font-medium">{pendingCount} pending</span>
      )}
      <button
        onClick={() => syncEngine.run()}
        className={`flex items-center gap-1.5 text-xs transition-colors ${colorCls}`}
        title={syncError ?? 'Sync now'}
      >
        <svg
          className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {label}
      </button>
    </div>
  )
}
