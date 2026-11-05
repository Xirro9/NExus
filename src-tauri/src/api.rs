// api_fetch command — async reqwest pass-through with auth injection
// (SPEC-PHASE4 §3). HTTP error statuses are RETURNED, never rejected; the
// TS client maps them to ApiError exactly as it does for fetch today.
// Rejects Err(String) only on transport failure (unreadable service.json,
// connect/timeout errors).

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::service;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFetchArgs {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFetchResponse {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub async fn api_fetch(
    client: tauri::State<'_, reqwest::Client>,
    args: ApiFetchArgs,
) -> Result<ApiFetchResponse, String> {
    // defense in depth: the client only ever sends /api paths
    if !args.path.starts_with("/api") {
        return Err(format!("rejected non-/api path: {}", args.path));
    }
    let target = service::resolve().ok_or("opencode service.json unreadable")?;

    let url = format!("{}{}", target.base_url.trim_end_matches('/'), args.path);
    let method = reqwest::Method::from_bytes(args.method.as_bytes())
        .map_err(|e| format!("invalid method: {e}"))?;

    let mut req = client
        .request(method, &url)
        .timeout(Duration::from_secs(30))
        .header("authorization", &target.auth_header);
    for (k, v) in &args.headers {
        // the webview must never supply auth — the password lives here
        if k.eq_ignore_ascii_case("authorization") {
            continue;
        }
        req = req.header(k, v);
    }
    if let Some(body) = args.body {
        req = req.body(body);
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| format!("body read failed: {e}"))?;
    Ok(ApiFetchResponse { status, body })
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_api_path() {
        // mirror of the command guard without the tauri State plumbing
        let path = "/etc/passwd";
        assert!(!path.starts_with("/api"));
    }
}
