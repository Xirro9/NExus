// Agents view (SPEC-PHASE3 §2 + P0 session control): live agent/subagent
// graph AND a practical list view, sharing one projection. The graph is a
// pure projection — nodes/edges derive in useMemo from the stable nexus
// sessions/busy references (NO store slice: building arrays inside a selector
// would loop useSyncExternalStore — zustand v5 hazard). Owns the ONLY poll:
// 5 s reconciliation while this view is visible (§2.2, single-slot budget).
//
// P0 controls: status/priority filters, sort, bulk selection (list), End All
// Active, per-node context menus + End buttons, and confirm-gated destructive
// actions. Priority is Jerry-side organization ONLY — OpenCode has no
// scheduling API, so the UI labels it accordingly.

import { Suspense, lazy, useEffect, useMemo, useState } from "react"
import { Globe, List, Network, Radar, Square, Trash2, X } from "lucide-react"

import {
  SESSION_PRIORITIES,
  type SessionPriority,
} from "@/lib/sessionPriority"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"

import { buildGraph, layoutForest, resolveModes, type AgentNode } from "./graph"
import { AgentDetailPanel } from "./AgentDetailPanel"
import { AgentListView, type AgentSort } from "./AgentListView"
import { useSessionActions } from "./sessionActions"

// xyflow lives only in this lazy chunk (§12.3 bundle risk)
const AgentGraphCanvas = lazy(() => import("./AgentGraphCanvas"))

type ViewMode = "graph" | "list"
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

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "graph",
  )
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [priorityFilter, setPriorityFilter] = useState<"all" | SessionPriority>("all")
  const [sort, setSort] = useState<AgentSort>("activity")
  const [selectedSet, setSelectedSet] = useState<Set<string>>(() => new Set())

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

  const runningIds = useMemo(
    () => nodes.filter((n) => n.status === "running").map((n) => n.id),
    [nodes],
  )

  const setView = (v: ViewMode) => {
    setViewMode(v)
    localStorage.setItem(VIEW_KEY, v)
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
          {viewMode === "list" && visibleNodes.length > 0 && (
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
          <div
            className="flex overflow-hidden rounded-lg border border-border"
            role="group"
            aria-label="View mode"
          >
            {(
              [
                ["graph", Network],
                ["list", List],
              ] as const
            ).map(([mode, Icon]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-pressed={viewMode === mode}
                className={
                  "flex h-7 items-center gap-1 px-2 text-[11px] transition-colors " +
                  (viewMode === mode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                <Icon className="size-3.5" aria-hidden />
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* bulk bar (list selection) */}
      {viewMode === "list" && selectedSet.size > 0 && (
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

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Suspense fallback={<GraphFallback label="Loading graph…" />}>
            {viewMode === "list" ? (
              <AgentListView
                nodes={visibleNodes}
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
            ) : visibleNodes.length === 0 ? (
              <GraphEmpty scoped={!graphScopeAll} filtered={statusFilter !== "all" || priorityFilter !== "all"} />
            ) : (
              <AgentGraphCanvas
                nodes={visibleNodes}
                edges={edges.filter(
                  (e) =>
                    visibleNodes.some((n) => n.id === e.source) &&
                    visibleNodes.some((n) => n.id === e.target),
                )}
                positions={positions}
                callbacks={{
                  onContextMenu: (e, id) => actions.openMenu(e, id),
                  onEnd: (id) => actions.requestStop([id], "terminate"),
                }}
              />
            )}
          </Suspense>
        </div>
        {selected && (
          <AgentDetailPanel
            node={selected}
            projectPath={selectedProject}
            onOpenInChat={onOpenSession}
            onEnd={(id) => actions.requestStop([id], "terminate")}
            onDelete={(id) => actions.requestDelete([id])}
            onCopy={(id) => actions.copySessionId(id)}
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
