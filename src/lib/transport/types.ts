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

// --- Graphify CLI bridge (docs/NOTES-SESSIONS-GRAPHIFY.md) -------------------
// Both transports route to a host-side executor (Rust commands in Tauri, the
// Vite dev middleware in the browser) that enforces a strict code-only
// whitelist. Jerry never runs arbitrary commands through this seam.

export interface GraphifyDetect {
  available: boolean
  version: string | null
  path: string | null
}

export interface GraphifyStatus {
  /** graphify-out/graph.json exists in the project */
  found: boolean
  mtimeMs: number | null
  sizeBytes: number | null
  nodeCount: number | null
  edgeCount: number | null
  /** graphify version that built the graph (graph.json header) */
  graphifyVersion: string | null
}

export interface GraphifyExecResult {
  /** process exit code; null when the watchdog killed it */
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

// --- Host filesystem seam (Projects tab "new project") -----------------------
// Both transports route to a host-side directory creator (Rust fs_create_dir
// in Tauri, the Vite dev middleware in the browser) that enforces the same
// absolute-path validation. mkdir ONLY — Jerry never reads or writes files
// through this seam.

export interface CreateDirResult {
  /** canonicalized absolute path (symlinks resolved host-side) */
  path: string
  /** true when the directory already existed (creation is idempotent) */
  existed: boolean
}

export interface Transport {
  request(path: string, init?: TransportRequestInit): Promise<TransportResponse>
  telemetrySnapshot(): Promise<TelemetrySnapshot>
  connectEvents(
    onEvent: (e: NexusEvent) => void,
    onState: (s: StreamState) => void,
  ): EventStreamHandle
  graphifyDetect(): Promise<GraphifyDetect>
  graphifyStatus(cwd: string): Promise<GraphifyStatus>
  graphifyExec(cwd: string, args: string[]): Promise<GraphifyExecResult>
  /** Create a directory (with parents) at an absolute host path. Rejects
   *  empty/relative/NUL/./.. paths; the host side canonicalizes. Not an error
   *  when the directory already exists (existed:true comes back). */
  createDir(path: string): Promise<CreateDirResult>
}
