// Shared dashboard card (SPEC-PHASE2 §7): title + optional right slot, optional
// degraded swap, optional dimming ("charts freeze at last good data, dimmed").

import type { ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { TriangleAlert } from "lucide-react"

export interface PanelCardProps {
  title: string
  right?: ReactNode
  /** dim the body while still rendering it (last-good-data freeze) */
  dim?: boolean
  /** when provided and !ok, the body is swapped for the degraded state */
  degraded?: { ok: boolean; error: string | null; children?: ReactNode }
  children?: ReactNode
}

export function PanelCard({ title, right, dim, degraded, children }: PanelCardProps) {
  const reduceMotion = useReducedMotion()
  const showDegraded = degraded !== undefined && !degraded.ok
  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={
        "rounded-xl border border-border/70 bg-card p-4 " +
        (showDegraded || dim ? "opacity-75" : "")
      }
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </h3>
        {right}
      </header>
      {showDegraded ? (
        degraded.children ?? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            <span>{degraded.error ?? "unavailable"}</span>
          </div>
        )
      ) : (
        children
      )}
    </motion.section>
  )
}

/** "warming up (n samples)" — fewer than 2 samples means no chart yet (§3.4). */
export function Warming({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-primary/70" aria-hidden />
      warming up ({n} sample{n === 1 ? "" : "s"})
    </div>
  )
}
