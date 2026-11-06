// Unit tests for the per-tool display extractors (§B2) — including the
// missing-field and weird-shape cases the live API makes possible.

import { describe, expect, it } from "vitest"

import { extractFilePaths, formatToolCall } from "./toolDisplay"

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
