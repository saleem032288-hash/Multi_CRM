import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// GET /api/whatsapp/connections — webhook readiness flags.
//
// The settings UI warns about a connection whose Meta App Secret is missing
// *before* the first inbound webhook is rejected with 401. That warning is
// driven entirely by two derived fields on the list response:
//
//   app_secret_set  the row has its own encrypted secret
//   webhook_ready   a signature can be verified (own secret OR env fallback)
//
// Both must stay booleans, must never be derived from the ciphertext being
// sent to the browser, and must be `undefined` (not `false`) when the secret
// column could not be read — otherwise the UI would claim a secret is
// missing on a database blip.
// ---------------------------------------------------------------------------

const ENCRYPTED_SECRET = 'iv:ciphertext:tag'

const h = vi.hoisted(() => ({
  state: {
    connections: [] as Record<string, unknown>[],
    /** Null models the query failing, which is different from "no rows". */
    secrets: [] as { id: string; app_secret: string | null }[] | null,
    secretError: null as { message: string } | null,
    listError: null as { message: string } | null,
    counters: [] as Record<string, unknown>[],
    secretQueries: 0,
  },
}))

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  connection_number: 1,
  connection_name: 'Support line',
  phone_number: '+15551234567',
  phone_number_id: 'PNID-1',
  waba_id: 'WABA-1',
  profile_name: null,
  profile_picture_url: null,
  status: 'connected',
  connection_status: 'connected',
  verification_status: 'verified',
  registered_at: null,
  subscribed_apps_at: null,
  last_registration_error: null,
  last_status_check_at: null,
  last_status_error: null,
  status_details: null,
  last_webhook_at: null,
  mirror_inbound_media: true,
  app_id: '1234567890',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

function makeSupabaseMock() {
  function builder(table: string) {
    let columns = ''
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['eq', 'order', 'limit', 'in', 'not', 'is']) {
      b[m] = vi.fn(chain)
    }
    b.select = vi.fn((cols: string) => {
      columns = cols
      return b
    })

    // Single-row lookups (account context).
    const rowResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1', account_role: 'admin' }, error: null }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    // Awaited chains (list queries).
    const chainResult = () => {
      switch (table) {
        case 'whatsapp_config':
          if (columns === 'id, app_secret') {
            h.state.secretQueries += 1
            return { data: h.state.secrets, error: h.state.secretError }
          }
          return { data: h.state.connections, error: h.state.listError }
        case 'whatsapp_message_counters':
          return { data: h.state.counters, error: null }
        default:
          return { data: null, error: null }
      }
    }

    b.maybeSingle = vi.fn(async () => rowResult())
    b.single = vi.fn(async () => rowResult())
    b.then = (resolve: (value: unknown) => unknown) => resolve(chainResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

const supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

import { GET } from './route'

async function getConnections() {
  const res = await GET()
  const body = await res.json()
  return { status: res.status, body }
}

describe('GET /api/whatsapp/connections — Meta App Secret readiness flags', () => {
  beforeEach(() => {
    h.state.connections = [connection()]
    h.state.secrets = [{ id: 'cfg-1', app_secret: ENCRYPTED_SECRET }]
    h.state.secretError = null
    h.state.listError = null
    h.state.counters = []
    h.state.secretQueries = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports the connection as ready when its own App Secret is stored', async () => {
    const { status, body } = await getConnections()

    expect(status).toBe(200)
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0].app_secret_set).toBe(true)
    expect(body.connections[0].webhook_ready).toBe(true)
    // One list query + one secret-presence query, both account scoped.
    expect(h.state.secretQueries).toBe(1)
  })

  it('warns when no secret is stored and there is no env fallback', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    h.state.secrets = [{ id: 'cfg-1', app_secret: null }]

    const { body } = await getConnections()

    expect(body.connections[0].app_secret_set).toBe(false)
    expect(body.connections[0].webhook_ready).toBe(false)
  })

  it('treats the env fallback as ready without claiming a per-connection secret', async () => {
    vi.stubEnv('META_APP_SECRET', 'deployment-wide-secret')
    h.state.secrets = [{ id: 'cfg-1', app_secret: null }]

    const { body } = await getConnections()

    // The card must stay quiet (webhooks verify), but editing still shows
    // that this connection has no secret of its own.
    expect(body.connections[0].app_secret_set).toBe(false)
    expect(body.connections[0].webhook_ready).toBe(true)
  })

  it('leaves the flags undefined when the secret column cannot be read', async () => {
    h.state.secrets = null
    h.state.secretError = { message: 'permission denied for table whatsapp_config' }

    const { status, body } = await getConnections()

    // The list still loads — a failed readiness probe must not break the
    // settings page — but the UI must not invent a "missing secret" warning.
    expect(status).toBe(200)
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0].app_secret_set).toBeUndefined()
    expect(body.connections[0].webhook_ready).toBeUndefined()
  })

  it('never sends the stored secret to the browser', async () => {
    const { body } = await getConnections()

    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(ENCRYPTED_SECRET)
    expect(body.connections[0]).not.toHaveProperty('app_secret')
  })

  it('keeps the per-connection counter alongside the readiness flags', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    h.state.connections = [
      connection(),
      connection({ id: 'cfg-2', connection_number: 2, connection_name: 'Sales' }),
    ]
    h.state.secrets = [
      { id: 'cfg-1', app_secret: ENCRYPTED_SECRET },
      { id: 'cfg-2', app_secret: null },
    ]
    h.state.counters = [
      {
        whatsapp_connection_id: 'cfg-1',
        service_messages_count: 7,
        last_reset_at: null,
        updated_at: null,
      },
    ]

    const { body } = await getConnections()

    expect(body.connections[0].counter.service_messages_count).toBe(7)
    expect(body.connections[1].counter).toMatchObject({
      whatsapp_connection_id: 'cfg-2',
      service_messages_count: 0,
    })
    expect(body.connections[1].webhook_ready).toBe(false)
  })
})
