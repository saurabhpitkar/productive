import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { TaskList } from '../components/TaskList'
import { FilterToolbar } from '../components/FilterToolbar'
import { applyFiltersAndSort, toISO } from '../lib/docFilters'
import type { Doc } from '../types'
import type { SortBy } from '../lib/docFilters'

type FilterPriority = NonNullable<Doc['priority']>
type Status = Doc['status']

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function Today() {
  const [search,   setSearch]   = useState('')
  const [status,   setStatus]   = useState<Status | ''>('')
  const [priority, setPriority] = useState<FilterPriority | ''>('')
  const [sortBy,   setSortBy]   = useState<SortBy>('priority')

  const today = todayISO()

  const allDocs = useLiveQuery(() => db.docs.toArray(), [])

  const docs = useMemo(() => {
    if (!allDocs) return []
    // Base: docs due today (handles both ISO YYYY-MM-DD and legacy MM-DD-YYYY)
    const base = allDocs.filter(d => {
      if (!d.due_date) return false
      return toISO(d.due_date) === today
    })
    // Apply status filter or default exclusions
    const statusFiltered = status
      ? base.filter(d => d.status === status)
      : base.filter(d => d.status !== 'archived' && d.status !== 'cancelled')
    return applyFiltersAndSort(statusFiltered, { search, priority, sortBy })
  }, [allDocs, today, search, status, priority, sortBy])

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-3">Today</h1>
      <FilterToolbar
        search={search}   onSearch={setSearch}
        status={status}   onStatus={setStatus}
        priority={priority} onPriority={setPriority}
        sortBy={sortBy}   onSort={setSortBy}
      />
      <TaskList docs={docs} emptyText="Nothing due today." />
    </div>
  )
}
