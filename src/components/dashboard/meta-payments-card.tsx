'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CreditCard } from 'lucide-react'

import { formatCurrencyPrecise } from '@/lib/currency'
import type { MetaPaymentsResult } from '@/lib/dashboard/types'
import { SkeletonCard } from './skeleton'

const REASON_KEYS = [
  'no_account',
  'no_config',
  'no_waba',
  'token_corrupted',
  'meta_error',
  'no_cost',
  'unknown',
] as const

type Reason = (typeof REASON_KEYS)[number]

function isReason(value: string): value is Reason {
  return (REASON_KEYS as readonly string[]).includes(value)
}

function formatPeriod(startIso: string, endIso: string): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const start = new Date(startIso).toLocaleDateString(undefined, options)
  const end = new Date(endIso).toLocaleDateString(undefined, options)
  return `${start} – ${end}`
}

export function MetaPaymentsCard() {
  const t = useTranslations('Dashboard.metaPayments')
  const [data, setData] = useState<MetaPaymentsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/whatsapp/payments', {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      const payload = (await response.json()) as MetaPaymentsResult
      setData(payload)
      setError(false)
    } catch (err) {
      console.error('[dashboard] meta payments failed:', err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="col-span-full">
        <SkeletonCard />
      </div>
    )
  }

  if (error || !data) {
    return (
      <CardShell total={null} period={null}>
        <Note>{t('loadError')}</Note>
      </CardShell>
    )
  }

  if (!data.available) {
    const reason = isReason(data.reason) ? data.reason : 'unknown'
    return (
      <CardShell total={null} period={null}>
        <Note>{t(`reason_${reason}`)}</Note>
      </CardShell>
    )
  }

  return (
    <CardShell
      total={formatCurrencyPrecise(data.total, data.currency)}
      period={formatPeriod(data.periodStart, data.periodEnd)}
    >
      {data.numbers.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.numbers.map((item) => (
            <div
              key={item.phoneNumberId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2"
            >
              <span className="truncate text-sm text-foreground">
                {item.displayPhoneNumber}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                {formatCurrencyPrecise(item.amount, data.currency)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Note>{t('noNumbers')}</Note>
      )}
      <Note className="mt-4 border-t border-border pt-3">
        {t('estimateNote')}
      </Note>
    </CardShell>
  )
}

function CardShell({
  total,
  period,
  children,
}: {
  total: string | null
  period: string | null
  children: React.ReactNode
}) {
  const t = useTranslations('Dashboard.metaPayments')

  return (
    <div className="col-span-full rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <CreditCard className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t('title')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {period ? t('subtitle', { period }) : t('subtitleEmpty')}
            </p>
          </div>
        </div>
        {total !== null && (
          <div className="text-right">
            <p className="text-[28px] leading-none font-bold tabular-nums text-foreground">
              {total}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('total')}</p>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

function Note({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <p className={`text-xs text-muted-foreground ${className ?? ''}`}>
      {children}
    </p>
  )
}
