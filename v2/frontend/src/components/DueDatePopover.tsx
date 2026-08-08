import { useState } from 'react'
import { updateDoc } from '../sync/engine'
import { DatePicker, TimePicker } from './pickers'
import type { Doc } from '../types'

function tomorrowISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function normalizeToISO(d: string): string {
  if (/^\d{2}-\d{2}-\d{4}$/.test(d))
    return `${d.slice(6)}-${d.slice(0,2)}-${d.slice(3,5)}`
  return d
}

interface Props {
  doc:     Doc
  onClose: () => void
}

export function DueDatePopover({ doc, onClose }: Props) {
  const [date, setDate] = useState(doc.due_date ? normalizeToISO(doc.due_date) : tomorrowISO())
  const [time, setTime] = useState(doc.due_time ?? '10:30')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await updateDoc(doc.id, {
      due_date: date || null,
      due_time: time || null,
    })
    setSaving(false)
    onClose()
  }

  const handleClear = async () => {
    await updateDoc(doc.id, { due_date: null, due_time: null })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/40"
      onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 p-5 w-80"
        onPointerDown={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Update due date/time
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 truncate">{doc.name}</p>

        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Date</label>
            <DatePicker value={date} onChange={setDate} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Time</label>
            <TimePicker value={time} onChange={setTime} />
          </div>
        </div>

        <div className="flex justify-between mt-5">
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            Clear date
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
