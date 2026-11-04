// Selector hooks — keep re-renders scoped (streaming deltas only touch the
// components that select the changed slice).

import { useNexus, type NexusState } from "./nexus"
import type { ChatMessage, SessionInfo } from "@/lib/opencode/types"

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

export function useConnectionStatus(): NexusState["connection"] {
  return useNexus((s: NexusState) => s.connection)
}

/** Status only — avoids re-rendering on version/url updates. */
export function useStatus(): NexusState["connection"]["status"] {
  return useNexus((s: NexusState) => s.connection.status)
}
