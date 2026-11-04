// Status rail: AI core, live session token/cost block (mono), server card,
// permission badge placeholder (Phase 3).

import { useConnectionStatus, useIsBusy } from "@/store/selectors"
import { useNexus } from "@/store/nexus"
import type { SessionInfo } from "@/lib/opencode/types"
import { ShieldAlert } from "lucide-react"
import { AiCore, StaticCore } from "./AiCore"

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function TokenBlock({ session }: { session: SessionInfo }) {
  const t = session.tokens
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Session
      </h3>
      <dl className="space-y-1 font-mono text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">input</dt>
          <dd>{fmt(t.input)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">output</dt>
          <dd>{fmt(t.output)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">reasoning</dt>
          <dd>{fmt(t.reasoning)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">cache r/w</dt>
          <dd>
            {fmt(t.cache.read)} / {fmt(t.cache.write)}
          </dd>
        </div>
        <div className="flex justify-between border-t border-border pt-1">
          <dt className="text-muted-foreground">cost</dt>
          <dd>${session.cost.toFixed(4)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function StatusRail({ session }: { session: SessionInfo | null }) {
  const busy = useIsBusy()
  const connection = useConnectionStatus()
  const pendingPermissions = useNexus((s) => s.pendingPermissions)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-center py-2">
        {connection.status === "offline" ? (
          <StaticCore dim />
        ) : (
          <AiCore state={busy ? "thinking" : "idle"} />
        )}
      </div>

      {session ? (
        <TokenBlock session={session} />
      ) : (
        <div className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
          No active session.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-3">
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Server
        </h3>
        <dl className="space-y-1 font-mono text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">version</dt>
            <dd>{connection.version ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">host</dt>
            <dd className="truncate">{connection.hostname ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">url</dt>
            <dd className="truncate">{connection.url ?? "—"}</dd>
          </div>
        </dl>
      </div>

      {/* Phase 3 hook: permission inbox badge */}
      {pendingPermissions > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          {pendingPermissions} permission
          {pendingPermissions === 1 ? "" : "s"} pending
        </div>
      )}

      <div className="mt-auto text-center font-mono text-[10px] text-muted-foreground/60">
        nexus · phase 1
      </div>
    </div>
  )
}
