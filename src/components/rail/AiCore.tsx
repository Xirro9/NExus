// Animated AI core: concentric breathing rings — 4 s idle, 1.2 s + rotation
// when thinking. Cyan glow via --glow-primary. Static ring under
// prefers-reduced-motion. Pure SVG + motion (§8).

import { motion, useReducedMotion } from "motion/react"

export function AiCore({ state }: { state: "idle" | "thinking" }) {
  const reduced = useReducedMotion()
  const thinking = state === "thinking"
  const breathe = thinking ? 1.2 : 4

  if (reduced) {
    return <StaticCore dim={false} />
  }

  return (
    <div className="relative h-40 w-40" role="img" aria-label={`AI core ${state}`}>
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: "var(--glow-primary)" }}
        animate={
          thinking
            ? { scale: [1, 1.12, 1], opacity: [0.9, 1, 0.9] }
            : { scale: [1, 1.05, 1], opacity: [0.6, 0.8, 0.6] }
        }
        transition={{ duration: breathe, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute inset-3 rounded-full border-2 border-primary/60"
        animate={
          thinking
            ? { rotate: 360, scale: [1, 0.94, 1] }
            : { rotate: 0, scale: [1, 1.06, 1] }
        }
        transition={
          thinking
            ? { rotate: { duration: 3, repeat: Infinity, ease: "linear" }, scale: { duration: breathe, repeat: Infinity, ease: "easeInOut" } }
            : { duration: breathe, repeat: Infinity, ease: "easeInOut" }
        }
      />
      <motion.div
        className="absolute inset-7 rounded-full border border-accent/50"
        animate={{ rotate: thinking ? -360 : 0, scale: [1, 1.08, 1] }}
        transition={
          thinking
            ? { rotate: { duration: 2, repeat: Infinity, ease: "linear" }, scale: { duration: breathe, repeat: Infinity, ease: "easeInOut" } }
            : { duration: breathe, repeat: Infinity, ease: "easeInOut", delay: 0.4 }
        }
      />
      <motion.div
        className="absolute inset-12 rounded-full bg-primary/70"
        animate={{ scale: thinking ? [1, 1.3, 1] : [1, 1.12, 1] }}
        transition={{ duration: breathe, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  )
}

function StaticCore({ dim }: { dim: boolean }) {
  return (
    <div
      className={"relative h-40 w-40 " + (dim ? "opacity-40" : "")}
      role="img"
      aria-label="AI core idle"
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: "var(--glow-primary)" }}
      />
      <div className="absolute inset-3 rounded-full border-2 border-primary/60" />
      <div className="absolute inset-7 rounded-full border border-accent/50" />
      <div className="absolute inset-12 rounded-full bg-primary/70" />
    </div>
  )
}

export { StaticCore }
