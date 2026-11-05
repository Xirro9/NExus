// Inference panel (SPEC-PHASE2 §7): llama-server status dot, health latency
// (host-measured), model info from /props, latency sparkline. Amber "starting"
// vs red "unreachable" are rendered distinctly (§2.8).

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { fmtClock } from "@/lib/format"
import { useLlm } from "@/store/telemetry"
import { TOOLTIP_PROPS, useAnimateOnce } from "./chart-utils"
import { PanelCard } from "./PanelCard"

const STATUS_META = {
  ok: { color: "var(--success)", glow: "var(--glow-success)", label: "ok" },
  starting: { color: "var(--warning)", glow: null, label: "starting" },
  unreachable: { color: "var(--destructive)", glow: null, label: "unreachable" },
  null: { color: "var(--muted-foreground)", glow: null, label: "checking…" },
} as const

export function LlmPanel() {
  const llm = useLlm()
  const animate = useAnimateOnce()

  const status = llm?.status ?? null
  const meta = STATUS_META[status ?? "null"]
  const stale = (llm?.propsStaleMs ?? 0) > 120_000

  const latencyData = (llm?.samples ?? []).map((s) => ({ t: s.t, latencyMs: s.latencyMs }))

  return (
    <PanelCard
      title="Inference"
      right={
        stale ? (
          <span className="rounded-full border border-warning/50 px-2 py-0.5 font-mono text-[10px] text-warning">
            props stale
          </span>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">llama-server</span>
        )
      }
      // no degraded swap: the body always renders so the retained /props model
      // stays visible while unreachable (§2.8 — ctx math keeps working, flagged)
    >
      {!llm ? (
        <p className="py-1 text-xs text-muted-foreground">warming up (0 samples)</p>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{
                background: meta.color,
                ...(meta.glow ? { boxShadow: meta.glow } : {}),
              }}
              aria-hidden
            />
            <span className="font-mono text-xs">{meta.label}</span>
            <span className="ml-auto font-mono text-xs tabular-nums">
              {llm.latencyMs !== null ? `${llm.latencyMs.toFixed(1)} ms` : "—"}
            </span>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            {llm.ok
              ? "health latency (host)"
              : status === "starting"
                ? "model loading — retrying every 5 s"
                : `llama-server unreachable — retrying every 5 s${llm.error ? ` (${llm.error})` : ""}`}
          </p>

          {latencyData.length >= 2 && (
            <div className="h-[56px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={latencyData} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                  <XAxis dataKey="t" hide domain={["dataMin", "dataMax"]} type="number" />
                  <YAxis hide domain={[0, "auto"]} width={0} />
                  <Tooltip
                    {...TOOLTIP_PROPS}
                    labelFormatter={(label) => fmtClock(Number(label))}
                    formatter={(value) => [`${Number(value).toFixed(1)} ms`, "latency"]}
                  />
                  <Line
                    dataKey="latencyMs"
                    stroke="var(--chart-1)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={animate}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {llm.model && (
            <dl className="space-y-1 font-mono text-xs">
              <Row k="alias" v={llm.model.alias ?? "—"} />
              <Row k="n_ctx" v={llm.model.nCtx !== null ? llm.model.nCtx.toLocaleString() : "—"} />
              <Row k="slots" v={llm.model.slots !== null ? String(llm.model.slots) : "—"} />
              <Row k="build" v={llm.model.build ?? "—"} />
              <Row k="sleeping" v={llm.model.isSleeping === null ? "—" : String(llm.model.isSleeping)} />
              <Row k="url" v={llm.url} />
            </dl>
          )}
        </div>
      )}
    </PanelCard>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="truncate" title={v}>
        {v}
      </dd>
    </div>
  )
}
