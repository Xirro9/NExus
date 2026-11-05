// SSE pump — Rust port of the browser EventSource semantics (SPEC-PHASE4 §3):
// GET {base}/api/event with injected auth, parse `data:` frames (blank-line
// delimited, `:` comment lines ignored), forward each parsed JSON envelope
// over a tauri ipc::Channel. The reconnect loop LIVES HERE (mirrors
// EventSource auto-reconnect) so useEventStream's resync semantics work
// verbatim. Exit conditions: stop flag set, channel send failed (webview
// gone), or app exit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

use crate::service;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFrame {
    /// "state" | "event"
    pub kind: String,
    /// "open" | "error" — present when kind == "state"
    pub state: Option<String>,
    /// parsed SSE envelope — present when kind == "event"
    pub event: Option<serde_json::Value>,
}

/// stream id → stop flag. `start` allocates, `stop` flips + removes.
#[derive(Default)]
pub struct StreamRegistry(Mutex<HashMap<u32, Arc<AtomicBool>>>);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
pub async fn event_stream_start(
    app: tauri::AppHandle,
    registry: tauri::State<'_, StreamRegistry>,
    channel: tauri::ipc::Channel<StreamFrame>,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut map = registry.0.lock().map_err(|_| "stream registry poisoned")?;
        map.insert(id, stop.clone());
    }
    tokio::spawn(pump_loop(app, channel, stop));
    Ok(id)
}

#[tauri::command]
pub fn event_stream_stop(
    registry: tauri::State<'_, StreamRegistry>,
    stream_id: u32,
) -> Result<(), String> {
    if let Ok(mut map) = registry.0.lock() {
        if let Some(flag) = map.remove(&stream_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// Resolves once the stop flag is set (polled — cheap at 100 ms granularity).
async fn stop_signal(stop: &Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn state_frame(state: &str) -> StreamFrame {
    StreamFrame {
        kind: "state".into(),
        state: Some(state.into()),
        event: None,
    }
}

async fn pump_loop(
    app: tauri::AppHandle,
    channel: tauri::ipc::Channel<StreamFrame>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Relaxed) {
        match connect_once(&app).await {
            Ok(res) => {
                if channel.send(state_frame("open")).is_err() {
                    return; // webview gone
                }
                if stream_response(res, &channel, &stop).await {
                    return; // stopped or channel closed
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                // stream ended / read error → EventSource-style error + retry
                if channel.send(state_frame("error")).is_err() {
                    return;
                }
            }
            Err(err) => {
                log::warn!("[sse-pump] connect failed: {err}");
                if channel.send(state_frame("error")).is_err() {
                    return;
                }
            }
        }
        // EventSource-equivalent retry delay
        tokio::select! {
            _ = stop_signal(&stop) => break,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
}

/// Consume one SSE response. Returns true when the pump should exit
/// (stop flag set or channel closed), false on stream end/error (reconnect).
async fn stream_response(
    mut res: reqwest::Response,
    channel: &tauri::ipc::Channel<StreamFrame>,
    stop: &Arc<AtomicBool>,
) -> bool {
    let mut buf = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = stop_signal(stop) => return true,
            chunk = res.chunk() => chunk,
        };
        let bytes = match chunk {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return false, // stream ended cleanly → error + reconnect
            Err(err) => {
                log::warn!("[sse-pump] read error: {err}");
                return false;
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // extract complete lines
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            if line.is_empty() {
                // blank line = frame delimiter: dispatch accumulated data
                if !data_lines.is_empty() {
                    let payload = data_lines.join("\n");
                    data_lines.clear();
                    match serde_json::from_str::<serde_json::Value>(&payload) {
                        Ok(event) => {
                            let frame = StreamFrame {
                                kind: "event".into(),
                                state: None,
                                event: Some(event),
                            };
                            if channel.send(frame).is_err() {
                                return true; // webview gone
                            }
                        }
                        Err(_) => continue, // non-JSON frame — ignore (parity: EventSource would too)
                    }
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
            // `:` comment lines (heartbeats) and other SSE fields ignored — live-only
        }
    }
}

/// One SSE connection: resolve() → GET /api/event with injected auth, no
/// overall timeout (the stream is long-lived by design).
async fn connect_once(app: &tauri::AppHandle) -> Result<reqwest::Response, String> {
    let target = service::resolve().ok_or("opencode service.json unreadable")?;
    let client = app
        .try_state::<reqwest::Client>()
        .map(|c| c.inner().clone())
        .ok_or("http client unavailable")?;
    let url = format!("{}/api/event", target.base_url.trim_end_matches('/'));
    let res = client
        .get(&url)
        .header("authorization", &target.auth_header)
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("event stream HTTP {}", res.status()));
    }
    Ok(res)
}
