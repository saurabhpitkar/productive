use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// ── Link label ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkLabel {
    BelongsTo,
    Requires,
    RelatedTo,
}

impl std::fmt::Display for LinkLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkLabel::BelongsTo => write!(f, "belongs_to"),
            LinkLabel::Requires => write!(f, "requires"),
            LinkLabel::RelatedTo => write!(f, "related_to"),
        }
    }
}

impl std::str::FromStr for LinkLabel {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "belongs_to" | "up" => Ok(LinkLabel::BelongsTo), // "up" kept for file migration
            "requires" => Ok(LinkLabel::Requires),
            "related_to" => Ok(LinkLabel::RelatedTo),
            _ => anyhow::bail!("unknown link label: {}", s),
        }
    }
}

// ── Task status (Productive-specific, frontmatter: task_status) ───────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    #[default]
    Todo,
    InProgress,
    Done,
    Cancelled,
    Archived,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskStatus::Todo => write!(f, "todo"),
            TaskStatus::InProgress => write!(f, "in_progress"),
            TaskStatus::Done => write!(f, "done"),
            TaskStatus::Cancelled => write!(f, "cancelled"),
            TaskStatus::Archived => write!(f, "archived"),
        }
    }
}

impl std::str::FromStr for TaskStatus {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "todo" => Ok(TaskStatus::Todo),
            "in_progress" => Ok(TaskStatus::InProgress),
            "done" => Ok(TaskStatus::Done),
            "cancelled" => Ok(TaskStatus::Cancelled),
            "archived" => Ok(TaskStatus::Archived),
            _ => anyhow::bail!("unknown task_status: {}", s),
        }
    }
}

// ── OKF lifecycle status (frontmatter: status) ────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DocLifecycle {
    #[default]
    Stable,
    Draft,
    Deprecated,
}

impl std::fmt::Display for DocLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocLifecycle::Draft => write!(f, "draft"),
            DocLifecycle::Stable => write!(f, "stable"),
            DocLifecycle::Deprecated => write!(f, "deprecated"),
        }
    }
}

impl std::str::FromStr for DocLifecycle {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "draft" => Ok(DocLifecycle::Draft),
            "stable" => Ok(DocLifecycle::Stable),
            "deprecated" => Ok(DocLifecycle::Deprecated),
            _ => Ok(DocLifecycle::Stable), // tolerate unknown values per OKF spec
        }
    }
}

// ── Doc priority ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DocPriority {
    Low,
    #[default]
    Medium,
    High,
}

impl std::fmt::Display for DocPriority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocPriority::Low => write!(f, "low"),
            DocPriority::Medium => write!(f, "medium"),
            DocPriority::High => write!(f, "high"),
        }
    }
}

impl std::str::FromStr for DocPriority {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "low" => Ok(DocPriority::Low),
            "medium" => Ok(DocPriority::Medium),
            "high" => Ok(DocPriority::High),
            _ => anyhow::bail!("unknown priority: {}", s),
        }
    }
}

// ── OKF provenance structs ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkfGenerated {
    pub by: String,   // "human:<id>" | "agent:inbox-router/v4" | "process:<id>"
    pub at: String,   // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkfVerified {
    pub by: String,
    pub at: String,
}

// ── Core doc model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: Uuid,
    pub doc_type: String,                    // OKF: type field
    pub title: String,
    pub description: String,                 // OKF: single-sentence summary
    pub body: String,
    // OKF lifecycle
    pub lifecycle: DocLifecycle,             // OKF: status (draft/stable/deprecated)
    pub stale_after: Option<String>,         // OKF: YYYY-MM-DD
    pub generated: Option<OkfGenerated>,     // OKF: provenance
    pub verified: Vec<OkfVerified>,          // OKF: trust (grows on HITL approval)
    // Productive-specific
    pub task_status: TaskStatus,             // renamed from v3 'status'
    pub priority: Option<DocPriority>,
    pub flag: bool,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    #[serde(default)]
    pub theme_ids: Vec<String>,
    #[serde(default)]
    pub links: Vec<DocLink>,
    pub hitl_required: bool,
    pub hitl_status: Option<String>,
    pub note_outline: Option<serde_json::Value>,
    /// Top-5 representative keywords extracted from title+body (weighted TF).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vector_keywords: Vec<String>,
    /// SHA-256 fingerprint of title+body at the time keywords were last extracted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword_source_hash: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A typed link stored inside a doc's frontmatter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocLink {
    pub target_id: Uuid,
    pub label: LinkLabel,
    pub title: Option<String>,
    /// "auto" = created by the auto-linker; "manual" = set by a human (protected from auto-overwrite).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

// ── API response shapes ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct DocResponse {
    pub id: Uuid,
    pub name: String,
    pub doc_type: String,
    pub description: String,
    pub body: String,
    pub note_outline: Option<serde_json::Value>,
    pub lifecycle: String,
    pub stale_after: Option<String>,
    pub task_status: String,
    pub priority: Option<String>,
    pub flag: bool,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    pub tags: HashMap<String, String>,
    pub theme_ids: Vec<String>,
    pub linked_doc_ids: Vec<Uuid>,
    pub hitl_required: bool,
    pub hitl_status: Option<String>,
    pub generated: Option<OkfGenerated>,
    pub verified: Vec<OkfVerified>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Doc> for DocResponse {
    fn from(d: &Doc) -> Self {
        DocResponse {
            id: d.id,
            name: d.title.clone(),
            doc_type: d.doc_type.clone(),
            description: d.description.clone(),
            body: d.body.clone(),
            note_outline: d.note_outline.clone(),
            lifecycle: d.lifecycle.to_string(),
            stale_after: d.stale_after.clone(),
            task_status: d.task_status.to_string(),
            priority: d.priority.as_ref().map(|p| p.to_string()),
            flag: d.flag,
            due_date: d.due_date.clone(),
            due_time: d.due_time.clone(),
            list_id: d.list_id,
            tags: d.tags.clone(),
            theme_ids: d.theme_ids.clone(),
            linked_doc_ids: d.links.iter().map(|l| l.target_id).collect(),
            hitl_required: d.hitl_required,
            hitl_status: d.hitl_status.clone(),
            generated: d.generated.clone(),
            verified: d.verified.clone(),
            created_at: d.created_at,
            updated_at: d.updated_at,
        }
    }
}

/// Lightweight summary — used by GET /docs?summary=true and subtree nodes.
#[derive(Debug, Serialize, Clone)]
pub struct DocSummary {
    pub id: Uuid,
    pub title: String,
    pub doc_type: String,
    pub description: String,
    pub task_status: String,
    pub lifecycle: String,
    pub priority: Option<String>,
    pub hitl_required: bool,
    pub link_count: usize,
    pub body_preview: String,
    pub updated_at: DateTime<Utc>,
}

impl From<&Doc> for DocSummary {
    fn from(d: &Doc) -> Self {
        DocSummary {
            id: d.id,
            title: d.title.clone(),
            doc_type: d.doc_type.clone(),
            description: d.description.clone(),
            task_status: d.task_status.to_string(),
            lifecycle: d.lifecycle.to_string(),
            priority: d.priority.as_ref().map(|p| p.to_string()),
            hitl_required: d.hitl_required,
            link_count: d.links.len(),
            body_preview: d.body.chars().take(200).collect(),
            updated_at: d.updated_at,
        }
    }
}

// ── Inbox / routing ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoutingResult {
    pub inbox_id: String,
    /// routed | hitl_pending | failed
    pub status: String,
    pub confidence: f32,
    pub target_doc_id: Option<String>,
    pub target_doc_title: Option<String>,
    /// appended | created | hitl_queued | failed
    pub action: String,
    pub reasoning: String,
    pub rounds_used: u8,
}

// ── Semantic search responses ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimilarDoc {
    pub id: Uuid,
    pub title: String,
    pub doc_type: String,
    pub description: String,
    pub body_preview: String,
    pub semantic_score: f32,
    pub structural_score: f32,
    pub combined_score: f32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DocContext {
    pub doc: DocResponse,
    pub forward_links: Vec<DocSummary>,
    pub backlinks: Vec<DocSummary>,
    pub siblings: Vec<DocSummary>,
}

#[derive(Debug, Serialize)]
pub struct SectionSearchResult {
    pub doc_id: Uuid,
    pub doc_title: String,
    pub heading: String,
    pub heading_level: u8,
    pub body_preview: String,
    pub updated_at: DateTime<Utc>,
}

// ── Subtree response ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SubtreeNode {
    pub id: Uuid,
    pub title: String,
    pub doc_type: String,
    pub description: String,
    pub task_status: String,
    pub lifecycle: String,
    pub priority: Option<String>,
    pub hitl_required: bool,
    pub link_count: usize,
    pub body_preview: String,
}

#[derive(Debug, Serialize)]
pub struct SubtreeEdge {
    pub source_id: Uuid,
    pub target_id: Uuid,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct SubtreeResponse {
    pub root_id: Uuid,
    pub depth: u32,
    pub nodes: Vec<SubtreeNode>,
    pub edges: Vec<SubtreeEdge>,
}

// ── Batch create ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BatchCreateRequest {
    pub docs: Vec<CreateDocRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchCreateResponse {
    pub created: Vec<DocResponse>,
    pub idempotent_replay: bool,
}

// ── API request shapes ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct CreateDocRequest {
    pub name: String,
    pub body: Option<String>,
    pub description: Option<String>,
    pub doc_type: Option<String>,
    pub task_status: Option<String>,
    pub lifecycle: Option<String>,
    pub stale_after: Option<String>,
    pub priority: Option<String>,
    pub flag: Option<bool>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    pub tags: Option<HashMap<String, String>>,
    pub links: Option<Vec<CreateLinkRequest>>,
    pub hitl_required: Option<bool>,
    pub writer: Option<String>, // OKF generated.by — caller can identify themselves
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateDocRequest {
    pub name: Option<String>,
    pub body: Option<String>,
    pub description: Option<String>,
    pub doc_type: Option<String>,
    pub task_status: Option<String>,
    pub lifecycle: Option<String>,
    pub stale_after: Option<serde_json::Value>,
    pub priority: Option<String>,
    pub flag: Option<bool>,
    pub due_date: Option<serde_json::Value>,
    pub due_time: Option<serde_json::Value>,
    pub list_id: Option<serde_json::Value>,
    pub tags: Option<HashMap<String, String>>,
    pub links: Option<Vec<CreateLinkRequest>>,
    pub hitl_required: Option<bool>,
    pub hitl_status: Option<serde_json::Value>,
    pub writer: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CreateLinkRequest {
    pub target_doc_id: Uuid,
    pub label: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LinkResponse {
    pub source_doc_id: Uuid,
    pub target_doc_id: Uuid,
    pub label: String,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
}

// ── List response ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub id: Uuid,
    pub list_name: String,
    pub doc_ids: Vec<String>,
    pub doc_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ListResponse {
    pub fn from_list(list: &List, all_docs: &[Doc]) -> Self {
        let doc_ids: Vec<String> = all_docs.iter()
            .filter(|d| d.list_id == Some(list.id))
            .map(|d| d.id.to_string())
            .collect();
        let doc_count = doc_ids.len();
        ListResponse {
            id: list.id,
            list_name: list.name.clone(),
            doc_ids,
            doc_count,
            created_at: list.created_at,
            updated_at: list.updated_at,
        }
    }
}

/// List model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct List {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// User identity returned from auth middleware
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub sub: String,
    pub email: String,
    pub name: String,
    pub auth_method: AuthMethod,
    pub pat_trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMethod {
    Cookie,
    Pat,
}
