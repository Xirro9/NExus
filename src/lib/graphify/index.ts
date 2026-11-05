// Graphify integration helpers (docs/NOTES-SESSIONS-GRAPHIFY.md).
//
// Jerry drives the OFFICIAL Graphify CLI (package `graphifyy`) — it never
// reimplements extraction. These builders are the single source of truth for
// the argument vectors Jerry sends; the Rust validate() (src-tauri) and the
// dev middleware (src/server/graphify.ts) whitelist exactly what is produced
// here. Code-only + no-LLM by construction: `extract --code-only` skips all
// semantic extraction, `update` is hash-based and model-free, and community
// labeling stays on placeholder names via --no-label.

import type { SessionInfo } from "@/lib/opencode/types"

export const GRAPHIFY_INSTALL_HINT = "uv tool install graphifyy"

/**
 * Tools that mutate files — the Graphify staleness signal. OpenCode v2.2.5
 * emits no filesystem.changed events (verified live: touching a project file
 * produced nothing on /api/event), so Jerry watches file-mutating tool calls
 * on the SSE stream instead. Lowercased tool names.
 */
export const FILE_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "applypatch",
])

/** Initial build: deterministic local AST extraction, no API key, no model. */
export function buildExtractArgs(): string[] {
  return ["extract", ".", "--code-only"]
}

/** Post-extract clustering: local, deterministic, keeps placeholder names,
 *  skips the HTML viz (lightweight default). */
export function buildClusterArgs(): string[] {
  return ["cluster-only", ".", "--no-label", "--no-viz"]
}

/** Incremental refresh: re-parses only files whose hashes changed. */
export function buildUpdateArgs(force = false): string[] {
  return force ? ["update", ".", "--force"] : ["update", "."]
}

export function buildQueryArgs(
  question: string,
  opts?: { budget?: number; depth?: number; dfs?: boolean },
): string[] {
  const args = ["query", question]
  if (opts?.budget !== undefined) args.push("--budget", String(Math.min(8000, Math.max(1, Math.floor(opts.budget)))))
  if (opts?.depth !== undefined) args.push("--depth", String(Math.min(6, Math.max(1, Math.floor(opts.depth)))))
  if (opts?.dfs) args.push("--dfs")
  return args
}

export function buildPathArgs(a: string, b: string, undirected = true): string[] {
  return undirected ? ["path", a, b, "--undirected"] : ["path", a, b]
}

export function buildExplainArgs(term: string): string[] {
  return ["explain", term]
}

/** Architectural hubs (god-nodes) as JSON — the "dependency information" for
 *  the project panel, straight from the official CLI. */
export function buildHubsArgs(): string[] {
  return ["god-nodes", "--json", "--top", "5"]
}

/**
 * Graphify's documented exit contract: 0 answer, 3 ambiguous name
 * (candidates printed), 4 no node matches. Map to honest operator text.
 */
export function describeExecFailure(r: {
  code: number | null
  timedOut: boolean
  stderr: string
}): string | null {
  if (r.timedOut) return "graphify timed out"
  switch (r.code) {
    case 0:
      return null
    case 3:
      return "Ambiguous name — the candidates are listed in the output"
    case 4:
      return "No node matches that name — try a symbol from the code"
    default:
      return (
        r.stderr.trim().split("\n").pop() ??
        `graphify exited with code ${String(r.code)}`
      )
  }
}

/** Parse `god-nodes --json` output. The CLI may print progress lines around
 *  the JSON — extract the first JSON array defensively. */
export function parseHubs(stdout: string): { label: string; degree: number }[] {
  const start = stdout.indexOf("[")
  const end = stdout.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    const hubs: { label: string; degree: number }[] = []
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue
      const rec = item as Record<string, unknown>
      const label = rec.label ?? rec.name ?? (typeof rec.id === "string" ? rec.id : null)
      const degree = rec.degree ?? rec.connections ?? rec.weight
      if (typeof label === "string" && typeof degree === "number") {
        hubs.push({ label, degree })
      }
    }
    return hubs
  } catch {
    return []
  }
}

/**
 * Staleness WITHOUT fabricating evidence: OpenCode v2.2.5 emits no
 * filesystem.changed events (verified live), so Jerry compares the graph's
 * build time against the newest session activity for the project. Any
 * session `time.updated` newer than graph.json means code may have changed
 * under the graph — phrased as "source activity since", never as a fact
 * about specific files. The exact check is `graphify update .` itself
 * (hash-based, near-instant when nothing changed).
 */
export function deriveStaleness(
  mtimeMs: number | null,
  sessions: Record<string, SessionInfo>,
  projectID: string,
): { stale: boolean; lastActivity: number | null } {
  if (mtimeMs === null) return { stale: false, lastActivity: null }
  let lastActivity: number | null = null
  for (const s of Object.values(sessions)) {
    if (s.projectID !== projectID) continue
    const t = s.time.updated || s.time.created
    if (lastActivity === null || t > lastActivity) lastActivity = t
  }
  return { stale: lastActivity !== null && lastActivity > mtimeMs, lastActivity }
}
