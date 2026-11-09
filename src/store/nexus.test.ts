// Store tests for createProject (new-project backend). The transport is
// mocked at the module boundary — same precedent as client.test.ts; the real
// client.ts + store run on top of it. vi.hoisted stubs `window` first: the
// store's dev-only debug handle touches it at module scope and vitest runs
// with import.meta.env.DEV = true in node.

import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockRequest, mockCreateDir } = vi.hoisted(() => {
  ;(globalThis as unknown as Record<string, unknown>).window = globalThis
  return { mockRequest: vi.fn(), mockCreateDir: vi.fn() }
})

vi.mock("@/lib/transport", () => ({
  isTauri: () => false,
  transport: { request: mockRequest, createDir: mockCreateDir },
}))

import { useNexus } from "./nexus"

function okBody(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    bodyText: JSON.stringify(body),
  }
}

describe("createProject", () => {
  beforeEach(() => {
    mockRequest.mockReset()
    mockCreateDir.mockReset()
    useNexus.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      messages: {},
      toast: null,
    })
  })

  it("rejects an invalid name before any transport call", async () => {
    const res = await useNexus.getState().createProject({
      name: "a/b",
      parent: "/tmp/projects",
      openSession: false,
    })
    expect(res).toBeNull()
    expect(mockCreateDir).not.toHaveBeenCalled()
    const t = useNexus.getState().toast
    expect(t?.kind).toBe("error")
    expect(t?.text).toContain("separator")
  })

  it("rejects a non-absolute parent before any transport call", async () => {
    const res = await useNexus.getState().createProject({
      name: "proj",
      parent: "relative/path",
      openSession: false,
    })
    expect(res).toBeNull()
    expect(mockCreateDir).not.toHaveBeenCalled()
    expect(useNexus.getState().toast?.kind).toBe("error")
  })

  it("creates the dir and opens a session on success", async () => {
    mockCreateDir.mockResolvedValue({ path: "/tmp/projects/proj", existed: false })
    mockRequest.mockResolvedValue(
      okBody({ data: { id: "ses_new", projectID: "proj_x" } }),
    )

    const res = await useNexus.getState().createProject({
      name: "proj",
      parent: "/tmp/projects",
      openSession: true,
    })

    expect(res).toEqual({ sessionID: "ses_new", path: "/tmp/projects/proj" })
    expect(mockCreateDir).toHaveBeenCalledWith("/tmp/projects/proj")
    const [pathArg, initArg] = mockRequest.mock.calls[0] as [string, {
      method?: string
      body?: string
    }]
    expect(pathArg).toBe("/api/session")
    expect(initArg.method).toBe("POST")
    expect(JSON.parse(initArg.body ?? "{}")).toEqual({
      location: { directory: "/tmp/projects/proj" },
    })
    const s = useNexus.getState()
    expect(s.activeSessionId).toBe("ses_new")
    expect(s.sessionOrder).toContain("ses_new")
    expect(s.messages["ses_new"]).toEqual([])
    expect(s.toast?.kind).toBe("info")
  })

  it("schedules a projects refetch after success", async () => {
    // The server emits no project.updated for a new-session directory, so
    // createProject must schedule its own refetch. scheduleRefetch debounces
    // 500ms and only fires while online — fake timers make that deterministic
    // in the node test env.
    vi.useFakeTimers()
    try {
      useNexus.setState({
        connection: { ...useNexus.getState().connection, status: "online" },
      })
      mockCreateDir.mockResolvedValue({ path: "/tmp/projects/proj", existed: false })
      mockRequest.mockResolvedValue(okBody([]))

      await useNexus.getState().createProject({
        name: "proj",
        parent: "/tmp/projects",
        openSession: false,
      })
      // debounced — no refetch fires before the 500ms timer elapses
      expect(mockRequest).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)
      expect(mockRequest.mock.calls.some((c) => c[0] === "/api/project")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports an already-existing directory without opening a session", async () => {
    mockCreateDir.mockResolvedValue({ path: "/tmp/projects/proj", existed: true })

    const res = await useNexus.getState().createProject({
      name: "proj",
      parent: "/tmp/projects",
      openSession: false,
    })

    expect(res).toEqual({ path: "/tmp/projects/proj" })
    expect(mockRequest).not.toHaveBeenCalled()
    expect(useNexus.getState().activeSessionId).toBeNull()
    const t = useNexus.getState().toast
    expect(t?.kind).toBe("info")
    expect(t?.text).toContain("already exists")
  })

  it("returns null and toasts when the host mkdir fails", async () => {
    mockCreateDir.mockRejectedValue(new Error("permission denied"))

    const res = await useNexus.getState().createProject({
      name: "proj",
      parent: "/tmp/projects",
      openSession: false,
    })

    expect(res).toBeNull()
    expect(useNexus.getState().toast?.kind).toBe("error")
  })
})
