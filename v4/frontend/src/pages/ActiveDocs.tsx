import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { api } from '../api/client'
import { TaskCard } from '../components/TaskCard'
import { FilterToolbar } from '../components/FilterToolbar'
import { applyFiltersAndSort } from '../lib/docFilters'
import type { Doc, StoredLink } from '../types'
import type { SortBy } from '../lib/docFilters'

type FilterPriority = NonNullable<Doc['priority']>
type Status = Doc['status']

export function ActiveDocs() {
  const [search,   setSearch]   = useState('')
  const [status,   setStatus]   = useState<Status | ''>('')
  const [priority, setPriority] = useState<FilterPriority | ''>('')
  const [sortBy,   setSortBy]   = useState<SortBy>('last_modified')
  const [allLinks, setAllLinks] = useState<StoredLink[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    api.getAllLinks().then(setAllLinks).catch(() => {})
  }, [])

  const allDocs = useLiveQuery(() => db.docs.toArray(), [])

  const docs = useMemo(() => {
    if (!allDocs) return []
    const base = status
      ? allDocs.filter(d => d.status === status)
      : allDocs.filter(d => d.status !== 'done' && d.status !== 'archived')
    return applyFiltersAndSort(base, { search, priority, sortBy })
  }, [allDocs, search, status, priority, sortBy])

  // Build hierarchy maps from all links
  const { childrenMap, childSet, parentSet } = useMemo(() => {
    const childrenMap = new Map<string, Set<string>>()
    const childSet    = new Set<string>()
    for (const link of allLinks) {
      if (link.label === 'requires') {
        if (!childrenMap.has(link.source_doc_id)) childrenMap.set(link.source_doc_id, new Set())
        childrenMap.get(link.source_doc_id)!.add(link.target_doc_id)
        childSet.add(link.target_doc_id)
      } else if (link.label === 'belongs_to') {
        if (!childrenMap.has(link.target_doc_id)) childrenMap.set(link.target_doc_id, new Set())
        childrenMap.get(link.target_doc_id)!.add(link.source_doc_id)
        childSet.add(link.source_doc_id)
      }
    }
    return { childrenMap, childSet, parentSet: new Set<string>(childrenMap.keys()) }
  }, [allLinks])

  const docMap = useMemo(() => new Map(docs.map(d => [d.id, d])), [docs])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Recursive tree render: depth 0-3 show chevron, depth 4+ uses same indent as depth 3
  function renderTree(docId: string, depth: number, visited: Set<string>): JSX.Element[] {
    if (visited.has(docId)) return []
    const doc = docMap.get(docId)
    if (!doc) return []

    const newVisited = new Set(visited)
    newVisited.add(docId)

    const isExpanded = expanded.has(docId)
    const hasChildren = parentSet.has(docId)
    // Chevrons shown up to depth 3; deeper docs are leaf-only in the UI
    const showToggle = hasChildren && depth <= 3

    const elements: JSX.Element[] = [
      <TaskCard
        key={docId}
        doc={doc}
        isRoot={depth === 0 && hasChildren}
        isParent={hasChildren}
        depth={depth}
        expanded={isExpanded}
        onToggle={showToggle ? () => toggleExpand(docId) : undefined}
      />
    ]

    if (isExpanded && hasChildren) {
      for (const childId of (childrenMap.get(docId) ?? [])) {
        elements.push(...renderTree(childId, depth + 1, newVisited))
      }
    }

    return elements
  }

  // Partition into root docs (have children, not a child) and orphans
  const { rootDocs, orphanDocs } = useMemo(() => {
    const rootDocs = docs.filter(d => parentSet.has(d.id) && !childSet.has(d.id))

    // Collect all descendant IDs reachable from roots and present in docs
    const visibleChildIds = new Set<string>()
    function collectChildren(id: string, seen: Set<string>) {
      if (seen.has(id)) return
      seen.add(id)
      for (const childId of (childrenMap.get(id) ?? [])) {
        if (docMap.has(childId)) {
          visibleChildIds.add(childId)
          collectChildren(childId, seen)
        }
      }
    }
    const seen = new Set<string>()
    for (const root of rootDocs) collectChildren(root.id, seen)

    const rootIdSet  = new Set(rootDocs.map(d => d.id))
    const orphanDocs = docs.filter(d => !rootIdSet.has(d.id) && !visibleChildIds.has(d.id))
    return { rootDocs, orphanDocs }
  }, [docs, parentSet, childSet, childrenMap, docMap])

  if (!allDocs) return null

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-3">Active Docs</h1>
      <FilterToolbar
        search={search}     onSearch={setSearch}
        status={status}     onStatus={setStatus}
        priority={priority} onPriority={setPriority}
        sortBy={sortBy}     onSort={setSortBy}
      />

      {docs.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No active docs.</p>
      )}

      {docs.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {rootDocs.flatMap(root => renderTree(root.id, 0, new Set()))}
          {orphanDocs.map(doc => (
            <TaskCard key={doc.id} doc={doc} depth={0} />
          ))}
        </div>
      )}
    </div>
  )
}
