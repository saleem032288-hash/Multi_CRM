import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricingAnalytics } from './meta-api'

let capturedUrl: string | null = null

const BASE = {
  wabaId: 'waba-1',
  accessToken: 'tok',
  start: 1730419200,
  end: 1730505600,
} as const

beforeEach(() => {
  capturedUrl = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          currency: 'USD',
          pricing_analytics: {
            data: [
              {
                data_points: [
                  { phone_number: '441234567890', volume: 3, cost: 0.18 },
                  { phone_number: '441234567890', volume: 1, cost: 0.06 },
                  { phone_number: '447700900000', volume: 2, cost: 0.1 },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getPricingAnalytics', () => {
  it('requests per-phone cost analytics on the WABA node', async () => {
    const result = await getPricingAnalytics(BASE)

    expect(capturedUrl).toBe(
      'https://graph.facebook.com/v21.0/waba-1?fields=' +
        'pricing_analytics.start(1730419200).end(1730505600).granularity(DAILY)' +
        '.dimensions([PHONE]).metric_types([COST,VOLUME]),currency',
    )
    expect(result.currency).toBe('USD')
    expect(result.points).toHaveLength(3)
  })

  it('accepts the flat data-point response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            pricing_analytics: {
              data: [{ phone: '441234567890', volume: 1, cost: 0.02 }],
            },
          }),
          { status: 200 },
        ),
      ),
    )

    const result = await getPricingAnalytics(BASE)

    expect(result.currency).toBeNull()
    expect(result.points).toEqual([
      { phone: '441234567890', volume: 1, cost: 0.02 },
    ])
  })

  it('surfaces Meta errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: 'Invalid WABA id', code: 100 } }),
          { status: 400 },
        ),
      ),
    )

    await expect(getPricingAnalytics(BASE)).rejects.toThrow('Invalid WABA id')
  })
})
