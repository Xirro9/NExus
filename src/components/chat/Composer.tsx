// Textarea composer: Enter = send, Shift+Enter = newline, slash detection,
// busy swaps send → interrupt (§8). Slash commands route to the store.

import { useEffect, useRef, useState } from "react"

import { useNexus } from "@/store/nexus"
import { SendHorizontal, Square } from "lucide-react"
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu"

const MAX_TEXTAREA_PX = 160 // matches max-h-40

export function Composer({
  disabled,
  busy,
  onSend,
  onInterrupt,
}: {
  disabled: boolean
  busy: boolean
  onSend(text: string): void
  onInterrupt(): void
}) {
  const [value, setValue] = useState("")
  const textRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<SlashMenuHandle>(null)
  const commands = useNexus((s) => s.commands)

  // "/" followed by an identifier → menu open
  const slashMatch = /^\/([a-zA-Z0-9_-]*)(?:\s(.*))?$/s.exec(value)
  const menuOpen = slashMatch !== null && !value.includes("\n")

  // auto-grow up to max-h
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_PX) + "px"
  }, [value])

  const send = () => {
    const text = value.trim()
    if (!text) return
    if (menuOpen && slashMatch) {
      const name = slashMatch[1] ?? ""
      const rest = slashMatch[2] ?? ""
      const known = commands.some(
        (c) => c.name.toLowerCase() === name.toLowerCase(),
      )
      if (!known) return // unknown command: Enter sends nothing (§9)
      void useNexus.getState().sendSlashCommand(name, rest)
      setValue("")
      return
    }
    onSend(text)
    setValue("")
  }

  return (
    <div className="relative mx-auto max-w-3xl">
      {menuOpen && slashMatch && (
        <SlashMenu
          ref={menuRef}
          query={slashMatch[1] ?? ""}
          rest={slashMatch[2] ?? ""}
          commands={commands}
          onPick={(name, rest) => {
            void useNexus.getState().sendSlashCommand(name, rest)
            setValue("")
            textRef.current?.focus()
          }}
          onClose={() => setValue("")}
        />
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 transition-colors duration-150 focus-within:border-ring/40 focus-within:shadow-[var(--glow-primary)]">
        <textarea
          ref={textRef}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                menuRef.current?.move(1)
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                menuRef.current?.move(-1)
                return
              }
              if (e.key === "Tab") {
                e.preventDefault()
                menuRef.current?.confirm()
                return
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                menuRef.current?.confirm()
                return
              }
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          placeholder={busy ? "Assistant is running…" : "Message OpenCode… (/ for commands)"}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground/60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/50 text-destructive transition-colors duration-150 hover:bg-destructive/10 active:scale-95"
            aria-label="Interrupt"
          >
            <Square className="size-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={disabled || value.trim() === ""}
            className={
              "inline-flex size-9 shrink-0 items-center justify-center rounded-lg transition-all duration-150 active:scale-95 disabled:opacity-40 " +
              (disabled || value.trim() === ""
                ? "bg-primary text-primary-foreground"
                : "bg-primary text-primary-foreground shadow-[var(--glow-primary)] hover:bg-primary/90")
            }
            aria-label="Send"
          >
            <SendHorizontal className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
