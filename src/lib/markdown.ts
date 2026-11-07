// Markdown → HTML for the read-only System/memory viewers (SPEC-PHASE3 §8.2)
// and, since Phase 4, assistant chat text parts (SPEC-PHASE4 §8).
//
// Security: html:false escapes every raw HTML tag in the source; markdown-it's
// default validateLink blocks javascript:/data: URLs. Safe by default with no
// second sanitizer dependency. Output goes through dangerouslySetInnerHTML in
// a fixed .md-body container — never feed it untrusted markdown.
//
// Phase C (C1): fenced code blocks get sugar-high highlighting for JS/TS
// (everything else falls back to a styled plain block — sugar-high's
// tokenizer only understands the JS/TS family) and, when the caller opts in
// via `codeCopy`, a copy button. The button is INERT markup (data-md-copy,
// no inline handlers — CSP-safe); the click is handled by React delegation
// in the chat's TextBody. System viewers keep the default (no button).
//
// sugar-high loads LAZILY (dynamic import — keeps ~11.6 kB gz out of the
// initial chunk). renderMarkdown stays SYNC: until the chunk arrives (or if
// it ever fails to load) JS/TS fences render as escaped plain blocks, then
// upgrade once ready. Components subscribe with useHighlighterReady() to
// re-render on arrival; imperative callers can await ensureHighlighter().
// Dynamic import is CSP-safe: a static chunk URL from the app origin — no
// eval, no inline script.

import MarkdownIt from "markdown-it"
import { useSyncExternalStore } from "react"

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

// Fence-info aliases sugar-high reliably tokenizes (JS/TS family only —
// other languages fall through to a plain styled block).
const SUGAR_HIGH_LANGS = new Set([
  "js",
  "jsx",
  "javascript",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "typescript",
  "mtsx",
])

// --- lazy highlighter (sugar-high via dynamic import) ----------------------

type HighlightFn = (src: string) => string

let highlightFn: HighlightFn | null = null
let highlightPromise: Promise<void> | null = null
const highlightListeners = new Set<() => void>()

/** Load the lazy highlighter once (memoized). Resolves even when the chunk
 *  fails — fences then keep the plain escaped-block fallback. */
export function ensureHighlighter(): Promise<void> {
  highlightPromise ??= import("sugar-high")
    .then((m) => {
      highlightFn = m.highlight
      for (const fn of highlightListeners) fn()
    })
    .catch(() => {
      // chunk load failure → stay on the plain-block fallback (already rendered)
    })
  return highlightPromise
}

// Prefetch: the chunk loads as soon as this module does (chat and both
// System viewers import it), keeping the initial bundle clean without any
// caller-side wiring.
void ensureHighlighter()

function isHighlighterReady(): boolean {
  return highlightFn !== null
}

function subscribeHighlighter(fn: () => void): () => void {
  highlightListeners.add(fn)
  return () => {
    highlightListeners.delete(fn)
  }
}

/** Re-render the calling component once the lazy highlighter arrives, so
 *  already-rendered fences upgrade from plain blocks to token spans. A no-op
 *  (and cheap) when the highlighter is already loaded. Pair with
 *  renderMarkdown — it picks up readiness internally. */
export function useHighlighterReady(): void {
  useSyncExternalStore(subscribeHighlighter, isHighlighterReady)
}

// Full replacement (never falls back to the default fence renderer — every
// fenced block goes through the .md-code wrapper).
md.renderer.rules.fence = (tokens, idx, _options, env, _self) => {
  const token = tokens[idx]!
  const lang = (token.info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const escape = md.utils.escapeHtml
  let body: string
  if (SUGAR_HIGH_LANGS.has(lang) && highlightFn) {
    // empty source (or an empty highlight result) → plain escaped block
    body = highlightFn(token.content) || escape(token.content)
  } else {
    body = escape(token.content)
  }
  // data-md-lang + data-md-copy are read by the chat's click delegation
  // (env.codeCopy — chat opts in; System viewers omit it and get no button)
  const copy =
    env?.codeCopy === true
      ? '<button type="button" class="md-code-copy" data-md-copy aria-label="Copy code to clipboard">Copy</button>'
      : ""
  // header row (lang label + optional copy) above the code well — the labels
  // no longer overlap the first code line (Phase C designer pass)
  return (
    `<div class="md-code" data-md-lang="${escape(lang)}">` +
    `<div class="md-code-head">` +
    `<span class="md-code-lang">${escape(lang || "text")}</span>` +
    copy +
    `</div>` +
    `<pre><code>${body}</code></pre></div>`
  )
}

export interface MarkdownOptions {
  /** Render the inert copy button on fenced code blocks (chat only — the
   *  System viewers call without it and keep their previous output). */
  codeCopy?: boolean
}

/** Render markdown source to an HTML string (escaped HTML, safe links). */
export function renderMarkdown(src: string, options?: MarkdownOptions): string {
  return md.render(src, { codeCopy: options?.codeCopy === true })
}
