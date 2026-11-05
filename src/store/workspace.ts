// Workspace store (SPEC-PHASE3 §4.2): on-demand tab data for History,
// Projects/Worktrees, System extensions and the memory viewer. Separate from
// the nexus event store — different cadence (on-demand), keeps the SSE event
// path untouched. Selector rule (Phase 2): module-level EMPTY_* constants;
// components select stable references, never freshly-built arrays.

import { create } from "zustand"

import { api } from "@/lib/opencode/client"
import {
  GRAPHIFY_INSTALL_HINT,
  buildClusterArgs,
  buildExplainArgs,
  buildExtractArgs,
  buildHubsArgs,
  buildPathArgs,
  buildQueryArgs,
  buildUpdateArgs,
  describeExecFailure,
  parseHubs,
} from "@/lib/graphify"
import { transport } from "@/lib/transport"
import type { SessionInfo } from "@/lib/opencode/types"
import type {
  McpServerInfo,
  PluginInfo,
  SessionCursor,
  SkillInfo,
  WorktreeDirectory,
} from "@/lib/opencode/types"
import type { GraphifyDetect } from "@/lib/transport/types"

export type MemoryFileId =
  | "memory"
  | "user"
  | "decisions"
  | "team"
  | "agent-architect"

export interface MemoryFileEntry {
  status: "idle" | "loading" | "ok" | "missing" | "error"
  content: string | null
  fetchedAt: number | null
}

/**
 * fs/read is host-wide — this client-side whitelist is the ONLY allowed paths
 * (SPEC-PHASE3 §4.3). Absolute paths are machine-local config, same precedent
 * as NEXUS_LLM_URL. No user-editable path input exists anywhere in the UI.
 */
export const MEMORY_FILES: {
  id: MemoryFileId
  label: string
  path: string
}[] = [
  {
    id: "memory",
    label: "MEMORY.md",
    path: "/home/mg-12623-8/.config/opencode/MEMORY.md",
  },
  {
    id: "user",
    label: "USER.md",
    path: "/home/mg-12623-8/.config/opencode/USER.md",
  },
  {
    id: "decisions",
    label: "DECISIONS.md",
    path: "/home/mg-12623-8/Documents/.opencode/memory/DECISIONS.md",
  },
  {
    id: "team",
    label: "TEAM.md",
    path: "/home/mg-12623-8/Documents/.opencode/TEAM.md",
  },
  {
    id: "agent-architect",
    label: "agents/architect.md",
    path: "/home/mg-12623-8/Documents/.opencode/agents/architect.md",
  },
]

const EMPTY_HISTORY: SessionInfo[] = []
const EMPTY_WORKTREES: WorktreeDirectory[] = []

/** Generation guard for history queries (same pattern as nexus.resync):
 *  out-of-order responses must not overwrite newer results/cursor. */
let historyGen = 0

/** In-flight `graphify --version` detection — coalesces concurrent callers.
 *  Reset on failure so an install + retry works without an app restart. */
let cliDetect: Promise<GraphifyDetect | null> | null = null

/** Merge a patch into one project's GraphifyEntry (create-on-write). */
function patchGraphEntry(
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  projectID: string,
  patch: Partial<GraphifyEntry>,
): void {
  const current = get().graphify[projectID] ?? EMPTY_ENTRY
  set({ graphify: { ...get().graphify, [projectID]: { ...current, ...patch } } })
}

export interface WorkspaceState {
  // history browser (server-side query; §6)
  historyQuery: string
  historyProjectId: string | null
  historyArchived: boolean
  historyResults: SessionInfo[]
  historyCursor: SessionCursor | null
  historyLoading: boolean
  historyError: string | null
  searchHistory(opts?: {
    query?: string
    projectId?: string | null
    archived?: boolean
  }): Promise<void>
  loadMoreHistory(): Promise<void>

  // graph support (the graph itself is storeless — derived in useMemo)
  graphScopeAll: boolean
  activeMap: Record<string, { type: "running" }> | null
  selectedGraphNode: string | null
  toggleGraphScopeAll(): void
  refreshActiveMap(): Promise<void>

  // projects / worktrees (read-only + refresh; mutations excluded §7)
  worktrees: Record<string, WorktreeDirectory[]>
  worktreeStatus: Record<string, "idle" | "loading" | "error">
  loadWorktrees(projectID: string): Promise<void>
  refreshWorktrees(projectID: string): Promise<void>
  /** Recent ROOT sessions for a project (Projects-card expand). No caching —
   *  the card owns its expanded state. Keeps api out of the component. */
  loadRecentSessions(projectID: string): Promise<SessionInfo[]>

  // system / extensions
  skills: SkillInfo[] | null
  plugins: PluginInfo[] | null
  mcpServers: McpServerInfo[] | null
  extensionsStatus: "idle" | "loading" | "error"
  loadExtensions(force?: boolean): Promise<void>

  // memory viewer
  memory: Record<MemoryFileId, MemoryFileEntry>
  loadMemoryFile(id: MemoryFileId): Promise<void>

  // session inbox (P0): queued-prompt counts for the agents detail panel.
  // null = unknown (fetch failed or never fetched) — never rendered as a fact.
  inboxCounts: Record<string, number | null>
  fetchInboxCount(sessionID: string): Promise<void>

  // graphify (docs/NOTES-SESSIONS-GRAPHIFY.md): optional per-project code
  // knowledge graphs via the official CLI. All state is on-demand + cached;
  // maintenance never blocks OpenCode execution (separate OS process).
  graphifyCli: GraphifyDetect | null
  graphify: Record<string, GraphifyEntry>
  /** projectID → timestamp of the last OBSERVED file-mutating tool call.
   *  Fed by nexus.applyEvent (SSE), cleared by a successful update. */
  graphDirty: Record<string, number>
  markGraphDirty(projectID: string): void
  clearGraphDirty(projectID: string): void
  ensureGraphifyCli(): Promise<GraphifyDetect | null>
  checkGraphStatus(projectID: string, cwd: string): Promise<void>
  /** Build the graph (missing) or incrementally update it (exists).
   *  Returns "skipped" when the graph is provably fresh (no observed source
   *  activity since the last build) so no process is spawned. */
  refreshGraph(
    projectID: string,
    cwd: string,
    skipIfClean: boolean,
  ): Promise<"ok" | "skipped" | "error" | "unavailable">
  runGraphQuery(
    cwd: string,
    kind: GraphQueryKind,
    input: string,
  ): Promise<{ ok: boolean; output: string; note: string | null }>
}

export type GraphQueryKind = "query" | "path" | "explain"

export interface GraphifyEntry {
  status:
    | "idle"
    | "checking"
    | "updating"
    | "ready"
    | "missing"
    | "error"
    | "unavailable"
  nodeCount: number | null
  edgeCount: number | null
  mtimeMs: number | null
  graphifyVersion: string | null
  lastDurationMs: number | null
  error: string | null
  hubs: { label: string; degree: number }[] | null
}

const EMPTY_ENTRY: GraphifyEntry = {
  status: "idle",
  nodeCount: null,
  edgeCount: null,
  mtimeMs: null,
  graphifyVersion: null,
  lastDurationMs: null,
  error: null,
  hubs: null,
}

function initialMemory(): Record<MemoryFileId, MemoryFileEntry> {
  return Object.fromEntries(
    MEMORY_FILES.map((f) => [
      f.id,
      { status: "idle", content: null, fetchedAt: null } satisfies MemoryFileEntry,
    ]),
  ) as Record<MemoryFileId, MemoryFileEntry>
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  historyQuery: "",
  historyProjectId: null,
  historyArchived: false,
  historyResults: [],
  historyCursor: null,
  historyLoading: false,
  historyError: null,

  async searchHistory(opts) {
    const query = opts?.query ?? get().historyQuery
    const projectId = opts?.projectId ?? get().historyProjectId
    const archived = opts?.archived ?? get().historyArchived
    const gen = ++historyGen
    set({
      historyQuery: query,
      historyProjectId: projectId,
      historyArchived: archived,
      historyLoading: true,
      historyError: null,
    })
    try {
      const res = await api.listSessionsQuery({
        ...(query !== "" ? { search: query } : {}),
        ...(projectId ? { project: projectId } : {}),
        archived: archived ? "true" : "false",
        limit: "50",
        order: "desc",
      })
      if (gen !== historyGen) return // superseded — never overwrite newer results
      set({
        historyResults: res.sessions,
        historyCursor: res.cursor,
        historyLoading: false,
      })
    } catch (err) {
      if (gen !== historyGen) return
      set({
        historyLoading: false,
        historyError: err instanceof Error ? err.message : String(err),
      })
    }
  },

  async loadMoreHistory() {
    const { historyCursor, historyLoading } = get()
    const next = historyCursor?.next
    if (!next || historyLoading) return
    const gen = ++historyGen
    set({ historyLoading: true })
    try {
      const res = await api.listSessionsQuery({
        ...(get().historyQuery !== "" ? { search: get().historyQuery } : {}),
        ...(get().historyProjectId
          ? { project: get().historyProjectId! }
          : {}),
        archived: get().historyArchived ? "true" : "false",
        limit: "50",
        order: "desc",
        cursor: next, // opaque — pass through verbatim, never inspected (§12.6)
      })
      if (gen !== historyGen) return
      set({
        // append; guard duplicates defensively (cursor overlap)
        historyResults: [
          ...get().historyResults,
          ...res.sessions.filter(
            (s) => !get().historyResults.some((r) => r.id === s.id),
          ),
        ],
        historyCursor: res.cursor,
        historyLoading: false,
      })
    } catch (err) {
      if (gen !== historyGen) return
      set({
        historyLoading: false,
        historyError: err instanceof Error ? err.message : String(err),
      })
    }
  },

  graphScopeAll: false,
  activeMap: null,
  selectedGraphNode: null,

  toggleGraphScopeAll() {
    set({ graphScopeAll: !get().graphScopeAll, selectedGraphNode: null })
  },

  async refreshActiveMap() {
    try {
      const activeMap = await api.listActiveSessions()
      set({ activeMap })
    } catch {
      // graph falls back to busy/outcome — non-fatal
      set({ activeMap: null })
    }
  },

  worktrees: {},
  worktreeStatus: {},

  async loadWorktrees(projectID) {
    set({ worktreeStatus: { ...get().worktreeStatus, [projectID]: "loading" } })
    try {
      const list = await api.listWorktrees(projectID)
      set({
        worktrees: { ...get().worktrees, [projectID]: list },
        worktreeStatus: { ...get().worktreeStatus, [projectID]: "idle" },
      })
    } catch {
      set({ worktreeStatus: { ...get().worktreeStatus, [projectID]: "error" } })
    }
  },

  async refreshWorktrees(projectID) {
    set({ worktreeStatus: { ...get().worktreeStatus, [projectID]: "loading" } })
    try {
      // read-only refresh: POST /worktree/refresh, then re-list (no mutations)
      await api.refreshWorktrees(projectID)
      const list = await api.listWorktrees(projectID)
      set({
        worktrees: { ...get().worktrees, [projectID]: list },
        worktreeStatus: { ...get().worktreeStatus, [projectID]: "idle" },
      })
    } catch {
      set({ worktreeStatus: { ...get().worktreeStatus, [projectID]: "error" } })
    }
  },

  async loadRecentSessions(projectID) {
    const res = await api.listSessionsQuery({
      project: projectID,
      parentID: "null",
      limit: "10",
      order: "desc",
    })
    return res.sessions
  },

  skills: null,
  plugins: null,
  mcpServers: null,
  extensionsStatus: "idle",

  async loadExtensions(force) {
    const { extensionsStatus, skills } = get()
    if (!force && (extensionsStatus === "loading" || skills !== null)) return
    set({ extensionsStatus: "loading" })
    try {
      const [skills, plugins, mcpServers] = await Promise.all([
        api.listSkills(),
        api.listPlugins(),
        api.listMcpServers(),
      ])
      set({ skills, plugins, mcpServers, extensionsStatus: "idle" })
    } catch {
      set({ extensionsStatus: "error" })
    }
  },

  memory: initialMemory(),

  async loadMemoryFile(id) {
    const file = MEMORY_FILES.find((f) => f.id === id)
    if (!file) return
    set({
      memory: {
        ...get().memory,
        [id]: { ...get().memory[id]!, status: "loading", content: null },
      },
    })
    try {
      const content = await api.readFsFile(file.path)
      set({
        memory: {
          ...get().memory,
          [id]: { status: "ok", content, fetchedAt: Date.now() },
        },
      })
    } catch (err) {
      const status =
        err instanceof Error && "status" in err && (err as { status?: number }).status === 404
          ? "missing"
          : "error"
      set({
        memory: {
          ...get().memory,
          [id]: { status, content: null, fetchedAt: null },
        },
      })
    }
  },

  inboxCounts: {},

  async fetchInboxCount(sessionID) {
    try {
      const entries = await api.listInbox(sessionID)
      set({
        inboxCounts: { ...get().inboxCounts, [sessionID]: entries.length },
      })
    } catch {
      // unknown ≠ zero — the panel renders "—" for null
      set({ inboxCounts: { ...get().inboxCounts, [sessionID]: null } })
    }
  },

  // --- graphify (docs/NOTES-SESSIONS-GRAPHIFY.md) ---------------------------
  // Every command here goes through the transport seam → host executor
  // (Rust command / dev middleware) with a strict arg whitelist. Nothing
  // blocks OpenCode: graphify runs as a separate OS process.

  graphifyCli: null,
  graphify: {},
  graphDirty: {},

  markGraphDirty(projectID) {
    set({ graphDirty: { ...get().graphDirty, [projectID]: Date.now() } })
  },

  clearGraphDirty(projectID) {
    if (!(projectID in get().graphDirty)) return
    const next = { ...get().graphDirty }
    delete next[projectID]
    set({ graphDirty: next })
  },

  async ensureGraphifyCli() {
    const cached = get().graphifyCli
    if (cached !== null) return cached
    cliDetect ??= transport
      .graphifyDetect()
      .catch(() => null)
      .then((d) => {
        if (d === null) {
          cliDetect = null // detect failed (not "unavailable") — allow retry
          return null
        }
        set({ graphifyCli: d })
        return d
      })
    return cliDetect
  },

  async checkGraphStatus(projectID, cwd) {
    const cli = await get().ensureGraphifyCli()
    if (cli === null || !cli.available) {
      patchGraphEntry(set, get, projectID, { status: "unavailable", error: null })
      return
    }
    patchGraphEntry(set, get, projectID, { status: "checking" })
    try {
      const st = await transport.graphifyStatus(cwd)
      patchGraphEntry(set, get, projectID, {
        status: st.found ? "ready" : "missing",
        nodeCount: st.found ? st.nodeCount : null,
        edgeCount: st.found ? st.edgeCount : null,
        mtimeMs: st.found ? st.mtimeMs : null,
        graphifyVersion: st.graphifyVersion,
        error: null,
      })
    } catch (err) {
      patchGraphEntry(set, get, projectID, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  async refreshGraph(projectID, cwd, skipIfClean) {
    const cli = await get().ensureGraphifyCli()
    if (cli === null || !cli.available) {
      patchGraphEntry(set, get, projectID, { status: "unavailable", error: null })
      return "unavailable"
    }
    let entry = get().graphify[projectID] ?? EMPTY_ENTRY
    if (entry.status === "updating") {
      patchGraphEntry(set, get, projectID, {
        error: "An update is already running",
      })
      return "error"
    }
    // No observed source activity since the last build → the hash check
    // inside `graphify update .` would be a no-op; don't spawn a process.
    if (
      skipIfClean &&
      entry.status === "ready" &&
      !(projectID in get().graphDirty)
    ) {
      return "skipped"
    }
    // Build-vs-update needs to know whether graph.json exists. If the status
    // check never ran, learn it from the cheap stat (no process) first.
    if (entry.status !== "ready" && entry.status !== "missing") {
      try {
        const st = await transport.graphifyStatus(cwd)
        entry = {
          ...entry,
          status: st.found ? "ready" : "missing",
          nodeCount: st.found ? st.nodeCount : null,
          edgeCount: st.found ? st.edgeCount : null,
          mtimeMs: st.found ? st.mtimeMs : null,
          graphifyVersion: st.graphifyVersion,
        }
      } catch (err) {
        patchGraphEntry(set, get, projectID, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        })
        return "error"
      }
    }
    const hasGraph = entry.status === "ready"
    const dirtyAtStart = get().graphDirty[projectID]
    patchGraphEntry(set, get, projectID, { status: "updating", error: null })
    try {
      let failure: string | null = null
      let durationMs = 0
      if (hasGraph) {
        // Incremental: re-parses only files whose hashes changed.
        const r = await transport.graphifyExec(cwd, buildUpdateArgs())
        durationMs = r.durationMs
        failure = describeExecFailure(r)
      } else {
        // First build: deterministic code-only extraction, then clustering.
        const ex = await transport.graphifyExec(cwd, buildExtractArgs())
        durationMs += ex.durationMs
        failure = describeExecFailure(ex)
        if (failure === null) {
          const cl = await transport.graphifyExec(cwd, buildClusterArgs())
          durationMs += cl.durationMs
          failure = describeExecFailure(cl)
        }
      }
      if (failure !== null) {
        // A failed update leaves the previous graph in place — keep "ready"
        // and surface the error; a failed first build has nothing to show.
        patchGraphEntry(set, get, projectID, {
          status: hasGraph ? "ready" : "error",
          error: failure,
          lastDurationMs: durationMs,
        })
        return "error"
      }
      // Success: re-stat for authoritative counts/mtime (the update itself
      // already succeeded, so a stat failure only keeps the old numbers).
      const counts: Partial<GraphifyEntry> = { lastDurationMs: durationMs }
      try {
        const st = await transport.graphifyStatus(cwd)
        counts.nodeCount = st.nodeCount
        counts.edgeCount = st.edgeCount
        counts.mtimeMs = st.mtimeMs
        counts.graphifyVersion = st.graphifyVersion
      } catch {
        /* keep previous counts */
      }
      patchGraphEntry(set, get, projectID, {
        status: "ready",
        error: null,
        ...counts,
      })
      // The update covered everything observed before it started. If a
      // file-edit event landed DURING the update, keep the dirty flag —
      // the graph may not include that change.
      if (get().graphDirty[projectID] === dirtyAtStart) {
        get().clearGraphDirty(projectID)
      }
      // Hubs are informational — best-effort, never fail the refresh.
      try {
        const hubs = await transport.graphifyExec(cwd, buildHubsArgs())
        const parsed = parseHubs(hubs.stdout)
        if (parsed.length > 0) {
          patchGraphEntry(set, get, projectID, { hubs: parsed })
        }
      } catch {
        /* ignore */
      }
      return "ok"
    } catch (err) {
      patchGraphEntry(set, get, projectID, {
        status: hasGraph ? "ready" : "error",
        error: err instanceof Error ? err.message : String(err),
      })
      return "error"
    }
  },

  async runGraphQuery(cwd, kind, input) {
    const cli = await get().ensureGraphifyCli()
    if (cli === null || !cli.available) {
      return {
        ok: false,
        output: "",
        note: `Graphify CLI not found — install with: ${GRAPHIFY_INSTALL_HINT}`,
      }
    }
    const trimmed = input.trim()
    if (trimmed === "") {
      return { ok: false, output: "", note: "Type a symbol or question first" }
    }
    let args: string[]
    if (kind === "path") {
      // exactly two symbols, whitespace-separated
      const [a, b] = trimmed.split(/\s+/)
      if (a === undefined || b === undefined || trimmed.split(/\s+/).length !== 2) {
        return {
          ok: false,
          output: "",
          note: "Path mode needs exactly two symbols, separated by a space",
        }
      }
      args = buildPathArgs(a, b)
    } else if (kind === "query") {
      args = buildQueryArgs(trimmed, { budget: 800 })
    } else {
      args = buildExplainArgs(trimmed)
    }
    try {
      const res = await transport.graphifyExec(cwd, args)
      const note = describeExecFailure(res)
      const stderr = res.stderr.trim()
      const output = `${res.stdout}${stderr !== "" ? `\n${stderr}` : ""}`.trim()
      // Exit 3 (ambiguous) prints candidates in stdout — keep them visible.
      return { ok: note === null, output, note }
    } catch (err) {
      return {
        ok: false,
        output: "",
        note: err instanceof Error ? err.message : String(err),
      }
    }
  },
}))

// ---------------------------------------------------------------------------
// selector hooks (stable references — zustand v5 rule)

export function useHistoryResults(): SessionInfo[] {
  return useWorkspace((s) => s.historyResults ?? EMPTY_HISTORY)
}

export function useWorktrees(projectID: string): WorktreeDirectory[] {
  return useWorkspace((s) => s.worktrees[projectID] ?? EMPTY_WORKTREES)
}

export function useMemoryFiles(): {
  files: typeof MEMORY_FILES
  entries: Record<MemoryFileId, MemoryFileEntry>
} {
  const entries = useWorkspace((s) => s.memory)
  return { files: MEMORY_FILES, entries }
}

// dev-only debug handle (browser-console verification, same as __nexus)
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__nexusWorkspace = useWorkspace
}
