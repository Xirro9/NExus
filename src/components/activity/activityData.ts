// Pure Activity Center derivations (Phase E1). No React, no store — the
// ActivityView passes the nexus/workspace slices it already subscribes to
// and this module decides what each section shows.
//
// Real data only: every row traces back to a session record, the busy/
// activeMap running signals, the Phase B per-session activity summary, the
// permission inbox, or the workspace inbox counts. Nothing is inferred
// beyond the state fallback rules shared with deriveAgentState.

import type {
  PermissionRequest,
  ProjectInfo,
  SessionInfo,
} from "@/lib/opencode/types"
import type { AgentRunState, SessionActivity } from "@/lib/agentState"
import {
  DEFAULT_PRIORITY,
  priorityRank,
  type SessionPriority,
} from "@/lib/sessionPriority"

/** A session projected into the Activity Center — one row feeds every section. */
export interface ActivityRow {
  id: string
  title: string
  agent: string
  state: AgentRunState
  /** execution running per Jerry's busy signal OR the server-truth active map */
  running: boolean
  priority: SessionPriority
  createdAt: number
  updatedAt: number
  currentTool: string | null
  toolsRun: number
  lastError: string | null
  /** queued inbox prompts; null = never polled for this session (NOT zero) */
  inboxCount: number | null
  isSubagent: boolean
  parentId: string | null
  projectPath: string | null
}

/** Running subagents grouped under their (resolvable) parent session. */
export interface SubagentGroup {
  parent: ActivityRow
  children: ActivityRow[]
}

export interface ActivityStats {
  activeCount: number
  toolsRunTotal: number
  errorCount: number
  approvalCount: number
  queuedSessionCount: number
  completedCount: number
}

export interface ActivitySnapshot {
  active: ActivityRow[]
  subagentRuns: SubagentGroup[]
  queued: ActivityRow[]
  errors: ActivityRow[]
  completed: ActivityRow[]
  toolActivity: ActivityRow[]
  stats: ActivityStats
}

export interface ActivityInput {
  sessions: Record<string, SessionInfo>
  busy: Record<string, boolean>
  activity: Record<string, SessionActivity>
  priorities: Record<string, SessionPriority>
  activeMap: Record<string, { type: "running" }> | null
  inboxCounts: Record<string, number | null>
  permissionRequests: PermissionRequest[]
  projects: ProjectInfo[]
}

/** Cap on the "completed" list — most recently updated kept. */
export const COMPLETED_CAP = 8

const OUTCOME_STATE: Record<
  NonNullable<SessionInfo["outcome"]>,
  AgentRunState
> = {
  succeeded: "completed",
  failed: "failed",
  interrupted: "interrupted",
}

/** Dot treatment per run state — established color semantics:
 *  cyan (primary) = live, amber (warning) = needs-you/attention,
 *  green (success) = done, red (destructive) = failed. `live` rows pulse
 *  via the shared nexus-dot-live keyframe (global reduced-motion clamp). */
export const ACTIVITY_STATE_DOT: Record<AgentRunState, string> = {
  generating: "bg-primary nexus-dot-live",
  "executing-tools": "bg-primary nexus-dot-live",
  "awaiting-permission": "bg-warning nexus-dot-live",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-warning",
}

/** States deriveAgentState can never return while busy — a running session
 *  carrying one means the stored summary is stale (e.g. "idle" from before
 *  a refetch gap). Running rows fall back to the live derivation instead. */
const TERMINAL_OR_IDLE: ReadonlySet<AgentRunState> = new Set([
  "idle",
  "completed",
  "failed",
  "interrupted",
])

/**
 * Build every Activity Center section from the subscribed slices.
 * Deterministic; sorts are stable in the priority-then-recency sense.
 */
export function buildActivitySnapshot(input: ActivityInput): ActivitySnapshot {
  const projectPaths = new Map(
    input.projects.map((p) => [p.id, p.name || p.canonical]),
  )

  const rows: ActivityRow[] = Object.values(input.sessions).map((s) => {
    const running =
      input.busy[s.id] === true || input.activeMap?.[s.id] != null
    const a = input.activity[s.id]
    // The Phase B summary is authoritative when present (it already folds
    // busy/permission/outcome through deriveAgentState) — EXCEPT on a
    // running session: deriveAgentState never yields a terminal/idle state
    // while busy, so a stored one is stale and the live derivation wins,
    // same semantics (busy + recent tool → executing-tools, else
    // generating). Fallback for quiet sessions: outcome map, else idle.
    const state: AgentRunState = running
      ? a && !TERMINAL_OR_IDLE.has(a.state)
        ? a.state
        : a?.lastActivityKind === "tool"
          ? "executing-tools"
          : "generating"
      : (a?.state ?? (s.outcome ? OUTCOME_STATE[s.outcome] : "idle"))
    return {
      id: s.id,
      title: s.title || "Untitled session",
      agent: s.agent ?? "build",
      state,
      running,
      priority: input.priorities[s.id] ?? DEFAULT_PRIORITY,
      createdAt: s.time.created,
      updatedAt: s.time.updated,
      currentTool: a?.currentTool ?? null,
      toolsRun: a?.toolsRun ?? 0,
      lastError: a?.lastError ?? null,
      inboxCount: input.inboxCounts[s.id] ?? null,
      isSubagent: s.parentID != null,
      parentId: s.parentID ?? null,
      projectPath: projectPaths.get(s.projectID) ?? null,
    }
  })

  const byId = new Map(rows.map((r) => [r.id, r]))

  // priority rank, then most recent activity (Jerry-side priority is
  // organizational ONLY — same ordering rule as the Agents list)
  const byPriorityThenRecency = (a: ActivityRow, b: ActivityRow): number => {
    const d = priorityRank(a.priority) - priorityRank(b.priority)
    return d !== 0 ? d : b.updatedAt - a.updatedAt
  }

  const active = rows.filter((r) => r.running).sort(byPriorityThenRecency)

  const queued = rows
    .filter((r) => (r.inboxCount ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.inboxCount ?? 0) - (a.inboxCount ?? 0) ||
        byPriorityThenRecency(a, b),
    )

  const errors = rows
    .filter((r) => r.lastError !== null || r.state === "failed")
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const completed = rows
    .filter(
      (r) => !r.running && (r.state === "completed" || r.state === "interrupted"),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, COMPLETED_CAP)

  const toolActivity = rows
    .filter((r) => r.currentTool !== null || r.toolsRun > 0)
    .sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1
      return b.updatedAt - a.updatedAt
    })

  // running subagents grouped under their parent record. A child whose
  // parent is gone (deleted mid-run) is skipped: buildGraph promotes
  // orphans to graph roots, but a summary line with no parent title is
  // just noise.
  const groups = new Map<string, ActivityRow[]>()
  for (const r of active) {
    if (r.parentId === null) continue
    const arr = groups.get(r.parentId) ?? []
    arr.push(r)
    groups.set(r.parentId, arr)
  }
  const subagentRuns: SubagentGroup[] = []
  for (const [parentId, children] of groups) {
    const parent = byId.get(parentId)
    if (parent) subagentRuns.push({ parent, children })
  }
  subagentRuns.sort(
    (a, b) =>
      b.children.length - a.children.length ||
      b.parent.updatedAt - a.parent.updatedAt,
  )

  const stats: ActivityStats = {
    activeCount: active.length,
    toolsRunTotal: rows.reduce((sum, r) => sum + r.toolsRun, 0),
    errorCount: errors.length,
    approvalCount: input.permissionRequests.length,
    queuedSessionCount: queued.length,
    completedCount: rows.filter((r) => !r.running && r.state === "completed")
      .length,
  }

  return {
    active,
    subagentRuns,
    queued,
    errors,
    completed,
    toolActivity,
    stats,
  }
}

/** Compact relative age ("now", "4m ago", "3h ago", "2d ago"). Mirrors the
 *  Agents list's private formatter — it is not exported there and this view
 *  must not touch agents/, so the small pure version lives here (tested). */
export function fmtRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
