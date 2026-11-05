// Compact live telemetry block for the status rail (SPEC-PHASE2 §6): the rail
// is the ambient always-watching surface — llama status + latency, CPU, RAM,
// GPU util, and the active session's context bar. Reads only the telemetry
// store (2 s poll, our own middleware) — never the OpenCode API.

import type { SessionInfo } from "@/lib/opencode/types"
import { useContextLimit } from "@/hooks/useContextLimit"
import { useGpuSamples, useLlm, useSystemSamples, useTelemetry } from "@/store/telemetry"
import { ContextBar } from "@/components/dashboard/ContextBar"

const DOT_COLORS = {
  ok: "var(--success)",
  starting: "var(--warning)",
  unreachable: "var(--destructive)",
  null: "var(--muted-foreground)",
} as const

export function TelemetryMini({ session }: { session: SessionInfo | null }) {
  const llm = useLlm()
  const systemSamples = useSystemSamples()
  const gpuSamples = useGpuSamples()
  const systemOk = useTelemetry((s) => s.snapshot?.system.ok ?? false)
  const gpuOk = useTelemetry((s) => s.snapshot?.gpu.ok ?? false)
  const ctx = useContextLimit(session)

  const sys = systemSamples.length > 0 ? systemSamples[systemSamples.length - 1]! : null
  const gpu = gpuSamples.length > 0 ? gpuSamples[gpuSamples.length - 1]! : null
  const ramPct = sys && sys.memTotal > 0 ? (sys.memUsed / sys.memTotal) * 100 : null
  const gpuUtil =
    gpu && gpu.gpus.length > 0
      ? gpu.gpus.reduce((a, g) => a + g.utilGpu, 0) / gpu.gpus.length
      : null
  const vramUsed = gpu?.gpus.reduce((a, g) => a + g.memUsed, 0) ?? 0
  const vramTotal = gpu?.gpus.reduce((a, g) => a + g.memTotal, 0) ?? 0

  const status = llm?.status ?? null
  const allNominal = status === "ok" && systemOk && gpuOk

  return (
    <div
      className={
        "rounded-xl border bg-card p-3 " +
        (allNominal
          ? "border-success/40 shadow-[var(--glow-success)]"
          : "border-border/70")
      }
    >
      <h3 className="mb-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Telemetry
      </h3>
      <dl className="space-y-1 font-mono text-xs">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">llama</dt>
          <dd className="flex items-center gap-1.5">
            <span
              className="size-1.5 rounded-full"
              style={{ background: DOT_COLORS[status ?? "null"] }}
              aria-hidden
            />
            {status ?? "…"}
            {llm?.latencyMs !== undefined && llm?.latencyMs !== null && (
              <span className="tabular-nums">{llm.latencyMs.toFixed(1)}ms</span>
            )}
          </dd>
        </div>
        <Row k="cpu" v={sys ? `${sys.cpu.toFixed(1)}%` : "…"} />
        <Row k="ram" v={ramPct !== null ? `${ramPct.toFixed(1)}%` : "…"} />
        <Row
          k="gpu"
          v={
            gpuUtil !== null
              ? `${gpuUtil.toFixed(0)}% · ${(vramUsed / 1024).toFixed(0)}/${(vramTotal / 1024).toFixed(0)}G`
              : gpuOk
                ? "…"
                : "n/a"
          }
        />
      </dl>
      {session && (
        <div className="mt-2.5 border-t border-border/70 pt-2.5">
          <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
            ctx {ctx.limit !== null ? ctx.limit.toLocaleString() : "unknown"}
            {ctx.stale ? " · stale" : ""}
          </div>
          <ContextBar tokens={session.tokens} ctxLimit={ctx.limit} />
        </div>
      )}
      {!llm && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">warming up…</p>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}
