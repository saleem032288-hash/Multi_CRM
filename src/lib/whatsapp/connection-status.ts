// ============================================================
// Live connection status probe.
//
// Answers "is this WhatsApp number actually operational?" from the
// official Cloud API, without inventing anything:
//
//   * API reachability      — GET /{phone_number_id} succeeds
//   * phone status          — phone.status (CONNECTED/DISCONNECTED/…)
//   * verified number       — phone.code_verification_status
//   * quality / name        — quality_rating, name_status
//   * messaging limit       — whatsapp_business_manager_messaging_limit
//                             (falling back to the older tier field)
//   * WABA review status    — account_review_status
//   * webhook subscription  — subscribed_apps contains our app
//
// Every value Meta omits is reported as NOT_AVAILABLE. A successful
// credential check does NOT imply "Active": that requires the phone
// status and verification to back it up.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getPhoneNumberHealth,
  getPhoneNumberPicture,
  getSubscribedApps,
  getWabaReviewStatus,
} from '@/lib/whatsapp/meta-api';
import { appSubscriptionState } from '@/lib/whatsapp/waba-pairing';
import type { WhatsAppConnectionWithCredentials } from '@/lib/whatsapp/connections';

export const NOT_AVAILABLE = 'NOT_AVAILABLE';

export type ConnectionState =
  | 'connected'
  | 'active'
  | 'inactive'
  | 'disconnected'
  | 'error';

export interface ConnectionStatusReport {
  connection_id: string;
  checked_at: string;
  connection_status: ConnectionState;
  verification_status: 'verified' | 'unverified' | 'unknown' | 'not_available';
  api: {
    reachable: boolean;
    error: string | null;
  };
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
  /** Fields Meta did not return; the UI renders these as Not available. */
  unavailable: string[];
}

function valueOrNa(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : NOT_AVAILABLE;
}

/**
 * Probe every status surface Meta exposes for this connection, persist
 * the result (row + status log) and return the report. Never throws for
 * Meta-side failures — an API error becomes `connection_status: 'error'`
 * with the message, which is exactly what the UI must show.
 */
export async function probeConnectionStatus(
  db: SupabaseClient,
  connection: WhatsAppConnectionWithCredentials,
  accessToken: string,
): Promise<ConnectionStatusReport> {
  const checkedAt = new Date().toISOString();
  const unavailable: string[] = [];

  let health;
  let apiError: string | null = null;
  try {
    health = await getPhoneNumberHealth({
      phoneNumberId: connection.phone_number_id,
      accessToken,
    });
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
    health = null;
  }

  const picture = health
    ? await getPhoneNumberPicture({
        phoneNumberId: connection.phone_number_id,
        accessToken,
      })
    : null;

  let subscribed: boolean | null = null;
  let accountReviewStatus: string = NOT_AVAILABLE;
  if (connection.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: connection.waba_id,
        accessToken,
      });
      subscribed = appSubscriptionState(
        subs,
        connection.app_id ?? process.env.META_APP_ID,
      ).subscribed;
      if (subscribed === null) unavailable.push('waba_subscription');
    } catch {
      unavailable.push('waba_subscription');
    }

    const waba = await getWabaReviewStatus({
      wabaId: connection.waba_id,
      accessToken,
    });
    if (waba?.account_review_status) {
      accountReviewStatus = waba.account_review_status;
    } else {
      unavailable.push('account_review_status');
    }
  } else {
    unavailable.push('waba_subscription', 'account_review_status');
  }

  if (!health) {
    unavailable.push(
      'phone_status',
      'phone_verification',
      'quality_rating',
      'name_status',
      'messaging_limit',
    );
  } else {
    if (!health.status) unavailable.push('phone_status');
    if (!health.code_verification_status) unavailable.push('phone_verification');
    if (!health.quality_rating) unavailable.push('quality_rating');
    if (!health.name_status) unavailable.push('name_status');
    if (
      !health.whatsapp_business_manager_messaging_limit &&
      !health.messaging_limit_tier
    ) {
      unavailable.push('messaging_limit');
    }
  }

  const phoneStatus = valueOrNa(health?.status);
  const codeVerification = valueOrNa(health?.code_verification_status);

  const verificationStatus: ConnectionStatusReport['verification_status'] =
    health == null
      ? 'unknown'
      : codeVerification === 'VERIFIED'
        ? 'verified'
        : codeVerification === 'UNVERIFIED'
          ? 'unverified'
          : 'not_available';

  // Active means Meta says the number is connected AND the number is
  // verified. Reachable-but-unknown stays "connected" — never "active".
  let connectionStatus: ConnectionState;
  if (apiError) {
    connectionStatus = 'error';
  } else if (phoneStatus === 'CONNECTED') {
    connectionStatus = verificationStatus === 'verified' ? 'active' : 'connected';
  } else if (phoneStatus === NOT_AVAILABLE) {
    connectionStatus = 'connected';
  } else if (phoneStatus === 'DISCONNECTED') {
    connectionStatus = 'disconnected';
  } else {
    // RESTRICTED / DELETED / MIGRATED / FLAGGED / …
    connectionStatus = 'inactive';
  }

  const report: ConnectionStatusReport = {
    connection_id: connection.id,
    checked_at: checkedAt,
    connection_status: connectionStatus,
    verification_status: verificationStatus,
    api: { reachable: health != null, error: apiError },
    phone: {
      status: phoneStatus,
      code_verification_status: codeVerification,
      quality_rating: valueOrNa(health?.quality_rating),
      name_status: valueOrNa(health?.name_status),
      messaging_limit: valueOrNa(
        health?.whatsapp_business_manager_messaging_limit ??
          health?.messaging_limit_tier,
      ),
      account_mode: valueOrNa(health?.account_mode),
      official_business_account:
        typeof health?.is_official_business_account === 'boolean'
          ? health.is_official_business_account
          : null,
      display_phone_number: health?.display_phone_number ?? null,
      verified_name: health?.verified_name ?? null,
    },
    waba: {
      id: connection.waba_id,
      account_review_status: accountReviewStatus,
      subscribed_to_app: subscribed,
    },
    profile_picture_url: picture?.url ?? null,
    unavailable,
  };

  // Persist the snapshot. The legacy `status` column keeps existing
  // readers working; the richer state lives in connection_status.
  // Identity fields are only written when Meta actually returned them —
  // a transient API failure must not blank out a previously verified
  // phone number / profile name / picture.
  const snapshot: Record<string, unknown> = {
    connection_status: connectionStatus,
    verification_status: verificationStatus,
    status: apiError ? 'disconnected' : 'connected',
    last_status_check_at: checkedAt,
    last_status_error: apiError,
    status_details: report,
    updated_at: checkedAt,
  };
  if (report.phone.display_phone_number) {
    snapshot.phone_number = report.phone.display_phone_number;
  }
  if (report.phone.verified_name) {
    snapshot.profile_name = report.phone.verified_name;
  }
  if (report.profile_picture_url) {
    snapshot.profile_picture_url = report.profile_picture_url;
  }
  // quality_rating is not a whatsapp_config column — it is already in
  // `status_details` above and in the status-log row below.

  const { error: updateError } = await db
    .from('whatsapp_config')
    .update(snapshot)
    .eq('id', connection.id);

  if (updateError) {
    console.error(
      '[connection-status] failed to persist status snapshot:',
      updateError.message,
    );
  }

  const { error: logError } = await db
    .from('whatsapp_connection_status_logs')
    .insert({
      account_id: connection.account_id,
      whatsapp_connection_id: connection.id,
      connection_status: connectionStatus,
      verification_status: verificationStatus,
      phone_number_verified: verificationStatus === 'verified',
      quality_rating:
        report.phone.quality_rating === NOT_AVAILABLE
          ? null
          : report.phone.quality_rating,
      messaging_limit:
        report.phone.messaging_limit === NOT_AVAILABLE
          ? null
          : report.phone.messaging_limit,
      error_message: apiError,
      details: report,
      checked_at: checkedAt,
    });

  if (logError) {
    console.error(
      '[connection-status] failed to write status log:',
      logError.message,
    );
  }

  return report;
}
