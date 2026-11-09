// Research library tool renderers — pure functions turning engine result types
// into compact, model-readable text for the research_library_* tools
// (.opencode/plugins/research-library/index.ts). Machine consumers (Jerry
// middleware, scripts) must use the CLI --json output instead of this text.
//
// No runtime imports: engine types arrive via `import type`, which both
// supported legs (plain Node v24 type-stripping, Bun plugin runtime) erase —
// so this file loads without pulling the engine module graph (or node:sqlite)
// in at all.

import type {
  CollectionSummary,
  DocumentRecord,
  IngestResult,
  LibraryStatus,
  ReindexResult,
  SearchHit,
} from "../../../src/lib/research/engine.ts"

// ---------------------------------------------------------------------------
// small helpers

function iso(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "never"
}

function pubDate(d: string | null): string {
  return d ?? "unknown"
}

function staleFlag(stale: boolean): string {
  return stale ? " (stale!)" : ""
}

function hash8(hash: string): string {
  return hash.slice(0, 8)
}

// ---------------------------------------------------------------------------
// status (also the refresh reindex:false report)

export function renderStatus(s: LibraryStatus): string {
  const lines: string[] = []
  lines.push(`research library status — root: ${s.root}`)
  lines.push(
    s.dbExists
      ? `index: present (${s.dbSizeBytes} bytes)`
      : "index: absent (empty library — search/list return nothing until a document is imported)",
  )
  lines.push(`engine ${s.engineVersion} · schema v${s.schemaVersion}`)
  for (const c of s.collections) {
    lines.push(
      `  ${c.id} · ${c.name} · docs ${c.documents} · sections ${c.sections} · stale ${c.stale} · last updated ${iso(c.lastUpdatedAt)}`,
    )
  }
  lines.push(`stale total: ${s.staleCount} · last reindex: ${iso(s.lastReindexAt)}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// list

export function renderCollections(collections: CollectionSummary[]): string {
  const lines = collections.map(
    (c) =>
      `${c.id} · ${c.name} · docs ${c.documents} · sections ${c.sections} · stale ${c.stale} · last updated ${iso(c.lastUpdatedAt)}`,
  )
  const docs = collections.reduce((n, c) => n + c.documents, 0)
  const sections = collections.reduce((n, c) => n + c.sections, 0)
  lines.push(`total: ${docs} docs · ${sections} sections across ${collections.length} collections`)
  return lines.join("\n")
}

export function renderDocuments(docs: DocumentRecord[], collection: string, verbose: boolean): string {
  if (docs.length === 0) {
    return `collection "${collection}" has no documents yet — research_library_import can add the first one`
  }
  const lines = docs.map((d) =>
    verbose
      ? `${d.docId} · "${d.title}" · version ${d.version} · status ${d.status} · published ${pubDate(d.publicationDate)} · age ${d.ageDays}d${staleFlag(d.stale)} · hash ${hash8(d.contentHash)}`
      : `${d.docId} · "${d.title}" · ${d.version}/${d.status} · age ${d.ageDays}d${staleFlag(d.stale)}`,
  )
  lines.push(`${docs.length} document(s) in "${collection}"`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// search

export function renderSearch(
  query: string,
  collection: string | undefined,
  result: { hits: SearchHit[]; tookMs: number },
): string {
  if (result.hits.length === 0) {
    return `No library hits for ${query} (searched ${collection ? `collection "${collection}"` : "all collections"}) — external research may be needed.`
  }
  const lines = result.hits.map((h) => {
    const parts = [
      h.docId,
      h.section ? `§${h.section.anchor}` : null,
      `"${h.title}"`,
      `${h.version}/${h.status}`,
      `published ${pubDate(h.publicationDate)}`,
      `age ${h.ageDays}d${staleFlag(h.stale)}`,
      `score ${h.score.toFixed(3)}`,
    ]
    let line = parts.filter((p) => p !== null).join(" · ")
    if (h.section) {
      // engine snippets are already capped (240 chars); flatten whitespace so
      // one hit stays one line
      const snippet = h.section.snippet.replace(/\s+/g, " ").trim()
      if (snippet.length > 0) line += ` · ${snippet}`
    }
    return line
  })
  const stale = result.hits.filter((h) => h.stale).length
  lines.push(`${result.hits.length} hit(s) (${stale} stale) · ${result.tookMs}ms`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// get

export function renderDocument(doc: DocumentRecord, section?: string): string {
  const lines: string[] = []
  lines.push(`# ${doc.docId} — ${doc.title}`)
  lines.push(`source: ${doc.sourceUrl}`)
  lines.push(`collection: ${doc.collection} · version: ${doc.version} · status: ${doc.status}`)
  lines.push(
    `published: ${pubDate(doc.publicationDate)} · retrieved: ${iso(doc.retrievedAt)} · verified: ${doc.verifiedAt === null ? "never" : iso(doc.verifiedAt)}`,
  )
  lines.push(
    `age: ${doc.ageDays}d${staleFlag(doc.stale)}${doc.stale ? " — beyond the collection TTL; verify externally before relying on this" : ""}`,
  )
  lines.push(`revision: ${doc.revision} · content hash: ${hash8(doc.contentHash)}`)
  lines.push(`file: ${doc.filePath ?? "-"}`)
  if (doc.notes.length > 0) lines.push(`notes: ${doc.notes}`)

  if (doc.sections === undefined) {
    lines.push("(section bodies unavailable)")
    return lines.join("\n")
  }
  if (doc.sections.length === 0) {
    lines.push(
      `no section matching ${JSON.stringify(section ?? "")} in ${doc.docId} — use research_library_search with scope "sections" to find exact anchors`,
    )
    return lines.join("\n")
  }
  for (const s of doc.sections) {
    lines.push("", `— §${s.anchor} · ${s.heading}`, s.body ?? "(body not requested)")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// import

export function renderIngest(result: IngestResult): string {
  const base = `${result.outcome} · ${result.docId} · revision ${result.revision} · hash ${hash8(result.contentHash)} · ${result.sectionCount} section(s) · file: ${result.sourcePath}`
  return result.outcome === "unchanged"
    ? `${base} — duplicate import ignored (freshness honest: retrieved_at not bumped)`
    : base
}

// ---------------------------------------------------------------------------
// refresh --reindex

export function renderReindex(result: ReindexResult): string {
  const lines = [
    `Reindexed ${result.documents} documents / ${result.sections} sections (${result.skipped.length} skipped) · ${result.tookMs}ms`,
  ]
  for (const s of result.skipped) lines.push(`skipped ${s.manifest}: ${s.error}`)
  return lines.join("\n")
}
