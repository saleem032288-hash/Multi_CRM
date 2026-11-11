import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

import {
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  CONNECTION_PUBLIC_COLUMNS,
  listAccountConnections,
} from '@/lib/whatsapp/connections';
import {
  ConnectionError,
  saveConnection,
} from '@/lib/whatsapp/connection-service';

// Service-role client used only to detect a phone_number_id already
// claimed by a DIFFERENT account — RLS hides those rows from the
// caller's session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

/**
 * GET /api/whatsapp/connections
 *
 * Lists every WhatsApp connection on the caller's account, lowest
 * connection number first, together with its independent
 * service-message counter. Tokens are never selected.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const connections = await listAccountConnections(supabase, accountId);

    const { data: counters } = await supabase
      .from('whatsapp_message_counters')
      .select(
        'whatsapp_connection_id, service_messages_count, last_reset_at, updated_at',
      )
      .eq('account_id', accountId);

    const counterByConnection = new Map(
      (counters ?? []).map((c) => [c.whatsapp_connection_id as string, c]),
    );

    // Per-connection Meta App Secret presence, so the UI can warn about
    // connections whose inbound webhook deliveries would be rejected
    // with 401. The ciphertext never leaves the server — only a boolean.
    const { data: secretRows, error: secretError } = await supabase
      .from('whatsapp_config')
      .select('id, app_secret')
      .eq('account_id', accountId);

    if (secretError) {
      // Non-fatal: the caller still needs the connection list. Leaving the
      // readiness flags undefined keeps the UI from claiming a secret is
      // missing when we simply could not read it.
      console.warn(
        '[connections] could not read app_secret presence:',
        secretError.message,
      );
    }

    const secretByConnection = new Map(
      (secretRows ?? []).map((row) => [
        row.id as string,
        Boolean((row as { app_secret?: string | null }).app_secret),
      ]),
    );
    const envSecretConfigured = Boolean(process.env.META_APP_SECRET?.trim());
    const canReportReadiness = !secretError;

    return NextResponse.json({
      connections: connections.map((connection) => {
        const appSecretSet = secretByConnection.get(connection.id) === true;
        return {
          ...connection,
          app_secret_set: canReportReadiness ? appSecretSet : undefined,
          webhook_ready: canReportReadiness
            ? appSecretSet || envSecretConfigured
            : undefined,
          counter: counterByConnection.get(connection.id) ?? {
            whatsapp_connection_id: connection.id,
            service_messages_count: 0,
            last_reset_at: null,
            updated_at: null,
          },
        };
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/whatsapp/connections
 *
 * Creates one additional connection. Credentials are verified against
 * the Cloud API first and the row is only written after verification;
 * a connection is never shown as active before it has been verified.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 },
      );
    }

    const phoneNumberId =
      typeof body.phone_number_id === 'string'
        ? body.phone_number_id.trim()
        : '';
    const wabaId = typeof body.waba_id === 'string' ? body.waba_id.trim() : '';
    const accessToken =
      typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const verifyToken =
      typeof body.verify_token === 'string' ? body.verify_token : '';
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const appId = typeof body.app_id === 'string' ? body.app_id.trim() : '';
    const appSecret =
      typeof body.app_secret === 'string' ? body.app_secret : '';
    const connectionName =
      typeof body.connection_name === 'string' ? body.connection_name : '';
    const phoneNumber =
      typeof body.phone_number === 'string' ? body.phone_number : '';

    if (!phoneNumberId) {
      return NextResponse.json(
        { error: 'Phone Number ID is required.', field: 'phone_number_id' },
        { status: 400 },
      );
    }
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Access token is required for a new connection.', field: 'access_token' },
        { status: 400 },
      );
    }
    const hasEnvSecret = Boolean(process.env.META_APP_SECRET?.trim());
    if (!appSecret.trim() && !hasEnvSecret) {
      return NextResponse.json(
        {
          error:
            'Meta App Secret is required for a new connection. Enter it here so webhook signatures can be verified per-connection.',
          field: 'app_secret',
        },
        { status: 400 },
      );
    }

    // A number can only be connected once across the whole instance.
    const { data: claimed } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .limit(1);
    if (claimed && claimed.length > 0) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected once.',
        },
        { status: 409 },
      );
    }

    const result = await saveConnection(supabase, {
      accountId,
      userId,
      effectiveAccessToken: accessToken,
      input: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId || null,
        access_token: accessToken,
        verify_token: verifyToken,
        pin,
        app_id: appId || null,
        app_secret: appSecret,
        connection_name: connectionName,
        phone_number: phoneNumber,
      },
    });

    // Seed the independent counter so the new number shows 0 straight
    // away (the trigger creates it on the first message otherwise).
    await supabase.from('whatsapp_message_counters').insert({
      whatsapp_connection_id: result.connectionId,
      account_id: accountId,
      service_messages_count: 0,
    });

    const { data: createdRows } = await supabase
      .from('whatsapp_config')
      .select(CONNECTION_PUBLIC_COLUMNS)
      .eq('id', result.connectionId)
      .eq('account_id', accountId)
      .limit(1);

    // A new connection needs its own secret unless the deployment still
    // runs on the shared env fallback — report readiness so the UI can
    // warn instead of letting the first webhook delivery 401 silently.
    const appSecretSet = Boolean(appSecret.trim());
    const webhookReady = appSecretSet || hasEnvSecret;
    const created = (createdRows?.[0] ?? null) as Record<string, unknown> | null;

    return NextResponse.json(
      {
        success: !result.registrationError,
        connection: created
          ? {
              ...created,
              app_secret_set: appSecretSet,
              webhook_ready: webhookReady,
            }
          : null,
        webhook_warning: webhookReady
          ? null
          : 'No Meta App Secret is saved for this connection, so Meta webhook deliveries are rejected with 401. Edit the connection and add the App Secret.',
        phone_info: result.phoneInfo,
        registered: !result.registrationError && result.registrationSkipped === false,
        registration_skipped: result.registrationSkipped,
        registration_error: result.registrationError,
        meta: result.registrationMeta,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ConnectionError) {
      return NextResponse.json(
        { error: error.message, field: error.field, meta: error.meta },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
