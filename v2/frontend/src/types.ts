export type DocStatus = 'todo' | 'in_progress' | 'done' | 'cancelled' | 'archived'
export type Priority  = 'high' | 'medium' | 'low'
export type LinkLabel = 'up' | 'requires' | 'related_to'

export interface DocLinkInfo {
  source_doc_id: string
  target_doc_id: string
  label:         LinkLabel
  created_at:    string
}

export interface Doc {
  id:             string
  name:           string
  body:           string
  note_outline:   string
  due_date:       string | null
  due_time:       string | null
  flag:           boolean | null
  list_id:        string | null
  priority:       Priority | null
  status:         DocStatus
  tags:           Record<string, string>
  linked_doc_ids: string[]
  embedding:      string | null
  hitl_required:  boolean
  hitl_status:    'pending' | null
  created_at:     string
  updated_at:     string
}

export interface HitlReview {
  id:               string
  doc_id:           string
  doc_name:         string
  proposed_payload: Record<string, unknown>
  agent_pat_prefix: string | null
  outcome:          'approved' | 'rejected' | 'cancelled' | null
  human_notes:      string | null
  created_at:       string
  resolved_at:      string | null
  doc_current?:     Record<string, unknown> | null
}

export interface DocList {
  id:         string
  list_name:  string
  doc_ids:    string[]
  doc_count:  number
  created_at: string
  updated_at: string
}

export interface OutboxEntry {
  id:            string
  type:          'create' | 'update' | 'delete' | 'link' | 'unlink'
  payload:       Record<string, unknown>
  created_at:    string
  attempt_count: number
  failed:        boolean
}

export interface SyncMeta {
  key:          string   // always 'main'
  last_sync_at: string
  user_id?:     string
}

export interface StoredLink {
  source_doc_id: string
  target_doc_id: string
  label:         LinkLabel
  created_at:    string
}
