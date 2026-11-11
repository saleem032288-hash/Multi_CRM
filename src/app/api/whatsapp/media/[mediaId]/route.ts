import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { loadConnectionCredentials } from '@/lib/whatsapp/connections'

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

    // Which connection owns this media? Prefer an explicit
    // `?connection_id=`, then the message row that references this
    // proxy id, then the account's first connection. Meta media ids are
    // scoped to the WABA, so using the owning number's token matters.
    let connectionId =
      new URL(request.url).searchParams.get('connection_id') || null
    if (!connectionId) {
      const { data: messageRow } = await supabase
        .from('messages')
        .select('whatsapp_connection_id')
        .ilike('media_url', `%${mediaId}%`)
        .not('whatsapp_connection_id', 'is', null)
        .limit(1)
        .maybeSingle()
      connectionId =
        (messageRow?.whatsapp_connection_id as string | null | undefined) ??
        null
    }

    let accessToken: string
    try {
      const loaded = await loadConnectionCredentials(
        supabase,
        accountId,
        connectionId,
      )
      accessToken = loaded.accessToken
    } catch {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    // Get the download URL from Meta
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
