// One pending permission request with reply buttons (SPEC-PHASE3 §5.1).
// HARD RULES (reviewer gate §12.1): replies fire ONLY from these explicit
// clicks — no timers, no batch approve, no default-on-timeout, no auto-approve.
// "Always allow" requires a second confirming click on an inline warning;
// the Reject button holds default focus (safest action first).

import { useEffect, useRef, useState } from "react"
import { ShieldAlert } from "lucide-react"

import type { PermissionReply, PermissionRequest } from "@/lib/opencode/types"

const MAX_RESOURCES = 5

export function PermissionCard({
  request,
  sessionTitle,
  onReply,
}: {
  request: PermissionRequest
  sessionTitle: string
  onReply(decision: PermissionReply, message?: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  // armed per-request id: a reply removes the card, so a stale arm can never fire
  const [armedId, setArmedId] = useState<string | null>(null)
  const alwaysArmed = armedId === request.id
  const rejectRef = useRef<HTMLButtonElement>(null)

  // default focus = Reject (safest)
  useEffect(() => {
    rejectRef.current?.focus()
  }, [request.id])

  const visibleResources = expanded
    ? request.resources
    : request.resources.slice(0, MAX_RESOURCES)
  const hiddenCount = request.resources.length - MAX_RESOURCES

  return (
    <div className="rounded-xl border border-warning/40 bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
          {request.action}
        </span>
        <span
          className="max-w-[45%] truncate text-[11px] text-muted-foreground"
          title={sessionTitle}
        >
          {sessionTitle}
        </span>
      </div>

      {request.message && (
        <blockquote className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {request.message}
        </blockquote>
      )}

      {request.resources.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {visibleResources.map((res, i) => (
            <li
              key={i}
              className="break-all font-mono text-[11px] text-foreground/90"
            >
              {res}
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {expanded ? "show less" : `+${hiddenCount} more`}
        </button>
      )}

      {request.source && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/80">
          tool call · message …{request.source.messageID.slice(-6)}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          ref={rejectRef}
          type="button"
          onClick={() => onReply("reject")}
          className="h-8 rounded-lg border border-destructive/50 px-3 text-xs font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onReply("once")}
          className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
        >
          Approve once
        </button>
        {alwaysArmed ? (
          <button
            type="button"
            onClick={() => {
              setArmedId(null)
              onReply("always")
            }}
            onBlur={() => setArmedId(null)}
            className="h-8 rounded-lg border border-warning/60 bg-warning/15 px-3 text-xs font-medium text-warning transition-colors duration-150 hover:bg-warning/25"
          >
            Confirm — always allow
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setArmedId(request.id)}
            className="h-8 rounded-lg border border-border px-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            Always allow…
          </button>
        )}
      </div>
      {alwaysArmed && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Adds a saved rule — future identical requests run without asking.
        </p>
      )}
    </div>
  )
}
