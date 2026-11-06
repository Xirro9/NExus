// Markdown fence behavior (C1): sugar-high on JS/TS, graceful plain-block
// fallback for other languages, copy button only when the caller opts in,
// security posture unchanged (raw HTML escaped).

import { describe, expect, it } from "vitest"

import { renderMarkdown } from "./markdown"

describe("renderMarkdown fences", () => {
  it("highlights TS/JS fences through sugar-high (token spans present)", () => {
    const html = renderMarkdown("```ts\nconst x: number = 1\n```")
    expect(html).toContain("md-code")
    expect(html).toContain("sh__token--keyword")
    expect(html).toContain('data-md-lang="ts"')
  })

  it("falls back to a plain escaped block for non-JS/TS languages", () => {
    const html = renderMarkdown("```python\ndef f(): pass\n```")
    expect(html).toContain("md-code")
    expect(html).toContain('data-md-lang="python"')
    expect(html).not.toContain("sh__token")
    expect(html).toContain("def f(): pass")
  })

  it("never crashes on an empty or unknown fence", () => {
    expect(renderMarkdown("```\n```")).toContain("md-code")
    expect(renderMarkdown("```brainfuck\n+[-]+\n```")).toContain("+[-]+")
  })

  it("emits the copy button only with codeCopy: true", () => {
    const plain = renderMarkdown("```js\nhi()\n```")
    expect(plain).not.toContain("data-md-copy")
    const chat = renderMarkdown("```js\nhi()\n```", { codeCopy: true })
    expect(chat).toContain("data-md-copy")
  })

  // Delegation contract (M1): the button lives INSIDE the .md-code-head row
  // and the <pre> is its SIBLING under the .md-code wrapper — the chat's
  // copy click must scope via closest(".md-code"), not parentElement
  // (src/lib/codeCopy.ts; structure mirrored by codeCopy.test.ts).
  it("puts the copy button in the head row with the <pre> as its sibling", () => {
    const html = renderMarkdown("```ts\nhi()\n```", { codeCopy: true })
    expect(html).toContain(
      '<div class="md-code-head"><span class="md-code-lang">ts</span>' +
        '<button type="button" class="md-code-copy" data-md-copy',
    )
    expect(html).toContain("</button></div><pre>")
  })

  it("escapes raw HTML in fences (security posture unchanged)", () => {
    const html = renderMarkdown("```html\n<img src=x onerror=alert(1)>\n```")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })

  it("renders tables with the existing md-body table markup", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>")
  })
})
