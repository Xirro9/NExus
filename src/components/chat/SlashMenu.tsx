// Command autocomplete popover with internal keyboard-driven selection.
// Composer forwards ArrowUp/Down/Tab/Enter via the imperative handle.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react"

import type { CommandInfo } from "@/lib/opencode/types"

export interface SlashMenuHandle {
  move(delta: 1 | -1): void
  confirm(): boolean // true if a command was picked
}

export const SlashMenu = forwardRef<
  SlashMenuHandle,
  {
    query: string
    /** remainder text after the command token (for keyboard confirm) */
    rest: string
    commands: CommandInfo[]
    onPick(name: string, rest: string): void
    onClose(): void
  }
>(function SlashMenu({ query, rest, commands, onPick, onClose }, ref) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return commands.filter((c) => c.name.toLowerCase().startsWith(q))
  }, [commands, query])

  const [selectedIndex, setSelectedIndex] = useState(0)

  // clamp when the filter result shrinks
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(filtered.length - 1, 0)))
  }, [filtered.length])

  useImperativeHandle(ref, () => ({
    move(delta) {
      setSelectedIndex((i) => {
        if (filtered.length === 0) return 0
        return (i + delta + filtered.length) % filtered.length
      })
    },
    confirm() {
      const cmd = filtered[selectedIndex]
      if (!cmd) return false
      onPick(cmd.name, rest)
      return true
    },
  }))

  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 z-10 mb-2 w-80 rounded-xl border border-border bg-popover p-2.5 text-xs text-muted-foreground shadow-[var(--glow-accent)]">
        Unknown command{" "}
        <span className="font-mono text-foreground">/{query}</span>
      </div>
    )
  }

  return (
    <div
      className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-[var(--glow-accent)]"
      role="listbox"
      aria-label="Slash commands"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => {
            onPick(cmd.name, "")
            onClose()
          }}
          className={
            "block w-full rounded-lg px-2.5 py-1.5 text-left " +
            (i === selectedIndex ? "bg-secondary" : "")
          }
        >
          <span className="font-mono text-xs text-foreground">/{cmd.name}</span>
          {cmd.description && (
            <span className="ml-2 line-clamp-1 text-[11px] text-muted-foreground">
              {cmd.description}
            </span>
          )}
        </button>
      ))}
    </div>
  )
})
