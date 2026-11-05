// Status rail: AI core, live session token/cost block (mono), server card,
// permission badge placeholder (Phase 3).

import { useIsBusy } from "@/store/selectors"
import { useNexus } from "@/store/nexus"
import type { SessionInfo } from "@/lib/opencode/types"
import { ShieldAlert } from "lucide-react"
import { AiCore, StaticCore } from "./AiCore"
import { TelemetryMini } from "./TelemetryMini"

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function TokenBlock({ session }: { session: SessionInfo }) {
  // session payloads may lack tokens/cost (e.g. bare session.created)
  const t = session.tokens ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <h3 className="mb-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Session
      </h3>
      <dl className="space-y-1 font-mono text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">input</dt>
          <dd>{fmt(t.input ?? 0)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">output</dt>
          <dd>{fmt(t.output ?? 0)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">reasoning</dt>
          <dd>{fmt(t.reasoning ?? 0)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">cache r/w</dt>
          <dd>
            {fmt(t.cache?.read ?? 0)} / {fmt(t.cache?.write ?? 0)}
          </dd>
        </div>
        <div className="flex justify-between border-t border-border/70 pt-1.5">
          <dt className="text-muted-foreground">cost</dt>
          <dd className="font-medium text-foreground">
            ${(session.cost ?? 0).toFixed(4)}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function StatusRail({
  session,
  onOpenPermissions,
}: {
  session: SessionInfo | null
  onOpenPermissions(): void
}) {
  const busy = useIsBusy()
  // primitives only — `connection` changes on every event (liveness stamp)
  const version = useNexus((s) => s.connection.version)
  const hostname = useNexus((s) => s.connection.hostname)
  const url = useNexus((s) => s.connection.url)
  const offline = useNexus((s) => s.connection.status === "offline")
  const pendingPermissions = useNexus((s) => s.pendingPermissions)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-center py-3">
        {offline ? (
          <StaticCore dim />
        ) : (
          <AiCore state={busy ? "thinking" : "idle"} />
        )}
      </div>

      {session ? (
        <TokenBlock session={session} />
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-3 text-xs text-muted-foreground">
          No active session.
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-card p-3">
        <h3 className="mb-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Server
        </h3>
        <dl className="space-y-1 font-mono text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">version</dt>
            <dd>{version ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">host</dt>
            <dd className="truncate">{hostname ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">url</dt>
            <dd className="truncate">{url ?? "—"}</dd>
          </div>
        </dl>
      </div>

      {/* permission inbox: opens the slide-over drawer (SPEC-PHASE3 §5.1) */}
      <button
        type="button"
        onClick={onOpenPermissions}
        className={
          "flex items-center gap-2 rounded-xl border p-3 text-left text-xs transition-colors duration-150 " +
          (pendingPermissions > 0
            ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
            : "border-border/70 bg-card text-muted-foreground hover:bg-secondary/50")
        }
        aria-label="Open permission inbox"
      >
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">
          {pendingPermissions > 0
            ? `${pendingPermissions} permission${pendingPermissions === 1 ? "" : "s"} pending`
            : "Permissions clear"}
        </span>
      </button>

      <TelemetryMini session={session} />

      <div className="mt-auto pt-3 text-center font-mono text-[10px] text-muted-foreground/80">
        nexus · phase 3
      </div>
    </div>
  )
}
