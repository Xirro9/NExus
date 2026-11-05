// List view for the Agents tab (P0): practical monitoring alongside the graph.
// Rows carry checkbox selection (bulk stop/delete), status, Jerry-side
// priority badge, duration, and a per-row End button for running sessions.
// Right-click or the kebab opens the shared session menu.

import { useMemo, useState } from "react"
import { ArrowDownUp, MoreVertical, Square } from "lucide-react"

import {
  DEFAULT_PRIORITY,
  PRIORITY_BADGE,
  priorityRank,
} from "@/lib/sessionPriority"
import type { AgentNode } from "./graph"

export type AgentSort = "priority" | "duration" | "activity"

const STATUS_DOT: Record<AgentNode["status"], string> = {
  running: "bg-primary",
  idle: "bg-muted-foreground/50",
  succeeded: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-warning",
}

function durationMs(n: AgentNode, now: number): number {
  return Math.max(0, (n.updatedAt || now) - n.createdAt)
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function relativeUpdated(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function AgentListView({
  nodes,
  selectedId,
  selectedSet,
  sort,
  onSelectRow,
  onToggleSelected,
  onToggleSelectAll,
  onSetSort,
  onOpenMenu,
  onEnd,
}: {
  nodes: AgentNode[]
  selectedId: string | null
  selectedSet: Set<string>
  sort: AgentSort
  onSelectRow(id: string): void
  onToggleSelected(id: string): void
  onToggleSelectAll(): void
  onSetSort(sort: AgentSort): void
  onOpenMenu(
    e: { clientX: number; clientY: number; preventDefault(): void },
    id: string,
  ): void
  onEnd(id: string): void
}) {
  // re-render cadence: the parent view re-renders on every 5 s poll, so a
  // `now` captured per mount is fresh enough for duration columns
  const [now] = useState(() => Date.now())

  const sorted = useMemo(() => {
    const list = [...nodes]
    list.sort((a, b) => {
      if (sort === "priority") {
        const d = priorityRank(a.priority) - priorityRank(b.priority)
        if (d !== 0) return d
        return b.createdAt - a.createdAt
      }
      if (sort === "duration") {
        return durationMs(b, now) - durationMs(a, now)
      }
      return b.updatedAt - a.updatedAt
    })
    return list
  }, [nodes, sort, now])

  const allSelected = sorted.length > 0 && sorted.every((n) => selectedSet.has(n.id))

  const SortButton = ({ sortKey, label }: { sortKey: AgentSort; label: string }) => (
    <button
      type="button"
      onClick={() => onSetSort(sortKey)}
      className={
        "inline-flex items-center gap-0.5 rounded px-1 py-0.5 uppercase transition-colors duration-150 hover:text-foreground " +
        (sort === sortKey ? "text-primary" : "")
      }
      aria-pressed={sort === sortKey}
      title={`Sort by ${label}`}
    >
      {label}
      {sort === sortKey && <ArrowDownUp className="size-3" aria-hidden />}
    </button>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* header row */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-2 py-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase backdrop-blur">
        <span className="w-4 shrink-0">
          <input
            type="checkbox"
            aria-label="Select all visible sessions"
            checked={allSelected}
            onChange={onToggleSelectAll}
            className="size-3 accent-[var(--primary)]"
          />
        </span>
        <span className="min-w-0 flex-1">Session</span>
        <span className="w-20 shrink-0 text-left">Status</span>
        <span className="w-16 shrink-0 text-left">Priority</span>
        <span className="hidden w-14 shrink-0 text-left sm:block">
          <SortButton sortKey="duration" label="dur" />
        </span>
        <span className="w-16 shrink-0 text-right">
          <SortButton sortKey="activity" label="active" />
        </span>
        <span className="w-14 shrink-0" />
      </div>
      <ul className="divide-y divide-border/40">
        {sorted.map((n) => {
          const checked = selectedSet.has(n.id)
          const showPriority = n.priority !== DEFAULT_PRIORITY
          return (
            <li
              key={n.id}
              onContextMenu={(e) => onOpenMenu(e, n.id)}
              className={
                "group flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors duration-150 " +
                (selectedId === n.id
                  ? "bg-secondary/70"
                  : "hover:bg-secondary/40")
              }
              onClick={() => onSelectRow(n.id)}
            >
              <span
                className="w-4 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={`Select session ${n.title}`}
                  checked={checked}
                  onChange={() => onToggleSelected(n.id)}
                  className="size-3 accent-[var(--primary)]"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{n.title}</span>
                  <span
                    className={
                      "shrink-0 rounded border px-1 font-mono text-[9px] " +
                      (n.agentMode === "subagent"
                        ? "border-accent/50 text-accent"
                        : "border-primary/40 text-primary")
                    }
                  >
                    {n.agent}
                  </span>
                  {n.depth > 0 && (
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                      d{n.depth}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70">
                  …{n.id.slice(-6)}
                </span>
              </span>
              <span className="flex w-20 shrink-0 items-center gap-1.5 text-left">
                <span
                  className={"size-1.5 shrink-0 rounded-full " + STATUS_DOT[n.status]}
                  aria-hidden
                />
                <span className="truncate font-mono text-[10px]">{n.status}</span>
              </span>
              <span className="w-16 shrink-0 text-left">
                {showPriority ? (
                  <span
                    className={
                      "rounded border px-1 font-mono text-[9px] " +
                      PRIORITY_BADGE[n.priority]
                    }
                    title={`Jerry-side priority: ${n.priority} (organizational only)`}
                  >
                    {n.priority}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground/40">—</span>
                )}
              </span>
              <span className="hidden w-14 shrink-0 font-mono text-[10px] text-muted-foreground/70 sm:block">
                {fmtDuration(durationMs(n, now))}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
                {relativeUpdated(n.updatedAt, now)}
              </span>
              <span
                className="flex w-14 shrink-0 items-center justify-end gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                {n.status === "running" && (
                  <button
                    type="button"
                    aria-label={`End session ${n.title}`}
                    title="End session (stop + drop queued prompts)"
                    onClick={() => onEnd(n.id)}
                    className="flex size-6 items-center justify-center rounded-md border border-warning/50 text-warning transition-colors duration-150 hover:bg-warning/15"
                  >
                    <Square className="size-3" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Actions for session ${n.title}`}
                  title="Session actions"
                  onClick={(e) => onOpenMenu(e, n.id)}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground"
                >
                  <MoreVertical className="size-3.5" aria-hidden />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {sorted.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No sessions match the current filters.
        </p>
      )}
    </div>
  )
}
