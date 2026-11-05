// Lightweight context menu for session/agent rows and graph nodes (P0
// session control). Hand-rolled: fixed-position card, outside-click/Escape
// close, arrow-key navigation, role="menu" semantics. Flips upward/leftward
// near viewport edges. Deliberately tiny — radix menu primitives would be
// overkill for a single flat list + one labeled group.

import { useEffect, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent } from "react"
import type { LucideIcon } from "lucide-react"

export interface SessionMenuItem {
  label: string
  icon?: LucideIcon
  onSelect(): void
  disabled?: boolean
  destructive?: boolean
  /** render a thin separator above this item */
  separatorBefore?: boolean
  /** show a check mark (priority picker) */
  checked?: boolean
}

/** Labeled group header inside the menu (e.g. "Priority"). */
export interface SessionMenuGroup {
  heading: string
  items: SessionMenuItem[]
}

export type SessionMenuEntry = SessionMenuItem | SessionMenuGroup

function isGroup(e: SessionMenuEntry): e is SessionMenuGroup {
  return "heading" in e
}

const MENU_W = 208

export function SessionMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number
  y: number
  entries: SessionMenuEntry[]
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // flat list of focusable buttons for arrow-key roving focus
  const [focusIdx, setFocusIdx] = useState(-1)
  const flat: SessionMenuItem[] = []
  for (const e of entries) {
    if (isGroup(e)) flat.push(...e.items)
    else flat.push(e)
  }

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("resize", onScroll)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("resize", onScroll)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [onClose])

  // clamp + flip: measure once mounted
  const [pos, setPos] = useState<CSSProperties>(() => ({
    left: x,
    top: y,
    visibility: "hidden",
  }))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const w = MENU_W
    let left = x
    let top = y
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w)
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h)
    setPos({ left, top, visibility: "visible" })
    // focus the first enabled item for keyboard users
    const first = el.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    )
    first?.focus()
  }, [x, y])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setFocusIdx((prev) => {
        const dir = e.key === "ArrowDown" ? 1 : -1
        let i = prev
        for (let n = 0; n < flat.length; n++) {
          i = (i + dir + flat.length) % flat.length
          if (!flat[i].disabled) return i
        }
        return prev
      })
    }
  }

  let flatIdx = -1
  const renderItems = (items: SessionMenuItem[]) =>
    items.map((item, i) => {
      flatIdx++
      const idx = flatIdx
      const Icon = item.icon
      return (
        <button
          key={`${item.label}-${i}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          tabIndex={focusIdx === idx ? 0 : -1}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
          className={
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-100 " +
            (item.disabled
              ? "cursor-not-allowed text-muted-foreground/40"
              : item.destructive
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground hover:bg-secondary/70") +
            (focusIdx === idx ? " bg-secondary/70 outline-none" : "")
          }
        >
          {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.checked && (
            <span aria-hidden className="text-[10px] text-primary">
              ✓
            </span>
          )}
        </button>
      )
    })

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Session actions"
      onKeyDown={onKeyDown}
      style={{ width: MENU_W, ...pos }}
      className="fixed z-50 rounded-xl border border-border bg-popover p-1 shadow-xl shadow-black/40"
    >
      {entries.map((entry, i) =>
        isGroup(entry) ? (
          <div key={entry.heading} role="group" aria-label={entry.heading}>
            {i > 0 && <div className="mx-1 my-1 h-px bg-border/70" />}
            <p className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold tracking-wider text-muted-foreground uppercase">
              {entry.heading}
            </p>
            {renderItems(entry.items)}
          </div>
        ) : (
          <div key={entry.label}>
            {entry.separatorBefore && i > 0 && (
              <div className="mx-1 my-1 h-px bg-border/70" />
            )}
            {renderItems([entry])}
          </div>
        ),
      )}
    </div>
  )
}
