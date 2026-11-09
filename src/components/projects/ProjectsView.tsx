// Projects view (SPEC-PHASE3 §7): project cards with per-project session
// scoping and read-only worktrees. No polling — data comes from the nexus
// projects list (kept fresh by SSE refetch markers). "New project" opens the
// creation dialog (NewProjectDialog); success with a sessionID hands off to
// the shared onOpenSession mechanism (AppShell → Chat), like History/Agents.

import { useState } from "react"
import { Plus } from "lucide-react"

import { useNexus } from "@/store/nexus"

import { NewProjectDialog } from "./NewProjectDialog"
import { ProjectCard } from "./ProjectCard"

export function ProjectsView({
  onBrowseAll,
  onOpenSession,
}: {
  onBrowseAll(projectId: string): void
  onOpenSession(sessionId: string): void
}) {
  const projects = useNexus((s) => s.projects)
  const [createOpen, setCreateOpen] = useState(false)
  // newest-active first
  const sorted = [...projects].sort(
    (a, b) =>
      (b.time.active ?? b.time.updated) - (a.time.active ?? a.time.updated),
  )
  // dialog prefill: parent dir of the most recently active project. "" (no
  // projects yet) → the dialog starts blank and live validation asks for an
  // absolute path.
  const latest = sorted[0]?.canonical
  const defaultParent =
    latest === undefined || latest === "/"
      ? (latest ?? "")
      : latest.lastIndexOf("/") <= 0
        ? "/"
        : latest.slice(0, latest.lastIndexOf("/"))

  return (
    <div className="mx-auto h-full w-full max-w-[900px] overflow-y-auto p-5 pb-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight">
          Projects
          <span className="font-mono text-[11px] font-normal text-muted-foreground/80">
            {sorted.length} project{sorted.length === 1 ? "" : "s"}
          </span>
        </h1>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98]"
        >
          <Plus className="size-3.5" aria-hidden />
          New project
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">No projects known.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} onBrowseAll={onBrowseAll} />
            </li>
          ))}
        </ul>
      )}
      <NewProjectDialog
        open={createOpen}
        defaultParent={defaultParent}
        onClose={() => setCreateOpen(false)}
        onOpenSession={onOpenSession}
      />
    </div>
  )
}
