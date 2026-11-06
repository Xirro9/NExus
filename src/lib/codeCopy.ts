// Copy-target resolution for the inert markdown code-copy buttons (Phase C).
//
// The fence renderer (src/lib/markdown.ts) emits the button INSIDE the
// .md-code-head header row, with the <pre> as a SIBLING of the head under the
// .md-code wrapper — so the scoping query must climb to .md-code via closest()
// before looking for the <pre>. Kept as a pure DOM-reading helper so the
// delegation scope is unit-testable in the node-only vitest environment (no
// DOM there — tests feed a minimal mock mirroring the renderer's structure).

/**
 * Text of the <pre> belonging to the clicked copy button's fenced block, or
 * null when no scoped <pre> exists (caller must not flash "Copied" then).
 */
export function resolveCopyTarget(btn: Element): string | null {
  const pre = btn.closest(".md-code")?.querySelector("pre")
  return pre?.textContent ?? null
}
