// Telemetry store — separate zustand store (SPEC-PHASE2 §3.1): the 2 s poll
// cadence must not touch the chat store's event flow, and dashboard components
// re-render independently of chat. Phase 4 swaps the transport in this file.
//
// zustand v5 rule: selectors below return module-level EMPTY_* constants as
// fallbacks — a fresh [] per selector call would loop useSyncExternalStore.

import { create } from "zustand"

import {
  TELEMETRY_SNAPSHOT_PATH,
  type GpuSample,
  type LlmSnapshot,
  type SystemSample,
  type TelemetrySnapshot,
} from "@/lib/telemetry/types"

const POLL_MS = 2000

export interface TelemetryState {
  snapshot: TelemetrySnapshot | null
  poll: "idle" | "polling" | "error"
  lastFetchAt: number
  error: string | null
  start(): void
  stop(): void
}

// module-scoped timer — never part of state
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

export const useTelemetry = create<TelemetryState>()((set) => ({
  snapshot: null,
  poll: "idle",
  lastFetchAt: 0,
  error: null,

  start() {
    if (timer) return
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(TELEMETRY_SNAPSHOT_PATH, { cache: "no-store" })
        if (!res.ok) throw new Error(`telemetry HTTP ${res.status}`)
        const snapshot = (await res.json()) as TelemetrySnapshot
        // wholesale replace on success — a fresh object per 2 s tick is fine
        // (the v5 hazard is only fresh objects returned FROM selectors)
        set({ snapshot, poll: "polling", lastFetchAt: Date.now(), error: null })
      } catch (err) {
        // keep the last snapshot rendered (dimmed via CSS) — no clearing
        set({
          poll: "error",
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        inFlight = false
      }
    }
    void tick()
    timer = setInterval(() => void tick(), POLL_MS)
  },

  stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },
}))

// ---------------------------------------------------------------------------
// selectors (§3.2) — arrays via module-level constants, primitives only

const EMPTY_SYSTEM: SystemSample[] = []
const EMPTY_GPU: GpuSample[] = []
const EMPTY_COMPUTE: TelemetrySnapshot["gpu"]["computeApps"] = []

export function useSystemSamples(): SystemSample[] {
  return useTelemetry((s) => s.snapshot?.system.samples ?? EMPTY_SYSTEM)
}

export function useGpuSamples(): GpuSample[] {
  return useTelemetry((s) => s.snapshot?.gpu.samples ?? EMPTY_GPU)
}

export function useComputeApps() {
  return useTelemetry((s) => s.snapshot?.gpu.computeApps ?? EMPTY_COMPUTE)
}

export function useLlm(): LlmSnapshot | null {
  return useTelemetry((s) => s.snapshot?.llm ?? null)
}

export function useTelemetryOk(): boolean {
  return useTelemetry((s) => s.snapshot !== null && s.poll !== "error")
}

// dev-only debug handle (T14 acceptance, mirrors the __nexus pattern)
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__telemetry = useTelemetry
}
