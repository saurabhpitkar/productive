import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useUIStore } from '../store/ui'
import { useAuthStore, serverLogout } from '../store/auth'
import {
  fetchAiSettings, updateAiSettings, fetchModels,
  fetchAiContext, upsertAiContext, fetchUsage,
} from '../lib/ai'
import type { AiSettings, AiModel, UsageResponse } from '../lib/ai'
import { fetchTokens, createToken, revokeToken, setTokenTrusted } from '../lib/tokens'
import type { ApiToken, NewTokenResponse } from '../lib/tokens'
import { api } from '../api/client'
import type { LinkSettings } from '../types'

// Published list prices per 1M tokens (approximate; update as providers change)
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Claude 5
  'claude-opus-5':               { input: 15.00, output: 75.00 },
  'claude-sonnet-5':             { input: 3.00,  output: 15.00 },
  'claude-fable-5':              { input: 3.00,  output: 15.00 },
  // Claude 4
  'claude-opus-4-5':             { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':           { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5':           { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00  },
  'claude-haiku-3-5':            { input: 0.80,  output: 4.00  },
  // Gemini 3.x
  'gemini-3.6-flash':            { input: 0.15,  output: 0.60  },
  'gemini-3.5-flash':            { input: 0.15,  output: 0.60  },
  'gemini-3.5-flash-lite':       { input: 0.075, output: 0.30  },
  'gemini-3.1-pro-preview':      { input: 3.50,  output: 10.50 },
  'gemini-3.1-flash-lite':       { input: 0.075, output: 0.30  },
  // Gemini 2.5
  'gemini-2.5-pro':              { input: 1.25,  output: 10.00 },
  'gemini-2.5-flash':            { input: 0.15,  output: 0.60  },
  'gemini-2.5-flash-lite':       { input: 0.075, output: 0.30  },
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = MODEL_PRICES[model]
  if (!prices) return 0
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// ── Shared UI atoms ──────────────────────────────────────────────────────────

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle}
      className={`relative flex-shrink-0 w-11 h-6 rounded-full p-[2px] transition-colors duration-200 focus:outline-none ${on ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}>
      <span className={`block w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

function Row({ title, description, control }: { title: string; description: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{control}</div>
    </div>
  )
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide">{title}</h2>
      {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
    </div>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────

function ProfileSection() {
  const { user, logout } = useAuthStore()

  const handleLogout = async () => {
    await serverLogout()
    logout()
    window.location.href = '/login'
  }

  return (
    <div>
      <SectionHeader title="Profile" description="Your Google account connected to Productive v2" />
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-100 dark:border-gray-800">
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-10 h-10 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center flex-shrink-0">
              <span className="text-indigo-600 dark:text-indigo-400 text-sm font-semibold">
                {user?.name?.[0]?.toUpperCase() ?? 'U'}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{user?.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user?.email}</p>
          </div>
        </div>
        <Row
          title="Session"
          description="Stays logged in for 90 days on this device"
          control={<span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Active</span>}
        />
        <div className="px-4 py-4">
          <button
            onClick={handleLogout}
            className="text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 font-medium transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}


function AiSection() {
  const [settings,    setSettings]    = useState<AiSettings | null>(null)
  const [models,      setModels]      = useState<AiModel[]>([])
  const [apiKey,      setApiKey]      = useState('')
  const [voyageKey,   setVoyageKey]   = useState('')
  const [showKey,     setShowKey]     = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [saved,       setSaved]       = useState(false)
  const [contexts,    setContexts]    = useState<{ key: string; content: string }[]>([])
  const [promptLimit, setPromptLimit] = useState(10000)

  useEffect(() => {
    fetchAiSettings().then(s => { setSettings(s); setPromptLimit(s.prompt_limit) })
    fetchModels().then(setModels)
    fetchAiContext().then(setContexts)
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { prompt_limit: promptLimit }
      if (settings?.provider)  patch.provider   = settings.provider
      if (settings?.model)     patch.model      = settings.model
      if (apiKey.trim())       patch.api_key    = apiKey.trim()
      if (voyageKey.trim())    patch.voyage_api_key = voyageKey.trim()
      await updateAiSettings(patch as Parameters<typeof updateAiSettings>[0])
      if (apiKey.trim())    setApiKey('')
      if (voyageKey.trim()) setVoyageKey('')
      const fresh = await fetchAiSettings()
      setSettings(fresh)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const deleteKey = async () => {
    if (!confirm('Delete your saved API key? You will need to re-enter it to use AI features.')) return
    setSaving(true)
    try {
      await updateAiSettings({ api_key: '' })
      const fresh = await fetchAiSettings()
      setSettings(fresh)
    } finally {
      setSaving(false)
    }
  }

  const deleteVoyageKey = async () => {
    if (!confirm('Delete your saved Voyage API key? Embeddings will be disabled for this provider.')) return
    setSaving(true)
    try {
      await updateAiSettings({ voyage_api_key: '' })
      const fresh = await fetchAiSettings()
      setSettings(fresh)
    } finally {
      setSaving(false)
    }
  }

  const saveContext = async (key: string, content: string) => {
    await upsertAiContext(key, content)
    const fresh = await fetchAiContext()
    setContexts(fresh)
  }

  const claudeModels      = models.filter(m => m.provider === 'claude')
  const geminiModels      = models.filter(m => m.provider === 'gemini')
  const openrouterModels  = models.filter(m => m.provider === 'openrouter')

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="AI Assistant" description="Configure your AI provider and API key. Your key is encrypted at rest and never sent to the browser." />

      {/* Provider + model */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Provider</p>
          <div className="flex flex-wrap gap-2">
            {([
              { id: 'claude',      label: 'Claude' },
              { id: 'gemini',      label: 'Gemini' },
              { id: 'openrouter',  label: 'OpenRouter' },
            ] as const).map(p => (
              <button key={p.id} onClick={() => setSettings(s => s ? { ...s, provider: p.id, model: null } : s)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  settings?.provider === p.id
                    ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                    : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Model</p>
          <select
            value={settings?.model ?? ''}
            onChange={e => setSettings(s => s ? { ...s, model: e.target.value } : s)}
            className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100"
          >
            <option value="">Select a model...</option>
            {(settings?.provider === 'gemini'
              ? geminiModels
              : settings?.provider === 'openrouter'
                ? openrouterModels
                : claudeModels
            ).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div className="px-4 py-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              API Key
              {settings?.api_key_set && (
                <span className="ml-2 text-emerald-600 dark:text-emerald-400 normal-case font-normal">· saved ({settings.api_key_masked})</span>
              )}
            </p>
            {settings?.api_key_set && (
              <button
                onClick={deleteKey}
                disabled={saving}
                className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors disabled:opacity-50"
              >
                Delete key
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={settings?.api_key_set ? 'Enter new key to replace...' : 'Paste your API key here...'}
              className="flex-1 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100 font-mono"
            />
            <button onClick={() => setShowKey(v => !v)}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs">
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-1.5">
            Encrypted with Fernet symmetric encryption before storage. Never exposed after saving.
            {settings?.provider === 'openrouter' && (
              <> Keys start with <code className="font-mono bg-gray-100 dark:bg-gray-800 px-0.5 rounded">sk-or-v1-</code> — get one at openrouter.ai/keys.</>
            )}
          </p>
        </div>
      </div>

      {/* Voyage API key — shown for providers that use Voyage for embeddings */}
      {(settings?.provider === 'claude' || settings?.provider === 'openrouter') && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
          <div className="px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Voyage API Key
                <span className="ml-2 normal-case font-normal text-gray-400 dark:text-gray-600">— for embeddings</span>
                {settings?.voyage_api_key_set && (
                  <span className="ml-2 text-emerald-600 dark:text-emerald-400 normal-case font-normal">· saved ({settings.voyage_api_key_masked})</span>
                )}
              </p>
              {settings?.voyage_api_key_set && (
                <button
                  onClick={deleteVoyageKey}
                  disabled={saving}
                  className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors disabled:opacity-50"
                >
                  Delete key
                </button>
              )}
            </div>
            <input
              type="password"
              value={voyageKey}
              onChange={e => setVoyageKey(e.target.value)}
              placeholder={settings?.voyage_api_key_set ? 'Enter new key to replace...' : 'Paste your Voyage API key here...'}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100 font-mono"
            />
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1.5">
              Claude and OpenRouter don't have embedding endpoints.
              Add a <a href="https://www.voyageai.com" target="_blank" rel="noreferrer" className="underline hover:text-gray-500">Voyage AI</a> key to enable semantic linking (voyage-3.5).
            </p>
          </div>
        </div>
      )}

      {/* Prompt limit */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="px-4 py-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Max prompt length</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={100}
              max={50000}
              step={500}
              value={promptLimit}
              onChange={e => setPromptLimit(Number(e.target.value))}
              className="w-32 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100"
            />
            <span className="text-xs text-gray-400 dark:text-gray-500">characters</span>
          </div>
        </div>
      </div>

      {/* Context blocks */}
      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">AI Context Blocks</p>
        <p className="text-xs text-gray-400 dark:text-gray-600 mb-3">These text blocks are injected into every AI conversation as the system prompt.</p>
        {[
          { key: 'guardrails', placeholder: 'Rules and constraints for the AI (e.g. "Always respond concisely", "Never suggest deleting data")' },
          { key: 'persona',    placeholder: 'How the AI should present itself (e.g. "You are a focused productivity coach")' },
          { key: 'domain',     placeholder: 'Domain context about you and your work (e.g. "I am a researcher focused on EB1A immigration")' },
        ].map(({ key, placeholder }) => {
          const row = contexts.find(c => c.key === key)
          return (
            <div key={key} className="mb-3 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
              <p className="text-xs font-mono font-medium text-indigo-600 dark:text-indigo-400 mb-2">{key}</p>
              <textarea
                rows={3}
                defaultValue={row?.content ?? ''}
                placeholder={placeholder}
                onBlur={e => { if (e.target.value !== (row?.content ?? '')) saveContext(key, e.target.value) }}
                className="w-full text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100 resize-none font-mono leading-relaxed"
              />
            </div>
          )
        })}
      </div>

      {/* Save button */}
      <button
        onClick={save}
        disabled={saving}
        className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl transition-colors"
      >
        {saving ? 'Saving...' : saved ? 'Saved!' : 'Save AI Settings'}
      </button>

      {/* Token usage */}
      <UsageSection apiKeySet={settings?.api_key_set ?? false} />
    </div>
  )
}


function UsageSection({ apiKeySet }: { apiKeySet: boolean }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!apiKeySet) return
    setLoading(true)
    fetchUsage().then(setUsage).catch(() => null).finally(() => setLoading(false))
  }, [apiKeySet])

  if (!apiKeySet) return null

  const totalCost = (usage?.by_model ?? []).reduce(
    (sum, m) => sum + estimateCost(m.model, m.input_tokens, m.output_tokens), 0
  )

  const maxDay = Math.max(1, ...(usage?.days ?? []).map(d => d.input_tokens + d.output_tokens))

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Token usage · last 7 days</p>
        {usage && usage.total_7d && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {usage.total_7d.calls} call{usage.total_7d.calls !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {loading && (
        <div className="text-xs text-gray-400 dark:text-gray-600 py-2">Loading…</div>
      )}

      {usage && !loading && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
          {/* Summary row */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-xs text-gray-500 dark:text-gray-400">Total tokens</span>
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {fmt(usage.total_7d?.total_tokens ?? 0)}
              </span>
              <span className="text-[0.65rem] text-gray-400 dark:text-gray-600">
                {fmt(usage.total_7d?.input_tokens ?? 0)} in · {fmt(usage.total_7d?.output_tokens ?? 0)} out
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-xs text-gray-500 dark:text-gray-400">Est. cost</span>
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                ${totalCost.toFixed(4)}
              </span>
              <span className="text-[0.65rem] text-gray-400 dark:text-gray-600">list price USD</span>
            </div>
          </div>

          {/* Daily mini bar chart */}
          {(usage.days?.length ?? 0) > 0 && (
            <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <p className="text-[0.65rem] text-gray-400 dark:text-gray-600 mb-2 uppercase tracking-wide">Daily</p>
              <div className="flex items-end gap-1 h-10">
                {(usage.days ?? []).map(d => {
                  const total = d.input_tokens + d.output_tokens
                  const pct   = Math.max(4, Math.round((total / maxDay) * 100))
                  const label = d.date.slice(5) // MM-DD
                  return (
                    <div key={d.date} className="flex flex-col items-center gap-0.5 flex-1" title={`${label}: ${fmt(total)} tokens`}>
                      <div
                        className="w-full bg-indigo-400 dark:bg-indigo-600 rounded-sm"
                        style={{ height: `${pct}%` }}
                      />
                      <span className="text-[0.5rem] text-gray-400 dark:text-gray-600 truncate w-full text-center">{label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Per-model breakdown */}
          {(usage.by_model?.length ?? 0) > 0 && (
            <div className="px-4 py-3">
              <p className="text-[0.65rem] text-gray-400 dark:text-gray-600 mb-2 uppercase tracking-wide">By model</p>
              <div className="flex flex-col gap-1.5">
                {(usage.by_model ?? []).map(m => {
                  const cost = estimateCost(m.model, m.input_tokens, m.output_tokens)
                  return (
                    <div key={m.model} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">{m.model}</p>
                        <p className="text-[0.6rem] text-gray-400 dark:text-gray-600">
                          {fmt(m.input_tokens)} in · {fmt(m.output_tokens)} out · {m.calls} call{m.calls !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <span className="text-xs text-gray-600 dark:text-gray-400 font-medium flex-shrink-0">
                        ${cost.toFixed(4)}
                      </span>
                    </div>
                  )
                })}
              </div>
              <p className="text-[0.6rem] text-gray-400 dark:text-gray-600 mt-2">
                * Estimates based on published list prices. Actual billing may differ.
              </p>
            </div>
          )}

          {(usage.total_7d?.calls ?? 0) === 0 && (
            <div className="px-4 py-4 text-xs text-gray-400 dark:text-gray-600 text-center">
              No usage in the last 7 days.
            </div>
          )}
        </div>
      )}
    </div>
  )
}


function ApiTokensSection() {
  const [tokens,        setTokens]        = useState<ApiToken[]>([])
  const [newName,       setNewName]       = useState('')
  const [creating,      setCreating]      = useState(false)
  const [generated,     setGenerated]     = useState<NewTokenResponse | null>(null)
  const [copied,        setCopied]        = useState(false)
  const [showForm,      setShowForm]      = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchTokens().then(setTokens).catch(() => {})
  }, [])

  useEffect(() => {
    if (showForm) setTimeout(() => inputRef.current?.focus(), 50)
  }, [showForm])

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const result = await createToken(newName.trim())
      setGenerated(result)
      setTokens(prev => [result, ...prev])
      setNewName('')
      setShowForm(false)
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (token_id: string) => {
    if (!confirm('Revoke this token? Any agents using it will immediately lose access.')) return
    await revokeToken(token_id)
    setTokens(prev => prev.filter(t => t.token_id !== token_id))
  }

  const handleToggleTrusted = async (token_id: string, current: boolean) => {
    const next = !current
    setTokens(prev => prev.map(t => t.token_id === token_id ? { ...t, trusted: next } : t))
    try {
      await setTokenTrusted(token_id, next)
    } catch {
      setTokens(prev => prev.map(t => t.token_id === token_id ? { ...t, trusted: current } : t))
    }
  }

  const copy = () => {
    if (!generated) return
    navigator.clipboard.writeText(generated.token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const fmtDate = (iso: string | null) => {
    if (!iso) return 'Never'
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div>
      <SectionHeader
        title="API Access"
        description="Personal access tokens let external agents and scripts read and write your workspace."
      />

      {/* Generated token - shown once */}
      {generated && (
        <div className="mb-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">
            Copy this token now - it will not be shown again.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 text-xs font-mono bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 text-gray-800 dark:text-gray-200 break-all select-all">
              {generated.token}
            </code>
            <button
              onClick={copy}
              className="flex-shrink-0 px-3 py-2 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setGenerated(null)}
            className="mt-2 text-xs text-amber-600 dark:text-amber-400 hover:underline"
          >
            I've copied it, dismiss
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        {tokens.length === 0 && !showForm && (
          <p className="px-4 py-4 text-xs text-gray-400 dark:text-gray-600">No tokens yet.</p>
        )}

        {tokens.map(t => (
          <div key={t.token_id}
            className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{t.name}</p>
              <p className="text-xs text-gray-400 dark:text-gray-600 font-mono mt-0.5">
                {t.prefix}… · Created {fmtDate(t.created_at)}
                {t.last_used_at ? ` · Last used ${fmtDate(t.last_used_at)}` : ' · Never used'}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">Trusted</span>
                <Toggle on={t.trusted} onToggle={() => handleToggleTrusted(t.token_id, t.trusted)} />
              </div>
              <button
                onClick={() => handleRevoke(t.token_id)}
                className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 font-medium transition-colors"
              >
                Revoke
              </button>
            </div>
          </div>
        ))}

        {showForm && (
          <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowForm(false) }}
              placeholder="Token name (e.g. My Agent)"
              maxLength={80}
              className="flex-1 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white transition-colors"
            >
              {creating ? '…' : 'Generate'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {!showForm && (
        <button
          onClick={() => { setShowForm(true); setGenerated(null) }}
          className="mt-3 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
        >
          + Generate new token
        </button>
      )}

      <p className="mt-3 text-xs text-gray-400 dark:text-gray-600">
        Use <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">Authorization: Bearer &lt;token&gt;</code> in API requests.
        Tokens are stored as SHA-256 hashes - the plaintext is shown only once at generation.
      </p>
    </div>
  )
}

function SyncSection() {
  const { syncInterval, toggleSyncInterval, autoSave, toggleAutoSave } = useUIStore()
  return (
    <div>
      <SectionHeader title="Sync & Auto-save" />
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <Row title="Auto-save" description="Save changes 2 seconds after you stop typing"
          control={<Toggle on={autoSave} onToggle={toggleAutoSave} />} />
        <Row title="Sync frequency" description="How often to pull changes from the server"
          control={
            <button onClick={toggleSyncInterval}
              className="text-sm font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 px-3 py-1.5 rounded-lg">
              {syncInterval === 180000 ? 'Every 3 min' : 'Every 30 min'}
            </button>
          } />
      </div>
    </div>
  )
}

// ── Storage section ───────────────────────────────────────────────────────────

function StorageSection() {
  const [info, setInfo] = useState<{ mode: string; docs_container_path: string; docs_folder_configured: boolean } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null)

  useEffect(() => {
    api.getStorageInfo().then(setInfo).catch(() => {})
  }, [])

  const supportsFilePicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const handleImport = async () => {
    if (!supportsFilePicker) return
    setImportResult(null)
    try {
      // @ts-expect-error File System Access API
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' })
      setImporting(true)
      let imported = 0
      let skipped = 0
      for await (const entry of dirHandle.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.md')) { skipped++; continue }
        const file = await entry.getFile()
        const raw = await file.text()
        const title = file.name.replace(/\.md$/, '')
        // Strip YAML frontmatter for body
        let body = raw
        if (raw.startsWith('---')) {
          const close = raw.indexOf('\n---', 3)
          if (close !== -1) body = raw.slice(close + 4).trimStart()
        }
        try {
          await api.createDoc({ name: title, body })
          imported++
        } catch {
          skipped++
        }
      }
      setImportResult({ imported, skipped })
    } catch {
      // user cancelled picker
    } finally {
      setImporting(false)
    }
  }

  const isLocalFolder = info?.docs_folder_configured

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Storage"
        description="Where your docs are stored. Configure a local folder to keep your notes on your own machine."
      />

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="px-4 py-4">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${isLocalFolder ? 'bg-green-500' : 'bg-amber-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {isLocalFolder ? 'Local folder mode' : 'Docker volume mode'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {info
                  ? `Container path: ${info.docs_container_path}`
                  : 'Loading…'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {!isLocalFolder && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3">
          <p className="text-xs text-amber-800 dark:text-amber-300 font-medium mb-1">Using internal Docker volume</p>
          <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed mb-2">
            Your docs live inside a Docker-managed volume, not on your local filesystem.
            To store docs in a folder you can access directly, set <code className="font-mono bg-amber-100 dark:bg-amber-900/50 px-1 rounded">HOST_DOCS_DIR</code> in your <code className="font-mono bg-amber-100 dark:bg-amber-900/50 px-1 rounded">.env</code> and restart.
          </p>
          <div className="space-y-1">
            <p className="text-xs font-mono text-amber-700 dark:text-amber-400">
              <span className="text-amber-500">Windows:</span> HOST_DOCS_DIR=C:/Users/YourName/Documents/notes
            </p>
            <p className="text-xs font-mono text-amber-700 dark:text-amber-400">
              <span className="text-amber-500">Mac:</span> HOST_DOCS_DIR=/Users/YourName/Documents/notes
            </p>
          </div>
        </div>
      )}

      {isLocalFolder && (
        <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3">
          <p className="text-xs text-green-800 dark:text-green-300 font-medium mb-1">Local folder active</p>
          <p className="text-xs text-green-700 dark:text-green-400 leading-relaxed">
            Your docs are stored in the folder you configured via <code className="font-mono bg-green-100 dark:bg-green-900/50 px-1 rounded">HOST_DOCS_DIR</code>.
            Add, edit, or delete <code className="font-mono bg-green-100 dark:bg-green-900/50 px-1 rounded">.md</code> files there directly — changes are picked up automatically.
          </p>
        </div>
      )}

      {supportsFilePicker && (
        <div>
          <SectionHeader title="Import from local folder" description="Read .md files from a folder on your device and add them as docs." />
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 px-4 py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              {importResult ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  Done — <strong>{importResult.imported}</strong> imported · <strong>{importResult.skipped}</strong> skipped
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">Pick a folder to import its Markdown files as new docs.</p>
              )}
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              className="flex-shrink-0 px-3 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white transition-colors"
            >
              {importing ? 'Importing…' : 'Choose folder'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function LinksSection() {
  const [settings, setSettings] = useState<LinkSettings | null>(null)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [sliderValue,    setSliderValue]    = useState(82)
  const [thresholdSaving, setThresholdSaving] = useState(false)
  const [thresholdSaved,  setThresholdSaved]  = useState(false)

  useEffect(() => {
    api.getLinkSettings().then(s => {
      setSettings(s)
      setSliderValue(Math.round(s.link_auto_threshold * 100))
    }).catch(() => {})
  }, [])

  const toggle = async (key: keyof LinkSettings) => {
    if (!settings) return
    const next = { ...settings, [key]: !settings[key] }
    setSettings(next)
    setSaving(true)
    try {
      const saved = await api.updateLinkSettings({ [key]: next[key] })
      setSettings(saved)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch {
      setSettings(settings) // revert on error
    } finally {
      setSaving(false)
    }
  }

  const saveThreshold = async () => {
    if (!settings) return
    setThresholdSaving(true)
    try {
      const updated = await api.updateLinkSettings({ link_auto_threshold: sliderValue / 100 })
      setSettings(updated)
      setThresholdSaved(true)
      setTimeout(() => setThresholdSaved(false), 1500)
    } catch {
      setSliderValue(Math.round(settings.link_auto_threshold * 100))
    } finally {
      setThresholdSaving(false)
    }
  }

  if (!settings) {
    return <div className="text-sm text-gray-400 py-4">Loading…</div>
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Links"
        description="Links connect related docs to build your knowledge graph. Linking runs asynchronously after capture — links appear a few seconds after the note is saved."
      />

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        <Row
          title="Enable linking"
          description="Allow the system to automatically discover and create links between related docs."
          control={<Toggle on={settings.links_enabled} onToggle={() => toggle('links_enabled')} />}
        />
        <Row
          title="Link after capture"
          description="After a note is captured, analyze it in the background and create links to related docs."
          control={
            <Toggle
              on={settings.links_enabled && settings.links_capture}
              onToggle={() => toggle('links_capture')}
            />
          }
        />
        <Row
          title="Link during chat"
          description="Allow the AI Assistant to suggest and create links during chat sessions."
          control={
            <Toggle
              on={settings.links_enabled && settings.links_chat}
              onToggle={() => toggle('links_chat')}
            />
          }
        />
        <Row
          title="Review before applying"
          description="Send proposed links to the Reviews screen for your approval instead of applying them automatically."
          control={
            <Toggle
              on={settings.links_require_review}
              onToggle={() => toggle('links_require_review')}
            />
          }
        />
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-600 -mt-3">
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Changes are saved immediately.'}
      </p>

      {/* Similarity threshold slider */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Auto-link threshold</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Similarity score above which links are auto-applied (or queued if review is on).
            </p>
          </div>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 ml-4 shrink-0">
            {sliderValue}%
          </span>
        </div>

        <input
          type="range"
          min={65}
          max={95}
          step={1}
          value={sliderValue}
          onChange={e => setSliderValue(Number(e.target.value))}
          onMouseUp={saveThreshold}
          onTouchEnd={saveThreshold}
          className="w-full accent-indigo-600"
        />

        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-600">
          <span>65%</span>
          <span>95%</span>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed space-y-1">
          <p><span className="text-emerald-600 dark:text-emerald-400 font-medium">≥ {sliderValue}%</span> — auto-applied (or queued if "Review before applying" is on)</p>
          <p><span className="text-amber-600 dark:text-amber-400 font-medium">65% – {sliderValue - 1}%</span> — always queued for review</p>
          <p><span className="text-gray-400 dark:text-gray-600 font-medium">{"< 65%"}</span> — ignored entirely</p>
        </div>

        <p className="text-xs text-gray-400 dark:text-gray-600">
          {thresholdSaved ? '✓ Saved' : thresholdSaving ? 'Saving…' : ''}
        </p>
      </div>

      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-3">
        <p className="text-xs text-blue-800 dark:text-blue-300 font-medium mb-1">How linking works</p>
        <p className="text-xs text-blue-700 dark:text-blue-400 leading-relaxed">
          After each capture, the system embeds the new note and compares it against your existing docs.
          Pairs above a similarity threshold are linked automatically (or queued for review).
          Links are directional and labeled — <em>belongs to</em>, <em>requires</em>, or <em>related to</em>.
        </p>
      </div>

      <KgRebuildCard />
    </div>
  )
}

interface KgRebuildResult {
  docs_scanned: number
  docs_already_embedded: number
  embeddings_updated: number
  embedding_errors: number
  docs_with_embeddings: number
  pairs_above_threshold: number
  pairs_skipped_existing: number
  already_pending_review: number
  proposals_queued_for_review: number
  links_auto_applied: number
  docs_theme_assigned: number
  warning?: string
  error_detail?: string
}

function KgRebuildCard() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<KgRebuildResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRebuild = async () => {
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      const r = await api.rebuildKg() as KgRebuildResult
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rebuild failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <SectionHeader
        title="Rebuild knowledge graph"
        description="Scan your docs, generate any missing embeddings (up to 50), and surface new link proposals."
      />
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 px-4 py-4">
        {result && (
          <div className="mb-3 space-y-2">
            {result.warning && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                <p className="text-xs text-amber-800 dark:text-amber-300">{result.warning}</p>
              </div>
            )}
            {result.error_detail && (
              <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                <p className="text-xs font-mono text-red-800 dark:text-red-300 break-all">{result.error_detail}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <span className="text-gray-500 dark:text-gray-400">Docs scanned</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{result.docs_scanned}</span>
              <span className="text-gray-500 dark:text-gray-400">Already embedded</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{result.docs_already_embedded}</span>
              <span className="text-gray-500 dark:text-gray-400">New embeddings</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{result.embeddings_updated}</span>
              {result.embedding_errors > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Embedding errors</span>
                <span className="font-medium text-red-600 dark:text-red-400">{result.embedding_errors}</span>
              </>)}
              <span className="text-gray-500 dark:text-gray-400">Total with embeddings</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{result.docs_with_embeddings}</span>
              <span className="text-gray-500 dark:text-gray-400">Pairs above threshold</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{result.pairs_above_threshold}</span>
              {result.pairs_skipped_existing > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Skipped (already linked)</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{result.pairs_skipped_existing}</span>
              </>)}
              {result.links_auto_applied > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Links auto-applied</span>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{result.links_auto_applied}</span>
              </>)}
              {result.proposals_queued_for_review > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Queued for review</span>
                <span className="font-medium text-indigo-600 dark:text-indigo-400">{result.proposals_queued_for_review}</span>
              </>)}
              {result.already_pending_review > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Already in review queue</span>
                <span className="font-medium text-amber-600 dark:text-amber-400">{result.already_pending_review}</span>
              </>)}
              {result.docs_theme_assigned > 0 && (<>
                <span className="text-gray-500 dark:text-gray-400">Docs assigned to themes</span>
                <span className="font-medium text-violet-600 dark:text-violet-400">{result.docs_theme_assigned}</span>
              </>)}
            </div>
          </div>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}
        <div className="flex items-center justify-between">
          {!result && !error && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {running ? 'Running — this may take a moment…' : 'Run this after adding many docs or when proposals seem stale.'}
            </p>
          )}
          {(result || error) && <span />}
          <button
            onClick={handleRebuild}
            disabled={running}
            className="ml-auto flex-shrink-0 px-3 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-200 transition-colors"
          >
            {running ? 'Running…' : result ? 'Run again' : 'Rebuild'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Settings page ────────────────────────────────────────────────────────

const SECTIONS = ['account', 'ai_usage'] as const
type Section = typeof SECTIONS[number]

const SECTION_LABELS: Record<Section, string> = {
  account:  'Account',
  ai_usage: 'AI Usage',
}

export function Settings() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('section') ?? ''
  const active: Section = (SECTIONS as readonly string[]).includes(raw) ? raw as Section : 'account'

  const setSection = (s: Section) => setParams({ section: s })

  return (
    <div className="max-w-lg mx-auto py-6 px-4">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-5">Settings</h1>

      {/* Tab nav */}
      <div className="flex gap-1 mb-6 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl">
        {SECTIONS.map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`flex-1 text-sm py-1.5 px-1 rounded-lg font-medium transition-colors whitespace-nowrap text-center overflow-hidden ${
              active === s
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {SECTION_LABELS[s]}
          </button>
        ))}
      </div>

      {active === 'account' && (
        <div className="flex flex-col gap-8">
          <ProfileSection />
          <ApiTokensSection />
          <SyncSection />
          <StorageSection />
        </div>
      )}
      {active === 'ai_usage' && (
        <div className="flex flex-col gap-8">
          <AiSection />
          <LinksSection />
        </div>
      )}
    </div>
  )
}
