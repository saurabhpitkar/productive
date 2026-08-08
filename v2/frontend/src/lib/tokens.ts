const BASE = '/api/v1/tokens'

export interface ApiToken {
  token_id:     string
  name:         string
  prefix:       string
  created_at:   string
  last_used_at: string | null
  trusted:      boolean
}

export interface NewTokenResponse extends ApiToken {
  token: string  // plaintext - shown once only
}

export async function fetchTokens(): Promise<ApiToken[]> {
  const res = await fetch(BASE, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load tokens')
  return res.json()
}

export async function createToken(name: string): Promise<NewTokenResponse> {
  const res = await fetch(BASE, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error('Failed to create token')
  return res.json()
}

export async function revokeToken(token_id: string): Promise<void> {
  const res = await fetch(`${BASE}/${token_id}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok && res.status !== 404) throw new Error('Failed to revoke token')
}

export async function setTokenTrusted(token_id: string, trusted: boolean): Promise<void> {
  const res = await fetch(`${BASE}/${token_id}/trusted`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trusted }),
  })
  if (!res.ok) throw new Error('Failed to update token trust')
}
