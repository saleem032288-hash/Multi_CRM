"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  connectionDisplayName,
  connectionLabel,
  type WhatsAppConnection,
} from "@/lib/whatsapp/connection-types";
import {
  Search,
  ChevronDown,
  X,
  Check,
  CheckSquare,
  Trash2,
  Loader2,
  Layers,
  Phone,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  /** Every WhatsApp number connected to the account. */
  connections?: WhatsAppConnection[];
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Fired after a bulk delete succeeds so the page can clear the active
   * thread if it was among the deleted conversations and resync other
   * panes. Optional so existing callers keep working.
   */
  onConversationsDeleted?: (ids: string[]) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  connections = [],
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onConversationsDeleted,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  // null = "All Numbers". Otherwise only conversations that belong to
  // the selected WhatsApp connection are shown.
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Bulk delete: selection mode is scoped to the currently filtered rows.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // Local refetch trigger after a delete, in addition to the parent's
  // resyncToken (which may not change if the parent chooses not to bump).
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
    // `refreshNonce` refetches immediately after our own bulk delete.
  }, [resyncToken, refreshNonce]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const connectionById = useMemo(() => {
    const map = new Map<string, WhatsAppConnection>();
    for (const connection of connections) map.set(connection.id, connection);
    return map;
  }, [connections]);

  const filtered = useMemo(() => {
    let result = conversations;

    // Number filter. Threads created before migration 049 carry no
    // connection id; they remain visible under "All Numbers".
    if (selectedConnectionId) {
      result = result.filter(
        (c) => c.whatsapp_connection_id === selectedConnectionId,
      );
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    selectedConnectionId,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => !prev);
    setSelected(new Set());
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (filtered.length > 0 && filtered.every((c) => next.has(c.id))) {
        filtered.forEach((c) => next.delete(c.id));
      } else {
        filtered.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }, [filtered]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0 || bulkDeleting) return;
    const ids = [...selected];
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/inbox/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      const deletedIds: string[] = Array.isArray(payload?.ids)
        ? payload.ids
        : ids;
      toast.success(
        t("toastBulkDeleted", { count: payload?.deleted ?? deletedIds.length }),
      );
      setSelected(new Set());
      setSelectMode(false);
      setBulkDeleteOpen(false);
      onConversationsDeleted?.(deletedIds);
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network error";
      toast.error(t("toastBulkDeleteFailed", { reason }));
    } finally {
      setBulkDeleting(false);
    }
  }, [selected, bulkDeleting, t, onConversationsDeleted]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        {/* Connected WhatsApp numbers — "All Numbers" plus one selectable
            entry per connection (automatic number + custom name + the
            real phone number). Selecting one filters the inbox. */}
        {connections.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => setSelectedConnectionId(null)}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                selectedConnectionId === null
                  ? "bg-primary/5 text-primary"
                  : "text-foreground",
              )}
            >
              <Layers className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 font-medium">All Numbers</span>
              <span className="text-[10px] text-muted-foreground">
                {conversations.length}
              </span>
            </button>
            <div className="max-h-36 divide-y divide-border overflow-y-auto border-t border-border">
              {connections.map((connection) => {
                const active = selectedConnectionId === connection.id;
                const count = conversations.filter(
                  (c) => c.whatsapp_connection_id === connection.id,
                ).length;
                return (
                  <button
                    type="button"
                    key={connection.id}
                    onClick={() => setSelectedConnectionId(connection.id)}
                    className={cn(
                      "flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
                      active ? "bg-primary/5" : "",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                        active
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Phone className="h-3 w-3" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "text-[11px] font-semibold",
                            active ? "text-primary" : "text-foreground",
                          )}
                        >
                          {connectionLabel(connection)}
                        </span>
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            connection.connection_status === "active"
                              ? "bg-emerald-400"
                              : connection.connection_status === "error"
                                ? "bg-red-400"
                                : "bg-muted-foreground/60",
                          )}
                          title={connection.connection_status}
                        />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {connectionDisplayName(connection)}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {connection.phone_number || "Phone not available"}
                      </span>
                    </span>
                    <span className="mt-0.5 text-[10px] text-muted-foreground">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={toggleSelectMode}
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded-md px-2 h-7 text-xs hover:bg-muted",
              selectMode
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {selectMode ? t("cancelSelection") : t("selectChats")}
          </button>

          {selectMode && (
            <>
              <button
                onClick={toggleSelectAll}
                disabled={filtered.length === 0}
                className="inline-flex items-center justify-center rounded-md px-2 h-7 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {allFilteredSelected ? t("clearSelection") : t("selectAll")}
              </button>
              <span className="text-[11px] text-muted-foreground">
                {t("selectedCount", { count: selected.size })}
              </span>
              <button
                onClick={() => setBulkDeleteOpen(true)}
                disabled={selected.size === 0}
                className="ml-auto inline-flex items-center justify-center gap-1 rounded-md px-2 h-7 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("deleteSelected")}
              </button>
            </>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                connection={
                  conv.whatsapp_connection_id
                    ? connectionById.get(conv.whatsapp_connection_id) ?? null
                    : null
                }
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                selectMode={selectMode}
                selected={selected.has(conv.id)}
                onToggleSelect={toggleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteBulkTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteBulkDesc", { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={bulkDeleting}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-destructive px-3 text-sm text-white hover:bg-destructive/90 disabled:opacity-50"
            >
              {bulkDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("deleteSelected")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// How many assigned tags render inline next to the contact name before
// overflowing into a "+N" chip. Keeps rows compact when a contact carries
// many tags while still signalling "has more".
const MAX_INLINE_TAGS = 2;

interface ConversationItemProps {
  conversation: Conversation;
  /** Which connected number owns this thread (null on legacy rows). */
  connection: WhatsAppConnection | null;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  t: ReturnType<typeof useTranslations>;
}

/**
 * Small compact badge showing one assigned tag. Reuses the exact colour
 * configured for the tag (tinted background + solid text), matching the
 * Contact sidebar and the rest of the app — no separate colour system.
 */
function TagBadge({ tag }: { tag: Tag }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-none transition-colors"
      style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
    >
      {tag.name}
    </span>
  );
}

function ConversationItem({
  conversation,
  connection,
  isActive,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const assignedTags = contact?.tags ?? [];
  const visibleTags = assignedTags.slice(0, MAX_INLINE_TAGS);
  const overflowTagCount = Math.max(0, assignedTags.length - MAX_INLINE_TAGS);

  const handleClick = useCallback(() => {
    if (selectMode) onToggleSelect(conversation.id);
    else onSelect(conversation);
  }, [onSelect, conversation, selectMode, onToggleSelect]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      aria-pressed={selectMode ? selected : undefined}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70",
        selectMode && selected && "bg-primary/5"
      )}
    >
      {selectMode && (
        <span
          aria-hidden
          className={cn(
            "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-card"
          )}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      )}
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {visibleTags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
            {overflowTagCount > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("moreTags", { count: overflowTagCount })}
              </span>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {connection && (
              <span
                className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
                title={`${connectionLabel(connection)} · ${connectionDisplayName(connection)} · ${connection.phone_number ?? ""}`}
              >
                {connectionLabel(connection)}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
