import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    })
  }

  // Optional `?connection_id=` targets one of several connections;
  // without it the account's first connection is diagnosed.
  const requestedConnectionId =
    new URL(request.url).searchParams.get('connection_id') || null
  let configQuery = supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
  if (requestedConnectionId) {
    configQuery = configQuery.eq('id', requestedConnectionId)
  } else {
    configQuery = configQuery
      .order('connection_number', { ascending: true })
      .limit(1)
  }
  const { data: configRows } = await configQuery
  const config = configRows?.[0]

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  }

  // Heartbeat freshness (migration 047). registered_at proves WE wired
  // Meta correctly; last_webhook_at is the only column that answers
  // "is Meta still delivering?" — a silently dropped 'messages' field
  // subscription leaves every credential check green while the inbox
  // starves, and the only symptom is this timestamp going stale.
  const lastWebhookAt = (config as { last_webhook_at?: string | null })
    .last_webhook_at
  const lastWebhookAgeHours =
    lastWebhookAt != null
      ? (Date.now() - new Date(lastWebhookAt).getTime()) / 3_600_000
      : null
  const heartbeatFresh = lastWebhookAgeHours != null && lastWebhookAgeHours <= 24
  const warnings: string[] = []
  if (lastWebhookAt == null) {
    warnings.push(
      'No webhook delivery has ever been authenticated for this connection — Meta has never reached the webhook endpoint. Check the webhook URL and the app-level "messages" field subscription.',
    )
  } else if (!heartbeatFresh) {
    warnings.push(
      `Last authenticated webhook delivery was ${Math.floor(lastWebhookAgeHours ?? 0)}h ago — Meta has stopped delivering events. Credentials can still be valid; re-subscribe the WABA and the "messages" field (Settings → Verify with Meta, or the Meta App Dashboard → WhatsApp → Configuration).`,
    )
  }
  const errors: string[] = []

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.',
        )
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
    )
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    errors,
    // Non-fatal: the pipe may look fully wired but be silently dead.
    // The UI surfaces this as a warning banner under the diagnostic.
    warnings,
    heartbeat: {
      last_webhook_at: lastWebhookAt ?? null,
      age_hours: lastWebhookAgeHours,
      fresh: heartbeatFresh,
    },
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
