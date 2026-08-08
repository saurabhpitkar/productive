import type { Doc } from '../types'

export type SortBy = 'priority' | 'due_date' | 'name' | 'last_modified'

export function toISO(d: string): string {
  return /^\d{2}-\d{2}-\d{4}$/.test(d)
    ? `${d.slice(6)}-${d.slice(0, 2)}-${d.slice(3, 5)}`
    : d
}

const PRI: Record<string, number> = { high: 1, medium: 2, low: 3 }

export function applyFiltersAndSort(
  arr: Doc[],
  opts: { search?: string; priority?: string; sortBy: SortBy }
): Doc[] {
  let r = arr
  if (opts.priority) r = r.filter(d => d.priority === opts.priority)
  if (opts.search?.trim()) {
    const q = opts.search.trim().toLowerCase()
    r = r.filter(d => d.name.toLowerCase().includes(q))
  }
  return [...r].sort((a, b) => {
    if (opts.sortBy === 'priority') {
      return (PRI[a.priority ?? ''] ?? 4) - (PRI[b.priority ?? ''] ?? 4)
    }
    if (opts.sortBy === 'due_date') {
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return toISO(a.due_date).localeCompare(toISO(b.due_date))
    }
    if (opts.sortBy === 'last_modified') {
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    }
    return a.name.localeCompare(b.name)
  })
}
