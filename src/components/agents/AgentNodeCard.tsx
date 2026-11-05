// Custom xyflow node (SPEC-PHASE3 §2.4): agent name + mode chip, truncated
// title, status ring, mono token count. Handles top (target) / bottom (source).
// Running = pulsing glow, failed = destructive ring — both silenced under
// prefers-reduced-motion by the global CSS clamp.
//
// P0 session control: right-click (or the ⋮ button) opens the session menu;
// running nodes get a one-click End Session control. Callbacks arrive via the
// node data (injected by AgentGraphCanvas) — the card itself stays store-free.

import { Handle, Position, type NodeProps } from "@xyflow/react"
import { MoreVertical, Square } from "lucide-react"

import {
  DEFAULT_PRIORITY,
  PRIORITY_BADGE,
} from "@/lib/sessionPriority"
import { fmtTokens } from "@/lib/format"
import type { AgentNode } from "./graph"

export type AgentNodeData = AgentNode &
  Record<string, unknown> & {
    /** right-click / kebab → open the session context menu */
    onContextMenu?: (
      e: { clientX: number; clientY: number; preventDefault(): void },
      id: string,
    ) => void
    /** one-click End Session (confirm dialog opens upstream) */
    onEnd?: (id: string) => void
  }

const STATUS_RING: Record<AgentNode["status"], string> = {
  running: "border-primary/70 shadow-[var(--glow-primary)] agent-node-running",
  idle: "border-border/70",
  succeeded: "border-success/50",
  failed: "border-destructive/70",
  interrupted: "border-warning/60",
}

const STATUS_DOT: Record<AgentNode["status"], string> = {
  running: "bg-primary",
  idle: "bg-muted-foreground/50",
  succeeded: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-warning",
}

export function AgentNodeCard({ data, selected }: NodeProps) {
  const node = data as AgentNodeData
  const isSubagent = node.agentMode === "subagent"
  const showPriority = node.priority !== DEFAULT_PRIORITY
  const openMenu = (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) => {
    e.stopPropagation()
    node.onContextMenu?.(e, node.id)
  }
  return (
    <div
      className={
        "group relative w-[200px] rounded-xl border bg-card px-3 py-2.5 transition-shadow " +
        STATUS_RING[node.status] +
        (selected ? " ring-2 ring-ring/70" : "")
      }
      onContextMenu={openMenu}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1.5 !border-0 !bg-muted-foreground/60"
      />
      {/* control cluster — visible on hover/focus, always for touch */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        {node.status === "running" && node.onEnd && (
          <button
            type="button"
            title="End session (stop + drop queued prompts)"
            aria-label={`End session ${node.title}`}
            onClick={(e) => {
              e.stopPropagation()
              node.onEnd?.(node.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex size-5 items-center justify-center rounded-md border border-warning/50 text-warning transition-colors duration-150 hover:bg-warning/15"
          >
            <Square className="size-2.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          title="Session actions"
          aria-label={`Actions for session ${node.title}`}
          onClick={openMenu}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground"
        >
          <MoreVertical className="size-3" aria-hidden />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 pr-9">
        <span className="truncate text-xs font-semibold">{node.agent}</span>
        <span
          className={
            "shrink-0 rounded border px-1 font-mono text-[9px] " +
            (isSubagent
              ? "border-accent/50 text-accent"
              : "border-primary/40 text-primary")
          }
        >
          {node.agentMode}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground">
        {node.title}
      </p>
      <div className="mt-1 flex items-center justify-between gap-1 font-mono text-[10px] text-muted-foreground/80">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={"size-1.5 shrink-0 rounded-full " + STATUS_DOT[node.status]}
            aria-hidden
          />
          <span className="truncate">{node.status}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {showPriority && (
            <span
              className={
                "rounded border px-1 text-[9px] " + PRIORITY_BADGE[node.priority]
              }
              title={`Jerry-side priority: ${node.priority} (organizational only)`}
            >
              {node.priority}
            </span>
          )}
          <span>
            {fmtTokens(node.tokens)} tok · ${node.cost.toFixed(4)}
          </span>
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-1.5 !border-0 !bg-muted-foreground/60"
      />
    </div>
  )
}
