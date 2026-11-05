// Selector hooks — keep re-renders scoped (streaming deltas only touch the
// components that select the changed slice).

import { useNexus, type NexusState } from "./nexus"
import type {
  ChatMessage,
  ModelInfo,
  PermissionRequest,
  SessionInfo,
  TokenUsage,
} from "@/lib/opencode/types"

export function useActiveSession(): SessionInfo | null {
  return useNexus((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null,
  )
}

const EMPTY_MESSAGES: ChatMessage[] = []

export function useActiveMessages(): ChatMessage[] {
  // stable fallback: a fresh [] per call would loop useSyncExternalStore
  return useNexus((s) =>
    s.activeSessionId ? (s.messages[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  )
}

export function useIsBusy(): boolean {
  return useNexus((s) =>
    s.activeSessionId ? (s.busy[s.activeSessionId] ?? false) : false,
  )
}

/**
 * Current context size: the latest assistant message's per-message tokens —
 * each assistant message reports the running window after its step, so the
 * newest one IS the current context. Cumulative session.tokens is NOT
 * (cache.read alone is a per-step counter that re-reads the whole window).
 * Returns null when no measured message is loaded — callers that must show
 * something then fall back to session.tokens and label it an estimate.
 */
export function useCurrentContextTokens(): TokenUsage | null {
  return useNexus((s) => {
    const msgs = s.activeSessionId ? s.messages[s.activeSessionId] : undefined
    if (!msgs) return null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      if (m.role === "assistant" && m.tokens) return m.tokens
    }
    return null
  })
}

/** Status only — avoids re-rendering on version/url updates. */
export function useStatus(): NexusState["connection"]["status"] {
  return useNexus((s: NexusState) => s.connection.status)
}

const EMPTY_MODELS: ModelInfo[] = []

export function useModels(): ModelInfo[] {
  // stable fallback: a fresh [] per call would loop useSyncExternalStore
  return useNexus((s) => s.models ?? EMPTY_MODELS)
}

const EMPTY_PERMISSIONS: PermissionRequest[] = []

export function usePermissionRequests(): PermissionRequest[] {
  // stable fallback: a fresh [] per call would loop useSyncExternalStore
  return useNexus((s) => s.permissionRequests ?? EMPTY_PERMISSIONS)
}
