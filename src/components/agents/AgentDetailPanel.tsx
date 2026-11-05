// Selected-node facts panel (SPEC-PHASE3 §2.4, right side, 280 px) with the
// "Open in Chat" jump. Read-only facts from the projected node.

import { ArrowRight } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { fmtTokens } from "@/lib/format"
import type { AgentNode } from "./graph"

function humanDuration(ms: number): string {
  if (ms <= 0) return "—"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const OUTCOME_CHIP: Record<AgentNode["status"], string> = {
  running: "text-primary border-primary/50",
  idle: "text-muted-foreground border-border/60",
  succeeded: "text-success border-success/40",
  failed: "text-destructive border-destructive/40",
  interrupted: "text-warning border-warning/40",
}

export function AgentDetailPanel({
  node,
  projectPath,
  onOpenInChat,
}: {
  node: AgentNode
  projectPath: string | null
  onOpenInChat(id: string): void
}) {
  const duration =
    (node.updatedAt || node.createdAt) - node.createdAt
  const reduceMotion = useReducedMotion()
  return (
    <motion.aside
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/70 bg-sidebar p-3"
    >
      <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Agent detail
      </h2>
      <div>
        <p className="text-sm font-medium break-words">{node.title}</p>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span>{node.agent}</span>
          <span className="rounded border border-border/60 px-1 text-[9px]">
            {node.agentMode}
          </span>
          <span className="text-muted-foreground/60">d{node.depth}</span>
        </p>
      </div>
      <dl className="space-y-1.5 rounded-xl border border-border/70 bg-card p-3 font-mono text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">status</dt>
          <dd>
            <span
              className={
                "rounded border px-1.5 py-0.5 text-[10px] " +
                OUTCOME_CHIP[node.status]
              }
            >
              {node.status}
            </span>
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">project</dt>
          <dd className="max-w-[170px] truncate" title={projectPath ?? undefined}>
            {projectPath ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">duration</dt>
          <dd>{humanDuration(duration)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">tokens</dt>
          <dd>{fmtTokens(node.tokens)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">cost</dt>
          <dd>${node.cost.toFixed(4)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">session</dt>
          <dd>…{node.id.slice(-6)}</dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={() => onOpenInChat(node.id)}
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[var(--glow-primary)] transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
      >
        Open in Chat
        <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </motion.aside>
  )
}
