// Domain types for the OpenCode v2.2.0 HTTP API.
// Shapes verified against the live service (see docs/SPEC-PHASE1.md §0/§3).

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline"

export interface LocationRef {
  directory?: string
}

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionInfo {
  id: string
  projectID: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsage
  outcome?: "succeeded" | "failed" | "interrupted"
  time: {
    created: number
    updated: number
    idle?: number
    viewed?: number
    archived?: number
  }
  location: LocationRef
}

export type MessageRole =
  | "user"
  | "assistant"
  | "synthetic"
  | "system"
  | "skill"
  | "shell"
  | "compaction"
  | "idle"
  | "agent-switched"
  | "model-switched"
  | "location-switched"

export interface TextPart {
  type: "text"
  text: string
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
  time?: { created: number; completed?: number }
}

export interface ToolPart {
  type: "tool"
  id: string
  name: string
  executed: boolean
  state: { status: string; input?: unknown; output?: unknown }
}

export type MessagePart = TextPart | ReasoningPart | ToolPart

export interface ChatMessage {
  id: string
  sessionID: string
  role: MessageRole
  agent?: string
  model?: ModelRef
  parts: MessagePart[]
  streaming?: boolean // true while assistant deltas are arriving
  time: { created: number }
}

export interface AgentInfo {
  id: string
  name: string
  mode: string
  hidden: boolean
  description?: string
}

export interface CommandInfo {
  name: string
  description?: string
}

export interface ProjectInfo {
  id: string
  canonical: string
  time: { created: number; updated: number; active?: number; archived?: number }
  /** additive Phase 3 fields (SPEC-PHASE3 §0.9) */
  vcs?: unknown
  name?: string
  icon?: unknown
  worktrees?: number
  sandboxes?: string[]
}

export interface ServerInfo {
  version?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Phase 2 additions (SPEC-PHASE2 §0.4/§7; shapes verified against the live
// v2.2.0 service + /tmp/opencode/nexus-api-samples/)

export interface ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  type: string
  status: string
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  variants?: { id: string; [k: string]: unknown }[]
}

/** Item of GET /api/session/{id}/context — messages after the last compaction.
 *  User messages carry `text`; assistant messages carry `content[]` plus
 *  per-message `tokens` + `cost`. */
export interface ContextMessage {
  id: string
  time: { created: number; streamed?: number; completed?: number }
  type: MessageRole
  agent?: string
  model?: ModelRef
  tokens?: TokenUsage
  cost?: number
  text?: string
  content?: { type: string; text?: string; [k: string]: unknown }[]
}

export interface SessionStatsToolUsage {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  durationP50: number
}

export interface SessionStatsTools {
  mode: "none" | "summary" | "detail"
  totals: { calls: number; succeeded: number; failed: number; unfinished: number }
  /** only present when requested with tools=detail */
  usage?: SessionStatsToolUsage[]
}

export interface SessionStatsActivity {
  date: string // e.g. "2026-11-04"
  steps: number
}

export interface SessionStatsModelUsage {
  model: ModelRef
  steps: number
  tokens: TokenUsage
  cost: number
}

export interface SessionStatsInfo {
  range: { from: number; to: number }
  sessions: number
  subagents: number
  prompts: number
  steps: number
  tokens: TokenUsage
  cost: number
  tools: SessionStatsTools
  activeDays: number
  streak: number
  activity: SessionStatsActivity[]
  models: SessionStatsModelUsage[]
}

export interface StatsParams {
  from?: string
  to?: string
  /** Project.ID — a filesystem path is accepted but matches nothing (verified live). */
  project?: string
  timezone?: string
  tools?: "none" | "summary" | "detail"
}

// request bodies (exact, §5)

export interface PromptBody {
  text: string
  files?: { uri: string; name?: string; description?: string }[]
  agents?: { name: string }[]
  skills?: { id: string }[]
  metadata?: Record<string, unknown>
  delivery?: "steer" | "queue" | null
  resume?: boolean | null
  id?: string | null
}

export interface CommandBody {
  name: string
  text: string
}

// ---------------------------------------------------------------------------
// Phase 3 additions (SPEC-PHASE3 §3; shapes verified against the live
// v2.2.0 service + /tmp/opencode/nexus-api-samples/)

/** Query params of GET /api/session — a full server-side query engine. */
export interface SessionQuery {
  limit?: string
  order?: "asc" | "desc"
  search?: string
  /** Session.ID or the literal string "null" (roots only). */
  parentID?: string
  archived?: "true" | "false"
  directory?: string
  project?: string
  cursor?: string
}

/** SessionsResponse.cursor — opaque, pass through verbatim (§12.6). */
export interface SessionCursor {
  previous: string | null
  next: string | null
}

export type PermissionReply = "once" | "always" | "reject"

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
  message?: string
}

export interface WorktreeDirectory {
  directory: string
  strategy?: string
}

export interface SkillInfo {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  /** full markdown body — render lazily on expand (56 KB total) */
  content: string
}

export type PluginSource =
  | { type: "builtin" }
  | { type: "sdk" }
  | { type: "package"; target: string; version?: string; outdated?: true; updating?: true }
  | { type: "local"; path: string }

export interface PluginInfo {
  id?: string
  source: PluginSource
  features: { server?: true; tui?: true; rpc?: true; gui?: true }
  state: { status: "active" } | { status: "failed"; error: string; ref?: string }
}

export type McpStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error?: string }
  | { status: "needs_auth"; error?: string }

export interface McpServerInfo {
  name: string
  status: McpStatus
  title?: string
  integrationID?: string
}
