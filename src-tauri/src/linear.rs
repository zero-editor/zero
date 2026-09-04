//! Linear — the issues beside the code they belong to.
//!
//! Three things this does that Linear's own web app can't, and they are the
//! reason it exists rather than a bookmark:
//!
//! 1. It answers *is this one started* from the checkout, not from the issue.
//!    A Linear issue says "In Progress" because somebody dragged it there; the
//!    branch, the worktree and the open PR say it because they exist. Every
//!    row carries both, and the disagreements are the interesting rows.
//! 2. It maps issues to *this project*, so a workspace of 84 issues across
//!    four repos shows the eleven that are this one's.
//! 3. It hands the identifier and the description to the agent in the terminal
//!    without a round trip through a browser and a clipboard.
//!
//! The pull request state is not fetched from GitHub. Linear's own GitHub
//! integration already attaches the PR to the issue and keeps a copy of its
//! status, branch, draft flag and conflict state in the attachment metadata,
//! so one Linear query answers what would otherwise be a Linear query plus a
//! `gh pr list` per repo. The cost is that a PR opened while the integration
//! is down never appears; the benefit is that the panel works on a repo whose
//! remote you have no `gh` credentials for.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

const API: &str = "https://api.linear.app/graphql";

// ─── stored credentials ──────────────────────────────────────────────────────

/// Tokens live in a file of their own, mode 0600, beside the other things the
/// app keeps in its config directory — not in the macOS keychain. The keychain
/// would be the better answer for a signed, installed app, but it keys access
/// by code signature, and local builds are ad-hoc signed with a *fresh*
/// identity on every rebuild (see CLAUDE.md, "Signing"), so a keychain item
/// would re-prompt for permission every single `tauri dev` rebuild. This is
/// where `gh` puts its token too.
///
/// **One token per project, not one per machine.** A Linear personal API key
/// is scoped to a single workspace, so a machine-wide token means every
/// project in the app can only ever see that one company's issues. Keyed by
/// project root, a consultancy's four clients are four workspaces, and a
/// repository that belongs to none of them simply has no token and says so.
fn tokens_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("linear-tokens.json"))
}

/// What is stored per project: the key, and the name of the workspace it turned
/// out to belong to. The name is a convenience — Preferences shows it beside
/// the project so "connected" says *to what* — and it is written at connect
/// time rather than looked up on every read, because a settings pane that
/// makes one network request per connected project to draw a label is a
/// settings pane that is blank whenever the network is slow.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Conn {
    token: String,
    #[serde(default)]
    org: Option<String>,
}

/// The file has held two shapes. Before the workspace name it was a bare
/// `{root: "lin_api_…"}`, and those entries have to keep working rather than
/// disconnecting everyone the first time this reads them.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredConn {
    Bare(String),
    Full(Conn),
}

impl From<StoredConn> for Conn {
    fn from(s: StoredConn) -> Conn {
        match s {
            StoredConn::Bare(token) => Conn { token, org: None },
            StoredConn::Full(c) => c,
        }
    }
}

fn load_tokens(app: &tauri::AppHandle) -> HashMap<String, Conn> {
    tokens_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, StoredConn>>(&s).ok())
        .map(|m| m.into_iter().map(|(k, v)| (k, v.into())).collect())
        .unwrap_or_default()
}

fn save_tokens(app: &tauri::AppHandle, map: &HashMap<String, Conn>) -> Result<(), String> {
    let p = tokens_path(app)?;
    fs::write(&p, serde_json::to_string_pretty(map).unwrap()).map_err(|e| e.to_string())?;
    // 0600 before anyone else can read it. Set after the file exists, which
    // leaves a window; the directory is already user-only, so that window is
    // inside a private directory rather than open to the world.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_token(app: &tauri::AppHandle, root: &str) -> Result<String, String> {
    let t = load_tokens(app).get(root).map(|c| c.token.trim().to_string()).unwrap_or_default();
    if t.is_empty() {
        return Err("this project isn't connected to Linear".into());
    }
    Ok(t)
}

fn write_token(app: &tauri::AppHandle, root: &str, token: &str, org: &str) -> Result<(), String> {
    let mut map = load_tokens(app);
    map.insert(
        root.to_string(),
        Conn {
            token: token.trim().to_string(),
            org: (!org.is_empty()).then(|| org.to_string()),
        },
    );
    save_tokens(app, &map)
}

// ─── the wire ────────────────────────────────────────────────────────────────

/// One client for the process: connection pooling matters when the panel polls,
/// and building a client is where the missing-provider panic below would fire.
///
/// The rustls in this build comes from tauri-plugin-updater, which selects
/// `rustls-no-provider` — no crypto backend is chosen for us, and reqwest
/// *panics* on `Client::new()` rather than failing a request. The updater
/// installs one when its plugin initialises, but that is an ordering promise
/// from another crate, so this installs ring's own and ignores the error that
/// means somebody already did.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("http client")
    })
}

async fn gql(token: &str, query: &str, vars: Value) -> Result<Value, String> {
    let res = client()
        .post(API)
        .header("Content-Type", "application/json")
        .header("Authorization", token)
        .json(&json!({ "query": query, "variables": vars }))
        .send()
        .await
        .map_err(|e| format!("Linear unreachable: {e}"))?;

    let status = res.status();
    let body: Value = res
        .json()
        .await
        .map_err(|e| format!("Linear sent something that isn't JSON: {e}"))?;

    // A GraphQL API answers 200 with an `errors` array as readily as it
    // answers 4xx, so both have to be looked at or a failure arrives as an
    // empty issue list — indistinguishable from a project with no issues.
    if let Some(errs) = body.get("errors").and_then(|e| e.as_array()) {
        let msg = errs
            .iter()
            .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        let msg = if msg.is_empty() { format!("HTTP {status}") } else { msg };
        return Err(if status == 400 || status == 401 {
            format!("Linear rejected the token: {msg}")
        } else {
            format!("Linear: {msg}")
        });
    }
    if !status.is_success() {
        return Err(format!("Linear: HTTP {status}"));
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| "Linear returned no data".to_string())
}

// ─── shapes handed to the frontend ───────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: i64,
    pub url: String,
    pub repo: String,
    /// Linear's own word for the state, with one change: `draft` is promoted
    /// out of the boolean, because a draft pull request means something
    /// different to a reviewer than an open one.
    ///
    /// Measured against this workspace, the words that actually arrive are
    /// `merged`, `inReview` and `closed` — *not* the `open`/`merged`/`closed`
    /// trio the shape suggests. Unknown words are passed through rather than
    /// mapped to a default, so a vocabulary Linear grows later shows up as
    /// itself instead of silently reading as "open".
    pub status: String,
    pub branch: String,
    pub has_conflicts: bool,
    pub target_branch: String,
}

/// What the checkout knows, which is the half Linear can't see.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    /// A local branch whose name is the issue's, or which carries the
    /// identifier. None when nobody has started it here.
    pub branch: Option<String>,
    /// That branch is checked out in a worktree, and where.
    pub worktree: Option<String>,
    /// That worktree is the one this project window is looking at.
    pub current: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub branch_name: String,
    pub priority: i64,
    pub state: String,
    pub state_type: String,
    pub state_color: String,
    pub state_position: f64,
    pub assignee: Option<String>,
    /// Their picture, when they have set one. Linear serves these from two
    /// hosts of its own, both named in the app's `img-src` — see
    /// tauri.conf.json, which is the only reason an `<img>` for one loads.
    pub assignee_avatar: Option<String>,
    /// Linear's own initials for them, so a person without a picture is
    /// still told apart from the next one, and is spelled the same way here
    /// as in Linear rather than by a second guess at how a name splits.
    pub assignee_initials: Option<String>,
    pub is_mine: bool,
    /// Which Linear project it belongs to, if any. Here so the panel's filter
    /// can offer the projects that actually appear, rather than asking Linear
    /// for a list of every project in the workspace and then showing options
    /// that match nothing.
    pub project: Option<String>,
    /// The team's key, for the same reason.
    pub team: String,
    pub labels: Vec<Label>,
    pub prs: Vec<Pr>,
    pub local: Local,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(flatten)]
    pub issue: Issue,
    pub description: String,
    pub created_at: String,
    pub comments: Vec<Comment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub name: String,
    pub email: String,
    pub org: String,
    pub url_key: String,
}

// ─── parsing ─────────────────────────────────────────────────────────────────

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn parse_prs(node: &Value) -> Vec<Pr> {
    let mut out = Vec::new();
    let Some(atts) = node.pointer("/attachments/nodes").and_then(|a| a.as_array()) else {
        return out;
    };
    for a in atts {
        if s(a, "sourceType") != "github" {
            continue;
        }
        let Some(m) = a.get("metadata") else { continue };
        // GitHub *issues* come through the same integration and carry no
        // `number`+`status` pair in the way a PR does; only pull requests have
        // a merge state, so that is the discriminator.
        let (Some(number), true) = (
            m.get("number").and_then(|n| n.as_i64()),
            m.get("status").is_some(),
        ) else {
            continue;
        };
        let raw = s(m, "status");
        let draft = m.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
        // A draft is only a draft while it is still open; GitHub keeps the flag
        // set on a draft that was closed, and "draft" would then hide the more
        // important half of that.
        let open = matches!(raw.as_str(), "open" | "inReview");
        let status = if open && draft { "draft".to_string() } else { raw };
        out.push(Pr {
            number,
            url: s(m, "url"),
            repo: s(m, "repoName"),
            status,
            branch: s(m, "branch"),
            has_conflicts: m.get("hasConflicts").and_then(|c| c.as_bool()).unwrap_or(false),
            target_branch: s(m, "targetBranch"),
        });
    }
    // Newest PR first: the one that matters is the one still open.
    out.sort_by(|a, b| b.number.cmp(&a.number));
    out
}

fn parse_issue(node: &Value, me: &str) -> Issue {
    let assignee = node
        .pointer("/assignee/displayName")
        .and_then(|x| x.as_str())
        .map(|x| x.to_string());
    let is_mine = node
        .pointer("/assignee/id")
        .and_then(|x| x.as_str())
        .is_some_and(|id| id == me);
    let labels = node
        .pointer("/labels/nodes")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .map(|l| Label { name: s(l, "name"), color: s(l, "color") })
                .collect()
        })
        .unwrap_or_default();
    Issue {
        id: s(node, "id"),
        identifier: s(node, "identifier"),
        title: s(node, "title"),
        url: s(node, "url"),
        branch_name: s(node, "branchName"),
        priority: node.get("priority").and_then(|p| p.as_i64()).unwrap_or(0),
        state: node.pointer("/state/name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        state_type: node.pointer("/state/type").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        state_color: node.pointer("/state/color").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        state_position: node.pointer("/state/position").and_then(|x| x.as_f64()).unwrap_or(0.0),
        assignee,
        assignee_avatar: node
            .pointer("/assignee/avatarUrl")
            .and_then(|x| x.as_str())
            .map(String::from),
        assignee_initials: node
            .pointer("/assignee/initials")
            .and_then(|x| x.as_str())
            .filter(|x| !x.is_empty())
            .map(String::from),
        is_mine,
        project: node.pointer("/project/name").and_then(|x| x.as_str()).map(String::from),
        team: node.pointer("/team/key").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        labels,
        prs: parse_prs(node),
        local: Local::default(),
        updated_at: s(node, "updatedAt"),
    }
}

// ─── queries ─────────────────────────────────────────────────────────────────

/// The window the panel lists: everything unfinished, plus what finished
/// recently. A done issue with an unmerged pull request is exactly the row
/// worth seeing, and a cycle's worth of completed work is the other thing
/// people look for. Narrowing past this is the panel's own job — it filters
/// what it already has rather than asking Linear again, so a filter costs
/// nothing and can be changed while you read.
fn window_filter() -> Value {
    json!({
        "or": [
            { "state": { "type": { "nin": ["completed", "canceled"] } } },
            { "completedAt": { "gt": "-P14D" } }
        ]
    })
}

const ISSUE_FIELDS: &str = r#"
  id identifier title url branchName priority updatedAt
  state { name type color position }
  assignee { id displayName avatarUrl initials }
  project { name }
  team { key }
  labels(first: 8) { nodes { name color } }
  attachments(first: 10) { nodes { sourceType metadata } }
"#;

// ─── the local half ──────────────────────────────────────────────────────────

/// Which local branch, if any, is this issue's. Exact match on Linear's own
/// suggested branch name first; failing that, any branch carrying the
/// identifier as a token — `fix/ecl-99`, `ecl-99-retry`, `vid/ECL-99` — since
/// the suggested name is a suggestion and people rename.
fn match_branch(branches: &[String], branch_name: &str, identifier: &str) -> Option<String> {
    if let Some(b) = branches.iter().find(|b| *b == branch_name) {
        return Some(b.clone());
    }
    let id = identifier.to_lowercase();
    branches
        .iter()
        .find(|b| {
            let lb = b.to_lowercase();
            lb.split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
                .any(|seg| seg == id || seg.starts_with(&format!("{id}-")))
        })
        .cloned()
}

fn local_state(root: &str, issues: &mut [Issue]) {
    let branches: Vec<String> = crate::git::run_git(root, &["branch", "--format=%(refname:short)"])
        .map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();

    // branch -> worktree path, from the same porcelain the worktree panel reads
    let mut wt: HashMap<String, String> = HashMap::new();
    if let Ok(out) = crate::git::run_git(root, &["worktree", "list", "--porcelain"]) {
        let mut path = String::new();
        for line in out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = p.to_string();
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                wt.insert(b.to_string(), path.clone());
            }
        }
    }

    for i in issues.iter_mut() {
        if let Some(b) = match_branch(&branches, &i.branch_name, &i.identifier) {
            let worktree = wt.get(&b).cloned();
            // `root` is the directory this project window has open, so the
            // worktree matching it is the one whose files are on screen.
            let current = worktree.as_deref().is_some_and(|w| {
                std::path::Path::new(w) == std::path::Path::new(root)
            });
            i.local = Local { branch: Some(b), worktree, current };
        }
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn linear_connected(app: tauri::AppHandle, root: String) -> bool {
    read_token(&app, &root).is_ok()
}

/// Store a token, but only one that works — a typo saved silently would show
/// up later as an empty panel rather than as a rejected paste.
#[tauri::command]
pub async fn linear_connect(
    app: tauri::AppHandle,
    root: String,
    token: String,
) -> Result<Viewer, String> {
    let data = gql(
        token.trim(),
        "{ viewer { name email } organization { name urlKey } }",
        json!({}),
    )
    .await?;
    let v = Viewer {
        name: data.pointer("/viewer/name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        email: data.pointer("/viewer/email").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        org: data.pointer("/organization/name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        url_key: data.pointer("/organization/urlKey").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    };
    write_token(&app, &root, &token, &v.org)?;
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// the project's root path — what disconnecting needs, and what the caller
    /// takes the project's name from
    pub root: String,
    /// the Linear workspace it is connected to. None for a connection made
    /// before this was recorded, which reads as "connected" with nothing after
    /// it rather than as a wrong name.
    pub org: Option<String>,
}

/// Every project holding a token, so Preferences can show what is connected,
/// to which workspace, and offer to undo it.
///
/// Connections made before the workspace name was recorded have none stored,
/// so this asks for theirs once and writes it down. That is the only reason
/// this is async: on a settled config it makes no requests at all, and a
/// workspace that can't be reached is reported as a connection without a name
/// rather than as no connection.
#[tauri::command]
pub async fn linear_connections(app: tauri::AppHandle) -> Vec<Connection> {
    let stored = load_tokens(&app);
    let mut out: Vec<Connection> = Vec::with_capacity(stored.len());
    let mut learned: Vec<(String, String)> = Vec::new();

    for (root, c) in stored.iter() {
        if c.token.trim().is_empty() {
            continue;
        }
        let mut org = c.org.clone();
        if org.is_none() {
            if let Ok(data) = gql(&c.token, "{ organization { name } }", json!({})).await {
                if let Some(name) = data.pointer("/organization/name").and_then(|x| x.as_str()) {
                    org = Some(name.to_string());
                    learned.push((root.clone(), name.to_string()));
                }
            }
        }
        out.push(Connection { root: root.clone(), org });
    }

    if !learned.is_empty() {
        let mut map = load_tokens(&app);
        for (root, name) in learned {
            if let Some(c) = map.get_mut(&root) {
                c.org = Some(name);
            }
        }
        let _ = save_tokens(&app, &map);
    }

    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}

#[tauri::command]
pub fn linear_disconnect(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let mut map = load_tokens(&app);
    map.remove(&root);
    save_tokens(&app, &map)
}

/// The list the panel polls. One request; the local half is git, which is
/// three subprocesses and no network.
#[tauri::command]
pub async fn linear_issues(app: tauri::AppHandle, root: String) -> Result<Vec<Issue>, String> {
    let token = read_token(&app, &root)?;

    let query = format!(
        "query Issues($f: IssueFilter) {{
           viewer {{ id }}
           issues(first: 150, filter: $f, orderBy: updatedAt) {{ nodes {{ {ISSUE_FIELDS} }} }}
         }}"
    );
    let data = gql(&token, &query, json!({ "f": window_filter() })).await?;
    let me = data.pointer("/viewer/id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut issues: Vec<Issue> = data
        .pointer("/issues/nodes")
        .and_then(|n| n.as_array())
        .map(|a| a.iter().map(|n| parse_issue(n, &me)).collect())
        .unwrap_or_default();

    let r = root.clone();
    let mut owned = std::mem::take(&mut issues);
    owned = crate::git::blocking(move || {
        local_state(&r, &mut owned);
        owned
    })
    .await;
    Ok(owned)
}

#[tauri::command]
pub async fn linear_issue(app: tauri::AppHandle, root: String, id: String) -> Result<IssueDetail, String> {
    let token = read_token(&app, &root)?;
    let query = format!(
        "query One($id: String!) {{
           viewer {{ id }}
           issue(id: $id) {{
             {ISSUE_FIELDS}
             description createdAt
             comments(first: 50) {{ nodes {{ id body createdAt user {{ displayName }} }} }}
           }}
         }}"
    );
    let data = gql(&token, &query, json!({ "id": id })).await?;
    let me = data.pointer("/viewer/id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let node = data.get("issue").filter(|n| !n.is_null()).ok_or("no such issue")?;

    let r = root.clone();
    let mut one = vec![parse_issue(node, &me)];
    one = crate::git::blocking(move || {
        local_state(&r, &mut one);
        one
    })
    .await;
    let issue = one.pop().unwrap();

    let comments = node
        .pointer("/comments/nodes")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .map(|c| Comment {
                    id: s(c, "id"),
                    body: s(c, "body"),
                    author: c
                        .pointer("/user/displayName")
                        .and_then(|x| x.as_str())
                        .unwrap_or("Linear")
                        .to_string(),
                    created_at: s(c, "createdAt"),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(IssueDetail {
        description: s(node, "description"),
        created_at: s(node, "createdAt"),
        comments,
        issue,
    })
}

#[tauri::command]
pub async fn linear_save_description(
    app: tauri::AppHandle,
    root: String,
    id: String,
    description: String,
) -> Result<(), String> {
    let token = read_token(&app, &root)?;
    let data = gql(
        &token,
        "mutation Save($id: String!, $input: IssueUpdateInput!) {
           issueUpdate(id: $id, input: $input) { success }
         }",
        json!({ "id": id, "input": { "description": description } }),
    )
    .await?;
    if data.pointer("/issueUpdate/success").and_then(|x| x.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err("Linear did not accept the edit".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_match_prefers_linears_own_name() {
        let bs = vec!["main".into(), "vid/ecl-99-kraken".into(), "ecl-99-old".into()];
        assert_eq!(
            match_branch(&bs, "vid/ecl-99-kraken", "ECL-99").as_deref(),
            Some("vid/ecl-99-kraken")
        );
    }

    #[test]
    fn branch_match_falls_back_to_the_identifier() {
        let bs = vec!["main".into(), "fix/ECL-99".into()];
        assert_eq!(match_branch(&bs, "vid/ecl-99-kraken", "ECL-99").as_deref(), Some("fix/ECL-99"));
    }

    #[test]
    fn branch_match_does_not_confuse_neighbouring_numbers() {
        // ecl-9 must not match ECL-99, and ecl-990 must not either
        let bs = vec!["fix/ecl-990".into(), "fix/ecl-9".into()];
        assert_eq!(match_branch(&bs, "vid/ecl-99-x", "ECL-99"), None);
    }

    #[test]
    fn draft_is_promoted_out_of_the_boolean() {
        let node = json!({ "attachments": { "nodes": [
            { "sourceType": "github", "metadata": {
                "number": 7, "status": "open", "draft": true, "url": "u",
                "repoName": "r", "branch": "b", "targetBranch": "main" } }
        ]}});
        assert_eq!(parse_prs(&node)[0].status, "draft");
    }

    /// The one thing unit tests can't answer: whether this crate's reqwest can
    /// actually negotiate TLS. The rustls stack here comes from
    /// tauri-plugin-updater and is built `rustls-no-provider`, so a wrong
    /// feature selection fails at *runtime*, on the first request, not at
    /// compile time. Ignored by default because it needs the network and a
    /// token:
    ///
    /// ```sh
    /// LINEAR_TOKEN=lin_api_… cargo test --no-default-features \
    ///     linear::tests::wire -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs the network and $LINEAR_TOKEN"]
    fn wire() {
        let token = std::env::var("LINEAR_TOKEN").expect("set $LINEAR_TOKEN");
        let data = tauri::async_runtime::block_on(gql(&token, "{ viewer { name } }", json!({})))
            .expect("Linear request failed");
        let name = data.pointer("/viewer/name").and_then(|x| x.as_str());
        assert!(name.is_some(), "no viewer in {data}");
        println!("connected as {}", name.unwrap());
    }

    /// `IssueDetail` flattens `Issue` into itself so the TypeScript side can
    /// say `extends LinearIssue`. Flatten and `rename_all` are independent
    /// attributes and it is not obvious they compose — if they ever stop, the
    /// detail tab loses every field of the issue at once and only at runtime.
    #[test]
    fn detail_flattens_the_issue_in_camel_case() {
        let issue = parse_issue(
            &json!({
                "id": "u", "identifier": "ECL-1", "title": "t", "url": "http://x",
                "branchName": "vid/ecl-1", "priority": 2, "updatedAt": "2026-01-01",
                "state": { "name": "Todo", "type": "unstarted", "color": "#fff", "position": 1.0 },
                "assignee": { "id": "me", "displayName": "vid" }
            }),
            "me",
        );
        let detail = IssueDetail {
            issue,
            description: "d".into(),
            created_at: "2026-01-01".into(),
            comments: vec![],
        };
        let v = serde_json::to_value(&detail).unwrap();
        // the flattened half
        assert_eq!(v["identifier"], "ECL-1");
        assert_eq!(v["branchName"], "vid/ecl-1");
        assert_eq!(v["stateType"], "unstarted");
        assert_eq!(v["isMine"], true);
        assert_eq!(v["local"]["current"], false);
        // and its own
        assert_eq!(v["description"], "d");
        assert_eq!(v["createdAt"], "2026-01-01");
        // nothing snake_case leaked through
        assert!(v.get("state_type").is_none(), "snake_case leaked: {v}");
        assert!(v.get("created_at").is_none(), "snake_case leaked: {v}");
    }

    /// The words Linear actually sends, measured across this workspace rather
    /// than assumed from the shape of the field.
    #[test]
    fn linears_own_status_words_survive() {
        let pr = |status: &str, draft: bool| {
            let node = json!({ "attachments": { "nodes": [
                { "sourceType": "github", "metadata": {
                    "number": 1, "status": status, "draft": draft, "url": "u",
                    "repoName": "r", "branch": "b", "targetBranch": "main" } }
            ]}});
            parse_prs(&node).remove(0).status
        };
        assert_eq!(pr("inReview", false), "inReview");
        assert_eq!(pr("merged", false), "merged");
        assert_eq!(pr("closed", false), "closed");
        assert_eq!(pr("open", true), "draft");
        assert_eq!(pr("inReview", true), "draft");
        // a closed draft is closed, not a draft
        assert_eq!(pr("closed", true), "closed");
        // and a word nobody has seen yet arrives as itself
        assert_eq!(pr("somethingNew", false), "somethingNew");
    }







    #[test]
    fn github_issues_are_not_pull_requests() {
        let node = json!({ "attachments": { "nodes": [
            { "sourceType": "github", "metadata": { "number": 460, "title": "an issue" } }
        ]}});
        assert!(parse_prs(&node).is_empty());
    }
}

#[cfg(test)]
mod conn_tests {
    use super::*;

    /// The tokens file has held two shapes. The old one was a bare string per
    /// project; reading it must not disconnect everybody.
    #[test]
    fn the_old_bare_token_shape_still_loads() {
        let old: HashMap<String, StoredConn> =
            serde_json::from_str(r#"{"/p/a":"lin_api_x"}"#).unwrap();
        let c: Conn = old.into_iter().next().unwrap().1.into();
        assert_eq!(c.token, "lin_api_x");
        assert_eq!(c.org, None);
    }

    #[test]
    fn the_new_shape_round_trips() {
        let new: HashMap<String, StoredConn> =
            serde_json::from_str(r#"{"/p/a":{"token":"lin_api_x","org":"Ecliptica"}}"#).unwrap();
        let c: Conn = new.into_iter().next().unwrap().1.into();
        assert_eq!(c.token, "lin_api_x");
        assert_eq!(c.org.as_deref(), Some("Ecliptica"));
        let back = serde_json::to_string(&c).unwrap();
        assert!(back.contains("Ecliptica"), "{back}");
    }
}
