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
  DefaultModelInfo,
  ModelInfo,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProjectInfo,
  SessionInfo,
} from "@/lib/opencode/types"
import {
  DEFAULT_PRIORITY,
  isSessionPriority,
  loadPriorities,
  savePriorities,
  type SessionPriority,
} from "@/lib/sessionPriority"
import type { SessionActivity } from "@/lib/agentState"
import { applyEvent, type RefetchTarget } from "./events"
import { FILE_EDIT_TOOLS } from "@/lib/graphify"
import { useWorkspace } from "./workspace"

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
  /** Per-session activity summary (Phase B §B1) — maintained by the pure
   *  reducer's SUMMARY path for ALL sessions. Field-scoped: never carries
   *  message text or deltas, so the cross-session bleed guard holds. */
  activity: Record<string, SessionActivity>
  commands: CommandInfo[]
  agents: AgentInfo[]
  projects: ProjectInfo[]
  models: ModelInfo[] // provider catalog — ctx-limit chain (SPEC-PHASE2 §4.1)
  /** GET /api/model/default — fallback display when the active session has
   *  no model yet (fresh sessions report model:null until first use). */
  defaultModel: DefaultModelInfo | null
  activeProjectId: string | null // sidebar filter
  toast: { kind: "error" | "info"; text: string } | null
  /** Jerry-side organizational priorities (localStorage-persisted). NEVER
   *  affects inference scheduling — OpenCode v2.2.5 has no priority API. */
  priorities: Record<string, SessionPriority>
  /** Chat render mode (C2, localStorage-persisted): clean conversation with
   *  compact tool cards, or the technical activity timeline. */
  chatViewMode: ChatViewMode
  // internal scheduling markers consumed by the applyEvent wrapper (§4)
  pendingReconcile: { sessionID: string; at: number } | null
  pendingRefetch: RefetchTarget[]
  pendingPermissions: number // badge count — kept equal to permissionRequests.length on every authoritative fetch
  permissionRequests: PermissionRequest[] // pending permission inbox (SPEC-PHASE3 §5)
  // actions
  bootstrap(): Promise<void>
  setActiveSession(id: string | null): Promise<void>
  newSession(): Promise<void>
  /** Resolves true when the prompt was accepted; false on failure (409 etc.)
   *  so the composer can keep the text (§9). Deviates from the spec's
   *  Promise<void> purely as a success signal — no other change. */
  sendPrompt(text: string): Promise<boolean>
  sendSlashCommand(name: string, rest: string): Promise<void>
  interruptActive(): Promise<void>
  /** Stop a session's execution from the Agents tab / sidebar.
   *  - "interrupt": interrupt the active generation only (Stop Execution).
   *  - "terminate" (End Session / Kill): interrupt AND purge queued inbox
   *    prompts (steer prompts queued after a dead run are never consumed —
   *    the known stuck-running failure mode). Conversation history is NEVER
   *    touched by either mode.
   *  Reports the actual server outcome via toasts — never a fake success. */
  stopSession(sessionID: string, mode: "interrupt" | "terminate"): Promise<void>
  /** DELETE /api/session/{id} — permanent, cascades to child sessions.
   *  Optimistic local removal; restored on failure. Destructive. */
  deleteSession(sessionID: string): Promise<void>
  /** Set the Jerry-side organizational priority (normal = unset). */
  setSessionPriority(sessionID: string, priority: SessionPriority): void
  /** Switch the chat render mode (C2) — persists to localStorage. */
  setChatViewMode(mode: ChatViewMode): void
  /** Re-fetch the pending permission list (drawer open, manual refresh). */
  refreshPermissions(): Promise<void>
  /** Agents-graph reconciliation poll (5 s, Agents-tab-visible only, §2.2):
   *  upserts sessions missed during SSE gaps and heals terminal outcomes.
   *  Best-effort — failures are silent (the SSE path stays authoritative). */
  reconcileSessions(): Promise<void>
  /** Reply to a permission request — optimistic remove, authoritative heal.
   *  ⚠ SINGLE CALL SITE for api.replyPermission (reviewer gate, §12.1):
   *  only the PermissionCard click handlers may reach this action. */
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionReply,
    message?: string,
  ): Promise<void>
  /** Switch the active session's model (POST /api/session/{id}/model).
   *  Optimistic with revert-on-error; the SSE session.updated + a sessions
   *  refetch heal authoritatively. Validates the ref against the catalog
   *  first — the server stores payloads verbatim (verified live, API-NOTES).
   *  ⚠ SINGLE CALL SITE for api.setSessionModel. */
  setSessionModel(providerID: string, modelID: string, variant?: string): Promise<void>
  resync(): Promise<void>
  applyEvent(e: NexusEvent): void
}

// ---------------------------------------------------------------------------
// chat view mode (C2) — Jerry-side UI preference, localStorage-persisted
// (same pattern as sessionPriority: validated load, save-on-change)

export type ChatViewMode = "conversation" | "activity"

const CHAT_VIEW_STORAGE_KEY = "nexus.chatViewMode.v1"

function isChatViewMode(v: unknown): v is ChatViewMode {
  return v === "conversation" || v === "activity"
}

function loadChatViewMode(): ChatViewMode {
  try {
    const raw = localStorage.getItem(CHAT_VIEW_STORAGE_KEY)
    return isChatViewMode(raw) ? raw : "conversation"
  } catch {
    return "conversation"
  }
}

function saveChatViewMode(mode: ChatViewMode): void {
  try {
    localStorage.setItem(CHAT_VIEW_STORAGE_KEY, mode)
  } catch {
    // quota/private-mode — the preference degrades to session-scoped
  }
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
      targets.includes("models")
        ? api.listModels().then((models) => ({ models }))
        : null,
      targets.includes("models")
        ? api
            .getDefaultModel()
            .catch(() => null)
            .then((defaultModel) => ({ defaultModel }))
        : null,
      targets.includes("sessions")
        ? state.resync()
        : null,
      targets.includes("permissions")
        ? api
            .listPermissionRequests()
            .then((permissionRequests) => ({ permissionRequests }))
        : null,
      // cross-store targets (SPEC-PHASE3 §4.2): workspace-owned data.
      targets.includes("worktrees") ? reloadLoadedWorktrees() : null,
      targets.includes("extensions") ? invalidateExtensions() : null,
    ])
      .then((results) => {
        const patch: Partial<NexusState> = {}
        for (const r of results) {
          if (!r) continue
          Object.assign(patch, r)
        }
        // the badge count mirrors the authoritative list length (heals
        // optimistic-removal drift and missed permission.asked events)
        if (patch.permissionRequests) {
          patch.pendingPermissions = patch.permissionRequests.length
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
// cross-store refetch handlers (workspace-owned data, §4.2)

/** worktree.updated / worktree.resolved → reload every loaded worktree list
 *  (the Projects view's visible lists), debounced by scheduleRefetch. */
function reloadLoadedWorktrees() {
  const { worktrees, loadWorktrees } = useWorkspace.getState()
  for (const projectID of Object.keys(worktrees)) {
    void loadWorktrees(projectID)
  }
}

/** skill.updated / plugin.updated / mcp.status.changed / config.updated →
 *  invalidate the extensions cache; the next System-view open refetches. */
function invalidateExtensions() {
  useWorkspace.setState({ skills: null, plugins: null, mcpServers: null })
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
      const [commands, agents, projects, models, permissionRequests, defaultModel] =
        await Promise.all([
          api.listCommands(),
          api.listAgents(),
          api.listProjects(),
          api.listModels(),
          // drawer populated on boot/reconnect (SPEC-PHASE3 §4.1)
          api.listPermissionRequests(),
          // best-effort: only the model dropdown consumes it — never let a
          // failure here degrade the whole resync to offline
          api.getDefaultModel().catch(() => null),
        ])
      if (!fresh()) return
      set({
        commands,
        agents,
        projects,
        models,
        defaultModel,
        permissionRequests,
        pendingPermissions: permissionRequests.length,
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
    activity: {},
    commands: [],
    agents: [],
    projects: [],
    models: [],
    defaultModel: null,
    activeProjectId: null,
    toast: null,
    priorities: loadPriorities(),
    chatViewMode: loadChatViewMode(),
    pendingReconcile: null,
    pendingRefetch: [],
    pendingPermissions: 0,
    permissionRequests: [],

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
      if (!sessionID) return false
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
        return true
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
        return false
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

    async stopSession(sessionID, mode) {
      if (!get().sessions[sessionID]) return
      // 1. interrupt the active generation (server answers honestly: false
      //    when the session is not executing)
      let interrupted = false
      let interruptError: string | null = null
      try {
        const res = await api.interrupt(sessionID)
        interrupted = res.interrupted === true
        if (interrupted) {
          // SSE session.execution.interrupted confirms authoritatively; this
          // optimistic clear just avoids a visible busy beat
          set({ busy: { ...get().busy, [sessionID]: false } })
        }
      } catch (err) {
        interruptError = err instanceof Error ? err.message : String(err)
      }
      // 2. terminate mode also purges queued inbox prompts (steer prompts
      //    queued behind a dead run are never consumed — the stuck-running bug)
      let purged = 0
      let purgeError: string | null = null
      if (mode === "terminate") {
        try {
          const entries = await api.listInbox(sessionID)
          for (const entry of entries) {
            try {
              await api.deleteInboxEntry(sessionID, entry.id)
              purged++
            } catch {
              // one entry vanishing mid-purge (already consumed) is non-fatal
            }
          }
        } catch (err) {
          purgeError = err instanceof Error ? err.message : String(err)
        }
      }
      // 3. report the REAL outcome — never a fabricated success
      const facts: string[] = []
      if (interrupted) facts.push("execution interrupted")
      if (purged > 0)
        facts.push(`${purged} queued prompt${purged === 1 ? "" : "s"} dropped`)
      if (interruptError) {
        toast("error", `Stop failed: ${interruptError}`)
        return
      }
      if (mode === "interrupt") {
        toast("info", interrupted ? "Execution interrupted" : "Session was not running")
      } else if (facts.length > 0) {
        toast("info", `Session ended — ${facts.join(", ")}`)
      } else {
        toast("info", "Session was idle — nothing to stop")
      }
      if (purgeError) toast("error", `Inbox purge failed: ${purgeError}`)
    },

    async deleteSession(sessionID) {
      const s = get()
      const session = s.sessions[sessionID]
      if (!session) return
      // the server cascades child sessions (verified live) — mirror that
      // locally so the tree doesn't flicker orphaned children
      const removed = new Set<string>([sessionID])
      for (const other of Object.values(s.sessions)) {
        if (other.parentID === sessionID) removed.add(other.id)
      }
      const prevSessions = s.sessions
      const prevOrder = s.sessionOrder
      const prevMessages = s.messages
      const prevPriorities = s.priorities
      const prevActivity = s.activity
      const sessions = { ...s.sessions }
      const messages = { ...s.messages }
      const activity = { ...s.activity }
      for (const id of removed) {
        delete sessions[id]
        delete messages[id]
        delete activity[id]
      }
      const priorities = { ...s.priorities }
      for (const id of removed) delete priorities[id]
      savePriorities(priorities)
      set({
        sessions,
        messages,
        priorities,
        activity,
        sessionOrder: prevOrder.filter((id) => !removed.has(id)),
        ...(s.activeSessionId && removed.has(s.activeSessionId)
          ? { activeSessionId: null }
          : {}),
      })
      try {
        await api.deleteSession(sessionID)
        // per-session session.deleted SSE events confirm; this refetch heals
        // anything the optimistic pass missed
        scheduleRefetch(["sessions"])
      } catch (err) {
        // restore — the delete did NOT happen
        set({
          sessions: prevSessions,
          sessionOrder: prevOrder,
          messages: prevMessages,
          priorities: prevPriorities,
          activity: prevActivity,
        })
        savePriorities(prevPriorities)
        handleApiError("delete session", err)
      }
    },

    setSessionPriority(sessionID, priority) {
      if (!isSessionPriority(priority)) return
      const priorities = { ...get().priorities }
      // default stays absent from storage — the map only carries overrides
      if (priority === DEFAULT_PRIORITY) delete priorities[sessionID]
      else priorities[sessionID] = priority
      savePriorities(priorities)
      set({ priorities })
    },

    setChatViewMode(mode) {
      if (!isChatViewMode(mode)) return
      saveChatViewMode(mode)
      set({ chatViewMode: mode })
    },

    async refreshPermissions() {
      try {
        const permissionRequests = await api.listPermissionRequests()
        set({ permissionRequests, pendingPermissions: permissionRequests.length })
      } catch (err) {
        handleApiError("permission requests", err)
      }
    },

    async reconcileSessions() {
      try {
        // no directory filter — children across the workspace must appear (§2.2)
        const res = await api.listSessionsQuery({ limit: "200" })
        const s = get()
        const sessions = { ...s.sessions }
        const newIds: string[] = []
        const busy = { ...s.busy }
        for (const sess of res.sessions) {
          if (!sessions[sess.id]) newIds.push(sess.id)
          sessions[sess.id] = sess
          // heal a stuck busy flag (time.idle set = not running)
          if (sess.time.idle !== undefined) busy[sess.id] = false
        }
        set({
          sessions,
          busy,
          ...(newIds.length > 0
            ? { sessionOrder: [...newIds, ...s.sessionOrder] }
            : {}),
        })
      } catch (err) {
        console.warn("[nexus] graph reconcile failed:", err)
      }
    },

    async replyPermission(sessionID, requestID, decision, message) {
      const prev = get().permissionRequests
      const removed = prev.find(
        (r) => r.id === requestID && r.sessionID === sessionID,
      )
      if (!removed) return
      const remaining = prev.filter((r) => r !== removed)
      // optimistic removal — the permission.replied refetch heals authoritatively
      set({ permissionRequests: remaining, pendingPermissions: remaining.length })
      try {
        await api.replyPermission(sessionID, requestID, decision, message)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // already resolved elsewhere — do not restore; refetch the truth
          toast("info", "Request already resolved")
          scheduleRefetch(["permissions"])
          return
        }
        set({ permissionRequests: prev, pendingPermissions: prev.length })
        handleApiError("permission reply", err)
      }
    },

    async setSessionModel(providerID, modelID, variant) {
      const sessionID = get().activeSessionId
      if (!sessionID) return
      // the server stores model refs verbatim with no validation (verified
      // live, API-NOTES) — validate against the catalog before sending
      const entry = get().models.find(
        (m) => m.providerID === providerID && m.id === modelID,
      )
      if (!entry) {
        toast("error", "Model not in the provider catalog")
        return
      }
      // the server normalizes an absent variant to "default" — send neither
      const cleanVariant = variant && variant !== "default" ? variant : undefined
      if (cleanVariant && !entry.variants?.some((v) => v.id === cleanVariant)) {
        toast("error", `Unknown variant "${cleanVariant}"`)
        return
      }
      const ref: ModelRef = {
        id: modelID,
        providerID,
        ...(cleanVariant ? { variant: cleanVariant } : {}),
      }
      // optimistic — the SSE session.updated + sessions refetch heal; revert
      // on error (409 busy, 401 auth stale, …)
      const session = get().sessions[sessionID]
      const prevModel = session?.model
      if (session) {
        set({
          sessions: { ...get().sessions, [sessionID]: { ...session, model: ref } },
        })
      }
      try {
        await api.setSessionModel(sessionID, ref)
        scheduleRefetch(["sessions"])
      } catch (err) {
        const s = get()
        const cur = s.sessions[sessionID]
        if (cur && prevModel) {
          set({
            sessions: { ...s.sessions, [sessionID]: { ...cur, model: prevModel } },
          })
        }
        handleApiError("model switch", err)
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
      if (next.pendingRefetch.length > 0) {
        scheduleRefetch(next.pendingRefetch)
      }
      // Graphify staleness bridge: a file-mutating tool call in ANY session
      // marks that project's knowledge graph dirty (workspace-owned state —
      // lives there to avoid an import cycle; see docs/NOTES-SESSIONS-GRAPHIFY)
      if (e.type === "session.tool.called") {
        const { sessionID, name } = e.data as { sessionID?: unknown; name?: unknown }
        if (
          typeof sessionID === "string" &&
          typeof name === "string" &&
          FILE_EDIT_TOOLS.has(name.toLowerCase())
        ) {
          const projectID = next.sessions[sessionID]?.projectID
          if (projectID) useWorkspace.getState().markGraphDirty(projectID)
        }
      }
    },
  }
})

// dev-only debug handle (T10 drills, browser-console verification)
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__nexus = useNexus
}
