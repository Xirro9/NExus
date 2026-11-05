// Shared session-control behavior for the Agents tab (P0): the context menu,
// the confirmation dialog, and the actual stop/terminate/delete dispatch.
// Every destructive path goes through a ConfirmDialog that lists exactly the
// affected sessions; results are reported by the store actions via toasts —
// this layer never invents success.

import { useCallback, useMemo, useState } from "react"
import {
  ArrowRight,
  Ban,
  Copy,
  MessageSquare,
  Square,
  Trash2,
} from "lucide-react"

import {
  DEFAULT_PRIORITY,
  SESSION_PRIORITIES,
  type SessionPriority,
} from "@/lib/sessionPriority"
import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"

import {
  ConfirmDialog,
  type AffectedSession,
} from "@/components/ui/ConfirmDialog"
import {
  SessionMenu,
  type SessionMenuEntry,
} from "@/components/ui/SessionMenu"

/** Everything the actions need about one session, snapshotted at menu-open. */
export interface SessionTarget {
  id: string
  title: string
  running: boolean
  priority: SessionPriority
  /** child session ids that cascade on delete (from the sessions map) */
  childIds: string[]
}

interface MenuState {
  x: number
  y: number
  target: SessionTarget
  withInspect: boolean
}

interface ConfirmState {
  kind: "stop" | "delete"
  mode: "interrupt" | "terminate"
  targets: SessionTarget[]
}

export function useSessionActions({
  onOpenSession,
  onInspect,
}: {
  onOpenSession(id: string): void
  onInspect?(id: string): void
}) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [busy, setBusy] = useState(false)

  const closeMenu = useCallback(() => setMenu(null), [])

  /** Build a target from the live stores (children resolved fresh). */
  const makeTarget = useCallback((id: string): SessionTarget | null => {
    const s = useNexus.getState()
    const session = s.sessions[id]
    if (!session) return null
    const activeMap = useWorkspace.getState().activeMap
    return {
      id,
      title: session.title || "Untitled session",
      running:
        s.busy[id] === true || (activeMap ? activeMap[id] !== undefined : false),
      priority: s.priorities[id] ?? DEFAULT_PRIORITY,
      childIds: Object.values(s.sessions)
        .filter((x) => x.parentID === id)
        .map((x) => x.id),
    }
  }, [])

  const openMenu = useCallback(
    (
      e: { clientX: number; clientY: number; preventDefault(): void },
      id: string,
      withInspect = true,
    ) => {
      e.preventDefault()
      const target = makeTarget(id)
      if (!target) return
      setMenu({ x: e.clientX, y: e.clientY, target, withInspect })
    },
    [makeTarget],
  )

  const requestStop = useCallback(
    (ids: string[], mode: "interrupt" | "terminate") => {
      const targets = ids
        .map((id) => makeTarget(id))
        .filter((t): t is SessionTarget => t !== null)
      if (targets.length === 0) return
      setConfirm({ kind: "stop", mode, targets })
    },
    [makeTarget],
  )

  const requestDelete = useCallback(
    (ids: string[]) => {
      // expand cascading children so the dialog shows the true blast radius
      const byId = new Map<string, SessionTarget>()
      for (const id of ids) {
        const t = makeTarget(id)
        if (!t) continue
        byId.set(id, t)
        for (const childId of t.childIds) {
          if (!byId.has(childId)) {
            const c = makeTarget(childId)
            if (c) byId.set(childId, c)
          }
        }
      }
      if (byId.size === 0) return
      setConfirm({
        kind: "delete",
        mode: "interrupt",
        targets: [...byId.values()],
      })
    },
    [makeTarget],
  )

  const copySessionId = useCallback((id: string) => {
    const done = () =>
      useNexus.setState({
        toast: { kind: "info", text: `Session ID copied — …${id.slice(-6)}` },
      })
    const fallbackCopy = () => {
      try {
        const ta = document.createElement("textarea")
        ta.value = id
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        ta.remove()
        done()
      } catch {
        useNexus.setState({
          toast: { kind: "error", text: "Copy failed — select the ID manually" },
        })
      }
    }
    navigator.clipboard?.writeText(id).then(done, fallbackCopy)
  }, [])

  /** Menu entries for the currently open menu's target. */
  const menuEntries: SessionMenuEntry[] | null = useMemo(() => {
    if (!menu) return null
    const t = menu.target
    const top: SessionMenuEntry[] = []
    if (menu.withInspect && onInspect) {
      top.push({
        label: "Inspect agent",
        icon: ArrowRight,
        onSelect: () => onInspect(t.id),
      })
    }
    top.push({
      label: "Open conversation",
      icon: MessageSquare,
      onSelect: () => onOpenSession(t.id),
    })
    const priorityGroup: SessionMenuEntry = {
      heading: "Priority (organizational)",
      items: SESSION_PRIORITIES.map((p) => ({
        label: p[0]!.toUpperCase() + p.slice(1),
        checked: p === t.priority,
        onSelect: () => useNexus.getState().setSessionPriority(t.id, p),
      })),
    }
    const controls: SessionMenuEntry[] = [
      {
        label: "Stop execution",
        icon: Ban,
        disabled: !t.running,
        separatorBefore: true,
        onSelect: () => requestStop([t.id], "interrupt"),
      },
      {
        label: "End session (stop + drop queued)",
        icon: Square,
        disabled: !t.running,
        onSelect: () => requestStop([t.id], "terminate"),
      },
      {
        label:
          t.childIds.length > 0
            ? `Delete session (+${t.childIds.length} child)…`
            : "Delete session…",
        icon: Trash2,
        destructive: true,
        onSelect: () => requestDelete([t.id]),
      },
      {
        label: "Copy session ID",
        icon: Copy,
        separatorBefore: true,
        onSelect: () => copySessionId(t.id),
      },
    ]
    return [...top, priorityGroup, ...controls]
  }, [menu, onInspect, onOpenSession, requestStop, requestDelete, copySessionId])

  const cancelConfirm = useCallback(() => {
    if (!busy) setConfirm(null)
  }, [busy])

  const executeConfirm = useCallback(async () => {
    if (!confirm || busy) return
    setBusy(true)
    try {
      if (confirm.kind === "delete") {
        // sequential — gentle on the server; parent deletes cascade anyway
        for (const t of confirm.targets) {
          await useNexus.getState().deleteSession(t.id)
        }
      } else {
        for (const t of confirm.targets) {
          await useNexus.getState().stopSession(t.id, confirm.mode)
        }
        // refresh the server-truth active map right away so running dots
        // don't linger until the next 5 s poll
        void useWorkspace.getState().refreshActiveMap()
      }
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }, [confirm, busy])

  const confirmView = useMemo(() => {
    if (!confirm) return null
    if (confirm.kind === "delete") {
      const cascaded = confirm.targets.filter((t) => t.childIds.length > 0)
      const affected: AffectedSession[] = confirm.targets.map((t) => ({
        id: t.id,
        title: t.title,
        detail:
          t.childIds.length > 0
            ? `parent · cascades ${t.childIds.length} child`
            : `…${t.id.slice(-6)}`,
      }))
      return {
        title:
          confirm.targets.length === 1
            ? "Delete this session?"
            : `Delete ${confirm.targets.length} sessions?`,
        body:
          cascaded.length > 0
            ? "Deletion is permanent and removes the full conversation history. Parent sessions cascade to their child sessions."
            : "Deletion is permanent and removes the full conversation history. This cannot be undone.",
        affected,
        confirmLabel:
          confirm.targets.length === 1
            ? "Delete session"
            : `Delete ${confirm.targets.length} sessions`,
        destructive: true,
      }
    }
    const affected: AffectedSession[] = confirm.targets.map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.running ? "running" : `…${t.id.slice(-6)}`,
    }))
    const multi = confirm.targets.length > 1
    return {
      title: multi
        ? `End ${confirm.targets.length} sessions?`
        : "End this session?",
      body:
        confirm.mode === "interrupt"
          ? "Stops the active generation. Conversation history is preserved."
          : "Stops the active generation and drops any queued prompts. Conversation history is preserved.",
      affected,
      confirmLabel: multi
        ? `End ${confirm.targets.length} sessions`
        : "End session",
      destructive: true,
    }
  }, [confirm])

  const menuView =
    menu && menuEntries ? { x: menu.x, y: menu.y, entries: menuEntries } : null

  const overlays =
    menuView || confirmView ? (
      <>
        {menuView && (
          <SessionMenu
            x={menuView.x}
            y={menuView.y}
            entries={menuView.entries}
            onClose={closeMenu}
          />
        )}
        {confirmView && (
          <ConfirmDialog
            open
            title={confirmView.title}
            body={confirmView.body}
            affected={confirmView.affected}
            confirmLabel={confirmView.confirmLabel}
            destructive={confirmView.destructive}
            busy={busy}
            onConfirm={() => void executeConfirm()}
            onCancel={cancelConfirm}
          />
        )}
      </>
    ) : null

  return {
    openMenu,
    requestStop,
    requestDelete,
    copySessionId,
    closeMenu,
    overlays,
  }
}
