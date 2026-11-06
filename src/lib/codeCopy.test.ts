// resolveCopyTarget regression tests (M1): the markdown fence renderer emits
// the copy button INSIDE .md-code-head with the <pre> as a SIBLING of the
// head under the .md-code wrapper — the old parentElement.querySelector("pre")
// scoping searched only the head row's descendants and always found nothing,
// so every click copied "". These tests pin the closest(".md-code") scoping.
//
// Vitest runs in pure node (vitest.config.ts — no DOM), so the "DOM" is a
// minimal mock mirroring the renderer's emitted structure; the renderer-side
// structure itself is pinned by the sibling/head-row test in markdown.test.ts.

import { describe, expect, it } from "vitest"

import { resolveCopyTarget } from "./codeCopy"

interface FakePre {
  textContent: string
}
interface FakeCode {
  querySelector(sel: string): FakePre | null
}

/** A copy button mock shaped like the renderer's output:
 *  <div class="md-code"> <div class="md-code-head"> …btn </div> <pre>… </pre> </div>
 *  (btn's parentElement = the head row — which contains NO <pre>).
 *  Omit preText to model a .md-code with no <pre>; pass orphan for a button
 *  with no .md-code ancestor at all. */
function mockButton(opts: { preText?: string; orphan?: boolean }): Element {
  const pre: FakePre | null =
    opts.preText === undefined ? null : { textContent: opts.preText }
  const codeDiv: FakeCode = {
    querySelector: (sel) => (sel === "pre" ? pre : null),
  }
  return {
    parentElement: {
      querySelector: (sel: string) => (sel === "pre" ? null : null),
    },
    closest: (sel: string) => (sel === ".md-code" && !opts.orphan ? codeDiv : null),
  } as unknown as Element
}

describe("resolveCopyTarget (markdown copy-button scoping)", () => {
  it("finds the sibling <pre> text through the .md-code wrapper", () => {
    const btn = mockButton({ preText: "const x = 1\n" })
    expect(resolveCopyTarget(btn)).toBe("const x = 1\n")
  })

  it("M1 regression: works even though the <pre> is NOT inside the button's parentElement", () => {
    const btn = mockButton({ preText: "hi()\n" })
    // the buggy query (what MessageBubble used to do) finds nothing on this
    // structure — the head row has no <pre> descendants:
    const buggy = (
      (btn as unknown as { parentElement: { querySelector(s: string): unknown } })
        .parentElement.querySelector("pre") as FakePre | null
    )?.textContent
    expect(buggy).toBeUndefined()
    // …while the fixed scoping resolves the code:
    expect(resolveCopyTarget(btn)).toBe("hi()\n")
  })

  it("returns null when the button has no .md-code ancestor", () => {
    expect(resolveCopyTarget(mockButton({ orphan: true, preText: "x" }))).toBeNull()
  })

  it("returns null when the .md-code wrapper has no <pre>", () => {
    expect(resolveCopyTarget(mockButton({}))).toBeNull()
  })

  it("returns the empty string for an empty fence (a real, copyable block)", () => {
    expect(resolveCopyTarget(mockButton({ preText: "" }))).toBe("")
  })
})
