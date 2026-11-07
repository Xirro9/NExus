// Agent run-state derivation — PURE, telemetry-driven (Phase B, §B1).
//
// No polling, no inference, no fabrication: every state maps to a real
// signal (execution events, tool events, deltas, the permission inbox,
// the session outcome). Callers pass what the last event actually said;
// this module only decides which label fits.

export type AgentRunState =
  | "generating"
  | "executing-tools"
  | "awaiting-permission"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"

/** One recent tool call, by reference: the tool NAME and the event
 *  timestamp ONLY. Never tool input/output text — recentTools must stay
 *  field-scoped like the rest of SessionActivity (bleed guard). */
export interface ToolCallRef {
  name: string
  at: number
}

/** Per-session activity summary maintained by the event reducer's SUMMARY
 *  path (runs for ALL sessions — see events.ts). Field-scoped: it never
 *  accumulates message text or deltas, so the cross-session bleed guard
 *  keeps holding. */
export interface SessionActivity {
  state: AgentRunState
  lastEventAt: number
  /** tool currently executing (from session.tool.called), null when none */
  currentTool: string | null
  /** when the current tool started (event timestamp) */
  currentToolSince: number | null
  /** tool calls issued this execution run (reset on execution.started) */
  toolsRun: number
  /** files observed in real tool inputs/metadata, most recent last, capped */
  filesTouched: string[]
  /** recent tool calls by reference (name + timestamp, most recent last,
   *  capped). Session-wide recency like filesTouched — NOT reset on
   *  execution.started (only run-scoped counters reset), so a session's
   *  recent tools stay visible without loading its messages. */
  recentTools: ToolCallRef[]
  /** error text from a failed tool / failed execution, when the event carries one */
  lastError: string | null
  /** kind of the most recent activity event (drives busy-state refinement) */
  lastActivityKind: "text" | "tool" | "permission" | null
}

export interface AgentStateInput {
  /** session.execution.started seen and not yet ended */
  busy: boolean
  /** terminal outcome — from the session record or the ending event itself */
  outcome: "succeeded" | "failed" | "interrupted" | null
  /** an unresolved permission request exists for this session */
  permissionOpen: boolean
  /** kind of the most recent activity event while busy */
  lastActivityKind: SessionActivity["lastActivityKind"]
}

/**
 * Map real telemetry → run state, in priority order:
 *   1. open permission request        → awaiting-permission
 *   2. busy + last activity was a tool call → executing-tools
 *   3. busy otherwise (text/reasoning deltas, or the run just started
 *      with nothing streamed yet)     → generating
 *   4. terminal outcome               → completed / failed / interrupted
 *   5. else                           → idle
 */
export function deriveAgentState(input: AgentStateInput): AgentRunState {
  if (input.permissionOpen) return "awaiting-permission"
  if (input.busy) {
    return input.lastActivityKind === "tool" ? "executing-tools" : "generating"
  }
  if (input.outcome === "succeeded") return "completed"
  if (input.outcome === "failed") return "failed"
  if (input.outcome === "interrupted") return "interrupted"
  return "idle"
}

/** Cap on the per-session filesTouched list (most recent entries kept). */
export const FILES_TOUCHED_CAP = 20

/** Cap on the per-session recentTools list (most recent entries kept). */
export const RECENT_TOOLS_CAP = 25

/** Append file paths (deduped, most recent last) under the cap. Pure. */
export function appendFilesTouched(
  existing: string[],
  added: string[],
): string[] {
  if (added.length === 0) return existing
  const merged = [...existing, ...added.filter((f) => !existing.includes(f))]
  return merged.slice(-FILES_TOUCHED_CAP)
}

/** Append a tool-call ref (most recent last) under the cap. Pure. */
export function appendRecentTools(
  existing: ToolCallRef[],
  name: string,
  at: number,
): ToolCallRef[] {
  const next = [...existing, { name, at }]
  return next.length > RECENT_TOOLS_CAP ? next.slice(-RECENT_TOOLS_CAP) : next
}
