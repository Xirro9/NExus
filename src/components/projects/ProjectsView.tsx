// Projects view (SPEC-PHASE3 §7): project cards with per-project session
// scoping and read-only worktrees. No polling — data comes from the nexus
// projects list (kept fresh by SSE refetch markers).

import { useNexus } from "@/store/nexus"

import { ProjectCard } from "./ProjectCard"

export function ProjectsView({
  onBrowseAll,
}: {
  onBrowseAll(projectId: string): void
}) {
  const projects = useNexus((s) => s.projects)
  // newest-active first
  const sorted = [...projects].sort(
    (a, b) =>
      (b.time.active ?? b.time.updated) - (a.time.active ?? a.time.updated),
  )

  return (
    <div className="mx-auto h-full w-full max-w-[900px] overflow-y-auto p-5 pb-10">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Projects</h1>
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
    </div>
  )
}
