use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// ── Link label ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkLabel {
    Up,
    Requires,
    RelatedTo,
}

impl std::fmt::Display for LinkLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkLabel::Up => write!(f, "up"),
            LinkLabel::Requires => write!(f, "requires"),
            LinkLabel::RelatedTo => write!(f, "related_to"),
        }
    }
}

impl std::str::FromStr for LinkLabel {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "up" => Ok(LinkLabel::Up),
            "requires" => Ok(LinkLabel::Requires),
            "related_to" => Ok(LinkLabel::RelatedTo),
            _ => anyhow::bail!("unknown link label: {}", s),
        }
    }
}

// ── Doc status / priority ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DocStatus {
    #[default]
    Todo,
    InProgress,
    Done,
    Archived,
}

impl std::fmt::Display for DocStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocStatus::Todo => write!(f, "todo"),
            DocStatus::InProgress => write!(f, "in_progress"),
            DocStatus::Done => write!(f, "done"),
            DocStatus::Archived => write!(f, "archived"),
        }
    }
}

impl std::str::FromStr for DocStatus {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "todo" => Ok(DocStatus::Todo),
            "in_progress" => Ok(DocStatus::InProgress),
            "done" => Ok(DocStatus::Done),
            "archived" => Ok(DocStatus::Archived),
            _ => anyhow::bail!("unknown status: {}", s),
        }
    }
}

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

// ── Core doc model ────────────────────────────────────────────────────────────

/// Full in-memory / on-disk representation of a doc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: Uuid,
    pub title: String,
    pub description: String,
    pub body: String,
    #[serde(default)]
    pub status: DocStatus,
    #[serde(default)]
    pub priority: DocPriority,
    pub flag: bool,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    #[serde(default)]
    pub links: Vec<DocLink>,
    pub hitl_required: bool,
    pub hitl_status: Option<String>,
    pub note_outline: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A link stored inside a doc's frontmatter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocLink {
    pub target_id: Uuid,
    pub label: LinkLabel,
}

// ── API request / response shapes (match v2 contract) ─────────────────────────

#[derive(Debug, Serialize)]
pub struct DocResponse {
    pub id: Uuid,
    pub name: String,
    pub body: String,
    pub note_outline: Option<serde_json::Value>,
    pub status: String,
    pub priority: String,
    pub flag: bool,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    pub tags: HashMap<String, String>,
    pub linked_doc_ids: Vec<Uuid>,
    pub hitl_required: bool,
    pub hitl_status: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Doc> for DocResponse {
    fn from(d: &Doc) -> Self {
        DocResponse {
            id: d.id,
            name: d.title.clone(),
            body: d.body.clone(),
            note_outline: d.note_outline.clone(),
            status: d.status.to_string(),
            priority: d.priority.to_string(),
            flag: d.flag,
            due_date: d.due_date.clone(),
            due_time: d.due_time.clone(),
            list_id: d.list_id,
            tags: d.tags.clone(),
            linked_doc_ids: d.links.iter().map(|l| l.target_id).collect(),
            hitl_required: d.hitl_required,
            hitl_status: d.hitl_status.clone(),
            created_at: d.created_at,
            updated_at: d.updated_at,
        }
    }
}

// ── List response (API shape expected by frontend) ────────────────────────────

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

#[derive(Debug, Deserialize)]
pub struct CreateDocRequest {
    pub name: String,
    pub body: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub flag: Option<bool>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub list_id: Option<Uuid>,
    pub tags: Option<HashMap<String, String>>,
    pub links: Option<Vec<CreateLinkRequest>>,
    pub hitl_required: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateDocRequest {
    pub name: Option<String>,
    pub body: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub flag: Option<bool>,
    pub due_date: Option<serde_json::Value>,
    pub due_time: Option<serde_json::Value>,
    pub list_id: Option<serde_json::Value>,
    pub tags: Option<HashMap<String, String>>,
    pub links: Option<Vec<CreateLinkRequest>>,
    pub hitl_required: Option<bool>,
    pub hitl_status: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CreateLinkRequest {
    pub target_doc_id: Uuid,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LinkResponse {
    pub source_doc_id: Uuid,
    pub target_doc_id: Uuid,
    pub label: String,
    pub created_at: DateTime<Utc>,
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
