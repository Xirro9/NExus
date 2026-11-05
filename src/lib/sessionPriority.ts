// Session priority — JERRY-SIDE ORGANIZATIONAL METADATA ONLY.
//
// OpenCode v2.2.5 has no execution-priority or scheduling API (verified live:
// openapi session paths + /api/session/active carry no priority concept, and
// the local GLM server processes one generation at a time regardless). This
// module therefore stores a per-session label that Jerry uses for sorting,
// filtering, and bulk-operation ordering — it NEVER changes inference
// scheduling, and the UI says so next to every priority control.
//
// Persisted to localStorage keyed by sessionID; pruned on explicit deletes.

export const SESSION_PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
  "paused",
] as const

export type SessionPriority = (typeof SESSION_PRIORITIES)[number]

export const DEFAULT_PRIORITY: SessionPriority = "normal"

const STORAGE_KEY = "nexus.sessionPriorities.v1"

export function isSessionPriority(v: unknown): v is SessionPriority {
  return (
    typeof v === "string" &&
    (SESSION_PRIORITIES as readonly string[]).includes(v)
  )
}

export function loadPriorities(): Record<string, SessionPriority> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, SessionPriority> = {}
    for (const [id, v] of Object.entries(parsed)) {
      if (isSessionPriority(v)) out[id] = v
    }
    return out
  } catch {
    return {}
  }
}

export function savePriorities(map: Record<string, SessionPriority>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota/private-mode — priorities degrade to session-scoped, non-fatal
  }
}

/** Sort rank: lower = more urgent. "paused" sorts last (after "low"). */
export function priorityRank(p: SessionPriority): number {
  return SESSION_PRIORITIES.indexOf(p)
}

/** Badge styling per priority — muted for the default, colored otherwise. */
export const PRIORITY_BADGE: Record<SessionPriority, string> = {
  critical: "border-destructive/60 text-destructive",
  high: "border-warning/60 text-warning",
  normal: "border-border/60 text-muted-foreground/80",
  low: "border-border/60 text-muted-foreground/60",
  paused: "border-accent/60 text-accent",
}

export function getPriority(
  map: Record<string, SessionPriority>,
  sessionID: string,
): SessionPriority {
  return map[sessionID] ?? DEFAULT_PRIORITY
}
