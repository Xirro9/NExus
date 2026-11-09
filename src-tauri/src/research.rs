// research.rs — Jerry's read surface for the research library (pipeline T3).
//
// Design rules:
// - Jerry NEVER reimplements schema/search — no rusqlite. It spawns the
//   research-library CLI (`node <root>/.opencode/plugins/research-library/
//   cli.mjs <cmd> … --json`) and parses its JSON output; the CLI is a thin
//   wrapper over src/lib/research/engine.ts, the single source of truth.
// - The validation below MUST stay in sync with the dev-middleware mirror in
//   src/server/research.ts and the engine's own checks — it is the security
//   boundary: absolute roots only, whitelisted collections/scopes, bounded
//   integers, no leading-dash positionals. READ-ONLY BY DESIGN: no import
//   route exists; reindex is the single write-adjacent operation and only
//   rebuilds the derived index from the manifests (unit of record).
// - No cwd guessing in the desktop app: explicit root > RESEARCH_LIBRARY_ROOT
//   env > honest "library path not set" error. A fake-empty library result
//   would be worse than an error.
// - serde structs below mirror the TS transport types in
//   src/lib/transport/types.ts (aliases of the engine's interfaces) EXACTLY —
//   camelCase omissions are the classic Rust↔TS shape bug; the serde test
//   pins the wire shapes.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Reads are local SQLite queries behind the CLI — 60 s is generous.
const READ_TIMEOUT_SECS: u64 = 60;
/// A full manifest replay on a large library stays far below this; the
/// watchdog exists so a wedged spawn can never pin a thread forever.
const REINDEX_TIMEOUT_SECS: u64 = 300;
/// graphify.rs precedent — don't ship megabytes of CLI output over IPC.
const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// Mirror of engine COLLECTIONS (src/lib/research/engine.ts).
const COLLECTIONS: [&str; 5] = [
    "legislation",
    "cybersecurity",
    "ai-research",
    "technical-docs",
    "projects",
];
/// Mirror of engine SearchOpts.scope.
const SCOPES: [&str; 3] = ["all", "documents", "sections"];

// ---------------------------------------------------------------------------
// serde structs — EXACT camelCase mirrors of the TS transport types

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchCollectionSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub documents: i64,
    pub sections: i64,
    pub stale: i64,
    pub last_updated_at: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSearchSection {
    pub id: String,
    pub anchor: String,
    pub heading: String,
    pub snippet: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSearchHit {
    pub doc_id: String,
    pub collection: String,
    pub title: String,
    pub source_url: String,
    pub version: String,
    pub status: String,
    pub publication_date: Option<String>,
    pub retrieved_at: i64,
    pub verified_at: Option<i64>,
    pub age_days: i64,
    pub stale: bool,
    pub score: f64,
    pub section: Option<ResearchSearchSection>,
}

/// Raw CLI envelope for `search --json` ({hits, tookMs}); q is composed here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResearchSearchCli {
    hits: Vec<ResearchSearchHit>,
    took_ms: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSectionRecord {
    pub id: String,
    pub anchor: String,
    pub heading: String,
    pub ordinal: i64,
    pub content_hash: String,
    /// Present only when requested (engine contract — CLI `get` always
    /// includes it, maxChars-capped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchDocumentRecord {
    pub doc_id: String,
    pub collection: String,
    pub title: String,
    pub source_url: String,
    pub publication_date: Option<String>,
    pub retrieved_at: i64,
    pub verified_at: Option<i64>,
    pub version: String,
    pub status: String,
    pub revision: i64,
    pub content_hash: String,
    pub file_path: Option<String>,
    pub notes: String,
    pub age_days: i64,
    pub stale: bool,
    /// TS `sections?: SectionRecord[]` — ABSENT when not requested, never
    /// null (a serialized null would not match the optional field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<ResearchSectionRecord>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSkippedManifest {
    pub manifest: String,
    pub error: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchReindexResult {
    pub documents: i64,
    pub sections: i64,
    pub skipped: Vec<ResearchSkippedManifest>,
    pub took_ms: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStatus {
    pub root: String,
    pub db_exists: bool,
    pub db_size_bytes: Option<i64>,
    pub schema_version: i64,
    pub engine_version: String,
    pub collections: Vec<ResearchCollectionSummary>,
    pub stale_count: i64,
    pub last_reindex_at: Option<i64>,
}

/// TS ResearchSearchResult — middleware/CLI envelope with q echoed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSearchResult {
    pub q: String,
    pub hits: Vec<ResearchSearchHit>,
    pub took_ms: f64,
}

// ---------------------------------------------------------------------------
// node resolution (same discipline as graphify.rs resolve_binary)

fn candidate_node_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            out.push(dir.join("node"));
        }
    }
    // desktop-launched apps inherit a minimal PATH — cover the usual installs
    out.push(PathBuf::from("/usr/bin/node"));
    out.push(PathBuf::from("/usr/local/bin/node"));
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(home).join(".local/bin/node"));
    }
    out
}

fn resolve_node() -> Option<PathBuf> {
    candidate_node_paths()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

// ---------------------------------------------------------------------------
// validation — THE security boundary (mirror of src/server/research.ts)

fn validate_root(root: &str) -> Result<(), String> {
    if root.is_empty() {
        return Err("root is empty".into());
    }
    if root.contains('\0') {
        return Err("root contains a NUL byte".into());
    }
    if !root.starts_with('/') {
        return Err(format!("root must be absolute: {root:?}"));
    }
    for seg in root.split('/') {
        if seg == "." || seg == ".." {
            return Err(format!("root must not contain {seg:?} segments: {root:?}"));
        }
    }
    let lib = Path::new(root).join("research-library");
    if !lib.is_dir() {
        return Err(format!(
            "no research-library directory under {root} — pick the checkout/folder that contains it"
        ));
    }
    Ok(())
}

fn validate_q(q: &str) -> Result<(), String> {
    if q.is_empty() {
        return Err("q must not be empty".into());
    }
    if q.contains('\0') {
        return Err("q contains a NUL byte".into());
    }
    let len = q.chars().count();
    if len > 512 {
        return Err(format!("q exceeds 512 characters (got {len})"));
    }
    // positional-injection guard: the CLI takes <q> as a positional, a
    // leading dash would be mis-parsed as a flag ("--root" as a "query"
    // would hijack root resolution)
    if q.starts_with('-') {
        return Err("q must not start with a dash".into());
    }
    Ok(())
}

fn validate_collection(raw: &str) -> Result<(), String> {
    if !COLLECTIONS.contains(&raw) {
        return Err(format!(
            "invalid collection {raw:?} — expected one of: {}",
            COLLECTIONS.join(", ")
        ));
    }
    Ok(())
}

fn validate_scope(raw: &str) -> Result<(), String> {
    if !SCOPES.contains(&raw) {
        return Err(format!(
            "invalid scope {raw:?} — expected one of: {}",
            SCOPES.join(", ")
        ));
    }
    Ok(())
}

/// Mirror of the middleware's DOC_ID_RE — stricter than the engine's
/// DOC_ID_RE: engine SLUG_RE never produces a leading-dash segment, so
/// accepting one would only ever match nothing, while here it could be
/// mis-read as a CLI flag.
fn validate_doc_id(id: &str) -> Result<(), String> {
    fn valid_segment(seg: &str) -> bool {
        let mut chars = seg.chars();
        match chars.next() {
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    }
    let parts: Vec<&str> = id.split('/').collect();
    let ok = parts.len() == 2 && parts.iter().all(|p| valid_segment(p));
    if !ok {
        return Err(format!(
            "invalid id {id:?} — expected \"<collection>/<slug>\" (lowercase letters, digits and dashes; no leading dash)"
        ));
    }
    Ok(())
}

fn validate_section(section: &str) -> Result<(), String> {
    if section.contains('\0') {
        return Err("section contains a NUL byte".into());
    }
    let len = section.chars().count();
    if len > 120 {
        return Err(format!("section exceeds 120 characters (got {len})"));
    }
    Ok(())
}

fn validate_limit(limit: u32) -> Result<(), String> {
    if !(1..=50).contains(&limit) {
        return Err("limit must be an integer between 1 and 50".into());
    }
    Ok(())
}

fn validate_max_chars(max_chars: u32) -> Result<(), String> {
    if !(500..=50000).contains(&max_chars) {
        return Err("maxChars must be an integer between 500 and 50000".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// CLI plumbing (mirror of graphify.rs run_with_timeout + cap detection)

struct CliRun {
    /// process exit code; None when the watchdog killed it
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    /// stdout hit the 256 KB cap — the JSON would be truncated, so this
    /// surfaces as an explicit error instead of a parse failure
    stdout_capped: bool,
}

fn run_cli(node: &Path, cli: &Path, args: &[String], timeout: u64) -> Result<CliRun, String> {
    let start = Instant::now();
    let mut child = Command::new(node)
        .arg(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn node failed: {e}"))?;

    // drain both pipes on threads — a full pipe buffer would otherwise stall
    // the child while we wait (classic deadlock; graphify.rs precedent)
    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        // cap + 1 → the overflow itself is detectable
        let mut limited = (&mut stdout_pipe).take(OUTPUT_CAP_BYTES as u64 + 1);
        let _ = limited.read_to_end(&mut buf);
        let capped = buf.len() > OUTPUT_CAP_BYTES;
        (String::from_utf8_lossy(&buf).into_owned(), capped)
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let mut limited = (&mut stderr_pipe).take(OUTPUT_CAP_BYTES as u64 + 1);
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

    let (stdout, stdout_capped) = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(CliRun {
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        timed_out,
        stdout_capped,
    })
}

fn cli_paths(root: &str) -> Result<(PathBuf, PathBuf), String> {
    let cli = Path::new(root).join(".opencode/plugins/research-library/cli.mjs");
    if !cli.is_file() {
        return Err(format!(
            "research library CLI not found at {} — this checkout ships it under .opencode/plugins/research-library/",
            cli.display()
        ));
    }
    let node = resolve_node()
        .ok_or("node not found — install Node.js (research library reads run through the repo's CLI)")?;
    Ok((node, cli))
}

/// With --json the CLI reports errors as {error: "..."} on stdout — prefer
/// that over the stderr tail (which carries human-format logs).
fn cli_error_text(run: &CliRun) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(run.stdout.trim()) {
        if let Some(msg) = v.get("error").and_then(|e| e.as_str()) {
            return msg.to_string();
        }
    }
    stderr_tail(&run.stderr)
}

fn stderr_tail(stderr: &str) -> String {
    let line = stderr.trim().lines().next_back().unwrap_or("").trim();
    let len = line.chars().count();
    if len <= 500 {
        line.to_string()
    } else {
        let tail: String = line.chars().skip(len - 500).collect();
        format!("…{tail}")
    }
}

async fn run_cli_command(
    root: &str,
    args: Vec<String>,
    timeout_secs: u64,
    label: &'static str,
) -> Result<CliRun, String> {
    let (node, cli) = cli_paths(root)?;
    let joined = tauri::async_runtime::spawn_blocking(move || run_cli(&node, &cli, &args, timeout_secs))
        .await
        .map_err(|e| format!("join {label}: {e}"))?;
    let run = joined?;
    if run.timed_out {
        return Err(format!("research library {label} timed out after {timeout_secs}s"));
    }
    if run.stdout_capped {
        return Err(format!(
            "research library {label} output exceeded the {OUTPUT_CAP_BYTES} byte cap — narrow the request (e.g. a section filter)"
        ));
    }
    Ok(run)
}

fn require_success(run: &CliRun, label: &str) -> Result<(), String> {
    if run.code == Some(0) {
        return Ok(());
    }
    let code = run
        .code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    Err(format!("research library {label} failed (exit {code}): {}", cli_error_text(run)))
}

// ---------------------------------------------------------------------------
// commands

#[tauri::command]
pub async fn research_status(root: Option<String>) -> Result<ResearchStatus, String> {
    // Desktop resolution chain: explicit arg > env > honest error. NO cwd
    // guessing — the walk-up legs are dev-middleware behavior only.
    let root = match root {
        Some(r) => r,
        None => std::env::var("RESEARCH_LIBRARY_ROOT").unwrap_or_default().trim().to_string(),
    };
    if root.is_empty() {
        return Err(
            "library path not set — choose a folder containing research-library/ in Jerry's research settings"
                .into(),
        );
    }
    validate_root(&root)?;
    let args = vec![
        "status".to_string(),
        "--json".to_string(),
        "--root".to_string(),
        root.clone(),
    ];
    let run = run_cli_command(&root, args, READ_TIMEOUT_SECS, "status").await?;
    require_success(&run, "status")?;
    serde_json::from_str::<ResearchStatus>(run.stdout.trim())
        .map_err(|e| format!("research library status returned unparsable output: {e}"))
}

#[tauri::command]
pub async fn research_collections(root: String) -> Result<Vec<ResearchCollectionSummary>, String> {
    validate_root(&root)?;
    let args = vec![
        "list".to_string(),
        "--json".to_string(),
        "--root".to_string(),
        root.clone(),
    ];
    let run = run_cli_command(&root, args, READ_TIMEOUT_SECS, "collections").await?;
    require_success(&run, "collections")?;
    serde_json::from_str::<Vec<ResearchCollectionSummary>>(run.stdout.trim())
        .map_err(|e| format!("research library collections returned unparsable output: {e}"))
}

#[tauri::command]
pub async fn research_search(
    root: String,
    q: String,
    collection: Option<String>,
    limit: Option<u32>,
    scope: Option<String>,
) -> Result<ResearchSearchResult, String> {
    validate_root(&root)?;
    validate_q(&q)?;
    if let Some(c) = &collection {
        validate_collection(c)?;
    }
    if let Some(l) = limit {
        validate_limit(l)?;
    }
    let scope = scope.unwrap_or_else(|| "all".to_string());
    validate_scope(&scope)?;

    let mut args = vec![
        "search".to_string(),
        q.clone(),
        "--json".to_string(),
        "--root".to_string(),
        root.clone(),
    ];
    if let Some(c) = &collection {
        args.push("--collection".to_string());
        args.push(c.clone());
    }
    if let Some(l) = limit {
        args.push("--limit".to_string());
        args.push(l.to_string());
    }
    args.push("--scope".to_string());
    args.push(scope);

    let run = run_cli_command(&root, args, READ_TIMEOUT_SECS, "search").await?;
    require_success(&run, "search")?;
    let parsed = serde_json::from_str::<ResearchSearchCli>(run.stdout.trim())
        .map_err(|e| format!("research library search returned unparsable output: {e}"))?;
    Ok(ResearchSearchResult {
        q,
        hits: parsed.hits,
        took_ms: parsed.took_ms,
    })
}

#[tauri::command]
pub async fn research_document(
    root: String,
    id: String,
    section: Option<String>,
    max_chars: Option<u32>,
) -> Result<Option<ResearchDocumentRecord>, String> {
    validate_root(&root)?;
    validate_doc_id(&id)?;
    if let Some(s) = &section {
        validate_section(s)?;
    }
    if let Some(m) = max_chars {
        validate_max_chars(m)?;
    }

    let mut args = vec![
        "get".to_string(),
        id.clone(),
        "--json".to_string(),
        "--root".to_string(),
        root.clone(),
    ];
    if let Some(s) = &section {
        args.push("--section".to_string());
        args.push(s.clone());
    }
    if let Some(m) = max_chars {
        args.push("--max-chars".to_string());
        args.push(m.to_string());
    }

    let run = run_cli_command(&root, args, READ_TIMEOUT_SECS, "document").await?;
    if run.code == Some(3) {
        // honest not-found — missing doc OR a section filter that matched
        // nothing (CLI exit 3). The UI renders "not found", no error toast.
        return Ok(None);
    }
    require_success(&run, "document")?;
    serde_json::from_str::<ResearchDocumentRecord>(run.stdout.trim())
        .map(Some)
        .map_err(|e| format!("research library document returned unparsable output: {e}"))
}

#[tauri::command]
pub async fn research_reindex(root: String) -> Result<ResearchReindexResult, String> {
    validate_root(&root)?;
    let args = vec![
        "refresh".to_string(),
        "--reindex".to_string(),
        "--json".to_string(),
        "--root".to_string(),
        root.clone(),
    ];
    let run = run_cli_command(&root, args, REINDEX_TIMEOUT_SECS, "reindex").await?;
    require_success(&run, "reindex")?;
    serde_json::from_str::<ResearchReindexResult>(run.stdout.trim())
        .map_err(|e| format!("research library reindex returned unparsable output: {e}"))
}

// ---------------------------------------------------------------------------
// tests — accept/reject matrix (graphify.rs validate() test style)

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir per call (tests run in parallel threads).
    fn make_dir(label: &str, with_library: bool) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "jerry-research-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        if with_library {
            std::fs::create_dir_all(dir.join("research-library")).unwrap();
        }
        dir
    }

    #[test]
    fn root_accepts_dir_with_library() {
        let dir = make_dir("ok", true);
        let root = dir.to_str().unwrap().to_string();
        assert!(validate_root(&root).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_rejects_traversal_nul_relative_and_missing_library() {
        let dir = make_dir("bad", true);
        let root = dir.to_str().unwrap().to_string();
        // traversal
        assert!(validate_root(&format!("{root}/..")).is_err());
        assert!(validate_root("/home/x/../y").is_err());
        // NUL
        assert!(validate_root(&format!("{root}\0")).is_err());
        // relative
        assert!(validate_root("relative/path").is_err());
        assert!(validate_root("").is_err());
        // existing dir WITHOUT research-library/
        let bare = make_dir("bare", false);
        assert!(validate_root(bare.to_str().unwrap()).is_err());
        // nonexistent dir
        assert!(validate_root("/nonexistent/jerry-research/xyz").is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn q_bounds_and_injection_guard() {
        assert!(validate_q("transparency").is_ok());
        assert!(validate_q(&"x".repeat(512)).is_ok());
        assert!(validate_q("").is_err());
        assert!(validate_q(&"x".repeat(513)).is_err());
        assert!(validate_q("bad\0q").is_err());
        // leading dash would be mis-read as a CLI flag (search <q> positional)
        assert!(validate_q("-leading").is_err());
        assert!(validate_q("--root").is_err());
    }

    #[test]
    fn doc_id_shape() {
        assert!(validate_doc_id("legislation/s-5471").is_ok());
        assert!(validate_doc_id("ai-research/paper-1").is_ok());
        // shape only — existence is the CLI's business (exit 3 → Ok(None))
        assert!(validate_doc_id("legislation/nope").is_ok());
        assert!(validate_doc_id("legislation").is_err());
        assert!(validate_doc_id("legislation/a/b").is_err());
        assert!(validate_doc_id("/slug").is_err());
        assert!(validate_doc_id("coll/").is_err());
        assert!(validate_doc_id("Coll/slug").is_err());
        assert!(validate_doc_id("coll/slug_x").is_err());
        // leading-dash segments: engine SLUG_RE never produces one; rejecting
        // keeps the token from being mis-read as a CLI flag
        assert!(validate_doc_id("-coll/slug").is_err());
        assert!(validate_doc_id("coll/-slug").is_err());
    }

    #[test]
    fn whitelists_and_integer_bounds() {
        for c in COLLECTIONS {
            assert!(validate_collection(c).is_ok());
        }
        assert!(validate_collection("news").is_err());
        assert!(validate_collection("").is_err());
        for s in SCOPES {
            assert!(validate_scope(s).is_ok());
        }
        assert!(validate_scope("everything").is_err());
        assert!(validate_limit(1).is_ok());
        assert!(validate_limit(50).is_ok());
        assert!(validate_limit(0).is_err());
        assert!(validate_limit(51).is_err());
        assert!(validate_max_chars(500).is_ok());
        assert!(validate_max_chars(50000).is_ok());
        assert!(validate_max_chars(499).is_err());
        assert!(validate_max_chars(50001).is_err());
    }

    #[test]
    fn section_bounds() {
        assert!(validate_section("SEC. 1").is_ok());
        assert!(validate_section("").is_ok()); // empty → no filter upstream
        assert!(validate_section(&"x".repeat(120)).is_ok());
        assert!(validate_section(&"x".repeat(121)).is_err());
        assert!(validate_section("sec\0").is_err());
    }

    /// The #1 Rust↔TS shape bug class is a serde camelCase omission — pin the
    /// exact engine wire shapes here.
    #[test]
    fn serde_shapes_match_engine_camel_case() {
        let doc: ResearchDocumentRecord = serde_json::from_str(
            r#"{
              "docId": "legislation/s-5471", "collection": "legislation",
              "title": "T", "sourceUrl": "https://example.gov/bill",
              "publicationDate": "2026-09-23", "retrievedAt": 1762000000000,
              "verifiedAt": null, "version": "current", "status": "cached",
              "revision": 1, "contentHash": "abc", "filePath": "research-library/sources/x",
              "notes": "", "ageDays": 3, "stale": false,
              "sections": [{"id": "x#1-sec", "anchor": "SEC. 1", "heading": "SEC. 1.",
                            "ordinal": 1, "contentHash": "h", "body": "b"}]
            }"#,
        )
        .unwrap();
        assert_eq!(doc.doc_id, "legislation/s-5471");
        assert_eq!(doc.age_days, 3);
        assert_eq!(doc.sections.as_ref().unwrap()[0].content_hash, "h");
        let json = serde_json::to_string(&doc).unwrap();
        for key in [
            "\"docId\"", "\"sourceUrl\"", "\"publicationDate\"", "\"retrievedAt\"",
            "\"verifiedAt\"", "\"contentHash\"", "\"filePath\"", "\"ageDays\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        // TS `sections?:` — absent, never null
        assert!(!json.contains("\"sections\":null"));

        let status: ResearchStatus = serde_json::from_str(
            r#"{"root":"/r","dbExists":true,"dbSizeBytes":12,"schemaVersion":1,
                "engineVersion":"1.0.0","collections":[],"staleCount":0,"lastReindexAt":null}"#,
        )
        .unwrap();
        assert_eq!(status.engine_version, "1.0.0");
        assert_eq!(status.db_size_bytes, Some(12));
        let status_json = serde_json::to_string(&status).unwrap();
        for key in [
            "\"dbExists\"", "\"dbSizeBytes\"", "\"schemaVersion\"", "\"engineVersion\"",
            "\"staleCount\"", "\"lastReindexAt\"",
        ] {
            assert!(status_json.contains(key), "missing {key} in {status_json}");
        }

        let hit: ResearchSearchHit = serde_json::from_str(
            r#"{"docId":"c/s","collection":"c","title":"t","sourceUrl":"u","version":"v",
                "status":"cached","publicationDate":null,"retrievedAt":1,"verifiedAt":null,
                "ageDays":1,"stale":false,"score":1.5,
                "section":{"id":"i","anchor":"a","heading":"h","snippet":"s"}}"#,
        )
        .unwrap();
        assert_eq!(hit.section.as_ref().unwrap().snippet, "s");

        let re: ResearchReindexResult = serde_json::from_str(
            r#"{"documents":1,"sections":2,"skipped":[{"manifest":"m","error":"e"}],"tookMs":0.5}"#,
        )
        .unwrap();
        assert_eq!(re.took_ms, 0.5);
        assert_eq!(re.skipped[0].manifest, "m");

        let summary: ResearchCollectionSummary = serde_json::from_str(
            r#"{"id":"legislation","name":"Legislation","description":"d","documents":0,
                "sections":0,"stale":0,"lastUpdatedAt":null}"#,
        )
        .unwrap();
        assert_eq!(summary.last_updated_at, None);
    }
}
