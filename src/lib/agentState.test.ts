// Unit tests for agent run-state derivation (§B1) and the reducer's
// activity summary path. applyEvent is pure, so the store-level behavior
// (bleed guard, prune-on-delete, cap) is tested without a live store.

import { describe, expect, it } from "vitest"

import { applyEvent, PENDING_TOOL_NAMES_CAP } from "@/store/events"
import type { NexusState } from "@/store/nexus"
import type { NexusEvent } from "@/lib/opencode/sse"
import type { SessionInfo } from "@/lib/opencode/types"
import {
  appendFilesTouched,
  appendRecentTools,
  deriveAgentState,
  FILES_TOUCHED_CAP,
  RECENT_TOOLS_CAP,
  type AgentStateInput,
} from "./agentState"

// ---------------------------------------------------------------------------
// helpers

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  created = 1_000,
): NexusEvent {
  return { id: null, created, type, data }
}

function makeSession(id: string): SessionInfo {
  return {
    id,
    projectID: "proj_1",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 0, updated: 0 },
    location: {},
  }
}

/** Minimal runtime-complete state for the pure reducer (actions omitted —
 *  the reducer never calls them; the cast is test-scope only). */
function makeState(): NexusState {
  return {
    connection: {
      status: "online",
      version: null,
      lastEventAt: 0,
      url: null,
      hostname: null,
    },
    syncGeneration: 0,
    sessions: {},
    sessionOrder: [],
    activeSessionId: null,
    messages: {},
    busy: {},
    activity: {},
    pendingToolNames: {},
    commands: [],
    agents: [],
    projects: [],
    models: [],
    defaultModel: null,
    activeProjectId: null,
    toast: null,
    priorities: {},
    pendingReconcile: null,
    pendingRefetch: [],
    pendingPermissions: 0,
    permissionRequests: [],
  } as unknown as NexusState
}

const SID = "ses_target" // a NON-active session — exercises the summary path

function apply(state: NexusState, ...events: NexusEvent[]): NexusState {
  let s = state
  for (const e of events) s = applyEvent(s, e)
  return s
}

// ---------------------------------------------------------------------------
// deriveAgentState — pure mapping rules

describe("deriveAgentState", () => {
  const base: AgentStateInput = {
    busy: false,
    outcome: null,
    permissionOpen: false,
    lastActivityKind: null,
  }

  it("open permission wins over everything", () => {
    expect(
      deriveAgentState({ ...base, busy: true, permissionOpen: true }),
    ).toBe("awaiting-permission")
    expect(
      deriveAgentState({
        ...base,
        busy: true,
        permissionOpen: true,
        lastActivityKind: "tool",
      }),
    ).toBe("awaiting-permission")
  })

  it("busy + recent tool call → executing-tools", () => {
    expect(
      deriveAgentState({ ...base, busy: true, lastActivityKind: "tool" }),
    ).toBe("executing-tools")
  })

  it("busy + recent text/reasoning delta → generating", () => {
    expect(
      deriveAgentState({ ...base, busy: true, lastActivityKind: "text" }),
    ).toBe("generating")
  })

  it("busy with nothing streamed yet → generating (a run in progress is never idle)", () => {
    expect(deriveAgentState({ ...base, busy: true })).toBe("generating")
  })

  it("terminal outcomes map to completed/failed/interrupted", () => {
    expect(deriveAgentState({ ...base, outcome: "succeeded" })).toBe("completed")
    expect(deriveAgentState({ ...base, outcome: "failed" })).toBe("failed")
    expect(deriveAgentState({ ...base, outcome: "interrupted" })).toBe(
      "interrupted",
    )
  })

  it("no signals → idle", () => {
    expect(deriveAgentState(base)).toBe("idle")
  })
})

// ---------------------------------------------------------------------------
// appendFilesTouched — dedupe + cap

describe("appendFilesTouched", () => {
  it("appends new paths, most recent last", () => {
    expect(appendFilesTouched(["/a"], ["/b"])).toEqual(["/a", "/b"])
  })

  it("dedupes within and across batches", () => {
    expect(appendFilesTouched(["/a"], ["/a", "/b"])).toEqual(["/a", "/b"])
    expect(appendFilesTouched([], [])).toEqual([])
  })

  it("caps at FILES_TOUCHED_CAP keeping the most recent", () => {
    const all = Array.from({ length: 30 }, (_, i) => `/f${i}`)
    let files: string[] = []
    for (const f of all) files = appendFilesTouched(files, [f])
    expect(files.length).toBe(FILES_TOUCHED_CAP)
    expect(files[0]).toBe(`/f${30 - FILES_TOUCHED_CAP}`)
    expect(files[files.length - 1]).toBe("/f29")
  })
})

// ---------------------------------------------------------------------------
// appendRecentTools — order + cap

describe("appendRecentTools", () => {
  it("appends by reference, most recent last", () => {
    expect(appendRecentTools([], "bash", 1_000)).toEqual([
      { name: "bash", at: 1_000 },
    ])
    expect(appendRecentTools([{ name: "bash", at: 1_000 }], "edit", 1_100))
      .toEqual([
        { name: "bash", at: 1_000 },
        { name: "edit", at: 1_100 },
      ])
  })

  it("caps at RECENT_TOOLS_CAP keeping the most recent", () => {
    let tools: ReturnType<typeof appendRecentTools> = []
    for (let i = 0; i < RECENT_TOOLS_CAP + 10; i++) {
      tools = appendRecentTools(tools, `tool_${i}`, i)
    }
    expect(tools.length).toBe(RECENT_TOOLS_CAP)
    expect(tools[0]).toEqual({ name: "tool_10", at: 10 })
    expect(tools[tools.length - 1]).toEqual({
      name: `tool_${RECENT_TOOLS_CAP + 9}`,
      at: RECENT_TOOLS_CAP + 9,
    })
  })
})

// ---------------------------------------------------------------------------
// summary path via applyEvent — runs for ALL sessions

describe("activity summary path", () => {
  it("tool.called on a NON-active session updates activity, never messages", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "edit",
        input: { path: "/src/a.ts" },
      }),
    )
    const a = state.activity[SID]!
    expect(a.currentTool).toBe("edit")
    expect(a.currentToolSince).toBe(1_000)
    expect(a.toolsRun).toBe(1)
    expect(a.filesTouched).toEqual(["/src/a.ts"])
    expect(a.lastActivityKind).toBe("tool")
    expect(a.state).toBe("idle") // not busy — tool call alone is not a run
    // cross-session bleed guard: no message content materialized
    expect(state.messages[SID]).toBeUndefined()
  })

  it("busy run lifecycle: started → generating, tool → executing-tools, delta → generating", () => {
    const state = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 1_000),
      makeEvent("session.text.delta", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "hello",
      }, 1_100),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "bash",
        input: { command: "ls" },
      }, 1_200),
    )
    expect(state.activity[SID]!.state).toBe("executing-tools")
    expect(state.activity[SID]!.toolsRun).toBe(1)
    // bleed guard: the delta content must NOT be stored for a non-active session
    expect(state.messages[SID]).toBeUndefined()
  })

  it("execution.started resets run-scoped counters", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "bash",
        input: {},
      }, 1_000),
      makeEvent("session.execution.started", { sessionID: SID }, 2_000),
    )
    const a = state.activity[SID]!
    expect(a.toolsRun).toBe(0)
    expect(a.currentTool).toBeNull()
    expect(a.lastError).toBeNull()
    expect(a.state).toBe("generating")
    expect(a.lastEventAt).toBe(2_000)
  })

  it("execution ending events override the stale session outcome", () => {
    // session record still carries an old "succeeded" — the ending event wins
    const seeded = makeState()
    seeded.sessions[SID] = { ...makeSession(SID), outcome: "succeeded" }
    const state = apply(
      seeded,
      makeEvent("session.execution.started", { sessionID: SID }, 1_000),
      makeEvent("session.execution.failed", { sessionID: SID }, 2_000),
    )
    expect(state.activity[SID]!.state).toBe("failed")
  })

  it("execution.succeeded/interrupted map to terminal states", () => {
    const done = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 1_000),
      makeEvent("session.execution.succeeded", { sessionID: SID }, 2_000),
    )
    expect(done.activity[SID]!.state).toBe("completed")
    const stopped = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 1_000),
      makeEvent("session.execution.interrupted", { sessionID: SID }, 2_000),
    )
    expect(stopped.activity[SID]!.state).toBe("interrupted")
  })

  it("execution ending events clear a stale currentTool label", () => {
    // a mid-tool interrupt/fail must not leave the tool name hanging in the UI
    for (const ending of [
      "session.execution.interrupted",
      "session.execution.failed",
      "session.execution.succeeded",
    ] as const) {
      const state = apply(
        makeState(),
        makeEvent("session.execution.started", { sessionID: SID }, 1_000),
        makeEvent("session.tool.called", {
          sessionID: SID,
          assistantMessageID: "msg_1",
          id: "tool_1",
          name: "bash",
          input: { command: "sleep 100" },
        }, 1_100),
        makeEvent(ending, { sessionID: SID }, 1_200),
      )
      const a = state.activity[SID]!
      expect(a.currentTool).toBeNull()
      expect(a.currentToolSince).toBeNull()
      expect(a.lastEventAt).toBe(1_200)
    }
  })

  it("tool failure records lastError when the event carries text", () => {
    const state = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 1_000),
      makeEvent("session.tool.failed", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        content: [{ type: "text", text: "boom: no such file" }],
      }, 1_500),
    )
    expect(state.activity[SID]!.lastError).toBe("boom: no such file")
    expect(state.activity[SID]!.currentTool).toBeNull()
  })

  it("permission.asked → awaiting-permission; replied clears the flag", () => {
    const asked = apply(
      makeState(),
      makeEvent("permission.asked", { sessionID: SID }, 1_000),
    )
    expect(asked.activity[SID]!.state).toBe("awaiting-permission")
    const replied = apply(
      asked,
      makeEvent("permission.replied", { sessionID: SID }, 1_100),
    )
    expect(replied.activity[SID]!.state).toBe("idle")
  })

  it("edit tool.success metadata.files feed filesTouched (deduped)", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "edit",
        input: { path: "/src/a.ts" },
      }, 1_000),
      makeEvent("session.tool.success", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        metadata: {
          files: [
            { file: "/src/a.ts", patch: "…" },
            { file: "/src/b.ts", patch: "…" },
          ],
        },
      }, 1_100),
    )
    expect(state.activity[SID]!.filesTouched).toEqual(["/src/a.ts", "/src/b.ts"])
  })

  it("filesTouched caps at 20 keeping the most recent", () => {
    let state = makeState()
    for (let i = 0; i < 25; i++) {
      state = apply(
        state,
        makeEvent("session.tool.called", {
          sessionID: SID,
          assistantMessageID: "msg_1",
          id: `tool_${i}`,
          name: "write",
          input: { path: `/f${i}` },
        }, 1_000 + i),
      )
    }
    const files = state.activity[SID]!.filesTouched
    expect(files.length).toBe(20)
    expect(files[0]).toBe("/f5")
    expect(files[files.length - 1]).toBe("/f24")
  })

  it("recentTools accumulates on a NON-active session (summary path, refs only)", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "edit",
        input: { path: "/src/a.ts", SECRET_TOOL_INPUT: "do not store" },
      }, 1_000),
      makeEvent("session.tool.success", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }],
      }, 1_100),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_2",
        name: "bash",
        input: {},
      }, 1_200),
    )
    const a = state.activity[SID]!
    expect(a.recentTools).toEqual([
      { name: "edit", at: 1_000 },
      { name: "bash", at: 1_200 },
    ])
    // field-scoped guarantee: references ONLY — no tool input/output text
    const refs = JSON.stringify(a.recentTools)
    expect(refs).not.toContain("SECRET")
    expect(refs).not.toContain("/src/a.ts")
    // and the bleed guard still holds: no message path ran
    expect(state.messages[SID]).toBeUndefined()
  })

  it("recentTools caps at 25 keeping the most recent", () => {
    let state = makeState()
    for (let i = 0; i < 30; i++) {
      state = apply(
        state,
        makeEvent("session.tool.called", {
          sessionID: SID,
          assistantMessageID: "msg_1",
          id: `tool_${i}`,
          name: `tool_${i}`,
          input: {},
        }, 1_000 + i),
      )
    }
    const tools = state.activity[SID]!.recentTools
    expect(tools.length).toBe(RECENT_TOOLS_CAP)
    expect(tools[0]).toEqual({ name: "tool_5", at: 1_005 })
    expect(tools[tools.length - 1]).toEqual({ name: "tool_29", at: 1_029 })
  })

  it("execution.started resets run-scoped counters but keeps the session-wide recentTools", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "bash",
        input: {},
      }, 1_000),
      makeEvent("session.execution.started", { sessionID: SID }, 2_000),
    )
    const a = state.activity[SID]!
    // run-scoped: reset
    expect(a.toolsRun).toBe(0)
    expect(a.currentTool).toBeNull()
    // session-wide recency (like filesTouched): kept
    expect(a.recentTools).toEqual([{ name: "bash", at: 1_000 }])
  })

  it("subagent calls touch no files", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "subagent",
        input: { agent: "architect", description: "spec", prompt: "…" },
      }, 1_000),
    )
    expect(state.activity[SID]!.filesTouched).toEqual([])
    expect(state.activity[SID]!.currentTool).toBe("subagent")
  })

  it("the ACTIVE session gets both paths: message parts AND activity", () => {
    const seeded = makeState()
    seeded.activeSessionId = SID
    const state = apply(
      seeded,
      makeEvent("session.execution.started", { sessionID: SID }, 800),
      makeEvent("session.step.started", {
        sessionID: SID,
        assistantMessageID: "msg_1",
      }, 900),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "read",
        input: { path: "/src/a.ts" },
      }, 1_000),
    )
    // active: the guarded full path ran (sessionID matches activeSessionId)
    const msg = state.messages[SID]?.find((m) => m.id === "msg_1")
    expect(msg?.parts.some((p) => p.type === "tool" && p.name === "read")).toBe(true)
    expect(state.activity[SID]!.state).toBe("executing-tools")
  })

  it("session.deleted prunes the activity entry", () => {
    const seeded = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "tool_1",
        name: "bash",
        input: {},
      }, 1_000),
    )
    expect(seeded.activity[SID]).toBeDefined()
    const pruned = apply(
      seeded,
      makeEvent("session.deleted", { sessionID: SID }, 2_000),
    )
    expect(pruned.activity[SID]).toBeUndefined()
  })

  it("events without a sessionID leave activity untouched", () => {
    const state = apply(
      makeState(),
      makeEvent("config.updated", {}),
      makeEvent("server.connected", {}),
    )
    expect(state.activity).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// pendingToolNames correlation — the LIVE wire format (opencode v2.2.5 SSE
// capture): session.tool.input.started is the ONLY event carrying the tool
// name; tool.called / .success / .failed carry just the tool-call id.
// Fixtures below use the REAL captured shapes, not the legacy synthetic ones.

describe("pendingToolNames correlation (live wire format)", () => {
  it("WIRE FORMAT: input.started {id,name} → tool.called {id,input,NO name} resolves on a NON-active session", () => {
    const state = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 900),
      // real capture: { sessionID, assistantMessageID, id, name }
      makeEvent("session.tool.input.started", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "s2sbox_call_1",
        name: "shell",
      }, 1_000),
      // real capture: { sessionID, id, delta } — no assistantMessageID
      makeEvent("session.tool.input.delta", {
        sessionID: SID,
        id: "s2sbox_call_1",
        delta: "{\"command\":\"ls\"}",
      }, 1_050),
      // real capture: { sessionID, assistantMessageID, id, input, executed } — NO name
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "s2sbox_call_1",
        input: { command: "ls" },
        executed: false,
      }, 1_100),
    )
    const a = state.activity[SID]!
    expect(a.currentTool).toBe("shell")
    expect(a.currentToolSince).toBe(1_100)
    expect(a.toolsRun).toBe(1)
    expect(a.lastActivityKind).toBe("tool")
    expect(a.recentTools).toEqual([{ name: "shell", at: 1_100 }])
    expect(a.state).toBe("executing-tools")
    // correlation slice: reference only (no input payload)
    expect(state.pendingToolNames["s2sbox_call_1"]).toEqual({
      name: "shell",
      sessionID: SID,
      at: 1_000,
    })
    // bleed guard: the summary path never materialized message content
    expect(state.messages[SID]).toBeUndefined()
  })

  it("tool.success resolves via the correlation, then CLEARS the entry", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.input.started", {
        sessionID: SID,
        id: "call_1",
        name: "edit",
      }, 1_000),
      // real capture: { sessionID, assistantMessageID, id, content, metadata } — NO name
      makeEvent("session.tool.success", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "ok" }],
        metadata: { files: [{ file: "/src/b.ts" }] },
      }, 1_100),
    )
    expect(state.pendingToolNames["call_1"]).toBeUndefined()
    // metadata file extraction still worked with the resolved name
    expect(state.activity[SID]!.filesTouched).toEqual(["/src/b.ts"])
    // a later called with the SAME id now resolves unknown — no fabrication
    const again = apply(
      state,
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        input: {},
        executed: false,
      }, 1_200),
    )
    const a = again.activity[SID]!
    expect(a.toolsRun).toBe(1) // the unknown-name called still bumped it
    expect(a.currentTool).toBeNull()
    expect(a.recentTools).toEqual([])
  })

  it("tool.failed also clears the pending correlation entry", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.input.started", {
        sessionID: SID,
        id: "call_1",
        name: "bash",
      }, 1_000),
      makeEvent("session.tool.failed", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "boom" }],
      }, 1_100),
    )
    expect(state.pendingToolNames["call_1"]).toBeUndefined()
    expect(state.activity[SID]!.lastError).toBe("boom")
  })

  it("unknown-name called (no input.started seen): real signals bump, nothing fabricated", () => {
    const state = apply(
      makeState(),
      makeEvent("session.execution.started", { sessionID: SID }, 900),
      // real capture shape — no name anywhere before this
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_never_started",
        input: { command: "SECRET_INPUT" },
        executed: false,
      }, 1_000),
    )
    const a = state.activity[SID]!
    // real signals still recorded
    expect(a.toolsRun).toBe(1)
    expect(a.lastActivityKind).toBe("tool")
    expect(a.state).toBe("executing-tools")
    // nothing fabricated
    expect(a.currentTool).toBeNull()
    expect(a.currentToolSince).toBeNull()
    expect(a.recentTools).toEqual([])
    expect(a.filesTouched).toEqual([])
  })

  it("a pending entry for a DIFFERENT session is never resolved (sessionID guard)", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.input.started", {
        sessionID: "ses_other",
        id: "call_1",
        name: "edit",
      }, 1_000),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        input: { path: "/etc/passwd" },
        executed: false,
      }, 1_100),
    )
    const a = state.activity[SID]!
    expect(a.currentTool).toBeNull()
    expect(a.recentTools).toEqual([])
    expect(a.filesTouched).toEqual([])
    expect(a.toolsRun).toBe(1)
  })

  it("legacy shape (name directly on tool.called) still works", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "bash",
        input: { command: "ls" },
      }, 1_000),
    )
    const a = state.activity[SID]!
    expect(a.currentTool).toBe("bash")
    expect(a.toolsRun).toBe(1)
    expect(a.recentTools).toEqual([{ name: "bash", at: 1_000 }])
    // no correlation was needed — none recorded
    expect(state.pendingToolNames["call_1"]).toBeUndefined()
  })

  it("pendingToolNames caps at 256, evicting the OLDEST by timestamp", () => {
    let state = makeState()
    for (let i = 0; i < PENDING_TOOL_NAMES_CAP + 4; i++) {
      state = apply(
        state,
        makeEvent("session.tool.input.started", {
          sessionID: SID,
          id: `call_${i}`,
          name: `tool_${i}`,
        }, 1_000 + i),
      )
    }
    const pending = state.pendingToolNames
    expect(Object.keys(pending).length).toBe(PENDING_TOOL_NAMES_CAP)
    expect(pending["call_0"]).toBeUndefined()
    expect(pending["call_3"]).toBeUndefined()
    expect(pending["call_4"]).toBeDefined()
    expect(pending[`call_${PENDING_TOOL_NAMES_CAP + 3}`]).toEqual({
      name: `tool_${PENDING_TOOL_NAMES_CAP + 3}`,
      sessionID: SID,
      at: 1_000 + PENDING_TOOL_NAMES_CAP + 3,
    })
  })

  it("session.deleted prunes that session's pending entries, keeps other sessions'", () => {
    const state = apply(
      makeState(),
      makeEvent("session.tool.input.started", {
        sessionID: SID,
        id: "call_1",
        name: "edit",
      }, 1_000),
      makeEvent("session.tool.input.started", {
        sessionID: "ses_other",
        id: "call_2",
        name: "bash",
      }, 1_010),
      makeEvent("session.deleted", { sessionID: SID }, 1_100),
    )
    expect(state.pendingToolNames["call_1"]).toBeUndefined()
    expect(state.pendingToolNames["call_2"]).toBeDefined()
  })

  it("live wire shapes on the ACTIVE session: message part keeps its name AND activity resolves", () => {
    const seeded = makeState()
    seeded.activeSessionId = SID
    const state = apply(
      seeded,
      makeEvent("session.execution.started", { sessionID: SID }, 900),
      makeEvent("session.step.started", {
        sessionID: SID,
        assistantMessageID: "msg_1",
      }, 950),
      makeEvent("session.tool.input.started", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "shell",
      }, 1_000),
      makeEvent("session.tool.called", {
        sessionID: SID,
        assistantMessageID: "msg_1",
        id: "call_1",
        input: { command: "ls" },
        executed: false,
      }, 1_100),
    )
    // full message path: the part upserted from input.started kept its name
    const msg = state.messages[SID]?.find((m) => m.id === "msg_1")
    expect(msg?.parts.some((p) => p.type === "tool" && p.name === "shell")).toBe(true)
    // summary path: the same correlation resolved the activity label
    expect(state.activity[SID]!.currentTool).toBe("shell")
    expect(state.activity[SID]!.state).toBe("executing-tools")
  })
})
