//! Zoxide-style frecency URL jump index.
//!
//! Short tokens in the omnibox (`yt`, `ama`, `gh`, `hn`, …) match either:
//! 1. Learned `(query_token -> target)` pairs stored in `jump.json` (weighted by
//!    zoxide-style recency decay), or
//! 2. Aggregated host frecency from `HistoryStore` matched by exact domain,
//!    prefix (`ama` -> `amazon.com`), word/CamelCase initials (`yt` -> "YouTube",
//!    `hn` -> "Hacker News"), or anchored subsequence (`yt` -> `youtube.com`).
//!
//! Pressing `Enter` jumps directly when confident (`jump_record` boosts the
//! score); pressing `Shift+Enter` runs a normal web search and calls
//! `jump_demote` so a wrong guess stops hijacking that token.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::history::HistoryStore;

const MIN_LEARNED_SCORE: f64 = 0.5;
const MIN_HISTORY_VISITS: u32 = 2;
const MAX_QUERIES: usize = 2_000;
const MAX_TARGETS_PER_QUERY: usize = 6;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
pub struct JumpMatch {
    pub url: String,
    pub host: String,
    pub label: String,
    pub learned: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct JumpTarget {
    url: String,
    host: String,
    score: f64,
    last_used_ms: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct JumpDisk {
    #[serde(default)]
    entries: HashMap<String, Vec<JumpTarget>>,
    #[serde(default)]
    suppressed: HashMap<String, HashSet<String>>,
}

#[derive(Default)]
pub struct JumpStore {
    data: RwLock<JumpDisk>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
}

impl JumpStore {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            data: RwLock::new(JumpDisk::default()),
            path: Some(path),
            dirty: AtomicBool::new(false),
            hydrated: AtomicBool::new(false),
        }
    }

    pub fn restore(path: PathBuf) -> Self {
        let s = Self::empty(path);
        s.hydrate();
        s
    }

    pub fn hydrate(&self) {
        if let Some(path) = &self.path {
            if let Ok(raw) = std::fs::read_to_string(path) {
                if let Ok(disk) = serde_json::from_str::<JumpDisk>(&raw) {
                    let mut guard = self.data.write();
                    for (q, targets) in disk.entries {
                        let slot = guard.entries.entry(q).or_default();
                        for t in targets {
                            if !slot.iter().any(|x| x.url == t.url) {
                                slot.push(t);
                            }
                        }
                    }
                    for (q, hosts) in disk.suppressed {
                        guard.suppressed.entry(q).or_default().extend(hosts);
                    }
                }
            }
        }
        self.hydrated.store(true, Ordering::Release);
    }

    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let snapshot = {
            let d = self.data.read();
            JumpDisk {
                entries: d.entries.clone(),
                suppressed: d.suppressed.clone(),
            }
        };
        crate::persist::save_json(path, &snapshot, crate::persist::Durability::Barrier);
    }

    pub fn persist_if_hydrated(&self) {
        if self.hydrated.load(Ordering::Acquire) {
            self.persist_if_dirty();
        }
    }

    /// Best jump match for `raw_query`, consulting learned mappings first and
    /// falling back to `HistoryStore` host frecency.
    pub fn match_query(&self, raw_query: &str, history: &HistoryStore) -> Option<JumpMatch> {
        let q = normalize_query(raw_query)?;
        let now = now_ms();

        let (best_learned, suppressed_hosts) = {
            let d = self.data.read();
            let sup = d.suppressed.get(&q).cloned().unwrap_or_default();
            let learned = d
                .entries
                .get(&q)
                .and_then(|targets| {
                    targets
                        .iter()
                        .filter(|t| t.score >= MIN_LEARNED_SCORE && !sup.contains(&t.host))
                        .max_by(|a, b| {
                            let sa = a.score * recency_factor(now.saturating_sub(a.last_used_ms));
                            let sb = b.score * recency_factor(now.saturating_sub(b.last_used_ms));
                            sa.total_cmp(&sb)
                        })
                        .cloned()
                });
            (learned, sup)
        };

        if let Some(t) = best_learned {
            return Some(JumpMatch {
                url: t.url,
                label: t.host.clone(),
                host: t.host,
                learned: true,
            });
        }

        // Tier 2: History host frecency + zoxide prefix/acronym/subsequence match.
        let candidates = history.host_summaries();
        let mut best: Option<(f64, JumpMatch)> = None;
        for c in candidates {
            if c.visits < MIN_HISTORY_VISITS || suppressed_hosts.contains(&c.host) {
                continue;
            }
            let Some(quality) = score_host_match(&q, &c.host, &c.title) else {
                continue;
            };
            let frecency = (c.visits as f64).ln_1p() * recency_factor(now.saturating_sub(c.last_visit_ms));
            let total = quality * frecency;
            if best.as_ref().is_none_or(|(b, _)| total > *b) {
                best = Some((
                    total,
                    JumpMatch {
                        url: c.url,
                        label: c.host.clone(),
                        host: c.host,
                        learned: false,
                    },
                ));
            }
        }
        best.map(|(_, m)| m)
    }

    /// Boost `(query -> url)` after the user accepts a jump or history match.
    pub fn record(&self, raw_query: &str, url: &str) {
        let Some(q) = normalize_query(raw_query) else {
            return;
        };
        let Some(host) = extract_host(url) else {
            return;
        };
        let now = now_ms();
        {
            let mut d = self.data.write();
            if let Some(sup) = d.suppressed.get_mut(&q) {
                sup.remove(&host);
                if sup.is_empty() {
                    d.suppressed.remove(&q);
                }
            }
            let slot = d.entries.entry(q).or_default();
            if let Some(existing) = slot.iter_mut().find(|t| t.host == host) {
                existing.url = url.to_string();
                existing.score = (existing.score + 2.0).min(1_000.0);
                existing.last_used_ms = now;
            } else {
                slot.push(JumpTarget {
                    url: url.to_string(),
                    host,
                    score: 4.0,
                    last_used_ms: now,
                });
                if slot.len() > MAX_TARGETS_PER_QUERY {
                    slot.sort_by(|a, b| b.score.total_cmp(&a.score));
                    slot.truncate(MAX_TARGETS_PER_QUERY);
                }
            }
            if d.entries.len() > MAX_QUERIES {
                if let Some(oldest_key) = d
                    .entries
                    .iter()
                    .min_by_key(|(_, v)| v.iter().map(|t| t.last_used_ms).max().unwrap_or(0))
                    .map(|(k, _)| k.clone())
                {
                    d.entries.remove(&oldest_key);
                }
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Demote/suppress `(query -> url)` when the user explicitly forces a search
    /// with `Shift+Enter` instead of taking the suggested jump.
    pub fn demote(&self, raw_query: &str, url: &str) {
        let Some(q) = normalize_query(raw_query) else {
            return;
        };
        let Some(host) = extract_host(url) else {
            return;
        };
        {
            let mut d = self.data.write();
            if let Some(slot) = d.entries.get_mut(&q) {
                for t in slot.iter_mut() {
                    if t.host == host {
                        t.score *= 0.25;
                    }
                }
                slot.retain(|t| t.score >= MIN_LEARNED_SCORE);
                if slot.is_empty() {
                    d.entries.remove(&q);
                }
            }
            d.suppressed.entry(q).or_default().insert(host);
        }
        self.dirty.store(true, Ordering::Relaxed);
    }
}

/// Only short, single-word, non-URL tokens trigger zoxide jumps.
fn normalize_query(raw: &str) -> Option<String> {
    let q = raw.trim().to_lowercase();
    if q.len() < 2 || q.len() > 48 {
        return None;
    }
    if q.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    if q.starts_with('!')
        || q.starts_with('@')
        || q.starts_with('>')
        || q.contains("://")
        || q.contains('.')
        || q.contains('/')
        || q.contains(':')
        || q.contains('?')
        || q.contains('#')
    {
        return None;
    }
    Some(q)
}

fn extract_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let raw = rest.split(['/', '?', '#']).next()?;
    let stripped = raw.strip_prefix("www.").unwrap_or(raw).to_lowercase();
    if stripped.is_empty() {
        None
    } else {
        Some(stripped)
    }
}

fn recency_factor(age_ms: u64) -> f64 {
    const HOUR: u64 = 3_600_000;
    const DAY: u64 = 24 * HOUR;
    if age_ms < HOUR {
        4.0
    } else if age_ms < DAY {
        2.0
    } else if age_ms < 7 * DAY {
        1.0
    } else if age_ms < 30 * DAY {
        0.5
    } else {
        0.25
    }
}

/// Extract main domain label (`news.ycombinator.com` -> `ycombinator`,
/// `youtube.com` -> `youtube`, `docs.rs` -> `docs`).
fn domain_base(host: &str) -> &str {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 3 {
        // e.g. news.ycombinator.com -> pick longest non-TLD label or second-to-last if > 2 chars
        let candidate = parts[parts.len() - 2];
        if candidate.len() <= 3 && parts.len() >= 3 {
            // e.g. bbc.co.uk -> bbc
            parts[parts.len() - 3]
        } else if parts[0].len() >= 3 && candidate.len() > parts[0].len() {
            candidate
        } else {
            parts[0]
        }
    } else {
        parts.first().copied().unwrap_or(host)
    }
}

/// Extract word + CamelCase initials from title (`"YouTube"` -> `"yt"`,
/// `"Hacker News"` -> `"hn"`, `"GitHub"` -> `"gh"`).
fn title_initials(title: &str) -> String {
    let mut out = String::new();
    let mut prev_is_sep = true;
    let mut prev_is_lower = false;
    for ch in title.chars() {
        if !ch.is_alphanumeric() {
            prev_is_sep = true;
            prev_is_lower = false;
            continue;
        }
        if prev_is_sep || (prev_is_lower && ch.is_uppercase()) {
            out.extend(ch.to_lowercase());
        }
        prev_is_sep = false;
        prev_is_lower = ch.is_lowercase();
    }
    out
}

/// Anchored ordered subsequence score starting at `hay[0]` (`q` chars matched
/// in order, penalizing large gaps).
fn anchored_subseq_score(q: &str, hay: &str) -> Option<f64> {
    let mut q_chars = q.chars();
    let first_q = q_chars.next()?;
    let mut hay_chars = hay.char_indices();
    let (_, first_h) = hay_chars.next()?;
    if first_q != first_h {
        return None;
    }
    let mut last_idx = 0usize;
    let mut gap_sum = 0usize;
    for qc in q_chars {
        let found = hay_chars.find(|(_, hc)| *hc == qc)?;
        gap_sum += found.0.saturating_sub(last_idx).saturating_sub(1);
        last_idx = found.0;
    }
    let score = (55.0 - (gap_sum as f64) * 2.5).max(15.0);
    Some(score)
}

fn score_host_match(q: &str, host: &str, title: &str) -> Option<f64> {
    let base = domain_base(host);
    if base == q || host == q {
        return Some(100.0);
    }
    if base.starts_with(q) || host.starts_with(q) {
        let coverage = (q.len() as f64 / base.len().max(1) as f64) * 10.0;
        return Some(80.0 + coverage);
    }
    let initials = title_initials(title);
    if !initials.is_empty() && (initials == q || initials.starts_with(q)) {
        return Some(72.0);
    }
    // Check dot-separated host segments (e.g. `news.ycombinator.com` -> `ny` or `yc`)
    let host_initials: String = host
        .split('.')
        .filter(|s| !matches!(*s, "com" | "org" | "net" | "io" | "dev" | "ai" | "co" | "uk" | "au"))
        .filter_map(|s| s.chars().next())
        .collect();
    if host_initials.len() >= 2 && (host_initials == q || host_initials.starts_with(q)) {
        return Some(68.0);
    }
    if let Some(sub) = anchored_subseq_score(q, base) {
        return Some(sub);
    }
    // Fall back to subdomain prefix (e.g., `mail` -> `mail.google.com`)
    if host.split('.').any(|seg| seg.starts_with(q)) {
        return Some(65.0);
    }
    None
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn jump_match(
    query: String,
    history: State<'_, HistoryStore>,
    jump: State<'_, JumpStore>,
) -> Option<JumpMatch> {
    jump.match_query(&query, &history)
}

#[tauri::command]
pub fn jump_record(query: String, url: String, jump: State<'_, JumpStore>) {
    jump.record(&query, &url);
}

#[tauri::command]
pub fn jump_demote(query: String, url: String, jump: State<'_, JumpStore>) {
    jump.demote(&query, &url);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_urls_multiword_and_single_char() {
        let h = HistoryStore::default();
        let j = JumpStore::default();
        h.record("https://www.youtube.com/", "YouTube");
        h.import(vec![("https://www.youtube.com/watch?v=1".into(), "YouTube".into(), now_ms(), 5)]);
        for bad in ["", "y", "yt music", "youtube.com", "https://youtube.com", "flux://time", "!yt", "@tabs"] {
            assert!(j.match_query(bad, &h).is_none(), "expected None for {bad:?}");
        }
    }

    #[test]
    fn matches_yt_to_youtube_and_ama_to_amazon() {
        let h = HistoryStore::default();
        let now = now_ms();
        h.import(vec![
            ("https://www.youtube.com/".into(), "YouTube".into(), now, 12),
            ("https://news.ycombinator.com/".into(), "Hacker News".into(), now, 20),
            ("https://www.amazon.com.au/".into(), "Amazon.com.au".into(), now, 8),
            ("https://amadeus.com/".into(), "Amadeus".into(), now - 10_000_000, 2),
        ]);
        let j = JumpStore::default();

        let yt = j.match_query("yt", &h).expect("yt should match YouTube");
        assert_eq!(yt.host, "youtube.com");
        assert_eq!(yt.url, "https://www.youtube.com/");
        assert!(!yt.learned);

        let ama = j.match_query("ama", &h).expect("ama should match Amazon");
        assert_eq!(ama.host, "amazon.com.au");
        assert!(!ama.learned);

        let hn = j.match_query("hn", &h).expect("hn should match Hacker News");
        assert_eq!(hn.host, "news.ycombinator.com");
    }

    #[test]
    fn requires_minimum_visits_for_unlearned_history() {
        let h = HistoryStore::default();
        h.record("https://obscure-oneoff.example/", "One Off");
        let j = JumpStore::default();
        assert!(j.match_query("ob", &h).is_none());
    }

    #[test]
    fn learned_jump_beats_history_and_demote_suppresses() {
        let h = HistoryStore::default();
        let now = now_ms();
        h.import(vec![
            ("https://www.amazon.com/".into(), "Amazon".into(), now, 30),
            ("https://amadeus.com/".into(), "Amadeus".into(), now, 10),
        ]);
        let j = JumpStore::default();

        // Learned override wins over higher-visit history entry.
        j.record("ama", "https://amadeus.com/");
        let m = j.match_query("ama", &h).unwrap();
        assert_eq!(m.host, "amadeus.com");
        assert!(m.learned);

        // Demoting Amadeus removes it and suppresses it so Amazon takes over.
        j.demote("ama", "https://amadeus.com/");
        let m2 = j.match_query("ama", &h).unwrap();
        assert_eq!(m2.host, "amazon.com");
        assert!(!m2.learned);

        // Demoting Amazon too leaves no match for "ama".
        j.demote("ama", "https://www.amazon.com/");
        assert!(j.match_query("ama", &h).is_none());

        // Re-recording clears suppression.
        j.record("ama", "https://www.amazon.com/");
        let m3 = j.match_query("ama", &h).unwrap();
        assert_eq!(m3.host, "amazon.com");
        assert!(m3.learned);
    }
}
