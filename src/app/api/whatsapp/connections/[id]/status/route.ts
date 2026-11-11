import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadConnectionCredentials } from '@/lib/whatsapp/connections';
import { probeConnectionStatus } from '@/lib/whatsapp/connection-status';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/whatsapp/connections/:id/status
 *
 * Live status check against the official Cloud API. This is the only
 * source of the connection state shown in Settings — nothing is cached
 * as "Active" without a successful probe.
 *
 * Requires only 'viewer': the probe makes no writes beyond the status
 * snapshot + log, and the whole team needs to see whether a number is
 * usable.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 });
    }

    const { supabase, accountId } = await requireRole('viewer');

    let loaded;
    try {
      loaded = await loadConnectionCredentials(supabase, accountId, id);
    } catch {
      return NextResponse.json(
        { error: 'Connection not found, or its access token cannot be decrypted.' },
        { status: 404 },
      );
    }

    const report = await probeConnectionStatus(
      supabase,
      loaded.connection,
      loaded.accessToken,
    );

    return NextResponse.json({ success: true, status: report });
  } catch (error) {
    return toErrorResponse(error);
  }
}
