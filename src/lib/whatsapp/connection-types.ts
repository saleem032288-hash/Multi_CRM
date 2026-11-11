// Shared, client-safe types + labels for WhatsApp connections.
// Deliberately has no server imports (no encryption / Supabase client),
// so 'use client' components can use it without dragging server-only
// crypto into the browser bundle.

/**
 * Columns safe to send to the browser — deliberately excludes every
 * encrypted credential column. Shared by server and client so the
 * Inbox / Broadcast UI can list numbers without ciphertext.
 */
export const CONNECTION_PUBLIC_COLUMNS = [
  'id',
  'account_id',
  'user_id',
  'connection_number',
  'connection_name',
  'phone_number',
  'phone_number_id',
  'waba_id',
  'profile_name',
  'profile_picture_url',
  'status',
  'connection_status',
  'verification_status',
  'registered_at',
  'subscribed_apps_at',
  'last_registration_error',
  'last_status_check_at',
  'last_status_error',
  'status_details',
  'last_webhook_at',
  'mirror_inbound_media',
  'app_id',
  'created_at',
  'updated_at',
].join(', ');

export interface WhatsAppConnection {
  id: string;
  account_id: string;
  user_id: string;
  connection_number: number;
  connection_name: string | null;
  phone_number: string | null;
  phone_number_id: string;
  waba_id: string | null;
  profile_name: string | null;
  profile_picture_url: string | null;
  status: string;
  connection_status: string;
  verification_status: string;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  last_status_check_at: string | null;
  last_status_error: string | null;
  status_details: Record<string, unknown> | null;
  last_webhook_at: string | null;
  mirror_inbound_media: boolean | null;
  app_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ConnectionState =
  | 'connected'
  | 'active'
  | 'inactive'
  | 'disconnected'
  | 'error';

export interface ConnectionCounter {
  whatsapp_connection_id: string;
  service_messages_count: number;
  last_reset_at: string | null;
  updated_at: string | null;
}

/**
 * Webhook readiness, derived on the server from the encrypted row plus
 * the deployment-wide env fallback. The browser never receives the
 * secret itself — only whether one exists and whether an inbound Meta
 * signature can be verified at all.
 *
 * Both flags are optional because not every caller of the connection
 * shape asks the API for them; `=== false` means "known to be missing",
 * `undefined` means "not reported".
 */
export interface ConnectionCredentialReadiness {
  /** This row has its own Meta App Secret stored (encrypted). */
  app_secret_set?: boolean;
  /** A webhook signature can be verified: own secret or env fallback. */
  webhook_ready?: boolean;
}

export interface WhatsAppConnectionWithCounter
  extends WhatsAppConnection,
    ConnectionCredentialReadiness {
  counter?: ConnectionCounter;
}

/** Automatic label, e.g. `Number 2`. Always available. */
export function connectionLabel(
  connection: Pick<WhatsAppConnection, 'connection_number'> | null | undefined,
): string {
  const n = connection?.connection_number;
  return typeof n === 'number' && n > 0 ? `Number ${n}` : 'Number —';
}

/**
 * Human name shown next to the automatic number: the custom name typed
 * at connection time (falling back to the Meta profile name, then the
 * automatic label).
 */
export function connectionDisplayName(
  connection:
    | Pick<
        WhatsAppConnection,
        'connection_number' | 'connection_name' | 'profile_name'
      >
    | null
    | undefined,
): string {
  const custom = connection?.connection_name?.trim();
  if (custom) return custom;
  const profile = connection?.profile_name?.trim();
  if (profile) return profile;
  return connectionLabel(connection);
}

/** Full one-line label: `Number 2 · Support line · +15551234567`. */
export function connectionFullLabel(
  connection:
    | Pick<
        WhatsAppConnection,
        'connection_number' | 'connection_name' | 'profile_name' | 'phone_number'
      >
    | null
    | undefined,
): string {
  if (!connection) return 'No WhatsApp number';
  const parts = [connectionLabel(connection)];
  const name =
    connection.connection_name?.trim() || connection.profile_name?.trim();
  if (name) parts.push(name);
  if (connection.phone_number) parts.push(connection.phone_number);
  return parts.join(' · ');
}
