// Unit tests for the Activity Center derivations (Phase E1): running
// detection, state fallbacks, per-section membership/sorting, stats
// aggregation, and the honest null-vs-zero inbox semantics.

import { describe, expect, it } from "vitest"

import type { SessionActivity } from "@/lib/agentState"
import type {
  PermissionRequest,
  ProjectInfo,
  SessionInfo,
} from "@/lib/opencode/types"

import {
  buildActivitySnapshot,
  COMPLETED_CAP,
  fmtRelative,
  type ActivityInput,
} from "./activityData"

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    projectID: "proj1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
    location: {},
    ...over,
  }
}

function act(over: Partial<SessionActivity>): SessionActivity {
  return {
    state: "idle",
    lastEventAt: 0,
    currentTool: null,
    currentToolSince: null,
    toolsRun: 0,
    filesTouched: [],
    recentTools: [],
    lastError: null,
    lastActivityKind: null,
    ...over,
  }
}

function project(over: Partial<ProjectInfo> & { id: string }): ProjectInfo {
  return { canonical: "/repo", time: { created: 0, updated: 0 }, ...over }
}

const NO_PERMS: PermissionRequest[] = []

function input(over: Partial<ActivityInput>): ActivityInput {
  return {
    sessions: {},
    busy: {},
    activity: {},
    priorities: {},
    activeMap: null,
    inboxCounts: {},
    permissionRequests: NO_PERMS,
    projects: [project({ id: "proj1", name: "NExus" })],
    ...over,
  }
}

describe("buildActivitySnapshot — running detection", () => {
  it("marks a session busy via the busy map as active", () => {
    const snap = buildActivitySnapshot(
      input({ sessions: { a: session({ id: "a" }) }, busy: { a: true } }),
    )
    expect(snap.active.map((r) => r.id)).toEqual(["a"])
    expect(snap.active[0]!.state).toBe("generating")
  })

  it("marks a session present in the server-truth active map as active", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a" }) },
        activeMap: { a: { type: "running" } },
      }),
    )
    expect(snap.active.map((r) => r.id)).toEqual(["a"])
  })

  it("leaves quiet sessions out of active", () => {
    const snap = buildActivitySnapshot(
      input({ sessions: { a: session({ id: "a" }) } }),
    )
    expect(snap.active).toEqual([])
    expect(snap.active).toEqual([])
    expect(snap.stats.activeCount).toBe(0)
  })
})

describe("buildActivitySnapshot — state resolution", () => {
  it("prefers the Phase B activity state over the busy fallback", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a" }) },
        busy: { a: true },
        activity: { a: act({ state: "executing-tools", currentTool: "edit" }) },
      }),
    )
    expect(snap.active[0]!.state).toBe("executing-tools")
    expect(snap.active[0]!.currentTool).toBe("edit")
  })

  it("never shows a terminal/idle stored state on a running session (stale summary loses)", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          a: session({ id: "a" }),
          b: session({ id: "b" }),
          c: session({ id: "c" }),
        },
        busy: { a: true, b: true, c: true },
        activity: {
          a: act({ state: "idle" }),
          b: act({ state: "failed", lastError: "old failure" }),
          c: act({ state: "completed" }),
        },
      }),
    )
    // stale summaries lose to the live derivation (generating)
    expect(snap.active.map((r) => r.state)).toEqual([
      "generating",
      "generating",
      "generating",
    ])
    // the real lastError still routes the row to errors
    expect(snap.errors.map((r) => r.id)).toEqual(["b"])
  })

  it("running + recent tool refines to executing-tools even when the summary is stale", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a" }) },
        activeMap: { a: { type: "running" } },
        activity: {
          a: act({
            state: "idle",
            lastActivityKind: "tool",
            currentTool: "edit",
          }),
        },
      }),
    )
    expect(snap.active[0]!.state).toBe("executing-tools")
    expect(snap.active[0]!.currentTool).toBe("edit")
  })

  it("keeps a live awaiting-permission state on a running session", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a" }) },
        busy: { a: true },
        activity: { a: act({ state: "awaiting-permission" }) },
      }),
    )
    expect(snap.active[0]!.state).toBe("awaiting-permission")
  })

  it("maps a terminal outcome when no activity record exists", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          a: session({ id: "a", outcome: "failed" }),
          b: session({ id: "b", outcome: "succeeded" }),
          c: session({ id: "c", outcome: "interrupted" }),
          d: session({ id: "d" }),
        },
      }),
    )
    const states = Object.fromEntries(
      snap.completed.map((r) => [r.id, r.state]),
    )
    // failed routes to the errors section, not completed
    expect(snap.errors.map((r) => r.id)).toEqual(["a"])
    expect(snap.errors[0]!.state).toBe("failed")
    expect(states.b).toBe("completed")
    expect(states.c).toBe("interrupted")
    // d has no outcome and no activity — idle, so nowhere on the board
    expect(snap.completed.map((r) => r.id)).not.toContain("d")
  })
})

describe("buildActivitySnapshot — active ordering", () => {
  it("sorts by priority rank, then most recent activity", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          low: session({ id: "low", time: { created: 0, updated: 9_000 } }),
          crit: session({ id: "crit", time: { created: 0, updated: 1_000 } }),
        },
        busy: { low: true, crit: true },
        priorities: { crit: "critical", low: "low" },
      }),
    )
    expect(snap.active.map((r) => r.id)).toEqual(["crit", "low"])
  })
})

describe("buildActivitySnapshot — queued operations", () => {
  it("includes only sessions with a positive inbox count", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          a: session({ id: "a" }),
          b: session({ id: "b" }),
          c: session({ id: "c" }),
        },
        inboxCounts: { a: 2, b: 0, c: null },
      }),
    )
    expect(snap.queued.map((r) => r.id)).toEqual(["a"])
    expect(snap.stats.queuedSessionCount).toBe(1)
  })

  it("sorts by count descending", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          a: session({ id: "a" }),
          b: session({ id: "b" }),
        },
        inboxCounts: { a: 1, b: 3 },
      }),
    )
    expect(snap.queued.map((r) => r.id)).toEqual(["b", "a"])
  })
})

describe("buildActivitySnapshot — errors", () => {
  it("collects sessions with a lastError or a failed state", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          err: session({ id: "err" }),
          failed: session({ id: "failed" }),
          clean: session({ id: "clean" }),
        },
        activity: {
          err: act({ lastError: "tool exploded" }),
          failed: act({ state: "failed" }),
        },
      }),
    )
    expect(snap.errors.map((r) => r.id).sort()).toEqual(["err", "failed"])
    expect(snap.stats.errorCount).toBe(2)
  })
})

describe("buildActivitySnapshot — completed", () => {
  it("excludes running sessions and caps to the most recent", () => {
    const sessions: Record<string, SessionInfo> = {}
    for (let i = 0; i < COMPLETED_CAP + 2; i++) {
      sessions[`s${i}`] = session({
        id: `s${i}`,
        outcome: "succeeded",
        time: { created: 0, updated: i },
      })
    }
    const snap = buildActivitySnapshot(input({ sessions }))
    expect(snap.completed).toHaveLength(COMPLETED_CAP)
    // most recent first
    expect(snap.completed[0]!.id).toBe(`s${COMPLETED_CAP + 1}`)
    // stats count is uncapped — the full truth
    expect(snap.stats.completedCount).toBe(COMPLETED_CAP + 2)
  })

  it("never lists a currently-running session as completed", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a", outcome: "succeeded" }) },
        busy: { a: true },
      }),
    )
    expect(snap.completed).toEqual([])
  })
})

describe("buildActivitySnapshot — subagent summary", () => {
  it("groups running children under their parent record", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          parent: session({ id: "parent" }),
          kid1: session({ id: "kid1", parentID: "parent" }),
          kid2: session({ id: "kid2", parentID: "parent" }),
        },
        busy: { kid1: true, kid2: true },
      }),
    )
    expect(snap.subagentRuns).toHaveLength(1)
    expect(snap.subagentRuns[0]!.parent.id).toBe("parent")
    expect(snap.subagentRuns[0]!.children.map((c) => c.id).sort()).toEqual([
      "kid1",
      "kid2",
    ])
  })

  it("excludes idle children and skips groups whose parent record is gone", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          // "gone" parent deliberately absent (deleted mid-run)
          orphan: session({ id: "orphan", parentID: "gone" }),
        },
        busy: { orphan: true },
      }),
    )
    expect(snap.subagentRuns).toEqual([])
  })
})

describe("buildActivitySnapshot — tool activity", () => {
  it("lists sessions with a current tool or run counts, running first", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: {
          done: session({ id: "done", time: { created: 0, updated: 9_000 } }),
          live: session({ id: "live", time: { created: 0, updated: 5_000 } }),
          quiet: session({ id: "quiet" }),
        },
        busy: { live: true },
        activity: {
          live: act({ state: "executing-tools", currentTool: "bash", toolsRun: 1 }),
          done: act({ toolsRun: 4 }),
        },
      }),
    )
    expect(snap.toolActivity.map((r) => r.id)).toEqual(["live", "done"])
    expect(snap.stats.toolsRunTotal).toBe(5)
  })
})

describe("buildActivitySnapshot — project labels", () => {
  it("prefers the project name over the canonical path", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a", outcome: "succeeded" }) },
        projects: [project({ id: "proj1", name: "NExus", canonical: "/x/NExus" })],
      }),
    )
    expect(snap.completed[0]!.projectPath).toBe("NExus")
  })

  it("falls back to null for unknown projects", () => {
    const snap = buildActivitySnapshot(
      input({
        sessions: { a: session({ id: "a", projectID: "ghost", outcome: "succeeded" }) },
        projects: [],
      }),
    )
    expect(snap.completed[0]!.projectPath).toBeNull()
  })
})

describe("fmtRelative", () => {
  it("formats under a minute as now", () => {
    expect(fmtRelative(59_000, 60_000)).toBe("now")
  })
  it("formats minutes, hours and days", () => {
    expect(fmtRelative(0, 4 * 60_000)).toBe("4m ago")
    expect(fmtRelative(0, 3 * 3_600_000)).toBe("3h ago")
    expect(fmtRelative(0, 2 * 86_400_000)).toBe("2d ago")
  })
  it("clamps future timestamps to now", () => {
    expect(fmtRelative(2_000, 1_000)).toBe("now")
  })
})
