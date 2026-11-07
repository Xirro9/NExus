// Tree view for the Agents tab (Phase D1 — NEW DEFAULT): plain-DOM indented
// parent → child forest built from the same projection as the graph/list —
// deliberately NO xyflow, so the lazy chunk stays graph-only (§12.3).
//
// Rows carry the established list affordances (checkbox selection, status,
// priority badge, live elapsed, End button, context menu) plus per-node
// expand/collapse (persisted, shared with the graph view's subtree collapse)
// and the parent's delegation task text when that conversation is loaded
// (real data only — the session id stands in when it isn't).
//
// Phase D designer pass: per-level indent guides carry the hierarchy (the
// d{n} badge went away — geometry over annotation), rows are keyboard
// reachable, running rows pulse their status dot (cyan = live), and the
// select-all checkbox shows an honest indeterminate state.

import { useEffect, useMemo, useRef } from "react"
import { ChevronRight, MoreVertical, Square } from "lucide-react"

import {
  DEFAULT_PRIORITY,
  PRIORITY_BADGE,
} from "@/lib/sessionPriority"

import type { AgentNode } from "./graph"
import { fmtDuration, durationMs, STATUS_DOT } from "./AgentListView"
import { treeRows, type TaskText } from "./treeModel"
import { useNow } from "./useNow"

export function AgentTreeView({
  nodes,
  visibleIds,
  taskText,
  collapsed,
  onToggleCollapsed,
  selectedId,
  selectedSet,
  onSelectRow,
  onToggleSelected,
  onSetSelected,
  onOpenMenu,
  onEnd,
}: {
  /** status/priority-filtered nodes (search filtering happens via visibleIds) */
  nodes: AgentNode[]
  /** search matches, or null when no search is active */
  visibleIds: Set<string> | null
  taskText: TaskText
  collapsed: Set<string>
  onToggleCollapsed(id: string): void
  selectedId: string | null
  selectedSet: Set<string>
  onSelectRow(id: string): void
  onToggleSelected(id: string): void
  onSetSelected(ids: string[]): void
  onOpenMenu(
    e: { clientX: number; clientY: number; preventDefault(): void },
    id: string,
  ): void
  onEnd(id: string): void
}) {
  // live tick — elapsed columns stay fresh between the 5 s polls
  const now = useNow(1000)

  const rows = useMemo(
    () => treeRows(nodes, collapsed, visibleIds),
    [nodes, collapsed, visibleIds],
  )
  const rowIds = useMemo(() => rows.map((r) => r.node.id), [rows])
  const allSelected = rows.length > 0 && rows.every((r) => selectedSet.has(r.node.id))
  const someSelected = rows.some((r) => selectedSet.has(r.node.id))

  // indeterminate = "a visible subset is selected" — honest tri-state header
  const allRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected && !allSelected
  }, [someSelected, allSelected])

  const toggleAll = () => {
    if (allSelected) onSetSelected([])
    else onSetSelected(rowIds)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* header row */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-2 py-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase backdrop-blur">
        <span className="w-4 shrink-0">
          <input
            ref={allRef}
            type="checkbox"
            aria-label="Select all visible sessions"
            checked={allSelected}
            onChange={toggleAll}
            className="size-3 accent-[var(--primary)]"
          />
        </span>
        <span className="min-w-0 flex-1">Session</span>
        <span className="w-20 shrink-0 text-left">Status</span>
        <span className="w-16 shrink-0 text-left">Priority</span>
        <span className="hidden w-14 shrink-0 text-left sm:block">dur</span>
        <span className="w-14 shrink-0" />
      </div>
      <ul className="divide-y divide-border/40">
        {rows.map(({ node: n, depth }) => {
          const checked = selectedSet.has(n.id)
          const showPriority = n.priority !== DEFAULT_PRIORITY
          const task = taskText[n.id]
          const hasChildren = nodes.some((x) => x.parentId === n.id)
          const isSelected = selectedId === n.id
          return (
            <li
              key={n.id}
              tabIndex={0}
              aria-label={`${n.title}, ${n.status}${depth > 0 ? `, subagent depth ${depth}` : ""}`}
              onContextMenu={(e) => onOpenMenu(e, n.id)}
              onClick={() => onSelectRow(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelectRow(n.id)
                }
              }}
              className={
                "nexus-row-in group flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50 " +
                (isSelected
                  ? "bg-secondary/70 ring-1 ring-inset ring-primary/25"
                  : "hover:bg-secondary/40")
              }
            >
              {/* indent guides + expand/collapse (parents only) — the guides
                  ARE the hierarchy; no depth badge needed */}
              <span className="flex shrink-0 items-center self-stretch">
                {Array.from({ length: depth }).map((_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    className="h-full w-3.5 border-r border-border/40 transition-colors duration-150 group-hover:border-border/70"
                  />
                ))}
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={
                      collapsed.has(n.id)
                        ? `Expand ${n.title}`
                        : `Collapse ${n.title}`
                    }
                    aria-expanded={!collapsed.has(n.id)}
                    title={collapsed.has(n.id) ? "Expand subtree" : "Collapse subtree"}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleCollapsed(n.id)
                    }}
                    className="ml-0.5 flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                  >
                    <ChevronRight
                      className={
                        "size-3.5 transition-transform duration-150 " +
                        (collapsed.has(n.id) ? "" : "rotate-90")
                      }
                      aria-hidden
                    />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" aria-hidden />
                )}
              </span>
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
                  <span
                    className={
                      "truncate text-xs " +
                      (hasChildren ? "font-semibold" : "font-medium")
                    }
                  >
                    {n.title}
                  </span>
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
                </span>
                <span
                  className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70"
                  title={task ?? n.id}
                >
                  {task ?? `…${n.id.slice(-6)}`}
                </span>
              </span>
              <span className="flex w-20 shrink-0 items-center gap-1.5 text-left">
                <span
                  className={
                    "size-1.5 shrink-0 rounded-full " + STATUS_DOT[n.status] +
                    (n.status === "running" ? " nexus-dot-live" : "")
                  }
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
              <span className="hidden w-14 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70 sm:block">
                {fmtDuration(durationMs(n, now))}
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
                    className="flex size-6 items-center justify-center rounded-md border border-warning/40 text-warning transition-colors duration-150 hover:border-warning/70 hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning/60"
                  >
                    <Square className="size-3" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Actions for session ${n.title}`}
                  title="Session actions"
                  onClick={(e) => onOpenMenu(e, n.id)}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  <MoreVertical className="size-3.5" aria-hidden />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No sessions match the current filters.
        </p>
      )}
    </div>
  )
}
