// EventSource manager for GET /api/event (SSE).
// Auth comes from the dev proxy; EventSource cannot set headers itself.
// Live-only stream: no replay, no Last-Event-ID resume. EventSource
// auto-reconnects — never close/retry manually here.

import type { LocationRef } from "./types"

export interface NexusEvent {
  id: string | null
  created: number
  type: string
  data: Record<string, unknown>
  location?: LocationRef
}

export type StreamState = "open" | "error"

export interface EventStreamHandle {
  close(): void
}

export function connectEvents(
  onEvent: (e: NexusEvent) => void,
  onState: (s: StreamState) => void,
): EventStreamHandle {
  const source = new EventSource("/api/event")

  source.onopen = () => onState("open")
  source.onerror = () => onState("error")
  source.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as {
        id?: string
        created?: number
        type?: string
        data?: Record<string, unknown>
        location?: LocationRef
      }
      if (!parsed.type) return
      const event: NexusEvent = {
        id: parsed.id ?? null,
        created: parsed.created ?? Date.now(),
        type: parsed.type,
        data: parsed.data ?? {},
        ...(parsed.location !== undefined
          ? { location: parsed.location }
          : {}),
      }
      onEvent(event)
    } catch (err) {
      console.warn("[sse] failed to parse event frame", err)
    }
  }

  return {
    close() {
      source.close()
    },
  }
}
