// Unit tests for the pure graph helpers (Phase D): parentIdsOf — the
// collapse chevron's `hasChildren` signal must come from the UNFILTERED
// edge list so a collapsed subtree can still be re-expanded from the graph.

import { describe, expect, it } from "vitest"

import { parentIdsOf, type AgentEdge } from "./graph"

const edges: AgentEdge[] = [
  { id: "p->c1", source: "p", target: "c1" },
  { id: "p->c2", source: "p", target: "c2" },
  { id: "c1->g1", source: "c1", target: "g1" },
]

describe("parentIdsOf", () => {
  it("returns every node that appears as an edge source (a parent)", () => {
    expect(parentIdsOf(edges)).toEqual(new Set(["p", "c1"]))
  })

  it("is empty for a childless graph", () => {
    expect(parentIdsOf([])).toEqual(new Set())
  })

  it("keeps a parent whose child edges were filtered out — the collapsed-subtree case", () => {
    // graph view filters edges to visible nodes; collapsing "p" removes the
    // p->c1 / p->c2 edges. Deriving from the FILTERED list would drop "p"
    // and hide its expand chevron (one-way trap).
    const collapsedScope: AgentEdge[] = [{ id: "c1->g1", source: "c1", target: "g1" }]
    expect(parentIdsOf(collapsedScope).has("p")).toBe(false)
    expect(parentIdsOf(edges).has("p")).toBe(true)
  })
})
