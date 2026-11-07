// Pure delegation correlation (Phase D3): find the parent's `subagent` tool
// call that spawned a child session. Correlates via the tool part's
// state.metadata.sessionID (live-verified shape — see src/lib/toolDisplay.ts
// and the Phase B notes). Never fabricates: a missing or oddly-shaped call
// yields null / is skipped, and the UI shows an honest empty state.

import type { ChatMessage, MessagePart, ToolPart } from "@/lib/opencode/types"

export interface DelegationInfo {
  /** agent type requested in the delegation input (e.g. "reviewer") */
  agent: string | null
  /** short task summary from the delegation input */
  description: string | null
  /** full prompt handed to the child */
  prompt: string | null
  /** the subagent tool call id (traceability) */
  toolCallID: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function isSubagentCall(part: MessagePart, childSessionID: string): part is ToolPart {
  return (
    part.type === "tool" &&
    part.name.toLowerCase() === "subagent" &&
    asString(part.state?.metadata?.sessionID) === childSessionID
  )
}

function fromToolPart(part: ToolPart): DelegationInfo {
  const input = part.state?.input
  const rec = isRecord(input) ? input : {}
  return {
    agent: asString(rec.agent),
    description: asString(rec.description),
    prompt: asString(rec.prompt),
    toolCallID: part.id,
  }
}

/**
 * The delegation that spawned `childSessionID`, or null when the loaded
 * messages contain no matching subagent tool call (parent history not
 * loaded, or the call sits beyond the fetch window).
 */
export function findDelegation(
  messages: ChatMessage[],
  childSessionID: string,
): DelegationInfo | null {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      if (isSubagentCall(part, childSessionID)) return fromToolPart(part)
    }
  }
  return null
}

/**
 * childSessionID → delegation, collected from every LOADED parent
 * conversation (parents without loaded messages are skipped — no fetching
 * here, callers decide when to load).
 */
export function collectDelegations(
  messages: Record<string, ChatMessage[]>,
  parentIds: ReadonlySet<string>,
): Map<string, DelegationInfo> {
  const out = new Map<string, DelegationInfo>()
  for (const parentId of parentIds) {
    const msgs = messages[parentId]
    if (!msgs) continue
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.name.toLowerCase() !== "subagent") {
          continue
        }
        const child = asString(part.state?.metadata?.sessionID)
        if (child && !out.has(child)) out.set(child, fromToolPart(part))
      }
    }
  }
  return out
}
