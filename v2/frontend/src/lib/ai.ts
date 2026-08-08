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
  provider:        string | null
  model:           string | null
  api_key_masked:  string | null
  api_key_set:     boolean
  prompt_limit:    number
  context_enabled: boolean
  display_name:    string | null
  avatar_url:      string | null
  google_email:    string | null
}

export async function fetchModels(): Promise<AiModel[]> {
  const r = await fetch('/api/v1/ai/models', { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to fetch models')
  return r.json()
}

export async function fetchAiSettings(): Promise<AiSettings> {
  const r = await fetch('/api/v1/ai/settings', { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to fetch AI settings')
  return r.json()
}

export async function updateAiSettings(patch: Partial<{
  provider: string; model: string; api_key: string;
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
  return r.json()
}

export async function fetchAiContext(): Promise<{ key: string; content: string; updated_at: string }[]> {
  const r = await fetch('/api/v1/ai/context', { credentials: 'include' })
  if (!r.ok) return []
  return r.json()
}

export async function upsertAiContext(key: string, content: string): Promise<void> {
  await fetch(`/api/v1/ai/context/${key}`, {
    method:  'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ key, content }),
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
