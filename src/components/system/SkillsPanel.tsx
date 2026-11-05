// Skills panel (SPEC-PHASE3 §8.1): read-only rows; clicking a row expands the
// skill's full markdown body through the escaped renderer. Content is already
// in memory from loadExtensions — rendering happens lazily on expand
// (56 KB of markdown must not render eagerly).

import { useState } from "react"

import { renderMarkdown } from "@/lib/markdown"
import type { SkillInfo } from "@/lib/opencode/types"

function SkillRow({ skill }: { skill: SkillInfo }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-xl border border-border/70 bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-3 py-2.5 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{skill.name}</span>
          {skill.autoinvoke && (
            <span className="shrink-0 rounded border border-accent/40 px-1 font-mono text-[9px] text-accent">
              auto-invoke
            </span>
          )}
        </div>
        {skill.description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {skill.description}
          </p>
        )}
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
          {skill.path}
        </p>
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2">
          <div
            className="md-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(skill.content) }}
          />
        </div>
      )}
    </li>
  )
}

export function SkillsPanel({ skills }: { skills: SkillInfo[] | null }) {
  if (skills === null) {
    return <p className="text-xs text-muted-foreground">Loading skills…</p>
  }
  if (skills.length === 0) {
    return <p className="text-xs text-muted-foreground">No skills installed.</p>
  }
  return (
    <ul className="space-y-2">
      {skills.map((s) => (
        <SkillRow key={s.id} skill={s} />
      ))}
    </ul>
  )
}
