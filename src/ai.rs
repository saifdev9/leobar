//! ChatGPT plan limits as Codex CLI records them in its own session logs. Read offline.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone)]
pub struct Limit {
    used_percent: f64,
    window_minutes: Option<u64>,
    resets_at: Option<i64>,
}

#[derive(Serialize, Default)]
pub struct Codex {
    found: bool,
    plan: Option<String>,
    primary: Option<Limit>,
    secondary: Option<Limit>,
    seen_at: i64,
}

#[derive(Deserialize)]
struct Line {
    timestamp: Option<String>,
    payload: Option<Payload>,
}
#[derive(Deserialize)]
struct Payload {
    rate_limits: Option<Rates>,
}
#[derive(Deserialize)]
struct Rates {
    primary: Option<Limit>,
    secondary: Option<Limit>,
    plan_type: Option<String>,
}

fn files(dir: &Path, out: &mut Vec<(u64, PathBuf)>, depth: u8) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && depth > 0 {
            files(&p, out, depth - 1);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            let t = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            out.push((t, p));
        }
    }
}

/// The newest rate-limit report from the most recent sessions.
pub fn codex() -> Codex {
    let mut all = vec![];
    files(&PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(r".codex\sessions"), &mut all, 4);
    all.sort_by_key(|f| std::cmp::Reverse(f.0));
    let mut c = Codex { found: !all.is_empty(), ..Default::default() };
    for (_, p) in all.iter().take(5) {
        let Ok(text) = std::fs::read_to_string(p) else { continue };
        let hit = text.lines().rev().filter(|l| l.contains("\"rate_limits\"")).find_map(|l| {
            let line: Line = serde_json::from_str(l).ok()?;
            let r = line.payload?.rate_limits?;
            r.primary.is_some().then_some((line.timestamp, r))
        });
        if let Some((ts, r)) = hit {
            c.plan = r.plan_type;
            c.primary = r.primary;
            c.secondary = r.secondary;
            c.seen_at = ts.as_deref().and_then(crate::claude::parse_ts).unwrap_or(0);
            break;
        }
    }
    c
}
