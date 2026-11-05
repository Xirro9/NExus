// Four-state connection badge with distinct colors (§8).

import type { ConnectionStatus } from "@/lib/opencode/types"

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  online: "Online",
  reconnecting: "Reconnecting",
  offline: "Offline",
}

export function ConnectionBadge({
  status,
  version,
}: {
  status: ConnectionStatus
  version: string | null
}) {
  const styles: Record<ConnectionStatus, string> = {
    connecting: "border-border text-muted-foreground",
    online: "border-success/40 text-success",
    reconnecting: "border-warning/40 text-warning",
    offline: "border-destructive/50 text-destructive",
  }
  const pulse = status === "connecting" || status === "reconnecting"
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-none whitespace-nowrap " +
        styles[status]
      }
    >
      <span
        className={
          "size-1.5 rounded-full bg-current " + (pulse ? "animate-pulse" : "")
        }
        aria-hidden
      />
      {LABELS[status]}
      {status === "online" && version && (
        <span className="font-mono text-[10px] opacity-80">v{version}</span>
      )}
    </span>
  )
}
