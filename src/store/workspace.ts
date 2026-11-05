// Workspace store (SPEC-PHASE3 §4.2): on-demand tab data for History,
// Projects/Worktrees, System extensions and the memory viewer. Separate from
// the nexus event store — different cadence (on-demand), keeps the SSE event
// path untouched. Selector rule (Phase 2): module-level EMPTY_* constants;
// components select stable references, never freshly-built arrays.

import { create } from "zustand"

import { api } from "@/lib/opencode/client"
import type {
  McpServerInfo,
  PluginInfo,
  SessionCursor,
  SessionInfo,
  SkillInfo,
  WorktreeDirectory,
} from "@/lib/opencode/types"

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

  // system / extensions
  skills: SkillInfo[] | null
  plugins: PluginInfo[] | null
  mcpServers: McpServerInfo[] | null
  extensionsStatus: "idle" | "loading" | "error"
  loadExtensions(force?: boolean): Promise<void>

  // memory viewer
  memory: Record<MemoryFileId, MemoryFileEntry>
  loadMemoryFile(id: MemoryFileId): Promise<void>
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
      set({
        historyResults: res.sessions,
        historyCursor: res.cursor,
        historyLoading: false,
      })
    } catch (err) {
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
