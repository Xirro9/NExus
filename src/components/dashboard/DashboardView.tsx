// Dashboard view (SPEC-PHASE2 §7): System → Inference(GPU/LLM) → Context →
// Usage. Mounts lazily on first open and STAYS mounted (hidden via the
// `hidden` attribute) so charts keep their data; `visible` gates the OpenCode
// API polls (stats ≤1/30 s, /context debounced) per the single-slot rule.

import { ContextPanel } from "./ContextPanel"
import { GpuPanel } from "./GpuPanel"
import { LlmPanel } from "./LlmPanel"
import { SystemPanel } from "./SystemPanel"
import { UsagePanel } from "./UsagePanel"

export function DashboardView({ visible }: { visible: boolean }) {
  return (
    <div hidden={!visible} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] p-5 pb-10">
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="nexus-live size-1.5 rounded-full bg-success shadow-[var(--glow-success)]" />
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
            live · 2 s cadence
          </span>
        </div>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <SystemPanel visible={visible} />
          <GpuPanel visible={visible} />
          <LlmPanel visible={visible} />
          <ContextPanel visible={visible} />
          <div className="xl:col-span-2">
            <UsagePanel visible={visible} />
          </div>
        </div>
      </div>
    </div>
  )
}
