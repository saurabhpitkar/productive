import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { marked } from 'marked'
import { sendChat, fetchAiSettings } from '../lib/ai'
import type { AiSettings } from '../lib/ai'
import { syncEngine } from '../sync/engine'
import { useUIStore } from '../store/ui'

marked.use({ breaks: true, gfm: true })

interface LocalMessage {
  role:    'user' | 'assistant'
  content: string
  docs?:   { id: string; name: string }[]
}

interface Props {
  onClose?: () => void
}

const WELCOME = `Hi! I'm your Productive assistant. I can help you:
- **Create or summarize docs** - "Create a doc for my meeting tomorrow"
- **Answer questions** - "What docs do I have about Seattle?"
- **Plan your day** - "What should I focus on today?"

How can I help?`

const WELCOME_HTML = marked.parse(WELCOME) as string

/** Replace [[Name|id]] with a clickable <a> element before markdown parse */
function processDocLinks(text: string | undefined): string {
  if (!text) return ''
  return text.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    (_, name, id) => `<a class="doc-ref" data-doc-id="${id}" href="#">${name}</a>`
  )
}

export function AiPanel({ onClose }: Props) {
  const [messages,   setMessages]   = useState<LocalMessage[]>([])
  const [input,      setInput]      = useState('')
  const [loading,    setLoading]    = useState(false)
  const [tooling,    setTooling]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [settings,   setSettings]   = useState<AiSettings | null>(null)
  const [settingsOk, setSettingsOk] = useState(false)
  const bottomRef   = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const navigate    = useNavigate()
  const { openPanel } = useUIStore()

  useEffect(() => {
    fetchAiSettings()
      .then(s => { setSettings(s); setSettingsOk(s.api_key_set) })
      .catch(() => setSettingsOk(false))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const promptLimit = settings?.prompt_limit ?? 10000

  const handleDocClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a.doc-ref')
    if (anchor) {
      e.preventDefault()
      openPanel(anchor.getAttribute('data-doc-id') ?? '')
    }
  }

  const send = async () => {
    const text = input.slice(0, promptLimit).trim()
    if (!text || loading) return
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setError(null)

    const userMsg: LocalMessage = { role: 'user', content: text }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setLoading(true)

    try {
      const toolingTimer = setTimeout(() => setTooling(true), 1000)
      const apiMessages  = newMsgs.map(m => ({ role: m.role, content: m.content }))
      const reply        = await sendChat(apiMessages)
      clearTimeout(toolingTimer)
      setTooling(false)
      setMessages(prev => [...prev, {
        role:    'assistant',
        content: reply.content,
        docs:    reply.affected_docs,
      }])
      if (reply.tools_used) syncEngine.run()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setTooling(false)
      setLoading(false)
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  if (!settingsOk) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4 p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center">
          <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.338 2.798H4.14c-1.368 0-2.337-1.798-1.337-2.798L4 15.3" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">API key not configured</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
            Add your Claude or Gemini API key in Settings → AI Assistant to start chatting.
          </p>
        </div>
        <button
          onClick={() => { onClose?.(); navigate('/settings') }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Go to Settings
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full font-sans text-sm leading-relaxed">

      {/* Header - safe-area top padding for PWA notch/status bar */}
      <div
        className="flex items-center justify-between px-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))', paddingBottom: '0.5rem' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400 tracking-wide uppercase">
            AI Assistant
          </span>
          {settings?.model && (
            <span className="text-xs text-gray-400 dark:text-gray-600">
              · {settings.model.split('-').slice(0, 3).join('-')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMessages([])}
            title="Clear chat"
            className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Close"
              className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.length === 0 && (
          <div
            className="text-xs text-gray-400 dark:text-gray-500 leading-loose [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-0.5 [&_strong]:font-semibold [&_strong]:text-gray-500 dark:[&_strong]:text-gray-400 [&_p]:mb-1"
            dangerouslySetInnerHTML={{ __html: WELCOME_HTML }}
          />
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-0.5 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <span className="text-[0.65rem] text-gray-400 dark:text-gray-600 px-1">
              {m.role === 'user' ? 'you' : 'assistant'}
            </span>

            {m.role === 'user' ? (
              <div className="max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed break-words bg-indigo-600 text-white whitespace-pre-wrap">
                {m.content}
              </div>
            ) : (
              <div
                className="max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed break-words bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5 [&_li]:mb-0.5 [&_strong]:font-semibold [&_code]:bg-gray-200 dark:[&_code]:bg-gray-700 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.75em] [&_.doc-ref]:text-indigo-600 dark:[&_.doc-ref]:text-indigo-400 [&_.doc-ref]:underline [&_.doc-ref]:cursor-pointer [&_.doc-ref]:font-medium [&_h1]:font-bold [&_h1]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold"
                onClick={handleDocClick}
                dangerouslySetInnerHTML={{
                  __html: marked.parse(processDocLinks(m.content)) as string,
                }}
              />
            )}

            {/* Doc chips - clickable shortcuts to open the referenced doc */}
            {m.role === 'assistant' && m.docs && m.docs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-0.5 max-w-[90%]">
                {m.docs.map(doc => (
                  <button
                    key={doc.id}
                    onClick={() => openPanel(doc.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 text-[0.65rem] font-medium border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
                  >
                    <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    {doc.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-start">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-xl px-3 py-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              {tooling ? (
                <>
                  <svg className="w-3 h-3 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  <span>Working…</span>
                </>
              ) : (
                <span className="animate-pulse">···</span>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-gray-100 dark:border-gray-800 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKey}
            placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"
            rows={3}
            maxLength={promptLimit}
            className="flex-1 resize-none text-sm bg-transparent focus:outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 leading-relaxed"
            style={{ minHeight: '4.5rem', maxHeight: '10rem' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-indigo-600 disabled:opacity-40 hover:bg-indigo-700 transition-colors"
            title="Send (Enter)"
          >
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5-5 5M6 12h12" />
            </svg>
          </button>
        </div>
        {input.length > promptLimit * 0.85 && (
          <p className="text-[0.6rem] text-gray-400 mt-0.5 text-right">
            {input.length}/{promptLimit}
          </p>
        )}
      </div>
    </div>
  )
}
