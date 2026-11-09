// Shared small parts for the Research view (T5-UI). Deliberately
// self-contained: Activity/Agents own look-alike helpers (state dots, count
// chips) but those modules are view internals and the research chunk must
// stay one lazy unit — so the tiny pure versions live here with the same
// token treatment as the panels they mirror. Presentational only; no store
// access. (Pure functions + the ticking clock live in researchFmt.ts so this
// file stays components-only under react/only-export-components.)

import type { ResearchSearchHit } from "@/lib/transport/types"

export type ResearchDocStatus = ResearchSearchHit["status"]

/** HistoryView's exact input treatment — the app's one input idiom. */
export const inputClass =
  "h-9 min-w-56 flex-1 rounded-lg border border-border bg-input/60 px-3 text-sm transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60"

// --- chips -------------------------------------------------------------------

const STATUS_TONE: Record<ResearchDocStatus, string> = {
  verified: "border-success/50 text-success",
  cached: "border-border/70 text-muted-foreground",
  stale: "border-warning/60 text-warning",
  superseded: "border-warning/40 text-warning/80",
}

/** Document status chip: verified=positive, cached=neutral, stale/superseded
 *  = warning (dimmer once superseded — a settled state, not a live one). */
export function StatusChip({ status }: { status: ResearchDocStatus }) {
  return (
    <span
      className={
        "shrink-0 rounded border px-1 font-mono text-[9px] " + STATUS_TONE[status]
      }
    >
      {status}
    </span>
  )
}

/** Computed staleness (age beyond the collection TTL) — warning tone. */
export function StaleChip({ ageDays }: { ageDays: number }) {
  return (
    <span className="shrink-0 rounded border border-warning/60 px-1 font-mono text-[9px] text-warning">
      stale · {ageDays}d
    </span>
  )
}

type CountTone = "neutral" | "live" | "warn" | "error"

const COUNT_TONE: Record<CountTone, string> = {
  neutral: "border-border/60 text-muted-foreground",
  live: "border-primary/50 text-primary",
  warn: "border-warning/50 text-warning",
  error: "border-destructive/50 text-destructive",
}

/** Numeric count chip (ActivityView idiom) — quiet at zero. */
export function CountChip({ n, tone = "neutral" }: { n: number; tone?: CountTone }) {
  if (n === 0) return null
  return (
    <span className={"rounded border px-1.5 font-mono text-[10px] " + COUNT_TONE[tone]}>
      {n}
    </span>
  )
}

// --- state dot (researcher rows) ----------------------------------------------

export type RunKind =
  | "running"
  | "awaiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle"

/** Same color semantics as the Activity Center: cyan=live, amber=needs-you,
 *  green=done, red=failed, gray=idle (local copy — activityData is a view
 *  internal; the pulse rides the shared nexus-dot-live keyframe, globally
 *  clamped under prefers-reduced-motion in index.css). */
const DOT_CLASS: Record<RunKind, string> = {
  running: "bg-primary nexus-dot-live",
  awaiting: "bg-warning nexus-dot-live",
  completed: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-warning",
  idle: "bg-muted-foreground/50",
}

export function StateDot({ kind }: { kind: RunKind }) {
  return (
    <span className={"size-1.5 shrink-0 rounded-full " + DOT_CLASS[kind]} aria-hidden />
  )
}

// --- source tally -------------------------------------------------------------

/** Internal-vs-external research tally ("● 3 library · 2 web"). Sides with
 *  zero calls are omitted; an all-zero tally renders nothing — a researcher
 *  session that has run no classified tools yet is honestly blank, never
 *  "0 library · 0 web". */
export function SourceTally({
  internal,
  external,
}: {
  internal: number
  external: number
}) {
  if (internal === 0 && external === 0) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/80">
      <span className="size-1.5 rounded-full bg-primary/80" aria-hidden />
      {internal > 0 && <span className="tabular-nums">{internal} library</span>}
      {internal > 0 && external > 0 && <span aria-hidden>·</span>}
      {external > 0 && <span className="tabular-nums">{external} web</span>}
    </span>
  )
}

// --- placeholders ---------------------------------------------------------------

export function EmptyNote({ label }: { label: string }) {
  return (
    <p className="px-2 py-4 text-center text-xs text-muted-foreground">{label}</p>
  )
}

/** HistoryView's pulse skeleton — one bar pair per row. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          className="animate-pulse rounded-xl border border-border/70 bg-card p-3"
          style={{ animationDelay: `${i * 120}ms`, opacity: 1 - i * 0.15 }}
        >
          <div className="h-3.5 w-2/5 rounded bg-muted" />
          <div className="mt-2.5 h-2.5 w-3/5 rounded bg-muted/70" />
        </li>
      ))}
    </ul>
  )
}
