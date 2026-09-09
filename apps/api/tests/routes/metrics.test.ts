import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { metricsPlugin } from '../../src/routes/metrics.js'
import { MetricsCollector } from '../../src/domain/metrics-collector.js'

// Vitest 4.x: `vi.fn().mockImplementation(() => ({...}))` used with `new`
// invokes the arrow function as constructor — arrows aren't constructible,
// so it throws TypeError. Use a real class in the mock instead.
vi.mock('../../src/domain/metrics-collector.js', () => {
  class MockMetricsCollector {
    query = vi.fn().mockResolvedValue({
      buckets: [
        { key: 'proj-alpha', sessions: 5, tokens: 7500, cost_usd: 0.15, avg_duration_ms: 60000 },
        { key: 'proj-beta', sessions: 3, tokens: 4500, cost_usd: 0.09, avg_duration_ms: 30000 },
      ],
      total: { sessions: 8, tokens: 12000, cost_usd: 0.24 },
    })
  }
  return { MetricsCollector: MockMetricsCollector }
})

let app: ReturnType<typeof Fastify>
let collector: MetricsCollector

beforeEach(async () => {
  collector = new MetricsCollector('/data')
  app = Fastify({ logger: false })
  await app.register(metricsPlugin(collector))
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('GET /api/metrics', () => {
  it('returns metrics grouped by project (default groupBy)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=project' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total.sessions).toBe(8)
    expect(body.buckets).toHaveLength(2)
    expect(body.buckets[0].key).toBe('proj-alpha')
  })

  it('passes groupBy=model to collector', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=model' })
    expect(res.statusCode).toBe(200)
    const mockQuery = vi.mocked((collector as any).query)
    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'model' }))
  })

  it('passes date range params to collector', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/metrics?groupBy=day&from=2026-09-01&to=2026-09-04',
    })
    expect(res.statusCode).toBe(200)
    const mockQuery = vi.mocked((collector as any).query)
    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-09-01',
      to: '2026-09-04',
    }))
  })

  it('returns 400 for invalid groupBy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=invalid' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/groupBy/)
  })

  it('returns 400 for malformed from date', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=day&from=01-09-2026' })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when from > to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/metrics?groupBy=day&from=2026-09-05&to=2026-09-01',
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for invalid adapter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=day&adapter=invalid' })
    expect(res.statusCode).toBe(400)
  })

  it('accepts valid adapter param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics?groupBy=day&adapter=claude' })
    expect(res.statusCode).toBe(200)
  })
})
