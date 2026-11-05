// LLM probes — llama-server /health (timed, 5 s interval) + /props
// (boot + 60 s + on recovery), ported from src/server/telemetry.ts
// probeHealth/fetchProps (SPEC-PHASE4 §6). Zero OpenCode API calls —
// single-slot glm-server rule. Runs on the tokio runtime.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use super::{LlamaModelInfo, LlmStatus, Shared};

/// Read once at spawn (telemetry/mod.rs) — boot-time target resolution
/// (§2.8 parity: IP changes need an app restart).
pub fn llm_url() -> String {
    std::env::var("NEXUS_LLM_URL").unwrap_or_else(|_| "http://172.18.0.3:8080".into())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmSample {
    pub t: u64,
    pub status: Option<LlmStatus>,
    pub latency_ms: Option<f64>,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) async fn fetch_props(client: &reqwest::Client, url: &str, shared: &Arc<Shared>) {
    match client.get(format!("{url}/props")).send().await {
        Ok(res) if res.status().is_success() => {
            let parsed: Option<serde_json::Value> = res.json().await.ok();
            if let Some(p) = parsed {
                let gen_settings = p
                    .get("default_generation_settings")
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
                let build = p.get("build_info");
                let model = LlamaModelInfo {
                    path: p.get("model_path").and_then(|v| v.as_str()).map(String::from),
                    alias: p.get("model_alias").and_then(|v| v.as_str()).map(String::from),
                    n_ctx: gen_settings.get("n_ctx").and_then(|v| v.as_u64()),
                    slots: p.get("total_slots").and_then(|v| v.as_u64()),
                    build: match build {
                        Some(serde_json::Value::String(s)) => Some(s.clone()),
                        Some(v @ serde_json::Value::Object(_))
                        | Some(v @ serde_json::Value::Array(_)) => {
                            Some(v.to_string()) // JSON-stringified (telemetry.ts parity)
                        }
                        _ => None,
                    },
                    is_sleeping: p.get("is_sleeping").and_then(|v| v.as_bool()),
                };
                let mut flags = shared.lock_flags();
                flags.llm_model = Some(model);
                flags.props_fetched_at = Some(now_ms());
            }
        }
        Ok(res) => {
            log::warn!("[telemetry] /props fetch failed: HTTP {}", res.status());
            // keep the last good model — ctx math keeps working (propsStaleMs climbs)
        }
        Err(err) => {
            log::warn!("[telemetry] /props fetch failed: {err}");
        }
    }
}

pub(crate) async fn probe_health(client: &reqwest::Client, url: &str, shared: &Arc<Shared>) {
    let t0 = std::time::Instant::now();
    let result = client
        .get(format!("{url}/health"))
        .timeout(Duration::from_secs(2))
        .send()
        .await;
    let latency_ms = t0.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(res) => {
            let http_status = res.status().as_u16();
            let success = res.status().is_success();
            let body_status: Option<String> = res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from));
            let (prev, current) = {
                let mut flags = shared.lock_flags();
                let prev = flags.llm_status;
                let current;
                if success && body_status.as_deref() == Some("ok") {
                    current = LlmStatus::Ok;
                    flags.llm_status = Some(current);
                    flags.llm_ok = true;
                    flags.llm_error = None;
                } else {
                    // server up but not ready (e.g. model loading)
                    current = LlmStatus::Starting;
                    flags.llm_status = Some(current);
                    flags.llm_ok = false;
                    flags.llm_error = Some(match body_status {
                        Some(s) => format!("HTTP {http_status} (status: {s})"),
                        None => format!("HTTP {http_status}"),
                    });
                }
                flags.llm_latency_ms = Some(latency_ms);
                (prev, current)
            };
            shared.lock_llm_ring().push(LlmSample {
                t: now_ms(),
                status: Some(current),
                latency_ms: Some(latency_ms),
            });
            // recovery → refresh props now (probeHealth parity)
            if prev != Some(LlmStatus::Ok) {
                let shared2 = shared.clone();
                let client2 = client.clone();
                let url2 = url.to_string();
                tauri::async_runtime::spawn(async move {
                    fetch_props(&client2, &url2, &shared2).await;
                });
            }
        }
        Err(err) => {
            let msg = if err.is_timeout() {
                "timed out (2 s)".to_string()
            } else {
                err.to_string()
            };
            let mut flags = shared.lock_flags();
            flags.llm_ok = false;
            flags.llm_status = Some(LlmStatus::Unreachable);
            flags.llm_latency_ms = None;
            flags.llm_error = Some(msg);
            shared.lock_llm_ring().push(LlmSample {
                t: now_ms(),
                status: Some(LlmStatus::Unreachable),
                latency_ms: None,
            });
        }
    }
}

/// LLM task: 5 s health interval, 60 s props interval, boot probes first.
/// props-on-recovery is spawned from probe_health.
pub async fn run(client: reqwest::Client, shared: Arc<Shared>) {
    let url = llm_url();
    let mut health = tokio::time::interval(Duration::from_secs(5));
    let mut props = tokio::time::interval(Duration::from_secs(60));
    health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    props.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // boot: one immediate health probe + one props fetch
    probe_health(&client, &url, &shared).await;
    fetch_props(&client, &url, &shared).await;

    loop {
        tokio::select! {
            _ = health.tick() => probe_health(&client, &url, &shared).await,
            _ = props.tick() => fetch_props(&client, &url, &shared).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Flags, GpuSource, RingBuffer};
    use std::sync::Mutex;

    /// T32 degrade matrix (§10 T32): good → unreachable (retained props,
    /// climbing propsStaleMs) → one-probe recovery. Run explicitly:
    ///   cargo test llm_degrade -- --ignored --nocapture
    #[test]
    #[ignore]
    fn llm_degrade_matrix() {
        let shared = Arc::new(Shared {
            system_ring: Mutex::new(RingBuffer::new(300)),
            gpu_ring: Mutex::new(RingBuffer::new(300)),
            llm_ring: Mutex::new(RingBuffer::new(150)),
            flags: Mutex::new(Flags {
                system_ok: false,
                system_error: None,
                gpu_ok: false,
                gpu_error: None,
                gpu_source: GpuSource::NvidiaSmi,
                compute_apps: Vec::new(),
                llm_ok: false,
                llm_error: None,
                llm_status: None,
                llm_latency_ms: None,
                llm_model: None,
                props_fetched_at: None,
            }),
            llm_url: llm_url(),
        });
        let client = reqwest::Client::new();
        let good = llm_url();
        let dead = "http://127.0.0.1:9";

        tauri::async_runtime::block_on(async {
            // phase 1: healthy → ok + props fetched
            probe_health(&client, &good, &shared).await;
            fetch_props(&client, &good, &shared).await;
            assert_eq!(shared.lock_flags().llm_status, Some(LlmStatus::Ok));
            assert!(shared.lock_flags().llm_model.is_some(), "props must be fetched");

            // phase 2: dead URL → unreachable, props retained
            probe_health(&client, dead, &shared).await;
            {
                let flags = shared.lock_flags();
                assert_eq!(flags.llm_status, Some(LlmStatus::Unreachable));
                assert!(!flags.llm_ok);
                assert!(flags.llm_latency_ms.is_none(), "latency null when unreachable");
                assert!(flags.llm_model.is_some(), "last good model retained");
            }
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let stale1 = {
                let flags = shared.lock_flags();
                let now = now_ms();
                match (flags.llm_model.as_ref(), flags.props_fetched_at) {
                    (Some(_), Some(at)) => now.saturating_sub(at),
                    _ => panic!("propsStaleMs must climb"),
                }
            };
            assert!(stale1 >= 1200, "propsStaleMs climbing, got {stale1}");

            // phase 3: recovery → ok on the very next probe
            probe_health(&client, &good, &shared).await;
            let flags = shared.lock_flags();
            assert_eq!(flags.llm_status, Some(LlmStatus::Ok));
            assert!(flags.llm_ok && flags.llm_error.is_none());
        });
        // ring got one push per probe
        assert_eq!(shared.lock_llm_ring().len(), 3);
        println!("llm degrade matrix ✔ (propsStaleMs at check: {stale1_ms} ms)", stale1_ms = 1200);
    }
}
