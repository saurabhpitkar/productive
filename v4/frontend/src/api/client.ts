import type { Doc, DocList, DocLinkInfo, StoredLink, SectionSearchResult, InboxEntry, ActivityLogEntry, LinkProposal, LinkSettings, Theme } from '../types'

const BASE = '/api/v1'

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(body.detail ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// v4 API returns task_status; map to status so existing components work unchanged.
function adaptDoc(d: unknown): Doc {
  const r = d as Record<string, unknown>
  return {
    ...(r as unknown as Doc),
    status: (r.task_status as Doc['status']) ?? (r.status as Doc['status']) ?? 'todo',
  }
}

// Map client status → task_status for outgoing write requests.
function adaptRequest(data: Partial<Doc>): Record<string, unknown> {
  const { status, ...rest } = data as Record<string, unknown>
  return {
    ...rest,
    ...(status !== undefined ? { task_status: status } : {}),
  }
}

export interface PaginatedDocs { items: Doc[]; total: number; limit: number; offset: number }
export interface DeltaResponse  { docs: Doc[];  lists: DocList[]; deleted_doc_ids: string[]; deleted_list_ids: string[]; synced_at: string }

export const api = {
  // ── Docs ───────────────────────────────────────────────────────────────────
  getDocs: async (p?: Record<string, string>): Promise<PaginatedDocs> => {
    const r = await req<PaginatedDocs>(`/docs${p ? '?' + new URLSearchParams(p) : ''}`)
    return { ...r, items: r.items.map(adaptDoc) }
  },

  getDoc: async (id: string): Promise<Doc> => {
    const r = await req<Doc>(`/docs/${id}`)
    return adaptDoc(r)
  },

  createDoc: async (data: Partial<Doc>): Promise<Doc> => {
    const r = await req<Doc>('/docs', { method: 'POST', body: JSON.stringify(adaptRequest(data)) })
    return adaptDoc(r)
  },

  updateDoc: async (id: string, data: Partial<Doc>): Promise<Doc> => {
    const r = await req<Doc>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(adaptRequest(data)) })
    return adaptDoc(r)
  },

  deleteDoc:  (id: string)                           => req<void>(`/docs/${id}`, { method: 'DELETE' }),

  addLink:      (src: string, tgt: string, label = 'related_to') => req<void>(`/docs/${src}/links`, { method: 'POST', body: JSON.stringify({ target_doc_id: tgt, label }) }),
  getAllLinks:   () => req<StoredLink[]>('/docs/all-links'),
  getLinks:     (id: string) => req<DocLinkInfo[]>(`/docs/${id}/links`),
  getBacklinks: (id: string, label?: string) => req<Doc[]>(`/docs/${id}/backlinks${label ? `?label=${label}` : ''}`),
  removeLink:   (src: string, tgt: string)           => req<void>(`/docs/${src}/links/${tgt}`, { method: 'DELETE' }),

  // ── Lists ──────────────────────────────────────────────────────────────────
  getLists:     ()                                          => req<DocList[]>('/lists'),
  createList:   (data: { list_name: string })               => req<DocList>('/lists', { method: 'POST', body: JSON.stringify(data) }),
  updateList:   (id: string, data: { list_name: string })   => req<DocList>(`/lists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteList:   (id: string)                                => req<void>(`/lists/${id}`, { method: 'DELETE' }),

  // ── Search ─────────────────────────────────────────────────────────────────
  searchSections: (q: string, limit = 20) =>
    req<SectionSearchResult[]>(`/docs/search?${new URLSearchParams({ q, mode: 'section', limit: String(limit) })}`),

  // ── Inbox ──────────────────────────────────────────────────────────────────
  submitInbox: (body: string, opts?: {
    userTitle?: string
    priority?: string
    status?: string
    dueDate?: string
    dueTime?: string
    linkedDocIds?: string[]
  }) =>
    req<{ inbox_id: string; status: string }>('/inbox', {
      method: 'POST',
      body: JSON.stringify({
        body,
        ...(opts?.userTitle     ? { user_title:      opts.userTitle     } : {}),
        ...(opts?.priority      ? { priority:         opts.priority      } : {}),
        ...(opts?.status        ? { status:           opts.status        } : {}),
        ...(opts?.dueDate       ? { due_date:          opts.dueDate       } : {}),
        ...(opts?.dueTime       ? { due_time:          opts.dueTime       } : {}),
        ...(opts?.linkedDocIds?.length ? { linked_doc_ids: opts.linkedDocIds } : {}),
      }),
    }),
  listInbox: (status?: string) =>
    req<InboxEntry[]>(`/inbox${status ? '?status=' + status : ''}`),

  // ── Link settings & proposals ───────────────────────────────────────────────
  getLinkSettings: () => req<LinkSettings>('/links/settings'),
  updateLinkSettings: (patch: Partial<LinkSettings>) =>
    req<LinkSettings>('/links/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  getLinkProposals: () => req<LinkProposal[]>('/links/proposals'),
  resolveLinkProposal: (id: string, outcome: 'approved' | 'rejected') =>
    req<void>(`/links/proposals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome }) }),

  // ── Themes ─────────────────────────────────────────────────────────────────
  listThemes:   ()                      => req<Theme[]>('/themes'),
  createTheme:  (title: string, description?: string) => req<Theme>('/themes', { method: 'POST', body: JSON.stringify({ title, description }) }),
  updateTheme:  (id: string, patch: { title?: string; description?: string }) => req<Theme>(`/themes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTheme:  (id: string)            => req<void>(`/themes/${id}`, { method: 'DELETE' }),

  // ── Knowledge graph ────────────────────────────────────────────────────────
  getStorageInfo: () => req<{ mode: string; docs_container_path: string; docs_folder_configured: boolean; custom_docs_path?: string }>('/kg/storage'),
  updateStorage: (patch: { custom_docs_path?: string }) =>
    req<{ custom_docs_path: string }>('/kg/storage', { method: 'PATCH', body: JSON.stringify(patch) }),
  rebuildKg: () => req<{
    docs_scanned: number; docs_already_embedded: number; embeddings_updated: number;
    embedding_errors: number; docs_with_embeddings: number;
    pairs_above_threshold: number; pairs_skipped_existing: number;
    already_pending_review: number; proposals_queued_for_review: number;
    links_auto_applied: number; docs_theme_assigned: number;
    warning?: string; error_detail?: string;
  }>('/kg/rebuild', { method: 'POST' }),

  resetAccountData: () => req<{ deleted_docs: number; seeded: boolean }>('/account/data', { method: 'DELETE' }),

  // ── Activity log ───────────────────────────────────────────────────────────
  getActivityLog: (params?: { limit?: number; since?: string }) => {
    const p = new URLSearchParams()
    if (params?.limit)  p.set('limit', String(params.limit))
    if (params?.since)  p.set('since', params.since)
    return req<ActivityLogEntry[]>(`/activity-log${p.toString() ? '?' + p : ''}`)
  },

  // ── Sync ───────────────────────────────────────────────────────────────────
  delta: async (since: string): Promise<DeltaResponse> => {
    const r = await req<DeltaResponse>(`/sync/delta?since=${encodeURIComponent(since)}`)
    return { ...r, docs: r.docs.map(adaptDoc) }
  },
}
