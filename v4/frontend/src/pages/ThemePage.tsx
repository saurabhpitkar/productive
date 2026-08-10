import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { TaskList } from '../components/TaskList'
import { api } from '../api/client'
import type { Doc, Theme } from '../types'

export function ThemePage() {
  const { themeId } = useParams<{ themeId: string }>()
  const [theme, setTheme] = useState<Theme | null>(null)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descValue, setDescValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!themeId) return
    api.listThemes()
      .then(ts => {
        const t = ts.find(x => x.id === themeId) ?? null
        setTheme(t)
        setDescValue(t?.description ?? '')
      })
      .catch(() => {})
  }, [themeId])

  const saveDescription = async () => {
    if (!themeId || !theme) return
    setSaving(true)
    try {
      const updated = await api.updateTheme(themeId, { description: descValue })
      setTheme(updated)
      setEditingDesc(false)
    } catch {
      // leave editing open on error
    } finally {
      setSaving(false)
    }
  }

  const docs = useLiveQuery(async (): Promise<Doc[]> => {
    if (!themeId) return []
    return db.docs
      .filter(d => Array.isArray(d.theme_ids) && d.theme_ids.includes(themeId) && d.status !== 'archived')
      .toArray()
  }, [themeId])

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-2">
        {theme?.title ?? <span className="text-gray-400">Loading…</span>}
      </h1>

      {/* Description */}
      <div className="mb-5">
        {editingDesc ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={descValue}
              onChange={e => setDescValue(e.target.value.slice(0, 1000))}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-indigo-300 dark:border-indigo-700 rounded-lg bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              placeholder="Describe this theme (up to 1000 characters)…"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={saveDescription}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditingDesc(false); setDescValue(theme?.description ?? '') }}
                className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <span className="ml-auto text-xs text-gray-400">{descValue.length}/1000</span>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setEditingDesc(true)}
            className="w-full text-left group"
          >
            {theme?.description ? (
              <p className="text-sm text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">
                {theme.description}
              </p>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-600 italic group-hover:text-gray-500 dark:group-hover:text-gray-500 transition-colors">
                Add a description for this theme…
              </p>
            )}
          </button>
        )}
      </div>

      <TaskList
        docs={docs ?? []}
        emptyText="No docs in this theme yet. Rebuild the knowledge graph to auto-assign docs."
      />
    </div>
  )
}
