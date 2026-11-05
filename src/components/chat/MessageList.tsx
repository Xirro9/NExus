// Scroll container with pin-to-bottom + "new activity" pill (§8).
// New messages rise in subtly (skipped under prefers-reduced-motion).

import { useCallback, useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import type { ChatMessage } from "@/lib/opencode/types"
import { ArrowDown } from "lucide-react"
import { MessageBubble } from "./MessageBubble"

const PIN_THRESHOLD_PX = 80

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const reduced = useReducedMotion()

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }, [])

  // track whether the user is pinned to the bottom (checked BEFORE deltas land)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const pinned =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }, [])

  // autoscroll on new content iff pinned
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [messages, scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-5"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground/80">
              Nothing here yet — say hi to Jerry.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3.5 pb-1">
            {messages.map((m, i) => (
              // only the newest bubble animates — no mass entrance on session switch
              <motion.div
                key={m.id}
                initial={i === messages.length - 1 && !reduced ? { opacity: 0, y: 6 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              >
                <MessageBubble message={m} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            pinnedRef.current = true
            setShowJump(false)
            scrollToBottom(true)
          }}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-lg shadow-black/30 transition-colors hover:border-primary/40"
        >
          <ArrowDown className="size-3.5 text-primary" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  )
}
