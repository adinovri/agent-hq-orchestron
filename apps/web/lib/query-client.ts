'use client'

import { QueryClient } from '@tanstack/react-query'

let client: QueryClient | null = null

export function getQueryClient(): QueryClient {
  if (!client) {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 1,
          staleTime: 0,
        },
      },
    })
  }
  return client
}
