// Per-tool display extraction — PURE formatters, no React (Phase B, §B2).
//
// Tool inputs and metadata arrive in arbitrary shapes (and are absent while
// a tool is pending), so every accessor here is defensive: wrong types fall
// through to a safe summary, never a raw JSON.stringify dump and never a
// guessed file path.

export type ToolKind =
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "grep"
  | "glob"
  | "subagent"
  | "other"

export interface ToolCallDisplay {
  title: string
  detail?: string
  filePaths: string[]
  kind: ToolKind
  /** subagent only — the child session id from metadata (link hint) */
  subagentSessionID?: string
}

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  write: "write",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  subagent: "subagent",
}

const DETAIL_MAX = 120

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function truncate(s: string): string {
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 1) + "…" : s
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function kindOf(name: unknown): ToolKind {
  const n = asString(name)?.toLowerCase()
  return (n && TOOL_KINDS[n]) || "other"
}

/** Path-like keys observed in real tool inputs (edit carries `path`;
 *  read/write variants have been seen as path/file/filePath). */
const PATH_KEYS = ["path", "file", "filePath"] as const

function inputPath(input: unknown): string | null {
  if (!isRecord(input)) return null
  for (const key of PATH_KEYS) {
    const v = asString(input[key])
    if (v) return v
  }
  return null
}

/** edit tool success metadata: { files: [{ file, patch }], truncated }. */
function metadataFilePaths(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.files)) return []
  const out: string[] = []
  for (const f of metadata.files) {
    if (isRecord(f)) {
      const file = asString(f.file)
      if (file) out.push(file)
    }
  }
  return out
}

/**
 * File paths actually present in the tool's input/metadata — only when
 * present, never guessed. Used by formatToolCall and by the store's
 * filesTouched activity tracking.
 */
export function extractFilePaths(
  name: unknown,
  input: unknown,
  metadata: unknown,
): string[] {
  const paths: string[] = []
  const kind = kindOf(name)
  if (kind === "read" || kind === "edit" || kind === "write") {
    const p = inputPath(input)
    if (p) paths.push(p)
  }
  paths.push(...metadataFilePaths(metadata))
  return [...new Set(paths)]
}

function firstCommand(input: unknown): string | null {
  if (!isRecord(input)) return null
  return asString(input.command) ?? asString(input.cmd)
}

function firstPattern(input: unknown): string | null {
  if (!isRecord(input)) return null
  return asString(input.pattern)
}

/**
 * Human display summary for a tool call. `input`/`metadata` may be missing
 * or any shape; unknown tools fall back to a title plus an input-key list.
 */
export function formatToolCall(
  name: unknown,
  input: unknown,
  metadata: unknown,
): ToolCallDisplay {
  const kind = kindOf(name)
  const label = asString(name) ?? "Tool"
  const filePaths = extractFilePaths(name, input, metadata)

  switch (kind) {
    case "read":
    case "write": {
      const detail = filePaths[0]
      return {
        title: capitalize(label),
        ...(detail !== undefined ? { detail } : {}),
        filePaths,
        kind,
      }
    }
    case "edit": {
      const detail =
        filePaths.length > 1
          ? `${filePaths.length} files`
          : filePaths[0]
      return {
        title: capitalize(label),
        ...(detail !== undefined ? { detail } : {}),
        filePaths,
        kind,
      }
    }
    case "bash": {
      const command = firstCommand(input)
      return {
        title: "Bash",
        ...(command ? { detail: truncate(command) } : {}),
        filePaths,
        kind,
      }
    }
    case "grep":
    case "glob": {
      const pattern = firstPattern(input)
      return {
        title: kind === "grep" ? "Grep" : "Glob",
        ...(pattern ? { detail: truncate(pattern) } : {}),
        filePaths,
        kind,
      }
    }
    case "subagent": {
      // live-verified input keys {agent, description, prompt}; metadata
      // carries the child session id for linking
      const description = isRecord(input) ? asString(input.description) : null
      const agent = isRecord(input) ? asString(input.agent) : null
      const childSessionID = isRecord(metadata)
        ? asString(metadata.sessionID)
        : null
      return {
        title: description ?? "Subagent",
        ...(agent ? { detail: agent } : {}),
        filePaths,
        kind,
        ...(childSessionID ? { subagentSessionID: childSessionID } : {}),
      }
    }
    case "other": {
      // safe fallback: summarize input keys — never dump raw JSON
      const keys = isRecord(input) ? Object.keys(input) : []
      return {
        title: capitalize(label),
        ...(keys.length > 0 ? { detail: truncate(keys.join(", ")) } : {}),
        filePaths,
        kind,
      }
    }
  }
}
