// Graphify CLI bridge — Node-only Vite dev middleware. Browser-mode mirror of
// src-tauri/src/graphify.rs (production Tauri path). The whitelist below MUST
// stay in sync with the Rust validate() and the arg builders in
// src/lib/graphify/index.ts — it is the security boundary: code-only
// extraction, no LLM backends, no arbitrary commands.

import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"

const EXEC_TIMEOUT_MS = 300_000
const DETECT_TIMEOUT_MS = 5_000
const OUTPUT_CAP_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// binary resolution (same candidates as graphify.rs)

function resolveBinary(): string | null {
  const candidates: string[] = []
  const pathVar = process.env.PATH ?? ""
  for (const dir of pathVar.split(":").filter(Boolean)) {
    candidates.push(join(dir, "graphify"))
  }
  const home = homedir()
  candidates.push(join(home, ".local/bin/graphify"))
  candidates.push(join(home, ".cargo/bin/graphify"))
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      // keep scanning
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// argument whitelist — mirror of graphify.rs validate()

function validate(cwd: string, args: string[]): string | null {
  if (!cwd.startsWith("/") || !existsSync(cwd)) {
    return "cwd must be an existing absolute directory"
  }
  if (args.length < 1 || args.length > 8) return "args must contain 1–8 tokens"
  for (const a of args) {
    if (a.length === 0 || a.length > 512 || a.includes("\0")) {
      return `invalid arg token: ${JSON.stringify(a)}`
    }
  }
  const [cmd, ...rest] = args
  // Value-taking flags (--budget 800, --top 2) consume the NEXT token — a
  // plain dash-filter would count their values as positionals and wrongly
  // reject `query "…" --budget 800`. Mirror of the Rust token walk.
  const VALUE_FLAGS = new Set(["--budget", "--depth", "--top"])
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (VALUE_FLAGS.has(t)) {
      i++ // skip the flag's value token
      continue
    }
    if (!t.startsWith("--")) positionals.push(t)
  }
  const flags = rest.filter((t) => t.startsWith("--"))
  const hasDot = rest.includes(".")
  switch (cmd) {
    case "update":
      if (!hasDot) return 'update requires the project path "."'
      for (const f of flags) {
        if (f !== "--force" && f !== "--no-cluster") return `update: flag not allowed: ${f}`
      }
      break
    case "extract":
      if (!hasDot) return 'extract requires the project path "."'
      if (!rest.includes("--code-only")) {
        return "extract requires --code-only (no LLM extraction from Jerry)"
      }
      for (const f of flags) {
        if (f !== "--code-only" && f !== "--no-cluster" && f !== "--no-gitignore") {
          return `extract: flag not allowed: ${f}`
        }
      }
      break
    case "cluster-only":
      if (!hasDot) return 'cluster-only requires the project path "."'
      for (const f of flags) {
        if (f !== "--no-label" && f !== "--no-viz") return `cluster-only: flag not allowed: ${f}`
      }
      break
    case "query": {
      if (positionals.length !== 1) return "query takes exactly one question string"
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]
        if (t === "--dfs") continue
        if (t === "--budget" || t === "--depth") {
          const v = Number(rest[i + 1])
          if (!Number.isInteger(v)) return `query: ${t} needs an integer value`
          if (t === "--budget" && !(v >= 1 && v <= 8000)) return "query: --budget out of range"
          if (t === "--depth" && !(v >= 1 && v <= 6)) return "query: --depth out of range"
          i++
          continue
        }
        if (t.startsWith("--")) return `query: flag not allowed: ${t}`
      }
      break
    }
    case "path":
      if (positionals.length !== 2) return "path takes exactly two symbol names"
      for (const f of flags) {
        if (f !== "--undirected" && f !== "--directed") return `path: flag not allowed: ${f}`
      }
      break
    case "explain":
      if (positionals.length !== 1) return "explain takes exactly one symbol name"
      for (const f of flags) {
        if (f !== "--all") return `explain: flag not allowed: ${f}`
      }
      break
    case "god-nodes": {
      if (positionals.length !== 0) return "god-nodes takes no positional args"
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]
        if (t === "--json") continue
        if (t === "--top") {
          const v = Number(rest[i + 1])
          if (!Number.isInteger(v) || v < 1 || v > 50) return "god-nodes: --top out of range"
          i++
          continue
        }
        if (t.startsWith("--")) return `god-nodes: flag not allowed: ${t}`
      }
      break
    }
    default:
      return `subcommand not allowed: ${String(cmd)}`
  }
  return null
}

// ---------------------------------------------------------------------------
// process plumbing (mirror of graphify.rs run_with_timeout)

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

function runWithTimeout(
  program: string,
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let child
    try {
      child = spawn(program, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let stdout = ""
    let stderr = ""
    let outClosed = false
    let errClosed = false
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString("utf8")
    })
    child.stdout?.on("close", () => {
      outClosed = true
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString("utf8")
    })
    child.stderr?.on("close", () => {
      errClosed = true
    })
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    const finish = (code: number | null) => {
      if (!outClosed || !errClosed) {
        // pipes can flush a tick later — one deferred check is enough here
        setTimeout(() => {
          clearTimeout(watchdog)
          resolve({ code, stdout, stderr, durationMs: Date.now() - start, timedOut })
        }, 30)
        return
      }
      clearTimeout(watchdog)
      resolve({ code, stdout, stderr, durationMs: Date.now() - start, timedOut })
    }
    child.on("error", (err) => {
      clearTimeout(watchdog)
      reject(err)
    })
    child.on("close", (code) => finish(code))
  })
}

// ---------------------------------------------------------------------------
// status (mirror of graphify.rs graphify_status)

interface StatusResult {
  found: boolean
  mtimeMs: number | null
  sizeBytes: number | null
  nodeCount: number | null
  edgeCount: number | null
  graphifyVersion: string | null
}

function readStatus(cwd: string): StatusResult | string {
  if (!cwd.startsWith("/") || !existsSync(cwd)) {
    return "cwd must be an existing absolute directory"
  }
  const graphPath = join(cwd, "graphify-out", "graph.json")
  let stat
  try {
    stat = statSync(graphPath)
  } catch {
    return { found: false, mtimeMs: null, sizeBytes: null, nodeCount: null, edgeCount: null, graphifyVersion: null }
  }
  if (!stat.isFile()) {
    return { found: false, mtimeMs: null, sizeBytes: null, nodeCount: null, edgeCount: null, graphifyVersion: null }
  }
  let nodeCount: number | null = null
  let edgeCount: number | null = null
  let graphifyVersion: string | null = null
  if (stat.size <= 64 * 1024 * 1024) {
    try {
      const parsed = JSON.parse(readFileSync(graphPath, "utf8")) as {
        nodes?: unknown[]
        links?: unknown[]
        graph?: { graphify_version?: string }
      }
      nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : null
      edgeCount = Array.isArray(parsed.links) ? parsed.links.length : null
      graphifyVersion = parsed.graph?.graphify_version ?? null
    } catch {
      // corrupt/partial graph.json — counts stay null, mtime is still honest
    }
  }
  return {
    found: true,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    nodeCount,
    edgeCount,
    graphifyVersion,
  }
}

// ---------------------------------------------------------------------------
// plugin

function sendJson(res: import("node:http").ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
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

export function graphifyPlugin(): Plugin {
  return {
    name: "nexus-graphify",
    apply: "serve", // dev middleware only — the Tauri build uses graphify.rs
    configureServer(server) {
      server.middlewares.use("/graphify", (req, res) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/\/+$/, "") || "/"
        if (path === "/detect" && req.method === "GET") {
          const program = resolveBinary()
          if (!program) {
            sendJson(res, { available: false, version: null, path: null })
            return
          }
          void runWithTimeout(program, tmpdir(), ["--version"], DETECT_TIMEOUT_MS)
            .then((r) => {
              const version = r.stdout.trim().startsWith("graphify ")
                ? r.stdout.trim().slice("graphify ".length)
                : (r.stdout.trim().split(/\s+/).pop() ?? null)
              sendJson(res, { available: r.code === 0, version, path: program })
            })
            .catch(() => sendJson(res, { available: false, version: null, path: program }))
          return
        }
        if (path === "/status" && req.method === "GET") {
          const cwd = new URL(`http://x${req.url}`).searchParams.get("cwd") ?? ""
          const result = readStatus(cwd)
          if (typeof result === "string") {
            res.statusCode = 400
            sendJson(res, { error: result })
            return
          }
          sendJson(res, result)
          return
        }
        if (path === "/exec" && req.method === "POST") {
          void readBody(req)
            .then((body) => JSON.parse(body) as { cwd?: string; args?: string[] })
            .then((parsed) => {
              const cwd = parsed.cwd ?? ""
              const args = parsed.args ?? []
              const violation = validate(cwd, args)
              if (violation) {
                res.statusCode = 403
                sendJson(res, { error: violation })
                return
              }
              const program = resolveBinary()
              if (!program) {
                res.statusCode = 500
                sendJson(res, { error: "graphify CLI not found — install with `uv tool install graphifyy`" })
                return
              }
              void runWithTimeout(program, cwd, args, EXEC_TIMEOUT_MS)
                .then((r) => sendJson(res, r))
                .catch((err: unknown) => {
                  res.statusCode = 500
                  sendJson(res, {
                    error: err instanceof Error ? err.message : String(err),
                  })
                })
            })
            .catch(() => {
              res.statusCode = 400
              sendJson(res, { error: "invalid JSON body" })
            })
          return
        }
        res.statusCode = 404
        res.end()
      })
    },
  }
}
