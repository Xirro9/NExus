// Plugins panel (SPEC-PHASE3 §8.1): grouped read-only status rows; failed
// plugins pinned first with their error in destructive.

import type { PluginInfo } from "@/lib/opencode/types"

function sourceLabel(p: PluginInfo): string {
  switch (p.source.type) {
    case "builtin":
      return "builtin"
    case "sdk":
      return "sdk"
    case "local":
      return p.source.path
    case "package":
      return (
        p.source.target +
        (p.source.version ? `@${p.source.version}` : "")
      )
  }
}

const FEATURE_KEYS = ["server", "tui", "rpc", "gui"] as const

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const failed = plugin.state.status === "failed"
  return (
    <li
      className={
        "rounded-lg border bg-card px-3 py-2 " +
        (failed ? "border-destructive/50" : "border-border/70")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px]" title={plugin.id}>
          {plugin.id ?? sourceLabel(plugin)}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {plugin.source.type === "package" && plugin.source.outdated && (
            <span className="rounded border border-warning/50 px-1 font-mono text-[9px] text-warning">
              outdated
            </span>
          )}
          {plugin.source.type === "package" && plugin.source.updating && (
            <span className="rounded border border-border/60 px-1 font-mono text-[9px] text-muted-foreground">
              updating…
            </span>
          )}
          {FEATURE_KEYS.filter((k) => plugin.features[k]).map((k) => (
            <span
              key={k}
              className="rounded border border-border/60 px-1 font-mono text-[9px] text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
        {sourceLabel(plugin)}
      </p>
      {failed && plugin.state.status === "failed" && (
        <p className="mt-1 text-[11px] break-words text-destructive">
          {plugin.state.error}
        </p>
      )}
    </li>
  )
}

export function PluginsPanel({ plugins }: { plugins: PluginInfo[] | null }) {
  if (plugins === null) {
    return <p className="text-xs text-muted-foreground">Loading plugins…</p>
  }
  const failed = plugins.filter((p) => p.state.status === "failed")
  const active = plugins.filter((p) => p.state.status === "active")
  return (
    <div>
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">
        {active.length} active · {failed.length} failed · {plugins.length} total
      </p>
      <ul className="space-y-1.5">
        {[...failed, ...active].map((p, i) => (
          <li key={(p.id ?? "") + i}>
            <PluginRow plugin={p} />
          </li>
        ))}
      </ul>
    </div>
  )
}
