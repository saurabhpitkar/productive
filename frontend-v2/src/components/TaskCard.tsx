import { useRef, useState } from 'react'
import type { Doc } from '../types'
import { updateDoc, createDoc, addLink } from '../sync/engine'
import { useUIStore } from '../store/ui'
import { DocContextMenu } from './DocContextMenu'
import { DueDatePopover } from './DueDatePopover'

const PRIORITY_STYLE: Record<string, string> = {
  high:   'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  low:    'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
}

const STATUS_ICON: Record<string, string> = {
  todo:        'border-gray-300 dark:border-gray-600',
  in_progress: 'border-indigo-500 bg-indigo-100 dark:bg-indigo-900/40',
  done:        'border-green-500 bg-green-500',
  cancelled:   'border-gray-300 bg-gray-200 dark:bg-gray-700',
  archived:    'border-gray-200 bg-gray-100 dark:bg-gray-800',
}

function formatDate(d: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-')
    return `${m}/${day}/${y}`
  }
  const [m, day, y] = d.split('-')
  return `${m}/${day}/${y}`
}

interface Props {
  doc:       Doc
  isRoot?:   boolean   // depth-0 root: shows / purple label
  isParent?: boolean   // has children: shows chevron toggle
  depth?:    number    // nesting depth (0=root, 1=child, …); caps indent at 3
  expanded?: boolean   // whether children are visible
  onToggle?: () => void
}

export function TaskCard({ doc, isRoot = false, isParent = false, depth = 0, expanded, onToggle }: Props) {
  const { openPanel, closePanel, panelDocId } = useUIStore()
  const [menu,        setMenu]       = useState<{ x: number; y: number } | null>(null)
  const [showDuePop,  setShowDuePop] = useState(false)

  const longTimer      = useRef<ReturnType<typeof setTimeout>>()
  const longTriggered  = useRef(false)
  const touchStartPos  = useRef({ x: 0, y: 0 })
  const touchMoved     = useRef(false)

  const isDone = doc.status === 'done'

  const openMenu  = (x: number, y: number) => setMenu({ x, y })
  const closeMenu = () => setMenu(null)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    longTriggered.current = false
    touchMoved.current = false
    const t = e.touches[0]
    touchStartPos.current = { x: t.clientX, y: t.clientY }
    longTimer.current = setTimeout(() => {
      longTriggered.current = true
      openMenu(t.clientX, t.clientY)
    }, 500)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    clearTimeout(longTimer.current)
    const t = e.touches[0]
    if (Math.abs(t.clientX - touchStartPos.current.x) > 10 ||
        Math.abs(t.clientY - touchStartPos.current.y) > 10) {
      touchMoved.current = true
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    clearTimeout(longTimer.current)
    if (longTriggered.current) { longTriggered.current = false; return }
    if (touchMoved.current) return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    if (panelDocId === doc.id) closePanel()
    else openPanel(doc.id)
  }

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (panelDocId === doc.id) closePanel()
    else openPanel(doc.id)
  }

  const toggleDone = (e: React.MouseEvent) => {
    e.stopPropagation()
    updateDoc(doc.id, { status: isDone ? 'todo' : 'done' })
  }

  const toggleFlag = (e: React.MouseEvent) => {
    e.stopPropagation()
    updateDoc(doc.id, { flag: !doc.flag })
  }

  // Indentation: 20px per level, capped at depth 3
  const paddingLeft = 16 + Math.min(depth, 3) * 20

  return (
    <>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        className="group flex items-start gap-3 py-2.5 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors select-none"
        style={{ paddingLeft: `${paddingLeft}px`, paddingRight: '16px', touchAction: 'manipulation' }}
      >
        {/* Chevron for any parent (up to depth 3); status circle for leaf docs */}
        {(isParent && onToggle) ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            className="flex-shrink-0 w-5 self-center flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <button
            onClick={toggleDone}
            className="flex-shrink-0 -mx-2 w-8 self-stretch flex items-center justify-center"
            title={isDone ? 'Mark incomplete' : 'Mark complete'}
          >
            <span className={`w-4 h-4 rounded-full border-2 transition-colors flex items-center justify-center ${STATUS_ICON[doc.status]}`}>
              {isDone && (
                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
          </button>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isRoot && (
              <span className="text-[11px] font-bold text-purple-600 dark:text-purple-400 leading-none select-none">/</span>
            )}
            <p className={`text-sm font-medium leading-snug ${isDone ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
              {doc.name}
            </p>
          </div>
          {(doc.priority || doc.due_date || doc.linked_doc_ids.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {doc.priority && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PRIORITY_STYLE[doc.priority]}`}>
                  {doc.priority}
                </span>
              )}
              {doc.due_date && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {formatDate(doc.due_date)}{doc.due_time ? ` · ${doc.due_time}` : ''}
                </span>
              )}
              {doc.linked_doc_ids.length > 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {doc.linked_doc_ids.length} linked
                </span>
              )}
            </div>
          )}
        </div>

        {/* Flag */}
        <button
          onClick={toggleFlag}
          className={`flex-shrink-0 p-1 rounded transition-colors ${doc.flag ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 hover:text-amber-400'}`}
          title={doc.flag ? 'Unflag' : 'Flag'}
        >
          <svg className="w-3.5 h-3.5" fill={doc.flag ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
          </svg>
        </button>
      </div>

      {menu && (
        <DocContextMenu
          doc={doc}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onEdit={() => openPanel(doc.id)}
          onUpdateDue={() => setShowDuePop(true)}
          onCreateLinked={async () => {
            const newDoc = await createDoc({ name: '', body: '', status: 'todo', due_date: null, due_time: null, flag: null, list_id: null, priority: null, tags: {} })
            await addLink(doc.id, newDoc.id, 'requires')
            openPanel(newDoc.id)
          }}
        />
      )}

      {showDuePop && (
        <DueDatePopover
          doc={doc}
          onClose={() => setShowDuePop(false)}
        />
      )}
    </>
  )
}
