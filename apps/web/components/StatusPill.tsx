import type { SessionStatus } from '@agent-hq-orchestron/shared'
import { STATUS_LABEL, STATUS_PILL, STATUS_DOT } from '@/lib/status'

interface Props {
  status: SessionStatus
  size?: 'sm' | 'md'
}

export function StatusPill({ status, size = 'sm' }: Props) {
  const pill = STATUS_PILL[status]
  const dot = STATUS_DOT[status]
  const sz = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${pill} ${sz}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}
