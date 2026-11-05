// Agents view (SPEC-PHASE3 §2): live agent/subagent graph. The graph is a
// pure projection — nodes/edges derive in useMemo from the stable nexus
// sessions/busy references (NO store slice: building arrays inside a selector
// would loop useSyncExternalStore — zustand v5 hazard). Owns the ONLY poll:
// 5 s reconciliation while this view is visible (§2.2, single-slot budget).

import { Suspense, lazy, useEffect, useMemo } from "react"
import { Globe, Network } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"

import { buildGraph, layoutForest, resolveModes } from "./graph"
import { AgentDetailPanel } from "./AgentDetailPanel"

// xyflow lives only in this lazy chunk (§12.3 bundle risk)
const AgentGraphCanvas = lazy(() => import("./AgentGraphCanvas"))

export function AgentGraphView({
  onOpenSession,
}: {
  onOpenSession(id: string): void
}) {
  // stable object references — patched, never rebuilt wholesale
  const sessions = useNexus((s) => s.sessions)
  const busy = useNexus((s) => s.busy)
  const agents = useNexus((s) => s.agents)
  const activeProjectId = useNexus((s) => s.activeProjectId)
  const projects = useNexus((s) => s.projects)

  const graphScopeAll = useWorkspace((s) => s.graphScopeAll)
  const activeMap = useWorkspace((s) => s.activeMap)
  const selectedGraphNode = useWorkspace((s) => s.selectedGraphNode)
  const toggleGraphScopeAll = useWorkspace((s) => s.toggleGraphScopeAll)
  const refreshActiveMap = useWorkspace((s) => s.refreshActiveMap)

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

  const { nodes, edges, positions } = useMemo(() => {
    const graph = buildGraph(
      sessions,
      busy,
      activeMap,
      scopeProjectId,
      resolveModes(agents),
    )
    return { ...graph, positions: layoutForest(graph.nodes, graph.edges) }
  }, [sessions, busy, activeMap, scopeProjectId, agents])

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
            {nodes.length} node{nodes.length === 1 ? "" : "s"} ·{" "}
            {edges.length} edge{edges.length === 1 ? "" : "s"} · 5 s sync
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
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Loading graph…
              </div>
            }
          >
            <AgentGraphCanvas
              nodes={nodes}
              edges={edges}
              positions={positions}
            />
          </Suspense>
        </div>
        {selected && (
          <AgentDetailPanel
            node={selected}
            projectPath={selectedProject}
            onOpenInChat={onOpenSession}
          />
        )}
      </div>
    </div>
  )
}
