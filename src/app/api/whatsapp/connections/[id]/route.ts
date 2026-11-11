import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  CONNECTION_PUBLIC_COLUMNS,
  getAccountConnection,
  loadConnectionCredentials,
} from '@/lib/whatsapp/connections';
import {
  ConnectionError,
  saveConnection,
} from '@/lib/whatsapp/connection-service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/whatsapp/connections/:id
 *
 * Edits one connection and revalidates it with Meta before saving.
 * Fields not supplied keep their stored values. Access token / app
 * secret are never returned to the client.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 });
    }

    const { supabase, accountId, userId } = await requireRole('admin');

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    let loaded;
    try {
      loaded = await loadConnectionCredentials(supabase, accountId, id);
    } catch {
      return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
    }
    const { connection, accessToken: storedToken } = loaded;

    const newToken =
      typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const effectiveToken = newToken || storedToken;

    const phoneNumberId =
      typeof body.phone_number_id === 'string' && body.phone_number_id.trim()
        ? body.phone_number_id.trim()
        : connection.phone_number_id;
    const wabaId =
      typeof body.waba_id === 'string' ? body.waba_id.trim() : connection.waba_id;
    const appId =
      typeof body.app_id === 'string' && body.app_id.trim()
        ? body.app_id.trim()
        : connection.app_id;
    const verifyToken =
      typeof body.verify_token === 'string' ? body.verify_token : '';
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const appSecret =
      typeof body.app_secret === 'string' ? body.app_secret : '';
    const connectionName =
      typeof body.connection_name === 'string'
        ? body.connection_name
        : connection.connection_name ?? '';
    const phoneNumber =
      typeof body.phone_number === 'string'
        ? body.phone_number
        : connection.phone_number ?? '';

    const result = await saveConnection(supabase, {
      accountId,
      userId,
      effectiveAccessToken: effectiveToken,
      existing: {
        id: connection.id,
        phone_number_id: connection.phone_number_id,
        waba_id: connection.waba_id,
        access_token: connection.access_token,
        app_secret: connection.app_secret,
        app_id: connection.app_id,
        registered_at: connection.registered_at,
        connection_number: connection.connection_number,
      },
      input: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: effectiveToken,
        verify_token: verifyToken,
        pin,
        app_id: appId,
        app_secret: appSecret,
        connection_name: connectionName,
        phone_number: phoneNumber,
      },
    });

    const { data: rows } = await supabase
      .from('whatsapp_config')
      .select(CONNECTION_PUBLIC_COLUMNS)
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1);

    // Read the stored secret after the save (an edit that leaves the
    // field blank keeps the existing value) so the response reflects
    // reality rather than what the request happened to carry. Only the
    // boolean leaves the server.
    const { data: secretRows } = await supabase
      .from('whatsapp_config')
      .select('app_secret')
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1);
    const appSecretSet = Boolean(secretRows?.[0]?.app_secret);
    const webhookReady =
      appSecretSet || Boolean(process.env.META_APP_SECRET?.trim());
    const saved = (rows?.[0] ?? null) as Record<string, unknown> | null;

    return NextResponse.json({
      success: !result.registrationError,
      connection: saved
        ? {
            ...saved,
            app_secret_set: appSecretSet,
            webhook_ready: webhookReady,
          }
        : null,
      webhook_warning: webhookReady
        ? null
        : 'No Meta App Secret is saved for this connection, so Meta webhook deliveries are rejected with 401. Inbound messages and delivery receipts will not arrive until you add it.',
      phone_info: result.phoneInfo,
      registration_skipped: result.registrationSkipped,
      registration_error: result.registrationError,
      meta: result.registrationMeta,
    });
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

/**
 * DELETE /api/whatsapp/connections/:id
 *
 * Removes ONLY this connection. Conversations / messages / templates /
 * broadcasts keep their history — their connection columns are
 * `ON DELETE SET NULL`, so the Inbox still shows past threads (as
 * "unknown number") and broadcast history survives.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 });
    }

    const { supabase, accountId } = await requireRole('admin');

    const existing = await getAccountConnection(supabase, accountId, id);
    if (!existing) {
      return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('Error deleting WhatsApp connection:', error);
      return NextResponse.json(
        { error: 'Failed to delete the connection.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
