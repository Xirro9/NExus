// Main-area view switcher: Chat | Dashboard (SPEC-PHASE2 §6).
// Charts need ≥ 700 px width — the 260 px rail cannot host them. The active
// view is persisted to localStorage["nexus.mainView"]; the underline animates
// 150 ms (layoutId shared element), disabled under prefers-reduced-motion.

import { motion, useReducedMotion } from "motion/react"

export type MainView = "chat" | "dashboard"

const TABS: { id: MainView; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "dashboard", label: "Dashboard" },
]

export function MainTabs({
  view,
  onChange,
}: {
  view: MainView
  onChange: (v: MainView) => void
}) {
  const reduceMotion = useReducedMotion()
  return (
    <div
      role="tablist"
      aria-label="Main view"
      className="flex h-11 shrink-0 items-end gap-1 border-b border-border/70 px-4"
    >
      {TABS.map((tab) => {
        const active = view === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={
              "relative px-3 pb-2.5 pt-2 text-sm transition-colors duration-150 " +
              (active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {tab.label}
            {active &&
              (reduceMotion ? (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
              ) : (
                <motion.span
                  layoutId="main-tab-underline"
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
                  transition={{ duration: 0.15, ease: "easeOut" }}
                />
              ))}
          </button>
        )
      })}
    </div>
  )
}
