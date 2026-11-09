// fs.rs — host filesystem commands. Currently one command: project-directory
// creation for the Projects tab ("new project"). std::fs only — no shell-outs.
// The path validation below is the security boundary and MUST stay in sync
// with the dev-middleware mirror in src/server/devfs.ts and the UI-side
// pre-checks in src/lib/projectName.ts (same discipline as the graphify
// whitelist — see graphify.rs).

use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDir {
    /// canonicalized absolute path (symlinks resolved host-side)
    pub path: String,
    /// true when the directory already existed (creation is idempotent)
    pub existed: bool,
}

/// THE validation boundary (mirror in src/server/devfs.ts): absolute only, no
/// empty/NUL, no "." or ".." segments. A relative path would land wherever the
/// app's cwd points — always reject.
fn validate_absolute(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    if path.contains('\0') {
        return Err("path contains a NUL byte".into());
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("path must be absolute: {path:?}"));
    }
    // segment check, not Component walk: Components normalizes "." away, so
    // "/a/./b" would slip past — the literal segments are what we reject
    for seg in path.split('/') {
        if seg == "." || seg == ".." {
            return Err(format!("path must not contain {seg:?} segments: {path:?}"));
        }
    }
    Ok(())
}

fn io_message(err: std::io::Error) -> String {
    match err.kind() {
        ErrorKind::PermissionDenied => {
            "permission denied — check the parent directory's permissions".into()
        }
        ErrorKind::NotFound => "a parent path component was not found".into(),
        _ => format!("mkdir failed: {err}"),
    }
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<CreatedDir, String> {
    validate_absolute(&path)?;
    let p = Path::new(&path);
    // decided BEFORE creating (spec); an AlreadyExists error afterwards is a
    // concurrent-creation race — reported honestly instead of failing
    let mut existed = p.is_dir();
    if !existed {
        if let Err(err) = std::fs::create_dir_all(p) {
            if err.kind() == ErrorKind::AlreadyExists {
                if p.is_dir() {
                    existed = true;
                } else {
                    return Err(format!("path exists and is not a directory: {path}"));
                }
            } else {
                return Err(io_message(err));
            }
        }
    }
    let canonical = p.canonicalize().map_err(io_message)?;
    Ok(CreatedDir {
        path: canonical.to_string_lossy().into_owned(),
        existed,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_absolute;

    #[test]
    fn rejects_empty_relative_and_nul() {
        assert!(validate_absolute("").is_err());
        assert!(validate_absolute("relative/dir").is_err());
        assert!(validate_absolute("./dir").is_err());
        assert!(validate_absolute("dir\0x").is_err());
    }

    #[test]
    fn rejects_dot_segments() {
        assert!(validate_absolute("/a/./b").is_err());
        assert!(validate_absolute("/a/../b").is_err());
        assert!(validate_absolute("/..").is_err());
        assert!(validate_absolute("/a/b/..").is_err());
    }

    #[test]
    fn accepts_absolute_paths() {
        assert!(validate_absolute("/home/user/Projects/My Proj").is_ok());
        assert!(validate_absolute("/").is_ok());
        assert!(validate_absolute("/a/b.c/d-e").is_ok());
    }
}
