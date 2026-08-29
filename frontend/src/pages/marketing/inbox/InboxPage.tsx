import { lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui';
import { Settings, ArrowLeft } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { API_URL } from '../../../lib/env';
import { RouteFallback } from '../../../components/RouteFallback';
import { ConversationList } from './ConversationList';
import { ThreadPane } from './ThreadPane';
import { LeadContextPane } from './LeadContextPane';

// Lazy so a config tab's code only loads when opened — the inbox tab (the
// default, real-time surface) must never pay for the config pages' bundles.
// The contacts tab joins them for the same reason in reverse: /inbox must not
// pay for the leads table, and /leads must not pay for it twice.
const ChannelsSettingsPage = lazy(() => import('../ChannelsSettingsPage'));
const SnippetsPage = lazy(() => import('../settings/snippets'));
const AgentStudioPage = lazy(() => import('../AgentStudioPage'));
const KnowledgeBasePage = lazy(() => import('../KnowledgeBasePage'));
const LeadsPage = lazy(() => import('../leads/LeadsPage'));

const TABS = ['inbox', 'contacts', 'channels', 'snippets', 'agents', 'knowledge'] as const;
type InboxTab = (typeof TABS)[number];

/** The two VISIBLE tabs; the rest are config surfaces behind the gear menu. */
export type SurfaceTab = Extract<InboxTab, 'inbox' | 'contacts'>;
const CONFIG_TABS: readonly InboxTab[] = ['channels', 'snippets', 'agents', 'knowledge'];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

interface ConversationRow {
  id: string;
  status: string;
  aiPaused: boolean;
  unreadCount: number;
  lastMessageAt?: string | null;
  lead?: { businessName?: string; contactPerson?: string } | null;
  channel?: { type?: string; name?: string } | null;
  lastMessage?: { body?: string; direction?: string } | null;
}

/**
 * Omnichannel Inbox — 3 panes: conversation list, the live thread + composer,
 * and the lead context card. A single authenticated SSE stream (fetch + Bearer
 * header) to the workspace keeps everything live (any event re-fetches the
 * affected queries). An agent reply pauses the AI (human takeover); the AI can
 * be resumed per thread.
 *
 * We deliberately do NOT use EventSource: the native EventSource API cannot
 * set request headers, so the only way to authenticate it is to put the access
 * token in the query string — leaking the bearer token into logs and history.
 * Instead we open the stream with fetch() + an Authorization header and parse
 * the text/event-stream frames by hand. An AbortController tears the connection
 * down on unmount / token change, and a 3 s timer reconnects if the stream
 * drops (matching EventSource's auto-reconnect).
 */
export default function InboxPage({ defaultTab = 'inbox' }: { defaultTab?: SurfaceTab } = {}) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { accessToken, user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const { has } = useEntitlements();

  // `GET /conversations` and `GET /channels` are both
  // @RequiresFeature('conversationAi'). navigation.ts gates `/inbox` on it and
  // `/leads` on nothing — so now that both routes land HERE, an un-entitled
  // workspace could reach a Konuşmalar tab whose only reachable state is an
  // error. The gate moves WITH the item (navigation.ts's own rule, one level
  // down): trigger and content together, and the gear menu with them, because
  // the merge is what would have put it in front of them.
  const canConverse = has('conversationAi');

  // ── URL-synced top tabs (?tab=) ────────────────────────────────────────────
  // Konuşmalar + Kişiler are the two visible tabs of ONE surface; `/inbox` and
  // `/leads` render this same component and differ only in `defaultTab`. Both
  // routes stay — they are in the frozen path set and in people's bookmarks.
  // The 4 conversation-domain config surfaces stay behind the gear menu and
  // are manager-only: hidden from the bar AND deep links fall back for reps.
  // All inbox state/queries/SSE live in THIS component, so switching tabs
  // never tears down the real-time stream or the open thread.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const requested: InboxTab = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as InboxTab)
    : defaultTab;
  // Guard the CONTROLLED state, not just the render: if the trigger for the
  // requested value has been gated away, Radix selects nothing and the page
  // strands on a blank panel. Fall back to a tab that exists, however the
  // state got here.
  const tab: InboxTab =
    CONFIG_TABS.includes(requested) && !(isManager && canConverse)
      ? defaultTab
      : requested;
  const activeTab: InboxTab = tab === 'inbox' && !canConverse ? 'contacts' : tab;
  const setTab = (v: string) =>
    setParams((p) => {
      p.set('tab', v);
      return p;
    }, { replace: true });

  // Someone filtering their contact list is not running a live inbox. The
  // conversation poll and the SSE connection start when Konuşmalar is first
  // opened and then stay up — latched, so going back to Kişiler does not tear
  // down the stream or drop the open thread.
  const [inboxOpened, setInboxOpened] = useState(activeTab === 'inbox');
  useEffect(() => {
    if (activeTab === 'inbox') setInboxOpened(true);
  }, [activeTab]);
  const conversationsLive = canConverse && (activeTab === 'inbox' || inboxOpened);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [showContext, setShowContext] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // ── Queries ────────────────────────────────────────────────────────────────

  const {
    data: conversations,
    isLoading: conversationsLoading,
    isError: conversationsError,
    refetch: refetchConversations,
  } = useQuery<ConversationRow[]>({
    queryKey: ['marketing', 'conversations', statusFilter],
    queryFn: () =>
      marketingApi
        .get('/conversations', { params: { status: statusFilter } })
        .then((r) => r.data),
    refetchInterval: 30_000,
    enabled: conversationsLive,
  });

  const { data: thread } = useQuery({
    queryKey: ['marketing', 'conversation', selectedId],
    queryFn: () =>
      marketingApi.get(`/conversations/${selectedId}`).then((r) => r.data),
    enabled: !!selectedId,
  });

  // Team-only notes. The thread payload deliberately does not carry them, and
  // nothing in the panel used to fetch them — so notes written over the API (or
  // by an AI agent handing a thread over) were stored where no human could read
  // them.
  const { data: notes } = useQuery<{ id: string; body: string; createdAt: string }[]>({
    queryKey: ['marketing', 'conversation', selectedId, 'notes'],
    queryFn: () =>
      marketingApi.get(`/conversations/${selectedId}/notes`).then((r) => r.data),
    enabled: !!selectedId,
  });

  // ── Live SSE stream ────────────────────────────────────────────────────────

  useEffect(() => {
    // No token, no entitlement, or nobody has opened Konuşmalar yet: there is
    // nothing for a stream to keep fresh, and on an un-entitled workspace the
    // endpoint would only ever 403 in a reconnect loop.
    if (!accessToken || !conversationsLive) return;

    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const handleFrame = (frame: string) => {
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      const payload = dataLines.join('\n');
      try {
        const data = JSON.parse(payload);
        if (data?.kind === 'heartbeat') return;
        queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
        if (data?.conversationId) {
          queryClient.invalidateQueries({
            queryKey: ['marketing', 'conversation', data.conversationId],
          });
        }
      } catch {
        /* ignore malformed frame */
      }
    };

    const connect = async () => {
      try {
        const res = await fetch(`${API_URL}/marketing/conversations/stream`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Normalize CRLF → LF so the `\n\n` frame split works regardless of
          // whether the server emits `\n\n` or `\r\n\r\n` boundaries.
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.trim()) handleFrame(frame);
          }
        }
        if (!closed) scheduleReconnect();
      } catch {
        if (!closed) scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, 3000);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [accessToken, conversationsLive, queryClient]);

  // ── Side-effects ───────────────────────────────────────────────────────────

  // Reset the composer whenever the open conversation changes — `draft` is a
  // single shared state (cleared only on a successful send), so without this a
  // half-typed reply would carry from one customer's thread into the next and
  // could be sent to the wrong person.
  useEffect(() => {
    setDraft('');
    // Same reason for the note box: ThreadPane is prop-driven, not key-gated,
    // so a half-typed internal note would otherwise follow the agent into the
    // next customer's thread and be filed against the wrong lead.
    setNoteDraft('');
  }, [selectedId]);

  // Mark read on open AND whenever a new inbound bumps the OPEN thread's unread
  // count back up: an SSE message frame refetches the list, so a message landing
  // while the agent is still reading would otherwise re-surface (and keep
  // climbing) a badge on the very thread in focus. Keyed on the selected
  // conversation's unreadCount so it re-fires on a new message but only POSTs
  // when there is actually something unread — no redundant POST on every list
  // refetch, and no loop (the POST zeroes the count, settling the effect).
  const selectedUnread = conversations?.find((c) => c.id === selectedId)?.unreadCount ?? 0;
  useEffect(() => {
    if (selectedId && selectedUnread > 0)
      marketingApi
        .post(`/conversations/${selectedId}/read`)
        .then(() => queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] }))
        .catch(() => undefined);
  }, [selectedId, selectedUnread, queryClient]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
    if (selectedId)
      queryClient.invalidateQueries({
        queryKey: ['marketing', 'conversation', selectedId],
      });
  };

  const reply = useMutation({
    mutationFn: async (text: string) => {
      const convoId = selectedId;
      await marketingApi.post(`/conversations/${convoId}/reply`, { text });
      return convoId;
    },
    onSuccess: (convoId) => {
      // Only clear the composer if the agent is STILL on the thread we sent to —
      // a slow send that resolves after they switched threads must not wipe the
      // new thread's in-progress draft.
      if (convoId === selectedId) setDraft('');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('inbox.sendFailed', 'Send failed')),
  });

  const toggleAi = useMutation({
    mutationFn: (paused: boolean) =>
      marketingApi.post(`/conversations/${selectedId}/ai-pause`, { paused }),
    onSuccess: invalidate,
    // Without feedback an agent who clicked "pause AI" assumes it worked and
    // starts replying while the AI keeps answering — double replies on a live
    // customer channel. Surface the failure so they know the AI is still on.
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('inbox.aiToggleFailed', 'Could not change the AI status')),
  });

  const closeConvo = useMutation({
    mutationFn: () =>
      marketingApi.post(`/conversations/${selectedId}/close`),
    onSuccess: invalidate,
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('inbox.closeFailed', 'Could not close the conversation')),
  });

  const reopenConvo = useMutation({
    mutationFn: () =>
      marketingApi.post(`/conversations/${selectedId}/reopen`),
    onSuccess: invalidate,
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('inbox.reopenFailed', 'Could not reopen the conversation')),
  });

  const addNote = useMutation({
    mutationFn: (body: string) =>
      marketingApi.post(`/conversations/${selectedId}/notes`, { body }),
    onSuccess: () => {
      setNoteDraft('');
      queryClient.invalidateQueries({
        queryKey: ['marketing', 'conversation', selectedId, 'notes'],
      });
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('inbox.noteFailed', 'Could not save the note')),
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const convo = thread?.conversation;
  const lead = thread?.lead;
  const messages = thread?.messages ?? [];

  const handleBack = () => {
    setSelectedId(null);
    setShowContext(false);
  };

  return (
    <div className="flex flex-col h-full gap-4">
      {/* ONE header for the merged surface. Both halves used to render their
          own PageHeader, and nesting them stacked two <h1>s. The title follows
          the active tab so each route still reads the way it always did, and
          the ACTIONS belong to the tab that owns them — the gear to Konuşmalar,
          Export CSV + Yeni Lead to Kişiler (those two live inside the embedded
          leads surface, which owns the filter state they act on; same
          arrangement ChannelsSettingsPage and SnippetsPage already use as
          embedded tabs here). */}
      <PageHeader
        title={activeTab === 'contacts' ? t('leads.title') : t('inbox.title')}
        description={
          activeTab === 'contacts' ? t('leads.subtitle') : t('inbox.subtitle')
        }
        actions={
          // 2026-07 trim: the 4 one-time config surfaces no longer sit as
          // always-visible tabs on the daily messaging page — they live behind
          // ONE gear menu (deep links via ?tab= keep resolving unchanged).
          // Gated on conversationAi too: every one of them configures the
          // conversation domain, and `/leads` never used to offer them.
          isManager && canConverse ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  {t('inbox.settings', 'Inbox settings')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setTab('channels')}>
                  {t('inbox.tab.channels', 'Channels')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTab('snippets')}>
                  {t('inbox.tab.snippets', 'Canned Responses')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTab('agents')}>
                  {t('inbox.tab.agents', 'AI Agents')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTab('knowledge')}>
                  {t('inbox.tab.knowledge', 'Knowledge')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      <Tabs value={activeTab} onValueChange={setTab} className="flex-1 min-h-0 flex flex-col">
        {/* The merged surface: same data, different verb. Konuşmalar triages
            what came in; Kişiler filters the whole contact list — including
            the leads that have never had a conversation, which a
            conversation-first single list would hide entirely. That is the
            reason there are two tabs and not one merged feed. */}
        {!CONFIG_TABS.includes(activeTab) && (
          <TabsList className="shrink-0">
            {canConverse && (
              <TabsTrigger value="inbox">
                {t('surface.tab.conversations', 'Konuşmalar')}
              </TabsTrigger>
            )}
            <TabsTrigger value="contacts">
              {t('surface.tab.contacts', 'Kişiler')}
            </TabsTrigger>
          </TabsList>
        )}

        {/* On a config surface, one compact affordance leads back to the inbox. */}
        {isManager && CONFIG_TABS.includes(activeTab) && (
          <div className="shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setTab('inbox')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('inbox.backToInbox', 'Back to inbox')}
            </Button>
          </div>
        )}

        {/* Konuşmalar — the pre-existing 3-pane layout, byte-for-byte. Its
            state, queries and the SSE stream live in the page component above,
            so the open thread survives a trip to Kişiler and back (Radix
            unmounts the inactive panel; only state held ABOVE the tabs
            survives). Trigger and content are gated TOGETHER: gating only the
            trigger leaves a dead panel `setTab` can still reach, and gating
            only the content leaves a trigger that blanks the page. */}
        {canConverse && (
        <TabsContent
          value="inbox"
          className="flex-1 min-h-0 flex gap-0 sm:gap-4 mt-0"
        >
          {/* Pane 1 — conversation list (full-width on phone until one is opened) */}
          <div className={selectedId ? 'hidden sm:flex' : 'flex w-full sm:w-auto'}>
            <ConversationList
              conversations={conversations}
              isLoading={conversationsLoading}
              isError={conversationsError}
              selectedId={selectedId}
              statusFilter={statusFilter}
              isManager={isManager}
              onSelect={(id) => setSelectedId(id)}
              onStatusFilter={setStatusFilter}
              onRetry={() => refetchConversations()}
            />
          </div>

          {/* Pane 2 — thread + composer (full-width on phone when a conversation is open) */}
          <div
            className={`${
              selectedId ? 'flex' : 'hidden sm:flex'
            } w-full sm:w-auto sm:flex-1 min-w-0`}
          >
            <ThreadPane
              convo={convo}
              lead={lead}
              channel={thread?.channel}
              messages={messages}
              draft={draft}
              isSending={reply.isPending}
              isTogglingAi={toggleAi.isPending}
              isClosing={closeConvo.isPending}
              isReopening={reopenConvo.isPending}
              notes={notes ?? []}
              noteDraft={noteDraft}
              isAddingNote={addNote.isPending}
              onDraftChange={setDraft}
              onSend={() => draft.trim() && reply.mutate(draft.trim())}
              onToggleAi={() => convo && toggleAi.mutate(!convo.aiPaused)}
              onClose={() => closeConvo.mutate()}
              onReopen={() => reopenConvo.mutate()}
              onNoteDraftChange={setNoteDraft}
              onAddNote={() => {
                const body = noteDraft.trim();
                if (body) addNote.mutate(body);
              }}
              onBack={handleBack}
              onShowContext={() => setShowContext(true)}
            />
          </div>

          {/* Pane 3 — lead context: inline at lg+, sheet below lg */}
          <LeadContextPane lead={lead} />
          {showContext && (
            <LeadContextPane
              lead={lead}
              asSheet
              onClose={() => setShowContext(false)}
            />
          )}
        </TabsContent>
        )}

        {/* Kişiler — the leads list, unchanged: its own filters, table,
            pagination, bulk actions and CSV export, plus the work-queue chips.
            Embedded so the header above is the only one; it keeps its own
            actions in a toolbar row, the arrangement the config tabs here
            already use. Not entitlement-gated — /leads never was, and
            marketing-leads.controller gates only its two smsOtp endpoints. */}
        <TabsContent value="contacts" className="flex-1 min-h-0 overflow-y-auto mt-4">
          <Lazy><LeadsPage embedded /></Lazy>
        </TabsContent>

        {/* Config tabs — manager-only, lazy, scroll independently of the shell. */}
        <TabsContent value="channels" className="flex-1 min-h-0 overflow-y-auto">
          <Lazy><ChannelsSettingsPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="snippets" className="flex-1 min-h-0 overflow-y-auto">
          <Lazy><SnippetsPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="agents" className="flex-1 min-h-0 overflow-y-auto">
          <Lazy><AgentStudioPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="knowledge" className="flex-1 min-h-0 overflow-y-auto">
          <Lazy><KnowledgeBasePage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}
