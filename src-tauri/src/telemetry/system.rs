// System sampler — /proc math ported 1:1 from src/server/telemetry.ts
// sampleSystem (SPEC-PHASE4 §6). CPU% = Δ between consecutive /proc/stat
// aggregate lines; first sample warms at 0.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSample {
    pub t: u64,
    pub cpu: f64,
    pub load1: f64,
    pub mem_used: u64,
    pub mem_total: u64,
}

struct ProcStat {
    total: u64,
    idle: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_proc_stat() -> Option<ProcStat> {
    // aggregate `cpu` line: user nice system idle iowait irq softirq steal …
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    let line = text.lines().next()?;
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let vals: Vec<u64> = fields.filter_map(|f| f.parse::<u64>().ok()).collect();
    if vals.is_empty() {
        return None;
    }
    let total: u64 = vals.iter().sum();
    let idle = vals.get(3).copied().unwrap_or(0) + vals.get(4).copied().unwrap_or(0);
    Some(ProcStat { total, idle })
}

fn read_mem_info() -> Option<(u64, u64)> {
    // (totalKb, availableKb)
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total_kb: Option<u64> = None;
    let mut available_kb: Option<u64> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = rest.split_whitespace().next()?.parse::<u64>().ok();
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available_kb = rest.split_whitespace().next()?.parse::<u64>().ok();
        }
    }
    Some((total_kb?, available_kb?))
}

pub struct SystemSampler {
    prev_cpu: Option<ProcStat>,
}

impl SystemSampler {
    pub fn new() -> Self {
        SystemSampler { prev_cpu: None }
    }

    /// One 2 s sample. Ok(sample) pushed by the caller; Err(reason) →
    /// system.ok=false + error string (no sample pushed — Node parity).
    pub fn sample(&mut self) -> Result<SystemSample, String> {
        let stat = read_proc_stat().ok_or("unexpected /proc format")?;
        let (total_kb, available_kb) = read_mem_info().ok_or("unexpected /proc format")?;
        let loadavg = std::fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|t| t.split(' ').next().and_then(|f| f.parse::<f64>().ok()))
            .ok_or("unexpected /proc format")?;

        // first sample: warming (delta needs a previous frame)
        let cpu = match self.prev_cpu {
            None => 0.0,
            Some(ref prev) => {
                let d_total = stat.total.saturating_sub(prev.total);
                let d_idle = stat.idle.saturating_sub(prev.idle);
                if d_total > 0 {
                    (1.0 - d_idle as f64 / d_total as f64) * 100.0
                } else {
                    0.0
                }
            }
        };
        self.prev_cpu = Some(stat);

        Ok(SystemSample {
            t: now_ms(),
            cpu: cpu.clamp(0.0, 100.0),
            load1: loadavg,
            mem_used: (total_kb.saturating_sub(available_kb)).saturating_mul(1024),
            mem_total: total_kb.saturating_mul(1024),
        })
    }
}
