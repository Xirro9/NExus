// One history row (SPEC-PHASE3 §6): title, project, agent chip, outcome chip,
// duration / tokens / cost mono. No per-session "steps" column — steps are not
// in Session.Info and per-row message fetches would spam the single-slot
// server (honest omission).

import { ArrowUpRight } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { fmtTokens } from "@/lib/format"
import type { SessionInfo } from "@/lib/opencode/types"

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function humanDuration(ms: number): string {
  if (ms <= 0) return "—"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function outcomeChip(session: SessionInfo): { label: string; cls: string } {
  switch (session.outcome) {
    case "succeeded":
      return { label: "succeeded", cls: "text-success border-success/40" }
    case "failed":
      return { label: "failed", cls: "text-destructive border-destructive/40" }
    case "interrupted":
      return { label: "interrupted", cls: "text-warning border-warning/40" }
    default:
      return { label: "open", cls: "text-muted-foreground/70 border-border/60" }
  }
}

export function HistoryCard({
  session,
  onOpen,
}: {
  session: SessionInfo
  onOpen(id: string): void
}) {
  const project = useNexus((s) => s.projects.find((p) => p.id === session.projectID))
  const parent = useNexus((s) =>
    session.parentID ? (s.sessions[session.parentID] ?? null) : null,
  )
  const t = session.tokens
  const tokens = t
    ? (t.input ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0)
    : 0
  const chip = outcomeChip(session)
  const duration =
    (session.time.idle ?? session.time.updated) - session.time.created

  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className="group w-full rounded-xl border border-border/70 bg-card p-3 text-left transition-colors duration-150 hover:border-muted-foreground/40 hover:bg-secondary/40"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {session.title || "Untitled session"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className="font-mono text-[10px] text-muted-foreground/70"
            title={new Date(session.time.updated || session.time.created).toLocaleString()}
          >
            {relativeTime(session.time.updated || session.time.created)}
          </span>
          <span
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${chip.cls}`}
          >
            {chip.label}
          </span>
          <ArrowUpRight
            className="size-3.5 text-muted-foreground/0 transition-colors duration-150 group-hover:text-primary"
            aria-hidden
          />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <span className="max-w-[220px] truncate" title={project?.canonical ?? session.projectID}>
          {project?.canonical ?? session.projectID.slice(0, 12)}
        </span>
        {session.agent && (
          <span className="rounded border border-border/60 px-1 font-mono text-[10px]">
            {session.agent}
          </span>
        )}
        {session.parentID && (
          <span className="text-muted-foreground/80">
            ↳ subagent of {parent?.title ?? `…${session.parentID.slice(-6)}`}
          </span>
        )}
        <span>{humanDuration(duration)}</span>
        <span>{fmtTokens(tokens)} tok</span>
        <span>${(session.cost ?? 0).toFixed(4)}</span>
      </div>
    </button>
  )
}
