use dashmap::DashMap;
use uuid::Uuid;

use crate::models::{Doc, LinkLabel};

#[derive(Debug, Clone)]
pub struct DocMeta {
    pub id: Uuid,
    pub title: String,
    pub file_name: String, // e.g. "Japan Trip 2026.md"
    pub status: String,
    pub priority: String,
    pub flag: bool,
    pub list_id: Option<Uuid>,
    pub due_date: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct BacklinkEntry {
    pub source_id: Uuid,
    pub label: LinkLabel,
}

pub struct DocIndex {
    pub docs: DashMap<(String, Uuid), DocMeta>,
    pub backlinks: DashMap<(String, Uuid), Vec<BacklinkEntry>>,
}

impl DocIndex {
    pub fn new() -> Self {
        DocIndex { docs: DashMap::new(), backlinks: DashMap::new() }
    }

    /// Upsert a doc's metadata and refresh its backlink entries.
    /// `file_name` is just the filename (e.g. `"Japan Trip.md"`), not a full path.
    pub fn upsert(&self, user_id: &str, doc: &Doc, file_name: &str) {
        let key = (user_id.to_string(), doc.id);
        self.docs.insert(key, DocMeta {
            id: doc.id,
            title: doc.title.clone(),
            file_name: file_name.to_string(),
            status: doc.status.to_string(),
            priority: doc.priority.to_string(),
            flag: doc.flag,
            list_id: doc.list_id,
            due_date: doc.due_date.clone(),
            updated_at: doc.updated_at,
            created_at: doc.created_at,
        });

        // Remove stale backlinks from this doc, then re-add.
        self.backlinks.iter_mut().for_each(|mut e| {
            e.value_mut().retain(|b| b.source_id != doc.id);
        });
        for link in &doc.links {
            let target_key = (user_id.to_string(), link.target_id);
            self.backlinks.entry(target_key).or_default()
                .push(BacklinkEntry { source_id: doc.id, label: link.label.clone() });
        }
    }

    pub fn remove(&self, user_id: &str, doc_id: Uuid) {
        let key = (user_id.to_string(), doc_id);
        self.docs.remove(&key);
        self.backlinks.iter_mut().for_each(|mut e| {
            e.value_mut().retain(|b| b.source_id != doc_id);
        });
        self.backlinks.remove(&key);
    }

    pub fn get_meta(&self, user_id: &str, doc_id: Uuid) -> Option<DocMeta> {
        self.docs.get(&(user_id.to_string(), doc_id)).map(|e| e.clone())
    }

    /// Returns the cached filename for a doc (e.g. `"Japan Trip.md"`).
    pub fn get_file_name(&self, user_id: &str, doc_id: Uuid) -> Option<String> {
        self.docs.get(&(user_id.to_string(), doc_id)).map(|e| e.file_name.clone())
    }

    pub fn list_docs(&self, user_id: &str) -> Vec<DocMeta> {
        let mut docs: Vec<DocMeta> = self.docs.iter()
            .filter(|e| e.key().0 == user_id)
            .map(|e| e.value().clone())
            .collect();
        docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        docs
    }

    pub fn backlinks_for(&self, user_id: &str, doc_id: Uuid) -> Vec<BacklinkEntry> {
        self.backlinks
            .get(&(user_id.to_string(), doc_id))
            .map(|e| e.clone())
            .unwrap_or_default()
    }
}

impl Default for DocIndex {
    fn default() -> Self { Self::new() }
}
