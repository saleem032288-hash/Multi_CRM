// ============================================================
// Multi-connection helpers.
//
// `whatsapp_config` is the per-account list of WhatsApp Cloud API
// connections (migration 049). Every backend path that used to assume
// "the one config row for this account" resolves a connection here
// instead, either by an explicit id coming from the UI or by falling
// back to the account's first (lowest-numbered) connection.
//
// The public (`*_PUBLIC_COLUMNS`) select intentionally excludes the
// encrypted credential columns so a browser-scoped client can list
// connections without ever pulling ciphertext.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  CONNECTION_PUBLIC_COLUMNS,
  type WhatsAppConnection,
} from '@/lib/whatsapp/connection-types';

export type { WhatsAppConnection } from '@/lib/whatsapp/connection-types';
export { CONNECTION_PUBLIC_COLUMNS } from '@/lib/whatsapp/connection-types';
export {
  connectionDisplayName,
  connectionFullLabel,
  connectionLabel,
} from '@/lib/whatsapp/connection-types';

export const CONNECTION_CREDENTIAL_COLUMNS = `${CONNECTION_PUBLIC_COLUMNS}, access_token, verify_token, app_secret, app_id`;

export interface WhatsAppConnectionWithCredentials extends WhatsAppConnection {
  access_token: string;
  verify_token: string | null;
  app_secret: string | null;
}

/** All connections for an account, lowest connection number first. */
export async function listAccountConnections(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppConnection[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CONNECTION_PUBLIC_COLUMNS)
    .eq('account_id', accountId)
    .order('connection_number', { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as WhatsAppConnection[];
}

/**
 * Resolve one connection for `accountId`. When `connectionId` is
 * supplied it must belong to the account (otherwise null); when it is
 * omitted the account's first connection is returned.
 */
export async function getAccountConnection(
  db: SupabaseClient,
  accountId: string,
  connectionId?: string | null,
): Promise<WhatsAppConnectionWithCredentials | null> {
  let query = db
    .from('whatsapp_config')
    .select(CONNECTION_CREDENTIAL_COLUMNS)
    .eq('account_id', accountId);

  if (connectionId) {
    query = query.eq('id', connectionId);
  } else {
    query = query.order('connection_number', { ascending: true }).limit(1);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as unknown as WhatsAppConnectionWithCredentials[];
  return rows[0] ?? null;
}

export class ConnectionCredentialsError extends Error {
  readonly code: 'whatsapp_not_configured' | 'whatsapp_credentials_corrupted';
  constructor(
    code: 'whatsapp_not_configured' | 'whatsapp_credentials_corrupted',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionCredentialsError';
    this.code = code;
  }
}

/**
 * Resolve a connection plus its decrypted access token. Throws the two
 * failure modes callers need to distinguish: no connection at all, and
 * a stored token that the current ENCRYPTION_KEY cannot decrypt.
 */
export async function loadConnectionCredentials(
  db: SupabaseClient,
  accountId: string,
  connectionId?: string | null,
): Promise<{
  connection: WhatsAppConnectionWithCredentials;
  accessToken: string;
}> {
  const connection = await getAccountConnection(db, accountId, connectionId);
  if (!connection) {
    throw new ConnectionCredentialsError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
    );
  }

  let accessToken: string;
  try {
    accessToken = decrypt(connection.access_token);
  } catch {
    throw new ConnectionCredentialsError(
      'whatsapp_credentials_corrupted',
      'The stored WhatsApp access token could not be decrypted. Re-save your WhatsApp connection (the ENCRYPTION_KEY may have changed).',
    );
  }

  return { connection, accessToken };
}

/**
 * The connection a conversation belongs to. Null for legacy threads
 * created before migration 049 that have not sent/received since.
 */
export async function getConversationConnectionId(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('conversations')
    .select('whatsapp_connection_id')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) throw error;
  return (data?.whatsapp_connection_id as string | null | undefined) ?? null;
}

/** Next free connection number (1-based, never reuses a deleted slot). */
export async function nextConnectionNumber(
  db: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('connection_number')
    .eq('account_id', accountId)
    .order('connection_number', { ascending: false })
    .limit(1);

  if (error) throw error;
  const max = (data?.[0]?.connection_number as number | undefined) ?? 0;
  return max + 1;
}
