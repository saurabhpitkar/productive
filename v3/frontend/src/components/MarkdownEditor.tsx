import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import type { Doc } from '../types'

marked.use({ breaks: true, gfm: true })

interface Props {
  value:               string
  onChange:            (v: string) => void
  allDocs:             Doc[]
  currentDocId?:       string
  placeholder?:        string
  onWikiLinkInsert?:   (doc: Doc) => void
}

export function mdToHtml(text: string, docs: Doc[]): string {
  const withWiki = text.replace(/\[\[([^\]]+)\]\]/g, (_, name) => {
    const trimmed = name.trim()
    const doc = docs.find(d => d.name.toLowerCase() === trimmed.toLowerCase())
    if (doc) {
      return `<a data-doc-id="${doc.id}" href="/docs/${doc.id}" class="wiki-link">[[${trimmed}]]</a>`
    }
    return `<span class="wiki-link-miss">[[${trimmed}]]</span>`
  })
  const html = marked.parse(withWiki) as string
  // Add sequential data-outline-idx so DocPanel can scroll to each heading
  let idx = 0
  return html.replace(/<(h[1-6])(\s|>)/g, (_, tag, after) =>
    `<${tag} data-outline-idx="${idx++}"${after}`
  )
}

/**
 * Compute the pixel position of the caret at `pos` within `ta`.
 * Returns viewport-relative {top, left} - safe to use with `position: fixed`.
 */
function getCaretPx(ta: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  const div = document.createElement('div')
  const cs  = window.getComputedStyle(ta)
  const rect = ta.getBoundingClientRect()

  ;([
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight',
    'letterSpacing', 'lineHeight', 'textDecoration', 'textIndent',
    'textTransform', 'wordSpacing', 'tabSize',
  ] as const).forEach(prop => { (div.style as unknown as Record<string, string>)[prop] = cs[prop] })

  div.style.position   = 'fixed'
  div.style.top        = rect.top + 'px'
  div.style.left       = rect.left + 'px'
  div.style.width      = rect.width + 'px'
  div.style.height     = rect.height + 'px'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap   = 'break-word'
  div.style.overflow   = 'scroll'

  const span = document.createElement('span')
  div.appendChild(document.createTextNode(ta.value.slice(0, pos)))
  span.textContent = '​'  // zero-width space as caret marker
  div.appendChild(span)
  div.appendChild(document.createTextNode(ta.value.slice(pos)))

  document.body.appendChild(div)
  div.scrollTop = ta.scrollTop
  const spanRect = span.getBoundingClientRect()
  document.body.removeChild(div)

  return { top: spanRect.top, left: spanRect.left }
}

export function MarkdownEditor({
  value,
  onChange,
  allDocs,
  currentDocId,
  placeholder = 'Click to write… type [[ to link docs',
  onWikiLinkInsert,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focused,   setFocused]  = useState(false)
  const [wikiQuery, setWikiQuery] = useState<string | null>(null)
  const [wikiStart, setWikiStart] = useState(0)
  const [ddIdx,     setDdIdx]    = useState(0)
  const [ddPos,     setDdPos]    = useState({ top: 0, left: 0 })

  const otherDocs    = allDocs.filter(d => d.id !== currentDocId)
  const filteredWiki = wikiQuery != null
    ? otherDocs.filter(d => d.name.toLowerCase().includes(wikiQuery.toLowerCase())).slice(0, 8)
    : []

  const autoResize = () => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }

  const updateDdPos = useCallback((caretPos?: number) => {
    const ta = textareaRef.current
    if (!ta) return

    const vpH      = window.visualViewport?.height ?? window.innerHeight
    const vpW      = window.visualViewport?.width  ?? window.innerWidth
    const DD_H     = 260   // approximate max dropdown height
    const DD_W     = 280   // min dropdown width
    const LINE_H   = parseInt(window.getComputedStyle(ta).lineHeight || '20', 10)

    let caretTop: number, caretLeft: number
    if (caretPos !== undefined) {
      const c  = getCaretPx(ta, caretPos)
      caretTop  = c.top
      caretLeft = c.left
    } else {
      const r  = ta.getBoundingClientRect()
      caretTop  = r.bottom
      caretLeft = r.left
    }

    // Show below caret if room, otherwise above
    const below = caretTop + LINE_H + 4
    const above = caretTop - DD_H - 4
    const top   = below + DD_H > vpH ? Math.max(4, above) : below

    // Clamp horizontally so dropdown stays within visual viewport
    const left = Math.min(caretLeft, Math.max(0, vpW - DD_W - 8))

    setDdPos({ top, left })
  }, [])

  const checkWikiLink = useCallback((text: string, cursorPos: number) => {
    const before = text.slice(0, cursorPos)
    const match  = before.match(/\[\[([^\][\n]*)$/)
    if (match) {
      const start = cursorPos - match[0].length
      setWikiQuery(match[1])
      setWikiStart(start)
      setDdIdx(0)
      updateDdPos(start)   // position popup at the [[ marker
    } else {
      setWikiQuery(null)
    }
  }, [updateDdPos])

  const insertWikiLink = useCallback((doc: Doc) => {
    const ta = textareaRef.current
    if (!ta) return
    const cursorPos = ta.selectionStart
    const insertion = `[[${doc.name}]]`
    onChange(value.slice(0, wikiStart) + insertion + value.slice(cursorPos))
    setWikiQuery(null)
    onWikiLinkInsert?.(doc)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = wikiStart + insertion.length
      ta.setSelectionRange(pos, pos)
    })
  }, [value, wikiStart, onChange, onWikiLinkInsert])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v  = e.target.value
    const ta = e.target
    onChange(v)
    autoResize()
    // selectionStart can be unreliable during iOS composition events - defer to next frame
    requestAnimationFrame(() => {
      checkWikiLink(v, ta.selectionStart ?? v.length)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (wikiQuery !== null && filteredWiki.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setDdIdx(i => Math.min(i + 1, filteredWiki.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setDdIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter')     { e.preventDefault(); insertWikiLink(filteredWiki[ddIdx]); return }
    }
    if (e.key === 'Escape' && wikiQuery !== null) { setWikiQuery(null); return }

    // Wrap selected text with formatting syntax
    const ta = textareaRef.current
    if (ta) {
      const ss = ta.selectionStart
      const se = ta.selectionEnd
      if (ss !== se) {
        let before = '', after = ''
        if (e.key === '*')  { before = '*';  after = '*'  }
        if (e.key === '_')  { before = '_';  after = '_'  }
        if (e.key === '`')  { before = '`';  after = '`'  }
        if (e.key === '[')  { before = '[['; after = ']]' }
        if (before) {
          e.preventDefault()
          const selected = value.slice(ss, se)
          const next = value.slice(0, ss) + before + selected + after + value.slice(se)
          onChange(next)
          requestAnimationFrame(() => {
            ta.setSelectionRange(ss + before.length, se + before.length)
          })
        }
      }
    }
  }

  const handleFocus = () => {
    setFocused(true)
    requestAnimationFrame(() => autoResize())
  }

  const handleBlur = () => {
    // Small delay so wiki dropdown item clicks/taps fire before we collapse
    setTimeout(() => {
      if (document.activeElement !== textareaRef.current) {
        setFocused(false)
        setWikiQuery(null)
      }
    }, 80)
  }

  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-doc-id]')
    if (a) {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('wiki-navigate', { detail: { docId: a.getAttribute('data-doc-id') } }))
      return
    }
    setFocused(true)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoResize()
    })
  }

  // Close dropdown on click/tap outside - handles both mouse and touch
  useEffect(() => {
    if (wikiQuery === null) return
    const handler = (e: Event) => {
      const target = (e instanceof TouchEvent ? e.touches[0]?.target : (e as MouseEvent).target) as HTMLElement | null
      if (!target?.closest('[data-wiki-dropdown]')) setWikiQuery(null)
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('touchstart', handler, { passive: true })
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('touchstart', handler)
    }
  }, [wikiQuery])

  // Reposition dropdown when visual viewport changes (e.g. keyboard appears/disappears on mobile)
  useEffect(() => {
    if (wikiQuery === null) return
    const vv = window.visualViewport
    if (!vv) return
    const handler = () => updateDdPos(wikiStart)
    vv.addEventListener('resize', handler)
    vv.addEventListener('scroll', handler)
    return () => {
      vv.removeEventListener('resize', handler)
      vv.removeEventListener('scroll', handler)
    }
  }, [wikiQuery, wikiStart, updateDdPos])

  const rendered = mdToHtml(value, otherDocs)

  const wikiDropdown = wikiQuery !== null && filteredWiki.length > 0 && (
    <div
      data-wiki-dropdown
      style={{ position: 'fixed', top: ddPos.top, left: ddPos.left, zIndex: 300, minWidth: 240, maxWidth: 360 }}
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl overflow-hidden"
      onMouseDown={e => e.preventDefault()}
    >
      {filteredWiki.map((d, i) => (
        <button
          key={d.id}
          type="button"
          onClick={() => insertWikiLink(d)}
          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
            i === ddIdx
              ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <span className="text-gray-400 text-xs">↗</span>
          <span className="truncate flex-1">{d.name}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="relative">
      {focused ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          autoFocus
          className="w-full resize-none overflow-y-hidden min-h-[220px] bg-transparent text-sm text-gray-800 dark:text-gray-200 font-sans leading-relaxed focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
          style={{ height: 'auto' }}
        />
      ) : value ? (
        <div
          className="md-preview min-h-[60px] cursor-text text-sm"
          onClick={handlePreviewClick}
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      ) : (
        <div
          className="min-h-[60px] cursor-text text-sm text-gray-400 dark:text-gray-600 italic py-1"
          onClick={() => {
            setFocused(true)
            requestAnimationFrame(() => textareaRef.current?.focus())
          }}
        >
          {placeholder}
        </div>
      )}
      {wikiDropdown}
    </div>
  )
}
