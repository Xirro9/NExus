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
    <div hidden={!visible} className="h-full overflow-y-auto p-4 pb-8">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SystemPanel />
        <GpuPanel />
        <LlmPanel />
        <ContextPanel visible={visible} />
        <div className="xl:col-span-2">
          <UsagePanel visible={visible} />
        </div>
      </div>
    </div>
  )
}
