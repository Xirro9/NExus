// "New project" dialog (Projects tab). Structure follows ui/ConfirmDialog.tsx
// (overlay + centered card + window-level Escape). Pure UI: live inline
// validation comes from the pure helpers in lib/projectName.ts; creation goes
// through the store action, which re-validates and toasts. A null result is a
// failure that was ALREADY toasted — the dialog stays open so the fields can
// be fixed. No animation-library additions; motion usage matches ConfirmDialog
// and the global reduced-motion clamp in index.css covers transitions.

import { useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"

import { useNexus } from "@/store/nexus"
import { joinProjectPath, sanitizeProjectName } from "@/lib/projectName"

export function NewProjectDialog({
  open,
  defaultParent,
  onClose,
  onOpenSession,
}: {
  open: boolean
  /** Prefill for the parent-directory field (most recently active project's parent). */
  defaultParent: string
  onClose(): void
  /** Existing AppShell mechanism: open a session in the Chat tab. */
  onOpenSession(sessionId: string): void
}) {
  const createProject = useNexus((s) => s.createProject)

  const nameRef = useRef<HTMLInputElement>(null)
  const reduceMotion = useReducedMotion()

  const [name, setName] = useState("")
  const [parent, setParent] = useState(defaultParent)
  const [openSession, setOpenSession] = useState(true)
  const [nameDirty, setNameDirty] = useState(false)
  const [parentDirty, setParentDirty] = useState(false)
  const [pending, setPending] = useState(false)

  // fresh fields + initial focus on the name input every time it opens.
  // Deps are [open] ONLY: defaultParent/onClose change identity on every
  // ProjectsView render (SSE refetch markers) and re-running this effect
  // mid-edit would wipe the fields the user is typing. The closure captures
  // the prefill as of the open transition — exactly what we want.
  useEffect(() => {
    if (!open) return
    setName("")
    setParent(defaultParent)
    setOpenSession(true)
    setNameDirty(false)
    setParentDirty(false)
    setPending(false)
    nameRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefill-on-open only
  }, [open])

  // Escape closes (ConfirmDialog precedent — allowed even while pending; a
  // late success still navigates, a late failure is already toasted).
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // live validation — same helpers the store re-runs, so the dialog and the
  // store can never disagree
  const nameResult = sanitizeProjectName(name)
  let parentError: string | null = null
  let joinedPath: string | null = null
  if (parent.trim() === "") {
    parentError = "Parent directory is required"
  } else {
    try {
      joinedPath = joinProjectPath(
        parent.trim(),
        nameResult.ok ? nameResult.name : "…",
      )
    } catch (err) {
      parentError =
        err instanceof Error ? err.message : "Invalid parent directory"
    }
  }
  const nameError = nameResult.ok ? null : nameResult.reason
  const valid = nameResult.ok && parentError === null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || pending) return
    setPending(true)
    void createProject({
      name: name.trim(),
      parent: parent.trim(),
      openSession,
    }).then((res) => {
      setPending(false)
      if (res === null) return // failure already toasted — keep the dialog open
      onClose()
      if (res.sessionID) onOpenSession(res.sessionID)
      // no sessionID → stay on Projects; the new card arrives via SSE refetch markers
    })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex overscroll-contain items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose()
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        initial={reduceMotion ? false : { scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl shadow-black/50"
      >
        <h2 id="new-project-title" className="text-sm font-semibold">
          New project
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Creates a directory on the host and registers it as a project.
        </p>

        <form onSubmit={submit} className="mt-3 space-y-3">
          <div>
            <label
              htmlFor="new-project-name"
              className="mb-1 block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Name
            </label>
            <input
              ref={nameRef}
              id="new-project-name"
              name="project-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameDirty(true)
              }}
              placeholder="my-project"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={
                nameDirty && !nameResult.ok ? true : undefined
              }
              aria-describedby="new-project-name-status"
              className={
                "h-9 w-full rounded-lg border bg-input/60 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 " +
                (nameDirty && !nameResult.ok
                  ? "border-destructive/60"
                  : "border-border")
              }
            />
            {/* always-mounted polite live region: errors are announced as the
                user types; empty when valid (min-h reserves the row so the
                dialog doesn't jump) */}
            <p
              id="new-project-name-status"
              aria-live="polite"
              className={
                "mt-1 min-h-4 truncate text-[11px] " +
                (nameDirty && !nameResult.ok ? "text-destructive" : "")
              }
            >
              {nameDirty && !nameResult.ok ? nameError : ""}
            </p>
          </div>

          <div>
            <label
              htmlFor="new-project-parent"
              className="mb-1 block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Parent directory
            </label>
            <input
              id="new-project-parent"
              name="project-parent"
              type="text"
              value={parent}
              onChange={(e) => {
                setParent(e.target.value)
                setParentDirty(true)
              }}
              placeholder="/home/you/projects"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={parentDirty && parentError ? true : undefined}
              aria-describedby="new-project-parent-status"
              className={
                "h-9 w-full rounded-lg border bg-input/60 px-3 font-mono text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 " +
                (parentDirty && parentError
                  ? "border-destructive/60"
                  : "border-border")
              }
            />
            {/* one stable live region per field: error first, else the
                joined-path preview (title gives the full path on hover) */}
            <p
              id="new-project-parent-status"
              aria-live="polite"
              title={
                !(parentDirty && parentError) && joinedPath
                  ? joinedPath
                  : undefined
              }
              className={
                "mt-1 min-h-4 truncate text-[11px] " +
                (parentDirty && parentError
                  ? "text-destructive"
                  : joinedPath
                    ? "font-mono text-[10px] text-muted-foreground/70"
                    : "")
              }
            >
              {parentDirty && parentError
                ? parentError
                : joinedPath
                  ? `→ ${joinedPath}`
                  : ""}
            </p>
          </div>

          <label
            htmlFor="new-project-open-session"
            className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          >
            <input
              id="new-project-open-session"
              type="checkbox"
              checked={openSession}
              onChange={(e) => setOpenSession(e.target.checked)}
              disabled={pending}
              className="accent-[var(--primary)]"
            />
            Open a session in it
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || pending}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  )
}
