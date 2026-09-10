'use client'

import { projectInfoRows, type ProjectFormOption } from '@/lib/project-info'

interface Props {
  project: ProjectFormOption | undefined
  className?: string
}

/**
 * The facts a selected project carries into a spawn — harness, workspace,
 * config dir, and the model/effort a field left on "Default" resolves to.
 *
 * Shared by the Spawn and Schedule dialogs so the two describe a project the
 * same way; nothing renders until a project is picked.
 */
export function ProjectInfoPanel({ project, className }: Props) {
  const rows = projectInfoRows(project)
  if (rows.length === 0) return null

  return (
    <div
      data-testid="project-info-panel"
      className={`text-[11px] text-zinc-500 dark:text-zinc-400 space-y-0.5 font-mono ${className ?? ''}`}
    >
      {rows.map((row) => (
        <div key={row.key} className={row.wrap ? 'break-all' : undefined} title={row.title}>
          {row.label}: <span className="text-zinc-800 dark:text-zinc-200">{row.value}</span>
          {row.note && <span className="text-zinc-400 italic ml-1">({row.note})</span>}
        </div>
      ))}
    </div>
  )
}
