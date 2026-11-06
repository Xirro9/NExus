// Unit tests for the message-fetch mapping (toChatMessage via api.listMessages).
// The transport is mocked at the module boundary — no DOM, no Tauri, no network.
// Focus: tool parts must carry state.metadata through the fetch path exactly
// like the live SSE reducer does (Phase C fix — patches/subagent links were
// previously dropped for freshly-loaded sessions).

import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  isTauri: () => false,
  transport: { request: mockRequest },
}))

import { api } from "./client"

function okBody(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    bodyText: JSON.stringify(body),
  }
}

describe("listMessages — tool part mapping", () => {
  beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockResolvedValue(okBody([]))
  })

  it("tool parts keep state.metadata (patch excerpts / subagent links survive fetch)", async () => {
    const metadata = { files: [{ file: "/src/a.ts", patch: "@@ -1 +1 @@" }] }
    mockRequest.mockResolvedValue(
      okBody([
        {
          type: "assistant",
          id: "msg1",
          sessionID: "ses1",
          time: { created: 123 },
          content: [
            {
              type: "tool",
              id: "part1",
              name: "edit",
              executed: true,
              state: {
                status: "completed",
                input: { path: "/src/a.ts" },
                output: "ok",
                metadata,
              },
            },
          ],
        },
      ]),
    )

    const msgs = await api.listMessages("ses1")
    expect(msgs).toHaveLength(1)
    const part = msgs[0]!.parts[0]!
    expect(part.type).toBe("tool")
    expect(part).toMatchObject({
      name: "edit",
      state: { status: "completed", metadata },
    })
  })

  it("tool parts without metadata stay metadata-free (no invented key)", async () => {
    mockRequest.mockResolvedValue(
      okBody([
        {
          type: "assistant",
          id: "msg2",
          sessionID: "ses1",
          time: { created: 456 },
          content: [
            {
              type: "tool",
              id: "part2",
              name: "shell",
              executed: true,
              state: { status: "completed", input: { command: "ls" } },
            },
          ],
        },
      ]),
    )

    const msgs = await api.listMessages("ses1")
    const part = msgs[0]!.parts[0]!
    expect(part.type).toBe("tool")
    if (part.type === "tool") {
      expect("metadata" in part.state).toBe(false)
    }
  })
})
