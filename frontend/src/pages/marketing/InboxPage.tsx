import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PaperAirplaneIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  CheckCircleIcon,
  SparklesIcon,
  UserIcon,
  ChevronLeftIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Link } from 'react-router-dom';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader, EmptyState } from '../../features/marketing/components';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { API_URL } from '../../lib/env';

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
interface MessageRow {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  authorType: 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM';
  body: string;
  status?: string;
  createdAt: string;
}

/**
 * Omnichannel Inbox — 3 panes: conversation list, the live thread + composer,
 * and the lead context card. A single EventSource to the workspace stream keeps
 * everything live (any event re-fetches the affected queries). An agent reply
 * pauses the AI (human takeover); the AI can be resumed per thread.
 */
export default function InboxPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { accessToken, user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [showContext, setShowContext] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const { data: conversations } = useQuery<ConversationRow[]>({
    queryKey: ['marketing', 'conversations', statusFilter],
    queryFn: () =>
      marketingApi.get('/conversations', { params: { status: statusFilter } }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: thread } = useQuery({
    queryKey: ['marketing', 'conversation', selectedId],
    queryFn: () => marketingApi.get(`/conversations/${selectedId}`).then((r) => r.data),
    enabled: !!selectedId,
  });

  // Live updates: subscribe once; on any event refresh the list + open thread.
  useEffect(() => {
    if (!accessToken) return;
    const es = new EventSource(
      `${API_URL}/marketing/conversations/stream?access_token=${encodeURIComponent(accessToken)}`,
    );
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data?.kind === 'heartbeat') return;
        queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
        if (data?.conversationId) {
          queryClient.invalidateQueries({ queryKey: ['marketing', 'conversation', data.conversationId] });
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects; nothing to do */
    };
    return () => es.close();
  }, [accessToken, queryClient]);

  // Mark read + scroll on open / new messages.
  useEffect(() => {
    if (selectedId) marketingApi.post(`/conversations/${selectedId}/read`).catch(() => undefined);
  }, [selectedId]);
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages?.length]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
    if (selectedId) queryClient.invalidateQueries({ queryKey: ['marketing', 'conversation', selectedId] });
  };

  const reply = useMutation({
    mutationFn: (text: string) => marketingApi.post(`/conversations/${selectedId}/reply`, { text }),
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('inbox.sendFailed', 'Send failed')),
  });

  const toggleAi = useMutation({
    mutationFn: (paused: boolean) =>
      marketingApi.post(`/conversations/${selectedId}/ai-pause`, { paused }),
    onSuccess: invalidate,
  });
  const closeConvo = useMutation({
    mutationFn: () => marketingApi.post(`/conversations/${selectedId}/close`),
    onSuccess: invalidate,
  });

  const convo = thread?.conversation;
  const lead = thread?.lead;
  const messages: MessageRow[] = thread?.messages ?? [];

  // Lead-context body, reused by the inline pane (lg+) and the sheet (below lg).
  const leadBody = lead ? (
    <div className="space-y-2 text-sm">
      <div className="font-medium text-slate-900">{lead.businessName}</div>
      <div className="text-slate-600">{lead.contactPerson}</div>
      {lead.phone && <div className="text-slate-500 text-xs">{lead.phone}</div>}
      {lead.email && <div className="text-slate-500 text-xs">{lead.email}</div>}
      <div className="text-xs">
        <span className="inline-block px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{lead.status}</span>
      </div>
      <a href={`/leads/${lead.id}`} className="text-primary text-xs hover:underline inline-block mt-1">
        {t('inbox.openLead', 'Open lead →')}
      </a>
    </div>
  ) : (
    <p className="text-xs text-slate-400">{t('inbox.noLead', 'Select a conversation.')}</p>
  );

  return (
    <div className="flex flex-col h-full gap-4">
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
      <div className="flex-1 min-h-0 flex gap-0 sm:gap-4">
      {/* Pane 1 — conversation list (full-width on phone until one is opened) */}
      <div
        className={`${selectedId ? 'hidden sm:flex' : 'flex'} w-full sm:w-72 sm:shrink-0 bg-white rounded-xl border border-slate-200 flex-col overflow-hidden`}
      >
        <div className="p-3 border-b border-slate-100 flex gap-1">
          {['OPEN', 'CLOSED'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium ${
                statusFilter === s ? 'bg-primary/10 text-primary' : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              {s === 'OPEN' ? t('inbox.open', 'Open') : t('inbox.closed', 'Closed')}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
          {(conversations ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`w-full text-left p-3 hover:bg-slate-50 ${selectedId === c.id ? 'bg-primary/5' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm text-slate-900 truncate">
                  {c.lead?.contactPerson || c.lead?.businessName || t('inbox.unknown', 'Unknown')}
                </span>
                {c.unreadCount > 0 && (
                  <span className="text-xs bg-primary text-primary-foreground rounded-full px-1.5">
                    {c.unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] uppercase text-slate-400">{c.channel?.type}</span>
                {c.aiPaused && <span className="text-[10px] text-amber-500">{t('inbox.aiOff', 'AI off')}</span>}
              </div>
              <p className="text-xs text-slate-400 truncate mt-0.5">{c.lastMessage?.body ?? ''}</p>
            </button>
          ))}
          {(conversations ?? []).length === 0 && (
            <div className="p-3">
              <EmptyState
                title={t('inbox.empty', 'No conversations yet.')}
                description={t('inbox.emptyHint')}
                action={
                  isManager ? (
                    <Link to="/channels" className="text-xs font-medium text-primary hover:underline">
                      {t('inbox.connectChannel')}
                    </Link>
                  ) : undefined
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Pane 2 — thread + composer (full-width on phone when a conversation is open) */}
      <div
        className={`${selectedId ? 'flex' : 'hidden sm:flex'} w-full sm:w-auto sm:flex-1 bg-white rounded-xl border border-slate-200 flex-col overflow-hidden`}
      >
        {!convo ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            {t('inbox.selectPrompt', 'Select a conversation to view the thread.')}
          </div>
        ) : (
          <>
            <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => {
                    setSelectedId(null);
                    setShowContext(false);
                  }}
                  title={t('inbox.back', 'Back')}
                  className="sm:hidden -ml-1 p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 shrink-0"
                >
                  <ChevronLeftIcon className="w-5 h-5" />
                </button>
                <div className="font-medium text-slate-900 text-sm truncate">
                  {lead?.contactPerson || lead?.businessName}
                  <span className="ml-2 text-xs text-slate-400">{convo.channelType ?? thread?.channel?.type}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setShowContext(true)}
                  title={t('inbox.context', 'Lead')}
                  className="lg:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  <UserIcon className="w-5 h-5" />
                </button>
                <button
                  onClick={() => toggleAi.mutate(!convo.aiPaused)}
                  title={convo.aiPaused ? t('inbox.resumeAi', 'Resume AI') : t('inbox.pauseAi', 'Pause AI')}
                  className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  {convo.aiPaused ? <PlayCircleIcon className="w-5 h-5" /> : <PauseCircleIcon className="w-5 h-5" />}
                </button>
                <button
                  onClick={() => closeConvo.mutate()}
                  title={t('inbox.close', 'Close')}
                  className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  <CheckCircleIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === 'OUTBOUND'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-white border border-slate-200 text-slate-800'
                    }`}
                  >
                    <div className="flex items-center gap-1 mb-0.5 opacity-70 text-[10px]">
                      {m.authorType === 'AI' && <SparklesIcon className="w-3 h-3" />}
                      {m.authorType === 'AGENT' && <UserIcon className="w-3 h-3" />}
                      {m.authorType}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    {m.status === 'FAILED' && (
                      <div className="text-[10px] text-red-300 mt-0.5">{t('inbox.failed', 'failed')}</div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={threadEndRef} />
            </div>

            <div className="p-3 border-t border-slate-100 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim()) reply.mutate(draft.trim());
                }}
                placeholder={t('inbox.replyPlaceholder', 'Type a reply… (this pauses the AI)')}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              />
              <button
                onClick={() => draft.trim() && reply.mutate(draft.trim())}
                disabled={!draft.trim() || reply.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
              >
                <PaperAirplaneIcon className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Pane 3 — lead context: inline only at lg+, a sheet below that */}
      <div className="hidden lg:flex lg:w-64 lg:shrink-0 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto flex-col">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
          {t('inbox.context', 'Lead')}
        </h3>
        {leadBody}
      </div>

      {/* Lead-context sheet — bottom sheet on phone, centered card on tablet (below lg) */}
      {showContext && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowContext(false)} />
          <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                {t('inbox.context', 'Lead')}
              </h3>
              <button
                onClick={() => setShowContext(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
            {leadBody}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
