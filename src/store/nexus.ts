// Central zustand store: connection + sessions + chat slices.
// Components call actions here; lib/opencode is never imported by components.

import { create } from "zustand"

import { ApiError, api } from "@/lib/opencode/client"
import type { NexusEvent } from "@/lib/opencode/sse"
import type {
  AgentInfo,
  ChatMessage,
  CommandInfo,
  ConnectionStatus,
  ProjectInfo,
  SessionInfo,
} from "@/lib/opencode/types"
import { applyEvent, type RefetchTarget } from "./events"

export interface NexusState {
  connection: {
    status: ConnectionStatus
    version: string | null
    lastEventAt: number
    // extensions for the rail's server card (from GET /api/info)
    url: string | null
    hostname: string | null
  }
  syncGeneration: number
  sessions: Record<string, SessionInfo>
  sessionOrder: string[] // newest first
  activeSessionId: string | null
  messages: Record<string, ChatMessage[]> // per sessionID, oldest → newest
  busy: Record<string, boolean> // sessionID → execution running
  commands: CommandInfo[]
  agents: AgentInfo[]
  projects: ProjectInfo[]
  activeProjectId: string | null // sidebar filter
  toast: { kind: "error" | "info"; text: string } | null
  // internal scheduling markers consumed by the applyEvent wrapper (§4)
  pendingReconcile: { sessionID: string; at: number } | null
  pendingRefetch: RefetchTarget[]
  pendingPermissions: number // Phase 3 hook: count only, badge in rail
  // actions
  bootstrap(): Promise<void>
  setActiveSession(id: string | null): Promise<void>
  newSession(): Promise<void>
  sendPrompt(text: string): Promise<void>
  sendSlashCommand(name: string, rest: string): Promise<void>
  interruptActive(): Promise<void>
  resync(): Promise<void>
  applyEvent(e: NexusEvent): void
}

// ---------------------------------------------------------------------------
// module-level timers (debounces + auth retry); never exposed in state

const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
let refetchTimer: ReturnType<typeof setTimeout> | null = null
let authRetryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleReconcile(sessionID: string) {
  const existing = reconcileTimers.get(sessionID)
  if (existing) clearTimeout(existing)
  reconcileTimers.set(
    sessionID,
    setTimeout(() => {
      reconcileTimers.delete(sessionID)
      const state = useNexus.getState()
      if (state.connection.status !== "online") return
      void api
        .listMessages(sessionID)
        .then((msgs) => {
          const s = useNexus.getState()
          if (s.connection.status !== "online") return
          // wholesale replace — authoritative reconciliation (heals missed deltas)
          useNexus.setState({
            messages: { ...s.messages, [sessionID]: msgs },
          })
        })
        .catch((err) => handleApiError("messages reconcile", err))
    }, 300),
  )
}

function scheduleRefetch(targets: RefetchTarget[]) {
  if (refetchTimer) clearTimeout(refetchTimer)
  refetchTimer = setTimeout(() => {
    refetchTimer = null
    const state = useNexus.getState()
    if (state.connection.status !== "online") return
    void Promise.all([
      targets.includes("commands")
        ? api.listCommands().then((commands) => ({ commands }))
        : null,
      targets.includes("agents")
        ? api.listAgents().then((agents) => ({ agents }))
        : null,
      targets.includes("projects")
        ? api.listProjects().then((projects) => ({ projects }))
        : null,
      targets.includes("sessions")
        ? state.resync()
        : null,
    ])
      .then((results) => {
        const patch: Partial<NexusState> = {}
        for (const r of results) {
          if (!r) continue
          Object.assign(patch, r)
        }
        if (Object.keys(patch).length > 0) {
          useNexus.setState({
            ...patch,
            pendingRefetch: [],
          } as Partial<NexusState>)
        }
      })
      .catch((err) => handleApiError("list refetch", err))
  }, 500)
}

// ---------------------------------------------------------------------------
// error handling (§9)

function toast(kind: "error" | "info", text: string) {
  useNexus.setState({ toast: { kind, text } })
  setTimeout(() => {
    const current = useNexus.getState().toast
    if (current?.text === text) useNexus.setState({ toast: null })
  }, 5000)
}

function handleApiError(endpoint: string, err: unknown) {
  if (err instanceof ApiError) {
    console.warn(`[nexus] ${endpoint} failed:`, err.status, err.tag, err.message)
    if (err.status === 401 && err.tag === "UnauthorizedError") {
      toast("error", "Authentication stale — retrying")
      if (authRetryTimer) clearTimeout(authRetryTimer)
      // the proxy re-reads service.json per request, so retry usually heals
      authRetryTimer = setTimeout(() => {
        authRetryTimer = null
        void useNexus.getState().resync()
      }, 2000)
      return
    }
    if (err.status === 409) {
      toast("error", "Session is busy")
      return
    }
    toast("error", `${endpoint}: ${err.message}`)
    return
  }
  console.warn(`[nexus] ${endpoint} failed:`, err)
  toast("error", `${endpoint} failed — see console`)
}

// ---------------------------------------------------------------------------

export const useNexus = create<NexusState>()((set, get) => {
  /**
   * Directory for new sessions / session listings: the project selected in the
   * sidebar, else the most recently active project (projects carry time.active).
   */
  function activeDirectory(): string | undefined {
    const { projects, activeProjectId } = get()
    if (activeProjectId) {
      return projects.find((p) => p.id === activeProjectId)?.canonical
    }
    const newest = [...projects].sort(
      (a, b) => (b.time.active ?? b.time.updated) - (a.time.active ?? a.time.updated),
    )[0]
    return newest?.canonical
  }

  async function resync(): Promise<void> {
    const gen = get().syncGeneration + 1
    set({ syncGeneration: gen })
    const fresh = () => get().syncGeneration === gen
    try {
      const info = await api.info()
      if (!fresh()) return
      const urls = Array.isArray(info.urls) ? (info.urls as string[]) : []
      set({
        connection: {
          ...get().connection,
          status: "online",
          version: info.version ?? null,
          url: urls[0] ?? null,
          hostname: typeof info.hostname === "string" ? info.hostname : null,
        },
      })
      const sessions = await api.listSessions(activeDirectory())
      if (!fresh()) return
      set({
        sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
        sessionOrder: sessions.map((s) => s.id),
        // heal a stuck busy flag: a session with time.idle set is not running
        // (covers a missed execution.succeeded during an SSE drop)
        busy: Object.fromEntries(
          sessions.map((s) => [s.id, s.time.idle === undefined && (get().busy[s.id] ?? false)]),
        ),
      })
      const activeId = get().activeSessionId
      if (activeId) {
        const msgs = await api.listMessages(activeId)
        if (!fresh()) return
        set({ messages: { ...get().messages, [activeId]: msgs } })
      }
      const [commands, agents, projects] = await Promise.all([
        api.listCommands(),
        api.listAgents(),
        api.listProjects(),
      ])
      if (!fresh()) return
      set({
        commands,
        agents,
        projects,
        pendingRefetch: [],
      })
    } catch (err) {
      if (!fresh()) return
      if (err instanceof ApiError) {
        handleApiError("resync", err)
        if (!(err.status === 401 && err.tag === "UnauthorizedError")) {
          set({ connection: { ...get().connection, status: "offline" } })
        }
        return
      }
      set({ connection: { ...get().connection, status: "offline" } })
      handleApiError("resync", err)
    }
  }

  return {
    connection: {
      status: "connecting",
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
    commands: [],
    agents: [],
    projects: [],
    activeProjectId: null,
    toast: null,
    pendingReconcile: null,
    pendingRefetch: [],
    pendingPermissions: 0,

    bootstrap() {
      return resync()
    },

    async setActiveSession(id) {
      set({ activeSessionId: id })
      if (id === null) return
      const gen = get().syncGeneration
      try {
        const msgs = await api.listMessages(id)
        // a session switch during the fetch invalidates this result
        if (get().syncGeneration !== gen || get().activeSessionId !== id) return
        set({ messages: { ...get().messages, [id]: msgs } })
      } catch (err) {
        handleApiError("listMessages", err)
      }
    },

    async newSession() {
      const directory = activeDirectory()
      if (!directory) {
        toast("error", "No project selected — cannot create a session")
        return
      }
      try {
        const session = await api.createSession(directory)
        set({
          sessions: { ...get().sessions, [session.id]: session },
          sessionOrder: [session.id, ...get().sessionOrder.filter((id) => id !== session.id)],
          activeSessionId: session.id,
          messages: { ...get().messages, [session.id]: [] },
        })
      } catch (err) {
        handleApiError("createSession", err)
      }
    },

    async sendPrompt(text) {
      const sessionID = get().activeSessionId
      if (!sessionID) return
      const tempId = "tmp_" + crypto.randomUUID()
      const optimistic: ChatMessage = {
        id: tempId,
        sessionID,
        role: "user",
        parts: [{ type: "text", text }],
        time: { created: Date.now() },
      }
      set({
        messages: {
          ...get().messages,
          [sessionID]: [...(get().messages[sessionID] ?? []), optimistic],
        },
      })
      try {
        const res = (await api.prompt(sessionID, { text })) as {
          id?: string
        } | null
        // replace the temp message using the canonical id (§7 rule 1)
        const s = get()
        const msgs = s.messages[sessionID] ?? []
        const realId = typeof res?.id === "string" ? res.id : null
        set({
          messages: {
            ...s.messages,
            [sessionID]: realId
              ? msgs.map((m) => (m.id === tempId ? { ...m, id: realId } : m))
              : msgs,
          },
        })
      } catch (err) {
        // remove temp + toast
        const s = get()
        set({
          messages: {
            ...s.messages,
            [sessionID]: (s.messages[sessionID] ?? []).filter(
              (m) => m.id !== tempId,
            ),
          },
        })
        handleApiError("prompt", err)
      }
    },

    async sendSlashCommand(name, rest) {
      const sessionID = get().activeSessionId
      if (!sessionID) return
      try {
        await api.runCommand(sessionID, { name, text: rest })
        // the resulting user/assistant flow arrives via SSE
      } catch (err) {
        handleApiError("command", err)
      }
    },

    async interruptActive() {
      const sessionID = get().activeSessionId
      if (!sessionID || !get().busy[sessionID]) return
      try {
        const res = await api.interrupt(sessionID)
        if (res.interrupted) {
          set({ busy: { ...get().busy, [sessionID]: false } })
        }
        // interrupted:false → silent (button already hidden when not busy)
      } catch (err) {
        handleApiError("interrupt", err)
      }
    },

    resync,

    applyEvent(e) {
      const prev = get()
      const next = applyEvent(prev, e)
      // stamp liveness; consumers must select primitives off `connection`,
      // never the object itself (it changes on every event)
      set({
        ...next,
        connection: { ...next.connection, lastEventAt: e.created },
      })
      // consume scheduling markers set by the pure reducer (§4 table)
      if (
        next.pendingReconcile !== prev.pendingReconcile &&
        next.pendingReconcile
      ) {
        scheduleReconcile(next.pendingReconcile.sessionID)
      }
      if (next.pendingRefetch.length > 0 && prev.pendingRefetch.length === 0) {
        scheduleRefetch(next.pendingRefetch)
      } else if (next.pendingRefetch.length > 0) {
        scheduleRefetch(next.pendingRefetch)
      }
    },
  }
})

// dev-only debug handle (T10 drills, browser-console verification)
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__nexus = useNexus
}
