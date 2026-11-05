// OpenCode service target resolution — Rust port of the Vite proxy's
// readService() (vite.config.ts). mtime-cached: service.json is re-parsed
// only when it changed, so password rotation self-heals per request.
// The password NEVER leaves this process (Phase 1 decision, SPEC-PHASE4 §1).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use base64::Engine as _;

#[derive(Clone)]
pub struct ServiceTarget {
    pub base_url: String,
    /// "Basic …" header value — built from "opencode:<password>".
    pub auth_header: String,
}

struct CachedService {
    mtime: Option<SystemTime>,
    target: Option<ServiceTarget>,
}

static CACHE: Mutex<Option<CachedService>> = Mutex::new(None);

fn service_json_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".local/state/opencode/service.json"))
}

fn parse_service_json(path: &PathBuf) -> Option<ServiceTarget> {
    let raw = std::fs::read_to_string(path).ok()?;
    // shape: { url, password } — anything else is unreadable (→ None)
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let url = json.get("url")?.as_str()?.to_string();
    let password = json.get("password")?.as_str()?.to_string();
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
    Some(ServiceTarget {
        base_url: url,
        auth_header: format!("Basic {auth}"),
    })
}

/// mtime-cached service target (port of vite readService()); None when
/// unreadable — callers surface a transport error, never a panic.
pub fn resolve() -> Option<ServiceTarget> {
    let path = service_json_path()?;
    let mtime = std::fs::metadata(path.as_path())
        .and_then(|m| m.modified())
        .ok();
    {
        let cache = CACHE.lock().ok()?;
        if let Some(cached) = cache.as_ref() {
            if cached.mtime == mtime {
                return cached.target.clone();
            }
        }
    }
    let target = parse_service_json(&path);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(CachedService { mtime, target: target.clone() });
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_header_shape() {
        let auth = base64::engine::general_purpose::STANDARD.encode("opencode:secret");
        assert_eq!(format!("Basic {auth}"), "Basic b3BlbmNvZGU6c2VjcmV0");
    }
}
