// Agents view (SPEC-PHASE3 §2 + P0 session control + Phase D): live
// agent/subagent activity in THREE views sharing one projection — tree
// (plain-DOM forest, the default), graph (lazy xyflow canvas), and a
// practical list. The projection derives in useMemo from the stable nexus
// sessions/busy references (NO store slice: building arrays inside a selector
// would loop useSyncExternalStore — zustand v5 hazard). Owns the ONLY poll:
// 5 s reconciliation while this tab is visible (§2.2, single-slot budget).
//
// P0 controls: status/priority filters, sort (list), shared search (filters
// list/tree, highlights graph), bulk selection (list + tree), End All Active,
// per-node context menus + End buttons, and confirm-gated destructive
// actions. Priority is Jerry-side organization ONLY — OpenCode has no
// scheduling API, so the UI labels it accordingly.
//
// Phase D additions: subtree collapse persisted per view-switch (shared by
// tree + graph), delegation task text derived from loaded parent
// conversations, and the AgentInspector replacing the old facts panel.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react"
import { Globe, List, ListTree, Network, Radar, Search, Square, Trash2, X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import {
  SESSION_PRIORITIES,
  type SessionPriority,
} from "@/lib/sessionPriority"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"

import {
  buildGraph,
  layoutForest,
  parentIdsOf,
  resolveModes,
  type AgentNode,
} from "./graph"
import { AgentInspector } from "./AgentInspector"
import { AgentListView, type AgentSort } from "./AgentListView"
import { AgentTreeView } from "./AgentTreeView"
import { useSessionActions } from "./sessionActions"
import { collectDelegations } from "./delegation"
import {
  descendantIds,
  filterTreeVisible,
  loadCollapsedSet,
  saveCollapsedSet,
  searchMatchIds,
  toggleCollapsed,
} from "./treeModel"

// xyflow lives only in this lazy chunk (§12.3 bundle risk)
const AgentGraphCanvas = lazy(() => import("./AgentGraphCanvas"))

/** Segmented Tree|Graph|List switch — same sliding-pill treatment as the
 *  chat header's Chat|Activity toggle (Phase C), so the two toolbars read
 *  as one system. Reduced motion collapses the pill travel. */
const VIEW_MODES: [ViewMode, typeof ListTree, string][] = [
  ["tree", ListTree, "Tree"],
  ["graph", Network, "Graph"],
  ["list", List, "List"],
]

function ViewModeSwitch({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode
  onChange(mode: ViewMode): void
}) {
  const reduced = useReducedMotion()
  return (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex shrink-0 rounded-lg border border-border/80 bg-card/60 p-0.5"
    >
      {VIEW_MODES.map(([mode, Icon, label]) => {
        const active = viewMode === mode
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            aria-label={`${label} view`}
            onClick={() => onChange(mode)}
            className={
              "relative rounded-md px-2 py-1 text-[11px] leading-none transition-colors duration-150 " +
              (active
                ? "font-medium text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {active && (
              <motion.span
                layoutId="agents-view-pill"
                aria-hidden
                className="absolute inset-0 rounded-md bg-secondary shadow-sm shadow-black/20"
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", bounce: 0.18, duration: 0.32 }
                }
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1">
              <Icon className="size-3.5" aria-hidden />
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

type ViewMode = "tree" | "graph" | "list"
type StatusFilter = "all" | AgentNode["status"]

const VIEW_KEY = "nexus.agentsViewMode"

export function AgentGraphView({
  onOpenSession,
}: {
  onOpenSession(id: string): void
}) {
  // stable object references — patched, never rebuilt wholesale
  const sessions = useNexus((s) => s.sessions)
  const busy = useNexus((s) => s.busy)
  const agents = useNexus((s) => s.agents)
  const priorities = useNexus((s) => s.priorities)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const projects = useNexus((s) => s.projects)

  const graphScopeAll = useWorkspace((s) => s.graphScopeAll)
  const activeMap = useWorkspace((s) => s.activeMap)
  const selectedGraphNode = useWorkspace((s) => s.selectedGraphNode)
  const toggleGraphScopeAll = useWorkspace((s) => s.toggleGraphScopeAll)
  const refreshActiveMap = useWorkspace((s) => s.refreshActiveMap)

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const raw = localStorage.getItem(VIEW_KEY)
    return raw === "list" || raw === "graph" ? raw : "tree"
  })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [priorityFilter, setPriorityFilter] = useState<"all" | SessionPriority>("all")
  const [sort, setSort] = useState<AgentSort>("activity")
  const [selectedSet, setSelectedSet] = useState<Set<string>>(() => new Set())
  // shared search — filters list/tree (ancestor-preserving), highlights graph
  const [search, setSearch] = useState("")
  // subtree collapse — persisted, shared between tree rows and graph nodes
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedSet)

  const actions = useSessionActions({ onOpenSession })

  // the ONLY new poll (5 s, this tab visible only): server-truth active map +
  // session reconciliation (spawns missed during SSE gaps, outcome healing)
  useEffect(() => {
    void refreshActiveMap()
    void useNexus.getState().reconcileSessions()
    const timer = setInterval(() => {
      void refreshActiveMap()
      void useNexus.getState().reconcileSessions()
    }, 5000)
    return () => clearInterval(timer)
  }, [refreshActiveMap])

  const scopeProjectId = graphScopeAll ? null : activeProjectId

  const { nodes, edges, positions, runningCount } = useMemo(() => {
    const graph = buildGraph(
      sessions,
      busy,
      activeMap,
      scopeProjectId,
      resolveModes(agents),
      priorities,
    )
    return {
      ...graph,
      positions: layoutForest(graph.nodes, graph.edges),
      runningCount: graph.nodes.filter((n) => n.status === "running").length,
    }
  }, [sessions, busy, activeMap, scopeProjectId, agents, priorities])

  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (n) =>
          (statusFilter === "all" || n.status === statusFilter) &&
          (priorityFilter === "all" || n.priority === priorityFilter),
      ),
    [nodes, statusFilter, priorityFilter],
  )

  // delegation task text (D1): derived from whatever parent conversations
  // are already loaded — real data only, no fetching here. The messages
  // record is rebuilt on EVERY streaming event, so the rescan is gated on a
  // cheap per-parent message-count signature, not the record identity.
  const messages = useNexus((s) => s.messages)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const parentIds = useMemo(
    () => new Set(nodes.filter((n) => n.parentId !== null).map((n) => n.parentId!)),
    [nodes],
  )
  const parentMsgSignature = useMemo(
    () => [...parentIds].map((id) => messages[id]?.length ?? -1).join(","),
    [parentIds, messages],
  )
  const delegations = useMemo(
    () => {
      // parentMsgSignature is an intentional rescan gate (see above) — the
      // scan reads through messagesRef so streaming deltas don't re-run it
      void parentMsgSignature
      return collectDelegations(messagesRef.current, parentIds)
    },
    [parentIds, parentMsgSignature],
  )
  const taskText = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [child, d] of delegations) {
      if (d.description) map[child] = d.description
    }
    return map
  }, [delegations])

  const searching = search.trim() !== ""
  const matches = useMemo(
    () => searchMatchIds(visibleNodes, search, taskText),
    [visibleNodes, search, taskText],
  )
  // tree: search keeps ancestors so the forest stays connected
  const treeNodes = useMemo(
    () => (searching ? filterTreeVisible(visibleNodes, (id) => matches.has(id)) : visibleNodes),
    [searching, visibleNodes, matches],
  )
  // list: flat filter
  const listNodes = useMemo(
    () => (searching ? visibleNodes.filter((n) => matches.has(n.id)) : visibleNodes),
    [searching, visibleNodes, matches],
  )
  // graph: search HIGHLIGHTS (D4.2) instead of filtering — structure stays
  const graphHighlight = searching ? matches : null

  // subtree collapse (D4.1): hidden descendants + relayout on visible nodes
  // only (layoutForest accepts arbitrary node sets — orphans promote to roots)
  const collapsedHidden = useMemo(() => {
    if (collapsed.size === 0) return null
    const hidden = new Set<string>()
    for (const id of collapsed) {
      for (const d of descendantIds(nodes, id)) hidden.add(d)
    }
    return hidden
  }, [collapsed, nodes])
  const graphNodes = useMemo(
    () =>
      collapsedHidden
        ? visibleNodes.filter((n) => !collapsedHidden.has(n.id))
        : visibleNodes,
    [visibleNodes, collapsedHidden],
  )
  const graphEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          graphNodes.some((n) => n.id === e.source) &&
          graphNodes.some((n) => n.id === e.target),
      ),
    [edges, graphNodes],
  )
  const graphPositions = useMemo(
    () => (collapsedHidden ? layoutForest(graphNodes, graphEdges) : positions),
    [collapsedHidden, graphNodes, graphEdges, positions],
  )
  // hasChildren for the graph chevrons derives from the UNFILTERED edges —
  // collapsed subtrees lose their edges in graphEdges, and a chevron derived
  // from those could never re-expand (one-way trap, designer fix 1)
  const graphHasChildIds = useMemo(() => parentIdsOf(edges), [edges])

  const runningIds = useMemo(
    () => nodes.filter((n) => n.status === "running").map((n) => n.id),
    [nodes],
  )

  const setView = (v: ViewMode) => {
    setViewMode(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = toggleCollapsed(prev, id)
      saveCollapsedSet(next)
      return next
    })
  }

  const setSelectedIds = (ids: string[]) => {
    setSelectedSet(new Set(ids))
  }

  const toggleSelected = (id: string) => {
    setSelectedSet((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelectedSet((prev) => {
      if (visibleNodes.length > 0 && visibleNodes.every((n) => prev.has(n.id))) {
        return new Set()
      }
      return new Set(visibleNodes.map((n) => n.id))
    })
  }

  const selectIdle = () => {
    // "clean up completed": select everything not running in the current view
    setSelectedSet(
      new Set(visibleNodes.filter((n) => n.status !== "running").map((n) => n.id)),
    )
  }

  const selected = selectedGraphNode
    ? (nodes.find((n) => n.id === selectedGraphNode) ?? null)
    : null
  const selectedProject = selected
    ? (projects.find((p) => p.id === sessions[selected.id]?.projectID)?.canonical ??
      null)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Network className="size-4 text-primary" aria-hidden />
          Agent activity
        </h1>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-muted-foreground/80">
            {runningCount} running · {nodes.length} session
            {nodes.length === 1 ? "" : "s"} · 5 s sync
          </span>
          <button
            type="button"
            onClick={toggleGraphScopeAll}
            aria-pressed={graphScopeAll}
            className={
              "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors " +
              (graphScopeAll
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            <Globe className="size-3.5" aria-hidden />
            {graphScopeAll ? "All projects" : "Active project"}
          </button>
        </div>
      </div>

      {/* control row: filters + view toggle + global actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
          className="h-7 cursor-pointer rounded-lg border border-border bg-input/60 px-1.5 font-mono text-[11px] text-foreground"
        >
          <option value="all">status: all</option>
          <option value="running">running</option>
          <option value="idle">idle</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="interrupted">interrupted</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(e) =>
            setPriorityFilter(e.target.value as "all" | SessionPriority)
          }
          aria-label="Filter by Jerry-side priority"
          className="h-7 cursor-pointer rounded-lg border border-border bg-input/60 px-1.5 font-mono text-[11px] text-foreground"
        >
          <option value="all">priority: all</option>
          {SESSION_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {viewMode === "list" && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as AgentSort)}
            aria-label="Sort sessions"
            className="h-7 cursor-pointer rounded-lg border border-border bg-input/60 px-1.5 font-mono text-[11px] text-foreground"
          >
            <option value="activity">sort: activity</option>
            <option value="priority">sort: priority</option>
            <option value="duration">sort: duration</option>
          </select>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label
            className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-input/60 px-2"
            title="Search by title, agent type, or delegation task"
          >
            <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions…"
              aria-label="Search sessions by title, agent, or task"
              className="w-32 bg-transparent font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none sm:w-36"
            />
          </label>
          {viewMode !== "graph" && visibleNodes.length > 0 && (
            <button
              type="button"
              onClick={selectIdle}
              className="h-7 rounded-lg border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              title="Select all non-running sessions for cleanup"
            >
              Select idle
            </button>
          )}
          <button
            type="button"
            disabled={runningIds.length === 0}
            onClick={() => actions.requestStop(runningIds, "terminate")}
            className={
              "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors " +
              (runningIds.length === 0
                ? "cursor-not-allowed border-border/50 text-muted-foreground/40"
                : "border-destructive/50 text-destructive hover:bg-destructive/10")
            }
            title={
              runningIds.length === 0
                ? "No running sessions"
                : "Stop execution + drop queued prompts for every running session (priority order)"
            }
          >
            <Square className="size-3" aria-hidden />
            End all active ({runningIds.length})
          </button>
          <ViewModeSwitch viewMode={viewMode} onChange={setView} />
        </div>
      </div>

      {/* bulk bar (list + tree selection) */}
      {selectedSet.size > 0 && (
        <div className="mx-5 mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5">
          <span className="font-mono text-[11px] text-primary">
            {selectedSet.size} selected
          </span>
          <button
            type="button"
            onClick={() => {
              const running = [...selectedSet].filter(
                (id) => nodes.find((n) => n.id === id)?.status === "running",
              )
              if (running.length > 0) actions.requestStop(running, "terminate")
            }}
            className="inline-flex h-6 items-center gap-1 rounded border border-warning/50 px-2 text-[11px] text-warning transition-colors hover:bg-warning/10"
          >
            <Square className="size-3" aria-hidden />
            Stop selected running
          </button>
          <button
            type="button"
            onClick={() => actions.requestDelete([...selectedSet])}
            className="inline-flex h-6 items-center gap-1 rounded border border-destructive/50 px-2 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="size-3" aria-hidden />
            Delete selected…
          </button>
          <button
            type="button"
            onClick={() => setSelectedSet(new Set())}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        </div>
      )}

      {runningCount > 1 && (
        <p className="shrink-0 px-5 pb-1 text-[11px] text-muted-foreground/80">
          Note: the local GLM server executes one generation at a time —
          {" "}{runningCount} running sessions are sharing the model queue.
        </p>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Suspense fallback={<GraphFallback label="Loading graph…" />}>
            {viewMode === "list" ? (
              <AgentListView
                nodes={listNodes}
                selectedId={selectedGraphNode}
                selectedSet={selectedSet}
                sort={sort}
                onSelectRow={(id) => useWorkspace.setState({ selectedGraphNode: id })}
                onToggleSelected={toggleSelected}
                onToggleSelectAll={toggleSelectAll}
                onSetSort={setSort}
                onOpenMenu={(e, id) => actions.openMenu(e, id)}
                onEnd={(id) => actions.requestStop([id], "terminate")}
              />
            ) : viewMode === "tree" ? (
              treeNodes.length === 0 ? (
                <GraphEmpty
                  scoped={!graphScopeAll}
                  filtered={statusFilter !== "all" || priorityFilter !== "all" || searching}
                />
              ) : (
                <AgentTreeView
                  nodes={treeNodes}
                  visibleIds={searching ? matches : null}
                  taskText={taskText}
                  collapsed={collapsed}
                  onToggleCollapsed={toggleCollapse}
                  selectedId={selectedGraphNode}
                  selectedSet={selectedSet}
                  onSelectRow={(id) => useWorkspace.setState({ selectedGraphNode: id })}
                  onToggleSelected={toggleSelected}
                  onSetSelected={setSelectedIds}
                  onOpenMenu={(e, id) => actions.openMenu(e, id)}
                  onEnd={(id) => actions.requestStop([id], "terminate")}
                />
              )
            ) : graphNodes.length === 0 ? (
              <GraphEmpty
                scoped={!graphScopeAll}
                filtered={statusFilter !== "all" || priorityFilter !== "all"}
              />
            ) : (
              <AgentGraphCanvas
                nodes={graphNodes}
                edges={graphEdges}
                hasChildIds={graphHasChildIds}
                positions={graphPositions}
                highlightIds={graphHighlight}
                collapsedIds={collapsed}
                callbacks={{
                  onContextMenu: (e, id) => actions.openMenu(e, id),
                  onEnd: (id) => actions.requestStop([id], "terminate"),
                  onToggleCollapse: toggleCollapse,
                }}
              />
            )}
          </Suspense>
        </div>
        {selected && (
          <AgentInspector
            node={selected}
            projectPath={selectedProject}
            onOpenInChat={onOpenSession}
            onEnd={(id) => actions.requestStop([id], "terminate")}
            onDelete={(id) => actions.requestDelete([id])}
            onCopy={(id) => actions.copySessionId(id)}
            onSelectNode={(id) => useWorkspace.setState({ selectedGraphNode: id })}
            onClose={() => useWorkspace.setState({ selectedGraphNode: null })}
          />
        )}
      </div>
      {actions.overlays}
    </div>
  )
}

/** Suspense fallback for the lazy xyflow chunk — matches the app's warm pulse. */
function GraphFallback({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-primary/70" aria-hidden />
      {label}
    </div>
  )
}

/** Zero-node state — honest "nothing is running" instead of a bare canvas. */
function GraphEmpty({ scoped, filtered }: { scoped: boolean; filtered: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Radar className="size-5 text-muted-foreground/60" aria-hidden />
      <p className="text-sm text-muted-foreground">
        {filtered ? "No sessions match the current filters." : "No agent activity yet."}
      </p>
      {!filtered && (
        <p className="max-w-[36ch] text-xs text-muted-foreground/80">
          {scoped
            ? "Sessions and subagents for the active project appear here as they run."
            : "Sessions and subagents across all projects appear here as they run."}
        </p>
      )}
      {filtered && (
        <p className="text-xs text-muted-foreground/80">
          Loosen the status or priority filter above.
        </p>
      )}
    </div>
  )
}
