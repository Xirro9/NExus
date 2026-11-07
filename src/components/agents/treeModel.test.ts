// Unit tests for the pure tree-view model (Phase D1/D4): collapse
// persistence (degrades gracefully without localStorage in node env),
// search matching, ancestor-preserving filtering, and DFS row ordering.

import { describe, expect, it } from "vitest"

import type { AgentNode } from "./graph"
import {
  childrenOf,
  descendantIds,
  filterTreeVisible,
  loadCollapsedSet,
  saveCollapsedSet,
  searchMatchIds,
  toggleCollapsed,
  treeRows,
} from "./treeModel"

// ---------------------------------------------------------------------------
// helpers

function makeNode(
  id: string,
  parentId: string | null,
  overrides: Partial<AgentNode> = {},
): AgentNode {
  return {
    id,
    parentId,
    agent: "build",
    agentMode: "primary",
    title: `Session ${id}`,
    status: "idle",
    priority: "normal",
    tokens: 0,
    cost: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    depth: parentId === null ? 0 : 1,
    ...overrides,
  }
}

/** parent → two children → one grandchild under the first child */
function forest(): AgentNode[] {
  return [
    makeNode("p", null, { title: "Coordinator run" }),
    makeNode("c1", "p", { agent: "reviewer", agentMode: "subagent" }),
    makeNode("c2", "p", { title: "Write specs" }),
    makeNode("g1", "c1", { agent: "architect", agentMode: "subagent" }),
  ]
}

// ---------------------------------------------------------------------------
// collapsed-set persistence + toggle

describe("collapsed set persistence", () => {
  it("loads an empty set without localStorage (node env degradation)", () => {
    expect(loadCollapsedSet()).toEqual(new Set())
  })

  it("save is a silent no-op without localStorage", () => {
    expect(() => saveCollapsedSet(new Set(["p"]))).not.toThrow()
  })
})

describe("toggleCollapsed", () => {
  it("adds an id not present and never mutates the input", () => {
    const prev = new Set(["a"])
    const next = toggleCollapsed(prev, "b")
    expect(next).toEqual(new Set(["a", "b"]))
    expect(prev).toEqual(new Set(["a"]))
  })

  it("removes an id already present", () => {
    const next = toggleCollapsed(new Set(["a", "b"]), "a")
    expect(next).toEqual(new Set(["b"]))
  })
})

// ---------------------------------------------------------------------------
// forest helpers

describe("childrenOf", () => {
  it("groups children under their parent and promotes out-of-set parents to roots", () => {
    const map = childrenOf(forest())
    expect(map.get(null)!.map((n) => n.id)).toEqual(["p"])
    expect(map.get("p")!.map((n) => n.id)).toEqual(["c1", "c2"])
    expect(map.get("c1")!.map((n) => n.id)).toEqual(["g1"])
  })

  it("sorts siblings by createdAt", () => {
    const nodes = [
      makeNode("b", null, { createdAt: 2_000 }),
      makeNode("a", null, { createdAt: 1_000 }),
    ]
    expect(childrenOf(nodes).get(null)!.map((n) => n.id)).toEqual(["a", "b"])
  })
})

describe("descendantIds", () => {
  it("collects the full subtree excluding the root", () => {
    expect(descendantIds(forest(), "p")).toEqual(new Set(["c1", "c2", "g1"]))
    expect(descendantIds(forest(), "c1")).toEqual(new Set(["g1"]))
    expect(descendantIds(forest(), "g1")).toEqual(new Set())
  })

  it("survives a cycle without hanging (defensive — server data never cycles)", () => {
    const cycled = [
      makeNode("a", "b"),
      makeNode("b", "a"),
    ]
    const out = descendantIds(cycled, "a")
    expect(out.has("b")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// search

describe("searchMatchIds", () => {
  it("empty query → empty set (callers treat it as no filter)", () => {
    expect(searchMatchIds(forest(), "")).toEqual(new Set())
    expect(searchMatchIds(forest(), "   ")).toEqual(new Set())
  })

  it("matches title case-insensitively", () => {
    expect(searchMatchIds(forest(), "COORDINATOR")).toEqual(new Set(["p"]))
  })

  it("matches agent type", () => {
    expect(searchMatchIds(forest(), "review")).toEqual(new Set(["c1"]))
  })

  it("matches known task text", () => {
    expect(
      searchMatchIds(forest(), "spec", { c2: "Write the specs" }),
    ).toEqual(new Set(["c2"]))
  })

  it("no match → empty set", () => {
    expect(searchMatchIds(forest(), "zzz")).toEqual(new Set())
  })
})

// ---------------------------------------------------------------------------
// ancestor-preserving filter

describe("filterTreeVisible", () => {
  it("keeps matches and every ancestor so the tree stays connected", () => {
    const out = filterTreeVisible(forest(), (id) => id === "g1")
    expect(out.map((n) => n.id)).toEqual(["p", "c1", "g1"])
  })

  it("drops unmatched leaves without touching their siblings' subtrees", () => {
    const out = filterTreeVisible(forest(), (id) => id === "c2")
    expect(out.map((n) => n.id)).toEqual(["p", "c2"])
  })

  it("keep-all is the identity (order preserved)", () => {
    expect(filterTreeVisible(forest(), () => true).map((n) => n.id)).toEqual([
      "p",
      "c1",
      "c2",
      "g1",
    ])
  })

  it("survives a cycle", () => {
    const cycled = [makeNode("a", "b"), makeNode("b", "a")]
    const out = filterTreeVisible(cycled, (id) => id === "a")
    expect(out.map((n) => n.id)).toEqual(["a"])
  })
})

// ---------------------------------------------------------------------------
// DFS rows + collapse

describe("treeRows", () => {
  it("walks the forest depth-first, parents before children", () => {
    const rows = treeRows(forest(), new Set(), null)
    expect(rows.map((r) => r.node.id)).toEqual(["p", "c1", "g1", "c2"])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1])
  })

  it("a collapsed node hides its subtree but not its siblings", () => {
    const rows = treeRows(forest(), new Set(["c1"]), null)
    expect(rows.map((r) => r.node.id)).toEqual(["p", "c1", "c2"])
  })

  it("visibleIds filters rows while keeping the walk intact", () => {
    const rows = treeRows(forest(), new Set(), new Set(["p", "c2"]))
    expect(rows.map((r) => r.node.id)).toEqual(["p", "c2"])
  })
})
