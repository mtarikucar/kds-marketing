import { lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { API_URL } from '../../../lib/env';
import { RouteFallback } from '../../../components/RouteFallback';
import { ConversationList } from './ConversationList';
import { ThreadPane } from './ThreadPane';
import { LeadContextPane } from './LeadContextPane';

// Lazy so a config tab's code only loads when opened — the inbox tab (the
// default, real-time surface) must never pay for the config pages' bundles.
const ChannelsSettingsPage = lazy(() => import('../ChannelsSettingsPage'));
const SnippetsPage = lazy(() => import('../settings/snippets'));
const AgentStudioPage = lazy(() => import('../AgentStudioPage'));
const KnowledgeBasePage = lazy(() => import('../KnowledgeBasePage'));

const TABS = ['inbox', 'channels', 'snippets', 'agents', 'knowledge'] as const;
type InboxTab = (typeof TABS)[number];

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
export default function InboxPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { accessToken, user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // ── URL-synced top tabs (?tab=) ────────────────────────────────────────────
  // inbox (default) + the 4 conversation-domain config surfaces. The config
  // tabs are manager-only: hidden from the bar AND deep links fall back to the
  // inbox for reps. All inbox state/queries/SSE live in THIS component, so
  // switching tabs never tears down the real-time stream or the open thread.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const requested: InboxTab = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as InboxTab)
    : 'inbox';
  const tab: InboxTab = isManager ? requested : 'inbox';
  const setTab = (v: string) =>
    setParams((p) => {
      p.set('tab', v);
      return p;
    }, { replace: true });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [showContext, setShowContext] = useState(false);

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
  });

  const { data: thread } = useQuery({
    queryKey: ['marketing', 'conversation', selectedId],
    queryFn: () =>
      marketingApi.get(`/conversations/${selectedId}`).then((r) => r.data),
    enabled: !!selectedId,
  });

  // ── Live SSE stream ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!accessToken) return;

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
  }, [accessToken, queryClient]);

  // ── Side-effects ───────────────────────────────────────────────────────────

  // Reset the composer whenever the open conversation changes — `draft` is a
  // single shared state (cleared only on a successful send), so without this a
  // half-typed reply would carry from one customer's thread into the next and
  // could be sent to the wrong person.
  useEffect(() => {
    setDraft('');
  }, [selectedId]);

  // Mark read on open — and refresh the list so the unread badge on the thread
  // you just opened clears immediately, instead of lingering until the next 30s
  // poll / SSE event (the POST zeroes unreadCount server-side, but nothing was
  // re-reading the list).
  useEffect(() => {
    if (selectedId)
      marketingApi
        .post(`/conversations/${selectedId}/read`)
        .then(() => queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] }))
        .catch(() => undefined);
  }, [selectedId, queryClient]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
    if (selectedId)
      queryClient.invalidateQueries({
        queryKey: ['marketing', 'conversation', selectedId],
      });
  };

  const reply = useMutation({
    mutationFn: (text: string) =>
      marketingApi.post(`/conversations/${selectedId}/reply`, { text }),
    onSuccess: () => {
      setDraft('');
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
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.subtitle')}
      />

      <Tabs value={tab} onValueChange={setTab} className="flex-1 min-h-0 flex flex-col">
        {/* The config tabs are manager-only; reps get the plain inbox (no bar). */}
        {isManager && (
          <TabsList className="shrink-0">
            <TabsTrigger value="inbox">{t('inbox.tab.inbox', 'Inbox')}</TabsTrigger>
            <TabsTrigger value="channels">{t('inbox.tab.channels', 'Channels')}</TabsTrigger>
            <TabsTrigger value="snippets">{t('inbox.tab.snippets', 'Canned Responses')}</TabsTrigger>
            <TabsTrigger value="agents">{t('inbox.tab.agents', 'AI Agents')}</TabsTrigger>
            <TabsTrigger value="knowledge">{t('inbox.tab.knowledge', 'Knowledge')}</TabsTrigger>
          </TabsList>
        )}

        {/* Inbox — the pre-existing 3-pane layout, byte-for-byte. Its state,
            queries and the SSE stream live in the page component above, so the
            real-time behavior is identical whether or not the bar is shown. */}
        <TabsContent
          value="inbox"
          className={`flex-1 min-h-0 flex gap-0 sm:gap-4 ${isManager ? 'mt-4' : 'mt-0'}`}
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
              onDraftChange={setDraft}
              onSend={() => draft.trim() && reply.mutate(draft.trim())}
              onToggleAi={() => convo && toggleAi.mutate(!convo.aiPaused)}
              onClose={() => closeConvo.mutate()}
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
