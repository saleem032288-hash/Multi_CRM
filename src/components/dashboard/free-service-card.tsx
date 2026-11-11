'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageCircle, RotateCcw, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { loadFreeServiceUsage } from '@/lib/dashboard/queries'
import type { FreeServiceUsage } from '@/lib/dashboard/types'
import { SkeletonCard } from './skeleton'
import {
  CONNECTION_PUBLIC_COLUMNS,
  type WhatsAppConnection,
} from '@/lib/whatsapp/connection-types'

const RESET_STORAGE_PREFIX = 'wacrm:free-service-reset:'

function resetStorageKey(accountId: string): string {
  return `${RESET_STORAGE_PREFIX}${accountId}`
}

function readResetAt(accountId: string): Date | null {
  try {
    const raw = localStorage.getItem(resetStorageKey(accountId))
    if (!raw) return null
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
    return null
  }
}

interface ConnectionUsage {
  connection: WhatsAppConnection
  usage: FreeServiceUsage
}

/**
 * Current-month count of outgoing free-form messages (agent + bot,
 * excluding templates). Shown per connected WhatsApp number so each
 * number's free-service usage is tracked independently. The reset
 * button starts a fresh window from "now" for the whole account;
 * the month boundary still resets automatically.
 */
export function FreeServiceCard() {
  const t = useTranslations('Dashboard.freeService')
  const { accountId } = useAuth()

  const [connections, setConnections] = useState<WhatsAppConnection[]>([])
  const [usages, setUsages] = useState<ConnectionUsage[]>([])
  const [combinedUsage, setCombinedUsage] = useState<FreeServiceUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [resetting, setResetting] = useState(false)

  const load = useCallback(async () => {
    if (!accountId) return
    try {
      const db = createClient()
      const { data } = await db
        .from('whatsapp_config')
        .select(CONNECTION_PUBLIC_COLUMNS)
        .eq('account_id', accountId)
        .order('connection_number', { ascending: true })
      const conns = (data ?? []) as unknown as WhatsAppConnection[]
      setConnections(conns)

      const resetAt = readResetAt(accountId)
      if (conns.length === 0) {
        const next = await loadFreeServiceUsage(db, resetAt)
        setCombinedUsage(next)
        setUsages([])
      } else {
        const nextUsages = await Promise.all(
          conns.map(async (connection) => ({
            connection,
            usage: await loadFreeServiceUsage(db, resetAt, connection.id),
          })),
        )
        setUsages(nextUsages)
        setCombinedUsage(null)
      }
      setError(false)
    } catch (err) {
      console.error('[dashboard] free-service usage failed:', err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  const handleReset = useCallback(async () => {
    if (!accountId || resetting) return
    setResetting(true)
    try {
      localStorage.setItem(resetStorageKey(accountId), new Date().toISOString())
    } catch {
      // Persistence is best-effort; still refresh the count below.
    }
    await load()
    toast.success(t('resetSuccess'))
    setResetting(false)
  }, [accountId, resetting, load, t])

  if (loading) return <SkeletonCard />

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">
          {t('title')}
        </p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <MessageCircle className="h-4 w-4" />
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('loadError')}</p>
      ) : connections.length === 0 && combinedUsage ? (
        <>
          <p className="mt-3 text-[28px] leading-none font-bold tabular-nums text-foreground">
            {combinedUsage.count.toLocaleString()}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('subtitle', {
              date: new Date(combinedUsage.since).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              }),
            })}
          </p>
        </>
      ) : (
        <div className="mt-3 space-y-2">
          {usages.map(({ connection, usage }) => (
            <div
              key={connection.id}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-xs text-muted-foreground">
                Number {connection.connection_number}
              </span>
              <span className="text-sm font-bold tabular-nums text-foreground">
                {usage.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleReset}
          disabled={resetting || !accountId}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {resetting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          {t('reset')}
        </button>
      </div>
    </div>
  )
}