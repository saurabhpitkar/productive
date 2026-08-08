use std::path::Path;

use anyhow::{Context, Result};
use git2::{Repository, Signature};

/// Ensure the user's root directory is a git repo. Called once on first login.
pub fn ensure_repo(user_root: &Path) -> Result<()> {
    if user_root.join(".git").exists() {
        return Ok(());
    }
    let repo = Repository::init(user_root)
        .with_context(|| format!("git init {}", user_root.display()))?;

    // Create a .gitignore so the sidecar DB is not tracked
    let gitignore = user_root.join(".gitignore");
    std::fs::write(&gitignore, "_meta.db\n_meta.db-shm\n_meta.db-wal\n")?;

    // Initial commit
    let sig = bot_signature()?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    repo.commit(Some("HEAD"), &sig, &sig, "init: productive v3", &tree, &[])?;

    tracing::info!("git init {}", user_root.display());
    Ok(())
}

/// Stage a single file and create a commit.
pub fn commit_file(user_root: &Path, rel_path: &str, message: &str) -> Result<()> {
    let repo = Repository::open(user_root)
        .with_context(|| format!("opening repo at {}", user_root.display()))?;

    let mut index = repo.index()?;
    index.add_path(Path::new(rel_path))
        .with_context(|| format!("staging {}", rel_path))?;
    index.write()?;

    let sig = bot_signature()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let parent = match repo.head() {
        Ok(h) => Some(repo.find_commit(h.target().unwrap())?),
        Err(_) => None,
    };
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(())
}

/// Stage a deletion (git rm) and commit.
pub fn commit_remove(user_root: &Path, rel_path: &str, message: &str) -> Result<()> {
    let repo = Repository::open(user_root)
        .with_context(|| format!("opening repo at {}", user_root.display()))?;

    let mut index = repo.index()?;
    index.remove_path(Path::new(rel_path))
        .with_context(|| format!("git rm {}", rel_path))?;
    index.write()?;

    let sig = bot_signature()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let parent = repo.head()?.target().map(|oid| repo.find_commit(oid)).transpose()?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(())
}

/// Stage a rename (remove old path, add new path) and commit in one shot.
pub fn commit_rename(user_root: &Path, old_rel: &str, new_rel: &str, message: &str) -> Result<()> {
    let repo = Repository::open(user_root)
        .with_context(|| format!("opening repo at {}", user_root.display()))?;

    let mut index = repo.index()?;
    index.remove_path(Path::new(old_rel)).ok(); // ignore if not tracked
    index.add_path(Path::new(new_rel))
        .with_context(|| format!("staging {}", new_rel))?;
    index.write()?;

    let sig = bot_signature()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let parent = match repo.head() {
        Ok(h) => Some(repo.find_commit(h.target().unwrap())?),
        Err(_) => None,
    };
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(())
}

fn bot_signature() -> Result<Signature<'static>> {
    Ok(Signature::now("Productive v3", "productive@localhost")?)
}
