'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Radio,
  Plus,
  Loader2,
  RotateCcw,
  MessageCircle,
  Phone,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  connectionDisplayName,
  connectionLabel,
  type WhatsAppConnectionWithCounter,
} from '@/lib/whatsapp/connection-types';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

type BroadcastRow = Broadcast & {
  whatsapp_connection?: {
    connection_number: number;
    connection_name: string | null;
    phone_number: string | null;
  } | null;
};

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([]);
  const [connections, setConnections] = useState<
    WhatsAppConnectionWithCounter[]
  >([]);
  const [filterConnectionId, setFilterConnectionId] = useState<string>('all');
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      // Include the sending connection so history can show which number
      // each broadcast went out from (migration 049).
      const { data, error: fetchError } = await supabase
        .from('broadcasts')
        .select(
          '*, whatsapp_connection:whatsapp_config(connection_number, connection_name, phone_number)',
        )
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts((data ?? []) as unknown as BroadcastRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  // Connections + their independent service-message counters.
  const fetchConnections = async () => {
    try {
      const res = await fetch('/api/whatsapp/connections', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setConnections(
        (data.connections ?? []) as WhatsAppConnectionWithCounter[],
      );
    } catch (err) {
      console.error('[broadcasts] connections failed:', err);
    }
  };

  useEffect(() => {
    fetchBroadcasts();
    fetchConnections();
  }, []);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  const visibleBroadcasts = useMemo(
    () =>
      filterConnectionId === 'all'
        ? broadcasts
        : broadcasts.filter(
            (b) => b.whatsapp_connection_id === filterConnectionId,
          ),
    [broadcasts, filterConnectionId],
  );

  async function handleResetCounter(connection: WhatsAppConnectionWithCounter) {
    if (resettingId) return;
    const ok = window.confirm(
      `Reset the service-message counter for ${connectionLabel(connection)}? This only resets this number; other numbers are untouched.`,
    );
    if (!ok) return;

    setResettingId(connection.id);
    try {
      const res = await fetch(
        `/api/whatsapp/connections/${connection.id}/counter/reset`,
        { method: 'POST' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connection.id
            ? {
                ...c,
                counter: {
                  ...(c.counter ?? {
                    whatsapp_connection_id: c.id,
                    service_messages_count: 0,
                    last_reset_at: null,
                    updated_at: null,
                  }),
                  service_messages_count: 0,
                  last_reset_at: data.last_reset_at ?? new Date().toISOString(),
                },
              }
            : c,
        ),
      );
      toast.success(`Counter reset for ${connectionLabel(connection)}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to reset the counter.',
      );
    } finally {
      setResettingId(null);
    }
  }

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t('broadcastInProgress')}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create broadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('newBroadcast')}
        </GatedButton>
      </div>

      {/* Free service messages — one independent counter per connected
          WhatsApp number, reset individually. */}
      {connections.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MessageCircle className="h-4 w-4 text-primary" />
                Free service messages
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Outgoing free-form messages (agent + bot, excluding templates),
                counted independently per WhatsApp number.
              </p>
            </div>
          </div>
          <div className="divide-y divide-border">
            {connections.map((connection) => {
              const count = connection.counter?.service_messages_count ?? 0;
              return (
                <div
                  key={connection.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Phone className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {connectionLabel(connection)} ·{' '}
                      {connectionDisplayName(connection)}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {connection.phone_number || 'Phone not available'}
                      {connection.counter?.last_reset_at
                        ? ` · last reset ${new Date(
                            connection.counter.last_reset_at,
                          ).toLocaleDateString()}`
                        : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {count.toLocaleString()}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      service messages
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleResetCounter(connection)}
                    disabled={resettingId === connection.id || count === 0}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    {resettingId === connection.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Reset counter
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('createFirst')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      ) : (
        <div className="space-y-3">
          {/* History filter — All Broadcasts or one specific number. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              Broadcast history
            </h2>
            <select
              value={filterConnectionId}
              onChange={(e) => setFilterConnectionId(e.target.value)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary/50"
            >
              <option value="all">All Broadcasts</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connectionLabel(connection)} ·{' '}
                  {connectionDisplayName(connection)}
                </option>
              ))}
            </select>
          </div>

          {visibleBroadcasts.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-border bg-card">
              <Radio className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No broadcasts for this WhatsApp number yet.
              </p>
            </div>
          ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">{t('table.template')}</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  {t('table.recipients')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.delivery')}</TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.read')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">{t('table.date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleBroadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                return (
                  <TableRow
                    key={broadcast.id}
                    className="cursor-pointer border-border hover:bg-muted/50"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                  >
                    <TableCell className="font-medium text-foreground">
                      {broadcast.name}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      <span className="block">{broadcast.template_name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {broadcast.whatsapp_connection
                          ? `${connectionLabel({
                              connection_number:
                                broadcast.whatsapp_connection.connection_number,
                            })}${broadcast.whatsapp_connection.phone_number ? ` · ${broadcast.whatsapp_connection.phone_number}` : ''}`
                          : 'Unknown number'}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                      {broadcast.total_recipients}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.delivered_count}
                        total={broadcast.total_recipients}
                        color="bg-primary"
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.read_count}
                        total={broadcast.total_recipients}
                        color="bg-blue-500"
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                      >
                        {status.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                          </span>
                        )}
                        {tStatus(status.label)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {new Date(broadcast.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
          )}
        </div>
      )}
    </div>
  );
}
