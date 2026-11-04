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
  time: { created: number; updated: number; active?: number }
}

export interface ServerInfo {
  version?: string
  [k: string]: unknown
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
