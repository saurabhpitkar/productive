import type { Doc, DocList, DocLinkInfo, StoredLink } from '../types'

const BASE = '/api/v1'

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    credentials: 'include',   // send httpOnly session cookie
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(body.detail ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export interface PaginatedDocs { items: Doc[]; total: number; limit: number; offset: number }
export interface DeltaResponse  { docs: Doc[];  lists: DocList[]; deleted_doc_ids: string[]; deleted_list_ids: string[]; synced_at: string }

export const api = {
  // ── Docs ───────────────────────────────────────────────────────────────────
  getDocs:    (p?: Record<string, string>) =>
    req<PaginatedDocs>(`/docs${p ? '?' + new URLSearchParams(p) : ''}`),

  getDoc:     (id: string)                           => req<Doc>(`/docs/${id}`),
  createDoc:  (data: Partial<Doc>)                   => req<Doc>('/docs', { method: 'POST', body: JSON.stringify(data) }),
  updateDoc:  (id: string, data: Partial<Doc>)       => req<Doc>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDoc:  (id: string)                           => req<void>(`/docs/${id}`, { method: 'DELETE' }),

  addLink:      (src: string, tgt: string, label = 'related_to') => req<void>(`/docs/${src}/links`, { method: 'POST', body: JSON.stringify({ target_doc_id: tgt, label }) }),
  getAllLinks:   () => req<StoredLink[]>('/docs/all-links'),
  getLinks:     (id: string) => req<DocLinkInfo[]>(`/docs/${id}/links`),
  getBacklinks: (id: string) => req<Doc[]>(`/docs/${id}/backlinks`),
  removeLink:   (src: string, tgt: string)           => req<void>(`/docs/${src}/links/${tgt}`, { method: 'DELETE' }),

  // ── Lists ──────────────────────────────────────────────────────────────────
  getLists:     ()                                          => req<DocList[]>('/lists'),
  createList:   (data: { list_name: string })               => req<DocList>('/lists', { method: 'POST', body: JSON.stringify(data) }),
  updateList:   (id: string, data: { list_name: string })   => req<DocList>(`/lists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteList:   (id: string)                                => req<void>(`/lists/${id}`, { method: 'DELETE' }),

  // ── Sync ───────────────────────────────────────────────────────────────────
  delta: (since: string) => req<DeltaResponse>(`/sync/delta?since=${encodeURIComponent(since)}`),
}
