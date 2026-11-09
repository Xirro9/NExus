// Research library plugin (T2) — registers the six research_library_* tools
// with the opencode V2 plugin runtime. BARE tool names (no namespace); the
// researcher agent (.opencode/agents/researcher.md) is their primary user,
// Jerry sessions the secondary one. Machine consumers must use the CLI
// (--json) instead of parsing tool text.
//
// Layering contract: this file holds NO engine logic. Every operation
// delegates to the engine (src/lib/research/engine.ts — the same module the
// CLI wraps) and every result is rendered by ./render.ts. The import uses an
// explicit .ts extension and works on both runtime legs (Bun plugin runtime
// here, Node type-stripping for the CLI).
//
// Robustness contract: root resolution and engine calls happen INSIDE each
// tool execute (never in setup) and any failure becomes an honest
// "research library error: <message>" text. setup only registers tools and
// never throws — a broken library must not break sessions in this repo.

import { Plugin } from "@opencode/plugin"
import * as lib from "../../../src/lib/research/engine.ts"
import {
  renderCollections,
  renderDocument,
  renderDocuments,
  renderIngest,
  renderReindex,
  renderSearch,
  renderStatus,
} from "./render.ts"

// ---------------------------------------------------------------------------
// input shapes (mirrors of the JSON Schemas below — the engine re-validates
// everything and is the authority; the schemas exist to steer the model)

interface SearchInput {
  query: string
  collection?: string
  limit?: number
  scope?: "all" | "documents" | "sections"
}

interface ListInput {
  collection?: string
  verbose?: boolean
}

interface GetInput {
  docId: string
  section?: string
  maxChars?: number
}

interface ImportInput {
  collection: string
  slug: string
  title: string
  sourceUrl: string
  content: string
  contentType?: string
  publicationDate?: string
  version?: string
  status?: "cached" | "verified"
  notes?: string
  sections?: { anchor: string; heading: string; body: string }[]
}

interface RefreshInput {
  reindex?: boolean
}

// ---------------------------------------------------------------------------
// helpers

const COLLECTION_ENUM: string[] = [...lib.COLLECTIONS]

function errorText(err: unknown): string {
  return `research library error: ${err instanceof Error ? err.message : String(err)}`
}

function resolveRoot(): string {
  return lib.resolveLibraryRoot(process.env.RESEARCH_LIBRARY_ROOT ?? undefined)
}

function text(t: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: t }] }
}

// ---------------------------------------------------------------------------
// tool definitions

const searchTool = {
  name: "research_library_search",
  description:
    "Search the local research library FIRST, before any web research. Full-text (FTS) search over document titles/notes and section bodies; returns ranked hits with docId, section anchor, title, version/status, publication date, age with staleness flag, relevance score and a snippet. Narrow with collection (legislation | cybersecurity | ai-research | technical-docs | projects), scope (all | documents | sections — 'sections' is best for finding bill sections like 'SEC. 4'), limit (1-20, default 8). Empty or stale results mean the answer needs external verification via websearch/webfetch.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 512, description: "Search terms; trailing * acts as prefix wildcard." },
      collection: { type: "string", enum: COLLECTION_ENUM, description: "Restrict to one collection." },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 8, description: "Maximum hits returned." },
      scope: {
        type: "string",
        enum: ["all", "documents", "sections"],
        default: "all",
        description: "'documents' matches titles/notes only, 'sections' matches section headings/bodies only.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (input: SearchInput) => {
    try {
      const root = resolveRoot()
      const result = lib.search(root, input.query, {
        collection: input.collection as lib.CollectionId | undefined,
        limit: input.limit,
        scope: input.scope,
      })
      return text(renderSearch(input.query, input.collection, result))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

const listTool = {
  name: "research_library_list",
  description:
    "Orient in the research library: without 'collection', lists every collection with document/section/stale counts and last-updated time; with 'collection', lists that collection's documents (verbose:true adds version, status, publication date, age and content hash per document). Cheaper than search when you need an overview; use it before importing to check whether a source already exists.",
  input: {
    type: "object",
    properties: {
      collection: { type: "string", enum: COLLECTION_ENUM, description: "List one collection's documents instead of all collections." },
      verbose: { type: "boolean", default: false, description: "With collection: full metadata line per document." },
    },
    additionalProperties: false,
  },
  execute: async (input: ListInput) => {
    try {
      const root = resolveRoot()
      if (input.collection !== undefined) {
        const docs = lib.listDocuments(root, input.collection as lib.CollectionId)
        return text(renderDocuments(docs, input.collection, input.verbose === true))
      }
      return text(renderCollections(lib.listCollections(root)))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

const getTool = {
  name: "research_library_get",
  description:
    "Read one library document by docId ('<collection>/<slug>', as returned by research_library_search or research_library_list). Returns full metadata (source URL, version, status, publication/retrieved/verified dates, age + staleness, revision, content hash, file path) followed by the content split into sections. Prefer targeted reads to save context: pass section (anchor substring, e.g. 'SEC. 4') to fetch a single bill section and maxChars (500-50000, default 12000) to bound size instead of pulling whole documents into context.",
  input: {
    type: "object",
    properties: {
      docId: { type: "string", description: "Document id, e.g. \"legislation/s-5471\"." },
      section: { type: "string", description: "Anchor substring filter, e.g. \"SEC. 4\" — returns only matching sections." },
      maxChars: { type: "integer", minimum: 500, maximum: 50000, default: 12000, description: "Per-section character budget (truncation is marked in the text)." },
    },
    required: ["docId"],
    additionalProperties: false,
  },
  execute: async (input: GetInput) => {
    try {
      const root = resolveRoot()
      const doc = lib.getDocument(root, input.docId, {
        sections: true,
        section: input.section,
        maxChars: input.maxChars,
      })
      return text(doc === null ? `not found in library: ${input.docId}` : renderDocument(doc, input.section))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

const importTool = {
  name: "research_library_import",
  description:
    "Add a NEW source document to the research library — one import per distinct source, and only findings you actually verified this session (via webfetch/websearch or a primary source). Required: collection, slug (lowercase-dash id), title, sourceUrl, content (full text). Optional: sections (structured {anchor, heading, body} — for bills split on 'SEC. N.' headings), publicationDate (YYYY-MM-DD), version, status (cached | verified), notes (e.g. 'Status: introduced in Senate (not enacted), checked 2026-11-09'), contentType. Identical re-imports are detected and ignored (retrieved_at is not bumped) — do not waste steps re-importing unchanged documents. This tool writes only inside research-library/; it never edits project files.",
  input: {
    type: "object",
    properties: {
      collection: { type: "string", enum: COLLECTION_ENUM, description: "Which collection the document belongs to." },
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$", description: "Document id suffix; a NEW version of the same source needs a NEW slug (e.g. s-5471-enr)." },
      title: { type: "string", minLength: 1, maxLength: 300 },
      sourceUrl: { type: "string", pattern: "^https?://", description: "Primary source URL the content came from." },
      content: { type: "string", minLength: 1, maxLength: 1500000, description: "Full document text (normalized plain text)." },
      contentType: { type: "string", description: "Optional MIME type; picks the stored file extension." },
      publicationDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD publication date of the source, when known." },
      version: { type: "string", maxLength: 64, description: "Version/stage label, e.g. 'introduced'; defaults to 'current'." },
      status: { type: "string", enum: ["cached", "verified"], description: "'verified' also records the verification time (resets the freshness clock)." },
      notes: { type: "string", maxLength: 4000, description: "For legislation ALWAYS carry: 'Status: <verbatim status>, checked YYYY-MM-DD'." },
      sections: {
        type: "array",
        maxItems: 500,
        description: "Structured sections; omit to auto-split bill text on 'SEC. N.' lines.",
        items: {
          type: "object",
          properties: {
            anchor: { type: "string", maxLength: 120, description: "Exact anchor, e.g. 'SEC. 4.'" },
            heading: { type: "string", maxLength: 300 },
            body: { type: "string", maxLength: 200000 },
          },
          required: ["anchor", "heading", "body"],
          additionalProperties: false,
        },
      },
    },
    required: ["collection", "slug", "title", "sourceUrl", "content"],
    additionalProperties: false,
  },
  execute: async (input: ImportInput) => {
    try {
      const root = resolveRoot()
      const result = lib.ingest(root, {
        collection: input.collection as lib.CollectionId,
        slug: input.slug,
        title: input.title,
        sourceUrl: input.sourceUrl,
        content: input.content,
        contentType: input.contentType,
        publicationDate: input.publicationDate ?? null,
        version: input.version,
        status: input.status,
        notes: input.notes,
        sections: input.sections,
      })
      return text(renderIngest(result))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

const refreshTool = {
  name: "research_library_refresh",
  description:
    "Rebuild the derived SQLite index (research-library/indexes/research.db) by replaying every sources/**/manifest.json — the unit of record. Use when the index is missing or corrupt or after out-of-band changes to research-library/sources; reports document/section counts, duration and any skipped (corrupt) manifests. With reindex:false it only reports current status without touching anything.",
  input: {
    type: "object",
    properties: {
      reindex: { type: "boolean", default: true, description: "false = report status only, do not rebuild." },
    },
    additionalProperties: false,
  },
  execute: async (input: RefreshInput) => {
    try {
      const root = resolveRoot()
      if (input.reindex === false) {
        return text(`reindex skipped (reindex:false) — current state:\n${renderStatus(lib.status(root))}`)
      }
      return text(renderReindex(lib.reindex(root)))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

const statusTool = {
  name: "research_library_status",
  description:
    "Zero-cost health check of the research library: root path, whether the derived index exists (and its size), engine/schema versions, per-collection document/section/stale counts, total stale count and last reindex time. dbExists false or all-zero counts mean the library is empty — searches will return nothing until documents are imported.",
  input: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: async () => {
    try {
      return text(renderStatus(lib.status(resolveRoot())))
    } catch (err) {
      return text(errorText(err))
    }
  },
}

// ---------------------------------------------------------------------------
// registration

export default Plugin.define({
  id: "research-library",
  async setup(ctx) {
    try {
      await ctx.tool.transform((editor) => {
        editor.add(statusTool)
        editor.add(searchTool)
        editor.add(listTool)
        editor.add(getTool)
        editor.add(importTool)
        editor.add(refreshTool)
      })
    } catch (err) {
      // registration failure must never break sessions in this repo — the
      // library tools are simply unavailable
      console.error("[research-library] tool registration failed (sessions unaffected):", err)
    }
  },
})
