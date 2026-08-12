use sha2::{Sha256, Digest};
use std::collections::HashMap;

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "as", "is", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "shall", "can",
    "not", "no", "nor", "so", "yet", "each", "every", "few", "more", "most",
    "other", "some", "any", "it", "its", "i", "my", "me", "we", "our",
    "you", "your", "he", "his", "she", "her", "they", "their", "then",
    "there", "here", "also", "just", "like", "new", "get", "use", "one",
    "two", "if", "into", "after", "before", "very", "make", "see", "set",
    "per", "via", "etc", "all", "that", "this", "these", "those", "what",
    "which", "who", "whom", "when", "where", "why", "how", "both", "either",
    "neither", "than", "such", "can", "add", "its", "out", "now",
];

/// Extract top-5 representative keywords.
/// Weights: title × 3, description × 2, body × 1.
pub fn extract_keywords(title: &str, description: &str, body: &str) -> Vec<String> {
    let mut freq: HashMap<String, u32> = HashMap::new();
    add_tokens(title, 3, &mut freq);
    add_tokens(description, 2, &mut freq);
    add_tokens(body, 1, &mut freq);
    let mut scored: Vec<(String, u32)> = freq.into_iter().collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    scored.into_iter().take(5).map(|(k, _)| k).collect()
}

fn add_tokens(text: &str, weight: u32, freq: &mut HashMap<String, u32>) {
    for token in tokenize(text) {
        *freq.entry(token).or_insert(0) += weight;
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(|t| t.to_lowercase())
        .filter(|t| !STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// SHA-256 fingerprint of title+body (first 16 hex chars). Stable across restarts.
pub fn source_hash(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update(b"|");
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

/// Returns true when keywords need re-extraction (content changed or never computed).
pub fn should_refresh(title: &str, body: &str, stored_hash: Option<&str>) -> bool {
    stored_hash.map_or(true, |h| h != source_hash(title, body))
}
