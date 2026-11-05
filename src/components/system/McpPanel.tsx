// MCP servers panel (SPEC-PHASE3 §8.1): one row per server with a status dot.
// Read-only — no connect/disconnect affordances (§13).

import type { McpServerInfo } from "@/lib/opencode/types"

const STATUS_STYLE: Record<
  McpServerInfo["status"]["status"],
  { dot: string; label: string; cls: string }
> = {
  connected: { dot: "bg-success", label: "connected", cls: "text-success" },
  pending: { dot: "bg-muted-foreground nexus-live", label: "pending", cls: "text-muted-foreground" },
  disabled: { dot: "bg-muted-foreground/50", label: "disabled", cls: "text-muted-foreground/70" },
  failed: { dot: "bg-destructive", label: "failed", cls: "text-destructive" },
  needs_auth: { dot: "bg-destructive", label: "needs auth", cls: "text-destructive" },
}

export function McpPanel({ servers }: { servers: McpServerInfo[] | null }) {
  if (servers === null) {
    return <p className="text-xs text-muted-foreground">Loading MCP servers…</p>
  }
  if (servers.length === 0) {
    return <p className="text-xs text-muted-foreground">No MCP servers configured.</p>
  }
  return (
    <ul className="space-y-1.5">
      {servers.map((s) => {
        const style = STATUS_STYLE[s.status.status]
        return (
          <li
            key={s.name}
            className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-card px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={"size-2 shrink-0 rounded-full " + style.dot} aria-hidden />
              <span className="truncate text-[13px]">{s.title ?? s.name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
              {s.integrationID && (
                <span className="text-muted-foreground/70">{s.integrationID}</span>
              )}
              <span className={style.cls}>{style.label}</span>
            </span>
          </li>
        )
      })}
      {servers.map((s) =>
        (s.status.status === "failed" || s.status.status === "needs_auth") &&
        s.status.error ? (
          <li key={s.name + "-err"} className="text-[11px] break-words text-destructive">
            {s.name}: {s.status.error}
          </li>
        ) : null,
      )}
    </ul>
  )
}
