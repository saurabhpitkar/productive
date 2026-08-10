export interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  role:           'assistant'
  content:        string
  usage?:         unknown
  tools_used?:    boolean
  affected_docs?: { id: string; name: string }[]
}

export interface UsageDay {
  date:          string
  input_tokens:  number
  output_tokens: number
  calls:         number
}

export interface UsageByModel {
  model:         string
  provider:      string
  input_tokens:  number
  output_tokens: number
  calls:         number
}

export interface UsageResponse {
  days:     UsageDay[]
  by_model: UsageByModel[]
  total_7d: {
    input_tokens:  number
    output_tokens: number
    total_tokens:  number
    calls:         number
  }
}

export interface AiModel {
  id:       string
  label:    string
  provider: string
}

export interface AiSettings {
  provider:              string | null
  model:                 string | null
  api_key_masked:        string | null
  api_key_set:           boolean
  voyage_api_key_set:    boolean
  voyage_api_key_masked: string | null
  prompt_limit:          number
  context_enabled:       boolean
  display_name:          string | null
  avatar_url:            string | null
  google_email:          string | null
}

// v4 backend has no /ai/models endpoint — model list is static
const MODELS: AiModel[] = [
  // Claude 5
  { id: 'claude-opus-5',               label: 'Claude Opus 5',        provider: 'claude' },
  { id: 'claude-sonnet-5',             label: 'Claude Sonnet 5',      provider: 'claude' },
  { id: 'claude-fable-5',              label: 'Claude Fable 5',       provider: 'claude' },
  // Claude 4
  { id: 'claude-opus-4-5',             label: 'Claude Opus 4.5',      provider: 'claude' },
  { id: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6',    provider: 'claude' },
  // Claude Haiku
  { id: 'claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5',     provider: 'claude' },
  { id: 'claude-haiku-3-5',            label: 'Claude Haiku 3.5',     provider: 'claude' },
  // Gemini 3.x
  { id: 'gemini-3.6-flash',            label: 'Gemini 3.6 Flash',          provider: 'gemini' },
  { id: 'gemini-3.5-flash',            label: 'Gemini 3.5 Flash',          provider: 'gemini' },
  { id: 'gemini-3.5-flash-lite',       label: 'Gemini 3.5 Flash Lite',     provider: 'gemini' },
  { id: 'gemini-3.1-pro-preview',      label: 'Gemini 3.1 Pro (Preview)',   provider: 'gemini' },
  { id: 'gemini-3.1-flash-lite',       label: 'Gemini 3.1 Flash Lite',     provider: 'gemini' },
  // Gemini 2.5
  { id: 'gemini-2.5-pro',              label: 'Gemini 2.5 Pro',             provider: 'gemini' },
  { id: 'gemini-2.5-flash',            label: 'Gemini 2.5 Flash',           provider: 'gemini' },
  { id: 'gemini-2.5-flash-lite',       label: 'Gemini 2.5 Flash Lite',      provider: 'gemini' },
  // OpenRouter — OpenAI
  { id: 'openai/gpt-4o',               label: 'GPT-4o',                     provider: 'openrouter' },
  { id: 'openai/gpt-4o-mini',          label: 'GPT-4o Mini',                provider: 'openrouter' },
  { id: 'openai/o3',                   label: 'OpenAI o3',                  provider: 'openrouter' },
  { id: 'openai/o4-mini',              label: 'OpenAI o4-mini',             provider: 'openrouter' },
  // OpenRouter — Anthropic
  { id: 'anthropic/claude-opus-5',     label: 'Claude Opus 5 (OR)',         provider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-5',   label: 'Claude Sonnet 5 (OR)',       provider: 'openrouter' },
  // OpenRouter — Google
  { id: 'google/gemini-2.5-pro',       label: 'Gemini 2.5 Pro (OR)',        provider: 'openrouter' },
  { id: 'google/gemini-2.5-flash',     label: 'Gemini 2.5 Flash (OR)',      provider: 'openrouter' },
  // OpenRouter — Meta
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B',       provider: 'openrouter' },
  { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick',           provider: 'openrouter' },
  // OpenRouter — Mistral
  { id: 'mistralai/mistral-large',     label: 'Mistral Large',              provider: 'openrouter' },
  { id: 'mistralai/mistral-small',     label: 'Mistral Small',              provider: 'openrouter' },
  // OpenRouter — DeepSeek
  { id: 'deepseek/deepseek-r1',        label: 'DeepSeek R1',                provider: 'openrouter' },
  { id: 'deepseek/deepseek-chat',      label: 'DeepSeek V3',                provider: 'openrouter' },
]

export async function fetchModels(): Promise<AiModel[]> {
  return MODELS
}

export async function fetchAiSettings(): Promise<AiSettings> {
  const r = await fetch('/api/v1/ai/settings', { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to fetch AI settings')
  return r.json()
}

export async function updateAiSettings(patch: Partial<{
  provider: string; model: string; api_key: string; voyage_api_key: string;
  prompt_limit: number; context_enabled: boolean; display_name: string;
}>): Promise<void> {
  const r = await fetch('/api/v1/ai/settings', {
    method:  'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  })
  if (!r.ok) throw new Error('Failed to save settings')
}

export async function sendChat(
  messages: ChatMessage[],
  systemPrompt?: string,
): Promise<ChatResponse> {
  const r = await fetch('/api/v1/ai/chat', {
    method:  'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messages, system_prompt: systemPrompt }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err.detail ?? `API error ${r.status}`)
  }
  // Backend returns { response, tools_used, affected_docs } — adapt to ChatResponse shape
  const data = await r.json()
  return {
    role:          'assistant',
    content:       data.response ?? '',
    tools_used:    data.tools_used,
    affected_docs: data.affected_docs,
  }
}

// v4 backend returns a single object {guardrails, persona, domain}.
// Adapt to the array shape that Settings.tsx expects.
export async function fetchAiContext(): Promise<{ key: string; content: string }[]> {
  const r = await fetch('/api/v1/ai/context', { credentials: 'include' })
  if (!r.ok) return []
  const data = await r.json()
  if (Array.isArray(data)) return data
  return Object.entries(data as Record<string, string>).map(([key, content]) => ({ key, content }))
}

// v4 backend uses PATCH /ai/context with a partial body {guardrails?, persona?, domain?}
export async function upsertAiContext(key: string, content: string): Promise<void> {
  await fetch('/api/v1/ai/context', {
    method:  'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ [key]: content }),
  })
}

export async function deleteAiContext(key: string): Promise<void> {
  await fetch(`/api/v1/ai/context/${key}`, { method: 'DELETE', credentials: 'include' })
}

export async function fetchUsage(): Promise<UsageResponse> {
  const r = await fetch('/api/v1/ai/usage', { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to fetch usage')
  return r.json()
}
