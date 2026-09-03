'use client'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem('orchestron_token')
  } catch {
    return null
  }
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getToken()
  const headers: HeadersInit = { ...(init?.headers ?? {}) }
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
  }
  return fetch(input, { ...init, headers })
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}
