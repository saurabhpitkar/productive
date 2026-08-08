import { useEffect, useRef, useState } from 'react'
import { updateDoc, deleteDoc } from '../sync/engine'
import { ConfirmDialog } from './ConfirmDialog'
import { useUIStore } from '../store/ui'
import type { Doc } from '../types'


function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

interface Props {
  doc:             Doc
  x:               number
  y:               number
  onClose:         () => void
  onEdit:          () => void
  onUpdateDue:     () => void
  onCreateLinked:  () => void
}

export function DocContextMenu({ doc, x, y, onClose, onEdit, onUpdateDue, onCreateLinked }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const { panelDocId, closePanel } = useUIStore()

  // Close on outside click / Escape — suppressed while confirm dialog is open
  useEffect(() => {
    if (showConfirm) return
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', close)
    window.addEventListener('touchstart', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('touchstart', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, showConfirm])

  // Clamp to viewport so menu never goes off-screen
  const menuW  = 220
  const menuH  = 300
  const safeX  = Math.min(x, window.innerWidth  - menuW - 8)
  const safeY  = Math.min(y, window.innerHeight - menuH - 8)

  const item = (label: string, icon: React.ReactNode, action: () => void, danger = false) => (
    <button
      type="button"
      onMouseDown={e => { e.stopPropagation(); action() }}
      onTouchStart={e => { e.stopPropagation(); action() }}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors rounded-lg ${
        danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      <span className="flex-shrink-0 w-4 h-4">{icon}</span>
      {label}
    </button>
  )

  const handleDueTomorrow = async () => {
    onClose()
    await updateDoc(doc.id, { due_date: tomorrowISO(), due_time: doc.due_time ?? null })
  }

  const handleToggleFlag = async () => {
    onClose()
    await updateDoc(doc.id, { flag: !doc.flag })
  }

  const handleConfirmDelete = async () => {
    setShowConfirm(false)
    onClose()
    if (panelDocId === doc.id) closePanel()
    await deleteDoc(doc.id)
  }

  return (
    <>
      <div
        ref={menuRef}
        style={{ position: 'fixed', top: safeY, left: safeX, zIndex: 250, width: menuW }}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl p-1.5"
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
      >
        <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 truncate border-b border-gray-100 dark:border-gray-800 mb-1">
          {doc.name}
        </p>

        {item('Edit / View', <EditIcon />, () => { onClose(); onEdit() })}
        {item('Create linked doc', <LinkPlusIcon />, () => { onClose(); onCreateLinked() })}
        {item('Update due date/time', <CalendarIcon />, () => { onClose(); onUpdateDue() })}
        {item('Due tomorrow same time', <TomorrowIcon />, handleDueTomorrow)}
        {item(doc.flag ? 'Unflag' : 'Flag', <FlagIcon />, handleToggleFlag)}

        <div className="border-t border-gray-100 dark:border-gray-800 mt-1 pt-1">
          {item('Delete', <TrashIcon />, () => setShowConfirm(true), true)}
        </div>
      </div>

      {showConfirm && (
        <ConfirmDialog
          title="Delete doc"
          message={`"${doc.name}" will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={handleConfirmDelete}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  )
}

function LinkPlusIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1M12 12v6m3-3H9" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function TomorrowIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )
}
