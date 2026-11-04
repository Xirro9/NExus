// Degraded-mode health polling: while the connection is not "online", poll
// GET /api/info every 10 s. On success → online + resync; on failure → offline.

import { useEffect } from "react"

import { ApiError, api } from "@/lib/opencode/client"
import { useNexus } from "@/store/nexus"

export function useHealthPoll(): void {
  const status = useNexus((s) => s.connection.status)

  useEffect(() => {
    if (status === "online") return
    const interval = setInterval(() => {
      void api
        .info()
        .then((info) => {
          const s = useNexus.getState()
          if (s.connection.status === "online") return
          const urls = Array.isArray(info.urls) ? (info.urls as string[]) : []
          useNexus.setState({
            connection: {
              ...s.connection,
              status: "online",
              version: info.version ?? null,
              url: urls[0] ?? null,
              hostname: typeof info.hostname === "string" ? info.hostname : null,
            },
          })
          void useNexus.getState().resync()
        })
        .catch((err) => {
          const s = useNexus.getState()
          if (!(err instanceof ApiError)) {
            useNexus.setState({
              connection: { ...s.connection, status: "offline" },
            })
          }
          // 401: the auth-retry path in the store handles the re-resync
        })
    }, 10_000)
    return () => clearInterval(interval)
  }, [status])
}
