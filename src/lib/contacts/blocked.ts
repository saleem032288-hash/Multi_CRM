import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Contact blocking is backed by a reserved account tag. Keeping it as a
 * plain tag means it survives reloads, syncs across every agent's device,
 * and shows up in the existing tag UI without any schema changes.
 */
export const BLOCKED_TAG_NAME = 'Blocked'
export const BLOCKED_TAG_COLOR = '#ef4444'

export function isBlockedTagName(name: string | null | undefined): boolean {
  return name?.trim().toLowerCase() === BLOCKED_TAG_NAME.toLowerCase()
}

export function isContactBlocked(
  tags: ReadonlyArray<{ name: string }> | null | undefined,
): boolean {
  return (tags ?? []).some((tag) => isBlockedTagName(tag.name))
}

type ContactTagRow = {
  tags: { name: string }[] | { name: string } | null
}

export async function isContactBlockedById(
  client: SupabaseClient,
  contactId: string,
): Promise<boolean> {
  const { data } = await client
    .from('contact_tags')
    .select('tags(name)')
    .eq('contact_id', contactId)

  return ((data ?? []) as ContactTagRow[]).some((row) => {
    const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags
    return isBlockedTagName(tag?.name)
  })
}
