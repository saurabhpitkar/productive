import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { createDoc, updateDoc, addLink, removeLink } from '../sync/engine'
import { extractOutlineFromBody } from '../lib/outline'
import { MarkdownEditor } from './MarkdownEditor'
import { useUIStore } from '../store/ui'
import type { Doc, DocStatus, Priority, LinkLabel } from '../types'
import { DatePicker, TimePicker, FIELD_CLS } from './pickers'
import { api } from '../api/client'
import { DocLinkGraph } from './DocLinkGraph'

interface Props {
  docId:   string | undefined
  onClose: () => void
}

const STATUS_OPTS: DocStatus[] = ['todo', 'in_progress', 'done', 'cancelled', 'archived']
const PRIORITY_OPTS: Priority[] = ['high', 'medium', 'low']

const STATUS_DOT: Record<string, string> = {
  todo:        'bg-gray-300 dark:bg-gray-600',
  in_progress: 'bg-indigo-500',
  done:        'bg-green-500',
  cancelled:   'bg-gray-200 dark:bg-gray-700',
  archived:    'bg-gray-100 dark:bg-gray-800',
}

// â"€â"€ Pure helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function parseTags(s: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of s.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return result
}

// â"€â"€ Section accordion â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function Section({
  title, defaultOpen = false, open: controlledOpen, onToggle: externalToggle, badge, children,
}: {
  title: string; defaultOpen?: boolean; open?: boolean; onToggle?: () => void; badge?: number; children: React.ReactNode
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const doToggle = isControlled
    ? (externalToggle ?? (() => {}))
    : () => setInternalOpen(v => !v)
  return (
    <div>
      <button
        type="button"
        onClick={doToggle}
        className="w-full flex items-center justify-between py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge !== undefined && badge > 0 && (
            <span className="normal-case font-normal text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 rounded-full px-1.5 py-0.5 leading-none">{badge}</span>
          )}
        </span>
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  )
}

// â"€â"€ Label â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
      {children}
    </label>
  )
}

// â"€â"€ Sub-section toggle row (inside an accordion) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function SubSection({
  title, open, onToggle, children,
}: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between py-1 text-[11px] font-medium text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <span>{title}</span>
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  )
}

// ── DocPanel â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const LABEL_OPTS: LinkLabel[] = ['belongs_to', 'requires', 'related_to']
const LABEL_COLORS: Record<LinkLabel, string> = {
  belongs_to: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  requires:   'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  related_to: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
}

export function DocPanel({ docId, onClose }: Props) {
  const isNew = !docId
  const { openPanel, autoSave } = useUIStore()

  const doc      = useLiveQuery(() => (docId ? db.docs.get(docId) : undefined), [docId])
  const allDocs  = useLiveQuery(async () => {
    const arr = await db.docs.toArray()
    return arr.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [])
  const allLists = useLiveQuery(async () => {
    const arr = await db.lists.toArray()
    return arr.sort((a, b) => a.list_name.localeCompare(b.list_name))
  }, [])

  const [name,      setName]      = useState('')
  const [body,      setBody]      = useState('')
  const [flag,      setFlag]      = useState(false)
  const [dueDate,   setDueDate]   = useState('')
  const [dueTime,   setDueTime]   = useState('')
  const [priority,  setPriority]  = useState<Priority | ''>('')
  const [status,    setStatus]    = useState<DocStatus>('todo')
  const [listId,    setListId]    = useState('')
  const [tagsStr,   setTagsStr]   = useState('')
  const [linkedIds,     setLinkedIds]    = useState<string[]>([])
  const [wikiLinkedIds, setWikiLinkedIds]= useState<Set<string>>(new Set())
  const [linkLabels,    setLinkLabels]   = useState<Record<string, LinkLabel>>({})
  const [backlinks,        setBacklinks]        = useState<Doc[]>([])
  const [belongsToChildIds,  setBelongsToChildIds]  = useState<string[]>([])
  const [reqParentIds,     setReqParentIds]     = useState<string[]>([])
  const [linkSearch,    setLinkSearch]   = useState('')
  const [linkFilter,    setLinkFilter]   = useState<'all' | 'today' | 'not_done'>('not_done')
  const [linkListFilter, setLinkListFilter] = useState('')
  const [graphOpen,     setGraphOpen]     = useState(true)
  const [listOpen,      setListOpen]      = useState(false)
  const [noteOpen,      setNoteOpen]      = useState(false)
  const [hitlRequired,  setHitlRequired]  = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [autoSaveStatus, setAutoSaveStatus] = useState<'' | 'saved'>('')

  const initialized    = useRef(false)
  const userEdited     = useRef(false)
  const autoSaveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror of current field values for use inside setTimeout closures
  const fieldsRef = useRef({ name, body, flag, dueDate, dueTime, priority, status, listId, tagsStr, hitlRequired })
  useEffect(() => {
    fieldsRef.current = { name, body, flag, dueDate, dueTime, priority, status, listId, tagsStr, hitlRequired }
  })

  // Mark that the user has made a manual edit (prevents auto-save on initial load)
  const markEdited = () => { userEdited.current = true }

  // Reset when docId changes
  useEffect(() => {
    initialized.current = false
    userEdited.current  = false
    setAutoSaveStatus('')
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
    setName(''); setBody(''); setFlag(false); setDueDate(''); setDueTime('')
    setPriority(''); setStatus('todo'); setListId(''); setTagsStr('')
    setLinkedIds([]); setWikiLinkedIds(new Set()); setLinkLabels({}); setBacklinks([]); setLinkSearch('')
    setGraphOpen(true); setListOpen(false); setNoteOpen(false); setHitlRequired(false)
  }, [docId])


  // Prefill from doc once it loads
  useEffect(() => {
    if (!doc || initialized.current) return
    initialized.current = true
    setName(doc.name)
    setBody(doc.body)
    setNoteOpen(doc.body.length > 0)
    setHitlRequired(doc.hitl_required ?? false)
    setFlag(doc.flag ?? false)
    setDueDate(doc.due_date ?? '')
    setDueTime(doc.due_time ?? '')
    setPriority(doc.priority ?? '')
    setStatus(doc.status)
    setListId(doc.list_id ?? '')
    setTagsStr(Object.entries(doc.tags || {}).map(([k, v]) => `${k}=${v}`).join(', '))
    setLinkedIds(doc.linked_doc_ids ?? [])
  }, [doc])

  // Load link labels and backlinks from server when doc opens
  useEffect(() => {
    if (!docId) return
    let cancelled = false
    Promise.all([
      api.getLinks(docId),
      api.getBacklinks(docId),
      api.getBacklinks(docId, 'belongs_to'),
      api.getBacklinks(docId, 'requires'),
    ]).then(([links, bl, btChildren, reqParents]) => {
      if (cancelled) return
      const labels: Record<string, LinkLabel> = {}
      for (const l of links) labels[l.target_doc_id] = l.label
      setLinkLabels(labels)
      setBacklinks(bl)
      setBelongsToChildIds(btChildren.map(d => d.id))
      setReqParentIds(reqParents.map(d => d.id))
      const hasHierarchy = links.some(l => l.label === 'requires' || l.label === 'belongs_to')
        || btChildren.length > 0 || reqParents.length > 0
      setListOpen(!hasHierarchy)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [docId])

  // Core update helper (reads from ref, safe in timers)
  const doUpdateDoc = useCallback(async () => {
    if (!docId) return
    const f = fieldsRef.current
    if (!f.name.trim()) return
    await updateDoc(docId, {
      name:          f.name.trim(),
      body:          f.body,
      flag:          f.flag || null,
      due_date:      f.dueDate || null,
      due_time:      f.dueTime || null,
      priority:      (f.priority || null) as Priority | null,
      status:        f.status,
      list_id:       f.listId  || null,
      tags:          parseTags(f.tagsStr),
      hitl_required: f.hitlRequired,
    })
  }, [docId])

  // Auto-save: debounce 2s after any field change
  useEffect(() => {
    if (isNew || !autoSave || !userEdited.current) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(async () => {
      try {
        await doUpdateDoc()
        setAutoSaveStatus('saved')
        setTimeout(() => setAutoSaveStatus(''), 2000)
      } catch { /* sync error, will retry */ }
    }, 2000)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [name, body, flag, dueDate, dueTime, priority, status, listId, tagsStr, hitlRequired, isNew, autoSave, doUpdateDoc])

  const outlineItems = useMemo(() => extractOutlineFromBody(body), [body])

  const scrollToOutline = (idx: number) => {
    // Delay 150ms so MarkdownEditor's 80ms blurâ†’preview switch completes before querying the DOM
    setTimeout(() => {
      const el = document.querySelector(`[data-outline-idx="${idx}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 150)
  }

  const today = new Date().toISOString().slice(0, 10)
  const otherDocs = (allDocs ?? []).filter(d => d.id !== docId)
  const filteredLinks = otherDocs.filter(d => {
    if (linkedIds.includes(d.id)) return true  // always show already-linked docs regardless of filter
    if (linkSearch && !d.name.toLowerCase().includes(linkSearch.toLowerCase())) return false
    if (linkFilter === 'today' && d.updated_at.slice(0, 10) !== today) return false
    if (linkFilter === 'not_done' && ['done', 'cancelled', 'archived'].includes(d.status)) return false
    if (linkListFilter && d.list_id !== linkListFilter) return false
    return true
  })

  const btChildIdSet = new Set(belongsToChildIds)

  // parentLinks: docs shown above current in the flow map
  //   - outgoing 'belongs_to' links (current declared its own parent)
  //   - backlinks from docs that 'requires' current (those docs depend on current)
  const graphParentLinks = [
    // 'belongs_to' outgoing links — exclude docs that are ALSO belongs_to-children (backlink wins)
    ...linkedIds.filter(id => linkLabels[id] === 'belongs_to' && !btChildIdSet.has(id)).map(id => ({ id, label: 'belongs_to' as const })),
    // docs that 'require' current doc — exclude belongs_to-children
    ...reqParentIds.filter(id => !linkedIds.includes(id) && !btChildIdSet.has(id)).map(id => ({ id, label: 'requires' as const })),
  ]
  // childLinks: docs shown below current in the flow map
  //   - outgoing 'requires' links (current depends on these)
  //   - backlinks from docs that have 'belongs_to' → current (those are sub-docs)
  const graphChildLinks = [
    // 'requires' children that are NOT also belongs_to-children (belongs_to takes priority)
    ...linkedIds.filter(id => linkLabels[id] === 'requires' && !btChildIdSet.has(id)).map(id => ({ id, label: 'requires' as const })),
    // all belongs_to-children (solid line, no arrow)
    ...belongsToChildIds.map(id => ({ id, label: 'belongs_to' as const })),
  ]

  const handleCreateLinkedDoc = async () => {
    if (!docId) return
    const newDoc = await createDoc({ name: '', body: '', status: 'todo', due_date: null, due_time: null, flag: null, list_id: null, priority: null, tags: {}, theme_ids: [] })
    await addLink(docId, newDoc.id, 'requires')
    openPanel(newDoc.id)
  }

  const handleLinkToggle = async (targetId: string, checked: boolean) => {
    setLinkedIds(ids => checked ? [...ids, targetId] : ids.filter(id => id !== targetId))
    if (!docId) return
    if (checked) {
      const label = linkLabels[targetId] ?? 'related_to'
      await addLink(docId, targetId, label)
    } else {
      await removeLink(docId, targetId)
      setLinkLabels(prev => { const n = { ...prev }; delete n[targetId]; return n })
    }
  }

  // Called by MarkdownEditor when the user picks a doc from the [[ autocomplete dropdown
  const handleWikiLinkInsert = useCallback((doc: Doc) => {
    // Only auto-add if not already in linked docs; only track for auto-removal if newly added
    setLinkedIds(ids => {
      if (ids.includes(doc.id)) return ids
      setWikiLinkedIds(prev => new Set([...prev, doc.id]))
      if (docId) addLink(docId, doc.id, 'related_to').catch(() => {})
      return [...ids, doc.id]
    })
  }, [docId])

  // Auto-remove wiki-linked docs when their [[...]] reference is deleted from the body
  useEffect(() => {
    if (wikiLinkedIds.size === 0) return
    const names = new Set(
      [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim().toLowerCase())
    )
    wikiLinkedIds.forEach(id => {
      const doc = allDocs?.find(d => d.id === id)
      if (doc && !names.has(doc.name.toLowerCase())) {
        setWikiLinkedIds(prev => { const n = new Set(prev); n.delete(id); return n })
        setLinkedIds(ids => ids.filter(i => i !== id))
        if (docId) removeLink(docId, id).catch(() => {})
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])

  const handleLabelChange = async (targetId: string, label: LinkLabel) => {
    setLinkLabels(prev => ({ ...prev, [targetId]: label }))
    if (docId && linkedIds.includes(targetId)) {
      await addLink(docId, targetId, label)
    }
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
    try {
      const tags     = parseTags(tagsStr)
      const due_date = dueDate || null
      const due_time = dueTime || null
      const list_id  = listId  || null
      const pri      = (priority || null) as Priority | null
      if (isNew) {
        const newDoc = await createDoc({ name: name.trim(), body, flag, due_date, due_time, priority: pri, status, list_id, tags, theme_ids: [] })
        for (const tid of linkedIds) await addLink(newDoc.id, tid)
        onClose()
      } else if (docId) {
        await doUpdateDoc()
        setAutoSaveStatus('saved')
        setTimeout(() => setAutoSaveStatus(''), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  // Save-on-close when auto-save is enabled and there are pending edits
  const handleClose = async () => {
    if (!isNew && autoSave && userEdited.current && docId) {
      if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
      await doUpdateDoc().catch(() => {})
    }
    onClose()
  }

  // Wiki-link navigation from MarkdownEditor preview
  useEffect(() => {
    const handler = (e: Event) => {
      const { docId: targetId } = (e as CustomEvent<{ docId: string }>).detail
      if (targetId) openPanel(targetId)
    }
    window.addEventListener('wiki-navigate', handler)
    return () => window.removeEventListener('wiki-navigate', handler)
  }, [openPanel])

  // Escape closes panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  // â"€â"€ Reusable section content â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  // Details fields â€" compact single-column layout (works in both narrow sidebar and full mobile)
  const detailsFields = (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Due date</Label>
          <DatePicker value={dueDate} onChange={v => { setDueDate(v); markEdited() }} />
        </div>
        <div>
          <Label>Due time</Label>
          <TimePicker value={dueTime} onChange={v => { setDueTime(v); markEdited() }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Priority</Label>
          <select id="doc-priority" name="doc-priority" value={priority}
            onChange={e => { setPriority(e.target.value as Priority | ''); markEdited() }}
            className={FIELD_CLS}>
            <option value="">None</option>
            {PRIORITY_OPTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <Label>Status</Label>
          <select id="doc-status" name="doc-status" value={status}
            onChange={e => { setStatus(e.target.value as DocStatus); markEdited() }}
            className={FIELD_CLS}>
            {STATUS_OPTS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
      </div>
      <div>
        <Label>List</Label>
        <select id="doc-list" name="doc-list" value={listId}
          onChange={e => { setListId(e.target.value); markEdited() }}
          className={FIELD_CLS}>
          <option value="">None</option>
          {(allLists ?? []).map(l => <option key={l.id} value={l.id}>{l.list_name}</option>)}
        </select>
      </div>
      <div>
        <Label>Tags (key=value, comma-separated)</Label>
        <input id="doc-tags" name="doc-tags" autoComplete="off" value={tagsStr}
          onChange={e => { setTagsStr(e.target.value); markEdited() }}
          placeholder="work=yes, project=alpha" className={FIELD_CLS} />
      </div>
      <div className="flex items-center justify-between py-1">
        <div>
          <Label>Human review required</Label>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
            Untrusted agent writes will queue for your approval
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={hitlRequired}
          onClick={() => { setHitlRequired(v => !v); markEdited() }}
          className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${hitlRequired ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${hitlRequired ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>
    </div>
  )

  // Outline items list â€" clicking scrolls body to that heading
  const outlineList = outlineItems.length > 0 ? (
    <div className="flex flex-col gap-0.5">
      {outlineItems.map((item, i) => (
        <button
          key={i}
          type="button"
          onClick={() => scrollToOutline(i)}
          style={{ paddingLeft: `${(item.level - 1) * 10}px` }}
          className="flex items-baseline gap-1 text-xs text-gray-500 dark:text-gray-400 py-0.5 hover:text-indigo-600 dark:hover:text-indigo-400 text-left transition-colors"
        >
          <span className="text-gray-300 dark:text-gray-600 font-mono flex-shrink-0 text-[10px]">{'#'.repeat(item.level)}</span>
          <span className="truncate">{item.text}</span>
        </button>
      ))}
    </div>
  ) : (
    <p className="text-xs text-gray-400 dark:text-gray-500 py-1">No headings yet.</p>
  )

  // Linked docs list + search + label picker
  const linkedDocsList = (
    <div className="flex flex-col gap-2">
      {/* Create linked doc CTA */}
      {!isNew && (
        <button
          type="button"
          onClick={handleCreateLinkedDoc}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 rounded-lg transition-colors w-full"
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create linked doc
        </button>
      )}

      <input value={linkSearch} onChange={e => setLinkSearch(e.target.value)}
        placeholder="Search docs to link..."
        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />

      {/* Quick filters */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(['all', 'today', 'not_done'] as const).map(f => (
          <button
            key={f}
            type="button"
            onClick={() => setLinkFilter(f)}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
              linkFilter === f
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {f === 'all' ? 'All' : f === 'today' ? 'Updated today' : 'Active'}
          </button>
        ))}
        {(allLists ?? []).length > 0 && (
          <select
            value={linkListFilter}
            onChange={e => setLinkListFilter(e.target.value)}
            className="ml-auto text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-0 rounded-full px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
          >
            <option value="">All lists</option>
            {(allLists ?? []).map(l => (
              <option key={l.id} value={l.id}>{l.list_name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="rounded-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
        {filteredLinks.slice(0, 40).map(d => {
          const isLinked = linkedIds.includes(d.id)
          const label = linkLabels[d.id] ?? 'related_to'
          return (
            <div key={d.id}
              className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/50">
              <input type="checkbox" checked={isLinked}
                onChange={e => handleLinkToggle(d.id, e.target.checked)}
                className="rounded text-indigo-600 flex-shrink-0 cursor-pointer" />
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[d.status]}`} />
              <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 cursor-pointer"
                onClick={() => handleLinkToggle(d.id, !isLinked)}>{d.name}</span>
              {isLinked && (
                <select
                  value={label}
                  onChange={e => handleLabelChange(d.id, e.target.value as LinkLabel)}
                  onClick={e => e.stopPropagation()}
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border-0 outline-none cursor-pointer flex-shrink-0 ${LABEL_COLORS[label]}`}
                >
                  {LABEL_OPTS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
            </div>
          )
        })}
        {filteredLinks.length === 0 && <p className="text-xs text-gray-400 text-center py-3">No docs.</p>}
      </div>
    </div>
  )

  // Backlinks section
  const backlinksList = backlinks.length > 0 ? (
    <div className="flex flex-col gap-0.5">
      {backlinks.map(d => (
        <button key={d.id} type="button"
          onClick={() => openPanel(d.id)}
          className="flex items-center gap-2 px-1 py-1 text-xs text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 text-left transition-colors rounded">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[d.status]}`} />
          <span className="truncate">{d.name}</span>
        </button>
      ))}
    </div>
  ) : (
    <p className="text-xs text-gray-400 dark:text-gray-500 py-1">No docs link here yet.</p>
  )

  // â"€â"€ Render â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  return (
    <div className="flex flex-col h-full w-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-hidden pt-safe">

      {/* â"€â"€ Header â"€â"€ */}
      <div className="flex items-center gap-2 px-4 h-14 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        <button onClick={handleClose}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors flex-shrink-0"
          title="Close">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Editable name â€" the only place the name appears */}
        <input
          id="doc-name"
          name="doc-name"
          autoComplete="off"
          value={name}
          onChange={e => { setName(e.target.value); markEdited() }}
          placeholder={isNew ? 'New doc' : 'Untitled'}
          autoFocus={isNew}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          className="flex-1 min-w-0 bg-transparent focus:outline-none font-semibold text-sm text-gray-800 dark:text-gray-200 placeholder-gray-300 dark:placeholder-gray-600"
        />

        {/* Auto-save indicator */}
        {autoSaveStatus === 'saved' && (
          <span className="text-xs text-green-500 dark:text-green-400 flex-shrink-0">Saved</span>
        )}

        {/* Flag */}
        <button onClick={() => { setFlag(f => !f); markEdited() }}
          className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
            flag ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600 hover:text-amber-400'
          }`} title={flag ? 'Unflag' : 'Flag'}>
          <svg className="w-4 h-4" fill={flag ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
          </svg>
        </button>

        {/* Save / Create button â€" always shown */}
        <button onClick={handleSave} disabled={saving || !name.trim()}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0">
          {saving ? 'Savingâ€¦' : isNew ? 'Create' : 'Save'}
        </button>
      </div>

      {/* â"€â"€ Mobile layout (single scrollable column) â"€â"€ */}
      <div className="md:hidden flex-1 overflow-y-auto px-4 pt-2 pb-8 flex flex-col gap-0 divide-y divide-gray-100 dark:divide-gray-800">

        {/* 1. Details */}
        <Section title="Details">
          {detailsFields}
        </Section>

        {/* 2. Outline */}
        <Section title="Outline" badge={outlineItems.length}>
          {outlineList}
        </Section>

        {/* 3. Body / Note */}
        <Section title="Note" open={noteOpen} onToggle={() => setNoteOpen(v => !v)}>
          <div className="min-h-[200px]">
            <MarkdownEditor value={body} onChange={v => { setBody(v); markEdited() }}
              allDocs={allDocs ?? []} currentDocId={docId}
              onWikiLinkInsert={handleWikiLinkInsert}
              placeholder="Write detailed notes in markdown and link docs using [[" />
          </div>
        </Section>

        {/* 4. Linked Docs */}
        <Section title="Linked docs" defaultOpen={true} badge={linkedIds.length}>
          {!isNew && (graphParentLinks.length > 0 || graphChildLinks.length > 0) && (
            <SubSection title="Flow map" open={graphOpen} onToggle={() => setGraphOpen(v => !v)}>
              <DocLinkGraph
                docId={docId!}
                docName={name}
                docStatus={status}
                parentLinks={graphParentLinks}
                childLinks={graphChildLinks}
                onDocClick={openPanel}
                compact
                className="mb-1"
              />
            </SubSection>
          )}
          <SubSection title="All linked docs" open={listOpen} onToggle={() => setListOpen(v => !v)}>
            {linkedDocsList}
          </SubSection>
        </Section>

        {/* 5. Backlinks */}
        {!isNew && (
          <Section title="Backlinks" badge={backlinks.length}>
            {backlinksList}
          </Section>
        )}
      </div>

      {/* â"€â"€ Desktop layout (two columns) â"€â"€ */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">

        {/* Left: body only */}
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8 flex flex-col gap-3">
          <Section title="Note" open={noteOpen} onToggle={() => setNoteOpen(v => !v)}>
            <div className="min-h-[280px]">
              <MarkdownEditor value={body} onChange={v => { setBody(v); markEdited() }}
                allDocs={allDocs ?? []} currentDocId={docId}
                onWikiLinkInsert={handleWikiLinkInsert}
                placeholder="Write detailed notes in markdown and link docs using [[" />
            </div>
          </Section>
        </div>

        {/* Right sidebar: Outline â†’ Details â†’ Linked Docs */}
        <div className="w-60 flex-shrink-0 border-l border-gray-100 dark:border-gray-800 overflow-y-auto px-4 pt-2 pb-8 flex flex-col gap-0 divide-y divide-gray-100 dark:divide-gray-800">
          <Section title="Outline" defaultOpen={true} badge={outlineItems.length}>
            {outlineList}
          </Section>
          <Section title="Details">
            {detailsFields}
          </Section>
          <Section title="Linked docs" defaultOpen={true} badge={linkedIds.length}>
            {!isNew && (graphParentLinks.length > 0 || graphChildLinks.length > 0) && (
              <SubSection title="Flow map" open={graphOpen} onToggle={() => setGraphOpen(v => !v)}>
                <DocLinkGraph
                  docId={docId!}
                  docName={name}
                  docStatus={status}
                  parentLinks={graphParentLinks}
                  childLinks={graphChildLinks}
                  onDocClick={openPanel}
                  className="mb-1"
                />
              </SubSection>
            )}
            <SubSection title="All linked docs" open={listOpen} onToggle={() => setListOpen(v => !v)}>
              {linkedDocsList}
            </SubSection>
          </Section>
          {!isNew && (
            <Section title="Backlinks" badge={backlinks.length}>
              {backlinksList}
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
