// One-line degraded status + retry (§8/§9).

import { useNexus } from "@/store/nexus"
import type { ConnectionStatus } from "@/lib/opencode/types"
import { RotateCw, TriangleAlert } from "lucide-react"

const MESSAGES: Record<ConnectionStatus, string> = {
  connecting: "Waking Jerry…",
  online: "", // banner is not rendered when online
  reconnecting: "Connection lost — waking Jerry back up…",
  offline: "Jerry is unreachable — retrying",
}

export function DegradedBanner({ status }: { status: ConnectionStatus }) {
  const resync = useNexus((s) => s.resync)
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2.5 border-b border-warning/25 bg-warning/10 px-4 py-1.5 text-xs text-warning"
    >
      {status === "offline" ? (
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <RotateCw
          className="size-3.5 shrink-0 animate-spin [animation-duration:2.5s]"
          aria-hidden
        />
      )}
      <span>{MESSAGES[status]}</span>
      <button
        type="button"
        onClick={() => void resync()}
        className="rounded-full border border-warning/40 px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-warning/20"
      >
        retry
      </button>
    </div>
  )
}
