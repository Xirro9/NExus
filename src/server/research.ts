// Research library read surface — Node-only Vite dev middleware. Browser-mode
// mirror of src-tauri/src/research.rs (production Tauri path). The validation
// boundary below MUST stay in sync with research.rs validate_root()/validate_*()
// and the engine's own checks in src/lib/research/engine.ts — same three-way
// mirror discipline as the graphify whitelist (see src/server/graphify.ts).
//
// READ-ONLY BY DESIGN: no import/ingest route exists here — the browser can
// never write library sources or manifests. The single POST is /reindex, which
// only rebuilds the DERIVED index from the manifests that are the unit of
// record (engine.reindex). Everything else is a read.
//
// Unlike graphify.ts this middleware calls the engine IN-PROCESS (the engine
// is node:-builtins-only TypeScript and the dev server already runs in Node),
// so there is no CLI spawn or binary resolution on this leg. The desktop shell
// (research.rs) instead spawns the CLI — same engine, one process further out.
//
// Root resolution without an explicit ?root= rides engine.resolveLibraryRoot(
// null) AT REQUEST TIME: under the Vite config bundle import.meta.url is
// rewritten, so the cwd walk is the leg that anchors (cwd of `npm run dev` =
// repo root, which contains research-library/).

import { statSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "vite"

import {
  type CollectionId,
  COLLECTIONS,
  getDocument,
  listCollections,
  reindex,
  resolveLibraryRoot,
  search,
  status,
} from "../lib/research/engine"

// ---------------------------------------------------------------------------
// validation — THE boundary (mirror of research.rs validate_root/validate_*)

const SCOPES = ["all", "documents", "sections"] as const

/**
 * Stricter than the engine's DOC_ID_RE (which allows leading-dash segments):
 * engine SLUG_RE never produces a leading dash, so accepting one here would
 * only ever match nothing — while on the desktop leg a leading-dash token can
 * be mis-read as a CLI flag. Mirror of research.rs validate_doc_id().
 */
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/

function rootViolation(raw: string): string | null {
  if (raw.length === 0) return "root is empty"
  if (raw.includes("\0")) return "root contains a NUL byte"
  if (!raw.startsWith("/")) {
    return `root must be absolute: ${JSON.stringify(raw)}`
  }
  for (const seg of raw.split("/")) {
    if (seg === "." || seg === "..") {
      return `root must not contain ${JSON.stringify(seg)} segments: ${JSON.stringify(raw)}`
    }
  }
  return null
}

function libraryMissing(root: string): string | null {
  try {
    if (statSync(join(root, "research-library")).isDirectory()) return null
  } catch {
    // fall through to the error below
  }
  return `no research-library directory under ${root} — pick the checkout/folder that contains it`
}

interface ResolvedRoot {
  root: string
}

/**
 * Root pipeline shared by every route: raw checks → engine resolve() for a
 * canonical path → research-library presence. `null` resolves via the engine's
 * own chain (env, then walk-ups) at request time. Returns the resolved root or
 * the error message (devfs `T | string` idiom — a string result IS the error).
 */
function resolveRoot(raw: string | null): ResolvedRoot | string {
  if (raw !== null) {
    const violation = rootViolation(raw)
    if (violation) return violation
  }
  let root: string
  try {
    root = resolveLibraryRoot(raw)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  const missing = libraryMissing(root)
  if (missing) return missing
  return { root }
}

function qViolation(q: string): string | null {
  if (q.length === 0) return "q must not be empty"
  if (q.includes("\0")) return "q contains a NUL byte"
  if (q.length > 512) return `q exceeds 512 characters (got ${q.length})`
  // positional-injection guard: the CLI takes <q> as a positional, a leading
  // dash would be mis-parsed as a flag (mirror of research.rs validate_q)
  if (q.startsWith("-")) return "q must not start with a dash"
  return null
}

function collectionViolation(raw: string): string | null {
  if (!(COLLECTIONS as readonly string[]).includes(raw)) {
    return `invalid collection ${JSON.stringify(raw)} — expected one of: ${COLLECTIONS.join(", ")}`
  }
  return null
}

function scopeViolation(raw: string): string | null {
  if (!(SCOPES as readonly string[]).includes(raw)) {
    return `invalid scope ${JSON.stringify(raw)} — expected one of: ${SCOPES.join(", ")}`
  }
  return null
}

function docIdViolation(id: string): string | null {
  if (!DOC_ID_RE.test(id)) {
    return `invalid id ${JSON.stringify(id)} — expected "<collection>/<slug>" (lowercase letters, digits and dashes; no leading dash)`
  }
  return null
}

function sectionViolation(raw: string): string | null {
  if (raw.includes("\0")) return "section contains a NUL byte"
  if (raw.length > 120) return `section exceeds 120 characters (got ${raw.length})`
  return null
}

/** Integer-only parse + range check. `Number()` alone would let "3.5"/"1e2"
 *  through — mirror of research.rs u32 command params. */
function intParamViolation(raw: string, min: number, max: number, label: string): string | null {
  if (!/^-?\d+$/.test(raw)) return `${label} must be an integer`
  const n = Number(raw)
  if (n < min || n > max) return `${label} must be an integer between ${min} and ${max}`
  return null
}

// ---------------------------------------------------------------------------
// param plumbing

/** Absent OR empty → undefined (UIs may send empty strings for unset
 *  optional fields); required params fail loudly on their own checks. */
function optionalParam(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name)
  return v !== null && v.length > 0 ? v : undefined
}

function sendJson(res: import("node:http").ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function sendBadRequest(res: import("node:http").ServerResponse, error: string): void {
  res.statusCode = 400
  sendJson(res, { error })
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8")
      if (data.length > 8192) {
        reject(new Error("body too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

/** Engine reads "never throw for a missing/corrupt DB" but CAN throw (schema
 *  newer than the engine, reindex IO) — surface those as honest 500s. */
function respondEngine<T>(res: import("node:http").ServerResponse, fn: () => T): void {
  try {
    sendJson(res, fn())
  } catch (err) {
    res.statusCode = 500
    sendJson(res, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// plugin (same middleware shape as devFsPlugin / graphifyPlugin)

export function researchPlugin(): Plugin {
  return {
    name: "nexus-research",
    apply: "serve", // dev middleware only — the Tauri build uses research.rs
    configureServer(server) {
      server.middlewares.use("/research", (req, res) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/\/+$/, "") || "/"
        const params = new URL(`http://x${req.url}`).searchParams

        if (path === "/status" && req.method === "GET") {
          const resolved = resolveRoot(optionalParam(params, "root") ?? null)
          if (typeof resolved === "string") {
            sendBadRequest(res, resolved)
            return
          }
          // the payload's root is how the UI seeds its stored library path
          respondEngine(res, () => status(resolved.root))
          return
        }

        if (path === "/collections" && req.method === "GET") {
          const raw = optionalParam(params, "root")
          if (raw === undefined) {
            sendBadRequest(res, "root is required — call /research/status first to seed the library path")
            return
          }
          const resolved = resolveRoot(raw)
          if (typeof resolved === "string") {
            sendBadRequest(res, resolved)
            return
          }
          respondEngine(res, () => listCollections(resolved.root))
          return
        }

        if (path === "/search" && req.method === "GET") {
          const raw = optionalParam(params, "root")
          if (raw === undefined) {
            sendBadRequest(res, "root is required — call /research/status first to seed the library path")
            return
          }
          const resolved = resolveRoot(raw)
          if (typeof resolved === "string") {
            sendBadRequest(res, resolved)
            return
          }
          const q = params.get("q") ?? ""
          const qBad = qViolation(q)
          if (qBad) {
            sendBadRequest(res, qBad)
            return
          }
          const collection = optionalParam(params, "collection")
          if (collection !== undefined) {
            const bad = collectionViolation(collection)
            if (bad) {
              sendBadRequest(res, bad)
              return
            }
          }
          const scope = optionalParam(params, "scope")
          if (scope !== undefined) {
            const bad = scopeViolation(scope)
            if (bad) {
              sendBadRequest(res, bad)
              return
            }
          }
          const limitRaw = optionalParam(params, "limit")
          let limit: number | undefined
          if (limitRaw !== undefined) {
            const bad = intParamViolation(limitRaw, 1, 50, "limit")
            if (bad) {
              sendBadRequest(res, bad)
              return
            }
            limit = Number(limitRaw)
          }
          respondEngine(res, () => {
            const result = search(resolved.root, q, {
              ...(collection !== undefined ? { collection: collection as CollectionId } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(scope !== undefined ? { scope: scope as (typeof SCOPES)[number] } : {}),
            })
            return { q, hits: result.hits, tookMs: result.tookMs }
          })
          return
        }

        if (path === "/doc" && req.method === "GET") {
          const raw = optionalParam(params, "root")
          if (raw === undefined) {
            sendBadRequest(res, "root is required — call /research/status first to seed the library path")
            return
          }
          const resolved = resolveRoot(raw)
          if (typeof resolved === "string") {
            sendBadRequest(res, resolved)
            return
          }
          const id = params.get("id") ?? ""
          const idBad = docIdViolation(id)
          if (idBad) {
            sendBadRequest(res, idBad)
            return
          }
          const section = optionalParam(params, "section")
          if (section !== undefined) {
            const bad = sectionViolation(section)
            if (bad) {
              sendBadRequest(res, bad)
              return
            }
          }
          const maxCharsRaw = optionalParam(params, "maxChars")
          let maxChars: number | undefined
          if (maxCharsRaw !== undefined) {
            const bad = intParamViolation(maxCharsRaw, 500, 50000, "maxChars")
            if (bad) {
              sendBadRequest(res, bad)
              return
            }
            maxChars = Number(maxCharsRaw)
          }
          try {
            // CLI parity: `get` always carries section bodies (maxChars-capped)
            const doc = getDocument(resolved.root, id, {
              sections: true,
              ...(section !== undefined ? { section } : {}),
              ...(maxChars !== undefined ? { maxChars } : {}),
            })
            if (doc === null) {
              res.statusCode = 404
              sendJson(res, { error: `not found: ${id}` })
              return
            }
            if (section !== undefined && doc.sections !== undefined && doc.sections.length === 0) {
              // CLI parity: a section filter that matched nothing is "not found"
              res.statusCode = 404
              sendJson(res, {
                error: `section not found: no anchor matching ${JSON.stringify(section)} in ${id}`,
              })
              return
            }
            sendJson(res, doc)
          } catch (err) {
            res.statusCode = 500
            sendJson(res, { error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (path === "/reindex" && req.method === "POST") {
          void readBody(req)
            .then((body) => JSON.parse(body) as { root?: string })
            .then((parsed) => {
              const resolved = resolveRoot(parsed.root ?? "")
              if (typeof resolved === "string") {
                sendBadRequest(res, resolved)
                return
              }
              // the only write-adjacent operation: rebuilds the derived index
              // from sources/**\/manifest.json — sources themselves untouched
              respondEngine(res, () => reindex(resolved.root))
            })
            .catch(() => {
              sendBadRequest(res, "invalid JSON body")
            })
          return
        }

        res.statusCode = 404
        res.end()
      })
    },
  }
}
