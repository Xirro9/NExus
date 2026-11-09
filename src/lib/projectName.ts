// Project-name validation for the Projects tab "new project" flow. PURE —
// no fs, no store, no transport. The host side (fs.rs fs_create_dir /
// src/server/devfs.ts) re-validates the joined path; this is the UI-facing
// guard that produces readable errors before anything is called.

export type SanitizeResult =
  | { ok: true; name: string }
  | { ok: false; reason: string }

/** Trim + validate a user-typed project name. The name is kept VERBATIM
 *  (except trim) — no whitespace collapsing, no case changes. Rejected:
 *  empty, "." / "..", path separators, NUL / control characters, and a
 *  leading "-" (reads like a CLI flag). */
export function sanitizeProjectName(input: string): SanitizeResult {
  const name = input.trim()
  if (name.length === 0) {
    return { ok: false, reason: "Project name is empty" }
  }
  if (name === "." || name === "..") {
    return { ok: false, reason: `"${name}" is not a valid project name` }
  }
  if (name.includes("\0")) {
    return { ok: false, reason: "Project name contains a NUL byte" }
  }
  if (/[/\\]/.test(name)) {
    return { ok: false, reason: "Project name must not contain path separators" }
  }
  if (name.startsWith("-")) {
    return { ok: false, reason: `Project name must not start with "-": ${name}` }
  }
  if (/[\x01-\x1f\x7f]/.test(name)) {
    return { ok: false, reason: "Project name contains control characters" }
  }
  return { ok: true, name }
}

/** Join a validated name onto an absolute parent directory. Simple string
 *  join — NO realpath pretense: the Rust side (fs_create_dir) canonicalizes.
 *  Throws on a non-absolute parent (a caller bug or unvalidated input — the
 *  store catches and toasts). */
export function joinProjectPath(parent: string, name: string): string {
  if (!parent.startsWith("/")) {
    throw new Error(`Parent directory must be an absolute path: ${JSON.stringify(parent)}`)
  }
  // trailing slashes would double up the separator; "/" alone stays the root
  return `${parent.replace(/\/+$/, "")}/${name}`
}
