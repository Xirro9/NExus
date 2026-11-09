// Unit tests for the per-tool display extractors (§B2) — including the
// missing-field and weird-shape cases the live API makes possible.

import { describe, expect, it } from "vitest"

import {
  extractFilePaths,
  formatToolCall,
  researchSourceOf,
} from "./toolDisplay"

describe("formatToolCall — known tools", () => {
  it("read: title + path detail", () => {
    const d = formatToolCall("read", { path: "/src/a.ts" }, undefined)
    expect(d).toMatchObject({
      title: "Read",
      detail: "/src/a.ts",
      kind: "read",
      filePaths: ["/src/a.ts"],
    })
  })

  it("write: title + path detail", () => {
    const d = formatToolCall("write", { filePath: "/src/new.ts" }, undefined)
    expect(d.title).toBe("Write")
    expect(d.detail).toBe("/src/new.ts")
    expect(d.kind).toBe("write")
  })

  it("edit: single file uses the path as detail", () => {
    const d = formatToolCall("edit", { path: "/src/a.ts" }, undefined)
    expect(d.detail).toBe("/src/a.ts")
    expect(d.kind).toBe("edit")
  })

  it("edit: multi-file metadata summarizes the count and dedupes paths", () => {
    const d = formatToolCall(
      "edit",
      { path: "/src/a.ts" },
      {
        files: [
          { file: "/src/a.ts", patch: "…" },
          { file: "/src/b.ts", patch: "…" },
          { file: "/src/a.ts", patch: "…" }, // duplicate — deduped
        ],
      },
    )
    expect(d.detail).toBe("2 files")
    expect(d.filePaths).toEqual(["/src/a.ts", "/src/b.ts"])
  })

  it("bash: command as detail, truncated", () => {
    const long = "x".repeat(300)
    const d = formatToolCall("bash", { command: long }, undefined)
    expect(d.title).toBe("Bash")
    expect(d.detail!.length).toBe(120)
    expect(d.detail!.endsWith("…")).toBe(true)
  })

  it("shell (live-verified lowercase name): bash-kind rendering, name-derived title", () => {
    const d = formatToolCall("shell", { command: "npm test" }, { exit: 0 })
    expect(d).toMatchObject({
      title: "Shell", // derived from the tool name, not hardcoded "Bash"
      detail: "npm test",
      kind: "bash",
      filePaths: [],
    })
    // command key is picked up like bash, so the card shows command+output
    expect(extractFilePaths("shell", { command: "ls" }, undefined)).toEqual([])
  })

  it("grep/glob: pattern as detail, no file paths", () => {
    const grep = formatToolCall("grep", { pattern: "applyEvent" }, undefined)
    expect(grep).toMatchObject({ title: "Grep", detail: "applyEvent", kind: "grep", filePaths: [] })
    const glob = formatToolCall("glob", { pattern: "**/*.ts" }, undefined)
    expect(glob).toMatchObject({ title: "Glob", detail: "**/*.ts", kind: "glob" })
  })

  it("subagent: title from description, detail from agent, child session link hint", () => {
    // live-verified shapes: input {agent, description, prompt};
    // metadata {sessionID, status, truncated}
    const d = formatToolCall(
      "subagent",
      { agent: "architect", description: "Review the spec", prompt: "…" },
      { sessionID: "ses_child", status: "running", truncated: false },
    )
    expect(d).toMatchObject({
      title: "Review the spec",
      detail: "architect",
      kind: "subagent",
      filePaths: [],
      subagentSessionID: "ses_child",
    })
  })

  it("subagent: missing description falls back to the plain title", () => {
    const d = formatToolCall("subagent", { prompt: "…" }, undefined)
    expect(d.title).toBe("Subagent")
    expect(d.detail).toBeUndefined()
    expect(d.subagentSessionID).toBeUndefined()
  })
})

describe("formatToolCall — fallback (no raw JSON dumps)", () => {
  it("unknown tool: input keys summarized, not serialized", () => {
    const d = formatToolCall(
      "webfetch",
      { url: "https://example.com", timeout: 30 },
      undefined,
    )
    expect(d.title).toBe("Webfetch")
    expect(d.detail).toBe("url, timeout")
    expect(d.kind).toBe("other")
    expect(JSON.stringify(d)).not.toContain("https://example.com")
  })

  it("missing name → generic title, other kind", () => {
    const d = formatToolCall(undefined, { path: "/x" }, undefined)
    expect(d.title).toBe("Tool")
    expect(d.kind).toBe("other")
    expect(d.filePaths).toEqual([])
  })

  it("missing everything → safe minimal summary", () => {
    const d = formatToolCall(undefined, undefined, undefined)
    expect(d.title).toBe("Tool")
    expect(d.detail).toBeUndefined()
    expect(d.filePaths).toEqual([])
  })
})

describe("formatToolCall — defensive against weird shapes", () => {
  it("input as a bare string does not crash", () => {
    const d = formatToolCall("read", "weird", undefined)
    expect(d.title).toBe("Read")
    expect(d.detail).toBeUndefined()
    expect(d.filePaths).toEqual([])
  })

  it("input as an array does not crash", () => {
    const d = formatToolCall("bash", ["ls", "-la"], undefined)
    expect(d.title).toBe("Bash")
    expect(d.detail).toBeUndefined()
  })

  it("metadata as a bare string/array does not crash", () => {
    const a = formatToolCall("edit", { path: "/x" }, "weird")
    expect(a.filePaths).toEqual(["/x"])
    const b = formatToolCall("edit", { path: "/x" }, [1, 2])
    expect(b.filePaths).toEqual(["/x"])
  })

  it("null/number values in input are ignored, not stringified", () => {
    const d = formatToolCall("read", { path: 123, file: null }, undefined)
    expect(d.detail).toBeUndefined()
    expect(d.filePaths).toEqual([])
  })

  it("metadata.files with non-object entries is skipped", () => {
    const d = formatToolCall("edit", undefined, { files: ["nope", 42, { file: "/ok" }] })
    expect(d.filePaths).toEqual(["/ok"])
  })

  it("empty strings never win over real values", () => {
    const d = formatToolCall("bash", { command: "" }, undefined)
    expect(d.detail).toBeUndefined()
  })
})

describe("extractFilePaths", () => {
  it("only read/edit/write inputs contribute paths", () => {
    expect(extractFilePaths("read", { path: "/a" }, undefined)).toEqual(["/a"])
    expect(extractFilePaths("bash", { path: "/a" }, undefined)).toEqual([])
    expect(extractFilePaths("subagent", { description: "/a" }, undefined)).toEqual([])
  })

  it("metadata.files contribute regardless of tool name (edit shape)", () => {
    expect(
      extractFilePaths("edit", undefined, { files: [{ file: "/b" }] }),
    ).toEqual(["/b"])
  })

  it("never guesses: absent input/metadata → empty", () => {
    expect(extractFilePaths("edit", undefined, undefined)).toEqual([])
    expect(extractFilePaths("edit", {}, {})).toEqual([])
  })
})

// --- research-library tools (T5) ----------------------------------------------
// The six bare plugin tools get kind "research" with honest card titles; the
// internal-vs-external tally uses researchSourceOf, a SEPARATE helper — the
// webfetch → "other" pin above is untouched on purpose.

describe("formatToolCall — research-library tools", () => {
  const TITLES: [string, string][] = [
    ["research_library_search", "Library search"],
    ["research_library_list", "Library list"],
    ["research_library_get", "Library document"],
    ["research_library_import", "Library import"],
    ["research_library_refresh", "Library reindex"],
    ["research_library_status", "Library status"],
  ]

  it("six bare tools → kind research with honest titles, no fabricated detail", () => {
    for (const [name, title] of TITLES) {
      const d = formatToolCall(name, {}, undefined)
      expect(d).toMatchObject({ title, kind: "research", filePaths: [] })
      expect(d.detail).toBeUndefined()
    }
  })

  it("detail from input: query / slug / docId, whichever is present", () => {
    expect(
      formatToolCall("research_library_search", { query: "SEC. 4" }, undefined).detail,
    ).toBe("SEC. 4")
    expect(
      formatToolCall("research_library_get", { docId: "legislation/s-5471" }, undefined)
        .detail,
    ).toBe("legislation/s-5471")
    expect(
      formatToolCall("research_library_import", { slug: "congressional-status" }, undefined)
        .detail,
    ).toBe("congressional-status")
  })

  it("query wins when several keys are present; weird input shapes stay safe", () => {
    const d = formatToolCall(
      "research_library_search",
      { query: "ai", slug: "x", docId: "c/y" },
      undefined,
    )
    expect(d.detail).toBe("ai")
    const weird = formatToolCall("research_library_refresh", 42, undefined)
    expect(weird.kind).toBe("research")
    expect(weird.detail).toBeUndefined()
  })
})

describe("researchSourceOf", () => {
  it("the six research_library_* tools are internal", () => {
    for (const name of [
      "research_library_search",
      "research_library_list",
      "research_library_get",
      "research_library_import",
      "research_library_refresh",
      "research_library_status",
    ]) {
      expect(researchSourceOf(name)).toBe("internal")
    }
  })

  it("internal is a prefix rule — a future seventh library tool classifies as internal", () => {
    expect(researchSourceOf("research_library_something_new")).toBe("internal")
    expect(researchSourceOf("RESEARCH_LIBRARY_GET")).toBe("internal") // case-insensitive
  })

  it("web tools are external", () => {
    expect(researchSourceOf("webfetch")).toBe("external")
    expect(researchSourceOf("websearch")).toBe("external")
  })

  it("everything else is neither — never guessed", () => {
    expect(researchSourceOf("bash")).toBeNull()
    expect(researchSourceOf("subagent")).toBeNull()
    expect(researchSourceOf("grep")).toBeNull()
    expect(researchSourceOf("totally_unknown")).toBeNull()
    expect(researchSourceOf("")).toBeNull()
  })
})
