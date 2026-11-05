// The shared stacked context bar (SPEC-PHASE2 §4.2): custom divs for crisp 1px
// control, colors = chart tokens. Two modes:
//  - ctx mode (ctxLimit set): segments sized against the context limit,
//    ≥80% warning / ≥95% destructive + compaction hint
//  - relative mode (relative): no limit known — proportional widths (usage panel)
//  - ctxLimit null & !relative: honest dashed "unknown" state — never guessed

import { fmtTokens } from "@/lib/format"
import type { TokenUsage } from "@/lib/opencode/types"

export interface ContextBarProps {
  tokens: TokenUsage
  ctxLimit: number | null
  relative?: boolean
}

const SEGMENTS: { label: string; color: string }[] = [
  { label: "output", color: "var(--chart-2)" },
  { label: "reasoning", color: "var(--chart-4)" },
  { label: "input", color: "var(--chart-1)" },
  { label: "cache read", color: "var(--chart-3)" },
  { label: "cache write", color: "var(--chart-5)" },
]

function tokenParts(t: TokenUsage): number[] {
  return [
    t.output ?? 0,
    t.reasoning ?? 0,
    t.input ?? 0,
    t.cache?.read ?? 0,
    t.cache?.write ?? 0,
  ]
}

export function ContextBar({ tokens, ctxLimit, relative }: ContextBarProps) {
  const parts = tokenParts(tokens)
  const used = parts.reduce((a, b) => a + b, 0)
  const pct = ctxLimit && ctxLimit > 0 ? (used / ctxLimit) * 100 : null
  const unknown = !relative && ctxLimit === null
  const tone = pct !== null && pct >= 95 ? "destructive" : pct !== null && pct >= 80 ? "warning" : null

  // absolute-positioned segments with cumulative left offsets (computed up
  // front — no mutable bindings captured in JSX)
  const denomNum = relative ? Math.max(used, 1) : (ctxLimit ?? 0)
  const bars = parts
    .map((p, i) => ({ p, seg: SEGMENTS[i]! }))
    .reduce<{ bars: { key: string; color: string; left: number; width: number }[]; total: number }>(
      (acc, { p, seg }) => {
        if (p > 0 && denomNum > 0) {
          acc.bars.push({
            key: seg.label,
            color: seg.color,
            left: (acc.total / denomNum) * 100,
            width: (p / denomNum) * 100,
          })
        }
        acc.total += p
        return acc
      },
      { bars: [], total: 0 },
    ).bars

  return (
    <div>
      <div
        role="img"
        aria-label={
          pct !== null
            ? `context footprint ${pct.toFixed(1)}% of limit`
            : `context footprint ${used} tokens, limit unknown`
        }
        className={
          "relative h-2.5 overflow-hidden rounded-full bg-muted/50 " +
          (unknown ? "border border-dashed border-border" : "")
        }
      >
        {!unknown &&
          bars.map((b) => (
            <div
              key={b.key}
              className="absolute inset-y-0"
              style={{ background: b.color, left: `${b.left}%`, width: `${b.width}%` }}
            />
          ))}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {SEGMENTS.map((seg, i) => (
            <span key={seg.label} className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ background: seg.color }} aria-hidden />
              {seg.label} {fmtTokens(parts[i] ?? 0)}
            </span>
          ))}
        </div>
        <span
          className={
            "shrink-0 font-mono text-[10px] " +
            (tone === "destructive"
              ? "text-destructive"
              : tone === "warning"
                ? "text-warning"
                : "text-muted-foreground")
          }
        >
          {pct !== null
            ? `${pct.toFixed(1)}% of ${fmtTokens(ctxLimit!)} ctx`
            : relative
              ? `${fmtTokens(used)} tok`
              : "ctx unknown"}
        </span>
      </div>
      {tone === "destructive" && (
        <p className="mt-1 font-mono text-[10px] text-destructive">
          ≥95% of context limit — consider /compact
        </p>
      )}
    </div>
  )
}
