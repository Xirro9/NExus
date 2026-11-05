// graphify.rs — Jerry's bridge to the Graphify CLI (https://graphify.com,
// package `graphifyy`, installed via `uv tool install graphifyy`).
//
// Design rules (docs/NOTES-SESSIONS-GRAPHIFY.md):
// - Jerry NEVER reimplements graph extraction — it only drives the official
//   CLI with a strict, code-only whitelist. No LLM backends, no API keys,
//   no arbitrary commands: the whitelist below is the security boundary.
// - The whitelist MUST stay in sync with the dev-middleware mirror in
//   src/server/graphify.ts and the arg builders in src/lib/graphify/index.ts.
// - Maintenance runs as a separate OS process; OpenCode execution is never
//   blocked by it (async commands + spawn_blocking + watchdog).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Hard ceiling for maintenance/query runs. A code-only update on a large
/// repo stays far below this; the watchdog exists so a wedged spawn can
/// never pin a thread forever.
const EXEC_TIMEOUT_SECS: u64 = 300;
const DETECT_TIMEOUT_SECS: u64 = 5;
/// IPC guard: don't ship megabytes of progress spam back to the webview.
const OUTPUT_CAP_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyDetect {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyStatus {
    /// graphify-out/graph.json exists in the project
    pub found: bool,
    pub mtime_ms: Option<u128>,
    pub size_bytes: Option<u64>,
    pub node_count: Option<u64>,
    pub edge_count: Option<u64>,
    /// graphify version that built the graph (from the graph.json header)
    pub graphify_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyExec {
    /// process exit code; None when the watchdog killed it
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

// ---------------------------------------------------------------------------
// binary resolution

fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            out.push(dir.join("graphify"));
        }
    }
    // uv tool installs land here even when the desktop-launched app inherits
    // a minimal PATH (operator launches Jerry from the AppImage/desktop file)
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        out.push(home.join(".local/bin/graphify"));
        out.push(home.join(".cargo/bin/graphify"));
    }
    out
}

fn resolve_binary() -> Option<PathBuf> {
    for candidate in candidate_paths() {
        // is_file only — spawn errors on a non-executable file surface later
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// argument whitelist — THE security boundary (mirror in src/server/graphify.ts)

struct Validated {
    cwd: PathBuf,
    args: Vec<String>,
}

fn validate(cwd: &str, args: &[String]) -> Result<Validated, String> {
    if cwd.is_empty() || !cwd.starts_with('/') {
        return Err("cwd must be an absolute path".into());
    }
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    if args.is_empty() || args.len() > 8 {
        return Err("args must contain 1–8 tokens".into());
    }
    for a in args {
        if a.is_empty() || a.len() > 512 || a.contains('\0') {
            return Err(format!("invalid arg token: {a:?}"));
        }
    }
    // every subcommand targets the project root "." (cwd is the project)
    let positional_dot = |tokens: &[String]| tokens.iter().any(|t| t == ".");
    fn flags_of(tokens: &[String]) -> Vec<&String> {
        tokens.iter().filter(|t| t.starts_with("--")).collect()
    }

    let (cmd, rest) = args.split_first().unwrap();
    match cmd.as_str() {
        "update" => {
            if !positional_dot(rest) {
                return Err("update requires the project path \".\"".into());
            }
            for f in flags_of(rest) {
                if !(f == "--force" || f == "--no-cluster") {
                    return Err(format!("update: flag not allowed: {f}"));
                }
            }
        }
        "extract" => {
            if !positional_dot(rest) {
                return Err("extract requires the project path \".\"".into());
            }
            if !rest.iter().any(|t| t == "--code-only") {
                // Jerry is code-only by design — semantic extraction calls
                // external LLM backends and is never allowed from here
                return Err("extract requires --code-only (no LLM extraction from Jerry)".into());
            }
            for f in flags_of(rest) {
                if !(f == "--code-only" || f == "--no-cluster" || f == "--no-gitignore") {
                    return Err(format!("extract: flag not allowed: {f}"));
                }
            }
        }
        "cluster-only" => {
            if !positional_dot(rest) {
                return Err("cluster-only requires the project path \".\"".into());
            }
            for f in flags_of(rest) {
                if !(f == "--no-label" || f == "--no-viz") {
                    return Err(format!("cluster-only: flag not allowed: {f}"));
                }
            }
        }
        "query" => {
            // token walk: one positional question + boolean/value flags
            // (value flags consume the NEXT token — a plain flag-iterator
            // would miss non-dash value tokens and mis-validate)
            let mut positionals = 0usize;
            let mut i = 0usize;
            while i < rest.len() {
                let t = rest[i].as_str();
                match t {
                    "--dfs" => i += 1,
                    "--budget" | "--depth" => {
                        let Some(v) = rest.get(i + 1) else {
                            return Err(format!("query: {t} needs an integer value"));
                        };
                        let n: u32 = v.parse().map_err(|_| format!("query: {t} needs an integer value"))?;
                        let ok = if t == "--budget" { (1..=8000).contains(&n) } else { (1..=6).contains(&n) };
                        if !ok {
                            return Err(format!("query: {t} out of range"));
                        }
                        i += 2;
                    }
                    x if x.starts_with("--") => {
                        return Err(format!("query: flag not allowed: {t}"));
                    }
                    _ => {
                        positionals += 1;
                        i += 1;
                    }
                }
            }
            if positionals != 1 {
                return Err("query takes exactly one question string".into());
            }
        }
        "path" => {
            let positionals: Vec<&String> =
                rest.iter().filter(|t| !t.starts_with("--")).collect();
            if positionals.len() != 2 {
                return Err("path takes exactly two symbol names".into());
            }
            for f in flags_of(rest) {
                if f != "--undirected" && f != "--directed" {
                    return Err(format!("path: flag not allowed: {f}"));
                }
            }
        }
        "explain" => {
            let positionals: Vec<&String> =
                rest.iter().filter(|t| !t.starts_with("--")).collect();
            if positionals.len() != 1 {
                return Err("explain takes exactly one symbol name".into());
            }
            for f in flags_of(rest) {
                if f != "--all" {
                    return Err(format!("explain: flag not allowed: {f}"));
                }
            }
        }
        "god-nodes" => {
            let mut positionals = 0usize;
            let mut i = 0usize;
            while i < rest.len() {
                let t = rest[i].as_str();
                match t {
                    "--json" => i += 1,
                    "--top" => {
                        let Some(v) = rest.get(i + 1) else {
                            return Err("god-nodes: --top needs an integer value".into());
                        };
                        let n: u32 = v.parse().map_err(|_| "god-nodes: --top needs an integer value")?;
                        if !(1..=50).contains(&n) {
                            return Err("god-nodes: --top out of range".into());
                        }
                        i += 2;
                    }
                    x if x.starts_with("--") => {
                        return Err(format!("god-nodes: flag not allowed: {t}"));
                    }
                    _ => {
                        positionals += 1;
                        i += 1;
                    }
                }
            }
            if positionals != 0 {
                return Err("god-nodes takes no positional args".into());
            }
        }
        other => {
            return Err(format!("subcommand not allowed: {other}"));
        }
    }

    Ok(Validated {
        cwd: cwd_path.to_path_buf(),
        args: args.to_vec(),
    })
}

// ---------------------------------------------------------------------------
// process plumbing

fn run_with_timeout(
    program: &Path,
    cwd: &Path,
    args: &[String],
    timeout: u64,
) -> Result<GraphifyExec, String> {
    let start = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn graphify failed: {e}"))?;

    // drain both pipes on threads — a full pipe buffer would otherwise stall
    // the child while we wait (classic deadlock)
    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let mut limited = (&mut stdout_pipe).take(OUTPUT_CAP_BYTES);
        let _ = limited.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let mut limited = (&mut stderr_pipe).take(OUTPUT_CAP_BYTES);
        let _ = limited.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });

    let deadline = start + Duration::from_secs(timeout);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(GraphifyExec {
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out,
    })
}

// ---------------------------------------------------------------------------
// commands

#[tauri::command]
pub async fn graphify_detect() -> Result<GraphifyDetect, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(program) = resolve_binary() else {
            return Ok(GraphifyDetect {
                available: false,
                version: None,
                path: None,
            });
        };
        let cwd = std::env::temp_dir();
        let res = run_with_timeout(&program, &cwd, &["--version".to_string()], DETECT_TIMEOUT_SECS)?;
        let version = res
            .stdout
            .trim()
            .strip_prefix("graphify ")
            .map(str::to_string)
            .or_else(|| res.stdout.trim().split_whitespace().next_back().map(str::to_string));
        Ok(GraphifyDetect {
            available: res.code == Some(0),
            version,
            path: Some(program.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|e| format!("join detect: {e}"))?
}

#[tauri::command]
pub async fn graphify_status(cwd: String) -> Result<GraphifyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&cwd);
        if cwd.is_empty() || !cwd.starts_with('/') || !path.is_dir() {
            return Err("cwd must be an existing absolute directory".into());
        }
        let graph = path.join("graphify-out").join("graph.json");
        let meta = match std::fs::metadata(&graph) {
            Ok(m) if m.is_file() => m,
            _ => {
                return Ok(GraphifyStatus {
                    found: false,
                    mtime_ms: None,
                    size_bytes: None,
                    node_count: None,
                    edge_count: None,
                    graphify_version: None,
                })
            }
        };
        let size = meta.len();
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());

        // header-only extraction: nodes/links counts + graphify_version.
        // Parsing a few MB of JSON is fine here (called on project-card
        // expand / after updates, not in a loop).
        let mut node_count = None;
        let mut edge_count = None;
        let mut graphify_version = None;
        if size <= 64 * 1024 * 1024 {
            if let Ok(text) = std::fs::read_to_string(&graph) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    node_count = v.get("nodes").and_then(|n| n.as_array()).map(|a| a.len() as u64);
                    edge_count = v.get("links").and_then(|n| n.as_array()).map(|a| a.len() as u64);
                    graphify_version = v
                        .get("graph")
                        .and_then(|g| g.get("graphify_version"))
                        .and_then(|s| s.as_str())
                        .map(str::to_string);
                }
            }
        }
        Ok(GraphifyStatus {
            found: true,
            mtime_ms,
            size_bytes: Some(size),
            node_count,
            edge_count,
            graphify_version,
        })
    })
    .await
    .map_err(|e| format!("join status: {e}"))?
}

#[tauri::command]
pub async fn graphify_exec(cwd: String, args: Vec<String>) -> Result<GraphifyExec, String> {
    let validated = validate(&cwd, &args)?;
    tauri::async_runtime::spawn_blocking(move || {
        let program = resolve_binary().ok_or(
            "graphify CLI not found — install with `uv tool install graphifyy`",
        )?;
        run_with_timeout(&program, &validated.cwd, &validated.args, EXEC_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| format!("join exec: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::validate;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn allows_whitelisted_commands() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(validate(&cwd, &s(&["update", "."])).is_ok());
        assert!(validate(&cwd, &s(&["update", ".", "--force"])).is_ok());
        assert!(validate(&cwd, &s(&["extract", ".", "--code-only"])).is_ok());
        assert!(validate(&cwd, &s(&["cluster-only", ".", "--no-label", "--no-viz"])).is_ok());
        assert!(validate(&cwd, &s(&["query", "how does auth work", "--budget", "500"])).is_ok());
        // value token followed by a boolean flag — the walk must not
        // mis-read "--dfs" as --budget's value (regression: false rejection)
        assert!(validate(&cwd, &s(&["query", "auth", "--budget", "500", "--dfs"])).is_ok());
        assert!(validate(&cwd, &s(&["query", "auth", "--depth", "2"])).is_ok());
        assert!(validate(&cwd, &s(&["query", "auth", "--budget", "9000"])).is_err());
        assert!(validate(&cwd, &s(&["query", "auth", "--budget", "--dfs"])).is_err());
        assert!(validate(&cwd, &s(&["query", "a", "b"])).is_err());
        assert!(validate(&cwd, &s(&["path", "A", "B", "--undirected"])).is_ok());
        assert!(validate(&cwd, &s(&["explain", "reflect()", "--all"])).is_ok());
        assert!(validate(&cwd, &s(&["god-nodes", "--json", "--top", "5"])).is_ok());
    }

    #[test]
    fn rejects_non_whitelisted() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        // semantic extraction would call external LLM backends — hard no
        assert!(validate(&cwd, &s(&["extract", "."])).is_err());
        assert!(validate(&cwd, &s(&["extract", ".", "--code-only", "--mode", "deep"])).is_err());
        assert!(validate(&cwd, &s(&["provider", "add"])).is_err());
        assert!(validate(&cwd, &s(&["hook", "install"])).is_err());
        assert!(validate(&cwd, &s(&["query", "q", "--seed", "../../etc"])).is_err());
        assert!(validate(&cwd, &s(&["update"])).is_err());
        // relative cwd
        assert!(validate("relative/path", &s(&["update", "."])).is_err());
        // nonexistent cwd
        assert!(validate("/nonexistent/dir/xyz", &s(&["update", "."])).is_err());
    }
}
