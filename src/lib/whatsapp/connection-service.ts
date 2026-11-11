// ============================================================
// Connection verification + persistence.
//
// One place for the Meta round-trips that turn user-entered
// credentials into a stored, webhook-wired connection:
//
//   verify phone metadata → verify the number belongs to the WABA →
//   subscribe the WABA to this app → register the number (PIN) →
//   encrypt credentials → insert/update the row.
//
// Used by /api/whatsapp/connections (create + edit). Nothing is
// persisted unless Meta verified the credentials; a failed /register
// still saves the (verified) rows but marks them unverified, matching
// the existing single-connection behaviour.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { encrypt } from '@/lib/whatsapp/encryption';
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain';
import {
  getPhoneNumberPicture,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@/lib/whatsapp/meta-api';
import {
  describeWabaPhoneMismatch,
  isNumericMetaId,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing';
import { nextConnectionNumber } from '@/lib/whatsapp/connections';

export interface ConnectionInput {
  phone_number_id: string;
  waba_id?: string | null;
  access_token?: string | null;
  verify_token?: string | null;
  pin?: string | null;
  app_id?: string | null;
  app_secret?: string | null;
  connection_name?: string | null;
  /**
   * The dialable number the user entered. Meta's display number is
   * authoritative and stored when returned; this is only a fallback
   * for the rare response that omits it.
   */
  phone_number?: string | null;
}

export interface ExistingConnection {
  id: string;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  app_secret: string | null;
  app_id: string | null;
  registered_at: string | null;
  connection_number: number;
}

export class ConnectionError extends Error {
  readonly status: number;
  readonly field?: string;
  readonly meta?: Record<string, unknown> | null;
  constructor(
    message: string,
    status: number,
    field?: string,
    meta?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
    this.field = field;
    this.meta = meta ?? null;
  }
}

/** Reject the classic paste mistakes with a named field. */
export function validateConnectionInput(input: ConnectionInput): void {
  if (!input.phone_number_id || !isNumericMetaId(input.phone_number_id)) {
    throw new ConnectionError(
      'Phone Number ID must contain only digits — it is the numeric id shown under Meta → WhatsApp → API Setup, not the phone number itself.',
      400,
      'phone_number_id',
    );
  }
  if (
    input.waba_id !== undefined &&
    input.waba_id !== null &&
    input.waba_id !== '' &&
    !isNumericMetaId(input.waba_id)
  ) {
    throw new ConnectionError(
      'WhatsApp Business Account ID must contain only digits — copy it from Meta → WhatsApp → API Setup.',
      400,
      'waba_id',
    );
  }
  if (
    input.app_id !== undefined &&
    input.app_id !== null &&
    input.app_id !== '' &&
    !isNumericMetaId(input.app_id)
  ) {
    throw new ConnectionError(
      'Meta App ID must contain only digits — copy it from Meta → App Settings → Basic.',
      400,
      'app_id',
    );
  }
  if (input.pin !== undefined && input.pin !== null && input.pin !== '') {
    if (typeof input.pin !== 'string' || !/^\d{6}$/.test(input.pin)) {
      throw new ConnectionError('PIN must be exactly 6 digits.', 400, 'pin');
    }
  }
}

function metaFailure(
  err: unknown,
  step: MetaConnectStep,
  ctx: MetaErrorContext,
): ConnectionError {
  const explained = explainMetaError(err, step, ctx);
  console.error(`[whatsapp/connections] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  });
  return new ConnectionError(
    explained.summary,
    explained.httpStatus,
    undefined,
    metaErrorPayload(explained) as unknown as Record<string, unknown>,
  );
}

export interface SaveConnectionArgs {
  accountId: string;
  userId: string;
  input: ConnectionInput;
  /** Present when editing an existing connection. */
  existing?: ExistingConnection | null;
  /** Resolved stored token when the edit omitted a new one. */
  effectiveAccessToken: string;
}

export interface SaveConnectionResult {
  connectionId: string;
  connectionNumber: number;
  phoneInfo: MetaPhoneInfo;
  registrationSkipped: boolean;
  registrationError: string | null;
  registrationMeta: Record<string, unknown> | null;
}

/**
 * Verify credentials with Meta, wire the WABA, then persist. Callers
 * must have already resolved `effectiveAccessToken` (new or stored).
 */
export async function saveConnection(
  db: SupabaseClient,
  args: SaveConnectionArgs,
): Promise<SaveConnectionResult> {
  const { accountId, userId, input, existing, effectiveAccessToken } = args;

  validateConnectionInput(input);

  const wabaId = input.waba_id || null;
  const metaCtx: MetaErrorContext = {
    phoneNumberId: input.phone_number_id,
    wabaId,
  };

  // ── 1. Credentials: does the phone number resolve? ─────────────
  let phoneInfo: MetaPhoneInfo;
  try {
    phoneInfo = await verifyPhoneNumber({
      phoneNumberId: input.phone_number_id,
      accessToken: effectiveAccessToken,
    });
  } catch (err) {
    throw metaFailure(err, 'verify_number', metaCtx);
  }

  // ── 2. The number must live under the WABA the user typed. ─────
  if (wabaId) {
    let wabaNumbers;
    try {
      wabaNumbers = await listWabaPhoneNumbers({
        wabaId,
        accessToken: effectiveAccessToken,
      });
    } catch (err) {
      throw metaFailure(err, 'waba_phone_numbers', metaCtx);
    }
    if (!phoneNumberBelongsToWaba(wabaNumbers, input.phone_number_id)) {
      throw new ConnectionError(
        describeWabaPhoneMismatch(
          wabaNumbers,
          input.phone_number_id,
          wabaId,
        ),
        400,
        'waba_id',
      );
    }
  }

  // ── 3. Subscribe the WABA to this app (required for webhooks). ─
  let subscribedAppsAt: string | null = null;
  if (wabaId) {
    try {
      await subscribeWabaToApp({
        wabaId,
        accessToken: effectiveAccessToken,
      });
      subscribedAppsAt = new Date().toISOString();
    } catch (err) {
      throw metaFailure(err, 'subscribe_waba', metaCtx);
    }
  }

  // ── 4. Register the number for inbound routing (best-effort). ──
  const sameNumber =
    existing?.phone_number_id === input.phone_number_id &&
    existing?.registered_at != null;
  const pin = input.pin;
  const needsRegistration =
    !sameNumber || (typeof pin === 'string' && pin.length > 0);

  let registeredAt: string | null = existing?.registered_at ?? null;
  let registrationError: string | null = null;
  let registrationMeta: Record<string, unknown> | null = null;
  let registrationSkipped = false;

  if (needsRegistration) {
    if (!pin) {
      // Meta TEST numbers have no two-step PIN; production numbers need
      // one. Skip and let the UI surface "not registered" rather than
      // claiming the number is fully live.
      registrationSkipped = true;
    } else {
      try {
        await registerPhoneNumber({
          phoneNumberId: input.phone_number_id,
          accessToken: effectiveAccessToken,
          pin,
        });
        registeredAt = new Date().toISOString();
      } catch (err) {
        const explained = explainMetaError(err, 'register', metaCtx);
        registrationError = explained.summary;
        registrationMeta = metaErrorPayload(explained) as unknown as Record<
          string,
          unknown
        >;
        console.error(
          '[whatsapp/connections] Phone number /register failed:',
          explained.metaMessage,
          registrationMeta,
        );
        registeredAt = null;
      }
    }
  }

  // ── 5. Encrypt + persist. Nothing sensitive is returned. ───────
  const encryptedAccessToken = encrypt(effectiveAccessToken);
  const encryptedVerifyToken =
    input.verify_token && input.verify_token.trim()
      ? encrypt(input.verify_token.trim())
      : null;
  const encryptedAppSecret =
    input.app_secret &&
    input.app_secret.trim() &&
    input.app_secret.trim() !== '••••••••••••••••'
      ? encrypt(input.app_secret.trim())
      : null;

  const connectionNumber =
    existing?.connection_number ??
    (await nextConnectionNumber(db, accountId));

  // Best-effort profile picture (public CDN URL, never the token).
  const picture = await getPhoneNumberPicture({
    phoneNumberId: input.phone_number_id,
    accessToken: effectiveAccessToken,
  });

  const row: Record<string, unknown> = {
    account_id: accountId,
    user_id: userId,
    connection_number: connectionNumber,
    connection_name: input.connection_name?.trim() || null,
    phone_number_id: input.phone_number_id,
    waba_id: wabaId,
    app_id: input.app_id?.trim() || existing?.app_id || null,
    access_token: encryptedAccessToken,
    status: registrationError ? 'disconnected' : 'connected',
    connection_status: registrationError ? 'error' : 'connected',
    verification_status: registrationError
      ? 'unverified'
      : registeredAt != null
        ? 'verified'
        : 'unknown',
    phone_number:
      phoneInfo.display_phone_number ??
      (input.phone_number?.trim() || null),
    profile_name: phoneInfo.verified_name ?? null,
    profile_picture_url: picture?.url ?? null,
    quality_rating: phoneInfo.quality_rating ?? null,
    connected_at: registrationError ? null : new Date().toISOString(),
    registered_at: registrationError ? null : registeredAt,
    subscribed_apps_at: subscribedAppsAt,
    last_registration_error: registrationError,
    updated_at: new Date().toISOString(),
  };

  if (encryptedVerifyToken) row.verify_token = encryptedVerifyToken;
  if (encryptedAppSecret) row.app_secret = encryptedAppSecret;

  let connectionId = existing?.id ?? '';

  if (existing) {
    // Never clear a stored verify_token / app_secret on an edit that
    // did not provide a new value.
    const { error } = await db
      .from('whatsapp_config')
      .update(row)
      .eq('id', existing.id)
      .eq('account_id', accountId);
    if (error) {
      throw new ConnectionError(
        `Failed to update the connection: ${error.message}`,
        500,
      );
    }
  } else {
    const { data: inserted, error } = await db
      .from('whatsapp_config')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConnectionError(
          'This WhatsApp phone number is already linked to another connection on this instance. Each phone number can only be connected once.',
          409,
          'phone_number_id',
        );
      }
      throw new ConnectionError(
        `Failed to save the connection: ${error.message}`,
        500,
      );
    }
    connectionId = (inserted as { id: string }).id;
  }

  return {
    connectionId,
    connectionNumber,
    phoneInfo,
    registrationSkipped,
    registrationError,
    registrationMeta,
  };
}
