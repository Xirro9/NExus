// Scroll container with pin-to-bottom + "new activity" pill (§8).

import { useCallback, useEffect, useRef, useState } from "react"

import type { ChatMessage } from "@/lib/opencode/types"
import { ArrowDown } from "lucide-react"
import { MessageBubble } from "./MessageBubble"

const PIN_THRESHOLD_PX = 80

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

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
        className="h-full overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No messages yet — say something below.
          </p>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
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
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-xs text-foreground shadow-[var(--glow-primary)]"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          new activity
        </button>
      )}
    </div>
  )
}
