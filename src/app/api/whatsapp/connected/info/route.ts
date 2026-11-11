import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAccountConnection } from '@/lib/whatsapp/connections'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getPhoneNumberPicture,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * Full international form for the connected number. Meta's
 * `display_phone_number` usually arrives as "+44 7123 456789" but has
 * been observed without the leading "+", so make sure the international
 * dialling prefix is always visible — the Profile view must never show
 * a truncated or masked number.
 */
function withPlusSign(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`
}

/**
 * GET /api/whatsapp/connected/info
 *
 * Returns the WhatsApp API number connected to the caller's account,
 * plus that account's WhatsApp profile picture (DP). Used by the Profile
 * views so an agent can see exactly which connected WhatsApp number owns
 * the conversation — never the customer's number or DP.
 *
 * Response shape:
 *   { connected: false, reason: 'no_account' | 'no_config' | 'token_corrupted' }
 *   { connected: true, number, pictureUrl }
 *
 * `number` is the full international number (leading "+"); `pictureUrl`
 * is a public CDN URL for the connected account's profile picture, or
 * null when Meta has none. Failures degrade to `connected: false` so the
 * UI simply hides the block rather than error.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!profile?.account_id) {
      return NextResponse.json(
        { connected: false, reason: 'no_account' },
        { status: 200 },
      )
    }

    // Optional `?connection_id=` lets a view ask about a specific
    // number; without it the account's first connection is used.
    const requestedConnectionId =
      new URL(request.url).searchParams.get('connection_id') || null
    const config = await getAccountConnection(
      supabase,
      profile.account_id,
      requestedConnectionId,
    )

    if (!config?.phone_number_id || !config?.access_token) {
      return NextResponse.json(
        { connected: false, reason: 'no_config' },
        { status: 200 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { connected: false, reason: 'token_corrupted' },
        { status: 200 },
      )
    }

    // The full international number comes straight from Meta (the stored
    // phone_number_id is an opaque Meta id, not a dialable number). The
    // DP is the profile picture configured on the connected WhatsApp
    // account — deliberately NOT the customer's avatar.
    const phoneInfo = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    }).catch(() => null)

    const number = phoneInfo?.display_phone_number
    if (!number) {
      return NextResponse.json(
        { connected: false, reason: 'meta_api_error' },
        { status: 200 },
      )
    }

    const picture = await getPhoneNumberPicture({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })

    return NextResponse.json({
      connected: true,
      connection_id: config.id,
      connection_number: config.connection_number,
      connection_name: config.connection_name,
      number: withPlusSign(number),
      pictureUrl: picture?.url ?? null,
    })
  } catch (error) {
    console.error('Error in WhatsApp connected info GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown' },
      { status: 200 },
    )
  }
}