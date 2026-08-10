export type DocStatus = 'todo' | 'in_progress' | 'done' | 'cancelled' | 'archived'
export type Priority  = 'high' | 'medium' | 'low'
export type LinkLabel = 'belongs_to' | 'requires' | 'related_to'
export type DocLifecycle = 'draft' | 'stable' | 'deprecated'

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
  status:         DocStatus        // canonical field; API client maps task_status → status
  tags:           Record<string, string>
  theme_ids:      string[]
  linked_doc_ids: string[]
  embedding:      string | null
  hitl_required:  boolean
  hitl_status:    'pending' | null
  created_at:     string
  updated_at:     string
  // v4 additions — populated from server response
  task_status?:  DocStatus
  lifecycle?:    DocLifecycle
  doc_type?:     string
  description?:  string
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

export interface SectionSearchResult {
  doc_id:        string
  doc_title:     string
  heading:       string
  heading_level: number
  body_preview:  string
  updated_at:    string
}

export interface RoutingResult {
  inbox_id:         string
  status:           'routed' | 'hitl_pending' | 'failed'
  confidence:       number
  target_doc_id:    string | null
  target_doc_title: string | null
  action:           'appended' | 'created' | 'hitl_queued' | 'failed'
  reasoning:        string
  rounds_used:      number
}

export interface LinkProposal {
  id:            string
  session_id:    string | null
  source_doc_id: string
  target_doc_id: string
  label:         LinkLabel
  confidence:    number
  status:        'pending' | 'approved' | 'rejected'
  created_at:    string
  resolved_at:   string | null
}

export interface LinkSettings {
  links_enabled:        boolean
  links_capture:        boolean
  links_chat:           boolean
  links_require_review: boolean
  link_auto_threshold:  number
}

export interface Theme {
  id:          string
  title:       string
  description: string
  created_at:  string
}

export interface InboxEntry {
  id:             string
  body:           string
  status:         'pending' | 'routing' | 'routed' | 'failed' | 'hitl_pending'
  routing_result: RoutingResult | null
  created_at:     string
  updated_at:     string
}

export interface ActivityLogEntry {
  id:              string
  doc_id:          string | null
  doc_name:        string | null
  action:          'created' | 'updated' | 'deleted' | 'routed' | 'linked' | 'unlinked' | 'batch_created'
  actor:           string
  session_id:      string | null
  before_snapshot: Record<string, unknown> | null
  after_snapshot:  Record<string, unknown> | null
  created_at:      string
}
