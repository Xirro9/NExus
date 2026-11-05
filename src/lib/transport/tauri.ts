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

import type { Transport, TransportRequestInit, TransportResponse } from "./types"

interface ApiFetchResponse {
  status: number
  body: string
}

async function request(
  path: string,
  init?: TransportRequestInit,
): Promise<TransportResponse> {
  const res = await invoke<ApiFetchResponse>("api_fetch", {
    args: {
      method: init?.method ?? "GET",
      path,
      headers: init?.headers ?? {},
      body: init?.body ?? null,
    },
  })
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    statusText: "",
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
}
