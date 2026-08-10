use std::sync::Arc;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::embed::{doc_embed_text, spawn_embed_task};
use crate::store::file::parse_doc;
use crate::store::AppState;

/// Spawn a file-system watcher for a user's docs/ directory.
/// On external modification the affected doc is re-parsed, the index is updated,
/// and an embedding re-generation task is spawned so semantic search stays fresh.
pub fn spawn_watcher(
    user_id: String,
    docs_dir: std::path::PathBuf,
    state: Arc<AppState>,
) {
    let index = Arc::clone(&state.index);
    tokio::task::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => { tracing::warn!("watcher init failed for {}: {}", user_id, e); return; }
        };
        if let Err(e) = watcher.watch(&docs_dir, RecursiveMode::NonRecursive) {
            tracing::warn!("watch failed for {}: {}", docs_dir.display(), e);
            return;
        }
        tracing::debug!("watching {} for user {}", docs_dir.display(), user_id);

        for event in rx {
            let Ok(Event { kind, paths, .. }) = event else { continue };
            let is_write = matches!(kind, EventKind::Modify(_) | EventKind::Create(_));
            if !is_write { continue }

            for path in paths {
                if !path.extension().map(|e| e == "md").unwrap_or(false) { continue; }

                let file_name = path.file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("")
                    .to_string();

                match parse_doc(&path) {
                    Ok(doc) => {
                        // Update in-memory index so traverse_subtree and link
                        // lookups reflect the new content immediately.
                        index.upsert(&user_id, &doc, &file_name);
                        tracing::debug!("index updated from watcher: {} ({})", doc.id, file_name);

                        // Re-embed so semantic similarity candidates stay fresh.
                        // Fire-and-forget — never blocks the watcher loop.
                        let text = doc_embed_text(&doc.title, &doc.description, &doc.body);
                        spawn_embed_task(Arc::clone(&state), user_id.clone(), doc.id, text);
                    }
                    Err(e) => tracing::warn!("watcher parse error {}: {}", path.display(), e),
                }
            }
        }
    });
}
