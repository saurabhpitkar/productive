use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use uuid::Uuid;

use crate::models::{
    Doc, DocLifecycle, DocLink, DocPriority, LinkLabel, List, OkfGenerated, OkfVerified, TaskStatus,
};

// ── Filename helpers ──────────────────────────────────────────────────────────

pub fn title_to_stem(title: &str) -> String {
    let sanitized: String = title.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' | '#' | '^' | '[' | ']' => '-',
            c => c,
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_write_path(docs_dir: &Path, stem: &str, doc_id: Uuid) -> PathBuf {
    let id_str = doc_id.to_string();
    let primary = docs_dir.join(format!("{}.md", stem));
    if !primary.exists() { return primary; }

    if let Ok(content) = std::fs::read_to_string(&primary) {
        if content.contains(&id_str) { return primary; }
    }

    for n in 2..=999 {
        let candidate = docs_dir.join(format!("{} ({}).md", stem, n));
        if !candidate.exists() { return candidate; }
        if let Ok(content) = std::fs::read_to_string(&candidate) {
            if content.contains(&id_str) { return candidate; }
        }
    }

    docs_dir.join(format!("{}.md", doc_id))
}

pub fn find_doc_path(docs_dir: &Path, id: Uuid) -> Option<PathBuf> {
    let id_str = id.to_string();
    let entries = std::fs::read_dir(docs_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains(&id_str) {
                    if let Ok(doc) = parse_doc_str(&content) {
                        if doc.id == id { return Some(path); }
                    }
                }
            }
        }
    }
    None
}

// ── OKF frontmatter (YAML) ────────────────────────────────────────────────────

/// Intermediate serde struct for YAML frontmatter — maps 1:1 with on-disk format.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct Frontmatter {
    id: String,
    #[serde(rename = "type", default = "default_type")]
    doc_type: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note_outline: Option<String>,

    // OKF lifecycle
    #[serde(default = "default_lifecycle")]
    status: String,                             // OKF: draft | stable | deprecated
    #[serde(default)]
    stale_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generated: Option<FrontmatterGenerated>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    verified: Vec<FrontmatterVerified>,

    // Productive-specific
    #[serde(default)]
    task_status: String,                        // todo | in_progress | done | cancelled | archived
    #[serde(default)]
    priority: String,
    #[serde(default)]
    flag: bool,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    due_time: Option<String>,
    #[serde(default)]
    list_id: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    theme_ids: Vec<String>,
    #[serde(default)]
    links: Vec<FrontmatterLink>,
    #[serde(default)]
    hitl_required: bool,
    #[serde(default)]
    hitl_status: Option<String>,

    created_at: String,
    updated_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct FrontmatterGenerated {
    by: String,
    at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct FrontmatterVerified {
    by: String,
    at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct FrontmatterLink {
    target_id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

fn default_type() -> String { "Note".to_string() }
fn default_lifecycle() -> String { "stable".to_string() }

// ── Parse ─────────────────────────────────────────────────────────────────────

pub fn parse_doc(path: &Path) -> Result<Doc> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    parse_doc_str(&content)
}

pub fn parse_doc_str(content: &str) -> Result<Doc> {
    let (fm_str, body) = split_frontmatter(content)?;
    let fm: Frontmatter = serde_yaml::from_str(&fm_str)
        .context("parsing YAML frontmatter")?;

    let id = Uuid::parse_str(&fm.id).context("invalid UUID in frontmatter")?;
    let created_at = fm.created_at.parse::<chrono::DateTime<Utc>>().unwrap_or_else(|_| Utc::now());
    let updated_at = fm.updated_at.parse::<chrono::DateTime<Utc>>().unwrap_or_else(|_| Utc::now());

    let links = fm.links.iter()
        .filter_map(|l| {
            let target_id = Uuid::parse_str(&l.target_id).ok()?;
            let label: LinkLabel = l.label.parse().ok()?;
            Some(DocLink { target_id, label, title: l.title.clone() })
        })
        .collect();

    let note_outline = compute_outline(&body);

    // Handle v3 migration: v3 used 'status' for task state — map it to task_status if blank
    let task_status_str = if fm.task_status.is_empty() {
        // v3 compat: if task_status missing but status looks like a task state, use it
        match fm.status.as_str() {
            "todo" | "in_progress" | "done" | "cancelled" | "archived" => fm.status.clone(),
            _ => fm.task_status.clone(),
        }
    } else {
        fm.task_status.clone()
    };

    // OKF lifecycle: if status is a task state (v3 compat), treat as 'stable'
    let lifecycle_str = match fm.status.as_str() {
        "todo" | "in_progress" | "done" | "cancelled" | "archived" => "stable",
        s => s,
    };

    // Migrate legacy tags.theme_id → theme_ids array (one-time, forward-only)
    let mut tags = fm.tags;
    let mut theme_ids = fm.theme_ids;
    if theme_ids.is_empty() {
        if let Some(old_tid) = tags.remove("theme_id") {
            if !old_tid.is_empty() {
                theme_ids.push(old_tid);
            }
        }
    } else {
        tags.remove("theme_id"); // clean up if both exist somehow
    }

    Ok(Doc {
        id,
        doc_type: fm.doc_type,
        title: fm.title,
        description: fm.description,
        body,
        lifecycle: lifecycle_str.parse().unwrap_or_default(),
        stale_after: fm.stale_after,
        generated: fm.generated.map(|g| OkfGenerated { by: g.by, at: g.at }),
        verified: fm.verified.into_iter().map(|v| OkfVerified { by: v.by, at: v.at }).collect(),
        task_status: task_status_str.parse().unwrap_or_default(),
        priority: fm.priority.parse().unwrap_or_default(),
        flag: fm.flag,
        due_date: fm.due_date,
        due_time: fm.due_time,
        list_id: fm.list_id.as_deref().and_then(|s| Uuid::parse_str(s).ok()),
        tags,
        theme_ids,
        links,
        hitl_required: fm.hitl_required,
        hitl_status: fm.hitl_status,
        note_outline: Some(note_outline),
        created_at,
        updated_at,
    })
}

fn split_frontmatter(content: &str) -> Result<(String, String)> {
    if !content.starts_with("---") {
        return Ok((String::new(), content.to_string()));
    }
    let rest = &content[3..];
    let end = rest.find("\n---").ok_or_else(|| anyhow::anyhow!("unclosed frontmatter"))?;
    let fm = rest[..end].to_string();
    let body = rest[end + 4..].trim_start_matches('\n').to_string();
    Ok((fm, body))
}

// ── Serialize ─────────────────────────────────────────────────────────────────

pub fn serialize_doc(doc: &Doc) -> Result<String> {
    let outline_text = compute_outline_text(&doc.body);
    let fm = Frontmatter {
        id: doc.id.to_string(),
        doc_type: doc.doc_type.clone(),
        title: doc.title.clone(),
        description: doc.description.clone(),
        note_outline: if outline_text.is_empty() { None } else { Some(outline_text) },
        status: doc.lifecycle.to_string(),
        stale_after: doc.stale_after.clone(),
        generated: doc.generated.as_ref().map(|g| FrontmatterGenerated {
            by: g.by.clone(),
            at: g.at.clone(),
        }),
        verified: doc.verified.iter().map(|v| FrontmatterVerified {
            by: v.by.clone(),
            at: v.at.clone(),
        }).collect(),
        task_status: doc.task_status.to_string(),
        priority: doc.priority.to_string(),
        flag: doc.flag,
        due_date: doc.due_date.clone(),
        due_time: doc.due_time.clone(),
        list_id: doc.list_id.map(|id| id.to_string()),
        tags: {
            let mut t = doc.tags.clone();
            t.remove("theme_id"); // always strip legacy key on write
            t
        },
        theme_ids: doc.theme_ids.clone(),
        links: doc.links.iter().map(|l| FrontmatterLink {
            target_id: l.target_id.to_string(),
            label: l.label.to_string(),
            title: l.title.clone(),
        }).collect(),
        hitl_required: doc.hitl_required,
        hitl_status: doc.hitl_status.clone(),
        created_at: doc.created_at.to_rfc3339(),
        updated_at: doc.updated_at.to_rfc3339(),
    };

    let yaml = serde_yaml::to_string(&fm).context("serializing frontmatter")?;
    Ok(format!("---\n{}---\n{}", yaml, doc.body))
}

// ── Write / Delete ────────────────────────────────────────────────────────────

pub fn write_doc(docs_dir: &Path, doc: &Doc, current_file_name: Option<&str>) -> Result<PathBuf> {
    let text = serialize_doc(doc)?;
    let new_stem = title_to_stem(&doc.title);

    let target_path = match current_file_name {
        Some(current) => {
            let existing = docs_dir.join(current);
            let desired = docs_dir.join(format!("{}.md", new_stem));

            if existing.exists() && existing != desired {
                let final_target = resolve_write_path(docs_dir, &new_stem, doc.id);
                std::fs::rename(&existing, &final_target)
                    .with_context(|| format!("renaming {} -> {}", existing.display(), final_target.display()))?;
                final_target
            } else {
                resolve_write_path(docs_dir, &new_stem, doc.id)
            }
        }
        None => resolve_write_path(docs_dir, &new_stem, doc.id),
    };

    std::fs::write(&target_path, &text)
        .with_context(|| format!("writing {}", target_path.display()))?;
    Ok(target_path)
}

pub fn delete_doc_file(docs_dir: &Path, file_name: &str) -> Result<()> {
    let path = docs_dir.join(file_name);
    std::fs::remove_file(&path).with_context(|| format!("deleting {}", path.display()))?;
    Ok(())
}

pub fn load_all_docs(docs_dir: &Path) -> Vec<(Doc, String)> {
    let Ok(entries) = std::fs::read_dir(docs_dir) else { return vec![] };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
        .filter_map(|e| {
            let path = e.path();
            let file_name = path.file_name()?.to_str()?.to_string();
            match parse_doc(&path) {
                Ok(d) => Some((d, file_name)),
                Err(err) => {
                    tracing::warn!("skipping {}: {}", path.display(), err);
                    None
                }
            }
        })
        .collect()
}

// ── note_outline ──────────────────────────────────────────────────────────────

pub fn compute_outline(body: &str) -> serde_json::Value {
    use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

    let mut items = Vec::new();
    let mut in_heading: Option<u8> = None;
    let mut heading_text = String::new();

    let parser = Parser::new_ext(body, Options::all());
    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = Some(match level {
                    HeadingLevel::H1 => 1, HeadingLevel::H2 => 2, HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4, HeadingLevel::H5 => 5, HeadingLevel::H6 => 6,
                });
                heading_text.clear();
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = in_heading.take() {
                    items.push(serde_json::json!({ "level": level, "text": heading_text.trim() }));
                }
            }
            Event::Text(t) if in_heading.is_some() => { heading_text.push_str(&t); }
            _ => {}
        }
    }
    serde_json::Value::Array(items)
}

/// Flat header string rendered from the body's heading hierarchy.
/// e.g. "# Overview\n## Flights\n## Accommodation\n### Tokyo 5 nights"
pub fn compute_outline_text(body: &str) -> String {
    let outline = compute_outline(body);
    outline.as_array()
        .map(|items| {
            items.iter()
                .filter_map(|item| {
                    let level = item.get("level")?.as_u64()? as usize;
                    let text  = item.get("text")?.as_str()?;
                    if text.is_empty() { return None; }
                    Some(format!("{} {}", "#".repeat(level), text))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

// ── OKF provenance helper ─────────────────────────────────────────────────────

/// Build the `generated` block for a new or updated doc.
/// `writer` comes from the request (e.g. "claude-mcp") or defaults to auth method.
pub fn make_generated(writer: Option<&str>, auth_method: &str) -> OkfGenerated {
    let by = match writer {
        Some(w) if !w.is_empty() => {
            if w.starts_with("human:") || w.starts_with("agent:") || w.starts_with("process:") {
                w.to_string()
            } else {
                format!("agent:{}", w)
            }
        }
        _ => match auth_method {
            "cookie" => "human:user".to_string(),
            _ => "agent:pat-client".to_string(),
        },
    };
    OkfGenerated { by, at: Utc::now().to_rfc3339() }
}

// ── Lists ─────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ListsFile { lists: Vec<List> }

fn lists_path(user_root: &Path) -> PathBuf { user_root.join("_lists.yaml") }

pub fn load_lists(user_root: &Path) -> Vec<List> {
    let path = lists_path(user_root);
    if !path.exists() { return vec![] }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    serde_yaml::from_str::<ListsFile>(&content).unwrap_or_default().lists
}

pub fn save_lists(user_root: &Path, lists: &[List]) -> Result<()> {
    let yaml = serde_yaml::to_string(&ListsFile { lists: lists.to_vec() })?;
    std::fs::write(lists_path(user_root), yaml)?;
    Ok(())
}
