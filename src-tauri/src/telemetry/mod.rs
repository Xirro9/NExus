// Telemetry module — Rust port of the dev middleware (src/server/telemetry.ts),
// SPEC-PHASE4 §6 parity contract: identical cadences (system/gpu 2 s,
// compute-apps 30 s, health 5 s, props 60 s), ring capacities (300/300/150),
// and degradation semantics. system+gpu run on one dedicated std::thread
// (blocking /proc reads + child stdout); llm probes on the tokio runtime.
// ZERO OpenCode API calls from here — single-slot glm-server rule.

pub mod gpu;
pub mod llm;
pub mod ring;
pub mod system;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use gpu::{ComputeApp, GpuLoop, GpuSample};
use llm::LlmSample;
use ring::RingBuffer;
use system::{SystemSample, SystemSampler};

// ---------------------------------------------------------------------------
// serialized snapshot types — EXACTLY the TelemetrySnapshot shape
// (SPEC-PHASE2 §2.6, field-for-field)

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LlmStatus {
    Ok,
    Starting,
    Unreachable,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
pub enum GpuSource {
    #[serde(rename = "nvidia-smi")]
    NvidiaSmi,
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlamaModelInfo {
    pub path: Option<String>,
    pub alias: Option<String>,
    pub n_ctx: Option<u64>,
    pub slots: Option<u64>,
    pub build: Option<String>,
    pub is_sleeping: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct LlmSnapshot {
    pub ok: bool,
    pub error: Option<String>,
    pub url: String,
    pub status: Option<LlmStatus>,
    pub latency_ms: Option<f64>,
    pub model: Option<LlamaModelInfo>,
    pub props_stale_ms: Option<u64>,
    pub samples: Vec<LlmSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSection {
    pub ok: bool,
    pub error: Option<String>,
    pub samples: Vec<SystemSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSection {
    pub ok: bool,
    pub error: Option<String>,
    pub source: GpuSource,
    pub compute_apps: Vec<ComputeApp>,
    pub samples: Vec<GpuSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshotJson {
    pub now: u64,
    pub system: SystemSection,
    pub gpu: GpuSection,
    pub llm: LlmSnapshot,
}

// ---------------------------------------------------------------------------
// shared state (rings + flags)

pub struct Flags {
    pub system_ok: bool,
    pub system_error: Option<String>,
    pub gpu_ok: bool,
    pub gpu_error: Option<String>,
    pub gpu_source: GpuSource,
    pub compute_apps: Vec<ComputeApp>,
    pub llm_ok: bool,
    pub llm_error: Option<String>,
    pub llm_status: Option<LlmStatus>,
    pub llm_latency_ms: Option<f64>,
    pub llm_model: Option<LlamaModelInfo>,
    pub props_fetched_at: Option<u64>,
}

pub struct Shared {
    pub system_ring: Mutex<RingBuffer<SystemSample>>,
    pub gpu_ring: Mutex<RingBuffer<GpuSample>>,
    pub llm_ring: Mutex<RingBuffer<LlmSample>>,
    pub flags: Mutex<Flags>,
    pub llm_url: String,
}

impl Shared {
    /// Lock with poison recovery — telemetry never fails a snapshot on a
    /// panicked holder (the command contract is "never fails").
    pub fn lock_flags(&self) -> std::sync::MutexGuard<'_, Flags> {
        self.flags.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn lock_gpu_ring(&self) -> std::sync::MutexGuard<'_, RingBuffer<GpuSample>> {
        self.gpu_ring.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn lock_system_ring(
        &self,
    ) -> std::sync::MutexGuard<'_, RingBuffer<SystemSample>> {
        self.system_ring.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn lock_llm_ring(&self) -> std::sync::MutexGuard<'_, RingBuffer<LlmSample>> {
        self.llm_ring.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Managed handle — `TelemetryState::spawn()` starts both loop groups once.
pub struct TelemetryState {
    shared: Arc<Shared>,
}

impl TelemetryState {
    pub fn spawn(client: reqwest::Client) -> Self {
        let shared = Arc::new(Shared {
            system_ring: Mutex::new(RingBuffer::new(300)), // ≈10 min @ 2 s
            gpu_ring: Mutex::new(RingBuffer::new(300)),
            llm_ring: Mutex::new(RingBuffer::new(150)), // ≈12.5 min @ 5 s
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
            llm_url: llm::llm_url(),
        });

        // system + gpu loops: one dedicated blocking thread, 2 s tick,
        // compute-apps every 15th tick = 30 s
        {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("nexus-telemetry".into())
                .spawn(move || blocking_loop(shared))
                .map_err(|e| log::error!("[telemetry] thread spawn failed: {e}"))
                .ok();
        }

        // llm probes on the tokio runtime (tauri's global async runtime)
        tauri::async_runtime::spawn(llm::run(client, shared.clone()));

        TelemetryState { shared }
    }

    fn snapshot(&self, tail: Option<TailSpec>) -> TelemetrySnapshotJson {
        let s = &self.shared;
        let flags = s.lock_flags();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let sys_tail = tail.as_ref().and_then(|t| t.system);
        let gpu_tail = tail.as_ref().and_then(|t| t.gpu);
        let llm_tail = tail.as_ref().and_then(|t| t.llm);
        TelemetrySnapshotJson {
            now: now_ms,
            system: SystemSection {
                ok: flags.system_ok,
                error: flags.system_error.clone(),
                samples: s.lock_system_ring().tail(sys_tail),
            },
            gpu: GpuSection {
                ok: flags.gpu_ok,
                error: flags.gpu_error.clone(),
                source: flags.gpu_source,
                compute_apps: flags.compute_apps.clone(),
                samples: s.lock_gpu_ring().tail(gpu_tail),
            },
            llm: LlmSnapshot {
                ok: flags.llm_ok,
                error: flags.llm_error.clone(),
                url: s.llm_url.clone(),
                status: flags.llm_status,
                latency_ms: flags.llm_latency_ms,
                model: flags.llm_model.clone(),
                props_stale_ms: match (flags.llm_model.as_ref(), flags.props_fetched_at) {
                    (Some(_), Some(at)) => Some(now_ms.saturating_sub(at)),
                    _ => None,
                },
                samples: s.lock_llm_ring().tail(llm_tail),
            },
        }
    }
}

/// Dedicated blocking thread: 2 s tick — system sample, gpu tick; compute-apps
/// every 15th tick. First tick runs immediately (startLoops parity).
fn blocking_loop(shared: Arc<Shared>) {
    let mut sys = SystemSampler::new();
    let mut gpu = GpuLoop::new(shared.clone());
    let mut tick_count: u64 = 0;
    loop {
        // system sample (§2.2 math; failure → ok=false + error, no push)
        match sys.sample() {
            Ok(sample) => {
                shared.lock_system_ring().push(sample);
                let mut flags = shared.lock_flags();
                flags.system_ok = true;
                flags.system_error = None;
            }
            Err(reason) => {
                let mut flags = shared.lock_flags();
                flags.system_ok = false;
                flags.system_error = Some(reason);
            }
        }
        gpu.tick();
        if tick_count % 15 == 0 {
            gpu.sample_compute_apps();
        }
        tick_count = tick_count.wrapping_add(1);
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ---------------------------------------------------------------------------
// command

/// Optional per-ring truncation — the pre-built throttle lever (§10.3); the
/// store passes null (full parity today).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailSpec {
    pub system: Option<usize>,
    pub gpu: Option<usize>,
    pub llm: Option<usize>,
}

#[tauri::command]
pub fn telemetry_snapshot(
    state: tauri::State<'_, TelemetryState>,
    tail: Option<TailSpec>,
) -> serde_json::Value {
    serde_json::to_value(state.snapshot(tail)).unwrap_or_else(|_| serde_json::json!({
        "now": 0,
        "system": { "ok": false, "error": "snapshot serialization failed", "samples": [] },
        "gpu": { "ok": false, "error": "snapshot serialization failed", "source": "unavailable", "computeApps": [], "samples": [] },
        "llm": { "ok": false, "error": "snapshot serialization failed", "url": "", "status": null, "latencyMs": null, "model": null, "propsStaleMs": null, "samples": [] }
    }))
}
