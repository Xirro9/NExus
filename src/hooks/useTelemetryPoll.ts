// Poll lifecycle (SPEC-PHASE2 §3.3): start on mount, stop on unmount.
// Mounted ONCE in AppShell next to useEventStream() — the poll hits only our
// own /telemetry middleware, never the OpenCode API, so it runs app-wide.

import { useEffect } from "react"

import { useTelemetry } from "@/store/telemetry"

export function useTelemetryPoll(): void {
  const start = useTelemetry((s) => s.start)
  const stop = useTelemetry((s) => s.stop)

  useEffect(() => {
    start()
    return stop
  }, [start, stop])
}
