// Markdown → HTML for the read-only System/memory viewers (SPEC-PHASE3 §8.2).
// Scope: memory viewer + skill-content expander ONLY — chat markdown stays
// deferred (Phase 1 decision stands).
//
// Security: html:false escapes every raw HTML tag in the source; markdown-it's
// default validateLink blocks javascript:/data: URLs. Safe by default with no
// second sanitizer dependency. Output goes through dangerouslySetInnerHTML in
// a fixed .md-body container — never feed it untrusted markdown.

import MarkdownIt from "markdown-it"

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

/** Render markdown source to an HTML string (escaped HTML, safe links). */
export function renderMarkdown(src: string): string {
  return md.render(src)
}
