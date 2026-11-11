'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Phone,
  ShieldCheck,
  Wifi,
  Activity,
  KeyRound,
  ExternalLink,
  Copy,
  Webhook,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import {
  connectionDisplayName,
  connectionLabel,
  type WhatsAppConnectionWithCounter,
} from '@/lib/whatsapp/connection-types';
import { cn } from '@/lib/utils';

// Status refresh cadence. Meta rate-limits per app, so this is
// deliberately slower than the inbox realtime channel; the manual
// button always re-probes on demand.
const AUTO_REFRESH_MS = 180_000;
const MASKED = '••••••••••••••••';
const META_ID_RE = /^\d+$/;

interface StatusReport {
  checked_at: string;
  connection_status: string;
  verification_status: string;
  api: { reachable: boolean; error: string | null };
  phone: {
    status: string;
    code_verification_status: string;
    quality_rating: string;
    name_status: string;
    messaging_limit: string;
    account_mode: string;
    official_business_account: boolean | null;
    display_phone_number: string | null;
    verified_name: string | null;
  };
  waba: {
    id: string | null;
    account_review_status: string;
    subscribed_to_app: boolean | null;
  };
  profile_picture_url: string | null;
  unavailable: string[];
}

interface FormState {
  connection_name: string;
  phone_number: string;
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  verify_token: string;
  pin: string;
  app_id: string;
  app_secret: string;
}

const EMPTY_FORM: FormState = {
  connection_name: '',
  phone_number: '',
  phone_number_id: '',
  waba_id: '',
  access_token: '',
  verify_token: '',
  pin: '',
  app_id: '',
  app_secret: '',
};

const STATE_STYLES: Record<
  string,
  { label: string; className: string; dot: string }
> = {
  active: {
    label: 'Active',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    dot: 'bg-emerald-400',
  },
  connected: {
    label: 'Connected',
    className: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
    dot: 'bg-sky-400',
  },
  inactive: {
    label: 'Inactive',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    dot: 'bg-amber-400',
  },
  disconnected: {
    label: 'Disconnected',
    className: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  error: {
    label: 'Error',
    className: 'border-red-500/30 bg-red-500/10 text-red-400',
    dot: 'bg-red-400',
  },
};

function stateStyle(state: string | undefined) {
  return STATE_STYLES[state ?? ''] ?? STATE_STYLES.disconnected;
}

function isNotAvailable(value: string | null | undefined): boolean {
  return !value || value === 'NOT_AVAILABLE';
}

function displayValue(value: string | null | undefined): string {
  return isNotAvailable(value) ? 'Not available' : value!;
}

function formatChecked(value: string | null | undefined): string {
  if (!value) return 'Never checked';
  return `Checked ${new Date(value).toLocaleString()}`;
}

export function WhatsAppConfig() {
  const { canEditSettings } = useAuth();

  const [connections, setConnections] = useState<WhatsAppConnectionWithCounter[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, StatusReport>>({});
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] =
    useState<WhatsAppConnectionWithCounter | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Callback URL to paste into Meta → WhatsApp → Configuration. Resolved
  // on the client so the server render has no origin to guess at. The
  // endpoint is account-wide: every connection receives deliveries on
  // the same URL and its own verify token / app secret scope them.
  const [webhookUrl, setWebhookUrl] = useState('');
  useEffect(() => {
    setWebhookUrl(`${window.location.origin}/api/whatsapp/webhook`);
  }, []);

  // The connection currently open in the edit dialog. Used to tell the
  // user whether a Meta App Secret is already stored (leave the field
  // blank to keep it) or is missing (webhooks would 401).
  const editingConnection = editingId
    ? connections.find((c) => c.id === editingId) ?? null
    : null;

  const formOpenRef = useRef(false);
  useEffect(() => {
    formOpenRef.current = formOpen;
  }, [formOpen]);
  const deleteOpenRef = useRef(false);
  useEffect(() => {
    deleteOpenRef.current = deleteTarget !== null;
  }, [deleteTarget]);

  const load = useCallback(async (): Promise<WhatsAppConnectionWithCounter[]> => {
    try {
      const res = await fetch('/api/whatsapp/connections', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const list = (data.connections ?? []) as WhatsAppConnectionWithCounter[];
      setConnections(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load connections.',
      );
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async (connectionId: string) => {
    setRefreshing((prev) => ({ ...prev, [connectionId]: true }));
    try {
      const res = await fetch(
        `/api/whatsapp/connections/${connectionId}/status`,
        { cache: 'no-store' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const report = data.status as StatusReport;
      setStatuses((prev) => ({ ...prev, [connectionId]: report }));
      // Keep the card's stored snapshot in sync (phone / picture).
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connectionId
            ? {
                ...c,
                connection_status: report.connection_status,
                verification_status: report.verification_status,
                phone_number: report.phone.display_phone_number ?? c.phone_number,
                profile_name: report.phone.verified_name ?? c.profile_name,
                profile_picture_url:
                  report.profile_picture_url ?? c.profile_picture_url,
                last_status_check_at: report.checked_at,
                last_status_error: report.api.error,
                status_details: report as unknown as Record<string, unknown>,
              }
            : c,
        ),
      );
      return report;
    } catch (err) {
      console.error('[settings/whatsapp] status refresh failed:', err);
      return null;
    } finally {
      setRefreshing((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  const refreshAll = useCallback(
    async (list?: WhatsAppConnectionWithCounter[]) => {
      const current = list ?? connections;
      for (const connection of current) {
        await refreshStatus(connection.id);
      }
    },
    [connections, refreshStatus],
  );

  // Initial load + one live probe per connection.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await load();
      if (cancelled) return;
      await refreshAll(list);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic refresh — paused while a dialog is open or the tab is hidden.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (formOpenRef.current || deleteOpenRef.current) return;
      void refreshAll();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  function openAdd() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(connection: WhatsAppConnectionWithCounter) {
    setEditingId(connection.id);
    setForm({
      connection_name: connection.connection_name ?? '',
      phone_number: connection.phone_number ?? '',
      phone_number_id: connection.phone_number_id,
      waba_id: connection.waba_id ?? '',
      access_token: '',
      verify_token: '',
      pin: '',
      app_id: connection.app_id ?? '',
      app_secret: '',
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function handleSave() {
    if (saving) return;

    if (!META_ID_RE.test(form.phone_number_id.trim())) {
      setFormError(
        'Phone Number ID must contain only digits — it is the numeric id from Meta → WhatsApp → API Setup, not the phone number.',
      );
      return;
    }
    if (form.waba_id.trim() && !META_ID_RE.test(form.waba_id.trim())) {
      setFormError('WhatsApp Business Account ID must contain only digits.');
      return;
    }
    if (form.app_id.trim() && !META_ID_RE.test(form.app_id.trim())) {
      setFormError('Meta App ID must contain only digits.');
      return;
    }
    if (!editingId && !form.access_token.trim()) {
      setFormError('Access token is required for a new connection.');
      return;
    }
    if (form.pin.trim() && !/^\d{6}$/.test(form.pin.trim())) {
      setFormError('PIN must be exactly 6 digits.');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        connection_name: form.connection_name.trim(),
        phone_number: form.phone_number.trim(),
        phone_number_id: form.phone_number_id.trim(),
        waba_id: form.waba_id.trim(),
        access_token: form.access_token.trim() || undefined,
        verify_token: form.verify_token.trim() || undefined,
        pin: form.pin.trim() || undefined,
        app_id: form.app_id.trim() || undefined,
        app_secret: form.app_secret.trim() || undefined,
      };

      const res = await fetch(
        editingId
          ? `/api/whatsapp/connections/${editingId}`
          : '/api/whatsapp/connections',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setFormError(data?.error || `Save failed (HTTP ${res.status}).`);
        return;
      }

      if (data.registration_error) {
        toast.warning(
          `Connection saved but not fully registered: ${data.registration_error}`,
          { duration: 10000 },
        );
      } else if (data.registration_skipped) {
        toast.warning(
          'Credentials verified and saved. No PIN was supplied, so inbound webhook registration was skipped — add the 6-digit PIN and save again to make the number live.',
          { duration: 10000 },
        );
      } else {
        toast.success(
          editingId ? 'Connection updated and verified.' : 'WhatsApp connection added.',
        );
      }

      // Surfaced at save time so a missing Meta App Secret is fixed now
      // rather than discovered later through silent webhook 401s.
      if (typeof data.webhook_warning === 'string' && data.webhook_warning) {
        toast.warning(data.webhook_warning, { duration: 12000 });
      }

      setFormOpen(false);
      const list = await load();
      const saved = data.connection as WhatsAppConnectionWithCounter | null;
      if (saved?.id) await refreshStatus(saved.id);
      else await refreshAll(list);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Failed to save the connection.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyWebhookUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success('Webhook URL copied.');
    } catch {
      toast.error('Could not copy — select the URL and copy it manually.');
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/whatsapp/connections/${deleteTarget.id}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `Delete failed (HTTP ${res.status}).`);
        return;
      }
      toast.success(`${connectionLabel(deleteTarget)} deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title="WhatsApp connections"
        description="Connect any number of WhatsApp Business API numbers. Each connection has its own credentials, templates, inbox filtering and service-message counter."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshAll()}
            disabled={connections.length === 0}
            className="border-border text-muted-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh status
          </Button>
        }
      />

      {!canEditSettings && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <AlertTitle className="text-amber-400">Read-only access</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Only account owners and admins can add, edit or delete WhatsApp
            connections.
          </AlertDescription>
        </Alert>
      )}

      <Card className="border-border bg-card">
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start gap-2">
            <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                Webhook callback URL
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste this URL as the Callback URL in Meta App Dashboard →
                WhatsApp → Configuration, and subscribe to the{' '}
                <span className="font-mono">messages</span> field. Every
                connection on this account receives deliveries here; each
                one&apos;s verify token and App Secret keep it scoped to its
                own number.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              readOnly
              value={webhookUrl}
              placeholder="Loading…"
              className="border-border bg-muted font-mono text-xs text-muted-foreground"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => void handleCopyWebhookUrl()}
              disabled={!webhookUrl}
              title="Copy webhook URL"
              className="shrink-0 border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : loadError ? (
        <Alert className="border-red-500/30 bg-red-500/5">
          <XCircle className="h-4 w-4 text-red-400" />
          <AlertTitle className="text-red-400">Could not load connections</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {loadError}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {connections.map((connection) => {
            const report = statuses[connection.id];
            const state = stateStyle(
              report?.connection_status ?? connection.connection_status,
            );
            const busy = refreshing[connection.id];
            const phoneStatus =
              report?.phone.status ??
              (connection.status_details?.phone as { status?: string } | undefined)
                ?.status;
            const verification =
              report?.verification_status ?? connection.verification_status;
            const quality =
              report?.phone.quality_rating ??
              (connection.status_details?.phone as
                | { quality_rating?: string }
                | undefined)?.quality_rating;
            const limit =
              report?.phone.messaging_limit ??
              (connection.status_details?.phone as
                | { messaging_limit?: string }
                | undefined)?.messaging_limit;
            const wabaReview =
              report?.waba.account_review_status ??
              (connection.status_details?.waba as
                | { account_review_status?: string }
                | undefined)?.account_review_status;
            const subscribed =
              report?.waba.subscribed_to_app ??
              (connection.status_details?.waba as
                | { subscribed_to_app?: boolean | null }
                | undefined)?.subscribed_to_app;

            return (
              <Card
                key={connection.id}
                className="relative overflow-hidden border-border bg-card"
              >
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                      {connection.profile_picture_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={connection.profile_picture_url}
                          alt=""
                          className="h-11 w-11 rounded-full object-cover"
                        />
                      ) : (
                        <Phone className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          {connectionLabel(connection)}
                        </span>
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {connectionDisplayName(connection)}
                        </h3>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {connection.phone_number || 'Phone number not available'}
                      </p>
                    </div>

                    <div className="flex items-center gap-1">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                          state.className,
                        )}
                      >
                        <span className={cn('h-1.5 w-1.5 rounded-full', state.dot)} />
                        {state.label}
                      </span>
                    </div>
                  </div>

                  <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Phone Number ID</dt>
                      <dd className="truncate font-mono text-foreground">
                        {connection.phone_number_id}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">WABA ID</dt>
                      <dd className="truncate font-mono text-foreground">
                        {connection.waba_id || 'Not set'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Business profile</dt>
                      <dd className="truncate text-foreground">
                        {connection.profile_name || 'Not available'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Number verification</dt>
                      <dd className="flex items-center gap-1.5 text-foreground">
                        {verification === 'verified' ? (
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                        )}
                        {verification === 'verified'
                          ? 'Verified'
                          : verification === 'unverified'
                            ? 'Unverified'
                            : verification === 'unknown'
                              ? 'Unknown'
                              : 'Not available'}
                      </dd>
                    </div>
                  </dl>

                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-[11px]">
                    <StatusLine
                      icon={<Wifi className="h-3 w-3" />}
                      label="Phone active"
                      value={displayValue(phoneStatus)}
                    />
                    <StatusLine
                      icon={<Activity className="h-3 w-3" />}
                      label="Quality"
                      value={displayValue(quality)}
                    />
                    <StatusLine
                      icon={<KeyRound className="h-3 w-3" />}
                      label="Messaging limit"
                      value={displayValue(limit)}
                    />
                    <StatusLine
                      icon={<ShieldCheck className="h-3 w-3" />}
                      label="Account review"
                      value={displayValue(wabaReview)}
                    />
                    <StatusLine
                      icon={
                        subscribed === true ? (
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                        ) : subscribed === false ? (
                          <XCircle className="h-3 w-3 text-red-400" />
                        ) : (
                          <AlertTriangle className="h-3 w-3" />
                        )
                      }
                      label="Webhook subscription"
                      value={
                        subscribed === true
                          ? 'Subscribed'
                          : subscribed === false
                            ? 'Not subscribed'
                            : 'Not available'
                      }
                    />
                    <StatusLine
                      icon={<RefreshCw className="h-3 w-3" />}
                      label="Last check"
                      value={
                        connection.last_status_check_at
                          ? new Date(
                              connection.last_status_check_at,
                            ).toLocaleTimeString()
                          : 'Never'
                      }
                    />
                  </div>

                  {(report?.api.error || connection.last_status_error) && (
                    <p className="rounded-md border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-400">
                      {report?.api.error ?? connection.last_status_error}
                    </p>
                  )}

                  {connection.webhook_ready === false && (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-400">
                      No Meta App Secret saved — Meta&apos;s webhook deliveries
                      for this number are rejected with 401, so inbound
                      messages and delivery receipts never arrive. Edit this
                      connection and add the App Secret.
                    </p>
                  )}

                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <span className="text-[11px] text-muted-foreground">
                      {formatChecked(connection.last_status_check_at)}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void refreshStatus(connection.id)}
                        disabled={busy}
                        className="h-7 px-2 text-xs text-muted-foreground"
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Refresh
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(connection)}
                        disabled={!canEditSettings}
                        title="Edit connection"
                        className="h-7 w-7 text-muted-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(connection)}
                        disabled={!canEditSettings}
                        title="Delete connection"
                        className="h-7 w-7 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <button
            type="button"
            onClick={openAdd}
            disabled={!canEditSettings}
            className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 p-5 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium">Add WhatsApp Connection</span>
            <span className="max-w-[220px] text-center text-[11px] text-muted-foreground">
              Connect another WhatsApp Business API number. There is no limit
              beyond Meta&apos;s own account limits.
            </span>
          </button>
        </div>
      )}

      {/* Add / edit form */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (!saving) setFormOpen(open);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-card sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {editingId ? 'Edit WhatsApp connection' : 'Add WhatsApp connection'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Credentials are verified with the official Cloud API before
              anything is saved. Access tokens are encrypted and never shown
              again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <FormField
              label="Connection name"
              hint="A label for your team, e.g. “Support line”."
            >
              <Input
                value={form.connection_name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, connection_name: e.target.value }))
                }
                placeholder="Support line"
                className="border-border bg-muted text-foreground"
              />
            </FormField>

            <FormField
              label="WhatsApp phone number"
              hint="The dialable number, e.g. +15551234567. Meta's verified number is stored when it is returned."
            >
              <Input
                value={form.phone_number}
                onChange={(e) =>
                  setForm((f) => ({ ...f, phone_number: e.target.value }))
                }
                placeholder="+15551234567"
                className="border-border bg-muted text-foreground"
              />
            </FormField>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Phone Number ID" required hint="Digits only.">
                <Input
                  value={form.phone_number_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, phone_number_id: e.target.value }))
                  }
                  placeholder="123456789012345"
                  inputMode="numeric"
                  className="border-border bg-muted font-mono text-foreground"
                />
              </FormField>
              <FormField
                label="WhatsApp Business Account ID (WABA)"
                hint="Digits only."
              >
                <Input
                  value={form.waba_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, waba_id: e.target.value }))
                  }
                  placeholder="987654321098765"
                  inputMode="numeric"
                  className="border-border bg-muted font-mono text-foreground"
                />
              </FormField>
            </div>

            <FormField
              label="Permanent access token"
              required={!editingId}
              hint={
                editingId
                  ? 'Leave blank to keep the stored token. Enter a new one to rotate it.'
                  : 'System User token with whatsapp_business_messaging and whatsapp_business_management.'
              }
            >
              <Input
                type="password"
                autoComplete="off"
                value={form.access_token}
                onChange={(e) =>
                  setForm((f) => ({ ...f, access_token: e.target.value }))
                }
                placeholder={editingId ? MASKED : 'EAAG...'}
                className="border-border bg-muted font-mono text-foreground"
              />
            </FormField>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Meta App ID"
                hint="Optional — used for image-header template uploads."
              >
                <Input
                  value={form.app_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, app_id: e.target.value }))
                  }
                  placeholder="1234567890"
                  inputMode="numeric"
                  className="border-border bg-muted font-mono text-foreground"
                />
              </FormField>
              <FormField
                label="Meta App Secret"
                hint={
                  editingConnection
                    ? editingConnection.app_secret_set === false
                      ? undefined
                      : 'Already saved — leave blank to keep the stored secret.'
                    : 'Required so webhook signatures can be verified.'
                }
                warning={
                  editingConnection?.app_secret_set === false
                    ? 'No App Secret is stored for this connection. Webhook deliveries are rejected with 401 until you enter it and save.'
                    : undefined
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={form.app_secret}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, app_secret: e.target.value }))
                  }
                  placeholder={editingId ? MASKED : 'App secret'}
                  className="border-border bg-muted font-mono text-foreground"
                />
              </FormField>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Webhook verify token"
                hint="Must match the token in Meta → WhatsApp → Configuration."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={form.verify_token}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, verify_token: e.target.value }))
                  }
                  placeholder={editingId ? 'Leave blank to keep' : 'Verify token'}
                  className="border-border bg-muted text-foreground"
                />
              </FormField>
              <FormField
                label="Two-step PIN (6 digits)"
                hint="Needed to register a production number for inbound webhooks."
              >
                <Input
                  value={form.pin}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pin: e.target.value }))
                  }
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={6}
                  className="border-border bg-muted font-mono text-foreground"
                />
              </FormField>
            </div>

            {formError && (
              <Alert className="border-red-500/30 bg-red-500/5">
                <XCircle className="h-4 w-4 text-red-400" />
                <AlertDescription className="text-xs text-red-400">
                  {formError}
                </AlertDescription>
              </Alert>
            )}

            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              Where do I find these values?
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFormOpen(false)}
              disabled={saving}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Save and re-verify' : 'Connect WhatsApp API'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="border-border bg-card sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Delete {deleteTarget ? connectionLabel(deleteTarget) : 'connection'}?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This removes only this WhatsApp connection and its credentials.
              Conversations, messages, templates and broadcast history are kept
              — they simply become unlinked from the number.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormField({
  label,
  hint,
  warning,
  required,
  children,
}: {
  label: string;
  hint?: string;
  /** Amber, high-visibility variant of `hint` for save-blocking issues. */
  warning?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        {label}
        {required && <span className="text-primary"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      {warning && (
        <p className="flex items-start gap-1 text-[10px] text-amber-400">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

function StatusLine({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}:</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}
