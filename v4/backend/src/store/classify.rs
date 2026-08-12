use crate::models::LinkLabel;

const DEPENDENCY_PHRASES: &[&str] = &[
    "depends on",
    "blocked by",
    "prerequisite",
    "requires",
    "need to",
    "needs to",
    "must have",
    "waiting for",
    "after completing",
    "once finished",
    "cannot proceed without",
    "contingent on",
];

/// Classify the link label between two docs using heuristics only (no LLM).
///
/// Priority order:
/// 1. Source body contains dependency language → Requires
/// 2. Source keywords are an asymmetric subset of target keywords → BelongsTo
/// 3. Default → RelatedTo
pub fn classify_link_label(
    src_body: &str,
    src_keywords: &[String],
    tgt_keywords: &[String],
) -> LinkLabel {
    let body_lower = src_body.to_lowercase();
    if DEPENDENCY_PHRASES.iter().any(|p| body_lower.contains(p)) {
        return LinkLabel::Requires;
    }

    if !src_keywords.is_empty() && !tgt_keywords.is_empty() {
        let src_in_tgt = src_keywords.iter().filter(|k| tgt_keywords.contains(k)).count();
        let tgt_in_src = tgt_keywords.iter().filter(|k| src_keywords.contains(k)).count();
        let src_overlap = src_in_tgt as f32 / src_keywords.len() as f32;
        let tgt_overlap = tgt_in_src as f32 / tgt_keywords.len() as f32;
        // src is a narrower doc (more of its keywords appear in tgt than vice versa)
        if src_overlap >= 0.5 && src_overlap > 2.0 * tgt_overlap + f32::EPSILON {
            return LinkLabel::BelongsTo;
        }
    }

    LinkLabel::RelatedTo
}
