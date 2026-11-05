// Markdown → HTML for the read-only System/memory viewers (SPEC-PHASE3 §8.2)
// and, since Phase 4, assistant chat text parts (SPEC-PHASE4 §8).
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

// Webview has no tab UI — open links externally-capable and drop opener
// access (SPEC-PHASE4 §8). Applies to both chat and the System viewers.
const defaultLinkRender =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank")
  tokens[idx].attrSet("rel", "noopener noreferrer")
  return defaultLinkRender(tokens, idx, options, env, self)
}

/** Render markdown source to an HTML string (escaped HTML, safe links). */
export function renderMarkdown(src: string): string {
  return md.render(src)
}
