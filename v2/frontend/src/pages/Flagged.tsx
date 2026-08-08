import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { TaskList } from '../components/TaskList'
import { FilterToolbar } from '../components/FilterToolbar'
import { applyFiltersAndSort } from '../lib/docFilters'
import type { Doc } from '../types'
import type { SortBy } from '../lib/docFilters'

type FilterPriority = NonNullable<Doc['priority']>
type Status = Doc['status']

export function Flagged() {
  const [search,   setSearch]   = useState('')
  const [status,   setStatus]   = useState<Status | ''>('')
  const [priority, setPriority] = useState<FilterPriority | ''>('')
  const [sortBy,   setSortBy]   = useState<SortBy>('priority')

  const allDocs = useLiveQuery(() => db.docs.filter(d => d.flag === true).toArray(), [])

  const docs = useMemo(() => {
    if (!allDocs) return []
    const base = status
      ? allDocs.filter(d => d.status === status)
      : allDocs.filter(d => d.status !== 'archived')
    return applyFiltersAndSort(base, { search, priority, sortBy })
  }, [allDocs, search, status, priority, sortBy])

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-3">Flagged</h1>
      <FilterToolbar
        search={search}   onSearch={setSearch}
        status={status}   onStatus={setStatus}
        priority={priority} onPriority={setPriority}
        sortBy={sortBy}   onSort={setSortBy}
      />
      <TaskList docs={docs} emptyText="No flagged docs." />
    </div>
  )
}
