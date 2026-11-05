// Typed fetch wrapper for the OpenCode v2.2.0 API.
// All paths are origin-relative — auth is injected by the Vite dev proxy
// (never bypass it; EventSource cannot set headers on its own).

import type {
  AgentInfo,
  ChatMessage,
  CommandBody,
  CommandInfo,
  ContextMessage,
  McpServerInfo,
  MessagePart,
  MessageRole,
  ModelInfo,
  PermissionReply,
  PermissionRequest,
  PluginInfo,
  ProjectInfo,
  PromptBody,
  ServerInfo,
  SessionCursor,
  SessionInfo,
  SessionQuery,
  SessionStatsInfo,
  SkillInfo,
  StatsParams,
  WorktreeDirectory,
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

/** Fetch + ApiError mapping, WITHOUT envelope unwrapping — for endpoints
 *  whose response carries more than a single `data` field (e.g. /api/session
 *  returns { location, data, cursor }). */
async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
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
  return res
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await requestRaw(path, init)
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

  /** GET /api/model — model catalog with `limit.context` for the ctx chain. */
  listModels(): Promise<ModelInfo[]> {
    return request<ModelInfo[]>("/api/model")
  },

  /** GET /api/session/{id}/context — messages after the last compaction
   *  (the current context window; assistant items carry per-message tokens). */
  getSessionContext(sessionID: string): Promise<ContextMessage[]> {
    return request<ContextMessage[]>(`/api/session/${sessionID}/context`)
  },

  /** GET /api/experimental/session/stats — `project` takes a Project.ID
   *  (verified live: a path param is accepted but matches nothing). */
  getSessionStats(params?: StatsParams): Promise<SessionStatsInfo> {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) q.set(k, v)
    }
    const qs = q.toString()
    return request<SessionStatsInfo>(
      `/api/experimental/session/stats${qs ? `?${qs}` : ""}`,
    )
  },

  // -------------------------------------------------------------------------
  // Phase 3 additions (SPEC-PHASE3 §3)

  /** Cursor-aware session query (Phase 1 listSessions stays as-is for the
   *  sidebar). Uses requestRaw: the envelope is { location, data, cursor }
   *  and request()'s unwrap() would strip `.data` before we can read cursor. */
  async listSessionsQuery(q: SessionQuery): Promise<{
    sessions: SessionInfo[]
    cursor: SessionCursor
  }> {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined) params.set(k, v)
    }
    const res = await requestRaw(`/api/session?${params.toString()}`)
    const json = (await res.json()) as {
      data?: unknown
      cursor?: Partial<SessionCursor>
    }
    return {
      sessions: Array.isArray(json.data) ? (json.data as SessionInfo[]) : [],
      cursor: {
        previous: json.cursor?.previous ?? null,
        next: json.cursor?.next ?? null,
      },
    }
  },

  /** GET /api/permission/request — pending permission requests. */
  listPermissionRequests(directory?: string): Promise<PermissionRequest[]> {
    const qs = directory
      ? `?${new URLSearchParams({ "location[directory]": directory }).toString()}`
      : ""
    return request<PermissionRequest[]>(`/api/permission/request${qs}`)
  },

  /** GET /api/session/{id}/permission — a session's requests. */
  listSessionPermissions(sessionID: string): Promise<PermissionRequest[]> {
    return request<PermissionRequest[]>(`/api/session/${sessionID}/permission`)
  },

  /** POST …/permission/{requestID}/reply — 204. `once`/`always` EXECUTE the
   *  pending action (`always` also persists an allow rule); `reject` denies.
   *  ⚠ Single call site policy: only nexus.replyPermission may invoke this. */
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionReply,
    message?: string,
  ): Promise<void> {
    return request<void>(
      `/api/session/${sessionID}/permission/${requestID}/reply`,
      {
        method: "POST",
        body: JSON.stringify(message !== undefined ? { decision, message } : { decision }),
      },
    )
  },

  /** GET /api/worktree?projectID=… — bare array. */
  listWorktrees(projectID: string): Promise<WorktreeDirectory[]> {
    return request<WorktreeDirectory[]>(
      `/api/worktree?${new URLSearchParams({ projectID }).toString()}`,
    )
  },

  /** POST /api/worktree/refresh { projectID } — 204. Read-only refresh only:
   *  worktree create/delete are deliberately excluded (SPEC-PHASE3 §7). */
  refreshWorktrees(projectID: string): Promise<void> {
    return request<void>("/api/worktree/refresh", {
      method: "POST",
      body: JSON.stringify({ projectID }),
    })
  },

  listSkills(): Promise<SkillInfo[]> {
    return request<SkillInfo[]>("/api/skill")
  },

  listPlugins(): Promise<PluginInfo[]> {
    return request<PluginInfo[]>("/api/plugin")
  },

  listMcpServers(): Promise<McpServerInfo[]> {
    return request<McpServerInfo[]>("/api/mcp")
  },

  /** GET /api/session/active → { ses_…: { type: "running" } } map —
   *  server-truth "running" signal for the agents graph. */
  listActiveSessions(): Promise<Record<string, { type: "running" }>> {
    return request<Record<string, { type: "running" }>>("/api/session/active")
  },

  /** Raw file text — BYPASSES request<T>: fs/read returns bytes
   *  (application/octet-stream), not a JSON envelope. On !ok parse the
   *  {_tag} body and throw ApiError. ⚠ Callers MUST use the MEMORY_FILES
   *  whitelist (SPEC-PHASE3 §4.3) — the endpoint accepts absolute paths. */
  async readFsFile(absolutePath: string): Promise<string> {
    const res = await fetch(
      "/api/fs/read/" + encodeURIComponent(absolutePath),
    )
    if (!res.ok) {
      let tag: string | null = null
      let message = `${res.status} ${res.statusText}`
      try {
        const body = (await res.json()) as { _tag?: string; message?: string }
        if (body._tag) tag = body._tag
        if (body.message) message = body.message
      } catch {
        // non-JSON error body — keep the status text
      }
      throw new ApiError(res.status, tag, message)
    }
    return res.text()
  },
}
