// Collapsible reasoning part: auto-open while streaming, auto-collapse when
// time.completed arrives — unless the user manually toggled (§8).

import { useEffect, useRef, useState } from "react"

import type { ReasoningPart } from "@/lib/opencode/types"
import { ChevronRight } from "lucide-react"

export function ReasoningBlock({
  part,
  streaming,
}: {
  part: ReasoningPart
  streaming: boolean
}) {
  const [open, setOpen] = useState(streaming)
  const manual = useRef(false)

  // auto-open while streaming
  useEffect(() => {
    if (streaming && !manual.current) setOpen(true)
  }, [streaming])

  // auto-collapse on completion (unless the user toggled)
  const completed = part.time?.completed !== undefined
  useEffect(() => {
    if (completed && !manual.current) setOpen(false)
  }, [completed])

  return (
    <div className="border-l-2 border-accent/40 pl-3">
      <button
        type="button"
        onClick={() => {
          manual.current = true
          setOpen((o) => !o)
        }}
        className="flex items-center gap-1 rounded text-xs italic text-muted-foreground transition-colors duration-150 hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "size-3 transition-transform duration-150 " + (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        {completed ? "Reasoned" : "Reasoning…"}
      </button>
      {open && (
        <p className="mt-1.5 text-[13px] leading-relaxed italic whitespace-pre-wrap text-muted-foreground">
          {part.text}
        </p>
      )}
    </div>
  )
}
