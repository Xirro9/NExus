// Dev-only host filesystem middleware — Node-only Vite plugin. Browser-mode
// mirror of src-tauri/src/fs.rs (production Tauri path). The path validation
// below MUST stay in sync with fs.rs validate_absolute() and the UI-side
// pre-checks in src/lib/projectName.ts — a three-way mirror, same discipline
// as the graphify whitelist (see src/server/graphify.ts). DEV-ONLY BY NATURE:
// `apply: "serve"` keeps this plugin out of the vite build entirely, so it
// never ships inside the Tauri bundle — the desktop shell reaches fs.rs over
// IPC instead.

import { mkdirSync, realpathSync, statSync } from "node:fs"
import type { Plugin } from "vite"

// ---------------------------------------------------------------------------
// validation — mirror of fs.rs validate_absolute()

function validate(path: string): string | null {
  if (path.length === 0) return "path is empty"
  if (path.includes("\0")) return "path contains a NUL byte"
  if (!path.startsWith("/")) {
    return `path must be absolute: ${JSON.stringify(path)}`
  }
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") {
      return `path must not contain ${JSON.stringify(seg)} segments: ${JSON.stringify(path)}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// error mapping — mirror of fs.rs io_message()

function ioMessage(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return "permission denied — check the parent directory's permissions"
    case "ENOTDIR":
      return "a parent path component is not a directory"
    default:
      return `mkdir failed: ${err.message}`
  }
}

interface MkdirResult {
  path: string
  existed: boolean
}

/** Mirror of fs.rs fs_create_dir: validate, decide `existed` BEFORE creating,
 *  create with parents, return the canonicalized path. Errors come back as
 *  readable strings (500), never thrown. */
function mkdirAll(target: string): MkdirResult | string {
  let existed = false
  try {
    existed = statSync(target).isDirectory()
  } catch {
    // missing — created below
  }
  try {
    mkdirSync(target, { recursive: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === "EEXIST") {
      // concurrent-creation race (fs.rs mirror) — fine when it really is a
      // directory now; a file in the way stays an error
      try {
        if (statSync(target).isDirectory()) {
          return { path: realpathSync(target), existed: true }
        }
      } catch {
        // fall through to the error below
      }
    }
    return ioMessage(e)
  }
  return { path: realpathSync(target), existed }
}

// ---------------------------------------------------------------------------
// plugin (same middleware shape as graphifyPlugin)

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

export function devFsPlugin(): Plugin {
  return {
    name: "nexus-devfs",
    apply: "serve", // dev middleware only — the Tauri build uses fs.rs
    configureServer(server) {
      server.middlewares.use("/dev/fs", (req, res) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/\/+$/, "") || "/"
        if (path === "/mkdir" && req.method === "POST") {
          void readBody(req)
            .then((body) => JSON.parse(body) as { path?: string })
            .then((parsed) => {
              const target = parsed.path ?? ""
              const violation = validate(target)
              if (violation) {
                res.statusCode = 400
                sendJson(res, { error: violation })
                return
              }
              const result = mkdirAll(target)
              if (typeof result === "string") {
                res.statusCode = 500
                sendJson(res, { error: result })
                return
              }
              sendJson(res, result)
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
