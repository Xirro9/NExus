// Nexus telemetry provider — Node-only Vite plugin (SPEC-PHASE2 §2).
// Serves origin-relative /telemetry/* JSON and runs the poll loops:
//   system  2 s   → /proc/stat, /proc/meminfo, /proc/loadavg
//   gpu     2 s   → long-lived `nvidia-smi -l 2` child (§2.3 — never spawn-per-poll)
//   gpu apps 30 s → one-shot `nvidia-smi --query-compute-apps=...`
//   llm     5 s   → timed GET /health (2 s timeout); /props boot + 60 s + on recovery
// ZERO OpenCode API calls from here — single-slot glm-server rule (§9.2).
// The only vite import allowed in this file is the Plugin type.

import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import type { Plugin } from "vite"

import {
  type ComputeApp,
  type GpuInfo,
  type LlamaModelInfo,
  type TelemetrySnapshot,
} from "../lib/telemetry/types"
import { RingBuffer } from "./ring-buffer"

// boot-time target resolution (§2.8: IP changes need a dev-server restart)
const LLM_URL = process.env.NEXUS_LLM_URL ?? "http://172.18.0.3:8080"

const SYSTEM_CAPACITY = 300 // ≈10 min @ 2 s
const GPU_CAPACITY = 300
const LLM_CAPACITY = 150 // ≈12.5 min @ 5 s

// ---------------------------------------------------------------------------
// module-scoped state (one dev server per process)

const systemRing = new RingBuffer<{ t: number; cpu: number; load1: number; memUsed: number; memTotal: number }>(SYSTEM_CAPACITY)
const gpuRing = new RingBuffer<{ t: number; gpus: GpuInfo[] }>(GPU_CAPACITY)
const llmRing = new RingBuffer<{ t: number; status: string | null; latencyMs: number | null }>(LLM_CAPACITY)

let systemOk = false
let systemError: string | null = null

let gpuOk = false
let gpuError: string | null = null
let gpuSource: "nvidia-smi" | "unavailable" = "nvidia-smi"
let computeApps: ComputeApp[] = []

let llmOk = false
let llmError: string | null = null
let llmStatus: "ok" | "starting" | "unreachable" | null = null
let llmLatencyMs: number | null = null
let llmModel: LlamaModelInfo | null = null
let propsFetchedAt: number | null = null

let systemTimer: ReturnType<typeof setInterval> | null = null
let gpuAppsTimer: ReturnType<typeof setInterval> | null = null
let llmTimer: ReturnType<typeof setInterval> | null = null
let propsTimer: ReturnType<typeof setInterval> | null = null
let gpuChild: ChildProcess | null = null
let gpuRespawnTimer: ReturnType<typeof setTimeout> | null = null
let gpuFlushTimer: ReturnType<typeof setTimeout> | null = null
let started = false

// ---------------------------------------------------------------------------
// helpers

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// system loop — /proc (§2.2 exact math)

let prevCpu: { total: number; idle: number } | null = null

function readProcStat(): { total: number; idle: number } | null {
  // aggregate `cpu` line: user nice system idle iowait irq softirq steal ...
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0]
  if (!line.startsWith("cpu ")) return null
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((f) => Number(f))
  if (fields.some((f) => !Number.isFinite(f))) return null
  const total = fields.reduce((a, b) => a + b, 0)
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0) // idle + iowait
  return { total, idle }
}

function readMemInfo(): { totalKb: number; availableKb: number } | null {
  const text = readFileSync("/proc/meminfo", "utf8")
  let totalKb: number | null = null
  let availableKb: number | null = null
  for (const line of text.split("\n")) {
    if (line.startsWith("MemTotal:")) totalKb = Number(line.split(/\s+/)[1])
    if (line.startsWith("MemAvailable:")) availableKb = Number(line.split(/\s+/)[1])
  }
  if (totalKb === null || availableKb === null || !Number.isFinite(totalKb) || !Number.isFinite(availableKb)) {
    return null
  }
  return { totalKb, availableKb }
}

function sampleSystem(): void {
  try {
    const stat = readProcStat()
    const mem = readMemInfo()
    const load1 = Number.parseFloat(readFileSync("/proc/loadavg", "utf8").split(" ")[0] ?? "")
    if (!stat || !mem || !Number.isFinite(load1)) {
      throw new Error("unexpected /proc format")
    }
    let cpu = 0 // first sample: warming (delta needs a previous frame)
    if (prevCpu) {
      const dTotal = stat.total - prevCpu.total
      const dIdle = stat.idle - prevCpu.idle
      cpu = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0
    }
    prevCpu = stat
    systemRing.push({
      t: Date.now(),
      cpu: Math.min(100, Math.max(0, cpu)),
      load1,
      memUsed: (mem.totalKb - mem.availableKb) * 1024,
      memTotal: mem.totalKb * 1024,
    })
    systemOk = true
    systemError = null
  } catch (err) {
    systemOk = false
    systemError = errMsg(err)
  }
}

// ---------------------------------------------------------------------------
// gpu loop — long-lived nvidia-smi -l 2 child (§2.3)

const GPU_QUERY_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
]
const GPU_APPS_ARGS = ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"]

let gpuBackoffMs = 30_000 // doubling to max 300 s; reset after 5 min stable
let gpuStableSince: number | null = null
let gpuRowBuf: string
let gpuPendingRows: GpuInfo[]
let gpuLastRowIndex: number
let gpuParseWarned = false

function resetGpuParseState(): void {
  gpuRowBuf = ""
  gpuPendingRows = []
  gpuLastRowIndex = -1
  gpuParseWarned = false
}

function splitCsv(line: string): string[] {
  // nvidia-smi quotes fields containing commas; split on '", "' when present
  const sep = line.includes('", "') ? '", "' : ", "
  return line.split(sep).map((f) => f.trim().replace(/^"|"$/g, ""))
}

function parseGpuLine(line: string): GpuInfo | null {
  const f = splitCsv(line)
  if (f.length < 7) return null
  const index = Number(f[0])
  if (!Number.isFinite(index)) return null
  const num = (s: string | undefined): number => {
    const n = Number(s)
    if (!Number.isFinite(n)) {
      gpuParseWarned = true // NaN → 0 + flag (never synthesize a row)
      return 0
    }
    return n
  }
  return {
    index,
    name: f[1] ?? "unknown",
    utilGpu: num(f[2]),
    memUsed: num(f[3]),
    memTotal: num(f[4]),
    tempGpu: num(f[5]),
    powerDraw: num(f[6]),
  }
}

function flushGpuRows(): void {
  if (gpuPendingRows.length > 0) {
    gpuRing.push({ t: Date.now(), gpus: gpuPendingRows })
    gpuPendingRows = []
  }
  if (gpuParseWarned) {
    gpuError = "nvidia-smi csv had non-numeric fields (coerced to 0)"
    gpuParseWarned = false
  } else if (gpuOk) {
    gpuError = null
  }
}

function onGpuUnavailable(reason: string): void {
  gpuSource = "unavailable"
  gpuOk = false
  gpuError = reason
  gpuChild = null
  // nvidia-smi is not installed — stop retrying (§2.3)
}

function scheduleGpuRespawn(): void {
  if (gpuRespawnTimer || gpuSource === "unavailable") return
  gpuRespawnTimer = setTimeout(() => {
    gpuRespawnTimer = null
    startGpuLoop()
  }, gpuBackoffMs)
  gpuBackoffMs = Math.min(gpuBackoffMs * 2, 300_000)
}

function startGpuLoop(): void {
  resetGpuParseState()
  let child: ChildProcess
  try {
    child = spawn("nvidia-smi", [...GPU_QUERY_ARGS, "-l", "2"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    onGpuUnavailable(`nvidia-smi spawn failed: ${errMsg(err)}`)
    return
  }
  gpuChild = child
  gpuStableSince = Date.now()
  gpuSource = "nvidia-smi"

  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    gpuRowBuf += chunk
    let nl: number
    while ((nl = gpuRowBuf.indexOf("\n")) >= 0) {
      const line = gpuRowBuf.slice(0, nl).trim()
      gpuRowBuf = gpuRowBuf.slice(nl + 1)
      if (!line) continue
      const info = parseGpuLine(line)
      if (!info) continue
      // a row index ≤ the previous one starts a new sample block
      if (info.index <= gpuLastRowIndex && gpuPendingRows.length > 0) {
        flushGpuRows()
      }
      gpuLastRowIndex = info.index
      gpuPendingRows.push(info)
    }
    gpuOk = true
    // flush the newest block promptly instead of waiting for the next one
    if (gpuFlushTimer) clearTimeout(gpuFlushTimer)
    gpuFlushTimer = setTimeout(() => {
      gpuFlushTimer = null
      flushGpuRows()
    }, 1500)
  })

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      onGpuUnavailable("nvidia-smi not installed")
    } else {
      gpuOk = false
      gpuError = `nvidia-smi error: ${err.message}`
      scheduleGpuRespawn()
    }
  })

  child.on("exit", (code) => {
    gpuChild = null
    if (gpuFlushTimer) {
      clearTimeout(gpuFlushTimer)
      gpuFlushTimer = null
    }
    // stable ≥ 5 min → reset the backoff ladder (§2.3)
    if (gpuStableSince && Date.now() - gpuStableSince > 5 * 60_000) {
      gpuBackoffMs = 30_000
    }
    gpuStableSince = null
    gpuOk = false
    gpuError = `nvidia-smi exited (code ${code ?? "signal"}) — respawning`
    scheduleGpuRespawn()
  })
}

function sampleComputeApps(): void {
  // one-shot every 30 s — cannot be combined with `-l` across drivers (§2.3)
  let child: ChildProcess
  try {
    child = spawn("nvidia-smi", GPU_APPS_ARGS, { stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    onGpuUnavailable(`nvidia-smi spawn failed: ${errMsg(err)}`)
    return
  }
  let out = ""
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
  })
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") onGpuUnavailable("nvidia-smi not installed")
  })
  child.on("close", (code) => {
    if (code !== 0) return // keep last good computeApps
    const apps: ComputeApp[] = []
    for (const line of out.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const f = splitCsv(trimmed)
      const pid = Number(f[0])
      // used_memory carries a unit suffix ("70388 MiB") — parse the leading number
      const mem = Number.parseFloat(f[2] ?? "")
      if (!Number.isFinite(pid) || !f[1]) continue
      apps.push({ pid, name: f[1], memUsedMiB: Number.isFinite(mem) ? mem : 0 })
    }
    computeApps = apps
  })
}

// ---------------------------------------------------------------------------
// llm loops — /health (timed) + /props

async function probeHealth(): Promise<void> {
  const ctl = new AbortController()
  const timeout = setTimeout(() => ctl.abort(), 2000)
  const t0 = performance.now()
  try {
    const res = await fetch(`${LLM_URL}/health`, { signal: ctl.signal })
    const latencyMs = performance.now() - t0
    let status: string | null = null
    try {
      const body = (await res.json()) as { status?: unknown }
      if (typeof body.status === "string") status = body.status
    } catch {
      // non-JSON body — treat by HTTP status below
    }
    const prev = llmStatus
    llmLatencyMs = latencyMs
    if (res.ok && status === "ok") {
      llmStatus = "ok"
      llmOk = true
      llmError = null
      if (prev !== "ok") void fetchProps() // recovery → refresh props now
    } else {
      llmStatus = "starting" // server up but not ready (e.g. model loading)
      llmOk = false
      llmError = `HTTP ${res.status}${status ? ` (status: ${status})` : ""}`
    }
    llmRing.push({ t: Date.now(), status: llmStatus, latencyMs })
  } catch (err) {
    llmOk = false
    llmStatus = "unreachable"
    llmLatencyMs = null
    llmError =
      err instanceof Error && err.name === "AbortError"
        ? "timed out (2 s)"
        : errMsg(err)
    llmRing.push({ t: Date.now(), status: "unreachable", latencyMs: null })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchProps(): Promise<void> {
  try {
    const res = await fetch(`${LLM_URL}/props`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const p = (await res.json()) as Record<string, unknown>
    const gen = (p.default_generation_settings ?? {}) as Record<string, unknown>
    const build = p.build_info
    llmModel = {
      path: typeof p.model_path === "string" ? p.model_path : null,
      alias: typeof p.model_alias === "string" ? p.model_alias : null,
      nCtx: typeof gen.n_ctx === "number" ? gen.n_ctx : null,
      slots: typeof p.total_slots === "number" ? p.total_slots : null,
      build:
        typeof build === "string"
          ? build
          : build !== undefined && build !== null
            ? JSON.stringify(build)
            : null,
      isSleeping: typeof p.is_sleeping === "boolean" ? p.is_sleeping : null,
    }
    propsFetchedAt = Date.now()
  } catch (err) {
    // keep the last good model — ctx math keeps working, flagged via propsStaleMs
    console.warn("[nexus-telemetry] /props fetch failed:", errMsg(err))
  }
}

// ---------------------------------------------------------------------------
// snapshot assembly

function buildSnapshot(): TelemetrySnapshot {
  return {
    now: Date.now(),
    system: {
      ok: systemOk,
      error: systemError,
      samples: systemRing.tail(),
    },
    gpu: {
      ok: gpuOk,
      error: gpuError,
      source: gpuSource,
      computeApps,
      samples: gpuRing.tail(),
    },
    llm: {
      ok: llmOk,
      error: llmError,
      url: LLM_URL,
      status: llmStatus,
      latencyMs: llmLatencyMs,
      model: llmModel,
      propsStaleMs: llmModel && propsFetchedAt !== null ? Date.now() - propsFetchedAt : null,
      samples: llmRing.tail(),
    },
  }
}

function sendJson(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// lifecycle

function startLoops(): void {
  if (started) return
  started = true
  sampleSystem()
  systemTimer = setInterval(sampleSystem, 2000)

  startGpuLoop()
  sampleComputeApps()
  gpuAppsTimer = setInterval(sampleComputeApps, 30_000)

  void probeHealth()
  void fetchProps()
  llmTimer = setInterval(() => void probeHealth(), 5000)
  propsTimer = setInterval(() => void fetchProps(), 60_000)
}

function stopLoops(): void {
  started = false
  for (const t of [systemTimer, gpuAppsTimer, llmTimer, propsTimer, gpuRespawnTimer, gpuFlushTimer]) {
    if (t) clearInterval(t)
  }
  systemTimer = gpuAppsTimer = llmTimer = propsTimer = gpuRespawnTimer = gpuFlushTimer = null
  if (gpuChild) {
    gpuChild.kill("SIGTERM")
    gpuChild = null
  }
}

export function telemetryPlugin(): Plugin {
  return {
    name: "nexus-telemetry",
    apply: "serve", // dev middleware only — vite build never starts the loops
    configureServer(server) {
      startLoops()
      server.middlewares.use("/telemetry", (req, res) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/\/+$/, "") || "/"
        if (req.method !== "GET") {
          res.statusCode = 405
          res.end()
          return
        }
        if (path === "/snapshot") {
          sendJson(res, buildSnapshot())
          return
        }
        if (path === "/llm") {
          sendJson(res, buildSnapshot().llm)
          return
        }
        res.statusCode = 404
        res.end()
      })
      server.httpServer?.once("close", stopLoops)
    },
  }
}
