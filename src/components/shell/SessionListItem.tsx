// One session row: truncated title, relative time, mono id suffix, busy dot.
// Phase 3 (SPEC-PHASE3 §9.1): optional `child` renders an agent chip instead
// of the id suffix (subagent rows); optional `childCount`/`expanded`/
// `onToggleChildren` put a chevron + count badge on a parent row. Existing
// props stay intact. The row is a role="button" div (not a real <button>) so
// the chevron toggle can be a real button without nested-button invalid HTML.

import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react"

import type { SessionInfo } from "@/lib/opencode/types"
import { useWorkspace } from "@/store/workspace"

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function SessionListItem({
  session,
  active,
  busy,
  onSelect,
  child,
  childCount,
  expanded,
  onToggleChildren,
  onContextMenu,
  onActionsClick,
}: {
  session: SessionInfo
  active: boolean
  busy: boolean
  onSelect(id: string): void
  /** child-row mode: show the agent chip instead of the model/id suffix */
  child?: { agent?: string }
  /** parent-row mode: number of nested children (chevron + count badge) */
  childCount?: number
  expanded?: boolean
  onToggleChildren?(): void
  /** right-click → shared session control menu (P0) */
  onContextMenu?(e: { clientX: number; clientY: number; preventDefault(): void }): void
  /** visible kebab → the same menu, for touch/keyboard users (P0) */
  onActionsClick?(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }): void
}) {
  // Running = Jerry's busy signal OR the server-truth active map — busy
  // alone misses server-side running sessions this client hasn't seen busy
  // yet (same rule the Activity view uses). Read-only store subscription;
  // activeMap is a stable store reference (set once per refresh).
  const activeMap = useWorkspace((s) => s.activeMap)
  const running = busy || activeMap?.[session.id] != null
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect(session.id)
        }
      }}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault()
          onContextMenu(e)
        }
      }}
      aria-current={active ? "true" : undefined}
      className={
        "group/row w-full cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors duration-150 " +
        (active
          ? "bg-secondary text-secondary-foreground ring-1 ring-border/60"
          : "hover:bg-secondary/50")
      }
    >
      <div className="flex items-center gap-2">
        {/* dot slot always present so titles never shift when running flips */}
        <span className="flex size-1.5 shrink-0 items-center justify-center">
          {running && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[var(--glow-primary)]" />
          )}
        </span>
        <span
          className={
            "min-w-0 flex-1 truncate text-[13px] " +
            (active ? "font-medium" : "")
          }
        >
          {session.title || "Untitled session"}
        </span>
        {childCount !== undefined && childCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleChildren?.()
            }}
            aria-label={`Toggle ${childCount} subagent session${childCount === 1 ? "" : "s"}`}
            aria-expanded={expanded === true}
            className="flex shrink-0 items-center gap-0.5 rounded px-0.5 font-mono text-[9px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
            {childCount}
          </button>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
          {relativeTime(session.time.updated || session.time.created)}
        </span>
        {onActionsClick && (
          <button
            type="button"
            aria-label={`Actions for session ${session.title || session.id}`}
            title="Session actions"
            onClick={(e) => {
              e.stopPropagation()
              onActionsClick(e)
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <MoreVertical className="size-3" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-0.5 pl-3.5 font-mono text-[10px] text-muted-foreground/80">
        {child ? (
          <span className="rounded border border-border/60 px-1">
            {child.agent ?? "subagent"}
          </span>
        ) : (
          <>…{session.id.slice(-6)}</>
        )}
      </div>
    </div>
  )
}
