// Telemetry snapshot contract (SPEC-PHASE2 §2.6 — verbatim).
// Client-safe: zero node imports. Shared by the Vite middleware (src/server/*)
// and the browser store (src/store/telemetry.ts).

export const TELEMETRY_SNAPSHOT_PATH = "/telemetry/snapshot"
export const TELEMETRY_LLM_PATH = "/telemetry/llm"

export interface SystemSample {
  t: number // Date.now() at sample (server clock)
  cpu: number // 0..100
  load1: number
  memUsed: number // bytes
  memTotal: number // bytes
}

export interface GpuInfo {
  index: number
  name: string
  utilGpu: number // %
  memUsed: number // MiB
  memTotal: number // MiB
  tempGpu: number // °C
  powerDraw: number // W
}
export interface GpuSample {
  t: number
  gpus: GpuInfo[]
}

export interface ComputeApp {
  pid: number
  name: string
  memUsedMiB: number
}

export interface LlamaModelInfo {
  path: string | null
  alias: string | null
  nCtx: number | null // /props default_generation_settings.n_ctx
  slots: number | null // /props total_slots
  build: string | null // /props build_info summary
  isSleeping: boolean | null
}

export interface LlmSample {
  t: number
  status: string | null
  latencyMs: number | null
}

export interface LlmSnapshot {
  ok: boolean
  error: string | null
  url: string // resolved target (NEXUS_LLM_URL)
  status: "ok" | "starting" | "unreachable" | null
  latencyMs: number | null // host → llama-server /health round trip
  model: LlamaModelInfo | null
  propsStaleMs: number | null // age of last successful /props fetch
  samples: LlmSample[] // ring, oldest → newest
}

export interface TelemetrySnapshot {
  now: number
  system: { ok: boolean; error: string | null; samples: SystemSample[] }
  gpu: {
    ok: boolean
    error: string | null
    source: "nvidia-smi" | "unavailable"
    computeApps: ComputeApp[]
    samples: GpuSample[]
  }
  llm: LlmSnapshot
}
