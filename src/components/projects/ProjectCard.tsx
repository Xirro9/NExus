// One project card (SPEC-PHASE3 §7): canonical path, last-active, vcs,
// sandboxes count, recent-loaded session count; expands to recent root
// sessions + the worktree section. No create/delete affordances anywhere.

import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronRight, ExternalLink } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useWorkspace } from "@/store/workspace"
import type { ProjectInfo, SessionInfo } from "@/lib/opencode/types"

import { GraphifyPanel } from "./GraphifyPanel"
import { WorktreeList } from "./WorktreeList"

function relativeTime(ts: number | undefined): string {
  if (!ts) return "—"
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ProjectCard({
  project,
  onBrowseAll,
}: {
  project: ProjectInfo
  onBrowseAll(projectId: string): void
}) {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<SessionInfo[] | null>(null)
  const [recentError, setRecentError] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()
  const sessionCount = useNexus(
    (s) =>
      s.sessionOrder.filter((id) => s.sessions[id]?.projectID === project.id)
        .length,
  )
  const loadRecentSessions = useWorkspace((s) => s.loadRecentSessions)

  const toggle = () => {
    const next = !open
    setOpen(next)
    // lazily fetch recent ROOT sessions on first expand (single-slot budget)
    if (next && recent === null && !recentError) {
      loadRecentSessions(project.id)
        .then((sessions) => setRecent(sessions))
        .catch((err) =>
          setRecentError(err instanceof Error ? err.message : String(err)),
        )
    }
  }

  return (
    <div className="rounded-xl border border-border/70 bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full px-4 py-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronRight
              className={
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 " +
                (open ? "rotate-90" : "")
              }
              aria-hidden
            />
            <span className="truncate font-mono text-[13px]" title={project.canonical}>
              {project.name || project.canonical}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
            {sessionCount} recent (loaded)
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-5 font-mono text-[10px] text-muted-foreground">
          <span title={project.canonical}>{project.canonical}</span>
          <span>· last active {relativeTime(project.time.active)}</span>
          {project.vcs != null && <span>· vcs</span>}
          {project.sandboxes && project.sandboxes.length > 0 && (
            <span className="rounded border border-border/60 px-1">
              {project.sandboxes.length} sandbox{project.sandboxes.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="project-card-body"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="border-t border-border/60 px-4 py-3">
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Recent sessions
            </h4>
            <button
              type="button"
              onClick={() => onBrowseAll(project.id)}
              className="flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
            >
              Browse all
              <ExternalLink className="size-3" aria-hidden />
            </button>
          </div>
          {recentError ? (
            <p className="text-[11px] text-destructive">
              Failed to load recent sessions.
            </p>
          ) : recent === null ? (
            <div className="space-y-1.5 py-0.5" aria-hidden>
              <div className="h-2.5 w-3/5 animate-pulse rounded bg-muted" />
              <div className="h-2.5 w-2/5 animate-pulse rounded bg-muted" />
            </div>
          ) : recent.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/80">
              No root sessions.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {recent.map((s) => (
                <li
                  key={s.id}
                  className="flex items-baseline justify-between gap-2 text-[11px]"
                >
                  <span className="min-w-0 truncate">{s.title || "Untitled session"}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                    …{s.id.slice(-6)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <WorktreeList projectID={project.id} />
          <GraphifyPanel projectID={project.id} cwd={project.canonical} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
