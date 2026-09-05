'use client'

import { use } from 'react'
import { TranscriptPaneMinimal } from '@/components/TranscriptPaneMinimal'

interface PageProps {
  params: Promise<{ uuid: string }>
}

export default function SessionDiagPage({ params }: PageProps) {
  const { uuid } = use(params)
  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200">
        DIAG mode · minimal transcript dump · session {uuid}
      </div>
      <div className="flex-1 overflow-hidden">
        <TranscriptPaneMinimal uuid={uuid} />
      </div>
    </div>
  )
}
