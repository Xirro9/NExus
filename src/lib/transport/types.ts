// Transport contract (SPEC-PHASE4 §2 — verbatim). Two implementations:
// http (browser, dev proxy) and tauri (invoke → Rust commands). The auth
// header is injected Rust-side / proxy-side — NEVER through `headers` here.

import type {
  EventStreamHandle,
  NexusEvent,
  StreamState,
} from "@/lib/opencode/sse"
import type { TelemetrySnapshot } from "@/lib/telemetry/types"

export interface TransportRequestInit {
  method?: string // default "GET"
  body?: string | null // pre-serialized JSON (client.ts already serializes)
  headers?: Record<string, string> // content-type etc. — NEVER "authorization"
}

export interface TransportResponse {
  status: number
  ok: boolean
  /** statusText preserved for ApiError messages (parity with fetch). */
  statusText: string
  bodyText: string // "" for 204
}

export interface Transport {
  request(path: string, init?: TransportRequestInit): Promise<TransportResponse>
  telemetrySnapshot(): Promise<TelemetrySnapshot>
  connectEvents(
    onEvent: (e: NexusEvent) => void,
    onState: (s: StreamState) => void,
  ): EventStreamHandle
}
