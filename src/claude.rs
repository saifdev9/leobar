//! Claude Code activity, read from the logs and sign-in Claude Code keeps on this PC.
//! Nothing is written; the sign-in token is sent only to api.anthropic.com.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BLOCK: i64 = 5 * 3600;
const WEEK: i64 = 7 * 86400;
const LIMITS_EVERY: i64 = 120;

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    ts: i64,
    id: String,
    session: String,
    cwd: String,
    model: String,
    tokens: u64,
}

#[derive(Deserialize)]
struct Line {
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<Msg>,
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Window {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Limits {
    five_hour: Option<Window>,
    seven_day: Option<Window>,
}

#[derive(Serialize)]
pub struct Session {
    project: String,
    model: String,
    last: i64,
    tokens: u64,
    messages: u32,
}

#[derive(Serialize)]
pub struct Snapshot {
    signed_in: bool,
    limits: Option<Limits>,
    limits_error: Option<String>,
    block_reset: Option<i64>,
    block_tokens: u64,
    day_tokens: u64,
    week_tokens: u64,
    sessions: Vec<Session>,
    models: Vec<(String, u64)>,
}

#[derive(Default)]
pub struct Logs {
    files: HashMap<PathBuf, (u64, Vec<Entry>)>,
    limits: Option<Limits>,
    limits_error: Option<String>,
    limits_at: i64,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude")
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// "2026-10-30T04:19:35.028Z" -> unix seconds (UTC, as Claude Code writes it).
pub fn parse_ts(s: &str) -> Option<i64> {
    let n = |a: usize, b: usize| -> Option<i64> { s.get(a..b)?.parse().ok() };
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, se) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    // days_from_civil, H. Hinnant
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + se)
}

fn parse_line(raw: &[u8]) -> Option<Entry> {
    if !raw.windows(7).any(|w| w == b"\"usage\"") {
        return None;
    }
    let l: Line = serde_json::from_slice(raw).ok()?;
    let m = l.message?;
    let u = m.usage?;
    Some(Entry {
        ts: parse_ts(l.timestamp.as_deref()?)?,
        id: format!("{}:{}", m.id.unwrap_or_default(), l.request_id.unwrap_or_default()),
        session: l.session_id.unwrap_or_default(),
        cwd: l.cwd.unwrap_or_default(),
        model: m.model.unwrap_or_default(),
        tokens: u.input_tokens.unwrap_or(0) + u.output_tokens.unwrap_or(0) + u.cache_creation_input_tokens.unwrap_or(0),
    })
}

/// Reads complete lines appended since `from`. Returns (new offset, entries, file was truncated).
fn read_from(path: &Path, from: u64) -> (u64, Vec<Entry>, bool) {
    let Ok(mut f) = File::open(path) else { return (from, vec![], false) };
    let len = f.metadata().map_or(0, |m| m.len());
    let reset = len < from;
    let from = if reset { 0 } else { from };
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(from)).is_err() || f.read_to_end(&mut buf).is_err() {
        return (from, vec![], reset);
    }
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let entries = buf[..end].split(|&b| b == b'\n').filter_map(parse_line).collect();
    (from + end as u64, entries, reset)
}

fn walk(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && depth > 0 {
            walk(&p, depth - 1, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
}

fn fetch_limits() -> Result<Limits, String> {
    let creds = std::fs::read_to_string(home().join(".credentials.json")).map_err(|_| "not signed in".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&creds).map_err(|e| e.to_string())?;
    let token = v["claudeAiOauth"]["accessToken"].as_str().ok_or("no Claude sign-in found")?;
    // ponytail: undocumented endpoint Claude Code itself uses for /usage; if it changes we fall back to log totals.
    ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("usage endpoint returned {code}"),
            other => other.kind().to_string(),
        })?
        .into_json()
        .map_err(|e| e.to_string())
}

impl Logs {
    fn refresh(&mut self, now: i64) {
        let mut paths = Vec::new();
        walk(&home().join("projects"), 3, &mut paths);
        let recent = |p: &PathBuf| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .is_some_and(|d| now - (d.as_secs() as i64) < WEEK)
        };
        let keep: HashSet<PathBuf> = paths.into_iter().filter(recent).collect();
        self.files.retain(|p, _| keep.contains(p));
        for p in keep {
            let (off, list) = self.files.entry(p.clone()).or_default();
            let (new_off, mut new, reset) = read_from(&p, *off);
            if reset {
                list.clear();
            }
            *off = new_off;
            list.append(&mut new);
            list.retain(|e| now - e.ts < WEEK);
        }
    }

    pub fn snapshot(&mut self) -> Snapshot {
        let now = now();
        self.refresh(now);
        if now - self.limits_at >= LIMITS_EVERY {
            self.limits_at = now;
            match fetch_limits() {
                Ok(l) => (self.limits, self.limits_error) = (Some(l), None),
                Err(e) => self.limits_error = Some(e),
            }
        }
        let mut seen = HashSet::new();
        let mut es: Vec<&Entry> = self.files.values().flat_map(|(_, v)| v).filter(|e| seen.insert(&e.id)).collect();
        es.sort_by_key(|e| e.ts);
        summarize(&es, now, self.limits.clone(), self.limits_error.clone())
    }
}

fn summarize(es: &[&Entry], now: i64, limits: Option<Limits>, limits_error: Option<String>) -> Snapshot {
    // 5-hour windows start on the hour of the first message after the previous window ended.
    let mut start: Option<i64> = None;
    for e in es {
        if start.is_none_or(|s| e.ts >= s + BLOCK) {
            start = Some(e.ts - e.ts.rem_euclid(3600));
        }
    }
    let active = start.filter(|s| now < s + BLOCK);
    let sum = |since: i64| es.iter().filter(|e| e.ts >= since).map(|e| e.tokens).sum();

    let mut by_session: HashMap<&str, Session> = HashMap::new();
    let mut by_model: HashMap<&str, u64> = HashMap::new();
    for e in es {
        *by_model.entry(&e.model).or_default() += e.tokens;
        if now - e.ts > 86400 {
            continue;
        }
        let s = by_session.entry(&e.session).or_insert_with(|| Session {
            project: Path::new(&e.cwd).file_name().map_or("?".into(), |n| n.to_string_lossy().into_owned()),
            model: String::new(),
            last: 0,
            tokens: 0,
            messages: 0,
        });
        (s.last, s.model) = (e.ts, e.model.clone());
        s.tokens += e.tokens;
        s.messages += 1;
    }
    let mut sessions: Vec<Session> = by_session.into_values().collect();
    sessions.sort_by_key(|s| -s.last);
    sessions.truncate(8);
    let mut models: Vec<(String, u64)> =
        by_model.into_iter().filter(|(m, _)| !m.is_empty() && !m.starts_with('<')).map(|(m, t)| (m.to_string(), t)).collect();
    models.sort_by_key(|m| std::cmp::Reverse(m.1));

    Snapshot {
        signed_in: home().join(".credentials.json").exists(),
        limits,
        limits_error,
        block_reset: active.map(|s| s + BLOCK),
        block_tokens: active.map_or(0, sum),
        day_tokens: sum(now - 86400),
        week_tokens: sum(now - WEEK),
        sessions,
        models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("2000-03-01T00:00:00.000Z"), Some(951_868_800));
        assert_eq!(parse_ts("2026-10-30T04:19:35.028Z"), Some(1_793_333_975));
        assert_eq!(parse_ts("garbage"), None);
    }

    #[test]
    fn lines_and_windows() {
        let line = br#"{"type":"assistant","timestamp":"2026-10-30T04:19:35.028Z","sessionId":"s1","cwd":"C:\\x\\leobar","requestId":"r1","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":4,"cache_creation_input_tokens":10,"cache_read_input_tokens":999,"output_tokens":6}}}"#;
        let e = parse_line(line).unwrap();
        assert_eq!((e.tokens, e.session.as_str(), e.model.as_str()), (20, "s1", "claude-opus-5-5"));
        assert!(parse_line(br#"{"type":"user","message":{"content":"hi"}}"#).is_none());

        let at = |ts, tokens| Entry { ts, tokens, id: ts.to_string(), session: "s".into(), cwd: "C:\\p".into(), model: "m".into() };
        let h = 3600;
        let es = [at(10 * h + 120, 5), at(12 * h, 7), at(15 * h + 1, 11)]; // third starts a new window at 15:00
        let refs: Vec<&Entry> = es.iter().collect();
        let s = summarize(&refs, 16 * h, None, None);
        assert_eq!((s.block_reset, s.block_tokens), (Some(20 * h), 11));
        assert_eq!(s.week_tokens, 23);
        assert_eq!(s.sessions[0].messages, 3);
    }
}
