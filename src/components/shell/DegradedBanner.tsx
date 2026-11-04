// One-line degraded status + retry (§8/§9).

import { useNexus } from "@/store/nexus"
import type { ConnectionStatus } from "@/lib/opencode/types"

const MESSAGES: Record<ConnectionStatus, string> = {
  connecting: "Connecting to OpenCode service…",
  online: "", // banner is not rendered when online
  reconnecting: "Connection lost — reconnecting…",
  offline: "OpenCode service unreachable — retrying",
}

export function DegradedBanner({ status }: { status: ConnectionStatus }) {
  const resync = useNexus((s) => s.resync)
  return (
    <div className="flex items-center justify-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning">
      <span>{MESSAGES[status]}</span>
      <button
        type="button"
        onClick={() => void resync()}
        className="rounded-full border border-warning/40 px-2 py-0.5 font-mono hover:bg-warning/20"
      >
        retry
      </button>
    </div>
  )
}
