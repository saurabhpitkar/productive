import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '../store/ui'
import { fetchReviews, fetchReview, resolveReview } from '../lib/hitl'
import { api } from '../api/client'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { HitlReview, LinkProposal, Theme } from '../types'

type FilterTab = 'pending' | 'all' | 'links'

const FIELD_LABELS: Record<string, string> = {
  name: 'Title', body: 'Body', status: 'Status', priority: 'Priority',
  due_date: 'Due date', due_time: 'Due time', flag: 'Flag',
  list_id: 'List', tags: 'Tags', hitl_required: 'HITL guard',
}

function formatValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (key === 'body' && typeof val === 'string')
    return val.length > 300 ? val.slice(0, 300) + '…' : val
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

function OutcomeBadge({ outcome }: { outcome: HitlReview['outcome'] }) {
  if (outcome === null) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      Pending
    </span>
  )
  if (outcome === 'approved') return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">Approved</span>
  )
  if (outcome === 'rejected') return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200">Rejected</span>
  )
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">Cancelled</span>
  )
}

function LinkProposalCard({
  proposal,
  themes,
  onResolve,
}: {
  proposal: LinkProposal
  themes: Theme[]
  onResolve: (id: string, outcome: 'approved' | 'rejected') => Promise<void>
}) {
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const allDocs = useLiveQuery(() => db.docs.toArray(), [])
  const docMap = new Map((allDocs ?? []).map(d => [d.id, d.name]))
  const themeMap = new Map(themes.map(t => [t.id, `[Theme] ${t.title}`]))

  const label = (id: string) =>
    docMap.get(id) ?? themeMap.get(id) ?? id.slice(0, 8) + '…'

  const sourceLabel = label(proposal.source_doc_id)
  const targetLabel = label(proposal.target_doc_id)

  const handleResolve = async (outcome: 'approved' | 'rejected') => {
    setResolving(true)
    setResolveError(null)
    try {
      await onResolve(proposal.id, outcome)
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : 'Failed to resolve')
    } finally {
      setResolving(false)
    }
  }

  const LABEL_MAP: Record<string, string> = {
    belongs_to: 'belongs to',
    requires: 'requires',
    related_to: 'related to',
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[180px]" title={sourceLabel}>
                {sourceLabel}
              </span>
              <span className="text-xs px-1.5 py-0.5 bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 rounded-full font-mono">
                {LABEL_MAP[proposal.label] ?? proposal.label}
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[180px]" title={targetLabel}>
                {targetLabel}
              </span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Similarity {(proposal.confidence * 100).toFixed(0)}% ·{' '}
              {new Date(proposal.created_at).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => handleResolve('approved')}
              disabled={resolving}
              className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => handleResolve('rejected')}
              disabled={resolving}
              className="px-3 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
          </div>
        </div>
        {resolveError && (
          <div className="px-4 pb-3">
            <p className="text-xs text-red-600 dark:text-red-400">{resolveError}</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function Reviews() {
  const [tab, setTab] = useState<FilterTab>('pending')
  const [reviews, setReviews] = useState<HitlReview[]>([])
  const [proposals, setProposals] = useState<LinkProposal[]>([])
  const [themes, setThemes] = useState<Theme[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<HitlReview | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notes, setNotes] = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { openPanel } = useUIStore()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'links') {
        setProposals(await api.getLinkProposals())
      } else {
        setReviews(await fetchReviews(tab === 'all' ? 'all' : undefined))
      }
    } catch {
      setError('Failed to load reviews')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { load() }, [load])
  useEffect(() => { api.listThemes().then(setThemes).catch(() => {}) }, [])

  const expand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      setDetail(await fetchReview(id))
    } catch {
      setExpandedId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleResolveReview = async (id: string, outcome: 'approved' | 'rejected' | 'cancelled') => {
    setResolving(true)
    try {
      await resolveReview(id, outcome, notes.trim() || undefined)
      setNotes('')
      setExpandedId(null)
      setDetail(null)
      await load()
    } catch {
      setError('Failed to resolve review')
    } finally {
      setResolving(false)
    }
  }

  const handleResolveProposal = async (id: string, outcome: 'approved' | 'rejected') => {
    await api.resolveLinkProposal(id, outcome)
    // Reload so stale proposals that were auto-rejected by the backend disappear too.
    setProposals(p => p.filter(x => x.id !== id))
  }

  const handleBulkResolve = async (outcome: 'approved' | 'rejected') => {
    const pending = tab === 'links'
      ? proposals
      : reviews.filter(r => r.outcome === null)
    if (pending.length === 0) return
    setResolving(true)
    setError(null)
    try {
      if (tab === 'links') {
        for (const p of proposals) await api.resolveLinkProposal(p.id, outcome)
        setProposals([])
      } else {
        for (const r of reviews.filter(r => r.outcome === null))
          await resolveReview(r.id, outcome, undefined)
        await load()
      }
    } catch {
      setError('Failed to resolve all')
    } finally {
      setResolving(false)
    }
  }

  const itemCount = tab === 'links' ? proposals.length : reviews.length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Reviews</h1>
          {!loading && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {itemCount} {tab === 'pending' ? 'pending' : tab === 'links' ? 'link proposals' : 'total'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {itemCount > 0 && !loading && (
            <>
              <button
                onClick={() => handleBulkResolve('approved')}
                disabled={resolving}
                className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                Approve all
              </button>
              <button
                onClick={() => handleBulkResolve('rejected')}
                disabled={resolving}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                Reject all
              </button>
            </>
          )}
          <button onClick={load} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex px-6 flex-shrink-0">
        {(['pending', 'all', 'links'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${
              tab === t
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {t === 'links' ? 'Link proposals' : t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}
        {loading && <p className="text-sm text-gray-400">Loading…</p>}

        {/* Links proposals tab */}
        {!loading && tab === 'links' && (
          <>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              Doc-to-doc similarity proposals only. Theme assignments happen automatically during Rebuild KG and are not reviewable here.
              The auto-link threshold (Settings → Links) controls which pairs appear.
            </p>
            {proposals.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-500 dark:text-gray-400">No pending link proposals.</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Link proposals appear here when "Review before applying" is enabled in Settings → Links.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {proposals.map(p => (
                  <LinkProposalCard key={p.id} proposal={p} themes={themes} onResolve={handleResolveProposal} />
                ))}
              </div>
            )}
          </>
        )}

        {/* HITL reviews (pending / all tabs) */}
        {!loading && tab !== 'links' && (
          <>
            {reviews.length === 0 && (
              <div className="text-center py-16">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {tab === 'pending' ? 'No pending reviews.' : 'No reviews yet.'}
                </p>
                {tab === 'pending' && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    Reviews appear here when an AI agent tries to update a HITL-protected doc.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col gap-3">
              {reviews.map(r => (
                <div key={r.id} className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  {/* Summary row */}
                  <button
                    onClick={() => expand(r.id)}
                    className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 text-left transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.doc_name}</p>
                        <OutcomeBadge outcome={r.outcome} />
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Agent{' '}
                        <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">
                          {r.agent_pat_prefix ?? 'unknown'}
                        </code>
                        {' · '}
                        {new Date(r.created_at).toLocaleString()}
                      </p>
                    </div>
                    <svg
                      className={`w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5 transition-transform ${expandedId === r.id ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Expanded detail */}
                  {expandedId === r.id && (
                    <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-4 space-y-4">
                      {detailLoading && !detail && <p className="text-sm text-gray-400">Loading…</p>}

                      {detail && detail.id === r.id && (
                        <>
                          <button
                            onClick={() => openPanel(r.doc_id)}
                            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            Open doc in panel →
                          </button>

                          <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-gray-50 dark:bg-gray-800 text-left">
                                    <th className="px-3 py-2 font-medium text-gray-500 dark:text-gray-400 w-24 whitespace-nowrap">Field</th>
                                    <th className="px-3 py-2 font-medium text-gray-500 dark:text-gray-400">Current</th>
                                    <th className="px-3 py-2 font-medium text-green-700 dark:text-green-400">Proposed</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                  {Object.entries(detail.proposed_payload).map(([key, val]) => (
                                    <tr key={key} className="bg-white dark:bg-gray-900">
                                      <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap align-top">
                                        {FIELD_LABELS[key] ?? key}
                                      </td>
                                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap break-all max-w-xs align-top">
                                        {detail.doc_current ? formatValue(key, detail.doc_current[key]) : '-'}
                                      </td>
                                      <td className="px-3 py-2 text-green-700 dark:text-green-300 font-mono whitespace-pre-wrap break-all max-w-xs align-top">
                                        {formatValue(key, val)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {r.outcome === null && (
                            <>
                              <textarea
                                value={notes}
                                onChange={e => setNotes(e.target.value)}
                                placeholder="Optional notes (recorded with the decision)…"
                                rows={2}
                                className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                              />
                              <div className="flex gap-2 flex-wrap">
                                <button
                                  onClick={() => handleResolveReview(r.id, 'approved')}
                                  disabled={resolving}
                                  className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => handleResolveReview(r.id, 'rejected')}
                                  disabled={resolving}
                                  className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
                                >
                                  Reject
                                </button>
                                <button
                                  onClick={() => handleResolveReview(r.id, 'cancelled')}
                                  disabled={resolving}
                                  className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium disabled:opacity-50 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          )}

                          {r.outcome !== null && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              <span className="font-medium capitalize">{r.outcome}</span>
                              {r.resolved_at && <span> · {new Date(r.resolved_at).toLocaleString()}</span>}
                              {r.human_notes && <p className="mt-1 italic">"{r.human_notes}"</p>}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
