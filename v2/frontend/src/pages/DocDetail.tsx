import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { deleteDoc, updateDoc } from '../sync/engine'
import { useUIStore } from '../store/ui'
import { mdToHtml } from '../components/MarkdownEditor'

const PRIORITY_STYLE: Record<string, string> = {
  high:   'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  low:    'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{label}</dt>
      <dd className="text-sm text-gray-800 dark:text-gray-200">{children}</dd>
    </div>
  )
}

export function DocDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { openPanel } = useUIStore()

  const doc = useLiveQuery(() => (id ? db.docs.get(id) : undefined), [id])

  const allDocs = useLiveQuery(async () => db.docs.toArray(), [])

  const linkedDocs = useLiveQuery(async () => {
    if (!doc?.linked_doc_ids?.length) return []
    return db.docs.bulkGet(doc.linked_doc_ids)
  }, [doc?.linked_doc_ids])

  if (!doc) {
    return (
      <div className="max-w-2xl mx-auto py-20 text-center text-gray-400">
        Doc not found.
      </div>
    )
  }

  const isDone = doc.status === 'done'

  const STATUS_ICON: Record<string, string> = {
    todo:        'border-gray-300 dark:border-gray-600',
    in_progress: 'border-indigo-500 bg-indigo-100 dark:bg-indigo-900/40',
    done:        'border-green-500 bg-green-500',
    cancelled:   'border-gray-300 bg-gray-200 dark:bg-gray-700',
    archived:    'border-gray-200 bg-gray-100 dark:bg-gray-800',
  }

  const toggleDone = () => updateDoc(doc.id, { status: isDone ? 'todo' : 'done' })

  const handleDelete = async () => {
    if (!confirm(`Delete "${doc.name}"? This cannot be undone.`)) return
    await deleteDoc(doc.id)
    navigate('/')
  }

  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-doc-id]')
    if (a) {
      e.preventDefault()
      navigate(`/docs/${a.getAttribute('data-doc-id')}`)
    }
  }

  const tags        = doc.tags ? Object.entries(doc.tags) : []
  const bodyHtml    = doc.body ? mdToHtml(doc.body, (allDocs ?? []).filter(d => d.id !== doc.id)) : ''

  return (
    <div className="max-w-2xl mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-4 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        {/* Header */}
        <div className="flex items-start gap-3 mb-6">
          {/* Due-date completion circle */}
          {doc.due_date && (
            <button
              onClick={toggleDone}
              className={`mt-1 flex-shrink-0 w-6 h-6 rounded-full border-2 transition-colors flex items-center justify-center ${STATUS_ICON[doc.status]}`}
              title={isDone ? 'Mark incomplete' : 'Mark complete'}
            >
              {isDone && (
                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h1 className={`text-xl font-semibold leading-snug ${isDone ? 'line-through text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
              {doc.name}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                {doc.status.replace('_', ' ')}
              </span>
              {doc.priority && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_STYLE[doc.priority]}`}>
                  {doc.priority}
                </span>
              )}
              {doc.flag && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400">
                  flagged
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => openPanel(doc.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit
            </button>
            <button
              onClick={handleDelete}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Delete doc"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body (rendered markdown) */}
        {bodyHtml && (
          <div
            className="md-preview mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-xl"
            onClick={handleBodyClick}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        )}

        {/* Details */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 mb-6">
          {doc.due_date && (
            <Field label="Due date">
              {doc.due_date}{doc.due_time ? ` at ${doc.due_time}` : ''}
            </Field>
          )}
          {doc.list_id && (
            <Field label="List">
              <ListName listId={doc.list_id} />
            </Field>
          )}
          <Field label="Created">{new Date(doc.created_at).toLocaleDateString()}</Field>
          <Field label="Updated">{new Date(doc.updated_at).toLocaleDateString()}</Field>
        </dl>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">Tags</h3>
            <div className="flex flex-wrap gap-1.5">
              {tags.map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-md text-gray-700 dark:text-gray-300">
                  <span className="font-medium">{k}</span>
                  <span className="text-gray-400">:</span>
                  <span>{v}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Linked docs */}
        {(linkedDocs ?? []).filter(Boolean).length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              Linked docs ({linkedDocs!.filter(Boolean).length})
            </h3>
            <div className="flex flex-col gap-2">
              {linkedDocs!.filter(Boolean).map(linked => (
                <button
                  key={linked!.id}
                  onClick={() => navigate(`/docs/${linked!.id}`)}
                  className="flex items-center gap-3 px-3 py-2.5 text-left rounded-xl border border-gray-200 dark:border-gray-800 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors group"
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    linked!.status === 'done'        ? 'bg-green-500' :
                    linked!.status === 'in_progress' ? 'bg-indigo-500' :
                    'bg-gray-300 dark:bg-gray-600'
                  }`} />
                  <span className={`text-sm flex-1 ${linked!.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800 dark:text-gray-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400'}`}>
                    {linked!.name}
                  </span>
                  {linked!.priority && (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PRIORITY_STYLE[linked!.priority]}`}>
                      {linked!.priority}
                    </span>
                  )}
                  <svg className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ListName({ listId }: { listId: string }) {
  const list = useLiveQuery(() => db.lists.get(listId), [listId])
  return <>{list?.list_name ?? '…'}</>
}
