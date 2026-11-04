// Tool call row: icon, mono name, status chip; click expands input/output JSON.

import { useState } from "react"

import type { ToolPart } from "@/lib/opencode/types"
import { Check, ChevronRight, Terminal, TriangleAlert, Wrench } from "lucide-react"

function StatusChip({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="rounded-full border border-primary/40 px-1.5 py-0.5 font-mono text-[10px] text-primary">
        running…
      </span>
    )
  }
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/40 px-1.5 py-0.5 font-mono text-[10px] text-success">
        <Check className="h-2.5 w-2.5" aria-hidden /> done
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
        <TriangleAlert className="h-2.5 w-2.5" aria-hidden /> failed
      </span>
    )
  }
  return (
    <span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {status}
    </span>
  )
}

export function ToolPartCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const Icon =
    part.name === "shell" || part.name === "bash"
      ? Terminal
      : Wrench
  return (
    <div className="rounded-lg border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {part.name}
        </span>
        <StatusChip status={part.state.status} />
      </button>
      {open && (
        <div className="space-y-1.5 px-2.5 pb-2.5">
          {part.state.input !== undefined && (
            <pre className="max-h-48 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(part.state.input, null, 2)}
            </pre>
          )}
          {part.state.output !== undefined && (
            <pre className="max-h-64 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(part.state.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
