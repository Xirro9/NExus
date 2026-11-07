// Pure tree-view model (Phase D1/D4): collapse persistence, search matching,
// ancestor-preserving filtering, and DFS row ordering for the Agents tab.
// No React, no store — unit-testable, same contract as graph.ts.

import type { AgentNode } from "./graph"

// ---------------------------------------------------------------------------
// collapsed-set persistence (sessionPriority pattern: try/catch load,
// save-on-change, degrade to session-scoped under quota/private mode)

const COLLAPSED_KEY = "nexus.agentTreeCollapsed.v1"

export function loadCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === "string"))
  } catch {
    return new Set()
  }
}

export function saveCollapsedSet(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    // quota/private-mode — collapse degrades to session-scoped, non-fatal
  }
}

/** Pure toggle — returns a NEW set (zustand-safe), never mutates `prev`. */
export function toggleCollapsed(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// ---------------------------------------------------------------------------
// forest helpers

/** parentId → child nodes (children whose parent is not in the set promote
 *  to roots, mirroring buildGraph's scope rule). Children sort by createdAt. */
export function childrenOf(nodes: AgentNode[]): Map<string | null, AgentNode[]> {
  const ids = new Set(nodes.map((n) => n.id))
  const map = new Map<string | null, AgentNode[]>()
  for (const n of nodes) {
    const key = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null
    const arr = map.get(key)
    if (arr) arr.push(n)
    else map.set(key, [n])
  }
  for (const arr of map.values()) arr.sort((a, b) => a.createdAt - b.createdAt)
  return map
}

/** Every descendant id of rootId EXCLUDING rootId (cycle-guarded). */
export function descendantIds(nodes: AgentNode[], rootId: string): Set<string> {
  const kids = childrenOf(nodes)
  const out = new Set<string>()
  const stack = (kids.get(rootId) ?? []).map((n) => n.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const child of kids.get(id) ?? []) stack.push(child.id)
  }
  return out
}

// ---------------------------------------------------------------------------
// search + filtering

/** Known delegation task text, keyed by CHILD session id (derived from
 *  loaded parent conversations — never fabricated). */
export type TaskText = Readonly<Record<string, string>>

/** Ids whose title / agent type / known task text contains the query
 *  (case-insensitive). An empty query returns an EMPTY set — callers treat
 *  that as "no filter", not "no matches". */
export function searchMatchIds(
  nodes: AgentNode[],
  query: string,
  taskText?: TaskText,
): Set<string> {
  const q = query.trim().toLowerCase()
  if (q === "") return new Set()
  const out = new Set<string>()
  for (const n of nodes) {
    if (
      n.title.toLowerCase().includes(q) ||
      n.agent.toLowerCase().includes(q) ||
      (taskText?.[n.id] ?? "").toLowerCase().includes(q)
    ) {
      out.add(n.id)
    }
  }
  return out
}

/** Ancestor-preserving filter: a node survives when `keep(id)` is true OR
 *  when any descendant survives (the tree must stay connected). Input order
 *  is preserved. */
export function filterTreeVisible(
  nodes: AgentNode[],
  keep: (id: string) => boolean,
): AgentNode[] {
  const kids = childrenOf(nodes)
  const kept = new Set<string>()
  const decided = new Set<string>()
  const visit = (n: AgentNode): boolean => {
    if (decided.has(n.id)) return kept.has(n.id)
    decided.add(n.id)
    let any = keep(n.id)
    for (const child of kids.get(n.id) ?? []) {
      if (visit(child)) any = true
    }
    if (any) kept.add(n.id)
    return any
  }
  for (const root of kids.get(null) ?? []) visit(root)
  // cycle-guard fallback: decide any node the root walk never reached
  for (const n of nodes) visit(n)
  return nodes.filter((n) => kept.has(n.id))
}

// ---------------------------------------------------------------------------
// row ordering

export interface TreeRow {
  node: AgentNode
  /** indent level within the RENDERED tree (promoted orphans restart at 0) */
  depth: number
}

/** Visible rows in depth-first order, honoring the collapsed set (a
 *  collapsed node's children are skipped). `visibleIds` (search matches) may
 *  be null = everything visible. */
export function treeRows(
  nodes: AgentNode[],
  collapsed: Set<string>,
  visibleIds: Set<string> | null,
): TreeRow[] {
  const kids = childrenOf(nodes)
  const rows: TreeRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (visibleIds && !visibleIds.has(n.id)) continue
      rows.push({ node: n, depth })
      if (!collapsed.has(n.id)) walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}
