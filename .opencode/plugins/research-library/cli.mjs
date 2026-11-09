#!/usr/bin/env node
// Research library CLI — THIN wrapper over src/lib/research/engine.ts.
// Zero logic beyond arg parsing: every command maps 1:1 onto an engine call.
// The engine is imported with an explicit .ts extension and runs under plain
// Node type-stripping (v24) — the same engine file is later imported by the
// opencode plugin under Bun (T2), so it stays dependency-free.
//
//   node .opencode/plugins/research-library/cli.mjs <cmd> [args]
//     status   [--json]
//     list     [--collection <slug>]          [--json]
//     search   "<query>" [--collection <slug>] [--limit 1-50]
//              [--scope all|documents|sections] [--json]
//     get      "<docId>" [--section "<anchor substring>"] [--max-chars N] [--json]
//     import   (--manifest <path.json> | --stdin) [--json]   # IngestDocInput JSON
//     refresh  [--reindex] [--json]      # --reindex: full manifest replay;
//                                        # default: status-style verify
// Root resolution: --root <path> > RESEARCH_LIBRARY_ROOT > walk-up from this
// file / cwd to a directory containing research-library/.
//
// Exit codes: 0 ok · 2 usage/validation · 3 not found · 4 I/O error.
// With --json, stdout carries machine JSON ONLY (errors included); human
// logs go to stderr.

import { readFileSync } from "node:fs"

import {
  getDocument,
  ingest,
  listCollections,
  listDocuments,
  reindex,
  resolveLibraryRoot,
  search,
  status,
} from "../../../src/lib/research/engine.ts"

const USAGE = `usage: node .opencode/plugins/research-library/cli.mjs <cmd> [args]

commands:
  status                                  [--json]
  list     [--collection <slug>]          [--json]
  search   "<query>" [--collection <slug>] [--limit 1-50] [--scope all|documents|sections] [--json]
  get      "<docId>" [--section "<anchor substring>"] [--max-chars N] [--json]
  import   (--manifest <path.json> | --stdin) [--json]
  refresh  [--reindex] [--json]

common: --root <path> overrides RESEARCH_LIBRARY_ROOT / walk-up resolution
exit codes: 0 ok · 2 usage/validation · 3 not found · 4 I/O error`

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--collection", "--limit", "--scope", "--section", "--max-chars", "--manifest", "--root"])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    if (!VALUE_FLAGS.has(arg)) {
      if (arg === "--json" || arg === "--stdin" || arg === "--reindex") {
        flags[arg] = true
        continue
      }
      throw new UsageError(`unknown flag: ${arg}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`flag ${arg} requires a value`)
    }
    flags[arg] = value
    i++
  }
  return { positional, flags }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function fail(message, code) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(code)
}

function exitCodeFor(err) {
  const code = err && typeof err.code === "string" ? err.code : ""
  if (["ENOENT", "EACCES", "EPERM", "EISDIR", "EMFILE", "ENOSPC"].includes(code)) return 4
  return 2
}

function resolveRootOrThrow(flags) {
  const explicit = flags["--root"] !== undefined ? flags["--root"] : process.env.RESEARCH_LIBRARY_ROOT ?? null
  try {
    return resolveLibraryRoot(explicit)
  } catch (err) {
    err.rootResolution = true
    throw err
  }
}

function intFlag(flags, name) {
  const raw = flags[name]
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) throw new UsageError(`--${name.replace("--", "")} must be an integer (got ${JSON.stringify(raw)})`)
  return n
}

function humanStatus(root, s) {
  process.stdout.write(`research library: ${root}\n`)
  process.stdout.write(
    s.dbExists
      ? `database: present (${s.dbSizeBytes} bytes)\n`
      : "database: absent (reads return empty; ingest or refresh --reindex creates it)\n",
  )
  for (const c of s.collections) {
    process.stdout.write(
      `  ${c.id.padEnd(16)} ${String(c.documents).padStart(3)} docs ${String(c.sections).padStart(4)} sections ${String(c.stale).padStart(3)} stale\n`,
    )
  }
  process.stdout.write(
    `stale total: ${s.staleCount} · last reindex: ${s.lastReindexAt ? new Date(s.lastReindexAt).toISOString() : "never"} · engine ${s.engineVersion} (schema ${s.schemaVersion})\n`,
  )
}

function humanCollections(collections) {
  for (const c of collections) {
    process.stdout.write(`${c.id} — ${c.name}: ${c.documents} docs, ${c.sections} sections, ${c.stale} stale\n`)
  }
}

function humanDocuments(docs) {
  for (const d of docs) {
    const flag = d.stale ? " [STALE]" : ""
    process.stdout.write(`${d.docId}  [${d.status} v${d.revision}] ${d.title} (${d.ageDays}d old)${flag}\n`)
  }
}

function humanHits(result) {
  process.stdout.write(`${result.hits.length} hit(s) in ${result.tookMs}ms\n`)
  for (const h of result.hits) {
    const where = h.section ? ` · § ${h.section.anchor} — ${h.section.heading}` : ""
    process.stdout.write(`${h.score.toFixed(3)}  ${h.docId}${where}\n  ${h.title}\n`)
    if (h.section) process.stdout.write(`  ${h.section.snippet.replace(/\n/g, " ")}\n`)
  }
}

function humanDocument(doc) {
  process.stdout.write(`${doc.docId}\n${doc.title}\n`)
  process.stdout.write(
    `status ${doc.status} · rev ${doc.revision} · version ${doc.version} · ${doc.ageDays}d old${doc.stale ? " [STALE]" : ""}\n`,
  )
  process.stdout.write(`source ${doc.sourceUrl}\nfile ${doc.filePath ?? "-"}\n`)
  if (doc.notes) process.stdout.write(`notes: ${doc.notes}\n`)
  if (doc.sections) {
    for (const s of doc.sections) {
      process.stdout.write(`\n— ${s.anchor} · ${s.heading}\n${s.body ?? "(body not requested)"}\n`)
    }
  }
}

function cmdStatus({ flags }) {
  const root = resolveRootOrThrow(flags)
  const s = status(root)
  if (flags["--json"]) emitJson(s)
  else humanStatus(root, s)
  return 0
}

function cmdList({ flags }) {
  const root = resolveRootOrThrow(flags)
  const collection = flags["--collection"]
  if (collection !== undefined) {
    const docs = listDocuments(root, collection)
    if (flags["--json"]) emitJson(docs)
    else humanDocuments(docs)
    return 0
  }
  const collections = listCollections(root)
  if (flags["--json"]) emitJson(collections)
  else humanCollections(collections)
  return 0
}

function cmdSearch({ positional, flags }) {
  const query = positional[0]
  if (query === undefined) throw new UsageError('search requires a query: search "<query>" [flags]')
  if (positional.length > 1) throw new UsageError("search takes a single quoted query — quote it")
  const scope = flags["--scope"] ?? "all"
  if (!["all", "documents", "sections"].includes(scope)) {
    throw new UsageError(`--scope must be all|documents|sections (got ${JSON.stringify(scope)})`)
  }
  const root = resolveRootOrThrow(flags)
  const result = search(root, query, {
    collection: flags["--collection"],
    limit: intFlag(flags, "--limit"),
    scope,
  })
  if (flags["--json"]) emitJson(result)
  else humanHits(result)
  return 0
}

function cmdGet({ positional, flags }) {
  const docId = positional[0]
  if (docId === undefined) throw new UsageError('get requires a docId: get "<collection>/<slug>" [flags]')
  if (positional.length > 1) throw new UsageError("get takes a single docId")
  const root = resolveRootOrThrow(flags)
  const doc = getDocument(root, docId, {
    sections: flags["--section"] === undefined,
    section: flags["--section"],
    maxChars: intFlag(flags, "--max-chars"),
  })
  if (doc === null) {
    if (flags["--json"]) emitJson({ error: "document not found", docId })
    else process.stderr.write(`not found: ${docId}\n`)
    return 3
  }
  if (flags["--section"] !== undefined && doc.sections !== undefined && doc.sections.length === 0) {
    if (flags["--json"]) emitJson({ error: "section not found", docId, section: flags["--section"] })
    else process.stderr.write(`section not found: no anchor matching ${JSON.stringify(flags["--section"])} in ${docId}\n`)
    return 3
  }
  if (flags["--json"]) emitJson(doc)
  else humanDocument(doc)
  return 0
}

function readImportInput(flags) {
  const manifest = flags["--manifest"]
  const stdin = flags["--stdin"] === true
  if (manifest !== undefined && stdin) throw new UsageError("--manifest and --stdin are mutually exclusive")
  if (manifest === undefined && !stdin) throw new UsageError("import needs --manifest <path.json> or --stdin")
  let text
  if (stdin) {
    text = readFileSync(0, "utf8")
  } else {
    try {
      text = readFileSync(manifest, "utf8")
    } catch (err) {
      err.cliExit = 4
      throw err
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new UsageError(`manifest is not valid JSON: ${err.message}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("manifest JSON must be a single object (IngestDocInput)")
  }
  for (const field of ["collection", "slug", "title", "sourceUrl", "content"]) {
    if (typeof parsed[field] !== "string") {
      throw new UsageError(`manifest field "${field}" must be a string`)
    }
  }
  return parsed
}

function cmdImport({ flags }) {
  const root = resolveRootOrThrow(flags)
  const input = readImportInput(flags)
  const result = ingest(root, input)
  if (flags["--json"]) emitJson(result)
  else {
    process.stdout.write(
      `${result.outcome}: ${result.docId} (rev ${result.revision}, ${result.contentHash.slice(0, 8)}, ${result.sectionCount} sections)\n  ${result.sourcePath}\n`,
    )
  }
  return 0
}

function cmdRefresh({ flags }) {
  const root = resolveRootOrThrow(flags)
  if (flags["--reindex"] === true) {
    const result = reindex(root)
    if (flags["--json"]) emitJson(result)
    else {
      process.stdout.write(
        `reindexed ${result.documents} document(s), ${result.sections} section(s) in ${result.tookMs}ms\n`,
      )
      for (const skip of result.skipped) {
        process.stderr.write(`skipped ${skip.manifest}: ${skip.error}\n`)
      }
    }
    return 0
  }
  // default: status-style verify — open the DB + report, touch nothing
  const s = status(root)
  if (flags["--json"]) emitJson(s)
  else {
    humanStatus(root, s)
    if (!s.dbExists) {
      process.stderr.write("note: no database yet — run refresh --reindex (or ingest) to create it\n")
    }
  }
  return 0
}

const COMMANDS = { status: cmdStatus, list: cmdList, search: cmdSearch, get: cmdGet, import: cmdImport, refresh: cmdRefresh }

function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(`${USAGE}\n`)
    process.exit(argv.length === 0 ? 2 : 0)
  }
  const cmd = argv[0]
  const handler = COMMANDS[cmd]
  if (handler === undefined) {
    process.stderr.write(`${USAGE}\n`)
    fail(`unknown command: ${cmd}`, 2)
  }
  const parsed = parseArgs(argv.slice(1))
  const code = handler(parsed)
  process.exit(code)
}

try {
  main()
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  const code = typeof err?.cliExit === "number" ? err.cliExit : exitCodeFor(err)
  if (process.argv.includes("--json")) emitJson({ error: message })
  else fail(message, code)
  process.exit(code)
}
