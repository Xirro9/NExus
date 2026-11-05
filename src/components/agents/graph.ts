// Pure agent/subagent graph projection (SPEC-PHASE3 §2.1–2.3).
// No React, no store — unit-testable. The graph is a projection of the nexus
// sessions + busy maps plus the server-truth active map (GET /api/session/active);
// every SSE signal is already ingested by the Phase 1 reducer.

import type { SessionInfo } from "@/lib/opencode/types"

export type AgentNodeStatus =
  | "running"
  | "idle"
  | "succeeded"
  | "failed"
  | "interrupted"

export interface AgentNode {
  id: string // sessionID
  parentId: string | null
  agent: string // "build", "reviewer", … (fallback "build")
  agentMode: "primary" | "subagent" | "all" // resolved from the agents list
  title: string
  status: AgentNodeStatus
  tokens: number // sum of the five TokenUsage classes
  cost: number
  createdAt: number
  updatedAt: number
  depth: number // 0 = root
}

export interface AgentEdge {
  id: string
  source: string
  target: string
}

type AgentModes = Record<string, "primary" | "subagent" | "all">

/** Resolve Agent.Info.mode with a safe fallback (build = primary). */
export function resolveModes(agents: { id: string; name: string; mode: string }[]): AgentModes {
  const modes: AgentModes = {}
  for (const a of agents) {
    if (a.mode === "primary" || a.mode === "subagent" || a.mode === "all") {
      modes[a.name] = a.mode
    }
  }
  return modes
}

/**
 * Build the forest. Scope: sessions of scopeProjectId (null = all projects).
 * Children whose parent is not in scope promote to roots (edge dropped).
 */
export function buildGraph(
  sessions: Record<string, SessionInfo>,
  busy: Record<string, boolean>,
  activeMap: Record<string, { type: "running" }> | null,
  scopeProjectId: string | null,
  agentModes: AgentModes = {},
): { nodes: AgentNode[]; edges: AgentEdge[] } {
  const all = Object.values(sessions)
  const inScope = scopeProjectId
    ? all.filter((s) => s.projectID === scopeProjectId)
    : all
  const scopeIds = new Set(inScope.map((s) => s.id))

  const nodes: AgentNode[] = inScope.map((s) => {
    // status priority: busy → activeMap → outcome ?? idle
    let status: AgentNodeStatus
    if (busy[s.id] === true) status = "running"
    else if (activeMap && activeMap[s.id]) status = "running"
    else status = s.outcome ?? "idle"
    const t = s.tokens
    return {
      id: s.id,
      parentId: s.parentID && scopeIds.has(s.parentID) ? s.parentID : null,
      agent: s.agent ?? "build",
      agentMode: agentModes[s.agent ?? "build"] ?? "primary",
      title: s.title || "Untitled session",
      status,
      tokens: t
        ? (t.input ?? 0) +
          (t.output ?? 0) +
          (t.reasoning ?? 0) +
          (t.cache?.read ?? 0) +
          (t.cache?.write ?? 0)
        : 0,
      cost: s.cost ?? 0,
      createdAt: s.time.created,
      updatedAt: s.time.updated,
      depth: 0, // filled below
    }
  })

  const edges: AgentEdge[] = nodes
    .filter((n) => n.parentId !== null)
    .map((n) => ({ id: `${n.parentId}->${n.id}`, source: n.parentId!, target: n.id }))

  // depth = longest parent chain (shallow forest in practice; code handles more)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    let depth = 0
    let cursor: AgentNode | undefined = n
    const seen = new Set<string>([n.id]) // cycle guard (defensive)
    while (cursor?.parentId) {
      depth++
      if (seen.has(cursor.parentId)) break
      seen.add(cursor.parentId)
      cursor = byId.get(cursor.parentId)
    }
    n.depth = depth
  }

  return { nodes, edges }
}

/**
 * Deterministic tidy forest (§2.3, no dagre):
 * 1. roots ordered by createdAt desc, laid out left→right at x = i × 300
 * 2. leaves of each tree stack vertically (y = running cursor × 130)
 * 3. parent y = mean of its children y; x offset +240 px per depth ≥ 1
 */
export function layoutForest(
  nodes: AgentNode[],
  edges: AgentEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const childrenOf = new Map<string, string[]>()
  const nodeIds = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    const arr = childrenOf.get(e.source) ?? []
    arr.push(e.target)
    childrenOf.set(e.source, arr)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const roots = nodes
    .filter((n) => n.parentId === null || !byId.has(n.parentId))
    .sort((a, b) => b.createdAt - a.createdAt)

  const placed = new Set<string>()

  function place(id: string, rootX: number): number {
    if (placed.has(id)) return positions.get(id)!.y
    placed.add(id)
    const node = byId.get(id)!
    const children = (childrenOf.get(id) ?? [])
      .map((cid) => byId.get(cid))
      .filter((c): c is AgentNode => Boolean(c))
      .sort((a, b) => a.createdAt - b.createdAt)
    let y: number
    if (children.length === 0) {
      y = leafCursor * 130
      leafCursor++
    } else {
      const ys = children.map((c) => place(c.id, rootX))
      y = ys.reduce((a, b) => a + b, 0) / ys.length
    }
    positions.set(id, { x: rootX + 240 * node.depth, y })
    return y
  }

  let leafCursor = 0
  roots.forEach((root, i) => {
    place(root.id, i * 300)
  })

  // orphans not reached through placement (cycle guard) — stack at the end
  for (const n of nodes) {
    if (!placed.has(n.id)) {
      positions.set(n.id, { x: 0, y: leafCursor * 130 })
      leafCursor++
    }
  }

  return positions
}
