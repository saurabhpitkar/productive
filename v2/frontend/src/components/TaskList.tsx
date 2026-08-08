import type { Doc } from '../types'
import { TaskCard } from './TaskCard'

interface Props {
  docs:      Doc[]
  emptyText?: string
}

export function TaskList({ docs, emptyText = 'No docs here.' }: Props) {
  if (!docs.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-600 gap-2">
        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <p className="text-sm">{emptyText}</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      {docs.map(doc => (
        <TaskCard key={doc.id} doc={doc} />
      ))}
    </div>
  )
}
