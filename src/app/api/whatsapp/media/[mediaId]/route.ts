import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { MIRROR_BUCKET, MIRROR_FOLDER } from '@/lib/whatsapp/mirror-inbound-media'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    // Storage first: a mirrored attachment already lives at a
    // deterministic, account-scoped path. Redirecting to that public URL
    // avoids two Meta round trips on every view (the old path, which
    // made the image spinner last for minutes whenever Meta/CDN stalled).
    // The listing stays inside the caller's account folder, so a guessed
    // media id from another account cannot resolve here.
    const folder = `account-${accountId}/${MIRROR_FOLDER}`
    const { data: mirrored, error: listError } = await supabase.storage
      .from(MIRROR_BUCKET)
      .list(folder, { limit: 1000, sortBy: { column: 'name', order: 'asc' } })

    if (!listError && mirrored?.length) {
      // Mirrored object names start with Meta's media id (see
      // `mirrorFileName`), and `list()` returns names relative to `folder`.
      const object = mirrored.find((item) => item.name.startsWith(mediaId))
      if (object) {
        const {
          data: { publicUrl },
        } = supabase.storage
          .from(MIRROR_BUCKET)
          .getPublicUrl(`${folder}/${object.name}`)
        if (publicUrl) return NextResponse.redirect(publicUrl, 307)
      }
    }

    const accessToken = decrypt(config.access_token)

    // Legacy / mirror-failed media: fall back to Meta (now bounded by
    // a timeout in both helpers).
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
