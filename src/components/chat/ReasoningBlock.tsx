// Collapsible reasoning part (Phase C designer pass, architect C3): DEFAULT
// COLLAPSED, never auto-expanded — streaming must not force it open (the
// bubble text carries the live content; reasoning is an audit trail). Purely
// manual chevron toggle, height/opacity disclosure, reduced-motion aware.
// Activity mode keeps its inline non-collapsible rendering (InlineReasoning).

import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { ReasoningPart } from "@/lib/opencode/types"
import { ChevronRight } from "lucide-react"

export function ReasoningBlock({
  part,
  streaming,
}: {
  part: ReasoningPart
  streaming: boolean
}) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const completed = part.time?.completed !== undefined

  return (
    <div className="border-l border-accent/30 pl-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded py-0.5 text-xs italic text-muted-foreground transition-colors duration-150 hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "size-3 transition-transform duration-150 " + (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <span className="font-mono text-[10px] tracking-wider uppercase italic">
          {completed ? "Reasoning" : "Reasoning…"}
        </span>
        {streaming && !completed && (
          <span className="nexus-live size-1 rounded-full bg-accent/80" aria-hidden />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <p className="pt-1.5 text-[13px] leading-relaxed italic whitespace-pre-wrap text-muted-foreground">
              {part.text}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
