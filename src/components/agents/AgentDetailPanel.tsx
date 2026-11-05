// Selected-node facts panel (SPEC-PHASE3 §2.4, right side, 280 px) with the
// "Open in Chat" jump — extended with P0 session control: Jerry-side priority
// selector, End Session / Delete Session / Copy ID, and the queued-prompt
// count for running sessions (real API data, "—" when unknown).

import { useEffect } from "react"
import { ArrowRight, Copy, Square, Trash2 } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import {
  DEFAULT_PRIORITY,
  PRIORITY_BADGE,
  SESSION_PRIORITIES,
} from "@/lib/sessionPriority"
import { fmtTokens } from "@/lib/format"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"
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
  onEnd,
  onDelete,
  onCopy,
}: {
  node: AgentNode
  projectPath: string | null
  onOpenInChat(id: string): void
  onEnd(id: string): void
  onDelete(id: string): void
  onCopy(id: string): void
}) {
  const duration =
    (node.updatedAt || node.createdAt) - node.createdAt
  const reduceMotion = useReducedMotion()

  const inboxCount = useWorkspace((s) => s.inboxCounts[node.id] ?? null)
  const fetchInboxCount = useWorkspace((s) => s.fetchInboxCount)

  // queued prompts are only observable while the session can have them
  useEffect(() => {
    if (node.status === "running") void fetchInboxCount(node.id)
  }, [node.id, node.status, fetchInboxCount])

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
          <dd title={node.id}>…{node.id.slice(-6)}</dd>
        </div>
        {node.status === "running" && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">queued</dt>
            <dd title="Unconsumed prompts in the session inbox (— when unknown)">
              {inboxCount === null ? "—" : String(inboxCount)}
            </dd>
          </div>
        )}
      </dl>

      {/* priority — organizational only, labeled as such */}
      <label className="block rounded-xl border border-border/70 bg-card p-2.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Priority
          </span>
          <span className="font-mono text-[9px] text-muted-foreground/60">
            {node.priority !== DEFAULT_PRIORITY ? (
              <span className={"rounded border px-1 " + PRIORITY_BADGE[node.priority]}>
                {node.priority}
              </span>
            ) : (
              "unset"
            )}
          </span>
        </span>
        <select
          value={node.priority}
          onChange={(e) =>
            useNexus
              .getState()
              .setSessionPriority(node.id, e.target.value as (typeof SESSION_PRIORITIES)[number])
          }
          aria-label="Jerry-side organizational priority (does not affect execution order)"
          className="mt-1.5 h-7 w-full cursor-pointer rounded-lg border border-border bg-input/60 px-1.5 font-mono text-[11px] text-foreground"
        >
          {SESSION_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === DEFAULT_PRIORITY ? " (default)" : ""}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[9px] leading-3 text-muted-foreground/70">
          Jerry-side organization only — OpenCode has no scheduling API.
        </span>
      </label>

      {/* session control */}
      <div className="space-y-1.5">
        {node.status === "running" && (
          <button
            type="button"
            onClick={() => onEnd(node.id)}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-warning/60 px-3 text-sm font-medium text-warning transition-all duration-150 hover:bg-warning/10 active:scale-[0.98]"
          >
            <Square className="size-3.5" aria-hidden />
            End Session
          </button>
        )}
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => onCopy(node.id)}
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60"
            title="Copy the full OpenCode session ID"
          >
            <Copy className="size-3" aria-hidden />
            Copy ID
          </button>
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-destructive/50 px-2 text-xs font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10"
            title="Permanently delete this session and its history"
          >
            <Trash2 className="size-3" aria-hidden />
            Delete…
          </button>
        </div>
      </div>

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
