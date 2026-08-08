use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use uuid::Uuid;

use crate::models::{Doc, DocLink, DocPriority, DocStatus, LinkLabel, List};

// ── Filename helpers ──────────────────────────────────────────────────────────

/// Convert a doc title to a filesystem-safe stem (no .md extension, spaces allowed).
/// Strips characters invalid on Windows / Linux / macOS.
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

/// Resolve a conflict-free write path for a doc.
/// If `{stem}.md` exists and belongs to a different doc, appends a counter.
pub fn resolve_write_path(docs_dir: &Path, stem: &str, doc_id: Uuid) -> PathBuf {
    let id_str = doc_id.to_string();
    let primary = docs_dir.join(format!("{}.md", stem));
    if !primary.exists() { return primary; }

    // Existing file — check ownership
    if let Ok(content) = std::fs::read_to_string(&primary) {
        if content.contains(&id_str) { return primary; } // this doc owns it
    }

    // Taken by another doc — append counter
    for n in 2..=999 {
        let candidate = docs_dir.join(format!("{} ({}).md", stem, n));
        if !candidate.exists() { return candidate; }
        if let Ok(content) = std::fs::read_to_string(&candidate) {
            if content.contains(&id_str) { return candidate; }
        }
    }

    // Fallback: UUID (shouldn't normally happen)
    docs_dir.join(format!("{}.md", doc_id))
}

/// Scan all .md files for a matching UUID in frontmatter.
/// O(n) — used only as a fallback when the index has no cached filename.
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

#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct Frontmatter {
    id: String,
    #[serde(rename = "type", default = "default_type")]
    doc_type: String,
    title: String,
    #[serde(default)]
    description: String,
    timestamp: String,
    #[serde(default)]
    status: String,
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
struct FrontmatterLink {
    target_id: String,
    label: String,
}

fn default_type() -> String { "Doc".to_string() }

// ── Parse ─────────────────────────────────────────────────────────────────────

pub fn parse_doc(path: &Path) -> Result<Doc> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    parse_doc_str(&content)
}

pub fn parse_doc_str(content: &str) -> Result<Doc> {
    let (fm, body) = split_frontmatter(content)?;
    let fm: Frontmatter = serde_yaml::from_str(&fm)
        .context("parsing YAML frontmatter")?;

    let id = Uuid::parse_str(&fm.id).context("invalid UUID in frontmatter")?;
    let created_at = fm.created_at.parse::<chrono::DateTime<Utc>>().unwrap_or_else(|_| Utc::now());
    let updated_at = fm.updated_at.parse::<chrono::DateTime<Utc>>().unwrap_or_else(|_| Utc::now());

    let links = fm.links.iter()
        .filter_map(|l| {
            let target_id = Uuid::parse_str(&l.target_id).ok()?;
            let label: LinkLabel = l.label.parse().ok()?;
            Some(DocLink { target_id, label })
        })
        .collect();

    let note_outline = compute_outline(&body);

    Ok(Doc {
        id,
        title: fm.title,
        description: fm.description,
        body,
        status: fm.status.parse().unwrap_or_default(),
        priority: fm.priority.parse().unwrap_or_default(),
        flag: fm.flag,
        due_date: fm.due_date,
        due_time: fm.due_time,
        list_id: fm.list_id.as_deref().and_then(|s| Uuid::parse_str(s).ok()),
        tags: fm.tags,
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
    let fm = Frontmatter {
        id: doc.id.to_string(),
        doc_type: "Doc".to_string(),
        title: doc.title.clone(),
        description: doc.description.clone(),
        timestamp: doc.created_at.to_rfc3339(),
        status: doc.status.to_string(),
        priority: doc.priority.to_string(),
        flag: doc.flag,
        due_date: doc.due_date.clone(),
        due_time: doc.due_time.clone(),
        list_id: doc.list_id.map(|id| id.to_string()),
        tags: doc.tags.clone(),
        links: doc.links.iter().map(|l| FrontmatterLink {
            target_id: l.target_id.to_string(),
            label: l.label.to_string(),
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

/// Write a doc to disk using its title as the filename.
///
/// - `current_file_name`: pass the existing filename (e.g. `"Old Title.md"`) when
///   updating so the file is renamed if the title changed. Pass `None` for new docs.
///
/// Returns the path that was written.
pub fn write_doc(docs_dir: &Path, doc: &Doc, current_file_name: Option<&str>) -> Result<PathBuf> {
    let text = serialize_doc(doc)?;
    let new_stem = title_to_stem(&doc.title);

    let target_path = match current_file_name {
        Some(current) => {
            let existing = docs_dir.join(current);
            let desired = docs_dir.join(format!("{}.md", new_stem));

            if existing.exists() && existing != desired {
                // Title changed — rename to new title-based name
                let final_target = resolve_write_path(docs_dir, &new_stem, doc.id);
                std::fs::rename(&existing, &final_target)
                    .with_context(|| format!("renaming {} -> {}", existing.display(), final_target.display()))?;
                final_target
            } else {
                // No rename needed
                resolve_write_path(docs_dir, &new_stem, doc.id)
            }
        }
        None => resolve_write_path(docs_dir, &new_stem, doc.id),
    };

    std::fs::write(&target_path, &text)
        .with_context(|| format!("writing {}", target_path.display()))?;
    Ok(target_path)
}

/// Delete a doc file by its known filename (e.g. `"Japan Trip.md"`).
pub fn delete_doc_file(docs_dir: &Path, file_name: &str) -> Result<()> {
    let path = docs_dir.join(file_name);
    std::fs::remove_file(&path).with_context(|| format!("deleting {}", path.display()))?;
    Ok(())
}

/// Load all docs from a user's docs/ directory.
/// Returns `(doc, filename)` pairs — filename is just the file name (e.g. `"Japan Trip.md"`).
/// Errors on individual files are logged and skipped.
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
