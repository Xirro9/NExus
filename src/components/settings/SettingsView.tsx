// Settings (VNEXT Phase E2): minimal static stub. Read-only view over state
// Jerry already holds — connection facts from the nexus store, plus an honest
// note about what lives locally. Nothing here writes to the server; real
// settings follow the roadmap.

import { Plug, HardDrive, Settings } from "lucide-react"

import { useNexus } from "@/store/nexus"
import { useStatus } from "@/store/selectors"
import { ConnectionBadge } from "@/components/shell/ConnectionBadge"
import { PanelCard } from "@/components/dashboard/PanelCard"

/** localStorage keys Jerry owns — surfaced so "where is my data?" has an answer. */
const LOCAL_KEYS: [string, string][] = [
  ["nexus.sessionPriorities.v1", "per-session priority labels (organizational only)"],
  ["nexus.mainView · nexus.railCollapsed", "last view + status-rail state"],
  ["nexus.chatViewMode.v1 · nexus.agentTreeCollapsed.v1", "chat + agent-tree layout state"],
]

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-2 py-1.5">
      <span className="w-20 shrink-0 font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">{children}</span>
    </div>
  )
}

export function SettingsView() {
  const status = useStatus()
  const connection = useNexus((s) => s.connection)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[900px] p-5 pb-10">
        <div className="mb-4 flex items-center gap-3 px-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Settings className="size-4 text-muted-foreground" aria-hidden />
            Settings
          </h1>
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80 uppercase">
            stub · read-only
          </span>
        </div>

        <div className="grid grid-cols-1 gap-5">
          <PanelCard
            title="Connection"
            icon={<Plug className="size-3.5 text-primary" aria-hidden />}
          >
            <div className="mb-2 px-2">
              <ConnectionBadge status={status} version={connection.version} />
            </div>
            <div className="divide-y divide-border/40">
              <FactRow label="server">
                <span className="font-mono text-[11px] break-all">
                  {connection.url ?? "unknown"}
                </span>
              </FactRow>
              <FactRow label="version">
                <span className="font-mono text-[11px] tabular-nums">
                  {connection.version ? `v${connection.version}` : "—"}
                </span>
              </FactRow>
            </div>
            <p className="mt-2 px-2 text-[10px] text-muted-foreground/60">
              Jerry talks to the local OpenCode server — no connection settings
              in this build.
            </p>
          </PanelCard>

          <PanelCard
            title="Stored locally in Jerry"
            icon={<HardDrive className="size-3.5 text-muted-foreground/70" aria-hidden />}
          >
            <ul className="divide-y divide-border/40">
              {LOCAL_KEYS.map(([key, what]) => (
                <li key={key} className="px-2 py-1.5">
                  <span className="block truncate font-mono text-[11px] text-foreground/90">
                    {key}
                  </span>
                  <span className="block text-[10px] text-muted-foreground/80">
                    {what}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 px-2 text-[10px] text-muted-foreground/60">
              Session priorities are stored in Jerry only — the OpenCode server
              has no priority API, so they organize Jerry's lists and never
              change inference scheduling.
            </p>
          </PanelCard>
        </div>
      </div>
    </div>
  )
}
