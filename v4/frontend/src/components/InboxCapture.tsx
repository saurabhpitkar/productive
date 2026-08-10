import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { api } from '../api/client'
import { fetchAiSettings } from '../lib/ai'
import type { DocStatus, Priority } from '../types'

interface Props {
  onClose: () => void
  defaultMode?: 'ai' | 'manual'
  /** Desktop panel mode: renders inline (no overlay/backdrop, fills parent) */
  panelMode?: boolean
}

const STATUS_OPTS: { value: DocStatus; label: string }[] = [
  { value: 'todo',        label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done',        label: 'Done' },
  { value: 'cancelled',   label: 'Cancelled' },
]

const PRIORITY_OPTS: { value: Priority; label: string }[] = [
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' },
]

function Section({ title, open, onToggle, badge, children }: {
  title: string; open: boolean; onToggle: () => void; badge?: number; children: React.ReactNode
}) {
  return (
    <div className="border-t border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge !== undefined && badge > 0 && (
            <span className="normal-case font-normal text-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 rounded-full px-1.5 py-0.5 leading-none">
              {badge}
            </span>
          )}
        </span>
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  )
}

const SELECT_CLS = 'w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100'

export function InboxCapture({ onClose, defaultMode, panelMode }: Props) {
  const initMode = defaultMode ?? 'ai'

  // ── Form state ─────────────────────────────────────────────────────────────
  const [userTitle, setUserTitle] = useState('')
  const [body,      setBody]      = useState('')
  const [priority,  setPriority]  = useState<Priority | ''>('')
  const [status,    setStatus]    = useState<DocStatus | ''>('')
  const [dueDate,   setDueDate]   = useState('')
  const [dueTime,   setDueTime]   = useState('')
  const [detailsOpen,  setDetailsOpen]  = useState(false)
  const [linkedOpen,   setLinkedOpen]   = useState(initMode === 'manual')
  const [linkedIds,    setLinkedIds]    = useState<string[]>([])
  const [docSearch,    setDocSearch]    = useState('')

  // ── AI / Manual mode ───────────────────────────────────────────────────────
  const [mode, setMode] = useState<'ai' | 'manual'>(initMode)

  // ── API key check ──────────────────────────────────────────────────────────
  const [apiKeySet,   setApiKeySet]   = useState<boolean | null>(null)
  const [activeModel, setActiveModel] = useState<string | null>(null)

  useEffect(() => {
    fetchAiSettings()
      .then(s => {
        setApiKeySet(s.api_key_set)
        setActiveModel(s.model ?? null)
        if (!s.api_key_set) setMode('manual')
      })
      .catch(() => setApiKeySet(true))
  }, [])

  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const bodyRef  = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'ai') bodyRef.current?.focus()
    else titleRef.current?.focus()
  }, [mode])

  // ── Doc search for linked docs ─────────────────────────────────────────────
  const allDocs = useLiveQuery(() => db.docs.toArray(), [])
  const docResults = docSearch.length >= 2
    ? (allDocs ?? [])
        .filter(d =>
          d.name.toLowerCase().includes(docSearch.toLowerCase()) &&
          !linkedIds.includes(d.id)
        )
        .slice(0, 6)
    : []
  const linkedDocs = (allDocs ?? []).filter(d => linkedIds.includes(d.id))

  // ── Validation ─────────────────────────────────────────────────────────────
  function validateFields(): string | null {
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      return 'Due date must be in YYYY-MM-DD format'
    if (dueTime && !/^\d{2}:\d{2}$/.test(dueTime))
      return 'Due time must be in HH:MM format'
    return null
  }

  // ── Submit: AI mode ────────────────────────────────────────────────────────
  const submitAI = async () => {
    if (loading || apiKeySet === false) return
    const trimmedBody = body.trim()
    if (!trimmedBody) return

    const validErr = validateFields()
    if (validErr) { setError(validErr); return }

    // Keep linked doc names in body as routing context for the LLM
    const bodyParts: string[] = [trimmedBody]
    if (linkedDocs.length > 0)
      bodyParts.push(`Related docs: ${linkedDocs.map(d => d.name).join(', ')}`)

    setLoading(true)
    setError(null)
    try {
      await api.submitInbox(bodyParts.join('\n\n'), {
        userTitle:    userTitle.trim() || undefined,
        priority:     priority  || undefined,
        status:       status    || undefined,
        dueDate:      dueDate   || undefined,
        dueTime:      dueTime   || undefined,
        linkedDocIds: linkedIds.length > 0 ? linkedIds : undefined,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Routing failed')
      setLoading(false)
    }
  }

  // ── Submit: Manual mode ────────────────────────────────────────────────────
  const submitManual = async () => {
    if (loading) return
    const trimmedTitle = userTitle.trim()
    if (!trimmedTitle) return

    const validErr = validateFields()
    if (validErr) { setError(validErr); return }

    setLoading(true)
    setError(null)
    try {
      const doc = await api.createDoc({
        name: trimmedTitle,
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(status   ? { status:    status    as DocStatus } : {}),
        ...(priority ? { priority:  priority  as Priority  } : {}),
        ...(dueDate  ? { due_date:  dueDate                } : {}),
        ...(dueTime  ? { due_time:  dueTime                } : {}),
      })
      for (const targetId of linkedIds) {
        await api.addLink(doc.id, targetId).catch(() => {})
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setLoading(false)
    }
  }

  const submit = mode === 'ai' ? submitAI : submitManual

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
  }

  const noKey = apiKeySet === false
  const canSubmit = mode === 'ai'
    ? !loading && body.trim().length > 0
    : !loading && userTitle.trim().length > 0

  const detailsBadge = [priority, status, dueDate, dueTime].filter(Boolean).length || undefined

  // ── Shared card content ────────────────────────────────────────────────────
  const cardContent = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Capture</span>
          <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            <button
              type="button"
              disabled={noKey}
              onClick={() => { if (!noKey) setMode('ai') }}
              title={noKey ? 'Add an AI API key in Settings → AI Usage first' : undefined}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                mode === 'ai'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400'
              } ${noKey ? 'opacity-40 cursor-not-allowed' : 'hover:text-gray-700 dark:hover:text-gray-200'}`}
            >
              AI
            </button>
            <button
              type="button"
              onClick={() => { setMode('manual'); setLinkedOpen(true) }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                mode === 'manual'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Manual
            </button>
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">

        {noKey && (
          <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
            AI routing requires an API key.{' '}
            <Link to="/settings?section=ai_usage" onClick={onClose} className="font-medium underline hover:no-underline">
              Settings → AI Usage
            </Link>
          </p>
        )}

        {/* AI MODE */}
        {mode === 'ai' && (
          <>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={5}
              placeholder="What's on your mind? Describe the note, task, or idea…"
              className="w-full text-sm bg-transparent border-none outline-none resize-none text-gray-700 dark:text-gray-300 placeholder-gray-300 dark:placeholder-gray-600 leading-relaxed"
            />
            <div className="mt-2 border-t border-gray-100 dark:border-gray-800 pt-2">
              <input
                value={userTitle}
                onChange={e => setUserTitle(e.target.value)}
                placeholder="Optional title"
                className="w-full text-sm font-medium bg-transparent border-none outline-none text-gray-900 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600"
              />
              {!userTitle.trim() && (
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">
                  Leave blank — AI will decide the title
                </p>
              )}
            </div>
          </>
        )}

        {/* MANUAL MODE */}
        {mode === 'manual' && (
          <>
            <input
              ref={titleRef}
              value={userTitle}
              onChange={e => setUserTitle(e.target.value)}
              placeholder="Title (required)"
              className="w-full text-sm font-semibold bg-transparent border-none outline-none text-gray-900 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 mb-2"
            />
            <div className="border-t border-gray-100 dark:border-gray-800 pt-2">
              <textarea
                ref={bodyRef}
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={4}
                placeholder="Body (optional)"
                className="w-full text-sm bg-transparent border-none outline-none resize-none text-gray-700 dark:text-gray-300 placeholder-gray-300 dark:placeholder-gray-600 leading-relaxed"
              />
            </div>
          </>
        )}

        {error && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Details section */}
        <Section
          title="Details"
          open={detailsOpen}
          onToggle={() => setDetailsOpen(o => !o)}
          badge={detailsBadge}
        >
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">Priority</p>
                <select value={priority} onChange={e => setPriority(e.target.value as Priority | '')} className={SELECT_CLS}>
                  <option value="">None</option>
                  {PRIORITY_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">Status</p>
                <select value={status} onChange={e => setStatus(e.target.value as DocStatus | '')} className={SELECT_CLS}>
                  <option value="">None</option>
                  {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">Due date</p>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className={SELECT_CLS}
                />
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">Due time</p>
                <input
                  type="time"
                  value={dueTime}
                  onChange={e => setDueTime(e.target.value)}
                  className={SELECT_CLS}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* Linked docs section */}
        <Section
          title="Linked Docs"
          open={linkedOpen}
          onToggle={() => setLinkedOpen(o => !o)}
          badge={linkedIds.length || undefined}
        >
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={docSearch}
              onChange={e => setDocSearch(e.target.value)}
              placeholder="Search docs to link…"
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            {docResults.length > 0 && (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                {docResults.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => { setLinkedIds(ids => [...ids, d.id]); setDocSearch('') }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-100 dark:border-gray-800 last:border-b-0 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            )}
            {linkedDocs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {linkedDocs.map(d => (
                  <span key={d.id} className="flex items-center gap-1 text-xs bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-2 py-1 rounded-full">
                    {d.name}
                    <button
                      type="button"
                      onClick={() => setLinkedIds(ids => ids.filter(id => id !== d.id))}
                      className="ml-0.5 hover:text-indigo-900 dark:hover:text-indigo-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Section>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          {mode === 'ai'
            ? activeModel
              ? <>Using <span className="font-medium text-gray-500 dark:text-gray-400">{activeModel}</span> · routing runs in background</>
              : 'AI will route this to the best matching doc'
            : 'Link docs manually to build your knowledge graph'
          }
        </p>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-1.5"
          >
            {loading && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {loading ? 'Saving…' : mode === 'ai' ? 'Capture' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )

  // ── Panel mode: inline, fills parent, no backdrop ──────────────────────────
  if (panelMode) {
    return (
      <div
        className="flex flex-col h-full bg-white dark:bg-gray-900"
        onKeyDown={handleKey}
      >
        {cardContent}
      </div>
    )
  }

  // ── Modal mode: fixed overlay with backdrop ────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 pb-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-xl bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[80vh]"
        onKeyDown={handleKey}
      >
        {cardContent}
      </div>
    </div>
  )
}
