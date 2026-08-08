import { useState } from 'react'
import { syncEngine } from '../sync/engine'

const SLIDES = ['intro', 'setup', 'start'] as const
type Slide = typeof SLIDES[number]

function IntroSlide() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
        Productive is a self-hosted second brain where every note, decision, and task is a <strong>doc</strong> — and docs link together into a knowledge graph your AI agents can traverse.
      </p>
      <div className="space-y-3.5">
        {([
          { icon: '🔗', title: 'Capture, link, remember', desc: 'Write docs and connect them with typed links (requires, related to, up). Cross-domain links let your AI answer questions that span multiple areas of your life.' },
          { icon: '🤖', title: 'Bring your own AI', desc: 'Connect Claude or Gemini via API key. Plug in any tool via REST or MCP - Claude Desktop, custom scripts, or your own agents.' },
          { icon: '🔒', title: 'Private by default', desc: 'Self-hosted with Docker. Your data stays in SQLite on your own server. Nothing leaves unless you choose to share it.' },
        ] as const).map(({ icon, title, desc }) => (
          <div key={title} className="flex gap-3">
            <span className="text-base mt-0.5 flex-shrink-0">{icon}</span>
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SetupSlide() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
        Three things to set up in Settings before you start:
      </p>
      <div className="space-y-4">
        {([
          {
            step: '1',
            title: 'Add your AI key',
            desc: 'Settings - AI Provider. Choose Claude or Gemini and paste your API key. It is encrypted and stored locally - never sent anywhere else.',
          },
          {
            step: '2',
            title: 'Control AI write access',
            desc: 'Settings - API Access. Create a PAT for any external tool. Toggle Trusted on to let it write directly. Leave it off and every write needs your approval first (HITL gate).',
          },
          {
            step: '3',
            title: 'Set sync cadence',
            desc: 'Settings - Sync Interval. Default is 30 s when active, 3 min in background. Adjust to match how often you work across devices.',
          },
        ] as const).map(({ step, title, desc }) => (
          <div key={step} className="flex gap-3">
            <div className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center mt-0.5">
              {step}
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StartSlide({ onSeed, onFresh, loading }: { onSeed: () => void; onFresh: () => void; loading: boolean }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
        Choose how you want to begin. You can delete demo docs anytime.
      </p>
      <button
        onClick={onSeed}
        disabled={loading}
        className="w-full flex items-start gap-3 p-4 border-2 border-indigo-200 dark:border-indigo-800 hover:border-indigo-500 dark:hover:border-indigo-500 rounded-xl text-left transition-colors group disabled:opacity-60"
      >
        <div className="w-8 h-8 flex-shrink-0 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 dark:group-hover:bg-indigo-800 transition-colors">
          <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
            {loading ? 'Loading...' : 'Explore demo vault'}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-0.5">
            5 pre-linked life projects - Japan trip, career, finance, health, learning. See how a real knowledge graph feels.
          </p>
        </div>
      </button>
      <button
        onClick={onFresh}
        disabled={loading}
        className="w-full flex items-start gap-3 p-4 border-2 border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 rounded-xl text-left transition-colors group disabled:opacity-60"
      >
        <div className="w-8 h-8 flex-shrink-0 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center group-hover:bg-gray-200 dark:group-hover:bg-gray-700 transition-colors">
          <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </div>
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Start fresh</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-0.5">
            Empty vault. Create your own docs and links from scratch.
          </p>
        </div>
      </button>
    </div>
  )
}

const SLIDE_TITLES: Record<Slide, string> = {
  intro: 'Welcome to Productive',
  setup: 'Quick setup',
  start: 'How do you want to start?',
}

export function DemoSeedPrompt() {
  const params = new URLSearchParams(window.location.search)
  const [visible, setVisible] = useState(params.get('welcome') === '1')
  const [slide, setSlide]     = useState<Slide>('intro')
  const [loading, setLoading] = useState(false)
  const slideIndex = SLIDES.indexOf(slide)

  const dismiss = () => {
    window.history.replaceState({}, '', window.location.pathname)
    setVisible(false)
  }

  const loadDemo = async () => {
    setLoading(true)
    try {
      await fetch('/api/v1/auth/seed-demo', { method: 'POST', credentials: 'include' })
      await syncEngine.run()
    } finally {
      setLoading(false)
      dismiss()
    }
  }

  const loadFresh = async () => {
    setLoading(true)
    try {
      await fetch('/api/v1/auth/seed-fresh', { method: 'POST', credentials: 'include' })
      await syncEngine.run()
    } finally {
      setLoading(false)
      dismiss()
    }
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">

        {/* Header */}
        <div className="bg-indigo-600 px-6 py-5 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-white/20 rounded-xl mb-2">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-white">{SLIDE_TITLES[slide]}</h2>
        </div>

        {/* Slide content */}
        <div className="p-5 min-h-[260px]">
          {slide === 'intro' && <IntroSlide />}
          {slide === 'setup' && <SetupSlide />}
          {slide === 'start' && <StartSlide onSeed={loadDemo} onFresh={loadFresh} loading={loading} />}
        </div>

        {/* Footer: dots + nav */}
        <div className="px-5 pb-5 flex items-center justify-between">
          {/* Dot indicators */}
          <div className="flex gap-1.5">
            {SLIDES.map((s, i) => (
              <button
                key={s}
                onClick={() => setSlide(s)}
                className={`w-2 h-2 rounded-full transition-colors ${i === slideIndex ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}
              />
            ))}
          </div>

          {/* Nav buttons */}
          <div className="flex gap-2">
            {slideIndex > 0 && (
              <button
                onClick={() => setSlide(SLIDES[slideIndex - 1])}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
              >
                Back
              </button>
            )}
            {slideIndex < SLIDES.length - 1 ? (
              <button
                onClick={() => setSlide(SLIDES[slideIndex + 1])}
                className="px-4 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              >
                Next
              </button>
            ) : (
              <button
                onClick={dismiss}
                className="px-3 py-1.5 text-sm text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
              >
                Skip
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
