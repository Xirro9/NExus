// GPU loop — long-lived `nvidia-smi -l 2` child + 30 s compute-apps one-shot,
// ported from src/server/telemetry.ts startGpuLoop/sampleComputeApps
// (SPEC-PHASE4 §6). The child's stdout is drained by a helper thread into a
// channel; the telemetry thread ticks every 2 s (drain, index-reset flush,
// 1.5 s tail-flush, respawn backoff). ENOENT → source "unavailable", no
// retry; child exit → backoff respawn 30 s doubling to 300 s, reset after
// 5 min stable.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::Shared;

const GPU_QUERY_ARGS: [&str; 4] = [
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
    "--format=csv,noheader,nounits",
    "-l",
    "2",
];
const GPU_APPS_ARGS: [&str; 2] = [
    "--query-compute-apps=pid,process_name,used_memory",
    "--format=csv,noheader",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub util_gpu: f64,
    pub mem_used: f64,
    pub mem_total: f64,
    pub temp_gpu: f64,
    pub power_draw: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub t: u64,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeApp {
    pub pid: u32,
    pub name: String,
    pub mem_used_mi_b: f64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// nvidia-smi quotes fields containing commas; split on `", "` when present
/// else `", "` (telemetry.ts splitCsv).
fn split_csv(line: &str) -> Vec<String> {
    let sep = if line.contains("\", \"") { "\", \"" } else { ", " };
    line.split(sep)
        .map(|f| f.trim().trim_matches('"').to_string())
        .collect()
}

fn parse_gpu_line(line: &str, parse_warned: &mut bool) -> Option<GpuInfo> {
    let f = split_csv(line);
    if f.len() < 7 {
        return None;
    }
    let index = f[0].parse::<u32>().ok()?;
    let mut warned = false;
    let mut num = |s: &str| -> f64 {
        match s.trim().parse::<f64>() {
            Ok(n) => n,
            Err(_) => {
                warned = true; // NaN → 0 + flag (never synthesize a row)
                0.0
            }
        }
    };
    let info = GpuInfo {
        index,
        name: f[1].clone(),
        util_gpu: num(&f[2]),
        mem_used: num(&f[3]),
        mem_total: num(&f[4]),
        temp_gpu: num(&f[5]),
        power_draw: num(&f[6]),
    };
    *parse_warned |= warned;
    Some(info)
}

/// used_memory carries a unit suffix ("70388 MiB") — parse the leading number.
fn parse_leading_f64(s: &str) -> Option<f64> {
    let t = s.trim();
    let end = t
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+')
        .unwrap_or(t.len());
    t[..end].parse::<f64>().ok()
}

fn parse_compute_apps(out: &str) -> Vec<ComputeApp> {
    let mut apps = Vec::new();
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let f = split_csv(trimmed);
        let pid = f.first().and_then(|p| p.parse::<u32>().ok());
        let name = f.get(1).map(|n| n.clone()).unwrap_or_default();
        let mem = f.get(2).and_then(|m| parse_leading_f64(m));
        match (pid, name.is_empty(), mem) {
            (Some(pid), false, mem) => apps.push(ComputeApp {
                pid,
                name,
                mem_used_mi_b: mem.unwrap_or(0.0),
            }),
            _ => continue,
        }
    }
    apps
}

enum QuerySpawn {
    Started(Child, Receiver<String>),
    /// nvidia-smi is not installed — stop retrying (§2.3)
    Unavailable(String),
    Failed(String),
}

fn spawn_reader(mut child: Child) -> (Child, Receiver<String>) {
    let (tx, rx) = channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
            // sender dropped → channel disconnect signals child stdout EOF
        });
    }
    (child, rx)
}

fn start_query_child() -> QuerySpawn {
    match Command::new("nvidia-smi")
        .args(GPU_QUERY_ARGS)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            let (child, rx) = spawn_reader(child);
            QuerySpawn::Started(child, rx)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            QuerySpawn::Unavailable("nvidia-smi not installed".into())
        }
        Err(err) => QuerySpawn::Failed(format!("nvidia-smi spawn failed: {err}")),
    }
}

/// Long-lived GPU loop state; `tick()` every 2 s from the telemetry thread.
pub struct GpuLoop {
    shared: std::sync::Arc<Shared>,
    child: Option<Child>,
    rx: Option<Receiver<String>>,
    pending_rows: Vec<GpuInfo>,
    last_row_index: i64,
    parse_warned: bool,
    last_line_at: Option<Instant>,
    backoff: Duration,
    stable_since: Option<Instant>,
    next_respawn_at: Instant,
}

impl GpuLoop {
    pub fn new(shared: std::sync::Arc<Shared>) -> Self {
        let mut gpu = GpuLoop {
            shared,
            child: None,
            rx: None,
            pending_rows: Vec::new(),
            last_row_index: -1,
            parse_warned: false,
            last_line_at: None,
            backoff: Duration::from_secs(30),
            stable_since: None,
            next_respawn_at: Instant::now(),
        };
        gpu.start_child();
        gpu
    }

    fn set_source_available(&self, ok: bool) {
        let mut flags = self.shared.lock_flags();
        flags.gpu_source = super::GpuSource::NvidiaSmi;
        flags.gpu_ok = ok;
    }

    fn mark_unavailable(&mut self, reason: &str) {
        let mut flags = self.shared.lock_flags();
        flags.gpu_source = super::GpuSource::Unavailable;
        flags.gpu_ok = false;
        flags.gpu_error = Some(reason.to_string());
        self.child = None;
        self.rx = None;
        // nvidia-smi is not installed — stop retrying (§2.3)
    }

    fn start_child(&mut self) {
        self.pending_rows.clear();
        self.last_row_index = -1;
        self.parse_warned = false;
        match start_query_child() {
            QuerySpawn::Started(child, rx) => {
                self.child = Some(child);
                self.rx = Some(rx);
                self.stable_since = Some(Instant::now());
                self.set_source_available(false);
            }
            QuerySpawn::Unavailable(reason) => self.mark_unavailable(&reason),
            QuerySpawn::Failed(reason) => {
                {
                    let mut flags = self.shared.lock_flags();
                    flags.gpu_ok = false;
                    flags.gpu_error = Some(reason);
                }
                self.schedule_respawn();
            }
        }
    }

    fn schedule_respawn(&mut self) {
        self.next_respawn_at = Instant::now() + self.backoff;
        self.backoff = (self.backoff * 2).min(Duration::from_secs(300));
    }

    fn flush_rows(&mut self) {
        if !self.pending_rows.is_empty() {
            let sample = GpuSample {
                t: now_ms(),
                gpus: std::mem::take(&mut self.pending_rows),
            };
            self.shared.lock_gpu_ring().push(sample);
        }
        let mut flags = self.shared.lock_flags();
        if self.parse_warned {
            flags.gpu_error =
                Some("nvidia-smi csv had non-numeric fields (coerced to 0)".into());
            self.parse_warned = false;
        } else if flags.gpu_ok {
            flags.gpu_error = None;
        }
    }

    /// Handle child stdout EOF: flush, backoff-ladder bookkeeping, respawn.
    fn on_child_exit(&mut self) {
        self.flush_rows();
        let mut code_desc = "signal".to_string();
        if let Some(mut child) = self.child.take() {
            if let Ok(status) = child.wait() {
                if let Some(code) = status.code() {
                    code_desc = code.to_string();
                }
            }
        }
        self.rx = None;
        // stable ≥ 5 min → reset the backoff ladder (§2.3)
        if self
            .stable_since
            .is_some_and(|s| s.elapsed() > Duration::from_secs(5 * 60))
        {
            self.backoff = Duration::from_secs(30);
        }
        self.stable_since = None;
        {
            let mut flags = self.shared.lock_flags();
            flags.gpu_ok = false;
            flags.gpu_error =
                Some(format!("nvidia-smi exited (code {code_desc}) — respawning"));
        }
        self.schedule_respawn();
    }

    /// One 2 s tick: drain child lines, process rows, tail-flush, respawn.
    pub fn tick(&mut self) {
        if self.child.is_none() {
            if self.rx.is_none()
                && !matches!(
                    self.shared.lock_flags().gpu_source,
                    super::GpuSource::Unavailable
                )
                && Instant::now() >= self.next_respawn_at
            {
                self.start_child();
            }
            return;
        }

        // drain all buffered lines from the reader thread (collected first —
        // the Receiver borrow must end before the mutable processing below)
        let mut lines: Vec<String> = Vec::new();
        let mut disconnected = false;
        if let Some(rx) = &self.rx {
            loop {
                match rx.try_recv() {
                    Ok(line) => lines.push(line),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        let got_lines = !lines.is_empty();
        for line in &lines {
            self.process_line(line);
        }
        if disconnected {
            self.on_child_exit();
            return;
        }
        if got_lines {
            self.last_line_at = Some(Instant::now());
        }
        // tail-flush: emit the newest block promptly (1.5 s after last line)
        if !self.pending_rows.is_empty()
            && self
                .last_line_at
                .is_some_and(|t| t.elapsed() >= Duration::from_millis(1500))
        {
            self.flush_rows();
        }
    }

    fn process_line(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let Some(info) = parse_gpu_line(trimmed, &mut self.parse_warned) else {
            return;
        };
        // a row index ≤ the previous one starts a new sample block
        if info.index as i64 <= self.last_row_index && !self.pending_rows.is_empty() {
            self.flush_rows();
        }
        self.last_row_index = info.index as i64;
        self.pending_rows.push(info);
        self.set_source_available(true);
    }

    /// 30 s one-shot compute-apps sample — cannot be combined with `-l`
    /// across drivers (§2.3). Non-zero exit keeps the last good data.
    pub fn sample_compute_apps(&mut self) {
        let output = Command::new("nvidia-smi")
            .args(GPU_APPS_ARGS)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let apps = parse_compute_apps(&String::from_utf8_lossy(&out.stdout));
                self.shared.lock_flags().compute_apps = apps;
            }
            Ok(_) => {
                // parity with the TS reference: a non-zero compute-apps exit
                // keeps the last good data silently — do NOT flip gpu_ok
                // (the -l 2 stream failure path above stays as-is)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.mark_unavailable("nvidia-smi not installed");
            }
            Err(err) => {
                let mut flags = self.shared.lock_flags();
                flags.gpu_error = Some(format!("nvidia-smi spawn failed: {err}"));
            }
        }
    }
}

// The reader thread owns the channel Sender; dropping the Receiver (in
// mark_unavailable / on_child_exit) unblocks it and signals stdout EOF.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Flags, GpuSource, RingBuffer};
    use std::sync::{Arc, Mutex};

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
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
            llm_url: "http://127.0.0.1:9".into(),
        })
    }

    /// T32 degrade matrix — nvidia-smi missing from PATH → source
    /// "unavailable", no respawn retry. Run isolated (it mutates the process
    /// PATH): cargo test gpu_unavailable -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn gpu_unavailable_degrade() {
        // SAFETY: single-threaded test (run with --test-threads=1); PATH is
        // only mutated to make the nvidia-smi lookup fail.
        unsafe { std::env::set_var("PATH", "/nonexistent") };
        let shared = shared();
        let mut gpu = GpuLoop::new(shared.clone());
        for _ in 0..3 {
            gpu.tick();
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let flags = shared.lock_flags();
        assert_eq!(flags.gpu_source, GpuSource::Unavailable);
        assert_eq!(flags.gpu_error.as_deref(), Some("nvidia-smi not installed"));
        assert!(!flags.gpu_ok);
        assert!(gpu.child.is_none() && gpu.rx.is_none(), "no retry state held");
        // further ticks must not attempt respawn
        drop(flags);
        for _ in 0..3 {
            gpu.tick();
        }
        let flags = shared.lock_flags();
        assert_eq!(flags.gpu_source, GpuSource::Unavailable, "still unavailable, no retry");
        unsafe { std::env::set_var("PATH", "/usr/bin:/bin") };
        println!("gpu unavailable degrade ✔ (no retry)");
    }

    /// T32: compute-apps parsing incl. the " MiB" suffix (§6 table).
    #[test]
    fn compute_apps_parse() {
        let out = "835267, /app/llama-server, 70764 MiB\n225747, /usr/libexec/gnome-remote-desktop-daemon, 560 MiB\n";
        let apps = parse_compute_apps(out);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].pid, 835267);
        assert_eq!(apps[0].name, "/app/llama-server");
        assert_eq!(apps[0].mem_used_mi_b, 70764.0);
        assert_eq!(apps[1].mem_used_mi_b, 560.0);
    }

    /// T32: gpu csv line parse with quoted commas (splitCsv parity).
    #[test]
    fn gpu_line_parse() {
        let mut warned = false;
        let info = parse_gpu_line(
            "0, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 35, 70902, 97887, 76, 87.68",
            &mut warned,
        )
        .expect("parse");
        assert_eq!(info.index, 0);
        assert!(info.name.contains("RTX PRO 6000"));
        assert_eq!(info.mem_used, 70902.0);
        assert_eq!(info.power_draw, 87.68);
        assert!(!warned);
    }
}
