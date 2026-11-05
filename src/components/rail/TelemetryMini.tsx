// Compact live telemetry block for the status rail (SPEC-PHASE2 §6): the rail
// is the ambient always-watching surface — llama status + latency, CPU, RAM,
// GPU util, and the active session's context bar. Reads the telemetry store
// (2 s poll, our own middleware) plus the nexus messages slice for the
// context bar's per-message tokens — no OpenCode API calls here.

import type { SessionInfo, TokenUsage } from "@/lib/opencode/types"
import { useContextLimit } from "@/hooks/useContextLimit"
import { useGpuSamples, useLlm, useSystemSamples, useTelemetry } from "@/store/telemetry"
import { useCurrentContextTokens } from "@/store/selectors"
import { ContextBar } from "@/components/dashboard/ContextBar"

// token-less session payloads exist (bare session.created) — same guard as StatusRail
const EMPTY_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const DOT_COLORS = {
  ok: "var(--success)",
  starting: "var(--warning)",
  unreachable: "var(--destructive)",
  null: "var(--muted-foreground)",
} as const

/** utilization tone: nominal → warning ≥80% → critical ≥95% */
function utilTone(v: number): string {
  return v >= 95 ? "text-destructive" : v >= 80 ? "text-warning" : "text-foreground"
}

export function TelemetryMini({ session }: { session: SessionInfo | null }) {
  const llm = useLlm()
  const systemSamples = useSystemSamples()
  const gpuSamples = useGpuSamples()
  const systemOk = useTelemetry((s) => s.snapshot?.system.ok ?? false)
  const gpuOk = useTelemetry((s) => s.snapshot?.gpu.ok ?? false)
  const ctx = useContextLimit(session)
  // measured current-context size from the latest assistant message; null →
  // fall back to cumulative session.tokens and let ContextBar label it "est."
  // (cumulative totals include cache.read, a per-step counter, so they are
  // NOT the live window)
  const measuredTokens = useCurrentContextTokens()

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
          : "border-border/70 shadow-[inset_0_1px_0_0_oklch(1_0_0/0.03)]")
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
              className={
                "size-1.5 rounded-full" + (status === "starting" ? " nexus-live" : "")
              }
              style={{ background: DOT_COLORS[status ?? "null"] }}
              aria-hidden
            />
            {status ?? "…"}
            {llm?.latencyMs !== undefined && llm?.latencyMs !== null && (
              <span className="tabular-nums">{llm.latencyMs.toFixed(1)}ms</span>
            )}
          </dd>
        </div>
        <Row k="cpu" v={sys ? `${sys.cpu.toFixed(1)}%` : "…"} tone={sys ? utilTone(sys.cpu) : undefined} />
        <Row
          k="ram"
          v={ramPct !== null ? `${ramPct.toFixed(1)}%` : "…"}
          tone={ramPct !== null ? utilTone(ramPct) : undefined}
        />
        <Row
          k="gpu"
          v={
            gpuUtil !== null
              ? `${gpuUtil.toFixed(0)}% · ${(vramUsed / 1024).toFixed(0)}/${(vramTotal / 1024).toFixed(0)}G`
              : gpuOk
                ? "…"
                : "n/a"
          }
          tone={gpuUtil !== null ? utilTone(gpuUtil) : undefined}
        />
      </dl>
      {session && (
        <div className="mt-2.5 border-t border-border/70 pt-2.5">
          <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
            ctx {ctx.limit !== null ? ctx.limit.toLocaleString() : "unknown"}
            {ctx.stale ? " · stale" : ""}
          </div>
          <ContextBar
            tokens={measuredTokens ?? session.tokens ?? EMPTY_TOKENS}
            ctxLimit={ctx.limit}
            estimate={measuredTokens === null}
          />
        </div>
      )}
      {!llm && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">warming up…</p>
      )}
    </div>
  )
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={"tabular-nums" + (tone ? ` ${tone}` : "")}>{v}</dd>
    </div>
  )
}
