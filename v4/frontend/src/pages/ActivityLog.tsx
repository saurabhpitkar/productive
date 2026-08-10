import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ActivityLogEntry } from '../types'

const ACTION_STYLES: Record<string, { label: string; color: string }> = {
  created:       { label: 'Created',      color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  updated:       { label: 'Updated',      color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
  deleted:       { label: 'Deleted',      color: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  routed:        { label: 'Appended',     color: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' },
  linked:        { label: 'Link added',   color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  unlinked:      { label: 'Link removed', color: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400' },
  batch_created: { label: 'Batch',        color: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m <  1)  return 'just now'
  if (m <  60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === today.toDateString())     return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

function actorLabel(actor: string): string {
  if (actor === 'human:user') return 'via UI'
  if (actor.startsWith('agent:inbox-router')) return 'Inbox routing agent'
  if (actor === 'agent:ai-assistant') return 'AI assistant'
  if (actor === 'agent:pat-client') return 'via API'
  if (actor.startsWith('human:')) return 'via UI'
  if (actor.startsWith('agent:')) return 'agent'
  return actor
}

function EntryRow({ entry }: { entry: ActivityLogEntry }) {
  const style = ACTION_STYLES[entry.action] ?? ACTION_STYLES.updated
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800">
      <span className={`mt-0.5 inline-flex px-2 py-0.5 text-[0.65rem] font-semibold rounded-full flex-shrink-0 ${style.color}`}>
        {style.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
          {entry.doc_name ?? <span className="italic text-gray-400 dark:text-gray-500">Document removed</span>}
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">
          {actorLabel(entry.actor)} · {timeAgo(entry.created_at)}
        </p>
      </div>
    </div>
  )
}

interface SessionGroup {
  session_id: string
  actor: string
  latest_at: string
  entries: ActivityLogEntry[]
  expanded: boolean
}

function SessionGroup({ group, onToggle }: { group: SessionGroup; onToggle: () => void }) {
  const actionSummary = group.entries.map(e => (ACTION_STYLES[e.action] ?? ACTION_STYLES.updated).label).join(', ')
  return (
    <div className="rounded-xl border border-indigo-100 dark:border-indigo-900/50 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 transition-colors text-left"
      >
        <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex-shrink-0">
          {actorLabel(group.actor)}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">
          {actionSummary}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-600 flex-shrink-0">
          {group.entries.length} event{group.entries.length !== 1 ? 's' : ''} · {timeAgo(group.latest_at)}
        </span>
        <svg className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${group.expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {group.expanded && (
        <div className="flex flex-col gap-1 p-1.5 bg-white dark:bg-gray-900">
          {group.entries.map(e => <EntryRow key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  )
}

type DayItem =
  | { kind: 'entry';   entry: ActivityLogEntry }
  | { kind: 'session'; group: SessionGroup }

export function ActivityLog() {
  const [entries,  setEntries]  = useState<ActivityLogEntry[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api.getActivityLog({ limit: 100 })
      .then(setEntries)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load activity'))
      .finally(() => setLoading(false))
  }, [])

  const toggleSession = (sid: string) =>
    setExpanded(prev => ({ ...prev, [sid]: !prev[sid] }))

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return <p className="px-4 py-6 text-sm text-red-500 text-center">{error}</p>
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center px-4">
        <svg className="w-10 h-10 text-gray-300 dark:text-gray-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm text-gray-400">No activity yet.</p>
      </div>
    )
  }

  // Build day groups, then within each day build session groups
  const dayMap: Map<string, ActivityLogEntry[]> = new Map()
  for (const e of entries) {
    const day = dayLabel(e.created_at)
    if (!dayMap.has(day)) dayMap.set(day, [])
    dayMap.get(day)!.push(e)
  }

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6">Activity Log</h1>

      <div className="flex flex-col gap-6">
        {[...dayMap.entries()].map(([day, dayEntries]) => {
          // Group entries within a day by session_id
          const sessionMap: Map<string, ActivityLogEntry[]> = new Map()
          const noSession: ActivityLogEntry[] = []

          for (const e of dayEntries) {
            if (e.session_id) {
              if (!sessionMap.has(e.session_id)) sessionMap.set(e.session_id, [])
              sessionMap.get(e.session_id)!.push(e)
            } else {
              noSession.push(e)
            }
          }

          // Build interleaved list of sessions + individual entries, ordered by latest created_at
          const items: (DayItem & { sort_at: string })[] = []

          for (const [sid, ses] of sessionMap.entries()) {
            const latest_at = ses[0].created_at
            const group: SessionGroup = {
              session_id: sid,
              actor: ses[0].actor,
              latest_at,
              entries: ses,
              expanded: expanded[sid] ?? false,
            }
            items.push({ kind: 'session', group, sort_at: latest_at })
          }
          for (const e of noSession) {
            items.push({ kind: 'entry', entry: e, sort_at: e.created_at })
          }
          items.sort((a, b) => b.sort_at.localeCompare(a.sort_at))

          return (
            <div key={day}>
              <p className="text-xs font-semibold text-gray-400 dark:text-gray-600 uppercase tracking-wider mb-3">
                {day}
              </p>
              <div className="flex flex-col gap-1.5">
                {items.map((item) =>
                  item.kind === 'session'
                    ? <SessionGroup
                        key={item.group.session_id}
                        group={item.group}
                        onToggle={() => toggleSession(item.group.session_id)}
                      />
                    : <EntryRow key={item.entry.id} entry={item.entry} />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
