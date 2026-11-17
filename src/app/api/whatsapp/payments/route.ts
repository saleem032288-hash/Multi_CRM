import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getPricingAnalytics,
  listWabaPhoneNumbers,
} from '@/lib/whatsapp/meta-api'
import type { MetaPaymentsResult } from '@/lib/dashboard/types'

export const dynamic = 'force-dynamic'

function unavailable(reason: string): MetaPaymentsResult {
  return { available: false, reason }
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

function withPlusSign(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('+')) return trimmed
  return /^\d/.test(trimmed) ? `+${trimmed}` : trimmed
}

function roundCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100
}

export async function GET() {
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
      return NextResponse.json(unavailable('no_account'))
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('account_id', profile.account_id)
      .maybeSingle()

    if (!config?.access_token) {
      return NextResponse.json(unavailable('no_config'))
    }
    if (!config.waba_id) {
      return NextResponse.json(unavailable('no_waba'))
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(unavailable('token_corrupted'))
    }

    const now = new Date()
    const end = Math.floor(now.getTime() / 1000)
    const start = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
    )

    let analytics
    try {
      analytics = await getPricingAnalytics({
        wabaId: config.waba_id,
        accessToken,
        start,
        end,
      })
    } catch (error) {
      console.error('[meta-payments] analytics fetch failed:', error)
      return NextResponse.json(unavailable('meta_error'))
    }

    const phones = await listWabaPhoneNumbers({
      wabaId: config.waba_id,
      accessToken,
    }).catch(() => [])

    const labelById = new Map<string, string>()
    const labelByDigits = new Map<string, string>()
    for (const phone of phones) {
      if (phone.id) {
        labelById.set(phone.id, phone.display_phone_number ?? phone.id)
      }
      if (phone.display_phone_number) {
        labelByDigits.set(
          digitsOnly(phone.display_phone_number),
          withPlusSign(phone.display_phone_number),
        )
      }
    }

    const grouped = new Map<string, { label: string; amount: number }>()
    for (const point of analytics.points) {
      const id = (point.phone_number ?? point.phone)?.trim() || 'unknown'
      const label =
        labelById.get(id) ??
        labelByDigits.get(digitsOnly(id)) ??
        withPlusSign(id)
      const entry = grouped.get(id) ?? { label, amount: 0 }
      entry.amount += Number(point.cost ?? 0) || 0
      grouped.set(id, entry)
    }

    const numbers = Array.from(grouped, ([phoneNumberId, entry]) => ({
      phoneNumberId,
      displayPhoneNumber: entry.label,
      amount: roundCents(entry.amount),
    })).sort((a, b) => b.amount - a.amount)

    const hasCost = analytics.points.some(
      (point) => typeof point.cost === 'number',
    )
    if (analytics.points.length > 0 && !hasCost) {
      return NextResponse.json(unavailable('no_cost'))
    }

    return NextResponse.json({
      available: true,
      currency: analytics.currency || 'USD',
      periodStart: new Date(start * 1000).toISOString(),
      periodEnd: new Date(end * 1000).toISOString(),
      total: roundCents(numbers.reduce((sum, item) => sum + item.amount, 0)),
      numbers,
    } satisfies MetaPaymentsResult)
  } catch (error) {
    console.error('Error in whatsapp payments GET:', error)
    return NextResponse.json(unavailable('unknown'))
  }
}
