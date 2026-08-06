import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { TaskList } from '../components/TaskList'

export function Recent() {
  const docs = useLiveQuery(async () => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 7)
    const cutoffISO = cutoff.toISOString()

    const all = await db.docs.toArray()
    return all
      .filter(d => d.updated_at >= cutoffISO && d.status !== 'archived')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [])

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-4">Recent</h1>
      <TaskList docs={docs ?? []} emptyText="No docs updated in the last 7 days." />
    </div>
  )
}
