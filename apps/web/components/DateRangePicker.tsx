'use client'

interface Props {
  from: string
  to: string
  onChange: (from: string, to: string) => void
}

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Hoisted out of the component on purpose. It reads the clock, and inside a
 *  component body the React Compiler lint cannot tell that the only caller is
 *  an onClick handler rather than render — it has to assume the worst. Out
 *  here it is plainly a handler helper. Same behaviour, `onChange` passed in. */
function applyPreset(days: number, onChange: Props['onChange']) {
  const end = new Date()
  const start = new Date(Date.now() - days * 86_400_000)
  onChange(toDateStr(start), toDateStr(end))
}

export function DateRangePicker({ from, to, onChange }: Props) {

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => applyPreset(p.days, onChange)}
          className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          Last {p.label}
        </button>
      ))}
      <input
        type="date"
        aria-label="From date"
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className="h-8 px-2 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
      />
      <span className="text-zinc-400">–</span>
      <input
        type="date"
        aria-label="To date"
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        className="h-8 px-2 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
      />
    </div>
  )
}
