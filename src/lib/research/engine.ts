// Research library engine — the deterministic, LLM-free core of the
// research-library feature (docs pipeline T1). Single source of truth for
// schema, hashing, freshness and FTS semantics; the CLI
// (.opencode/plugins/research-library/cli.mjs) is a thin wrapper, and the
// tool/plugin layers (T2) must call these functions rather than reimplement.
//
// Two runtime legs, one file:
//   - plain Node (v24 type-stripping) for the CLI and vitest — imports of this
//     file MUST use an explicit .ts extension there;
//   - Bun (opencode v2.2.5 plugin runtime) for the researcher tooling.
// So: node: builtins only, no dependencies, erasable-syntax-only TypeScript
// (no enums / namespaces / parameter properties — tsconfig.app.json enforces).
//
// Design invariants:
//   - sources/ + manifests are the unit of record; the SQLite index
//     (research-library/indexes/research.db) is derived and rebuildable via
//     reindex() ("refresh --reindex").
//   - ingest is idempotent: identity = (collection, source_url, version),
//     content hash = sha256 of normalized text. retrieved_at is never bumped
//     on unchanged re-ingest; the only silent mutation is the verification
//     bump (status "verified" + verified_at).
//   - staleness is COMPUTED at read time from TTLs and never stored; the
//     "stale" status VALUE is reserved for explicit researcher marking and is
//     not settable through ingest.
//   - reads never throw for a missing/corrupt DB — they return empty results.
//   - all FTS writes ride the same transaction as the row writes (external
//     content tables + trigger triples below).

import { createHash } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

// ---------------------------------------------------------------------------
// public constants + types

export const COLLECTIONS = [
  "legislation",
  "cybersecurity",
  "ai-research",
  "technical-docs",
  "projects",
] as const

export type CollectionId = typeof COLLECTIONS[number]

export const SCHEMA_VERSION = 1
export const ENGINE_VERSION = "1.0.0"

const LIB_DIR = "research-library"

export type DocStatus = "cached" | "verified" | "stale" | "superseded"

export interface SearchOpts {
  collection?: CollectionId
  limit?: number
  scope?: "all" | "documents" | "sections"
}

export interface SearchHit {
  docId: string
  collection: CollectionId
  title: string
  sourceUrl: string
  version: string
  status: DocStatus
  publicationDate: string | null
  retrievedAt: number
  verifiedAt: number | null
  ageDays: number
  stale: boolean
  score: number
  section: { id: string; anchor: string; heading: string; snippet: string } | null
}

export interface CollectionSummary {
  id: CollectionId
  name: string
  description: string
  documents: number
  sections: number
  stale: number
  lastUpdatedAt: number | null
}

export interface SectionRecord {
  id: string
  anchor: string
  heading: string
  ordinal: number
  contentHash: string
  /** Present only when requested (getDocument opts); maxChars applies. */
  body?: string
}

export interface DocumentRecord {
  docId: string
  collection: CollectionId
  title: string
  sourceUrl: string
  publicationDate: string | null
  retrievedAt: number
  verifiedAt: number | null
  version: string
  status: DocStatus
  revision: number
  contentHash: string
  /** Repo-relative, e.g. "research-library/sources/legislation/s-5471/r1-abc12345.txt". */
  filePath: string | null
  notes: string
  ageDays: number
  stale: boolean
  /** Present only when requested; `[]` means a section filter matched nothing. */
  sections?: SectionRecord[]
}

export interface IngestDocInput {
  collection: CollectionId
  slug: string
  title: string
  sourceUrl: string
  content: string
  contentType?: string
  publicationDate?: string | null
  version?: string
  status?: "cached" | "verified"
  notes?: string
  sections?: { anchor: string; heading: string; body: string }[]
  /** Injection point for deterministic tests / backdating; defaults to now. */
  retrievedAt?: number
}

export interface IngestResult {
  docId: string
  outcome: "created" | "updated" | "unchanged"
  revision: number
  contentHash: string
  sectionCount: number
  /** Repo-relative path of the current revision's source file. */
  sourcePath: string
}

export interface ReindexResult {
  documents: number
  sections: number
  skipped: { manifest: string; error: string }[]
  tookMs: number
}

export interface LibraryStatus {
  root: string
  dbExists: boolean
  dbSizeBytes: number | null
  schemaVersion: number
  engineVersion: string
  collections: CollectionSummary[]
  staleCount: number
  lastReindexAt: number | null
}

// ---------------------------------------------------------------------------
// small helpers

interface CollectionMeta {
  name: string
  description: string
  ttlDays: number
}

const DEFAULT_COLLECTIONS: Record<CollectionId, CollectionMeta> = {
  legislation: {
    name: "Legislation",
    description: "Bills, public laws and congressional materials (congress.gov, govinfo).",
    ttlDays: 30,
  },
  cybersecurity: {
    name: "Cybersecurity",
    description: "Advisories, threat reports and hardening guidance (CISA, NIST, vendors).",
    ttlDays: 90,
  },
  "ai-research": {
    name: "AI Research",
    description: "Papers, model documentation and technical AI-policy analysis.",
    ttlDays: 180,
  },
  "technical-docs": {
    name: "Technical Documentation",
    description: "Standards, API references and tooling manuals.",
    ttlDays: 365,
  },
  projects: {
    name: "Projects",
    description: "Project-local working documents and notes.",
    ttlDays: 30,
  },
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DOC_ID_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/
const SEC_LINE_RE = /^SEC\.\s+\d+\./
const SEC_ANCHOR_RE = /^SEC\.\s*\d+/

const DAY_MS = 86_400_000
const DEFAULT_MAX_CHARS = 12_000
const MAX_CHARS_FLOOR = 500
const MAX_CHARS_CEIL = 50_000
const SNIPPET_CHARS = 240

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`${field} must be a string`)
  return v
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** sha256 hex over content normalized \r\n→\n with trailing whitespace trimmed. */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd()
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function hash8(hash: string): string {
  return hash.slice(0, 8)
}

/** Lowercase, non-alnum → "-"; collapses runs; never empty. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return slug.length > 0 ? slug : "sec"
}

function extFor(contentType: string): string {
  const ct = contentType.toLowerCase().split(";")[0].trim()
  if (ct === "application/xhtml+xml" || ct === ".xhtml") return ".xhtml"
  if (ct === "text/html" || ct === ".html") return ".html"
  if (ct === "text/markdown" || ct === "text/x-markdown" || ct === ".md") return ".md"
  return ".txt"
}

function toPosix(p: string): string {
  return p.split("\\").join("/")
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 8
  return Math.min(50, Math.max(1, Math.floor(limit)))
}

function clampMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return DEFAULT_MAX_CHARS
  return Math.min(MAX_CHARS_CEIL, Math.max(MAX_CHARS_FLOOR, Math.floor(maxChars)))
}

function applyMaxChars(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body
  return `${body.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`
}

function tookMsSince(t0: number): number {
  return Math.round((performance.now() - t0) * 100) / 100
}

// ---------------------------------------------------------------------------
// collection config (metadata/collections.json overrides the defaults)

function collectionMeta(root: string): Record<CollectionId, CollectionMeta> {
  const out: Record<CollectionId, CollectionMeta> = { ...DEFAULT_COLLECTIONS }
  try {
    const p = join(root, LIB_DIR, "metadata", "collections.json")
    if (!isFile(p)) return out
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"))
    const map = isRecord(parsed) ? parsed.collections : null
    if (!isRecord(map)) return out
    for (const id of COLLECTIONS) {
      const entry = map[id]
      if (!isRecord(entry)) continue
      const def = DEFAULT_COLLECTIONS[id]
      out[id] = {
        name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : def.name,
        description:
          typeof entry.description === "string" && entry.description.length > 0
            ? entry.description
            : def.description,
        ttlDays:
          typeof entry.ttlDays === "number" && Number.isFinite(entry.ttlDays) && entry.ttlDays > 0
            ? Math.floor(entry.ttlDays)
            : def.ttlDays,
      }
    }
  } catch {
    // malformed config → defaults (reads must never crash on a bad metadata file)
  }
  return out
}

// ---------------------------------------------------------------------------
// root resolution

/**
 * Anchor chain: (1) explicit argument, (2) env RESEARCH_LIBRARY_ROOT — both
 * used verbatim (writes create research-library/ on demand) — then a walk-up
 * from this file's directory and finally from process.cwd(), each looking for
 * a directory that CONTAINS research-library/ (that dir is the repo root).
 * Throws (code ENOENT) when nothing anchors.
 */
export function resolveLibraryRoot(explicit?: string | null): string {
  const arg = typeof explicit === "string" ? explicit.trim() : ""
  if (arg.length > 0) return resolve(arg)
  const env = (process.env.RESEARCH_LIBRARY_ROOT ?? "").trim()
  if (env.length > 0) return resolve(env)
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()]
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      if (isDir(join(dir, LIB_DIR))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const err = new Error(
    "research library root not found — pass --root, set RESEARCH_LIBRARY_ROOT, or run from a checkout containing research-library/",
  )
  ;(err as NodeJS.ErrnoException).code = "ENOENT"
  throw err
}

// ---------------------------------------------------------------------------
// schema + database open

function dbPath(root: string): string {
  return join(root, LIB_DIR, "indexes", "research.db")
}

function sourceDir(root: string, collection: string, slug: string): string {
  return join(root, LIB_DIR, "sources", collection, slug)
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined
  return typeof row?.user_version === "number" ? row.user_version : 0
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ttl_days    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY, -- "<collection>/<slug>"
  collection       TEXT NOT NULL REFERENCES collections(id),
  title            TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  publication_date TEXT,
  retrieved_at     INTEGER NOT NULL,
  verified_at      INTEGER,
  version          TEXT NOT NULL DEFAULT 'current',
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'cached',
  origin           TEXT NOT NULL DEFAULT 'import',
  file_path        TEXT,
  revision         INTEGER NOT NULL DEFAULT 1,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_identity ON documents(collection, source_url, version);

CREATE TABLE IF NOT EXISTS document_revisions (
  document_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  file         TEXT,
  PRIMARY KEY (document_id, revision)
);

CREATE TABLE IF NOT EXISTS sections (
  id           TEXT PRIMARY KEY, -- "<docId>#<ordinal>-<slugified-heading>"
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  anchor       TEXT NOT NULL,
  heading      TEXT NOT NULL,
  body         TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sections_document ON sections(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, notes, source_url,
  content='documents', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  heading, body,
  content='sections', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, notes, source_url)
  VALUES (new.rowid, new.title, new.notes, new.source_url);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, notes, source_url)
  VALUES ('delete', old.rowid, old.title, old.notes, old.source_url);
  INSERT INTO documents_fts(rowid, title, notes, source_url)
  VALUES (new.rowid, new.title, new.notes, new.source_url);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_bd BEFORE DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, notes, source_url)
  VALUES ('delete', old.rowid, old.title, old.notes, old.source_url);
END;

CREATE TRIGGER IF NOT EXISTS sections_fts_ad AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, heading, body)
  VALUES (new.rowid, new.heading, new.body);
END;

CREATE TRIGGER IF NOT EXISTS sections_fts_au AFTER UPDATE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, heading, body)
  VALUES ('delete', old.rowid, old.heading, old.body);
  INSERT INTO sections_fts(rowid, heading, body)
  VALUES (new.rowid, new.heading, new.body);
END;

CREATE TRIGGER IF NOT EXISTS sections_fts_bd BEFORE DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, heading, body)
  VALUES ('delete', old.rowid, old.heading, old.body);
END;
`

function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL)
  const now = Date.now()
  const seed = db.prepare(
    "INSERT OR IGNORE INTO collections (id, name, description, ttl_days, created_at) VALUES (?, ?, ?, ?, ?)",
  )
  for (const id of COLLECTIONS) {
    seed.run(id, DEFAULT_COLLECTIONS[id].name, DEFAULT_COLLECTIONS[id].description, DEFAULT_COLLECTIONS[id].ttlDays, now)
  }
  if (readUserVersion(db) === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * mode "read"  → null when the DB is missing / unusable (reads degrade to
 *                 empty results, never throw);
 * mode "write" → creates the DB (and parent dirs) as needed; throws only on a
 *                 schema that is NEWER than this engine understands.
 */
function openDb(root: string, mode: "read" | "write"): DatabaseSync | null {
  const p = dbPath(root)
  if (!isFile(p)) {
    if (mode === "read") return null
    mkdirSync(dirname(p), { recursive: true })
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(p)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
  } catch (err) {
    if (mode === "read") return null
    throw err
  }
  try {
    const ver = readUserVersion(db)
    if (mode === "read") {
      if (ver !== SCHEMA_VERSION) {
        db.close()
        return null
      }
      ensureSchema(db) // idempotent; no-op writes when the schema is current
      return db
    }
    if (ver > SCHEMA_VERSION) {
      db.close()
      throw new Error(
        `research library database schema v${ver} is newer than engine schema v${SCHEMA_VERSION} — upgrade the engine or run "refresh --reindex" after removing ${p}`,
      )
    }
    ensureSchema(db)
    return db
  } catch (err) {
    try {
      db.close()
    } catch {
      // already closed
    }
    if (mode === "read") return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// validation

function assertCollection(collection: unknown): asserts collection is CollectionId {
  if (typeof collection !== "string" || !COLLECTIONS.includes(collection as CollectionId)) {
    throw new Error(
      `invalid collection ${JSON.stringify(collection)} — expected one of: ${COLLECTIONS.join(", ")}`,
    )
  }
}

function validatedSlug(slug: unknown): string {
  const s = requireString(slug, "slug")
  if (!SLUG_RE.test(s)) {
    throw new Error(
      `invalid slug ${JSON.stringify(s)} — must match ^[a-z0-9][a-z0-9-]{0,79}$ (lowercase letters, digits and dashes; no leading dash)`,
    )
  }
  return s
}

function validatedTitle(title: unknown): string {
  const t = requireString(title, "title")
  if (t.length === 0) throw new Error("title must not be empty")
  if (t.length > 300) throw new Error(`title exceeds 300 characters (got ${t.length})`)
  return t
}

function validatedSourceUrl(url: unknown): string {
  const u = requireString(url, "sourceUrl")
  if (!/^https?:\/\//.test(u)) {
    throw new Error(`invalid sourceUrl ${JSON.stringify(u)} — must start with http:// or https://`)
  }
  return u
}

function validatedContent(content: unknown): string {
  const c = requireString(content, "content")
  if (c.length > 1_500_000) {
    throw new Error(`content exceeds 1,500,000 characters (got ${c.length})`)
  }
  return c
}

function validatedPublicationDate(date: unknown): string | null {
  if (date === undefined || date === null) return null
  const d = requireString(date, "publicationDate")
  if (!DATE_RE.test(d)) {
    throw new Error(`invalid publicationDate ${JSON.stringify(d)} — must be YYYY-MM-DD or null`)
  }
  // shape regex alone would accept 2026-13-40 — verify it is a real calendar day
  const [y, m, day] = d.split("-").map(Number) as [number, number, number]
  const asUtc = new Date(Date.UTC(y, m - 1, day))
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== day) {
    throw new Error(`invalid publicationDate ${JSON.stringify(d)} — not a real calendar date`)
  }
  return d
}

function validatedVersion(version: unknown): string {
  if (version === undefined || version === null) return "current"
  const v = requireString(version, "version")
  if (v.length === 0) throw new Error("version must not be empty")
  if (v.length > 64) throw new Error(`version exceeds 64 characters (got ${v.length})`)
  return v
}

function validatedNotes(notes: unknown): string {
  if (notes === undefined || notes === null) return ""
  const n = requireString(notes, "notes")
  if (n.length > 4000) throw new Error(`notes exceed 4000 characters (got ${n.length})`)
  return n
}

function validatedRetrievedAt(retrievedAt: unknown): number | null {
  if (retrievedAt === undefined || retrievedAt === null) return null
  if (typeof retrievedAt !== "number" || !Number.isFinite(retrievedAt)) {
    throw new Error("retrievedAt must be a finite epoch-milliseconds number")
  }
  return Math.floor(retrievedAt)
}

// Section caps — shared by ingest validation and manifest replay so a
// hand-edited manifest cannot inject unbounded sections at reindex time.
const MAX_SECTIONS = 500
const MAX_SECTION_ANCHOR = 120
const MAX_SECTION_HEADING = 300
const MAX_SECTION_BODY = 200_000

function validatedExplicitSections(sections: unknown): { anchor: string; heading: string; body: string }[] {
  if (sections === undefined || sections === null) return []
  if (!Array.isArray(sections)) throw new Error("sections must be an array")
  if (sections.length > MAX_SECTIONS) {
    throw new Error(`sections exceeds ${MAX_SECTIONS} entries (got ${sections.length})`)
  }
  return sections.map((s, i) => {
    if (!isRecord(s)) throw new Error(`sections[${i}] must be an object`)
    const anchor = requireString(s.anchor, `sections[${i}].anchor`)
    if (anchor.length === 0) throw new Error(`sections[${i}].anchor must not be empty`)
    if (anchor.length > MAX_SECTION_ANCHOR) {
      throw new Error(`sections[${i}].anchor exceeds ${MAX_SECTION_ANCHOR} characters (got ${anchor.length})`)
    }
    const heading = requireString(s.heading, `sections[${i}].heading`)
    if (heading.length > MAX_SECTION_HEADING) {
      throw new Error(`sections[${i}].heading exceeds ${MAX_SECTION_HEADING} characters (got ${heading.length})`)
    }
    const body = requireString(s.body, `sections[${i}].body`)
    if (body.length > MAX_SECTION_BODY) {
      throw new Error(`sections[${i}].body exceeds ${MAX_SECTION_BODY} characters (got ${body.length})`)
    }
    return { anchor, heading, body }
  })
}

// ---------------------------------------------------------------------------
// section derivation

interface DerivedSection {
  anchor: string
  heading: string
  body: string
}

/**
 * Explicit sections win. Otherwise auto-split on legislation-style
 * "SEC. N." lines when ≥2 matches (any preamble is prepended to the first
 * section so the replay stays lossless), else a single implicit section.
 */
function deriveSections(
  title: string,
  normalizedContent: string,
  explicit: { anchor: string; heading: string; body: string }[],
): DerivedSection[] {
  if (explicit.length > 0) return explicit.map((s) => ({ ...s }))
  const lines = normalizedContent.split("\n")
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (SEC_LINE_RE.test(lines[i].trim())) starts.push(i)
  }
  if (starts.length >= 2) {
    const preamble = lines.slice(0, starts[0]).join("\n").trim()
    const out: DerivedSection[] = []
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length
      let body = lines.slice(starts[k], end).join("\n").trimEnd()
      if (k === 0 && preamble.length > 0) body = `${preamble}\n\n${body}`
      const line = lines[starts[k]].trim()
      const anchorMatch = line.match(SEC_ANCHOR_RE)
      const anchor = (anchorMatch ? anchorMatch[0] : line.slice(0, 120)).replace(/\s+/g, " ").trim()
      out.push({ anchor, heading: line, body })
    }
    return out
  }
  return [{ anchor: "all", heading: title, body: normalizedContent }]
}

// ---------------------------------------------------------------------------
// freshness

function freshness(
  retrievedAt: number,
  verifiedAt: number | null,
  ttlDays: number,
  now: number,
): { ageDays: number; stale: boolean } {
  const newest = Math.max(retrievedAt, verifiedAt ?? 0)
  const ageDays = Math.floor((now - newest) / DAY_MS)
  return { ageDays, stale: ageDays > ttlDays }
}

// ---------------------------------------------------------------------------
// manifests (unit of record)

interface ManifestRevision {
  revision: number
  contentHash: string
  retrievedAt: number
  file: string // repo-relative
}

interface Manifest {
  schema: number
  collection: CollectionId
  slug: string
  title: string
  sourceUrl: string
  publicationDate: string | null
  version: string
  status: "cached" | "verified" | "superseded"
  notes: string
  verifiedAt: number | null
  sections: { anchor: string; heading: string; body: string }[]
  revisions: ManifestRevision[]
}

function manifestPath(root: string, collection: string, slug: string): string {
  return join(sourceDir(root, collection, slug), "manifest.json")
}

function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(manifestPath(root, manifest.collection, manifest.slug), JSON.stringify(manifest, null, 2) + "\n", "utf8")
}

function readManifest(path: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(raw)) throw new Error("manifest is not a JSON object")
  if (raw.schema !== SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schema ${JSON.stringify(raw.schema)} (expected ${SCHEMA_VERSION})`)
  }
  assertCollection(raw.collection)
  const slug = requireString(raw.slug, "manifest.slug")
  if (!SLUG_RE.test(slug)) throw new Error(`invalid manifest slug ${JSON.stringify(slug)}`)
  const title = requireString(raw.title, "manifest.title")
  if (title.length === 0 || title.length > 300) throw new Error("manifest.title length out of range")
  const sourceUrl = requireString(raw.sourceUrl, "manifest.sourceUrl")
  if (!/^https?:\/\//.test(sourceUrl)) throw new Error(`invalid manifest.sourceUrl ${JSON.stringify(sourceUrl)}`)
  const publicationDate = validatedPublicationDate(raw.publicationDate)
  const version = validatedVersion(raw.version)
  const status = raw.status
  if (status !== "cached" && status !== "verified" && status !== "superseded") {
    throw new Error(`invalid manifest.status ${JSON.stringify(status)}`)
  }
  const notes = typeof raw.notes === "string" ? raw.notes : ""
  const verifiedAt = typeof raw.verifiedAt === "number" && Number.isFinite(raw.verifiedAt) ? raw.verifiedAt : null
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : []
  if (sectionsRaw.length > MAX_SECTIONS) {
    throw new Error(`manifest.sections exceeds ${MAX_SECTIONS} entries (got ${sectionsRaw.length})`)
  }
  const sections = sectionsRaw.map((s, i) => {
    if (!isRecord(s)) throw new Error(`manifest.sections[${i}] must be an object`)
    const anchor = requireString(s.anchor, `manifest.sections[${i}].anchor`)
    if (anchor.length > MAX_SECTION_ANCHOR) {
      throw new Error(`manifest.sections[${i}].anchor exceeds ${MAX_SECTION_ANCHOR} characters (got ${anchor.length})`)
    }
    const heading = requireString(s.heading, `manifest.sections[${i}].heading`)
    if (heading.length > MAX_SECTION_HEADING) {
      throw new Error(`manifest.sections[${i}].heading exceeds ${MAX_SECTION_HEADING} characters (got ${heading.length})`)
    }
    const body = requireString(s.body, `manifest.sections[${i}].body`)
    if (body.length > MAX_SECTION_BODY) {
      throw new Error(`manifest.sections[${i}].body exceeds ${MAX_SECTION_BODY} characters (got ${body.length})`)
    }
    return { anchor, heading, body }
  })
  const revisionsRaw = Array.isArray(raw.revisions) ? raw.revisions : []
  const revisions = revisionsRaw.map((r, i) => {
    if (!isRecord(r)) throw new Error(`manifest.revisions[${i}] must be an object`)
    const revision = r.revision
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
      throw new Error(`manifest.revisions[${i}].revision must be a positive integer`)
    }
    const contentHash = requireString(r.contentHash, `manifest.revisions[${i}].contentHash`)
    const retrievedAt = r.retrievedAt
    if (typeof retrievedAt !== "number" || !Number.isFinite(retrievedAt)) {
      throw new Error(`manifest.revisions[${i}].retrievedAt must be a number`)
    }
    const file = requireString(r.file, `manifest.revisions[${i}].file`)
    return { revision, contentHash, retrievedAt, file }
  })
  if (revisions.length === 0) throw new Error("manifest.revisions must not be empty")
  return {
    schema: SCHEMA_VERSION,
    collection: raw.collection,
    slug,
    title,
    sourceUrl,
    publicationDate,
    version,
    status,
    notes,
    verifiedAt,
    sections,
    revisions,
  }
}

function latestRevision(revisions: ManifestRevision[]): ManifestRevision {
  return revisions.reduce((best, r) => (r.revision > best.revision ? r : best), revisions[0])
}

// ---------------------------------------------------------------------------
// ingest

const INSERT_DOC_SQL = `
INSERT INTO documents (
  id, collection, title, source_url, publication_date, retrieved_at, verified_at,
  version, content_hash, status, origin, file_path, revision, notes, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?)
`

const INSERT_REVISION_SQL = `
INSERT INTO document_revisions (document_id, revision, content_hash, retrieved_at, file)
VALUES (?, ?, ?, ?, ?)
`

function insertSections(
  db: DatabaseSync,
  docId: string,
  sections: DerivedSection[],
): number {
  db.prepare("DELETE FROM sections WHERE document_id = ?").run(docId)
  const insert = db.prepare(
    "INSERT INTO sections (id, document_id, ordinal, anchor, heading, body, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    const ordinal = i + 1
    const id = `${docId}#${ordinal}-${slugify(s.heading)}`
    insert.run(id, docId, ordinal, s.anchor, s.heading, normalizeText(s.body), sha256Hex(normalizeText(s.body)))
  }
  return sections.length
}

/**
 * Idempotent by identity (collection, source_url, version):
 *   - same identity + same content hash → "unchanged" (nothing touched except
 *     the verification bump);
 *   - same identity + different hash → revision + 1, prior source file kept;
 *   - new version of the same source_url → new row; every other row of that
 *     (collection, source_url) flips to "superseded" (the flip is persisted
 *     into the superseded document's manifest so reindex is order-free).
 */
export function ingest(root: string, input: IngestDocInput): IngestResult {
  assertCollection(input.collection)
  const collection = input.collection
  const slug = validatedSlug(input.slug)
  const title = validatedTitle(input.title)
  const sourceUrl = validatedSourceUrl(input.sourceUrl)
  const content = validatedContent(input.content)
  const contentType =
    input.contentType === undefined || input.contentType === null ? "" : requireString(input.contentType, "contentType")
  const publicationDate = validatedPublicationDate(input.publicationDate)
  const version = validatedVersion(input.version)
  const docStatus = input.status === undefined ? "cached" : input.status
  if (docStatus !== "cached" && docStatus !== "verified") {
    throw new Error(
      `invalid status ${JSON.stringify(docStatus)} — ingest accepts "cached" or "verified" ("stale"/"superseded" are engine-managed)`,
    )
  }
  const notes = validatedNotes(input.notes)
  const explicitSections = validatedExplicitSections(input.sections)
  const retrievedAt = validatedRetrievedAt(input.retrievedAt) ?? Date.now()

  const normalized = normalizeText(content)
  const contentHash = sha256Hex(normalized)
  const ext = extFor(contentType)
  const docId = `${collection}/${slug}`
  const now = Date.now()

  const db = openDb(root, "write")
  if (!db) throw new Error("research library database could not be opened for writing")
  try {
    db.exec("BEGIN IMMEDIATE")
    const selectIdentity = db.prepare(
      "SELECT id, content_hash, revision FROM documents WHERE collection = ? AND source_url = ? AND version = ?",
    )
    const existing = selectIdentity.get(collection, sourceUrl, version) as
      | { id: string; content_hash: string; revision: number }
      | undefined

    let result: IngestResult
    if (existing === undefined) {
      // create — check docId collisions first so no source file is written
      const clash = db
        .prepare("SELECT source_url, version FROM documents WHERE id = ?")
        .get(docId) as { source_url: string; version: string } | undefined
      if (clash !== undefined) {
        throw new Error(
          `document id collision: "${docId}" already exists (source_url=${clash.source_url}, version=${clash.version}) — use a different slug for this version`,
        )
      }
      const fileRel = toPosix(join(LIB_DIR, "sources", collection, slug, `r1-${hash8(contentHash)}${ext}`))
      mkdirSync(sourceDir(root, collection, slug), { recursive: true })
      writeFileSync(join(root, fileRel), content, "utf8")
      const sections = deriveSections(title, normalized, explicitSections)
      db.prepare(INSERT_DOC_SQL).run(
        docId,
        collection,
        title,
        sourceUrl,
        publicationDate,
        retrievedAt,
        docStatus === "verified" ? retrievedAt : null,
        version,
        contentHash,
        docStatus,
        fileRel,
        1,
        notes,
        now,
        now,
      )
      db.prepare(INSERT_REVISION_SQL).run(docId, 1, contentHash, retrievedAt, fileRel)
      const sectionCount = insertSections(db, docId, sections)
      writeManifest(root, {
        schema: SCHEMA_VERSION,
        collection,
        slug,
        title,
        sourceUrl,
        publicationDate,
        version,
        status: docStatus,
        notes,
        verifiedAt: docStatus === "verified" ? retrievedAt : null,
        sections: sections.map((s) => ({ anchor: s.anchor, heading: s.heading, body: normalizeText(s.body) })),
        revisions: [{ revision: 1, contentHash, retrievedAt, file: fileRel }],
      })
      result = { docId, outcome: "created", revision: 1, contentHash, sectionCount, sourcePath: fileRel }
    } else if (existing.content_hash === contentHash) {
      // unchanged — verification bump only
      const sectionCount = (
        db.prepare("SELECT COUNT(*) AS n FROM sections WHERE document_id = ?").get(docId) as { n: number }
      ).n
      const fileRel = (
        db.prepare("SELECT file_path FROM documents WHERE id = ?").get(docId) as { file_path: string | null }
      ).file_path
      if (docStatus === "verified") {
        const row = db
          .prepare("SELECT status, verified_at FROM documents WHERE id = ?")
          .get(docId) as { status: string; verified_at: number | null }
        // cached→verified: verification happens NOW even when re-ingesting an
        // old copy — the bump is what resets the freshness clock.
        // verified→verified: keep the ORIGINAL verification instant in BOTH db
        // and manifest — the manifest is the unit of record, so writing `now`
        // here would let the next reindex silently reset the freshness clock.
        const verifiedAt = row.status === "verified" ? row.verified_at : now
        if (row.status !== "verified") {
          db.prepare("UPDATE documents SET status = 'verified', verified_at = ?, updated_at = ? WHERE id = ?").run(
            now,
            now,
            docId,
          )
        }
        if (fileRel !== null) rewriteManifestStatus(root, docId, "verified", verifiedAt)
      }
      result = {
        docId,
        outcome: "unchanged",
        revision: existing.revision,
        contentHash,
        sectionCount,
        sourcePath: fileRel ?? "",
      }
    } else {
      // updated — new revision, prior source file retained
      const revision = existing.revision + 1
      const fileRel = toPosix(
        join(LIB_DIR, "sources", collection, slug, `r${revision}-${hash8(contentHash)}${ext}`),
      )
      mkdirSync(sourceDir(root, collection, slug), { recursive: true })
      writeFileSync(join(root, fileRel), content, "utf8")
      const sections = deriveSections(title, normalized, explicitSections)
      db.prepare(
        `UPDATE documents SET title = ?, publication_date = ?, retrieved_at = ?, verified_at = ?,
         content_hash = ?, status = ?, file_path = ?, revision = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(
        title,
        publicationDate,
        retrievedAt,
        docStatus === "verified" ? retrievedAt : null,
        contentHash,
        docStatus,
        fileRel,
        revision,
        notes,
        now,
        docId,
      )
      db.prepare(INSERT_REVISION_SQL).run(docId, revision, contentHash, retrievedAt, fileRel)
      const sectionCount = insertSections(db, docId, sections)
      const history = db
        .prepare("SELECT revision, content_hash, retrieved_at, file FROM document_revisions WHERE document_id = ? ORDER BY revision")
        .all(docId) as { revision: number; content_hash: string; retrieved_at: number; file: string | null }[]
      writeManifest(root, {
        schema: SCHEMA_VERSION,
        collection,
        slug,
        title,
        sourceUrl,
        publicationDate,
        version,
        status: docStatus,
        notes,
        verifiedAt: docStatus === "verified" ? retrievedAt : null,
        sections: sections.map((s) => ({ anchor: s.anchor, heading: s.heading, body: normalizeText(s.body) })),
        revisions: history.map((r) => ({
          revision: r.revision,
          contentHash: r.content_hash,
          retrievedAt: r.retrieved_at,
          file: r.file ?? "",
        })),
      })
      result = { docId, outcome: "updated", revision, contentHash, sectionCount, sourcePath: fileRel }
    }

    // new row for an existing source_url supersedes its other versions
    if (result.outcome === "created") {
      supersedeSiblings(db, root, collection, sourceUrl, docId, now)
    }

    db.exec("COMMIT")
    return result
  } catch (err) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // transaction already rolled back / never opened
    }
    throw err
  } finally {
    db.close()
  }
}

function rewriteManifestStatus(
  root: string,
  docId: string,
  status: "verified" | "superseded",
  verifiedAt: number | null,
): void {
  try {
    const [collection, slug] = docId.split("/")
    const p = manifestPath(root, collection, slug)
    if (!isFile(p)) return
    const manifest = readManifest(p)
    manifest.status = status
    if (status === "verified" && verifiedAt !== null) manifest.verifiedAt = verifiedAt
    writeManifest(root, manifest)
  } catch {
    // best effort — the DB row is already correct; a broken manifest is
    // reported on the next reindex instead of failing this ingest
  }
}

function supersedeSiblings(
  db: DatabaseSync,
  root: string,
  collection: CollectionId,
  sourceUrl: string,
  keepDocId: string,
  now: number,
): void {
  const siblings = db
    .prepare("SELECT id FROM documents WHERE collection = ? AND source_url = ? AND id <> ?")
    .all(collection, sourceUrl, keepDocId) as { id: string }[]
  if (siblings.length === 0) return
  const update = db.prepare("UPDATE documents SET status = 'superseded', updated_at = ? WHERE id = ?")
  for (const s of siblings) {
    update.run(now, s.id)
    rewriteManifestStatus(root, s.id, "superseded", null)
  }
}

// ---------------------------------------------------------------------------
// reads — documents + collections

interface DocRow {
  id: string
  collection: string
  title: string
  source_url: string
  publication_date: string | null
  retrieved_at: number
  verified_at: number | null
  version: string
  content_hash: string
  status: string
  revision: number
  file_path: string | null
  notes: string
}

function toDocumentRecord(
  row: DocRow,
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
): DocumentRecord {
  const collection = row.collection as CollectionId
  const fresh = freshness(row.retrieved_at, row.verified_at, meta[collection]?.ttlDays ?? 365, now)
  return {
    docId: row.id,
    collection,
    title: row.title,
    sourceUrl: row.source_url,
    publicationDate: row.publication_date,
    retrievedAt: row.retrieved_at,
    verifiedAt: row.verified_at,
    version: row.version,
    status: row.status as DocStatus,
    revision: row.revision,
    contentHash: row.content_hash,
    filePath: row.file_path,
    notes: row.notes,
    ageDays: fresh.ageDays,
    stale: fresh.stale,
  }
}

// Always qualified with the `d` alias for documents — unqualified title/
// notes/source_url are ambiguous once documents_fts (same column names) is
// joined into the query.
const DOC_COLUMNS = `d.id, d.collection, d.title, d.source_url, d.publication_date, d.retrieved_at,
  d.verified_at, d.version, d.content_hash, d.status, d.revision, d.file_path, d.notes`

export function listCollections(root: string): CollectionSummary[] {
  const meta = collectionMeta(root)
  const now = Date.now()
  const db = openDb(root, "read")
  try {
    return COLLECTIONS.map((id): CollectionSummary => {
      const summary: CollectionSummary = {
        id,
        name: meta[id].name,
        description: meta[id].description,
        documents: 0,
        sections: 0,
        stale: 0,
        lastUpdatedAt: null,
      }
      if (!db) return summary
      summary.documents = (
        db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection = ?").get(id) as { n: number }
      ).n
      summary.sections = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sections s JOIN documents d ON d.id = s.document_id WHERE d.collection = ?",
          )
          .get(id) as { n: number }
      ).n
      summary.lastUpdatedAt = (
        db.prepare("SELECT MAX(updated_at) AS m FROM documents WHERE collection = ?").get(id) as { m: number | null }
      ).m
      const rows = db
        .prepare("SELECT retrieved_at, verified_at FROM documents WHERE collection = ?")
        .all(id) as { retrieved_at: number; verified_at: number | null }[]
      summary.stale = rows.filter((r) => freshness(r.retrieved_at, r.verified_at, meta[id].ttlDays, now).stale).length
      return summary
    })
  } finally {
    if (db) db.close()
  }
}

export function listDocuments(root: string, collection: CollectionId): DocumentRecord[] {
  assertCollection(collection)
  const meta = collectionMeta(root)
  const now = Date.now()
  const db = openDb(root, "read")
  if (!db) return []
  try {
    const rows = db
      .prepare(`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.collection = ? ORDER BY d.id`)
      .all(collection) as unknown as DocRow[]
    return rows.map((row) => toDocumentRecord(row, meta, now))
  } finally {
    db.close()
  }
}

export function getDocument(
  root: string,
  docId: string,
  opts?: { sections?: boolean; section?: string; maxChars?: number },
): DocumentRecord | null {
  if (!DOC_ID_RE.test(docId)) {
    throw new Error(`invalid docId ${JSON.stringify(docId)} — expected "<collection>/<slug>" (lowercase/dashes)`)
  }
  const meta = collectionMeta(root)
  const now = Date.now()
  const db = openDb(root, "read")
  if (!db) return null
  try {
    const row = db.prepare(`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ?`).get(docId) as DocRow | undefined
    if (row === undefined) return null
    const record = toDocumentRecord(row, meta, now)
    const wantAll = opts?.sections === true
    const filter = typeof opts?.section === "string" ? opts.section.toLowerCase() : null
    if (wantAll || filter !== null) {
      const maxChars = clampMaxChars(opts?.maxChars)
      let rows = db
        .prepare("SELECT id, anchor, heading, ordinal, body, content_hash FROM sections WHERE document_id = ? ORDER BY ordinal")
        .all(docId) as { id: string; anchor: string; heading: string; ordinal: number; body: string; content_hash: string }[]
      if (filter !== null) {
        rows = rows.filter((s) => s.anchor.toLowerCase().includes(filter))
      }
      record.sections = rows.map((s) => ({
        id: s.id,
        anchor: s.anchor,
        heading: s.heading,
        ordinal: s.ordinal,
        contentHash: s.content_hash,
        body: applyMaxChars(s.body, maxChars),
      }))
    }
    return record
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// reads — search

function likeEscape(text: string): string {
  return text.replace(/([\\%_])/g, "\\$1")
}

/**
 * Build an FTS5 MATCH expression from raw user input: each whitespace token
 * is double-quoted (internal quotes doubled) so quotes/dashes/punctuation
 * degrade to literal phrases, a trailing `*` becomes a prefix search. Tokens
 * without any letter/number are dropped (they can never match a token).
 */
function ftsExpression(query: string): string {
  const tokens = query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t))
  if (tokens.length === 0) throw new Error("query contains no searchable terms")
  return tokens
    .map((token) => {
      const prefix = token.length > 1 && token.endsWith("*")
      const core = prefix ? token.slice(0, -1) : token
      return `"${core.replace(/"/g, '""')}"${prefix ? "*" : ""}`
    })
    .join(" AND ")
}

function snippetOf(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  if (text.length <= SNIPPET_CHARS) return text
  return `${text.slice(0, SNIPPET_CHARS - 1)}…`
}

function hitFromDocRow(
  row: DocRow & { score: number },
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
): SearchHit {
  const record = toDocumentRecord(row, meta, now)
  return {
    docId: record.docId,
    collection: record.collection,
    title: record.title,
    sourceUrl: record.sourceUrl,
    version: record.version,
    status: record.status,
    publicationDate: record.publicationDate,
    retrievedAt: record.retrievedAt,
    verifiedAt: record.verifiedAt,
    ageDays: record.ageDays,
    stale: record.stale,
    score: row.score,
    section: null,
  }
}

function ftsDocumentHits(
  db: DatabaseSync,
  match: string,
  collection: CollectionId | undefined,
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
  limit: number,
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT ${DOC_COLUMNS}, bm25(documents_fts) AS rank_score
       FROM documents_fts
       JOIN documents d ON d.rowid = documents_fts.rowid
       WHERE documents_fts MATCH ? ${collection !== undefined ? "AND d.collection = ?" : ""}
       ORDER BY rank_score
       LIMIT ?`,
    )
    .all(...(collection !== undefined ? [match, collection] : [match]), limit) as unknown as (DocRow & {
    rank_score: number
  })[]
  return rows.map((row) => hitFromDocRow({ ...row, score: -row.rank_score }, meta, now))
}

function ftsSectionHits(
  db: DatabaseSync,
  match: string,
  collection: CollectionId | undefined,
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
  limit: number,
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT ${DOC_COLUMNS},
              s.id AS section_id, s.anchor AS section_anchor, s.heading AS section_heading,
              snippet(sections_fts, 1, '', '', '…', 24) AS snip,
              bm25(sections_fts) AS rank_score
       FROM sections_fts
       JOIN sections s ON s.rowid = sections_fts.rowid
       JOIN documents d ON d.id = s.document_id
       WHERE sections_fts MATCH ? ${collection !== undefined ? "AND d.collection = ?" : ""}
       ORDER BY rank_score
       LIMIT ?`,
    )
    .all(...(collection !== undefined ? [match, collection] : [match]), limit) as unknown as (DocRow & {
    section_id: string
    section_anchor: string
    section_heading: string
    snip: string | null
    rank_score: number
  })[]
  return rows.map((row) => {
    const hit = hitFromDocRow({ ...row, score: -row.rank_score }, meta, now)
    hit.section = {
      id: row.section_id,
      anchor: row.section_anchor,
      heading: row.section_heading,
      snippet: snippetOf(row.snip),
    }
    return hit
  })
}

function likeDocumentHits(
  db: DatabaseSync,
  query: string,
  collection: CollectionId | undefined,
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
  limit: number,
): SearchHit[] {
  const pat = `%${likeEscape(query)}%`
  const rows = db
    .prepare(
      `SELECT ${DOC_COLUMNS} FROM documents d
       WHERE ${collection !== undefined ? "d.collection = ? AND " : ""}(d.title LIKE ? ESCAPE '\\' OR d.notes LIKE ? ESCAPE '\\' OR d.source_url LIKE ? ESCAPE '\\')
       ORDER BY d.id LIMIT ?`,
    )
    .all(...(collection !== undefined ? [collection] : []), pat, pat, pat, limit) as unknown as DocRow[]
  return rows.map((row) => hitFromDocRow({ ...row, score: 1 }, meta, now))
}

function likeSectionHits(
  db: DatabaseSync,
  query: string,
  collection: CollectionId | undefined,
  meta: Record<CollectionId, CollectionMeta>,
  now: number,
  limit: number,
): SearchHit[] {
  const pat = `%${likeEscape(query)}%`
  const rows = db
    .prepare(
      `SELECT ${DOC_COLUMNS}, s.id AS section_id, s.anchor AS section_anchor, s.heading AS section_heading, s.body AS body
       FROM sections s JOIN documents d ON d.id = s.document_id
       WHERE ${collection !== undefined ? "d.collection = ? AND " : ""}(s.heading LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\')
       ORDER BY s.id LIMIT ?`,
    )
    .all(...(collection !== undefined ? [collection] : []), pat, pat, limit) as unknown as (DocRow & {
    section_id: string
    section_anchor: string
    section_heading: string
    body: string
  })[]
  const needle = query.toLowerCase()
  return rows.map((row) => {
    const hit = hitFromDocRow({ ...row, score: 1 }, meta, now)
    const idx = row.body.toLowerCase().indexOf(needle)
    const start = idx > 120 ? idx - 120 : 0
    hit.section = {
      id: row.section_id,
      anchor: row.section_anchor,
      heading: row.section_heading,
      snippet: snippetOf(`${start > 0 ? "…" : ""}${row.body.slice(start, start + SNIPPET_CHARS)}${start + SNIPPET_CHARS < row.body.length ? "…" : ""}`),
    }
    return hit
  })
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1
  const sa = a.section?.id ?? ""
  const sb = b.section?.id ?? ""
  if (sa !== sb) return sa < sb ? -1 : 1
  return 0
}

export function search(root: string, query: string, opts?: SearchOpts): { hits: SearchHit[]; tookMs: number } {
  const t0 = performance.now()
  const scope = opts?.scope ?? "all"
  if (scope !== "all" && scope !== "documents" && scope !== "sections") {
    throw new Error(`invalid scope ${JSON.stringify(scope)} — expected "all", "documents" or "sections"`)
  }
  if (opts?.collection !== undefined) assertCollection(opts.collection)
  const limit = clampLimit(opts?.limit)
  const trimmed = typeof query === "string" ? query.trim() : ""
  if (trimmed.length === 0) return { hits: [], tookMs: tookMsSince(t0) }

  const meta = collectionMeta(root)
  const db = openDb(root, "read")
  if (!db) return { hits: [], tookMs: tookMsSince(t0) }
  try {
    let hits: SearchHit[] = []
    const now = Date.now()
    try {
      const match = ftsExpression(trimmed)
      if (scope !== "sections") hits.push(...ftsDocumentHits(db, match, opts?.collection, meta, now, limit))
      if (scope !== "documents") hits.push(...ftsSectionHits(db, match, opts?.collection, meta, now, limit))
    } catch {
      // hostile/unsupported FTS input → degrade to LIKE, never crash
      hits = []
      if (scope !== "sections") hits.push(...likeDocumentHits(db, trimmed, opts?.collection, meta, now, limit))
      if (scope !== "documents") hits.push(...likeSectionHits(db, trimmed, opts?.collection, meta, now, limit))
    }
    hits.sort(compareHits)
    return { hits: hits.slice(0, limit), tookMs: tookMsSince(t0) }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// reindex

function walkManifests(dir: string): string[] {
  if (!isDir(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkManifests(p))
    else if (entry.isFile() && entry.name === "manifest.json") out.push(p)
  }
  return out
}

/**
 * Delete the derived DB (+ WAL/SHM), recreate the schema and replay every
 * sources/**\/manifest.json in deterministic sorted order. A corrupt or
 * invalid manifest is skipped in isolation (SAVEPOINT per manifest) — the
 * rest still restores. Manifests are the unit of record: supersede flips and
 * verification bumps are persisted into manifests at ingest time, so replay
 * is order-free and parser-free.
 */
export function reindex(root: string): ReindexResult {
  const t0 = performance.now()
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath(root) + suffix, { force: true })
  }
  const db = openDb(root, "write")
  if (!db) throw new Error("research library database could not be recreated")
  const manifests = walkManifests(join(root, LIB_DIR, "sources")).sort()
  const skipped: { manifest: string; error: string }[] = []
  let documents = 0
  let sections = 0
  try {
    db.exec("BEGIN IMMEDIATE")
    for (const path of manifests) {
      const rel = toPosix(relative(root, path))
      db.exec("SAVEPOINT manifest")
      try {
        sections += restoreManifest(db, path)
        documents += 1
        db.exec("RELEASE manifest")
      } catch (err) {
        db.exec("ROLLBACK TO manifest")
        db.exec("RELEASE manifest")
        skipped.push({ manifest: rel, error: err instanceof Error ? err.message : String(err) })
      }
    }
    db.prepare(
      "INSERT INTO library_meta (key, value) VALUES ('lastReindexAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(Date.now()))
    db.exec("COMMIT")
  } catch (err) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // transaction already rolled back / never opened
    }
    throw err
  } finally {
    db.close()
  }
  return { documents, sections, skipped, tookMs: tookMsSince(t0) }
}

function restoreManifest(db: DatabaseSync, path: string): number {
  const manifest = readManifest(path)
  const docId = `${manifest.collection}/${manifest.slug}`
  const now = Date.now()
  const latest = latestRevision(manifest.revisions)

  const clash = db
    .prepare("SELECT source_url, version FROM documents WHERE id = ?")
    .get(docId) as { source_url: string; version: string } | undefined
  if (clash !== undefined) {
    throw new Error(
      `document id collision with ${clash.source_url} (version=${clash.version}) — duplicate slug across manifests`,
    )
  }

  db.prepare(INSERT_DOC_SQL).run(
    docId,
    manifest.collection,
    manifest.title,
    manifest.sourceUrl,
    manifest.publicationDate,
    latest.retrievedAt,
    manifest.status === "verified" ? (manifest.verifiedAt ?? latest.retrievedAt) : null,
    manifest.version,
    latest.contentHash,
    manifest.status,
    latest.file,
    latest.revision,
    manifest.notes,
    now,
    now,
  )
  const insertRevision = db.prepare(INSERT_REVISION_SQL)
  for (const r of manifest.revisions) {
    insertRevision.run(docId, r.revision, r.contentHash, r.retrievedAt, r.file)
  }
  return insertSections(
    db,
    docId,
    manifest.sections.map((s) => ({ anchor: s.anchor, heading: s.heading, body: s.body })),
  )
}

// ---------------------------------------------------------------------------
// status

function metaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM library_meta WHERE key = ?").get(key) as
    | { value?: unknown }
    | undefined
  return typeof row?.value === "string" ? row.value : null
}

export function status(root: string): LibraryStatus {
  const meta = collectionMeta(root)
  const now = Date.now()
  const p = dbPath(root)
  const exists = isFile(p)
  const db = openDb(root, "read")
  try {
    const collections = COLLECTIONS.map((id): CollectionSummary => {
      const summary: CollectionSummary = {
        id,
        name: meta[id].name,
        description: meta[id].description,
        documents: 0,
        sections: 0,
        stale: 0,
        lastUpdatedAt: null,
      }
      if (!db) return summary
      summary.documents = (
        db.prepare("SELECT COUNT(*) AS n FROM documents d WHERE d.collection = ?").get(id) as { n: number }
      ).n
      summary.sections = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sections s JOIN documents d ON d.id = s.document_id WHERE d.collection = ?",
          )
          .get(id) as { n: number }
      ).n
      summary.lastUpdatedAt = (
        db.prepare("SELECT MAX(updated_at) AS m FROM documents d WHERE d.collection = ?").get(id) as { m: number | null }
      ).m
      const rows = db
        .prepare("SELECT retrieved_at, verified_at FROM documents d WHERE d.collection = ?")
        .all(id) as { retrieved_at: number; verified_at: number | null }[]
      summary.stale = rows.filter((r) => freshness(r.retrieved_at, r.verified_at, meta[id].ttlDays, now).stale).length
      return summary
    })
    let lastReindexAt: number | null = null
    if (db) {
      const raw = metaValue(db, "lastReindexAt")
      if (raw !== null && /^\d+$/.test(raw)) lastReindexAt = Number(raw)
    }
    return {
      root,
      dbExists: exists,
      dbSizeBytes: exists ? statSync(p).size : null,
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      collections,
      staleCount: collections.reduce((sum, c) => sum + c.stale, 0),
      lastReindexAt,
    }
  } finally {
    if (db) db.close()
  }
}
