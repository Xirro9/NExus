// Custom xyflow node (SPEC-PHASE3 §2.4): agent name + mode chip, truncated
// title, status ring, mono token count. Handles top (target) / bottom (source).
// Running = pulsing glow, failed = destructive ring — both silenced under
// prefers-reduced-motion by the global CSS clamp.

import { Handle, Position, type NodeProps } from "@xyflow/react"

import { fmtTokens } from "@/lib/format"
import type { AgentNode } from "./graph"

export type AgentNodeData = AgentNode & Record<string, unknown>

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
  return (
    <div
      className={
        "w-[200px] rounded-xl border bg-card px-3 py-2.5 transition-shadow " +
        STATUS_RING[node.status] +
        (selected ? " ring-2 ring-ring/70" : "")
      }
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1.5 !border-0 !bg-muted-foreground/60"
      />
      <div className="flex items-center justify-between gap-2">
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
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground/80">
        <span className="flex items-center gap-1">
          <span
            className={"size-1.5 rounded-full " + STATUS_DOT[node.status]}
            aria-hidden
          />
          {node.status}
        </span>
        <span>
          {fmtTokens(node.tokens)} tok · ${node.cost.toFixed(4)}
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
