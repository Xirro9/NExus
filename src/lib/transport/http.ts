// Browser transport — plain fetch + EventSource over origin-relative paths.
// Auth arrives via the Vite dev proxy; byte-identical to the pre-Phase-4 path.

import { connectEvents } from "@/lib/opencode/sse"
import { TELEMETRY_SNAPSHOT_PATH, type TelemetrySnapshot } from "@/lib/telemetry/types"

import type { Transport, TransportRequestInit, TransportResponse } from "./types"

async function request(
  path: string,
  init?: TransportRequestInit,
): Promise<TransportResponse> {
  const headers = { ...init?.headers }
  if (init?.body !== undefined && init.body !== null) {
    headers["content-type"] = headers["content-type"] ?? "application/json"
  }
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined && init.body !== null ? { body: init.body } : {}),
    headers,
  })
  return {
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    // 204 → "" (client.ts checks status before parsing)
    bodyText: res.status === 204 ? "" : await res.text(),
  }
}

export const httpTransport: Transport = {
  request,
  async telemetrySnapshot(): Promise<TelemetrySnapshot> {
    const res = await fetch(TELEMETRY_SNAPSHOT_PATH, { cache: "no-store" })
    if (!res.ok) throw new Error(`telemetry HTTP ${res.status}`)
    return (await res.json()) as TelemetrySnapshot
  },
  connectEvents,
}
