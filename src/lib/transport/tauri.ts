// Tauri transport — invoke() into Rust commands + a Channel-fed SSE pump
// (SPEC-PHASE4 §2). The auth header is injected Rust-side; the password never
// enters the webview. HTTP error statuses are RETURNED (client.ts maps them
// to ApiError); IPC failures reject, same as fetch network errors today.

import { Channel, invoke } from "@tauri-apps/api/core"

import type {
  EventStreamHandle,
  NexusEvent,
  StreamState,
} from "@/lib/opencode/sse"
import type { TelemetrySnapshot } from "@/lib/telemetry/types"

import type {
  CreateDirResult,
  GraphifyDetect,
  GraphifyExecResult,
  GraphifyStatus,
  ResearchCollectionSummary,
  ResearchDocumentRecord,
  ResearchReindexResult,
  ResearchSearchResult,
  ResearchStatus,
  Transport,
  TransportRequestInit,
  TransportResponse,
} from "./types"

interface ApiFetchResponse {
  status: number
  body: string
}

// api_fetch returns only the numeric status, so map the common codes for
// ApiError messages ("404 Not Found" instead of a bare "404" in toasts)
const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

async function request(
  path: string,
  init?: TransportRequestInit,
): Promise<TransportResponse> {
  // same default as http.ts — reqwest adds no Content-Type for a raw
  // .body(String), so JSON POSTs would arrive without one Rust-side
  const headers = { ...init?.headers }
  if (init?.body !== undefined && init.body !== null) {
    headers["content-type"] = headers["content-type"] ?? "application/json"
  }
  const res = await invoke<ApiFetchResponse>("api_fetch", {
    args: {
      method: init?.method ?? "GET",
      path,
      headers,
      body: init?.body ?? null,
    },
  })
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    statusText: STATUS_TEXT[res.status] ?? `HTTP ${res.status}`,
    bodyText: res.body,
  }
}

/** Rust StreamFrame (sse_pump.rs): "state" | "event". */
interface StreamFrame {
  kind: string
  state?: string | null
  event?: Record<string, unknown> | null
}

function connectEvents(
  onEvent: (e: NexusEvent) => void,
  onState: (s: StreamState) => void,
): EventStreamHandle {
  const channel = new Channel<StreamFrame>()
  channel.onmessage = (frame) => {
    if (frame.kind === "state") {
      onState(frame.state === "open" ? "open" : "error")
      return
    }
    if (frame.kind !== "event" || !frame.event) return
    // same defaults as sse.ts's EventSource mapping
    const raw = frame.event
    if (typeof raw.type !== "string") return
    const event: NexusEvent = {
      id: typeof raw.id === "string" ? raw.id : null,
      created: typeof raw.created === "number" ? raw.created : Date.now(),
      type: raw.type,
      data: (raw.data ?? {}) as Record<string, unknown>,
      ...(raw.location !== undefined ? { location: raw.location as NexusEvent["location"] } : {}),
    }
    onEvent(event)
  }

  let streamId: number | null = null
  let closed = false
  void invoke<number>("event_stream_start", { channel }).then(
    (id) => {
      if (closed) {
        // unmounted before start resolved — stop the Rust pump immediately
        void invoke("event_stream_stop", { streamId: id }).catch(() => {})
        return
      }
      streamId = id
    },
    (err) => {
      console.warn("[transport] event_stream_start failed", err)
      onState("error")
    },
  )

  return {
    close() {
      closed = true
      if (streamId !== null) {
        void invoke("event_stream_stop", { streamId }).catch(() => {})
      }
    },
  }
}

export const tauriTransport: Transport = {
  request,
  telemetrySnapshot(): Promise<TelemetrySnapshot> {
    return invoke<TelemetrySnapshot>("telemetry_snapshot", { tail: null })
  },
  connectEvents,
  graphifyDetect(): Promise<GraphifyDetect> {
    return invoke("graphify_detect")
  },
  graphifyStatus(cwd: string): Promise<GraphifyStatus> {
    return invoke("graphify_status", { cwd })
  },
  graphifyExec(
    cwd: string,
    args: string[],
  ): Promise<GraphifyExecResult> {
    // whitelist violations reject (Err in Rust) — same channel as IPC failures
    return invoke("graphify_exec", { cwd, args })
  },
  createDir(path: string): Promise<CreateDirResult> {
    // validation rejections come back as Err(String) — a bare string reject,
    // so normalize to Error for readable error toasts (same channel as the
    // other IPC failures)
    return invoke<CreateDirResult>("fs_create_dir", { path }).catch((err) => {
      throw err instanceof Error ? err : new Error(String(err))
    })
  },
  researchStatus(root: string | null): Promise<ResearchStatus> {
    // root null → Rust resolves via RESEARCH_LIBRARY_ROOT (honest error when
    // unset — the desktop app never guesses from cwd)
    return invoke("research_status", { root })
  },
  researchCollections(root: string): Promise<ResearchCollectionSummary[]> {
    return invoke("research_collections", { root })
  },
  researchSearch(
    root: string,
    q: string,
    opts?: { collection?: string; limit?: number; scope?: "all" | "documents" | "sections" },
  ): Promise<ResearchSearchResult> {
    // explicit nulls for absent optionals (telemetry_snapshot { tail: null }
    // precedent) — Rust Option<T> deserializes them as None
    return invoke("research_search", {
      root,
      q,
      collection: opts?.collection ?? null,
      limit: opts?.limit ?? null,
      scope: opts?.scope ?? null,
    })
  },
  researchDocument(
    root: string,
    id: string,
    opts?: { section?: string; maxChars?: number },
  ): Promise<ResearchDocumentRecord | null> {
    // CLI exit 3 (not found) → Ok(None) → null — honest not-found, no throw.
    // maxChars camelCase here maps to the Rust max_chars param (tauri auto-
    // converts camelCase invoke keys to snake_case command args).
    return invoke<ResearchDocumentRecord | null>("research_document", {
      root,
      id,
      section: opts?.section ?? null,
      maxChars: opts?.maxChars ?? null,
    })
  },
  researchReindex(root: string): Promise<ResearchReindexResult> {
    return invoke("research_reindex", { root })
  },
}
