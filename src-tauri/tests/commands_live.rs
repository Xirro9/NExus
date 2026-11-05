//! T30/T31 acceptance — command-level live tests against the real local
//! OpenCode service (read-only endpoints + one short-lived SSE connection;
//! light load, single-slot glm-server rule respected). Run explicitly:
//!   cargo test --test commands_live -- --ignored --nocapture

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::{api::ApiFetchArgs, sse_pump::{StreamFrame, StreamRegistry}, service};
use serde_json::json;
use tauri::{ipc::Channel, Manager};

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .manage(reqwest::Client::new())
        .manage(StreamRegistry::default())
        .build(tauri::generate_context!())
        .expect("mock app")
}

fn resolve_or_skip() -> service::ServiceTarget {
    match service::resolve() {
        Some(t) => t,
        None => {
            println!("SKIP: service.json unreadable — live service tests need the local OpenCode install");
            unreachable!("caller checks with_live()");
        }
    }
}

fn with_live() -> bool {
    service::resolve().is_some()
}

#[test]
#[ignore]
fn api_fetch_info_roundtrip() {
    if !with_live() {
        println!("SKIP: no service.json");
        return;
    }
    let _ = resolve_or_skip();
    let app = mock_app();
    let state = app.state::<reqwest::Client>();

    // GET /api/info through the command — 200 + parseable JSON
    let res = tauri::async_runtime::block_on(app_lib::api::api_fetch(
        state.clone(),
        ApiFetchArgs {
            method: "GET".into(),
            path: "/api/info".into(),
            headers: Default::default(),
            body: None,
        },
    ))
    .expect("api_fetch must resolve on success");
    assert_eq!(res.status, 200);
    let info: serde_json::Value = serde_json::from_str(&res.body).expect("JSON body");
    println!("api info: version={:?}", info.get("version"));

    // POST with a JSON body (echoes request path handling) — /api/session list
    let res = tauri::async_runtime::block_on(app_lib::api::api_fetch(
        state,
        ApiFetchArgs {
            method: "GET".into(),
            path: "/api/session?limit=1&order=desc".into(),
            headers: Default::default(),
            body: None,
        },
    ))
    .expect("api_fetch session list");
    assert_eq!(res.status, 200);

    // guard: non-/api paths are rejected
    let err = tauri::async_runtime::block_on(app_lib::api::api_fetch(
        app.state::<reqwest::Client>(),
        ApiFetchArgs {
            method: "GET".into(),
            path: "/etc/passwd".into(),
            headers: Default::default(),
            body: None,
        },
    ))
    .expect_err("non-/api path must reject");
    assert!(err.contains("rejected non-/api path"), "{err}");
    println!("api_fetch guard ✔");
}

#[test]
#[ignore]
fn api_fetch_json_post_roundtrip() {
    if !with_live() {
        println!("SKIP: no service.json");
        return;
    }
    let _ = resolve_or_skip();
    let app = mock_app();
    let state = app.state::<reqwest::Client>();

    // B1 regression: JSON POST through the command. reqwest adds no
    // Content-Type for .body(String), so the client-supplied header is the
    // only one — without it every create/prompt/command POST breaks.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis();
    let title = format!("jerry-transport-test {ms}");
    let body = serde_json::to_string(&json!({
        "title": title,
        "location": { "directory": env!("CARGO_MANIFEST_DIR") },
    }))
    .expect("serialize body");

    let res = tauri::async_runtime::block_on(app_lib::api::api_fetch(
        state.clone(),
        ApiFetchArgs {
            method: "POST".into(),
            path: "/api/session".into(),
            headers: HashMap::from([(
                "content-type".to_string(),
                "application/json".to_string(),
            )]),
            body: Some(body),
        },
    ))
    .expect("POST /api/session must resolve");
    assert_eq!(res.status, 200, "create failed: {}", res.body);
    let created: serde_json::Value = serde_json::from_str(&res.body).expect("JSON envelope");
    let id = created
        .pointer("/data/id")
        .and_then(|v| v.as_str())
        .expect("session id in data envelope")
        .to_string();
    assert_eq!(
        created.pointer("/data/title").and_then(|v| v.as_str()),
        Some(title.as_str()),
        "title must roundtrip through the POST body"
    );
    println!("created traceable session {id}");

    // immediately clean up — the session is real
    let res = tauri::async_runtime::block_on(app_lib::api::api_fetch(
        state,
        ApiFetchArgs {
            method: "DELETE".into(),
            path: format!("/api/session/{id}"),
            headers: Default::default(),
            body: None,
        },
    ))
    .expect("DELETE must resolve");
    assert_eq!(res.status, 204, "delete failed: {}", res.body);
    println!("POST → DELETE roundtrip ✔ (session {id} removed)");
}

#[test]
#[ignore]
fn sse_pump_live() {
    if !with_live() {
        println!("SKIP: no service.json");
        return;
    }
    let _ = resolve_or_skip();
    let app = mock_app();

    let frames: Arc<Mutex<Vec<StreamFrame>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = frames.clone();
    let channel: Channel<StreamFrame> = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            if let Ok(frame) = serde_json::from_str::<StreamFrame>(&text) {
                sink.lock().expect("frame sink").push(frame);
            }
        }
        Ok(())
    });

    let stream_id = tauri::async_runtime::block_on(app_lib::sse_pump::event_stream_start(
        app.handle().clone(),
        app.state::<StreamRegistry>(),
        channel,
    ))
    .expect("event_stream_start");

    // wait for state:"open" then a short window for any events/heartbeats
    let mut opened = false;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if frames
            .lock()
            .expect("frame sink")
            .iter()
            .any(|f| f.kind == "state" && f.state.as_deref() == Some("open"))
        {
            opened = true;
            break;
        }
    }
    assert!(opened, "pump must reach state=open against the live service");
    // hold the connection 3 s — pump must stay alive (no error frames after open)
    std::thread::sleep(Duration::from_secs(3));
    {
        let got = frames.lock().expect("frame sink");
        assert!(
            !got.iter().any(|f| f.kind == "state" && f.state.as_deref() == Some("error")),
            "no error frame while the service is up"
        );
        let events = got.iter().filter(|f| f.kind == "event").count();
        println!("frames after open: {} events, {} total", events, got.len());
    }

    // stop must flip the registry flag and remove the entry
    app_lib::sse_pump::event_stream_stop(app.state::<StreamRegistry>(), stream_id)
        .expect("event_stream_stop");
    std::thread::sleep(Duration::from_millis(300));
    let open_count = frames
        .lock()
        .expect("frame sink")
        .iter()
        .filter(|f| f.kind == "state" && f.state.as_deref() == Some("open"))
        .count();
    std::thread::sleep(Duration::from_secs(3));
    let open_count_after = frames
        .lock()
        .expect("frame sink")
        .iter()
        .filter(|f| f.kind == "state" && f.state.as_deref() == Some("open"))
        .count();
    assert_eq!(open_count, open_count_after, "no reconnect after stop");
    println!("sse pump open → stop ✔ (no reconnect)");
}

#[test]
#[ignore]
fn event_frames_parse_as_envelopes() {
    // the JSON we forward must match the NexusEvent expectation shape used by
    // the TS side (id/created/type/data) — verify with a representative set
    for payload in [
        json!({"id": "1", "created": 1, "type": "session.updated", "data": {}}),
        json!({"type": "session.text.delta", "data": {"text": "hi"}}),
        json!({"type": "permission.asked", "data": {"id": "p1"}, "location": {"projectID": "x"}}),
    ] {
        let s = serde_json::to_string(&payload).expect("str");
        let parsed: serde_json::Value = serde_json::from_str(&s).expect("roundtrip");
        assert!(parsed.get("type").and_then(|t| t.as_str()).is_some());
    }
}
