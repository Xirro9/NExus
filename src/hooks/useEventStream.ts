// Mounts the SSE stream once, feeds events into the store, drives resync on
// (re)connect per §4. EventSource auto-reconnects; we only track state.

import { useEffect, useRef } from "react"

import { connectEvents, type StreamState } from "@/lib/opencode/sse"
import { useNexus } from "@/store/nexus"

export function useEventStream(): void {
  const wasOpen = useRef(false)

  useEffect(() => {
    const handle = connectEvents(
      (e) => useNexus.getState().applyEvent(e),
      (state: StreamState) => {
        const s = useNexus.getState()
        if (state === "error") {
          // EventSource keeps retrying; surface degraded mode
          if (s.connection.status !== "offline") {
            useNexus.setState({
              connection: { ...s.connection, status: "reconnecting" },
            })
          }
          return
        }
        // "open" — first open or a reconnect after an error → resync
        const firstOpen = !wasOpen.current
        wasOpen.current = true
        const reconnect = s.connection.status === "reconnecting"
        if (firstOpen || reconnect) {
          useNexus.setState({
            connection: { ...s.connection, status: "online" },
          })
          void useNexus.getState().resync()
        }
      },
    )
    return () => handle.close()
  }, [])
}
