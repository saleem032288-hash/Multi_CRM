'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import {
  CONNECTION_PUBLIC_COLUMNS,
  connectionDisplayName,
  connectionLabel,
  type WhatsAppConnection,
} from '@/lib/whatsapp/connection-types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight, RefreshCw, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate | null) => void;
  /** Connected WhatsApp number the broadcast will send from. */
  connectionId: string | null;
  onConnectionChange: (connectionId: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({
  selectedTemplate,
  onSelect,
  connectionId,
  onConnectionChange,
  onNext,
  onBack,
}: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [connections, setConnections] = useState<WhatsAppConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );

  // Load the account's numbers once. Preselect the first connection when
  // the wizard has no selection yet, so the template list is never
  // ambiguous.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        setLoadingConnections(false);
        setLoading(false);
        return;
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setLoadingConnections(false);
        setLoading(false);
        return;
      }

      const { data, error: connectionError } = await supabase
        .from('whatsapp_config')
        .select(CONNECTION_PUBLIC_COLUMNS)
        .eq('account_id', accountId)
        .order('connection_number', { ascending: true });

      if (cancelled) return;
      if (connectionError) {
        setError(connectionError.message);
      }
      const rows = (data ?? []) as unknown as WhatsAppConnection[];
      setConnections(rows);
      if (!connectionId && rows.length > 0) {
        onConnectionChange(rows[0].id);
      }
      setLoadingConnections(false);
    })();
    return () => {
      cancelled = true;
    };
    // Only run on mount — connectionId changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTemplates = useCallback(
    async (forConnectionId: string | null) => {
      if (!forConnectionId) {
        setTemplates([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta, and only
        // templates that belong to the selected number/WABA may be
        // shown. The backend enforces the same scope again at send time.
        const { data, error: fetchError } = await supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .eq('whatsapp_connection_id', forConnectionId)
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('chooseTemplate.errorLoad'),
        );
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (loadingConnections) return;
    if (!connectionId) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    void fetchTemplates(connectionId);
    // If the selected template belongs to a different number, drop it —
    // sending it through this number would be rejected by Meta.
    if (
      selectedTemplate &&
      (selectedTemplate as MessageTemplate & {
        whatsapp_connection_id?: string | null;
      }).whatsapp_connection_id !== connectionId
    ) {
      onSelect(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, loadingConnections, fetchTemplates]);

  async function handleScanTemplates() {
    if (!connectionId || scanning) return;
    setScanning(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Template scan failed (HTTP ${res.status}).`);
      }
      toast.success(
        `Templates scanned: ${data.total ?? 0} found for ${connectionLabel(
          selectedConnection,
        )}.`,
      );
      await fetchTemplates(connectionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Template scan failed.');
    } finally {
      setScanning(false);
    }
  }

  if (loadingConnections) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('chooseTemplate.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('chooseTemplate.subtitle')}
          </p>
        </div>
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <Phone className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No WhatsApp number is connected yet.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add a connection in Settings → WhatsApp connections first.
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button
            variant="outline"
            onClick={onBack}
            className="border-border text-muted-foreground"
          >
            {t('back')}
          </Button>
          <Button
            onClick={onNext}
            disabled
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('next')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('chooseTemplate.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {/* Number selection + template scan. Templates are fetched per
          selected WABA, so Number 1 and Number 2 never share a list. */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/50 p-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="broadcast-connection"
            className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Send from WhatsApp number
          </label>
          <select
            id="broadcast-connection"
            value={connectionId ?? ''}
            onChange={(e) => onConnectionChange(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary/50"
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connectionLabel(connection)} ·{' '}
                {connectionDisplayName(connection)}
                {connection.phone_number ? ` · ${connection.phone_number}` : ''}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          onClick={() => void handleScanTemplates()}
          disabled={scanning || !connectionId}
          className="shrink-0 border-border text-muted-foreground"
        >
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Scan Templates
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No approved templates found for {connectionLabel(selectedConnection)}.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one in Settings → Templates, then click Scan Templates.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor =
              categoryColors[template.category] ?? categoryColors.Utility;
            // Broadcasts can fill body variables per recipient but have
            // no way to supply a TEXT-header variable, so Meta rejects
            // every send for these. Disable them rather than letting the
            // user launch a campaign that can't deliver.
            const headerVarUnsupported =
              template.header_type === 'text' &&
              extractVariableIndices(template.header_content ?? '').length > 0;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                disabled={headerVarUnsupported}
                title={
                  headerVarUnsupported
                    ? t('chooseTemplate.headerVarUnsupported')
                    : undefined
                }
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  headerVarUnsupported
                    ? 'cursor-not-allowed border-border bg-card/30 opacity-60'
                    : isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-medium text-foreground">
                    {template.name}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">
                  {template.body_text}
                </p>
                {headerVarUnsupported && (
                  <p className="text-[10px] font-medium text-amber-400">
                    {t('chooseTemplate.headerVarUnsupported')}
                  </p>
                )}
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  <span>·</span>
                  <span>{connectionLabel(selectedConnection)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate || !connectionId}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
