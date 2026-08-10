import { useEffect, useRef, useState, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { api } from '../api/client'
import { useUIStore } from '../store/ui'
import type { SectionSearchResult } from '../types'

interface Props {
  onClose: () => void
}

interface DocHit {
  id:   string
  name: string
}

export function GlobalSearch({ onClose }: Props) {
  const { openPanel } = useUIStore()
  const [query,    setQuery]    = useState('')
  const [sections, setSections] = useState<SectionSearchResult[]>([])
  const [cursor,   setCursor]   = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const allDocs = useLiveQuery(() => db.docs.toArray(), [])

  const docHits: DocHit[] = query.length < 2
    ? []
    : (allDocs ?? [])
        .filter(d => d.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 5)
        .map(d => ({ id: d.id, name: d.name }))

  const fetchSections = useCallback((q: string) => {
    if (q.length < 2) { setSections([]); return }
    api.searchSections(q, 8)
      .then(setSections)
      .catch(() => setSections([]))
  }, [])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchSections(query), 300)
    return () => clearTimeout(debounceRef.current)
  }, [query, fetchSections])

  useEffect(() => { inputRef.current?.focus() }, [])

  const totalResults = docHits.length + sections.length

  useEffect(() => {
    setCursor(0)
  }, [query])

  const openDoc = (id: string) => {
    openPanel(id)
    onClose()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, totalResults - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (cursor < docHits.length) {
        openDoc(docHits[cursor].id)
      } else {
        const sec = sections[cursor - docHits.length]
        if (sec) openDoc(sec.doc_id)
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-xl bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search docs and sections…"
            className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none"
          />
          <kbd className="hidden sm:inline-flex text-xs font-mono text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
            Esc
          </kbd>
        </div>

        {/* Results */}
        {totalResults > 0 && (
          <div className="max-h-96 overflow-y-auto">
            {docHits.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                  Documents
                </p>
                {docHits.map((hit, i) => (
                  <button
                    key={hit.id}
                    onClick={() => openDoc(hit.id)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      cursor === i
                        ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-sm truncate">{hit.name}</span>
                  </button>
                ))}
              </>
            )}

            {sections.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                  Sections
                </p>
                {sections.map((sec, i) => {
                  const idx = docHits.length + i
                  return (
                    <button
                      key={`${sec.doc_id}-${sec.heading}`}
                      onClick={() => openDoc(sec.doc_id)}
                      className={`w-full flex flex-col px-4 py-2.5 text-left transition-colors ${
                        cursor === idx
                          ? 'bg-indigo-50 dark:bg-indigo-950'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                      onMouseEnter={() => setCursor(idx)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[0.6rem] font-mono text-indigo-400 dark:text-indigo-500 uppercase">
                          H{sec.heading_level}
                        </span>
                        <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{sec.heading}</span>
                      </div>
                      <span className="text-xs text-gray-400 dark:text-gray-600 truncate ml-7">{sec.doc_title}</span>
                      {sec.body_preview && (
                        <span className="text-xs text-gray-400 dark:text-gray-600 truncate ml-7 mt-0.5">{sec.body_preview}</span>
                      )}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}

        {query.length >= 2 && totalResults === 0 && (
          <p className="px-4 py-6 text-sm text-center text-gray-400 dark:text-gray-600">
            No results for &ldquo;{query}&rdquo;
          </p>
        )}

        {query.length < 2 && (
          <p className="px-4 py-4 text-xs text-center text-gray-400 dark:text-gray-600">
            Type at least 2 characters to search
          </p>
        )}
      </div>
    </div>
  )
}
