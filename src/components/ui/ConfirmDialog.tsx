// Confirmation dialog for destructive session operations (P0). Lists exactly
// which sessions will be affected — the operator must see the blast radius
// before confirming (bulk delete / end-all / cascading parent deletes).

import { useEffect, useRef } from "react"
import { AlertTriangle } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

export interface AffectedSession {
  id: string
  title: string
  /** e.g. "running · 2m" or "child session (cascades)" */
  detail?: string
}

export function ConfirmDialog({
  open,
  title,
  body,
  affected,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: string
  affected: AffectedSession[]
  confirmLabel: string
  destructive: boolean
  busy: boolean
  onConfirm(): void
  onCancel(): void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        initial={reduceMotion ? false : { scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start gap-2.5">
          {destructive && (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        </div>

        {affected.length > 0 && (
          <ul className="mt-3 max-h-44 space-y-0.5 overflow-y-auto rounded-xl border border-border/70 bg-background/60 p-2">
            {affected.map((s) => (
              <li
                key={s.id}
                className="flex items-baseline justify-between gap-2 px-1 text-[11px]"
              >
                <span className="min-w-0 truncate">{s.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {s.detail ?? `…${s.id.slice(-6)}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              "inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 " +
              (destructive
                ? "bg-destructive text-white hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90")
            }
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
