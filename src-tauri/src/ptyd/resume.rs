use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_JSON: usize = 1024 * 1024;
const PROCESS_CLOCK_SLACK_MS: u64 = 2_000;
const SWITCH_OUTPUT_WINDOW_MS: u64 = 2_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeSession {
    pub agent: String,
    pub id: String,
    pub cwd: String,
    pub modified_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub pid: u32,
    pub id: String,
    pub cwd: String,
    pub changed_ms: u64,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub pane: String,
    pub agent: String,
    pub pid: u32,
    pub started_ms: u64,
    pub last_output_ms: u64,
    pub previous: Option<Binding>,
    pub hint: Option<ResumeRecipe>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResumeRecipe {
    pub agent: String,
    pub id: String,
    pub cwd: String,
}

impl Observation {
    pub fn recipe(&self) -> Option<ResumeRecipe> {
        self.previous.as_ref().map(|b| ResumeRecipe {
            agent: self.agent.clone(),
            id: b.id.clone(),
            cwd: b.cwd.clone(),
        })
    }
}

#[derive(Clone)]
struct Cached {
    modified_ms: u64,
    len: u64,
    session: Option<NativeSession>,
}

#[derive(Default)]
pub struct ResumeCache {
    files: HashMap<PathBuf, Cached>,
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn root(agent: &str) -> Option<PathBuf> {
    match agent {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".claude")))
            .map(|p| p.join("projects")),
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".codex")))
            .map(|p| p.join("sessions")),
        "kimi" => std::env::var_os("KIMI_CODE_HOME")
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".kimi-code")))
            .map(|p| p.join("sessions")),
        _ => None,
    }
}

fn files_at(dir: &Path, depth: u8, name: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() && depth > 0 {
            files_at(&path, depth - 1, name, out);
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(name) {
            out.push(path);
        }
    }
}

fn read_prefix(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_JSON as u64).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_cwd(cwd: &str) -> bool {
    cwd.starts_with('/') && !cwd.contains('\0')
}

fn parse(agent: &str, path: &Path, modified_ms: u64) -> Option<NativeSession> {
    let body = read_prefix(path)?;
    let (id, cwd) = match agent {
        "codex" => {
            let line = body.lines().next()?;
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            if value.get("type")?.as_str()? != "session_meta" {
                return None;
            }
            let payload = value.get("payload")?;
            (
                payload.get("id")?.as_str()?.to_string(),
                payload.get("cwd")?.as_str()?.to_string(),
            )
        }
        "kimi" => {
            let value: serde_json::Value = serde_json::from_str(&body).ok()?;
            (
                value.get("id")?.as_str()?.to_string(),
                value.get("cwd")?.as_str()?.to_string(),
            )
        }
        "claude" => {
            let id = path.file_stem()?.to_string_lossy().into_owned();
            let mut cwd = None;
            for line in body.lines().take(256) {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if value.get("sessionId").and_then(|v| v.as_str()) != Some(id.as_str()) {
                    continue;
                }
                if let Some(dir) = value.get("cwd").and_then(|v| v.as_str()) {
                    cwd = Some(dir.to_string());
                    break;
                }
            }
            (id, cwd?)
        }
        _ => return None,
    };
    if !valid_id(&id) || !valid_cwd(&cwd) {
        return None;
    }
    Some(NativeSession { agent: agent.to_string(), id, cwd, modified_ms })
}

impl ResumeCache {
    pub fn scan(&mut self, agent: &str) -> Vec<NativeSession> {
        let Some(root) = root(agent) else { return vec![] };
        let mut paths = Vec::new();
        match agent {
            "claude" => files_at(&root, 1, ".jsonl", &mut paths),
            "codex" => files_at(&root, 3, ".jsonl", &mut paths),
            "kimi" => files_at(&root, 2, "state.json", &mut paths),
            _ => return vec![],
        }
        let mut out = Vec::new();
        for path in paths {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let modified_ms = millis(meta.modified());
            let len = meta.len();
            let cached = self.files.get(&path).cloned();
            let entry = match cached {
                Some(c) if c.modified_ms == modified_ms && c.len == len => c,
                _ => {
                    let session = parse(agent, &path, modified_ms);
                    let c = Cached { modified_ms, len, session };
                    self.files.insert(path.clone(), c.clone());
                    c
                }
            };
            if let Some(session) = entry.session {
                out.push(session);
            }
        }
        out
    }
}

fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string()
}

fn same_dir(a: &str, b: &str) -> bool {
    canonical(a) == canonical(b)
}

fn initial_candidate<'a>(o: &Observation, cwd: &str, n: &'a NativeSession) -> bool {
    let hinted = o.hint.as_ref().is_some_and(|h| h.agent == n.agent && h.id == n.id);
    o.agent == n.agent
        && same_dir(cwd, &n.cwd)
        && (hinted || n.modified_ms.saturating_add(PROCESS_CLOCK_SLACK_MS) >= o.started_ms)
}

/// Reconcile one process sweep. A binding is stable for the life of the agent
/// process; a new native session replaces it only when this pane alone produced
/// output at the new file's first appearance. Anything less certain stays put.
pub fn resolve(observations: &mut [Observation], cwds: &HashMap<String, String>, native: &[NativeSession]) {
    let mut used: HashSet<(String, String)> = observations
        .iter()
        .filter_map(|o| {
            o.previous.as_ref().filter(|b| b.pid == o.pid).map(|b| (o.agent.clone(), b.id.clone()))
        })
        .collect();
    let activity: Vec<(String, String, u64)> = observations
        .iter()
        .map(|o| (o.pane.clone(), o.agent.clone(), o.last_output_ms))
        .collect();

    // First preserve existing process bindings and notice an unambiguous
    // in-process switch (/clear, /new, or a fork).
    for o in observations.iter_mut() {
        let current_cwd = cwds.get(&o.pane).cloned().unwrap_or_default();
        let previous = o.previous.clone().filter(|b| b.pid == o.pid);
        let Some(previous) = previous else {
            o.previous = None;
            continue;
        };
        let current = native.iter().find(|n| {
            n.agent == o.agent && n.id == previous.id && same_dir(&n.cwd, &previous.cwd)
        });
        let Some(current) = current else {
            o.previous = None;
            used.remove(&(o.agent.clone(), previous.id));
            continue;
        };
        let switches: Vec<&NativeSession> = native
            .iter()
            .filter(|n| {
                initial_candidate(o, &current_cwd, n)
                    && n.id != current.id
                    && n.modified_ms > previous.changed_ms
                    && n.modified_ms.abs_diff(o.last_output_ms) <= SWITCH_OUTPUT_WINDOW_MS
                    && !used.contains(&(n.agent.clone(), n.id.clone()))
            })
            .collect();
        let contested = switches.iter().any(|n| {
            activity.iter().any(|(pane, agent, last_output)| {
                pane != &o.pane && agent == &o.agent && last_output.abs_diff(n.modified_ms) <= SWITCH_OUTPUT_WINDOW_MS
            })
        });
        if switches.len() == 1 && !contested {
            let n = switches[0];
            used.remove(&(o.agent.clone(), previous.id));
            used.insert((n.agent.clone(), n.id.clone()));
            o.previous = Some(Binding {
                pid: o.pid,
                id: n.id.clone(),
                cwd: n.cwd.clone(),
                changed_ms: n.modified_ms,
            });
        } else {
            o.previous = Some(Binding { changed_ms: current.modified_ms, ..previous });
        }
    }

    // New processes choose the native file touched nearest their start. Pairs
    // are claimed globally so two panes can never be handed the same session.
    let mut pairs = Vec::new();
    for (oi, o) in observations.iter().enumerate() {
        if o.previous.is_some() {
            continue;
        }
        let Some(cwd) = cwds.get(&o.pane) else { continue };
        for n in native {
            if initial_candidate(o, cwd, n) && !used.contains(&(n.agent.clone(), n.id.clone())) {
                pairs.push((n.modified_ms.abs_diff(o.started_ms), oi, n));
            }
        }
    }
    pairs.sort_by_key(|(score, oi, n)| (*score, *oi, n.id.clone()));
    let mut assigned = HashSet::new();
    for (score, oi, n) in pairs {
        if assigned.contains(&oi) || used.contains(&(n.agent.clone(), n.id.clone())) {
            continue;
        }
        // An exact tie is not evidence. Leave both alone rather than letting
        // HashMap iteration order decide which conversation a pane gets.
        let tied = observations.iter().enumerate().any(|(other_i, other)| {
            other_i != oi
                && !assigned.contains(&other_i)
                && other.previous.is_none()
                && cwds.get(&other.pane).is_some_and(|cwd| initial_candidate(other, cwd, n))
                && n.modified_ms.abs_diff(other.started_ms) == score
        });
        if tied {
            continue;
        }
        assigned.insert(oi);
        used.insert((n.agent.clone(), n.id.clone()));
        observations[oi].previous = Some(Binding {
            pid: observations[oi].pid,
            id: n.id.clone(),
            cwd: n.cwd.clone(),
            changed_ms: n.modified_ms,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zero-resume-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_claude_session_metadata() {
        let dir = temp("claude");
        let project = dir.join("projects/-tmp-work");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("abc-123.jsonl");
        std::fs::write(&file, concat!(
            "{\"type\":\"last-prompt\",\"sessionId\":\"abc-123\"}\n",
            "{\"type\":\"attachment\",\"sessionId\":\"abc-123\",\"cwd\":\"/tmp/work\"}\n",
            "{\"message\":\"not needed\"}\n"
        )).unwrap();
        let got = parse("claude", &file, 42).unwrap();
        assert_eq!(got, NativeSession { agent: "claude".into(), id: "abc-123".into(), cwd: "/tmp/work".into(), modified_ms: 42 });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_codex_and_kimi_metadata() {
        let dir = temp("formats");
        let codex = dir.join("rollout.jsonl");
        std::fs::write(&codex, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"/tmp/codex\"}}\n").unwrap();
        assert_eq!(parse("codex", &codex, 1).unwrap().id, "codex-1");
        let kimi = dir.join("state.json");
        std::fs::write(&kimi, "{\"id\":\"session_kimi_1\",\"cwd\":\"/tmp/kimi\",\"lastPrompt\":\"private\"}").unwrap();
        let got = parse("kimi", &kimi, 2).unwrap();
        assert_eq!((got.id.as_str(), got.cwd.as_str()), ("session_kimi_1", "/tmp/kimi"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_or_oversize_metadata_is_not_a_session() {
        let dir = temp("bad");
        let file = dir.join("state.json");
        std::fs::write(&file, "x".repeat(MAX_JSON + 1)).unwrap();
        assert!(parse("kimi", &file, 0).is_none());
        std::fs::write(&file, "{\"id\":\"bad';rm\",\"cwd\":\"/tmp/work\"}").unwrap();
        assert!(parse("kimi", &file, 0).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn native(agent: &str, id: &str, cwd: &str, modified_ms: u64) -> NativeSession {
        NativeSession { agent: agent.into(), id: id.into(), cwd: cwd.into(), modified_ms }
    }

    fn observation(pane: &str, pid: u32, started_ms: u64) -> Observation {
        Observation {
            pane: pane.into(), agent: "claude".into(), pid, started_ms,
            last_output_ms: started_ms, previous: None, hint: None,
        }
    }

    #[test]
    fn simultaneous_panes_in_one_directory_get_distinct_sessions() {
        let cwds = HashMap::from([("a".into(), "/tmp/work".into()), ("b".into(), "/tmp/work".into())]);
        let native = [native("claude", "one", "/tmp/work", 10_100), native("claude", "two", "/tmp/work", 20_100)];
        let mut panes = [observation("a", 1, 10_000), observation("b", 2, 20_000)];
        resolve(&mut panes, &cwds, &native);
        assert_eq!(panes[0].previous.as_ref().unwrap().id, "one");
        assert_eq!(panes[1].previous.as_ref().unwrap().id, "two");
    }

    #[test]
    fn exact_ties_and_other_directories_stay_unbound() {
        let cwds = HashMap::from([("a".into(), "/tmp/work".into()), ("b".into(), "/tmp/work".into())]);
        let native = [native("claude", "one", "/tmp/work", 10_000), native("claude", "other", "/tmp/other", 10_000)];
        let mut panes = [observation("a", 1, 10_000), observation("b", 2, 10_000)];
        resolve(&mut panes, &cwds, &native);
        assert!(panes.iter().all(|p| p.previous.is_none()));
    }

    #[test]
    fn a_saved_hint_binds_an_old_conversation_without_touching_it() {
        let cwds = HashMap::from([("a".into(), "/tmp/work".into())]);
        let native = [native("claude", "one", "/tmp/work", 100)];
        let mut panes = [observation("a", 1, 30_000)];
        panes[0].hint = Some(ResumeRecipe {
            agent: "claude".into(), id: "one".into(), cwd: "/tmp/work".into(),
        });
        resolve(&mut panes, &cwds, &native);
        assert_eq!(panes[0].previous.as_ref().unwrap().id, "one");
    }

    #[test]
    fn a_bound_session_tracks_its_process_and_switches_on_new_activity() {
        let cwds = HashMap::from([("a".into(), "/tmp/work".into())]);
        let mut panes = [observation("a", 1, 10_000)];
        let first = [native("claude", "one", "/tmp/work", 10_100)];
        resolve(&mut panes, &cwds, &first);
        assert_eq!(panes[0].previous.as_ref().unwrap().id, "one");
        panes[0].last_output_ms = 30_000;
        let second = [first[0].clone(), native("claude", "two", "/tmp/work", 30_000)];
        resolve(&mut panes, &cwds, &second);
        assert_eq!(panes[0].previous.as_ref().unwrap().id, "two");
        panes[0].pid = 2;
        resolve(&mut panes, &cwds, &second);
        assert_ne!(panes[0].previous.as_ref().unwrap().pid, 1);
    }
}
