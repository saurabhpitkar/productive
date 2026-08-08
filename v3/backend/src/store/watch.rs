use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::store::index::DocIndex;
use crate::store::file::parse_doc;

/// Spawn a file-system watcher for a user's docs/ directory.
/// On external modification, the affected doc is re-parsed and the index is updated.
pub fn spawn_watcher(
    user_id: String,
    docs_dir: std::path::PathBuf,
    index: Arc<DocIndex>,
) {
    tokio::task::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => { tracing::warn!("watcher init failed: {}", e); return; }
        };
        if let Err(e) = watcher.watch(&docs_dir, RecursiveMode::NonRecursive) {
            tracing::warn!("watch failed for {}: {}", docs_dir.display(), e);
            return;
        }
        for event in rx {
            let Ok(Event { kind, paths, .. }) = event else { continue };
            let is_write = matches!(kind, EventKind::Modify(_) | EventKind::Create(_));
            if !is_write { continue }
            for path in paths {
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    let file_name = path.file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("")
                        .to_string();
                    match parse_doc(&path) {
                        Ok(doc) => {
                            index.upsert(&user_id, &doc, &file_name);
                            tracing::debug!("index updated from watcher: {}", doc.id);
                        }
                        Err(e) => tracing::warn!("watcher parse error {}: {}", path.display(), e),
                    }
                }
            }
        }
    });
}
