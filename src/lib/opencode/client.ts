// Typed fetch wrapper for the OpenCode v2.2.0 API.
// All paths are origin-relative — auth is injected by the Vite dev proxy
// (never bypass it; EventSource cannot set headers on its own).

import type {
  AgentInfo,
  ChatMessage,
  CommandBody,
  CommandInfo,
  MessagePart,
  MessageRole,
  ProjectInfo,
  PromptBody,
  ServerInfo,
  SessionInfo,
} from "./types"

export class ApiError extends Error {
  status: number
  tag: string | null
  constructor(status: number, tag: string | null, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.tag = tag
  }
}

/**
 * Response envelopes vary across endpoints: { location, data }, { data }, or a
 * bare array/object (GET /api/project). Unwrap all three.
 */
function unwrap<T>(json: unknown): T {
  if (
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "data" in json
  ) {
    return (json as { data: unknown }).data as T
  }
  return json as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let tag: string | null = null
    let message = `${res.status} ${res.statusText}`
    try {
      // auth-failure body shape: { _tag: "UnauthorizedError", message }
      const body = (await res.json()) as { _tag?: string; message?: string }
      if (body._tag) tag = body._tag
      if (body.message) message = body.message
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new ApiError(res.status, tag, message)
  }
  if (res.status === 204) return undefined as T
  return unwrap<T>(await res.json())
}

/** Map a raw server message (content: Part[]) to our ChatMessage 1:1. */
function toChatMessage(raw: Record<string, unknown>): ChatMessage {
  const role = raw.type as MessageRole
  const rawParts = Array.isArray(raw.content) ? raw.content : []
  const parts: MessagePart[] = []
  for (const p of rawParts) {
    if (!p || typeof p !== "object") continue
    const part = p as Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      const time = part.time as { created?: number; completed?: number } | undefined
      parts.push({
        type: "reasoning",
        text: part.text,
        ...(time?.created !== undefined
          ? {
              time: {
                created: time.created,
                ...(time.completed !== undefined
                  ? { completed: time.completed }
                  : {}),
              },
            }
          : {}),
      })
    } else if (part.type === "tool" && typeof part.id === "string") {
      const state = (part.state ?? {}) as Record<string, unknown>
      parts.push({
        type: "tool",
        id: part.id,
        name: typeof part.name === "string" ? part.name : "tool",
        executed: part.executed === true,
        state: {
          status: typeof state.status === "string" ? state.status : "unknown",
          ...(state.input !== undefined ? { input: state.input } : {}),
          ...(state.output !== undefined ? { output: state.output } : {}),
        },
      })
    }
    // unknown part types are dropped (verified taxonomy: text/reasoning/tool)
  }
  return {
    id: String(raw.id ?? ""),
    sessionID: String(raw.sessionID ?? ""),
    role,
    ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
    ...(raw.model !== undefined ? { model: raw.model as ChatMessage["model"] } : {}),
    parts,
    time: {
      created:
        typeof (raw.time as { created?: number } | undefined)?.created ===
        "number"
          ? (raw.time as { created: number }).created
          : 0,
    },
  }
}

export const api = {
  info(): Promise<ServerInfo> {
    return request<ServerInfo>("/api/info")
  },

  listSessions(directory?: string): Promise<SessionInfo[]> {
    const q = new URLSearchParams({ limit: "50", order: "desc" })
    if (directory) q.set("directory", directory)
    return request<SessionInfo[]>(`/api/session?${q.toString()}`)
  },

  createSession(directory: string): Promise<SessionInfo> {
    return request<SessionInfo>("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory } }),
    })
  },

  listMessages(sessionID: string): Promise<ChatMessage[]> {
    const q = new URLSearchParams({ order: "asc", limit: "200" })
    return request<Record<string, unknown>[]>(
      `/api/session/${sessionID}/message?${q.toString()}`,
    ).then((items) =>
      items.map((raw) => {
        const msg = toChatMessage(raw)
        return { ...msg, sessionID: msg.sessionID || sessionID }
      }),
    )
  },

  prompt(sessionID: string, body: PromptBody): Promise<unknown> {
    return request<unknown>(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  },

  /** POST /api/session/{id}/command — responds 204 No Content. */
  runCommand(sessionID: string, body: CommandBody): Promise<void> {
    return request<void>(`/api/session/${sessionID}/command`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  },

  /** POST /api/session/{id}/interrupt — no body. */
  interrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    return request<{ interrupted: boolean }>(
      `/api/session/${sessionID}/interrupt`,
      { method: "POST" },
    )
  },

  listAgents(): Promise<AgentInfo[]> {
    return request<AgentInfo[]>("/api/agent")
  },

  listCommands(): Promise<CommandInfo[]> {
    return request<CommandInfo[]>("/api/command")
  },

  /** GET /api/project returns a bare array (no envelope). */
  listProjects(): Promise<ProjectInfo[]> {
    return request<ProjectInfo[]>("/api/project")
  },
}
