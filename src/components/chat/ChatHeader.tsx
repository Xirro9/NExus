// Session title, run-state chip (real activity telemetry, C2), agent/model
// mono chips, Conversation/Activity view toggle, interrupt button while busy.

import type { SessionInfo } from "@/lib/opencode/types"
import type { AgentRunState } from "@/lib/agentState"
import type { ChatViewMode } from "@/store/nexus"
import { motion, useReducedMotion } from "motion/react"
import { Square } from "lucide-react"

const VIEW_MODES: { value: ChatViewMode; label: string }[] = [
  { value: "conversation", label: "Chat" },
  { value: "activity", label: "Activity" },
]

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: ChatViewMode
  onChange(mode: ChatViewMode): void
}) {
  const reduced = useReducedMotion()
  return (
    <div
      role="group"
      aria-label="Chat view mode"
      className="inline-flex shrink-0 rounded-lg border border-border/80 bg-card/60 p-0.5"
    >
      {VIEW_MODES.map((m) => {
        const active = viewMode === m.value
        return (
          <button
            key={m.value}
            type="button"
            aria-pressed={active}
            aria-label={`${m.label} view`}
            onClick={() => onChange(m.value)}
            className={
              "relative rounded-md px-2.5 py-1 text-[11px] leading-none transition-colors duration-150 " +
              (active
                ? "font-medium text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {active && (
              <motion.span
                layoutId="chat-view-pill"
                aria-hidden
                className="absolute inset-0 rounded-md bg-secondary shadow-sm shadow-black/20"
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", bounce: 0.18, duration: 0.32 }
                }
              />
            )}
            <span className="relative z-10">{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Live execution indicator — only the active run states, real data only. */
const RUN_CHIP_LABEL: Partial<Record<AgentRunState, string>> = {
  generating: "generating",
  "executing-tools": "running",
  "awaiting-permission": "permission",
}

function RunStateChip({
  runState,
  currentTool,
}: {
  runState: AgentRunState
  currentTool: string | null
}) {
  const label = RUN_CHIP_LABEL[runState]
  if (!label) return null
  // permission asks break the cyan "live" language — amber reads as "Jerry
  // is blocked on you", distinct from the working states
  const tone =
    runState === "awaiting-permission"
      ? "border-warning/50 bg-warning/10 text-warning"
      : "border-primary/40 bg-primary/5 text-primary"
  return (
    <span
      className={
        "nexus-dots inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none " +
        tone
      }
    >
      {currentTool && runState === "executing-tools" ? currentTool : label}
    </span>
  )
}

export function ChatHeader({
  session,
  busy,
  runState,
  currentTool,
  viewMode,
  onViewModeChange,
  onInterrupt,
}: {
  session: SessionInfo | null
  busy: boolean
  /** live activity state for the header chip (C2) */
  runState?: AgentRunState
  currentTool?: string | null
  viewMode: ChatViewMode
  onViewModeChange(mode: ChatViewMode): void
  onInterrupt(): void
}) {
  return (
    <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
        {session?.title || "Untitled session"}
      </h1>
      {runState && currentTool !== undefined && (
        <RunStateChip runState={runState} currentTool={currentTool} />
      )}
      {session?.agent && (
        <span className="hidden shrink-0 rounded-full border border-border bg-card/60 px-2 py-0.5 text-[11px] leading-none text-muted-foreground md:inline">
          {session.agent}
        </span>
      )}
      {session?.model && (
        <span className="hidden shrink-0 rounded-full border border-border bg-card/60 px-2 py-0.5 font-mono text-[11px] leading-none text-muted-foreground sm:inline">
          {session.model.id}
        </span>
      )}
      <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} />
      {busy && (
        <button
          type="button"
          onClick={onInterrupt}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/50 px-2.5 py-1 text-xs text-destructive transition-colors duration-150 hover:bg-destructive/10"
        >
          <Square className="size-3" aria-hidden />
          Interrupt
        </button>
      )}
    </header>
  )
}
