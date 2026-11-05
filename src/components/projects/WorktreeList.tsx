// Worktree rows + refresh (SPEC-PHASE3 §7). READ-ONLY + refresh only —
// create/delete are deliberately excluded (§7 decision: DELETE requires force
// and removes directories from disk; neither is reversible from a status UI).

import { GitBranch, RefreshCw } from "lucide-react"

import { useWorktrees, useWorkspace } from "@/store/workspace"

export function WorktreeList({ projectID }: { projectID: string }) {
  const worktrees = useWorktrees(projectID)
  const status = useWorkspace((s) => s.worktreeStatus[projectID] ?? "idle")
  const loadWorktrees = useWorkspace((s) => s.loadWorktrees)
  const refreshWorktrees = useWorkspace((s) => s.refreshWorktrees)

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          <GitBranch className="size-3" aria-hidden />
          Worktrees
        </h4>
        <button
          type="button"
          onClick={() =>
            status === "idle" && worktrees.length === 0
              ? void loadWorktrees(projectID)
              : void refreshWorktrees(projectID)
          }
          disabled={status === "loading"}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw
            className={"size-3" + (status === "loading" ? " animate-spin" : "")}
            aria-hidden
          />
          {status === "idle" && worktrees.length === 0 ? "Load" : "Refresh"}
        </button>
      </div>
      {status === "error" ? (
        <p className="text-[11px] text-destructive">
          Worktree listing failed.
        </p>
      ) : worktrees.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/80">
          {status === "loading"
            ? "Loading…"
            : "No worktrees registered for this project."}
        </p>
      ) : (
        <ul className="space-y-1">
          {worktrees.map((wt) => (
            <li
              key={wt.directory}
              className="flex items-center justify-between gap-2 font-mono text-[11px]"
            >
              <span className="min-w-0 truncate text-foreground/90" title={wt.directory}>
                {wt.directory}
              </span>
              {wt.strategy && (
                <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] text-muted-foreground">
                  {wt.strategy}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
