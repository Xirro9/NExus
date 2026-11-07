// Pure event reducer: applyEvent(state, NexusEvent) → state.
// Switch on e.type; unknown types are ignored (future-proof per §4).
// Chat-delta events for non-active sessions are ignored (cross-session bleed
// guard) — sessions/usage bookkeeping still applies globally.
//
// TWO paths per event (Phase B):
//   1. reduceEvent — the full message path, guarded by sameSession() so
//      non-active sessions NEVER accumulate text/deltas/message content.
//   2. applyActivity — a field-scoped SUMMARY path that runs for ALL
//      sessions (agent-state derivation, current tool, filesTouched).
//      It touches only the `activity` slice — never messages — so the
//      bleed guard keeps holding.

import {
  appendFilesTouched,
  appendRecentTools,
  deriveAgentState,
  type SessionActivity,
} from "@/lib/agentState"
import { extractFilePaths } from "@/lib/toolDisplay"
import type { NexusEvent } from "@/lib/opencode/sse"
import type {
  ChatMessage,
  MessagePart,
  ReasoningPart,
  SessionInfo,
  TextPart,
  ToolPart,
} from "@/lib/opencode/types"
import type { NexusState } from "./nexus"

/** Refetch-list markers (debounced 500 ms by the store wrapper). */
export type RefetchTarget =
  | "commands"
  | "agents"
  | "projects"
  | "sessions"
  | "models"
  | "permissions"
  | "worktrees"
  | "extensions"

function sameSession(state: NexusState, e: NexusEvent): boolean {
  return e.data.sessionID === state.activeSessionId
}

// ---------------------------------------------------------------------------
// activity summary path (Phase B §B1) — runs for ALL sessions

/** Initial activity entry; derived state fills in on the first event. */
function emptyActivity(at: number): SessionActivity {
  return {
    state: "idle",
    lastEventAt: at,
    currentTool: null,
    currentToolSince: null,
    toolsRun: 0,
    filesTouched: [],
    recentTools: [],
    lastError: null,
    lastActivityKind: null,
  }
}

function updateActivity(
  state: NexusState,
  sessionID: string,
  at: number,
  patch: Partial<SessionActivity>,
): NexusState {
  const prev = state.activity[sessionID] ?? emptyActivity(at)
  // "in" check (not ??): an explicit null patch must RESET the kind
  // (execution.started clears a stale "tool", permission.replied clears
  // the event-driven "permission" flag)
  const kind =
    "lastActivityKind" in patch
      ? (patch.lastActivityKind ?? null)
      : prev.lastActivityKind
  const next: SessionActivity = {
    ...prev,
    ...patch,
    lastEventAt: at,
    // derive from real telemetry: busy/outcome as of this event, an
    // authoritative open permission from the inbox, or an event-driven
    // permission flag (permission.asked arrives before the refetch heals
    // the inbox list — cleared on reply or on the next execution run)
    state: deriveAgentState({
      busy: state.busy[sessionID] ?? false,
      outcome: state.sessions[sessionID]?.outcome ?? null,
      permissionOpen:
        state.permissionRequests.some((r) => r.sessionID === sessionID) ||
        kind === "permission",
      lastActivityKind: kind,
    }),
  }
  return { ...state, activity: { ...state.activity, [sessionID]: next } }
}

/** Outcome carried by the execution-ending event itself (the session
 *  record's outcome field only heals on the next sessions refetch). */
function outcomeOverride(e: NexusEvent): "succeeded" | "failed" | "interrupted" {
  if (e.type === "session.execution.failed") return "failed"
  if (e.type === "session.execution.interrupted") return "interrupted"
  return "succeeded"
}

/** Error text from a failed tool/execution event, only when a string is
 *  actually present (content parts carry {type, text} — verified shape). */
function errorText(data: Record<string, unknown>): string | null {
  if (typeof data.error === "string" && data.error) return data.error
  if (Array.isArray(data.content)) {
    for (const part of data.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        const text = (part as Record<string, unknown>).text as string
        if (text) return text
      }
    }
  }
  return null
}

/**
 * SUMMARY path — field-scoped activity updates for ALL sessions. Never
 * touches `messages`: for non-active sessions this records only labels,
 * timestamps, tool names, tool-call references, and file paths extracted
 * from real tool inputs/metadata. The cross-session bleed guard lives in
 * reduceEvent.
 */
function applyActivity(state: NexusState, e: NexusEvent): NexusState {
  const data = e.data
  const { sessionID } = data as { sessionID?: unknown }
  if (typeof sessionID !== "string") return state
  const at = e.created
  switch (e.type) {
    case "session.execution.started":
      // new run: reset run-scoped counters (filesTouched and recentTools
      // accumulate session-wide — recent lists, not run logs)
      return updateActivity(state, sessionID, at, {
        currentTool: null,
        currentToolSince: null,
        toolsRun: 0,
        lastError: null,
        lastActivityKind: null,
      })
    case "session.text.delta":
    case "session.reasoning.delta":
      // kind label only — NEVER the delta content (bleed guard)
      return updateActivity(state, sessionID, at, { lastActivityKind: "text" })
    case "session.tool.called": {
      const { name, input } = data as { name?: unknown; input?: unknown }
      if (typeof name !== "string") return state
      const prev = state.activity[sessionID]
      return updateActivity(state, sessionID, at, {
        currentTool: name,
        currentToolSince: at,
        toolsRun: (prev?.toolsRun ?? 0) + 1,
        lastActivityKind: "tool",
        filesTouched: appendFilesTouched(
          prev?.filesTouched ?? [],
          extractFilePaths(name, input, undefined),
        ),
        // reference only (name + timestamp) — never the input payload
        recentTools: appendRecentTools(prev?.recentTools ?? [], name, at),
      })
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const { name, metadata } = data as {
        name?: unknown
        metadata?: Record<string, unknown>
      }
      const prev = state.activity[sessionID]
      const patch: Partial<SessionActivity> = {
        currentTool: null,
        currentToolSince: null,
        filesTouched: appendFilesTouched(
          prev?.filesTouched ?? [],
          extractFilePaths(name, undefined, metadata),
        ),
      }
      if (e.type === "session.tool.failed") {
        patch.lastError = errorText(data)
      }
      return updateActivity(state, sessionID, at, patch)
    }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      // outcomeOverride: the session record's outcome only heals on refetch.
      // The run is over — clear the current-tool label so an interrupted or
      // failed session never shows a stale tool in the UI.
      const prev = state.activity[sessionID]
      const patch: Partial<SessionActivity> = {
        currentTool: null,
        currentToolSince: null,
      }
      if (e.type === "session.execution.failed") {
        patch.lastError = errorText(data) ?? prev?.lastError ?? null
      }
      return updateActivityOutcome(state, sessionID, at, outcomeOverride(e), patch)
    }
    case "permission.asked":
      return updateActivity(state, sessionID, at, {
        lastActivityKind: "permission",
      })
    case "permission.replied":
      // optimistic reply cleared the inbox entry — drop the event-driven
      // permission flag so a busy session returns to generating/executing
      if (
        !state.permissionRequests.some((r) => r.sessionID === sessionID) &&
        state.activity[sessionID]?.lastActivityKind === "permission"
      ) {
        return updateActivity(state, sessionID, at, { lastActivityKind: null })
      }
      return state
    default:
      return state
  }
}

/** Like updateActivity but with the outcome supplied directly (execution
 *  ending events know the outcome before the session record heals). */
function updateActivityOutcome(
  state: NexusState,
  sessionID: string,
  at: number,
  outcome: "succeeded" | "failed" | "interrupted",
  patch: Partial<SessionActivity>,
): NexusState {
  const prev = state.activity[sessionID] ?? emptyActivity(at)
  const next: SessionActivity = {
    ...prev,
    ...patch,
    lastEventAt: at,
    state: deriveAgentState({
      busy: false, // the ending event terminates the run
      outcome,
      permissionOpen:
        state.permissionRequests.some((r) => r.sessionID === sessionID),
      lastActivityKind:
        "lastActivityKind" in patch
          ? (patch.lastActivityKind ?? null)
          : prev.lastActivityKind,
    }),
  }
  return { ...state, activity: { ...state.activity, [sessionID]: next } }
}

function sessionFromEvent(e: NexusEvent): SessionInfo | undefined {
  const raw = e.data as Partial<SessionInfo>
  if (typeof raw.id !== "string") return undefined
  return raw as SessionInfo
}

function patchSession(
  state: NexusState,
  id: string,
  patch: Partial<SessionInfo>,
): NexusState {
  const existing = state.sessions[id]
  if (!existing) return state
  return {
    ...state,
    sessions: { ...state.sessions, [id]: { ...existing, ...patch } },
  }
}

function mapMessages(
  state: NexusState,
  sessionID: string,
  fn: (msgs: ChatMessage[]) => ChatMessage[],
): NexusState {
  // self-initializing: events for a session whose message list hasn't been
  // fetched yet must not be dropped (e.g. activated while listMessages is
  // in flight, or a session created in another client)
  const msgs = state.messages[sessionID] ?? []
  return { ...state, messages: { ...state.messages, [sessionID]: fn(msgs) } }
}

function mapMessage(
  state: NexusState,
  sessionID: string,
  messageID: string,
  fn: (msg: ChatMessage) => ChatMessage,
): NexusState {
  return mapMessages(state, sessionID, (msgs) =>
    msgs.map((m) => (m.id === messageID ? fn(m) : m)),
  )
}

/** Ensure a message exists for streaming events (never fabricated otherwise). */
function ensureStreamingMessage(
  state: NexusState,
  sessionID: string,
  messageID: string,
  extra?: Partial<ChatMessage>,
): NexusState {
  const msgs = state.messages[sessionID] ?? []
  if (msgs.some((m) => m.id === messageID)) return state
  return {
    ...state,
    messages: {
      ...state.messages,
      [sessionID]: [
        ...msgs,
        {
          id: messageID,
          sessionID,
          role: "assistant",
          parts: [],
          streaming: true,
          time: { created: Date.now() },
          ...extra,
        },
      ],
    },
  }
}

/**
 * Ensure an n-th part of `kind` exists on the message and return its index.
 * Ordinals are per part-kind (verified: reasoning and text each count from 0),
 * so we count existing parts of that kind and append (placeholders for gaps).
 */
function ensurePart(
  msg: ChatMessage,
  kind: "text" | "reasoning",
  ordinal: number,
): { parts: MessagePart[]; index: number } {
  const parts = [...msg.parts]
  const indices = parts
    .map((p, i) => (p.type === kind ? i : -1))
    .filter((i) => i >= 0)
  let index: number
  if (indices.length > ordinal) {
    index = indices[ordinal]!
  } else {
    // fill any gap defensively, then append the new part
    while (indices.length < ordinal) {
      parts.push(kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" })
      indices.push(parts.length - 1)
    }
    parts.push(kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" })
    index = parts.length - 1
  }
  return { parts, index }
}

function appendDelta(
  state: NexusState,
  sessionID: string,
  messageID: string,
  kind: "text" | "reasoning",
  ordinal: number,
  delta: string,
): NexusState {
  return mapMessage(state, sessionID, messageID, (msg) => {
    const { parts, index } = ensurePart(msg, kind, ordinal)
    const part = parts[index]!
    const updated: TextPart | ReasoningPart =
      part.type === kind
        ? ({ ...part, text: part.text + delta } as TextPart | ReasoningPart)
        : ({ type: kind, text: delta } as TextPart | ReasoningPart)
    parts[index] = updated
    return { ...msg, parts }
  })
}

/** Upsert a tool part keyed by tool-call id. */
function upsertToolPart(
  state: NexusState,
  sessionID: string,
  messageID: string,
  toolID: string,
  patch: Partial<Omit<ToolPart, "type" | "id">> & { name?: string },
): NexusState {
  return mapMessage(state, sessionID, messageID, (msg) => {
    const idx = msg.parts.findIndex(
      (p) => p.type === "tool" && p.id === toolID,
    )
    const parts = [...msg.parts]
    if (idx >= 0) {
      const existing = parts[idx] as ToolPart
      parts[idx] = {
        ...existing,
        ...patch,
        type: "tool",
        id: toolID,
        state: { ...existing.state, ...(patch.state ?? {}) },
      }
    } else {
      parts.push({
        type: "tool",
        id: toolID,
        name: patch.name ?? "tool",
        executed: patch.executed ?? false,
        state: patch.state ?? { status: "pending" },
      })
    }
    return { ...msg, parts }
  })
}

/**
 * Full reducer: the message path (guarded to the active session) followed
 * by the activity summary path (all sessions, activity slice only).
 */
export function applyEvent(state: NexusState, e: NexusEvent): NexusState {
  return applyActivity(reduceEvent(state, e), e)
}

function reduceEvent(state: NexusState, e: NexusEvent): NexusState {
  const data = e.data
  switch (e.type) {
    case "server.connected":
      // connection → online + resync are driven by the stream state callback;
      // lastEventAt is stamped by the applyEvent wrapper.
      return state

    case "session.created": {
      const s = sessionFromEvent(e)
      if (!s) return state
      if (state.sessions[s.id]) {
        return patchSession(state, s.id, s)
      }
      return {
        ...state,
        sessions: { ...state.sessions, [s.id]: s },
        sessionOrder: [s.id, ...state.sessionOrder],
      }
    }

    case "session.renamed": {
      const { sessionID, title } = data as { sessionID?: string; title?: string }
      if (typeof sessionID !== "string" || typeof title !== "string") return state
      return patchSession(state, sessionID, { title })
    }

    case "session.deleted": {
      const { sessionID } = data as { sessionID?: string }
      if (typeof sessionID !== "string") return state
      const sessions = { ...state.sessions }
      delete sessions[sessionID]
      const messages = { ...state.messages }
      delete messages[sessionID]
      const activity = { ...state.activity }
      delete activity[sessionID]
      const wasActive = state.activeSessionId === sessionID
      return {
        ...state,
        sessions,
        messages,
        activity,
        sessionOrder: state.sessionOrder.filter((id) => id !== sessionID),
        ...(wasActive ? { activeSessionId: null } : {}),
      }
    }

    case "session.inbox.delivered":
    case "session.inbox.enqueued": {
      // inboxID = the canonical user message id — reconcile the optimistic tmp_
      const { sessionID, inboxID } = data as {
        sessionID?: string
        inboxID?: string
      }
      if (
        typeof sessionID !== "string" ||
        typeof inboxID !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return mapMessages(state, sessionID, (msgs) => {
        const idx = msgs.findLastIndex(
          (m) => m.role === "user" && m.id.startsWith("tmp_"),
        )
        if (idx < 0) return msgs
        return msgs.map((m, i) => (i === idx ? { ...m, id: inboxID } : m))
      })
    }

    case "session.execution.started": {
      const { sessionID } = data as { sessionID?: string }
      if (typeof sessionID !== "string") return state
      return { ...state, busy: { ...state.busy, [sessionID]: true } }
    }

    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const { sessionID } = data as { sessionID?: string }
      if (typeof sessionID !== "string") return state
      const msgs = state.messages[sessionID]?.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      )
      return {
        ...state,
        busy: { ...state.busy, [sessionID]: false },
        ...(msgs
          ? { messages: { ...state.messages, [sessionID]: msgs } }
          : {}),
        pendingReconcile: { sessionID, at: Date.now() },
      }
    }

    case "session.step.started": {
      const { sessionID, assistantMessageID, agent, model } = data as {
        sessionID?: string
        assistantMessageID?: string
        agent?: string
        model?: ChatMessage["model"]
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return ensureStreamingMessage(state, sessionID, assistantMessageID, {
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
      })
    }

    // session.step.streamed / .ended / .failed — ordering bookkeeping only (Phase 1)
    case "session.step.streamed":
    case "session.step.ended":
    case "session.step.failed":
      return state

    case "session.text.started":
    case "session.reasoning.started": {
      const kind = e.type === "session.text.started" ? "text" : "reasoning"
      const { sessionID, assistantMessageID, ordinal } = data as {
        sessionID?: string
        assistantMessageID?: string
        ordinal?: number
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof ordinal !== "number" ||
        !sameSession(state, e)
      ) {
        return state
      }
      const msgs = state.messages[sessionID]
      if (!msgs?.some((m) => m.id === assistantMessageID)) return state
      return mapMessage(state, sessionID, assistantMessageID, (msg) => {
        const { parts } = ensurePart(msg, kind, ordinal)
        return { ...msg, parts }
      })
    }

    case "session.text.delta":
    case "session.reasoning.delta": {
      const kind = e.type === "session.text.delta" ? "text" : "reasoning"
      const { sessionID, assistantMessageID, ordinal, delta } = data as {
        sessionID?: string
        assistantMessageID?: string
        ordinal?: number
        delta?: string
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof ordinal !== "number" ||
        typeof delta !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return appendDelta(state, sessionID, assistantMessageID, kind, ordinal, delta)
    }

    case "session.text.ended":
    case "session.reasoning.ended": {
      // mark part complete: reasoning carries time.completed; text completion
      // is implied by the reconcile fetch — nothing to patch for text.
      if (e.type !== "session.reasoning.ended") return state
      const { sessionID, assistantMessageID, ordinal } = data as {
        sessionID?: string
        assistantMessageID?: string
        ordinal?: number
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof ordinal !== "number" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return mapMessage(state, sessionID, assistantMessageID, (msg) => {
        const indices = msg.parts
          .map((p, i) => (p.type === "reasoning" ? i : -1))
          .filter((i) => i >= 0)
        const idx = indices[ordinal]
        if (idx === undefined) return msg
        const parts = [...msg.parts]
        const part = parts[idx] as ReasoningPart
        parts[idx] = {
          ...part,
          time: { created: part.time?.created ?? Date.now(), completed: Date.now() },
        }
        return { ...msg, parts }
      })
    }

    case "session.tool.input.started": {
      const { sessionID, assistantMessageID, id, name } = data as {
        sessionID?: string
        assistantMessageID?: string
        id?: string
        name?: string
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof id !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return upsertToolPart(state, sessionID, assistantMessageID, id, {
        ...(name !== undefined ? { name } : {}),
        state: { status: "pending" },
      })
    }

    case "session.tool.input.delta": {
      const { sessionID, assistantMessageID, id, delta } = data as {
        sessionID?: string
        assistantMessageID?: string
        id?: string
        delta?: string
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof id !== "string" ||
        typeof delta !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return mapMessage(state, sessionID, assistantMessageID, (msg) => {
        const idx = msg.parts.findIndex((p) => p.type === "tool" && p.id === id)
        if (idx < 0) return msg
        const parts = [...msg.parts]
        const part = parts[idx] as ToolPart
        const current =
          typeof part.state.input === "string" ? part.state.input : ""
        parts[idx] = {
          ...part,
          state: { ...part.state, input: current + delta },
        }
        return { ...msg, parts }
      })
    }

    case "session.tool.input.ended": {
      const { sessionID, assistantMessageID, id, text } = data as {
        sessionID?: string
        assistantMessageID?: string
        id?: string
        text?: string
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof id !== "string" ||
        typeof text !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      // input arrives as a JSON string — parse for display, keep raw on failure
      let input: unknown = text
      try {
        input = JSON.parse(text) as unknown
      } catch {
        // keep raw text
      }
      return upsertToolPart(state, sessionID, assistantMessageID, id, {
        state: { status: "pending", input },
      })
    }

    case "session.tool.called": {
      const { sessionID, assistantMessageID, id, name, input } = data as {
        sessionID?: string
        assistantMessageID?: string
        id?: string
        name?: string
        input?: unknown
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof id !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return upsertToolPart(state, sessionID, assistantMessageID, id, {
        ...(name !== undefined ? { name } : {}),
        state: { status: "running", ...(input !== undefined ? { input } : {}) },
      })
    }

    case "session.tool.success":
    case "session.tool.failed": {
      const { sessionID, assistantMessageID, id, content, metadata } = data as {
        sessionID?: string
        assistantMessageID?: string
        id?: string
        content?: unknown[]
        metadata?: Record<string, unknown>
      }
      if (
        typeof sessionID !== "string" ||
        typeof assistantMessageID !== "string" ||
        typeof id !== "string" ||
        !sameSession(state, e)
      ) {
        return state
      }
      return upsertToolPart(state, sessionID, assistantMessageID, id, {
        state: {
          status: e.type === "session.tool.success" ? "completed" : "failed",
          ...(content !== undefined ? { output: content } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        },
      })
    }

    case "session.usage.updated": {
      const { sessionID, cost, tokens } = data as {
        sessionID?: string
        cost?: number
        tokens?: SessionInfo["tokens"]
      }
      if (typeof sessionID !== "string") return state
      return patchSession(state, sessionID, {
        ...(cost !== undefined ? { cost } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      })
    }

    case "session.idle":
    case "session.status": {
      // defensive idle signal
      const { sessionID } = data as { sessionID?: string }
      if (typeof sessionID !== "string") return state
      return { ...state, busy: { ...state.busy, [sessionID]: false } }
    }

    case "command.updated":
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "commands"),
      }
    case "agent.updated":
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "agents"),
      }
    case "project.updated":
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "projects"),
      }
    case "config.updated":
      // config itself is not stored in Phase 1; refresh sessions as a proxy.
      // models: provider/model catalog feeds the ctx-limit chain (§4.1)
      return {
        ...state,
        pendingRefetch: unionTarget(unionTarget(state.pendingRefetch, "sessions"), "models"),
      }

    case "permission.asked":
      // count drives the badge; the refetch marker populates the drawer list
      // (SPEC-PHASE3 §4.1 — the count alone cannot render the drawer)
      return {
        ...state,
        pendingPermissions: state.pendingPermissions + 1,
        pendingRefetch: unionTarget(state.pendingRefetch, "permissions"),
      }

    case "permission.replied":
    case "session.permissions":
      // authoritative add/remove of pending requests (defensive: enum-verified)
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "permissions"),
      }

    case "worktree.updated":
    case "worktree.resolved":
      // reload the Projects view's visible worktree lists (debounced 500 ms)
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "worktrees"),
      }

    case "skill.updated":
    case "plugin.updated":
    case "mcp.status.changed":
      // invalidate the System view's extension cache — next view-open refetches
      // (no polling, §8.1); the handler lives in the workspace store
      return {
        ...state,
        pendingRefetch: unionTarget(state.pendingRefetch, "extensions"),
      }

    default:
      return state
  }
}

function unionTarget(
  current: RefetchTarget[],
  target: RefetchTarget,
): RefetchTarget[] {
  return current.includes(target) ? current : [...current, target]
}
