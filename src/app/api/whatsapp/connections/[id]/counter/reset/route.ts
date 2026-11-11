import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getAccountConnection } from '@/lib/whatsapp/connections';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/whatsapp/connections/:id/counter/reset
 *
 * Resets ONLY this connection's service-message counter. The RPC is
 * SECURITY DEFINER and checks account membership itself; it also writes
 * an audit row with the previous count so resets have a history.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 });
    }

    const { supabase, accountId } = await requireRole('agent');

    const connection = await getAccountConnection(supabase, accountId, id);
    if (!connection) {
      return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
    }

    const { data, error } = await supabase.rpc(
      'reset_whatsapp_message_counter',
      { p_connection_id: id },
    );

    if (error) {
      console.error('[counter-reset] RPC failed:', error);
      return NextResponse.json(
        { error: error.message || 'Failed to reset the counter.' },
        { status: 500 },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    return NextResponse.json({
      success: true,
      connection_id: id,
      service_messages_count: row?.service_messages_count ?? 0,
      last_reset_at: row?.last_reset_at ?? new Date().toISOString(),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
