// One project card (SPEC-PHASE3 §7): canonical path, last-active, vcs,
// sandboxes count, recent-loaded session count; expands to recent root
// sessions + the worktree section. No create/delete affordances anywhere.

import { useState } from "react"
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react"

import { api } from "@/lib/opencode/client"
import { useNexus } from "@/store/nexus"
import type { ProjectInfo, SessionInfo } from "@/lib/opencode/types"

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
  const sessionCount = useNexus(
    (s) =>
      s.sessionOrder.filter((id) => s.sessions[id]?.projectID === project.id)
        .length,
  )

  const toggle = () => {
    const next = !open
    setOpen(next)
    // lazily fetch recent ROOT sessions on first expand (single-slot budget)
    if (next && recent === null && !recentError) {
      api
        .listSessionsQuery({
          project: project.id,
          parentID: "null",
          limit: "10",
          order: "desc",
        })
        .then((res) => setRecent(res.sessions))
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
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
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

      {open && (
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
            <p className="text-[11px] text-muted-foreground/80">Loading…</p>
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
        </div>
      )}
    </div>
  )
}
