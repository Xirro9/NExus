// Unit tests for delegation correlation (Phase D3): the parent's `subagent`
// tool call is located via state.metadata.sessionID (live-verified shape).
// Defensive: malformed parts are skipped, never fabricated.

import { describe, expect, it } from "vitest"

import type { ChatMessage, MessagePart, ToolPart } from "@/lib/opencode/types"
import { collectDelegations, findDelegation } from "./delegation"

const CHILD = "ses_child"

function toolPart(
  name: string,
  metadata: Record<string, unknown> | undefined,
  input?: unknown,
): ToolPart {
  return {
    type: "tool",
    id: "tool_1",
    name,
    executed: true,
    state: {
      status: "completed",
      ...(input !== undefined ? { input } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  }
}

function assistantMessage(parts: MessagePart[]): ChatMessage {
  return {
    id: "msg_1",
    sessionID: "ses_parent",
    role: "assistant",
    parts,
    time: { created: 0 },
  }
}

describe("findDelegation", () => {
  const delegation = {
    agent: "reviewer",
    description: "Review the phase D diff",
    prompt: "Review src/components/agents carefully",
  }

  it("finds the subagent call whose metadata.sessionID matches the child", () => {
    const msgs = [
      assistantMessage([
        toolPart("subagent", { sessionID: CHILD, status: "done" }, delegation),
      ]),
    ]
    const d = findDelegation(msgs, CHILD)
    expect(d).not.toBeNull()
    expect(d!.agent).toBe("reviewer")
    expect(d!.description).toBe("Review the phase D diff")
    expect(d!.prompt).toBe("Review src/components/agents carefully")
    expect(d!.toolCallID).toBe("tool_1")
  })

  it("returns null when no call matches the child id", () => {
    const msgs = [
      assistantMessage([
        toolPart("subagent", { sessionID: "ses_other" }, delegation),
      ]),
    ]
    expect(findDelegation(msgs, CHILD)).toBeNull()
  })

  it("returns null for empty messages", () => {
    expect(findDelegation([], CHILD)).toBeNull()
  })

  it("ignores non-subagent tools even when metadata carries a sessionID", () => {
    const msgs = [
      assistantMessage([toolPart("bash", { sessionID: CHILD }, { command: "ls" })]),
    ]
    expect(findDelegation(msgs, CHILD)).toBeNull()
  })

  it("skips malformed parts without throwing", () => {
    const msgs = [
      assistantMessage([
        toolPart("subagent", undefined), // no metadata — pending call
        toolPart("subagent", { sessionID: CHILD }, "not-an-object-input"),
      ]),
    ]
    const d = findDelegation(msgs, CHILD)
    expect(d).not.toBeNull()
    expect(d!.agent).toBeNull()
    expect(d!.description).toBeNull()
    expect(d!.prompt).toBeNull()
  })
})

describe("collectDelegations", () => {
  it("maps child ids to delegations across loaded parents", () => {
    const messages = {
      p1: [
        assistantMessage([
          toolPart("subagent", { sessionID: "c1" }, { description: "task one" }),
        ]),
      ],
      p2: [
        assistantMessage([
          toolPart("subagent", { sessionID: "c2" }, { description: "task two" }),
        ]),
      ],
    }
    const out = collectDelegations(messages, new Set(["p1", "p2"]))
    expect(out.size).toBe(2)
    expect(out.get("c1")!.description).toBe("task one")
    expect(out.get("c2")!.description).toBe("task two")
  })

  it("skips parents whose messages are not loaded", () => {
    const out = collectDelegations({}, new Set(["p1"]))
    expect(out.size).toBe(0)
  })

  it("keeps the FIRST delegation per child and skips malformed entries", () => {
    const messages = {
      p1: [
        assistantMessage([
          toolPart("subagent", undefined), // no child id — skipped
          toolPart("subagent", { sessionID: "c1" }, { description: "first" }),
          toolPart("subagent", { sessionID: "c1" }, { description: "second" }),
        ]),
      ],
    }
    const out = collectDelegations(messages, new Set(["p1"]))
    expect(out.size).toBe(1)
    expect(out.get("c1")!.description).toBe("first")
  })
})
