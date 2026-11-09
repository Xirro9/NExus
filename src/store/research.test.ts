// Store tests for the research-library surface (T5). The transport is mocked
// at the module boundary — same precedent as nexus.test.ts. No `window` stub
// is needed here (unlike nexus): the research store only touches
// `localStorage`, lazily inside actions, so an in-memory localStorage stub
// installed in vi.hoisted (before the module under test imports) is enough —
// and it gives the persistence assertions something deterministic to read.

import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockResearchStatus, mockResearchSearch, mockResearchReindex, lsStore } =
  vi.hoisted(() => {
    const store = new Map<string, string>()
    ;(globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    }
    return {
      mockResearchStatus: vi.fn(),
      mockResearchSearch: vi.fn(),
      mockResearchReindex: vi.fn(),
      lsStore: store,
    }
  })

vi.mock("@/lib/transport", () => ({
  transport: {
    researchStatus: mockResearchStatus,
    researchSearch: mockResearchSearch,
    researchReindex: mockResearchReindex,
  },
}))

import { useResearch } from "./research"
import type { ResearchSearchHit } from "@/lib/transport/types"

const ROOT_KEY = "nexus.researchRoot.v1"

function statusFixture(root = "/repo") {
  return {
    root,
    dbExists: true,
    dbSizeBytes: 4096,
    schemaVersion: 1,
    engineVersion: "test",
    collections: [
      {
        id: "legislation",
        name: "Legislation",
        description: "",
        documents: 2,
        sections: 9,
        stale: 0,
        lastUpdatedAt: 1000,
      },
    ],
    staleCount: 0,
    lastReindexAt: 1000,
  }
}

function hitFixture(docId: string): ResearchSearchHit {
  return {
    docId,
    collection: "legislation",
    title: "A bill",
    sourceUrl: "https://example.gov/bill",
    version: "v1",
    status: "verified",
    publicationDate: null,
    retrievedAt: 1000,
    verifiedAt: 1000,
    ageDays: 1,
    stale: false,
    score: 0.5,
    section: null,
  }
}

function resetStore() {
  useResearch.setState({
    root: null,
    status: null,
    search: null,
    collection: null,
    searching: false,
    reindexing: false,
    initializing: false,
    error: null,
  })
}

describe("useResearch — init", () => {
  beforeEach(() => {
    vi.mocked(mockResearchStatus).mockReset()
    vi.mocked(mockResearchSearch).mockReset()
    vi.mocked(mockResearchReindex).mockReset()
    lsStore.clear()
    resetStore()
  })

  it("no stored root: transport receives null, status seeds, payload root persists", async () => {
    mockResearchStatus.mockResolvedValue(statusFixture("/repo/resolved"))

    await useResearch.getState().init()

    expect(mockResearchStatus).toHaveBeenCalledWith(null)
    const s = useResearch.getState()
    expect(s.root).toBe("/repo/resolved")
    expect(s.status?.collections).toHaveLength(1)
    expect(s.error).toBeNull()
    expect(s.initializing).toBe(false)
    // seed-once: the resolved root sticks for the next session
    expect(lsStore.get(ROOT_KEY)).toBe("/repo/resolved")
  })

  it("stored root: passed to the transport, never re-persisted (seed-once)", async () => {
    lsStore.set(ROOT_KEY, "/stored")
    mockResearchStatus.mockResolvedValue(statusFixture("/repo/resolved"))

    await useResearch.getState().init()

    expect(mockResearchStatus).toHaveBeenCalledWith("/stored")
    // the payload root wins in memory…
    expect(useResearch.getState().root).toBe("/repo/resolved")
    // …but a stored path is only seeded, never overwritten
    expect(lsStore.get(ROOT_KEY)).toBe("/stored")
  })

  it("transport error → honest error state, stored root kept for prefill", async () => {
    lsStore.set(ROOT_KEY, "/stored")
    mockResearchStatus.mockRejectedValue(new Error("library root not found"))

    await useResearch.getState().init()

    const s = useResearch.getState()
    expect(s.status).toBeNull()
    expect(s.error).toBe("library root not found")
    expect(s.root).toBe("/stored")
    expect(s.initializing).toBe(false)
  })

  it("is one-shot: a second init() does not refetch once status is loaded", async () => {
    mockResearchStatus.mockResolvedValue(statusFixture())

    await useResearch.getState().init()
    await useResearch.getState().init()

    expect(mockResearchStatus).toHaveBeenCalledTimes(1)
  })
})

describe("useResearch — setRoot", () => {
  beforeEach(() => {
    vi.mocked(mockResearchStatus).mockReset()
    vi.mocked(mockResearchSearch).mockReset()
    vi.mocked(mockResearchReindex).mockReset()
    lsStore.clear()
    resetStore()
  })

  it("trims, verifies via the transport, persists the resolved root, refetches status", async () => {
    mockResearchStatus.mockResolvedValue(statusFixture("/canonical"))
    useResearch.setState({ search: { query: "old", hits: [], tookMs: 0, at: 1 } })

    await useResearch.getState().setRoot("  /input  ")

    expect(mockResearchStatus).toHaveBeenCalledWith("/input")
    const s = useResearch.getState()
    expect(s.root).toBe("/canonical")
    expect(s.status?.root).toBe("/canonical")
    expect(lsStore.get(ROOT_KEY)).toBe("/canonical")
    expect(s.error).toBeNull()
    expect(s.search).toBeNull() // results from the old root are gone
    expect(s.initializing).toBe(false)
  })

  it("empty path → honest error, no transport call, nothing persisted", async () => {
    await useResearch.getState().setRoot("   ")

    expect(mockResearchStatus).not.toHaveBeenCalled()
    expect(useResearch.getState().error).toContain("empty")
    expect(lsStore.has(ROOT_KEY)).toBe(false)
  })

  it("bad path → transport error surfaces, nothing persisted, root unchanged", async () => {
    mockResearchStatus.mockRejectedValue(new Error("no research-library/ there"))
    useResearch.setState({ root: "/previous" })

    await useResearch.getState().setRoot("/bad")

    const s = useResearch.getState()
    expect(s.error).toBe("no research-library/ there")
    expect(s.status).toBeNull()
    expect(s.root).toBe("/previous")
    expect(lsStore.has(ROOT_KEY)).toBe(false)
  })
})

describe("useResearch — runSearch", () => {
  beforeEach(() => {
    vi.mocked(mockResearchStatus).mockReset()
    vi.mocked(mockResearchSearch).mockReset()
    vi.mocked(mockResearchReindex).mockReset()
    lsStore.clear()
    resetStore()
    useResearch.setState({ root: "/repo" })
  })

  it("success: result stored verbatim with at timestamp, error cleared", async () => {
    mockResearchSearch.mockResolvedValue({
      q: "SEC. 4",
      hits: [hitFixture("legislation/s-5471")],
      tookMs: 3,
    })

    await useResearch.getState().runSearch("SEC. 4")

    expect(mockResearchSearch).toHaveBeenCalledWith("/repo", "SEC. 4", {})
    const s = useResearch.getState()
    expect(s.search?.query).toBe("SEC. 4")
    expect(s.search?.hits).toHaveLength(1)
    expect(s.search?.tookMs).toBe(3)
    expect(typeof s.search?.at).toBe("number")
    expect(s.searching).toBe(false)
    expect(s.error).toBeNull()
  })

  it("collection scope rides along when set", async () => {
    mockResearchSearch.mockResolvedValue({ q: "ai", hits: [], tookMs: 1 })
    useResearch.setState({ collection: "legislation" })

    await useResearch.getState().runSearch("ai")

    expect(mockResearchSearch).toHaveBeenCalledWith("/repo", "ai", {
      collection: "legislation",
    })
  })

  it("empty query clears the result set without a transport call", async () => {
    useResearch.setState({
      search: { query: "old", hits: [hitFixture("x/y")], tookMs: 1, at: 1 },
    })

    await useResearch.getState().runSearch("   ")

    expect(mockResearchSearch).not.toHaveBeenCalled()
    const s = useResearch.getState()
    expect(s.search).toBeNull()
    expect(s.searching).toBe(false)
  })

  it("no library connected → honest error, no transport call", async () => {
    useResearch.setState({ root: null })

    await useResearch.getState().runSearch("ai")

    expect(mockResearchSearch).not.toHaveBeenCalled()
    expect(useResearch.getState().error).toContain("No library connected")
  })

  it("transport error → searching false + error message", async () => {
    mockResearchSearch.mockRejectedValue(new Error("boom"))

    await useResearch.getState().runSearch("ai")

    const s = useResearch.getState()
    expect(s.searching).toBe(false)
    expect(s.error).toBe("boom")
  })

  it("a slow response for an older query never overwrites newer results", async () => {
    let resolveFirst!: (v: unknown) => void
    mockResearchSearch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )
    const first = useResearch.getState().runSearch("first")

    mockResearchSearch.mockResolvedValue({ q: "second", hits: [], tookMs: 1 })
    await useResearch.getState().runSearch("second")

    resolveFirst({ q: "first", hits: [hitFixture("old/one")], tookMs: 99 })
    await first

    expect(useResearch.getState().search?.query).toBe("second")
    expect(useResearch.getState().search?.hits).toHaveLength(0)
  })
})

describe("useResearch — reindex", () => {
  beforeEach(() => {
    vi.mocked(mockResearchStatus).mockReset()
    vi.mocked(mockResearchSearch).mockReset()
    vi.mocked(mockResearchReindex).mockReset()
    lsStore.clear()
    resetStore()
    useResearch.setState({ root: "/repo" })
  })

  it("success: reindex runs, status is refreshed, no error when nothing skipped", async () => {
    mockResearchReindex.mockResolvedValue({
      documents: 7,
      sections: 35,
      skipped: [],
      tookMs: 12,
    })
    mockResearchStatus.mockResolvedValue(statusFixture())

    await useResearch.getState().reindex()

    expect(mockResearchReindex).toHaveBeenCalledWith("/repo")
    const s = useResearch.getState()
    expect(s.reindexing).toBe(false)
    expect(s.status?.root).toBe("/repo")
    expect(s.error).toBeNull()
  })

  it("skipped manifests surface as a non-failure error with context", async () => {
    mockResearchReindex.mockResolvedValue({
      documents: 1,
      sections: 2,
      skipped: [{ manifest: "sources/x/manifest.json", error: "bad pubDate" }],
      tookMs: 5,
    })
    mockResearchStatus.mockResolvedValue(statusFixture())

    await useResearch.getState().reindex()

    const s = useResearch.getState()
    expect(s.reindexing).toBe(false)
    expect(s.error).toContain("1 skipped manifest")
    expect(s.error).toContain("sources/x/manifest.json")
    expect(s.error).toContain("bad pubDate")
    // the rebuild itself still landed — status refreshed
    expect(s.status?.root).toBe("/repo")
  })

  it("transport error → reindexing false + error message", async () => {
    mockResearchReindex.mockRejectedValue(new Error("reindex failed"))

    await useResearch.getState().reindex()

    const s = useResearch.getState()
    expect(s.reindexing).toBe(false)
    expect(s.error).toBe("reindex failed")
  })

  it("no root → no-op, transport never called", async () => {
    useResearch.setState({ root: null })

    await useResearch.getState().reindex()

    expect(mockResearchReindex).not.toHaveBeenCalled()
    expect(useResearch.getState().reindexing).toBe(false)
  })
})

describe("useResearch — setCollection", () => {
  beforeEach(() => resetStore())

  it("scopes search and clears back to null", () => {
    useResearch.getState().setCollection("legislation")
    expect(useResearch.getState().collection).toBe("legislation")
    useResearch.getState().setCollection(null)
    expect(useResearch.getState().collection).toBeNull()
  })
})
