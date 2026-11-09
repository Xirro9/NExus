// Main-area view switcher (SPEC-PHASE3 §1): Chat | Dashboard | Agents |
// History | Projects | System | Settings, plus a permission shield button
// that opens the slide-over drawer from anywhere. The active view is
// persisted to localStorage["nexus.mainView"]; the underline animates 150 ms
// (layoutId shared element), disabled under prefers-reduced-motion.
// VNEXT Phase E2: the sidebar carries the primary destinations (Workspace/
// Operations/System groups); MainTabs stays the fine-grained switcher.

import { motion, useReducedMotion } from "motion/react"
import { ShieldAlert } from "lucide-react"

import { useNexus } from "@/store/nexus"

export type MainView =
  | "chat"
  | "dashboard"
  | "activity"
  | "agents"
  | "history"
  | "projects"
  | "research"
  | "system"
  | "settings"

const TABS: { id: MainView; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "dashboard", label: "Dashboard" },
  { id: "activity", label: "Activity" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "projects", label: "Projects" },
  { id: "research", label: "Research" },
  { id: "system", label: "System" },
  { id: "settings", label: "Settings" },
]

export function MainTabs({
  view,
  onChange,
  onOpenPermissions,
}: {
  view: MainView
  onChange: (v: MainView) => void
  onOpenPermissions(): void
}) {
  const reduceMotion = useReducedMotion()
  const pendingPermissions = useNexus((s) => s.pendingPermissions)
  return (
    <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-border/70 px-4">
      <div
        role="tablist"
        aria-label="Main view"
        className="flex min-w-0 items-end gap-1"
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
                "relative shrink-0 px-3 pb-2.5 pt-2 text-sm transition-colors duration-150 " +
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
      <div className="ml-auto shrink-0 pb-1.5 pl-3">
        <button
          type="button"
          onClick={onOpenPermissions}
          aria-label={
            pendingPermissions > 0
              ? `${pendingPermissions} pending permission request${pendingPermissions === 1 ? "" : "s"}`
              : "Permission inbox — no pending requests"
          }
          className={
            "relative flex size-7 items-center justify-center rounded-md transition-colors duration-150 " +
            (pendingPermissions > 0
              ? "border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")
          }
        >
          <ShieldAlert className="size-4" aria-hidden />
          {pendingPermissions > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] leading-4 font-semibold text-background">
              {pendingPermissions > 9 ? "9+" : pendingPermissions}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
