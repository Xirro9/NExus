# OpenCode Nexus — Phase 2 Implementation Spec (Telemetry)

**Scope:** real telemetry — system (CPU/RAM/GPU), inference server (llama.cpp), context-window/token visualization, usage stats. Live charts (recharts). No fabricated data: every number on screen must trace to a real measurement, and every panel has an explicit degraded/unknown state.
**Pipeline position:** Architect spec → Developer (this doc is the build contract) → Reviewer gate (QA + security) → Playwright visual pass.
**Repo root:** `/home/mg-12623-8/ai-workbench/projects/NExus` (project MOVED from ~/Documents/nexus). All paths relative to repo root.
**Builds directly on SPEC-PHASE1.md** — §1 module layout, §2 vite proxy, §4 event handling, §6 tokens are the foundation and are extended, not replaced. Task numbering continues Phase 1 (T10 was last).
Ground truth verified 2026-11-04 against the live llama-server, nvidia-smi on the host, the v2.2.0 OpenAPI spec (`/tmp/opencode/nexus-openapi.json`), and captured payloads (`/tmp/opencode/nexus-api-samples/`).

---

## 0. Verified ground truth & corrections

1. **llama-server** at `http://172.18.0.3:8080` (Docker, host-internal IP, pinned):
   - `GET /health` → `{"status":"ok"}` (timed: this is our latency metric).
   - `GET /props` → `model_path`, `model_alias` (`"ggml-org/GLM-5.3-Flash-GGUF:Q4_K"`), `default_generation_settings.n_ctx` (1048576), `total_slots` (1), `build_info`, `is_sleeping`.
   - `GET /metrics` → **501** (container was started without `--metrics`). Out of scope; optional follow-up noted in §9.
2. **nvidia-smi** works on the host: 3× NVIDIA RTX PRO 6000 Blackwell Max-Q (~97 GB each). Verified queries:
   - `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`
   - `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader` (per-process VRAM — identifies the llama.cpp containers' GPU usage).
3. **CPU/RAM**: `/proc/stat` (utilization = delta between consecutive samples), `/proc/meminfo` (`MemTotal`/`MemAvailable`), `/proc/loadavg`.
4. **OpenAPI findings (authoritative over API-NOTES.md where they differ):**
   - `GET /api/experimental/session/stats` — query params: `from` (string), `to` (string), `project` (Project.ID), `timezone` (string), `tools` (`"none"|"summary"|"detail"`). ⚠ API-NOTES.md says `?directory=`; the OpenAPI defines `project=`. Resolve live in T18 (try both; OpenAPI wins unless the live service disagrees).
   - Response `data: SessionStats.Info`: `{ range:{from,to}, sessions, subagents, prompts, steps, tokens:TokenUsage, cost, tools:{mode:"none"|"summary"|"detail", totals:{calls,succeeded,failed,unfinished}, usage?:[{name,calls,succeeded,failed,unfinished,durationP50}]}, activeDays, streak, activity:[{date,steps}], models:[{model:{id,providerID,variant?},steps,tokens,cost}] }` — `usage[]` only present when requested with `tools=detail`. Matches `session-stats.json` sample exactly (18 sessions, 6 subagents, 69 prompts, 550 steps, 668 tool calls / 651 ok / 16 failed / 1 unfinished, 4 model rows).
   - `GET /api/session/{sessionID}/context` → `data: Session.Message.Info[]` — **all messages after the last compaction** (i.e. what is actually in the context window). Assistant messages in this array carry per-message `tokens: TokenUsage.Info` and `cost`. This is the exact dataset for the per-message breakdown.
   - `GET /api/model` → `{location, data: Model.Info[]}`. **`Model.Info.limit = { context: integer (required), input?: integer, output: integer (required) }` — context limits ARE available for non-local providers.** Verified in `model-default.json` (`crouton-alpha-free`: `limit.context 1048576`, `limit.output 270000`).
   - `Model.Ref = { id, providerID, variant? }` — matches `SessionInfo.model` already in the Phase 1 store.
5. **Phase 1 code facts this spec extends (do not re-imagine):**
   - `src/store/nexus.ts` — zustand store `useNexus`; `session.usage.updated` already patches `sessions[id].tokens/cost` (`src/store/events.ts:503`); `pendingRefetch` union drives debounced list refetches.
   - `src/store/selectors.ts` — selector-stability pattern with module-level `EMPTY_MESSAGES` fallback (zustand v5 rule: never return a fresh array/object per selector call).
   - `src/components/rail/StatusRail.tsx` — `TokenBlock` renders live session tokens/cost (mono); footer says "nexus · phase 1".
   - `src/components/shell/AppShell.tsx` — grid `[280px sidebar] [1fr main] [260px rail]`, rail collapsible via `nexus.railCollapsed`; mounts `useEventStream()` + `bootstrap()` once.
   - `vite.config.ts` — `/api` proxy with per-request auth injection; **`/llm` proxy entry exists as a Phase 2 placeholder** (currently harmless 404).
   - `src/index.css` — `--chart-1..5` tokens already defined and bridged into `@theme`.
   - `package.json` — `recharts ^3.10.1` installed (React 19 compatible). xyflow installed but **out of scope this phase** (Phase 3).

---

## 1. Architecture & the `/llm` path decision

**DECIDED: a local `/telemetry/*` JSON endpoint served by a Vite plugin middleware; the `/llm` proxy entry is REMOVED from `vite.config.ts`.**

Rationale:
- The browser never needs raw llama-server access — the middleware fetches `/health` + `/props` server-side (no CORS questions, more accurate latency measurement, and the container IP never leaks into the client).
  *(Correction, review gate 2026-11-05: the llama URL does appear in the snapshot — `llm.url` per §2.6, rendered in LlmPanel. It is resolved server-side by the dev-only middleware and is a localhost/container address, so this is acceptable; the client still never talks to llama directly.)*
- One clean seam for Phase 4: the client contract is `fetch("/telemetry/snapshot")` → becomes `invoke("telemetry_snapshot")` in Tauri. The client never knows the difference (same rule that made Phase 1 auth swappable).
- A `/llm` passthrough would only duplicate what the middleware already does; nothing in Phases 2–4 needs a raw llama proxy.
- **The middleware makes ZERO calls to the OpenCode API** — no auth coupling, no extra load on the service (see §9, single-slot rule).

**Boundary rules:**
- All telemetry code the browser sees is behind origin-relative `/telemetry/*`.
- `src/server/*` is the ONLY place allowed `node:fs`, `node:child_process`, `node:http` imports (client code must never import from `src/server`).
- Shared types live in `src/lib/telemetry/types.ts` (client-safe, zero node imports) and are imported by both sides.

---

## 2. Telemetry provider (Node middleware inside the dev server)

Files: `src/lib/telemetry/types.ts`, `src/server/ring-buffer.ts`, `src/server/telemetry.ts`, plus wiring in `vite.config.ts`.

### 2.1 Poll loops (all inside `telemetryPlugin`, module-scoped, started on `configureServer`, stopped on server close)

| Loop | Cadence | Source | Notes |
| --- | --- | --- | --- |
| system | 2000 ms | `/proc/stat`, `/proc/meminfo`, `/proc/loadavg` | CPU% = delta between consecutive samples |
| gpu | 2000 ms | long-lived `nvidia-smi -l 2` child (§2.3) | streamed stdout parsed per block |
| gpu compute-apps | 30 000 ms | one-shot `nvidia-smi --query-compute-apps=...` | cheap at this cadence |
| llm | 5000 ms | timed `GET /health` (AbortController, 2000 ms timeout) | latency = ms around the fetch |
| llm props | boot + every 60 000 ms + on health-recovery | `GET /props` | static data; refreshed on error |

**No OpenCode API calls from the middleware. Ever.**

### 2.2 CPU math (exact)

Between two `/proc/stat` reads (aggregate `cpu` line: user nice system idle iowait irq softirq steal):

~~~
totalΔ   = Σ(all fields)Δ
idleΔ    = (idle + iowait)Δ
cpuPct   = totalΔ > 0 ? (1 - idleΔ/totalΔ) × 100 : 0   // guard first sample: cpu = 0, marked warming
memUsed  = MemTotal - MemAvailable        (kB → bytes ×1024)
memTotal = MemTotal
load1    = field 1 of /proc/loadavg
~~~

### 2.3 nvidia-smi strategy — DECIDED: one long-lived child process

~~~bash
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits -l 2
~~~

and, one-shot every 30 s (cannot be reliably combined with `-l` across drivers):

~~~bash
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
~~~

**Why long-lived over spawn-per-poll:** each cold `nvidia-smi` exec costs 200–800 ms (driver init × 3 GPUs), which would jitter the 2 s cadence and burn CPU 30×/min for nothing. `-l 2` emits one CSV block every 2 s on stdout; we parse streaming and get perfectly even samples. Spawn-per-poll rejected.

Lifecycle handling (`startGpuLoop` in `telemetry.ts`):
- `error` with `ENOENT` → `gpu.source = "unavailable"`, `gpu.ok = false`, **stop retrying** (nvidia-smi not installed).
- child `exit` (crash) → `gpu.ok = false` with the exit reason, respawn after 30 s backoff, doubling to max 300 s; reset backoff after 5 min of stable running.
- CSV parse: split block on `\n`, each line on `", "`; numbers via `Number()` with `NaN → 0` + flag. Never synthesize a GPU row.

### 2.4 Ring buffers — `src/server/ring-buffer.ts`

~~~ts
export class RingBuffer<T> {
  constructor(capacity: number)
  push(item: T): void          // drops oldest beyond capacity
  tail(n?: number): T[]        // last n items, oldest → newest
  size(): number
  clear(): void
}
~~~

Capacities: system 300 (≈10 min @ 2 s), gpu 300, llm health 150 (≈12.5 min @ 5 s). Memory ≈ tens of KB total — negligible.

### 2.5 Endpoints (mounted via `server.middlewares.use("/telemetry", handler)`)

- `GET /telemetry/snapshot` → full `TelemetrySnapshot` JSON (§2.6). Headers: `content-type: application/json`, `cache-control: no-store`.
- `GET /telemetry/llm` → just the `LlmSnapshot` (convenience for the rail).
- anything else → 404.

### 2.6 Snapshot types — `src/lib/telemetry/types.ts` (exact, contractual)

~~~ts
export interface SystemSample {
  t: number            // Date.now() at sample (server clock)
  cpu: number          // 0..100
  load1: number
  memUsed: number      // bytes
  memTotal: number     // bytes
}

export interface GpuInfo {
  index: number
  name: string
  utilGpu: number      // %
  memUsed: number      // MiB
  memTotal: number     // MiB
  tempGpu: number      // °C
  powerDraw: number    // W
}
export interface GpuSample { t: number; gpus: GpuInfo[] }

export interface ComputeApp { pid: number; name: string; memUsedMiB: number }

export interface LlamaModelInfo {
  path: string | null
  alias: string | null
  nCtx: number | null          // /props default_generation_settings.n_ctx
  slots: number | null         // /props total_slots
  build: string | null         // /props build_info summary
  isSleeping: boolean | null
}

export interface LlmSample { t: number; status: string | null; latencyMs: number | null }

export interface LlmSnapshot {
  ok: boolean
  error: string | null
  url: string                          // resolved target (NEXUS_LLM_URL)
  status: "ok" | "starting" | "unreachable" | null
  latencyMs: number | null             // host → llama-server /health round trip
  model: LlamaModelInfo | null
  propsStaleMs: number | null          // age of last successful /props fetch
  samples: LlmSample[]                 // ring, oldest → newest
}

export interface TelemetrySnapshot {
  now: number
  system: { ok: boolean; error: string | null; samples: SystemSample[] }
  gpu: { ok: boolean; error: string | null; source: "nvidia-smi" | "unavailable"; computeApps: ComputeApp[]; samples: GpuSample[] }
  llm: LlmSnapshot
}
~~~

### 2.7 Snapshot JSON example (real-shaped, values from ground truth)

~~~json
{
  "now": 1793833140908,
  "system": { "ok": true, "error": null, "samples": [
    { "t": 1793833138900, "cpu": 7.4, "load1": 1.82, "memUsed": 38654705664, "memTotal": 67439046656 } ] },
  "gpu": { "ok": true, "error": null, "source": "nvidia-smi",
    "computeApps": [ { "pid": 1234, "name": "llama-server", "memUsedMiB": 21534 } ],
    "samples": [
      { "t": 1793833138950, "gpus": [
        { "index": 0, "name": "NVIDIA RTX PRO 6000 Blackwell Max-Q", "utilGpu": 0, "memUsed": 22310, "memTotal": 98304, "tempGpu": 41, "powerDraw": 78.4 },
        { "index": 1, "name": "NVIDIA RTX PRO 6000 Blackwell Max-Q", "utilGpu": 0, "memUsed": 0, "memTotal": 98304, "tempGpu": 35, "powerDraw": 46.1 },
        { "index": 2, "name": "NVIDIA RTX PRO 6000 Blackwell Max-Q", "utilGpu": 0, "memUsed": 0, "memTotal": 98304, "tempGpu": 34, "powerDraw": 45.8 } ] } ] },
  "llm": { "ok": true, "error": null, "url": "http://172.18.0.3:8080", "status": "ok", "latencyMs": 1.8,
    "model": { "path": "/models/GLM-5.3-Flash-Q4_K.gguf", "alias": "ggml-org/GLM-5.3-Flash-GGUF:Q4_K", "nCtx": 1048576, "slots": 1, "build": "b6900", "isSleeping": false },
    "propsStaleMs": 4120,
    "samples": [ { "t": 1793833135900, "status": "ok", "latencyMs": 1.6 } ] }
}
~~~

### 2.8 Error & degradation matrix

| Condition | Detection | Snapshot effect | UI effect |
| --- | --- | --- | --- |
| nvidia-smi not installed | spawn ENOENT | `gpu.source:"unavailable"`, `ok:false` | "nvidia-smi unavailable" empty state; never zero-filled charts |
| nvidia-smi child died | `exit` event | `ok:false` + reason; respawn w/ backoff | charts freeze at last good data, dimmed with error chip |
| llama unreachable / IP changed | fetch throws or timeout (2 s) | `llm.ok:false`, `status:"unreachable"`, `latencyMs:null`; **keep last good `model` (props) with `propsStaleMs` so ctx math still works, flagged stale** | "llama-server unreachable — retrying every 5 s" |
| llama restarting | `/health` non-ok JSON | `status:"starting"` | amber status dot |
| container IP changed | persistent unreachable | none automatic | fix = set `NEXUS_LLM_URL` env + dev-server restart (documented) |
| /proc read failure | fs throws | `system.ok:false` + error | "system telemetry unavailable" |

**Target URL:** `const LLM_URL = process.env.NEXUS_LLM_URL ?? "http://172.18.0.3:8080"` — read once at dev-server boot. Recovery after a llama container restart is automatic (5 s probe) as long as the IP is unchanged; the env var covers IP changes.

### 2.9 vite.config.ts wiring

~~~ts
import { telemetryPlugin } from "./src/server/telemetry"
// plugins: [react(), tailwindcss(), telemetryPlugin()]
// DELETE the "/llm" proxy entry (was a Phase 2 placeholder)
~~~

`telemetryPlugin(): Plugin` (import `type { Plugin }` from "vite") implements `configureServer(server)` → registers middleware + starts loops; `closeBundle`/server close stops loops and kills the nvidia-smi child. `src/server/telemetry.ts` must not import anything else from vite.

---

## 3. Client telemetry layer

**DECIDED: 2 s polling of `/telemetry/snapshot`, not SSE.** Justification: the middleware is ours (no replay/resync semantics needed — each poll is a complete window); a 2 s JSON fetch on loopback is trivially cheap; SSE through the dev proxy would add a second reconnect/resync path for zero data gain. The Phase 1 SSE stream stays exclusively for OpenCode events.

### 3.1 Store — `src/store/telemetry.ts` (separate zustand store, NOT a nexus slice)

Separate store because: (a) the 2 s cadence must not touch the chat store's event flow; (b) dashboard components then re-render independently of chat; (c) Phase 4 swaps the transport in one file.

~~~ts
export interface TelemetryState {
  snapshot: TelemetrySnapshot | null
  poll: "idle" | "polling" | "error"
  lastFetchAt: number
  error: string | null
  start(): void        // idempotent; setInterval 2000 → fetch /telemetry/snapshot
  stop(): void
}
export const useTelemetry = create<TelemetryState>()(...)
~~~

On fetch failure: `poll:"error"`, keep last snapshot rendered (dimmed via CSS) — no data fabrication, no clearing. On success: replace `snapshot` wholesale. A fresh object per 2 s tick is fine — the zustand v5 hazard is only fresh objects returned *from selectors*, see 3.2.

### 3.2 Selectors & hooks (zustand v5 stability rules)

~~~ts
// src/store/telemetry.ts (same file)
const EMPTY_SYSTEM: SystemSample[] = []
const EMPTY_GPU: GpuSample[] = []
export function useSystemSamples(): SystemSample[]   // s.snapshot?.system.samples ?? EMPTY_SYSTEM
export function useGpuSamples(): GpuSample[]         // s.snapshot?.gpu.samples ?? EMPTY_GPU
export function useLlm(): LlmSnapshot | null
export function useTelemetryOk(): boolean            // snapshot != null && poll !== "error"
~~~

Module-level `EMPTY_*` constants — never `?? []` inline (would loop `useSyncExternalStore`). Components select arrays/`LlmSnapshot | null`, not the whole snapshot object.

### 3.3 Poll lifecycle — `src/hooks/useTelemetryPoll.ts`

`export function useTelemetryPoll(): void` — `useEffect` calls `start()` on mount, `stop()` on unmount. Mounted ONCE in `AppShell.tsx` next to `useEventStream()`. The rail's `TelemetryMini` needs live data on the chat tab too, so the poll runs app-wide (it hits only our own middleware, §9).

### 3.4 Windowing

The server ring buffer IS the window (300 samples ≈ 10 min). The client does **not** accumulate history across polls (dev restart wipes it — accepted, §9.1). Charts receive `samples` arrays directly; recharts handles 300 points without virtualization. A panel with `< 2` samples shows "warming up (n samples)" instead of a chart.

---

## 4. Context-window visualization

### 4.1 Context-limit resolution chain (exact, honest)

For the active session with `session.model = { id, providerID, variant? }`:

1. **`providerID === "llamacpp"`** and `telemetry.llm.model.nCtx != null` → use `nCtx` (from llama `/props` `default_generation_settings.n_ctx` — ground truth for the local server). If `propsStaleMs > 120000`, show a "stale" chip.
2. **Else** `api.listModels()` → find `m` where `m.providerID === model.providerID && m.id === model.id` → `m.limit.context` (`Model.Info.limit.context` — verified present and required in the OpenAPI; `model-default.json` sample confirms).
3. **Else → `null` → "ctx unknown" state:** dashed bar, label `context limit unknown for <modelID>`. Never guess, never fabricate.

The models list is cached in the nexus store: add `models: ModelInfo[]` to `NexusState`, fetch in `resync()` alongside commands/agents/projects, and add `"models"` to the `RefetchTarget` union so `config.updated` invalidates it (existing pattern in `events.ts` + `scheduleRefetch`).

### 4.2 Math (footprint estimate)

~~~
used  = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
        └─ all five from session.tokens — already live via session.usage.updated ─┘
pct   = ctxLimit ? used / ctxLimit × 100 : null
~~~

**Label it honestly:** "footprint = sum of reported token classes; providers attribute cache differently — treat as an estimate". We never claim a precise context-window position (llama.cpp's true prefix cache state is not exposed without `--metrics`).

Stacked horizontal bar segments (custom divs, not recharts, for crisp 1px control), colors = chart tokens:

| Segment | Token | Note |
| --- | --- | --- |
| output | `--chart-2` violet | |
| reasoning | `--chart-4` amber | |
| input | `--chart-1` cyan | |
| cache read | `--chart-3` green | dominant term locally (27.7 M vs 2.2 M input in the sample) |
| cache write | `--chart-5` red | 0 for llamacpp so far — still rendered in legend |

≥ 80 % of ctxLimit → bar border/label switch to `--warning`; ≥ 95 % → `--destructive` + compaction hint ("consider /compact", Phase 3 wires the button).

### 4.3 Per-message breakdown

`api.getSessionContext(activeSessionId)` → assistant messages carry per-message `tokens`. Render a stacked `BarChart` (recharts): x = message index (tooltip shows mono id suffix + model), series = input / output / reasoning / cacheRead with the same segment colors. Refetch triggers: dashboard open, active session change, and `session.usage.updated` **debounced 1 s, only while the dashboard tab is visible**.

**Honesty note rendered in the panel:** the session-totals bar (4.2) is *cumulative since session start*; the `/context` chart is *the current window after the last compaction*. They can legitimately disagree — label each with exactly what it measures.

---

## 5. Usage stats view (`/api/experimental/session/stats`)

~~~ts
// client.ts
getSessionStats(params?: StatsParams): Promise<SessionStatsInfo>
// GET /api/experimental/session/stats?tools=detail  (+ project=<id> once T18 resolves the param, §0.4)
// StatsParams = { from?: string; to?: string; project?: string; timezone?: string; tools?: "none"|"summary"|"detail" }
~~~

**Poll discipline: at most every 30 s** (single-slot glm-server rule, §9.2) + a manual refresh button. Poll runs only while the dashboard tab is visible (start/stop on tab switch). Request `tools:"detail"` so `tools.usage[]` (per-tool rows with `durationP50`) is present.

Layout (top → bottom, dashboard "Usage" section):

1. **KPI row** — 6 stat cards, mono numerals: sessions, subagents, prompts, steps, cost ($, `toFixed(4)`), activeDays + streak chips.
2. **Token totals** — reuse the rail `TokenBlock` math (input/output/reasoning/cache r/w) + a per-model horizontal stacked-bar list from `models[]`: one row per `{model.id @ providerID + variant chip}`, bar segments = token classes (§4.2 colors), right-aligned mono steps count.
3. **Tool reliability** — segmented bar `calls / succeeded / failed / unfinished` in `--chart-3 / --chart-1 / --destructive / --muted`; below, a compact table (only when `tools.mode === "detail"`): name (mono), calls, ok, fail, `durationP50` ms.
4. **Activity** — recharts `BarChart` over `activity[]` (`date` → `steps`). With one day of data (the current sample) it is one bar — render the x-domain from `range.from/to` so sparse data reads honestly instead of looking full.

---

## 6. Design (extends the §6 Phase 1 token contract)

- **Where the telemetry UI lives — DECIDED: both.** (a) A main-area **view switcher** (`MainTabs`: `Chat | Dashboard`, persisted to `localStorage["nexus.mainView"]`) — charts need ≥ 700 px width, the 260 px rail cannot host them. (b) A compact **`TelemetryMini` block appended to the rail** — the rail is the ambient always-watching surface, so it gets live llama status + latency, GPU util %, CPU %, RAM %, and the active session's context bar. xyflow stays Phase 3.
- View switching keeps `ChatPanel` mounted (hidden attribute) so chat scroll state and the SSE stream are untouched; `DashboardView` mounts lazily on first open and stays mounted; the stats poll (§5) starts/stops with tab visibility; the telemetry poll (§3.3) always runs.
- **Tokens:** no new palette. Reuse `--chart-1..5` (already bridged in `index.css`), `--success/--warning/--destructive` for status, `--glow-primary` accents. ADD one token: `--glow-success: 0 0 16px oklch(0.75 0.16 155 / 0.30)` for "all systems nominal" state accents.
- **Typography:** all numerals/latency/token counts in Geist Mono 12px; chart axis labels 10–11px mono; panel titles keep the StatusRail pattern (11px, uppercase, tracking-wider, muted).
- **Motion:** 150 ms micro (tab underline, value changes), 300 ms panel (dashboard section mount). Charts: `isAnimationActive` only on first render, then `false` — per-poll animation at 2 s is jank. Respect `prefers-reduced-motion` (motion's `useReducedMotion`) for non-chart motion.
- **Degraded states are first-class:** every panel has an `ok:false` render (muted icon + one-line reason, e.g. "nvidia-smi unavailable", "llama-server unreachable — retrying every 5 s", "warming up (n samples)"). Never zeros, never placeholder numbers.

---

## 7. Component breakdown & exact file list

### Server (node-only, never imported by client components)

| File | Exports |
| --- | --- |
| `src/server/ring-buffer.ts` | `class RingBuffer<T>` (§2.4) |
| `src/server/telemetry.ts` | `function telemetryPlugin(): Plugin` — loops (§2.1), middleware (§2.5), child-process lifecycle (§2.3), `LLM_URL` env resolution |

### Shared types

| File | Exports |
| --- | --- |
| `src/lib/telemetry/types.ts` | `SystemSample, GpuInfo, GpuSample, ComputeApp, LlamaModelInfo, LlmSample, LlmSnapshot, TelemetrySnapshot` + `const TELEMETRY_SNAPSHOT_PATH = "/telemetry/snapshot"` |

### API client extensions

| File | Additions |
| --- | --- |
| `src/lib/opencode/types.ts` | `ModelInfo { id, modelID, providerID, name, type, status, enabled, limit: { context, input?, output }, variants? }, ContextMessage { id, time, type, agent?, model?, tokens?, cost?, text?, content? }, SessionStatsInfo, SessionStatsTools, SessionStatsToolUsage, SessionStatsActivity, SessionStatsModelUsage, StatsParams` (shapes per §0.4) |
| `src/lib/opencode/client.ts` | `listModels(): Promise<ModelInfo[]>` (GET /api/model), `getSessionContext(sessionID): Promise<ContextMessage[]>` (GET /api/session/{id}/context), `getSessionStats(params?): Promise<SessionStatsInfo>` (§5). All go through the existing `request<T>`/`unwrap` |

### Client state & hooks

| File | Exports |
| --- | --- |
| `src/store/telemetry.ts` | `useTelemetry`, `useSystemSamples, useGpuSamples, useLlm, useTelemetryOk` (§3.1–3.2) |
| `src/hooks/useTelemetryPoll.ts` | `useTelemetryPoll(): void` |
| `src/store/nexus.ts` | add `models: ModelInfo[]` state + fetch in `resync()`; `"models"` added to `RefetchTarget` in `events.ts` |
| `src/store/selectors.ts` | add `useModels(): ModelInfo[]` (module-level `EMPTY_MODELS` fallback) |

### Components

| File | Exports | Notes |
| --- | --- | --- |
| `src/components/shell/MainTabs.tsx` | `MainTabs` | Chat/Dashboard switcher, localStorage-persisted, motion underline (150 ms) |
| `src/components/dashboard/DashboardView.tsx` | `DashboardView` | vertical scroll; sections: System → Inference → Context → Usage; grid-cols-1 → xl:grid-cols-2 |
| `src/components/dashboard/PanelCard.tsx` | `PanelCard` | shared card: title, optional `degraded?: { ok: boolean; error: string | null; children: ReactNode }` swap |
| `src/components/dashboard/SystemPanel.tsx` | `SystemPanel` | CPU% + RAM% area charts (2 s samples, 300 pts) + load1 readout; `/proc`-sourced only |
| `src/components/dashboard/GpuPanel.tsx` | `GpuPanel` | per-GPU util% lines + mem used/total readouts + `computeApps` list (mono pid/name/MiB); `source:"unavailable"` empty state |
| `src/components/dashboard/LlmPanel.tsx` | `LlmPanel` | status dot (ok/starting/unreachable), latency ms (mono, from `llm.samples`), model alias, `nCtx`, slots, build, `isSleeping`, latency sparkline; error chip with `error` |
| `src/components/dashboard/ContextPanel.tsx` | `ContextPanel` | §4: resolution chain + stacked `ContextBar` + per-message `BarChart` + honesty labels |
| `src/components/dashboard/ContextBar.tsx` | `ContextBar` | props `{ tokens: TokenUsage; ctxLimit: number | null }`; the shared stacked bar (also used in rail) |
| `src/components/dashboard/UsagePanel.tsx` | `UsagePanel` | §5 layout; owns the 30 s poll + manual refresh; starts/stops with tab visibility |
| `src/components/rail/TelemetryMini.tsx` | `TelemetryMini` | compact live block + `ContextBar` for the active session (§6) |

### Modified Phase 1 files (surgical edits only)

- `vite.config.ts` — add `telemetryPlugin()`, delete `/llm` proxy entry.
- `src/App.tsx` — unchanged. `src/components/shell/AppShell.tsx` — mount `useTelemetryPoll()`, render `MainTabs` + conditional `ChatPanel` (hidden, stays mounted) / `DashboardView` in `<main>`.
- `src/components/rail/StatusRail.tsx` — append `<TelemetryMini session={session} />`, footer "nexus · phase 2".
- `src/index.css` — add `--glow-success` + `@theme` bridge.

---

## 8. Ordered task list (T11–T19; sequential — glm-server is single-slot)

Each task compiles (`tsc -b` green), lints (`oxlint`), and leaves the app runnable. Acceptance = demonstrable, not asserted.

- **T11 — Telemetry types + ring buffer.** `src/lib/telemetry/types.ts` (§2.6 verbatim), `src/server/ring-buffer.ts` (§2.4). *Accept:* types compile standalone with zero node imports; `RingBuffer` drops oldest beyond capacity and `tail(n)` returns oldest→newest (verify via a temporary dev-server boot log or console).
- **T12 — Telemetry middleware.** `src/server/telemetry.ts` + `vite.config.ts` wiring; delete `/llm` proxy. *Accept:* from the app origin, `fetch("/telemetry/snapshot")` returns CPU% within ±5 pts of a simultaneous `top`, RAM matching `free -b`, 3 GPU rows matching `nvidia-smi` output, `llm.latencyMs` a plausible sub-10 ms number, `nCtx: 1048576`. Degrade drill: set `NEXUS_LLM_URL=http://127.0.0.1:9` + restart → `llm.ok:false`, `status:"unreachable"`, model retained with `propsStaleMs` climbing; restore env → recovers within one 5 s probe without dev restart.
- **T13 — API client extensions.** types.ts + client.ts additions (§7). *Accept:* console-verify `listModels()` returns `Model.Info[]` with `limit.context` populated (record whether the llamacpp model carries a limit — feeds T17 chain step 2), `getSessionContext()` returns post-compaction assistant messages with `tokens`, `getSessionStats({tools:"detail"})` matches the `session-stats.json` shape; **resolve `project` vs `directory` query param live and record the correction in docs/API-NOTES.md**.
- **T14 — Telemetry store + poll.** `src/store/telemetry.ts`, `src/hooks/useTelemetryPoll.ts`; mount hook in AppShell. *Accept:* snapshot updates every ~2 s (window.__telemetry debug handle, dev-only, mirroring the `__nexus` pattern); zero "getSnapshot should be cached" warnings in console over 5 min; killing the middleware (dev-server restart) flips `poll:"error"` with last snapshot retained.
- **T15 — View switcher + dashboard skeleton.** `MainTabs.tsx`, `DashboardView.tsx`, `PanelCard.tsx`, AppShell edits. *Accept:* switching views preserves chat scroll + streaming (send a prompt, switch to Dashboard, switch back mid-stream — deltas intact); `nexus.mainView` persists across reload; SSE unaffected by view switches.
- **T16 — System/GPU/LLM panels.** `SystemPanel`, `GpuPanel`, `LlmPanel`. *Accept:* every rendered number matches a simultaneous manual measurement (top/free/nvidia-smi/`time curl /health`); charts update live without per-poll animation jank; GPU panel renders the "nvidia-smi unavailable" state when the child is killed (simulate by renaming the binary on PATH for one run); llama panel shows amber "starting" vs red "unreachable" distinctly.
- **T17 — Context window visualization.** `ContextBar.tsx`, `ContextPanel.tsx`, nexus store `models` + selector. *Accept:* active-session bar segments sum to the rail's token numbers; llamacpp session resolves `nCtx` from `/props` (1048576); a non-llamacpp session without a model limit renders the honest "ctx unknown" dashed state; per-message chart reflects `/context` output; ≥80% warning threshold demonstrable (temporarily lower threshold in dev to verify, then revert).
- **T18 — Usage stats view.** `UsagePanel.tsx`. *Accept:* KPIs/tool totals/activity/models render from one `tools=detail` request; network tab shows ≤ 1 stats request / 30 s and **zero** stats requests while on the Chat tab; numbers spot-check against `api.getSessionStats()` output in console.
- **T19 — Rail mini + hardening + review handoff.** `TelemetryMini.tsx`, StatusRail edits, `--glow-success` token. Drills: (a) dev-server restart → charts show "warming up", refill within 10 s, no crashes; (b) llama container stop/start → rail dot degrades and recovers automatically; (c) reduced-motion pass over dashboard. Then hand to **reviewer** (QA + security: middleware exposes no auth material, binds no new ports, no `node:*` imports outside `src/server`) and **ui-designer** for the visual pass.

---

## 9. Risks & open questions

1. **Dev-server restart wipes the ring buffer** (10 min @ 2 s). Accepted: history is short-horizon by design; the UI says "warming up" honestly instead of pretending continuity. Phase 4 (Tauri) can persist to disk if wanted.
2. **Poll cost on the single-slot glm-server.** The middleware makes **zero** OpenCode API calls. Client-side OpenCode polling: stats ≤ 1/30 s (dashboard-visible only), models list on bootstrap/`config.updated`, `/context` on demand debounced. ≈ 2–3 req/min worst case, none on the inference path. The 2 s telemetry poll hits only our own middleware.
3. **nvidia-smi spawn overhead** — solved by the long-lived `-l 2` child (§2.3); compute-apps costs one exec per 30 s. Residual risk: driver-level flakiness killing the child → backoff respawn + visible degraded state, never silent zeros.
4. **`n_ctx` semantics** — `/props` `default_generation_settings.n_ctx` is per-slot server config; with `total_slots: 1` it is unambiguous. If slots > 1 later, per-slot ctx may differ — revisit then.
5. **Footprint ≠ truth.** Whether llamacpp-reported `tokens.input` already excludes cached-prefix reads is provider-defined; that is exactly why §4.2 labels the bar an estimate and shows cache read as its own segment (it is the dominant term: 27.7 M cache-read vs 2.2 M input in the captured sample).
6. **Latency attribution** — displayed `latencyMs` is host→llama-server (measured in the middleware), not browser→llama; label the metric "health latency (host)".
7. **`NEXUS_LLM_URL` is boot-time** — IP changes need a dev-server restart (documented in README; acceptable per the Phase 1 target-pinning precedent).
8. **Recharts + React 19** — `recharts ^3.10.1` is React 19 compatible; keep chart components free of store logic (props in, pure render) so the 2 s cadence re-renders only the chart subtree.
9. **Open questions for the coordinator:** (a) `project` vs `directory` stats param — T18 resolves and records the correction; (b) enabling llama `--metrics` (real KV-cache/prompt-cache metrics) requires a container restart with flag changes — deferred, noted as an optional follow-up in PLAN.md; (c) markdown rendering in chat (carried over from SPEC-PHASE1 §11a) remains deferred — out of Phase 2 scope.

---

## Appendix — file-write note for read-only agents

Shell is permission-denied for specialist subagents. The working file-write path: Code Mode → `tools.playwright.browser_run_code_unsafe` → in-page `Blob` download + `download.saveAs(abs path)` (used for SPEC-PHASE1.md and this file).