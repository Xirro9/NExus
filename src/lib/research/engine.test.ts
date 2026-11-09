// Unit tests for the research library engine — pure Node (node:sqlite + fs),
// each test on its own mkdtemp root passed explicitly, mirroring how the CLI
// passes a resolved root. No network, no LLM, no plugin runtime.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  COLLECTIONS,
  ENGINE_VERSION,
  SCHEMA_VERSION,
  getDocument,
  ingest,
  listCollections,
  listDocuments,
  reindex,
  resolveLibraryRoot,
  search,
  status,
} from "./engine"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "research-test-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const DAY = 86_400_000

const S5471_CONTENT =
  "A bill to establish guardrails for artificial intelligence systems.\n\n" +
  "SEC. 1. Short title.\nThis Act may be cited as the AI Policy Act of 2026.\n\n" +
  "SEC. 4. Prohibited acts.\nIt shall be unlawful to deploy deceptive chatbots toward voters.\n\n" +
  "SEC. 5. Enforcement.\nThe Commission may investigate violations of section 4."

function s5471(overrides: Partial<Parameters<typeof ingest>[1]> = {}): Parameters<typeof ingest>[1] {
  return {
    collection: "legislation",
    slug: "s-5471",
    title: "AI Policy Act of 2026",
    sourceUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/5471",
    content: S5471_CONTENT,
    publicationDate: "2026-09-23",
    version: "introduced",
    retrievedAt: Date.now() - 5 * DAY,
    ...overrides,
  }
}

describe("schema initialization", () => {
  it("reads on an empty library return empty results and never create the DB", () => {
    expect(status(root).dbExists).toBe(false)
    expect(existsSync(join(root, "research-library", "indexes", "research.db"))).toBe(false)
    const s = status(root)
    expect(s.collections).toHaveLength(5)
    for (const c of s.collections) {
      expect(c.documents).toBe(0)
      expect(c.sections).toBe(0)
      expect(c.stale).toBe(0)
      expect(c.lastUpdatedAt).toBeNull()
    }
    expect(s.staleCount).toBe(0)
    expect(s.lastReindexAt).toBeNull()
    expect(s.dbSizeBytes).toBeNull()
    expect(search(root, "chatbots").hits).toEqual([])
    expect(getDocument(root, "legislation/s-5471")).toBeNull()
    expect(listDocuments(root, "legislation")).toEqual([])
    for (const c of listCollections(root)) {
      expect(c.documents).toBe(0)
    }
  })

  it("ingest creates a WAL database at the expected version with seeded collections", () => {
    ingest(root, s5471())
    const dbFile = join(root, "research-library", "indexes", "research.db")
    expect(existsSync(dbFile)).toBe(true)
    const raw = new DatabaseSync(dbFile)
    try {
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION })
      const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as unknown as { name: string }[]).map((r) => r.name)
      for (const expected of ["collections", "documents", "document_revisions", "sections", "library_meta", "documents_fts", "sections_fts"]) {
        expect(names).toContain(expected)
      }
      expect((raw.prepare("SELECT COUNT(*) AS n FROM collections").get() as unknown as { n: number }).n).toBe(5)
    } finally {
      raw.close()
    }
  })

  it("status reports the derived engine version and db size after ingest", () => {
    ingest(root, s5471())
    const s = status(root)
    expect(s.dbExists).toBe(true)
    expect(s.dbSizeBytes).toBeGreaterThan(0)
    expect(s.engineVersion).toBe(ENGINE_VERSION)
    expect(s.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe("ingest idempotency lifecycle", () => {
  it("created → unchanged keeps retrieved_at, revision and files untouched", () => {
    const retrievedAt = Date.now() - 5 * DAY
    const created = ingest(root, s5471({ retrievedAt }))
    expect(created.outcome).toBe("created")
    expect(created.revision).toBe(1)
    expect(created.sectionCount).toBe(3)

    const again = ingest(root, s5471({ retrievedAt }))
    expect(again.outcome).toBe("unchanged")
    expect(again.revision).toBe(1)

    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc.retrievedAt).toBe(retrievedAt) // never bumped on unchanged
    expect(doc.verifiedAt).toBeNull()
    expect(doc.status).toBe("cached")

    const revs = getRevisionCount(root, "legislation/s-5471")
    expect(revs).toBe(1)
    const files = readdirSync(join(root, "research-library", "sources", "legislation", "s-5471"))
    expect(files.filter((f) => f !== "manifest.json")).toHaveLength(1)
  })

  it("verification bump marks verified without a new revision and resets the clock", () => {
    const retrievedAt = Date.now() - 5 * DAY
    ingest(root, s5471({ retrievedAt }))
    const bumped = ingest(root, s5471({ retrievedAt, status: "verified" }))
    expect(bumped.outcome).toBe("unchanged")
    expect(bumped.revision).toBe(1)

    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc.status).toBe("verified")
    expect(doc.verifiedAt).not.toBe(retrievedAt) // verified NOW, not at retrieval…
    expect(doc.verifiedAt).toBeGreaterThanOrEqual(retrievedAt)
    expect(doc.retrievedAt).toBe(retrievedAt) // …but retrieved_at is never bumped
    expect(getRevisionCount(root, "legislation/s-5471")).toBe(1)

    // manifest mirrors the verification bump so reindex stays faithful
    const manifest = readManifest(root, "legislation", "s-5471")
    expect(manifest.status).toBe("verified")
    expect(manifest.verifiedAt).toBe(doc.verifiedAt)
  })

  it("verified→verified re-import keeps the original verification instant (db + manifest)", () => {
    const retrievedAt = Date.now() - 5 * DAY
    ingest(root, s5471({ retrievedAt, status: "verified" }))
    expect(getDocument(root, "legislation/s-5471")!.verifiedAt).toBe(retrievedAt) // create: verified at retrieval

    const again = ingest(root, s5471({ retrievedAt, status: "verified" }))
    expect(again.outcome).toBe("unchanged")
    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc.status).toBe("verified")
    expect(doc.verifiedAt).toBe(retrievedAt) // re-import must not bump the clock
    expect(readManifest(root, "legislation", "s-5471").verifiedAt).toBe(retrievedAt) // manifest agrees

    // the manifest is the unit of record — a replay must not resurrect `now`
    reindex(root)
    expect(getDocument(root, "legislation/s-5471")!.verifiedAt).toBe(retrievedAt)
  })

  it("same identity with different content appends a revision and keeps the prior file", () => {
    ingest(root, s5471())
    const updated = ingest(
      root,
      s5471({ content: S5471_CONTENT + "\n\nSEC. 9. Effective date.\nThis Act takes effect in 2027.", retrievedAt: Date.now() }),
    )
    expect(updated.outcome).toBe("updated")
    expect(updated.revision).toBe(2)
    expect(updated.sectionCount).toBe(4)

    const dir = join(root, "research-library", "sources", "legislation", "s-5471")
    const files = readdirSync(dir)
    expect(files.some((f) => f.startsWith("r1-"))).toBe(true) // prior retained
    expect(files.some((f) => f.startsWith("r2-"))).toBe(true)

    expect(getRevisionCount(root, "legislation/s-5471")).toBe(2)
    const manifest = readManifest(root, "legislation", "s-5471")
    expect(manifest.revisions).toHaveLength(2)
    expect(manifest.revisions.map((r) => r.revision)).toEqual([1, 2])

    const doc = getDocument(root, "legislation/s-5471", { sections: true })!
    expect(doc.revision).toBe(2)
    expect(doc.sections).toHaveLength(4)
  })

  it("the FTS index follows title and content updates on the UPDATE path", () => {
    ingest(root, s5471())
    const updated = ingest(
      root,
      s5471({
        title: "AI Policy Act of 2027 (Amended)",
        // drops SEC. 4 (the only "chatbots" occurrence) and adds SEC. 9 with a
        // term ("quantum") that exists nowhere in the original content
        content:
          "A bill to establish guardrails for artificial intelligence systems.\n\n" +
          "SEC. 1. Short title.\nThis Act may be cited as the AI Policy Act of 2027.\n\n" +
          "SEC. 9. Effective date.\nQuantum provisions take effect in 2027.",
        retrievedAt: Date.now(),
      }),
    )
    expect(updated.outcome).toBe("updated")

    // (a) the NEW title is found (documents_fts UPDATE trigger)
    const byTitle = search(root, "Amended", { scope: "documents" })
    expect(byTitle.hits).toHaveLength(1)
    expect(byTitle.hits[0].docId).toBe("legislation/s-5471")

    // (b) a term that exists only in the NEW content is found (sections_fts)
    const added = search(root, "quantum")
    expect(added.hits.some((h) => h.docId === "legislation/s-5471" && h.section !== null)).toBe(true)

    // (c) a term that existed only in the OLD content is NOT found (delete sync)
    const removed = search(root, "chatbots")
    expect(removed.hits.some((h) => h.docId === "legislation/s-5471")).toBe(false)
  })

  it("a new version of the same source_url supersedes the older row (and its manifest)", () => {
    ingest(root, s5471())
    const newer = ingest(
      root,
      s5471({ slug: "s-5471-enr", version: "enrolled-bill", content: "Enrolled version text.\n\nSEC. 1. Short title.\nAI Policy Act." }),
    )
    expect(newer.outcome).toBe("created")

    const old = getDocument(root, "legislation/s-5471")!
    expect(old.status).toBe("superseded")
    expect(getDocument(root, "legislation/s-5471-enr")!.status).toBe("cached")

    // supersede flip persisted into the older manifest → reindex is order-free
    expect(readManifest(root, "legislation", "s-5471").status).toBe("superseded")
  })

  it("rejects a docId collision: same slug, different source_url", () => {
    ingest(root, s5471())
    expect(() =>
      ingest(root, s5471({ sourceUrl: "https://example.gov/different-bill" })),
    ).toThrow(/collision/)
  })
})

function getRevisionCount(r: string, docId: string): number {
  const db = new DatabaseSync(join(r, "research-library", "indexes", "research.db"))
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ?").get(docId) as unknown as { n: number }).n
  } finally {
    db.close()
  }
}

function readManifest(r: string, collection: string, slug: string): {
  status: string
  verifiedAt: number | null
  revisions: { revision: number }[]
} {
  const p = join(r, "research-library", "sources", collection, slug, "manifest.json")
  return JSON.parse(readFileSync(p, "utf8"))
}

describe("section derivation", () => {
  it("auto-splits legislation-style SEC. lines and prepends the preamble to section 1", () => {
    ingest(root, s5471())
    const doc = getDocument(root, "legislation/s-5471", { sections: true })!
    expect(doc.sections).toHaveLength(3)
    expect(doc.sections![0].anchor).toBe("SEC. 1")
    expect(doc.sections![1].anchor).toBe("SEC. 4")
    expect(doc.sections![2].anchor).toBe("SEC. 5")
    expect(doc.sections![0].body).toContain("A bill to establish guardrails") // preamble kept
    expect(doc.sections![0].id).toBe("legislation/s-5471#1-sec-1-short-title")
    expect(doc.sections![1].ordinal).toBe(2)
  })

  it("falls back to a single implicit section (anchor 'all', heading = title)", () => {
    ingest(root, s5471({ content: "Just one paragraph, no SEC. headings here." }))
    const doc = getDocument(root, "legislation/s-5471", { sections: true })!
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections![0].anchor).toBe("all")
    expect(doc.sections![0].heading).toBe("AI Policy Act of 2026")
    expect(doc.sections![0].body).toBe("Just one paragraph, no SEC. headings here.")
  })

  it("honors explicit sections with verbatim anchors", () => {
    ingest(
      root,
      s5471({
        content: "ignored in favor of explicit sections",
        sections: [
          { anchor: "§2", heading: "Definitions", body: "An AI system means software that…" },
          { anchor: "§3", heading: "Scope", body: "This act applies to covered platforms." },
        ],
      }),
    )
    const doc = getDocument(root, "legislation/s-5471", { sections: true })!
    expect(doc.sections).toHaveLength(2)
    expect(doc.sections![0].anchor).toBe("§2")
    expect(doc.sections![0].id).toBe("legislation/s-5471#1-definitions")
    expect(doc.sections![1].body).toBe("This act applies to covered platforms.")
  })
})

describe("search (FTS5)", () => {
  beforeEach(() => {
    ingest(root, s5471())
    ingest(
      root,
      s5471({
        collection: "cybersecurity",
        slug: "cisa-advisory-2026-01",
        title: "CISA Advisory: Chatbot Supply Chain Risks",
        sourceUrl: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa26-001a",
        content: "Threat actors compromise chatbot providers to harvest credentials. Patch now.",
        version: "current",
      }),
    )
  })

  it("finds documents by title with a positive score and null section", () => {
    const r = search(root, "CISA advisory", { scope: "documents" })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].docId).toBe("cybersecurity/cisa-advisory-2026-01")
    expect(r.hits[0].section).toBeNull()
    expect(r.hits[0].score).toBeGreaterThan(0)
    expect(r.tookMs).toBeGreaterThanOrEqual(0)
  })

  it("finds sections by body text with snippet ≤240 chars", () => {
    const r = search(root, "deceptive chatbots voters", { scope: "sections" })
    expect(r.hits.length).toBeGreaterThan(0)
    const hit = r.hits[0]
    expect(hit.docId).toBe("legislation/s-5471")
    expect(hit.section).not.toBeNull()
    expect(hit.section!.anchor).toBe("SEC. 4")
    expect(hit.section!.snippet.length).toBeLessThanOrEqual(240)
  })

  it("scope all returns each hit type once per document", () => {
    const r = search(root, "chatbot")
    expect(r.hits.some((h) => h.section === null)).toBe(true)
    expect(r.hits.some((h) => h.section !== null)).toBe(true)
  })

  it("filters by collection", () => {
    const r = search(root, "chatbot", { collection: "cybersecurity" })
    expect(r.hits.length).toBeGreaterThan(0)
    for (const h of r.hits) expect(h.collection).toBe("cybersecurity")
  })

  it("clamps limit", () => {
    expect(search(root, "chatbot", { limit: 1 }).hits).toHaveLength(1)
    expect(search(root, "chatbot", { limit: 10_000 }).hits.length).toBeLessThanOrEqual(50)
  })

  it("hostile queries degrade instead of crashing (LIKE fallback or empty)", () => {
    const hostile = [
      '"quoted phrase" --dashed *star*',
      'a"b OR 1=1',
      "---",
      '***',
      'NOT AND OR NEAR',
      '"unclosed quote',
      "sec. 4.",
    ]
    for (const q of hostile) {
      const r = search(root, q)
      expect(Array.isArray(r.hits)).toBe(true)
    }
  })

  it("empty query returns no hits", () => {
    expect(search(root, "   ").hits).toEqual([])
  })
})

describe("freshness + TTL", () => {
  it("stale is computed at read time from the collection TTL", () => {
    const retrievedAt = Date.now() - 40 * DAY
    ingest(root, s5471({ retrievedAt })) // legislation ttl 30 → stale
    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc.ageDays).toBe(40)
    expect(doc.stale).toBe(true)
    expect(doc.status).toBe("cached") // staleness never written into status

    const freshRoot = root // same root, different collection has ttl 365
    ingest(freshRoot, s5471({ collection: "technical-docs", slug: "spec-doc", sourceUrl: "https://example.com/spec", retrievedAt }))
    const tech = getDocument(freshRoot, "technical-docs/spec-doc")!
    expect(tech.stale).toBe(false)
  })

  it("verification resets the freshness clock", () => {
    const retrievedAt = Date.now() - 40 * DAY
    ingest(root, s5471({ retrievedAt }))
    expect(getDocument(root, "legislation/s-5471")!.stale).toBe(true)
    ingest(root, s5471({ retrievedAt, status: "verified" }))
    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc.stale).toBe(false)
    expect(doc.ageDays).toBeLessThanOrEqual(1)
  })

  it("metadata/collections.json overrides the TTL", () => {
    mkdirSync(join(root, "research-library", "metadata"), { recursive: true })
    writeFileSync(
      join(root, "research-library", "metadata", "collections.json"),
      JSON.stringify({ collections: { projects: { ttlDays: 1 } } }),
      "utf8",
    )
    const retrievedAt = Date.now() - 2 * DAY
    ingest(root, s5471({ collection: "projects", slug: "notes", sourceUrl: "https://example.com/notes", retrievedAt }))
    const doc = getDocument(root, "projects/notes")!
    expect(doc.stale).toBe(true)
    expect(status(root).staleCount).toBe(1)
  })
})

describe("reindex", () => {
  it("replays manifests into a fresh DB preserving revisions and search", () => {
    ingest(root, s5471())
    ingest(root, s5471({ content: S5471_CONTENT + "\n\nSEC. 9. Effective date.\n2027." }))
    ingest(
      root,
      s5471({ collection: "ai-research", slug: "llm-survey", sourceUrl: "https://arxiv.org/abs/2601.00001", content: "Survey of large language model evaluations.", version: "current" }),
    )

    const result = reindex(root)
    expect(result.documents).toBe(2)
    expect(result.skipped).toEqual([])
    expect(result.tookMs).toBeGreaterThanOrEqual(0)

    const doc = getDocument(root, "legislation/s-5471", { sections: true })!
    expect(doc.revision).toBe(2)
    expect(doc.sections).toHaveLength(4)
    expect(getRevisionCount(root, "legislation/s-5471")).toBe(2)
    expect(search(root, "chatbot").hits.length).toBeGreaterThan(0)
    expect(status(root).lastReindexAt).not.toBeNull()
  })

  it("isolates corrupt manifests and still restores the rest", () => {
    ingest(root, s5471())
    const junkDir = join(root, "research-library", "sources", "legislation", "junk-manifest")
    mkdirSync(junkDir, { recursive: true })
    writeFileSync(join(junkDir, "manifest.json"), "{ this is not json", "utf8")
    const badDir = join(root, "research-library", "sources", "legislation", "bad-collection")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(
      join(badDir, "manifest.json"),
      JSON.stringify({ schema: 1, collection: "not-a-collection", slug: "x", title: "x", sourceUrl: "https://x.test/a", version: "current", status: "cached", sections: [], revisions: [{ revision: 1, contentHash: "a".repeat(64), retrievedAt: 1, file: "f" }] }),
      "utf8",
    )

    const result = reindex(root)
    expect(result.documents).toBe(1)
    expect(result.skipped).toHaveLength(2)
    const manifestPaths = result.skipped.map((s) => s.manifest)
    expect(manifestPaths.some((m) => m.includes("junk-manifest"))).toBe(true)
    expect(manifestPaths.some((m) => m.includes("bad-collection"))).toBe(true)
    expect(result.skipped.every((s) => s.error.length > 0)).toBe(true)
    expect(getDocument(root, "legislation/s-5471")).not.toBeNull()
  })
})

describe("validation", () => {
  it("rejects bad input with clear messages", () => {
    const cases: [Parameters<typeof ingest>[1], RegExp][] = [
      [s5471({ collection: "not-a-collection" as never }), /invalid collection/],
      [s5471({ slug: "S-5471" }), /invalid slug/],
      [s5471({ slug: "has/slash" }), /invalid slug/],
      [s5471({ slug: "-leading-dash" }), /invalid slug/],
      [s5471({ slug: "x".repeat(81) }), /invalid slug/],
      [s5471({ sourceUrl: "ftp://example.com/bill" }), /sourceUrl/],
      [s5471({ title: "t".repeat(301) }), /title/],
      [s5471({ content: "c".repeat(1_500_001) }), /content/],
      [s5471({ publicationDate: "2026-13-40" }), /publicationDate/],
      [s5471({ publicationDate: "September 2026" }), /publicationDate/],
      [s5471({ version: "v".repeat(65) }), /version/],
      [s5471({ notes: "n".repeat(4001) }), /notes/],
      [s5471({ sections: Array.from({ length: 501 }, (_, i) => ({ anchor: `a${i}`, heading: "h", body: "b" })) }), /sections/],
      [s5471({ sections: [{ anchor: "a", heading: "h", body: "b".repeat(200_001) }] }), /body/],
      [s5471({ sections: [{ anchor: "a".repeat(121), heading: "h", body: "b" }] }), /anchor/],
      [s5471({ sections: [{ anchor: "a", heading: "h".repeat(301), body: "b" }] }), /heading/],
    ]
    for (const [input, pattern] of cases) {
      expect(() => ingest(root, input)).toThrow(pattern)
    }
  })

  it("rejects malformed docIds but returns null for unknown ones", () => {
    expect(() => getDocument(root, "no-slash-here")).toThrow(/docId/)
    expect(() => getDocument(root, "UPPER/case")).toThrow(/docId/)
    expect(getDocument(root, "legislation/does-not-exist")).toBeNull()
  })
})

describe("getDocument options", () => {
  beforeEach(() => {
    ingest(root, s5471())
  })

  it("returns metadata only by default (no sections field)", () => {
    const doc = getDocument(root, "legislation/s-5471")!
    expect(doc).not.toBeNull()
    expect(doc.sections).toBeUndefined()
    expect(doc.filePath).toBe("research-library/sources/legislation/s-5471/r1-" + doc.contentHash.slice(0, 8) + ".txt")
  })

  it("matches sections by anchor substring, case-insensitively", () => {
    const doc = getDocument(root, "legislation/s-5471", { section: "sec. 5" })!
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections![0].anchor).toBe("SEC. 5")
    expect(doc.sections![0].body).toContain("Commission may investigate")
  })

  it("returns [] sections when the anchor filter matches nothing", () => {
    const doc = getDocument(root, "legislation/s-5471", { section: "SEC. 99" })!
    expect(doc.sections).toEqual([])
  })

  it("truncates bodies with an honest marker and clamps maxChars", () => {
    const longBody = "word ".repeat(12000) // ~60k chars, above the 50k clamp ceiling
    ingest(
      root,
      s5471({
        slug: "long-doc",
        sourceUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/9999",
        content: `SEC. 1. Long.\n${longBody}`,
      }),
    )
    const doc = getDocument(root, "legislation/long-doc", { sections: true, maxChars: 600 })!
    const body = doc.sections![0].body!
    expect(body.length).toBeLessThan(700)
    expect(body.endsWith("[truncated at 600 chars]")).toBe(true)

    const clampedLow = getDocument(root, "legislation/long-doc", { sections: true, maxChars: 10 })!
    expect(clampedLow.sections![0].body!.endsWith("[truncated at 500 chars]")).toBe(true)
    const clampedHigh = getDocument(root, "legislation/long-doc", { sections: true, maxChars: 999_999 })!
    expect(clampedHigh.sections![0].body!.endsWith("[truncated at 50000 chars]")).toBe(true)
  })
})

describe("listDocuments / listCollections summaries", () => {
  it("reports counts, staleness and lastUpdatedAt without section bodies", () => {
    ingest(root, s5471({ retrievedAt: Date.now() - 40 * DAY }))
    const docs = listDocuments(root, "legislation")
    expect(docs).toHaveLength(1)
    expect(docs[0].stale).toBe(true)
    expect(docs[0].sections).toBeUndefined()
    expect(docs[0].notes).toBe("")
    expect(docs[0].version).toBe("introduced")

    const summaries = listCollections(root)
    expect(summaries.map((c) => c.id)).toEqual([...COLLECTIONS])
    const legislation = summaries.find((c) => c.id === "legislation")!
    expect(legislation.documents).toBe(1)
    expect(legislation.sections).toBe(3)
    expect(legislation.stale).toBe(1)
    expect(legislation.lastUpdatedAt).not.toBeNull()
    expect(status(root).staleCount).toBe(1)
  })
})

describe("resolveLibraryRoot", () => {
  it("prefers the explicit argument", () => {
    expect(resolveLibraryRoot("/tmp/opencode/explicit-root")).toBe("/tmp/opencode/explicit-root")
  })

  it("honors RESEARCH_LIBRARY_ROOT when no explicit arg is given", () => {
    vi.stubEnv("RESEARCH_LIBRARY_ROOT", "/tmp/opencode/env-root")
    expect(resolveLibraryRoot(null)).toBe("/tmp/opencode/env-root")
  })

  it("ignores empty/whitespace anchors and falls through the chain", () => {
    vi.stubEnv("RESEARCH_LIBRARY_ROOT", "   ")
    expect(resolveLibraryRoot("  ")).toBe(resolveLibraryRoot(null))
  })

  it("walk-up finds the directory containing research-library/ (the repo root)", () => {
    const found = resolveLibraryRoot(null)
    expect(found.endsWith("/NExus")).toBe(true)
    expect(existsSync(join(found, "research-library"))).toBe(true)
  })
})
