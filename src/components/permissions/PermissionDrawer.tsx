// Permission inbox slide-over (SPEC-PHASE3 §5). Overlays any view; never
// blocks SSE/chat. Replies are event-driven only — the drawer renders the
// nexus permissionRequests list and never initiates a reply itself; every
// decision passes through PermissionCard's explicit click handlers.

import { useEffect, useRef } from "react"
import { AnimatePresence, motion } from "motion/react"
import { X } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { usePermissionRequests } from "@/store/selectors"
import type { PermissionReply } from "@/lib/opencode/types"

import { PermissionCard } from "./PermissionCard"

function isFocusable(el: Element): boolean {
  return (
    el instanceof HTMLElement &&
    !el.hasAttribute("disabled") &&
    el.tabIndex >= 0 &&
    el.offsetParent !== null
  )
}

export function PermissionDrawer({
  open,
  onClose,
}: {
  open: boolean
  onClose(): void
}) {
  const requests = usePermissionRequests()
  const sessions = useNexus((s) => s.sessions)
  const panelRef = useRef<HTMLDivElement>(null)

  // populate on open (event-driven refetch keeps it fresh while open)
  useEffect(() => {
    if (open) void useNexus.getState().refreshPermissions()
  }, [open])

  // Esc closes + minimal focus trap
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== "Tab") return
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter(isFocusable)
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    panel.addEventListener("keydown", onKey)
    return () => panel.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const reply = (requestID: string, sessionID: string) => (
    decision: PermissionReply,
  ) => {
    // the ONLY reply path in the UI → nexus.replyPermission (single call site)
    void useNexus.getState().replyPermission(sessionID, requestID, decision)
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="permission-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-background/60"
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            key="permission-drawer"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Permission requests"
            initial={{ x: 440 }}
            animate={{ x: 0 }}
            exit={{ x: 440 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-[92vw] flex-col border-l border-border bg-sidebar shadow-2xl shadow-black/50"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                Permission requests
                <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {requests.length}
                </span>
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close permission inbox"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {requests.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">
                    No pending requests — agents run freely within their rules.
                  </p>
                </div>
              ) : (
                requests.map((req) => (
                  <PermissionCard
                    key={req.id}
                    request={req}
                    sessionTitle={sessions[req.sessionID]?.title ?? req.sessionID}
                    onReply={reply(req.id, req.sessionID)}
                  />
                ))
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
