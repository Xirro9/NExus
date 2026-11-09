// Unit tests for the "new project" name validation + path join (pure — no
// fs, no store, no transport). The host side re-validates the joined path
// (fs.rs / devfs.ts); these cover the UI-facing guard only.

import { describe, expect, it } from "vitest"

import { joinProjectPath, sanitizeProjectName } from "./projectName"

describe("sanitizeProjectName", () => {
  it("accepts a plain name verbatim", () => {
    expect(sanitizeProjectName("my-project")).toEqual({ ok: true, name: "my-project" })
  })

  it("trims surrounding whitespace but keeps the inside verbatim", () => {
    expect(sanitizeProjectName("  my proj  ")).toEqual({ ok: true, name: "my proj" })
    expect(sanitizeProjectName("My Weird_Name.v2")).toEqual({
      ok: true,
      name: "My Weird_Name.v2",
    })
    // no collapsing, no case changes — the user's name is kept as typed
    expect(sanitizeProjectName("  spaced   out ")).toEqual({
      ok: true,
      name: "spaced   out",
    })
  })

  it("accepts unicode", () => {
    expect(sanitizeProjectName("Projekt ✓")).toEqual({ ok: true, name: "Projekt ✓" })
  })

  it("rejects empty and whitespace-only names", () => {
    expect(sanitizeProjectName("").ok).toBe(false)
    expect(sanitizeProjectName("   \t ").ok).toBe(false)
  })

  it("rejects dot segments (even when padded with spaces)", () => {
    expect(sanitizeProjectName(".").ok).toBe(false)
    expect(sanitizeProjectName("..").ok).toBe(false)
    expect(sanitizeProjectName(" . ").ok).toBe(false)
  })

  it("rejects path separators (both slash and backslash)", () => {
    expect(sanitizeProjectName("a/b").ok).toBe(false)
    expect(sanitizeProjectName("a\\b").ok).toBe(false)
    expect(sanitizeProjectName("/etc").ok).toBe(false)
  })

  it("rejects NUL and control characters", () => {
    expect(sanitizeProjectName("a\0b").ok).toBe(false)
    expect(sanitizeProjectName("a\nb").ok).toBe(false)
    expect(sanitizeProjectName("a\tb").ok).toBe(false)
  })

  it("rejects a leading dash but allows inner dashes", () => {
    expect(sanitizeProjectName("-flag").ok).toBe(false)
    expect(sanitizeProjectName("a-b")).toEqual({ ok: true, name: "a-b" })
  })

  it("carries a readable reason on rejection", () => {
    const r = sanitizeProjectName("a/b")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("separator")
  })
})

describe("joinProjectPath", () => {
  it("joins with a single slash", () => {
    expect(joinProjectPath("/home/u/Projects", "my proj")).toBe("/home/u/Projects/my proj")
  })

  it("normalizes trailing slashes on the parent", () => {
    expect(joinProjectPath("/home/u/Projects/", "p")).toBe("/home/u/Projects/p")
    expect(joinProjectPath("/home/u/Projects///", "p")).toBe("/home/u/Projects/p")
  })

  it("handles the filesystem root", () => {
    expect(joinProjectPath("/", "p")).toBe("/p")
  })

  it("keeps the name verbatim (no whitespace collapsing)", () => {
    expect(joinProjectPath("/p", "My Proj")).toBe("/p/My Proj")
  })

  it("rejects a non-absolute parent", () => {
    expect(() => joinProjectPath("relative", "p")).toThrow(/absolute/)
    expect(() => joinProjectPath("", "p")).toThrow(/absolute/)
    expect(() => joinProjectPath("./here", "p")).toThrow(/absolute/)
  })
})
