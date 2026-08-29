import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CheckCircle,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Send,
  StickyNote,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { smsSegments, NETGSM_HEADER_OVERHEAD_CHARS } from '@/lib/smsSegments';
import { fmtSlot } from '../../../features/marketing/utils/format';
import LeadStream from '../../../features/marketing/components/LeadStream';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  listConversations,
  type ConversationSummary,
} from '../../../features/marketing/api/conversations.service';
import type { Lead } from '../../../features/marketing/types';
import LeadHeaderActions from '../leadDetail/LeadHeaderActions';

interface NoteRow {
  id: string;
  body: string;
  createdAt: string;
}

export interface PersonPaneProps {
  /** Who is selected. Null before anyone is — the column says so and fetches
   *  nothing rather than rendering an empty conversation. */
  person: Lead | null;
  className?: string;
}

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

/**
 * The middle column: one person's whole history, and the one place to write
 * back to them.
 *
 * This stands where the Inbox's ThreadPane stood, and the difference is the
 * point of the surface. ThreadPane rendered ONE conversation's messages,
 * because the object you had selected was a conversation. Here the object is a
 * PERSON, so the body is `LeadStream` — messages, calls, notes and status moves
 * on one axis — and the conversation becomes a field of theirs that the footer
 * writes into.
 *
 * What was lifted rather than rebuilt, because the brief is explicit that there
 * must not be a second send path:
 *
 * - The composer and its send are ThreadPane's, `POST /conversations/:id/reply`
 *   unchanged, including the Enter guard that stops a fast second press from
 *   double-sending an uncleared draft to a live customer, and the SMS segment
 *   counter.
 * - Pause/resume AI, close/reopen and the team-only notes are ThreadPane's too.
 *   They are per-CONVERSATION controls, so they hang off the thread this pane
 *   has in hand rather than off the person.
 * - Starting a thread is `LeadHeaderActions`, mounted whole. It already owns
 *   the channel picker, the WhatsApp exclusion and the FAILED-message case;
 *   a second dialog here would be a second set of those decisions.
 *
 * One thing is genuinely NEW, and it exists because the object changed:
 * **the thread picker.** Selecting a person no longer selects a channel, so a
 * person with an SMS thread and an email thread needs the composer to say which
 * one it is about to answer on. Without it a rep replies to an email over SMS
 * and finds out from the customer.
 *
 * Failure and gating, kept apart as everywhere else on this surface:
 *
 * - The thread lookup failing does NOT blank the stream, and is NOT the
 *   silent-person branch. Guessing "no conversations" from a thrown query would
 *   offer to start a second thread on top of one that already exists.
 * - No `conversationAi` is not a failure. `GET /conversations` is gated,
 *   `/leads` is not, so the list, the record card and the activity stream all
 *   survive; the composer says which plan line is missing. The stream's own
 *   `gated: ['mesajlar']` banner says the same thing about the history.
 *
 * Per-person state (the draft, the note draft, the chosen thread) is NOT reset
 * here. The surface mounts this component with `key={person.id}`, which is the
 * one mechanism rather than two: a stale draft following a rep into the next
 * customer's thread is a message sent to the wrong person, and this branch has
 * already shipped that bug once with a phone number.
 */
export function PersonPane({ person, className }: PersonPaneProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { has } = useEntitlements();
  // Both halves of writing back — `GET /conversations` and the reply POST — sit
  // behind @RequiresFeature('conversationAi'). Reading it here keeps the
  // request from being made at all rather than letting it 403 on load.
  const canConverse = has('conversationAi');

  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [pickedThreadId, setPickedThreadId] = useState<string | null>(null);

  const leadId = person?.id ?? null;

  const threads = useQuery<ConversationSummary[]>({
    queryKey: ['marketing', 'conversations', 'lead', leadId],
    queryFn: () => listConversations({ leadId: leadId! }),
    enabled: !!leadId && canConverse,
  });

  // Newest first, so "the thread in hand" is the one most recently spoken on
  // rather than whatever order the endpoint happened to return.
  const ordered = useMemo(
    () =>
      [...(threads.data ?? [])].sort((a, b) =>
        (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
      ),
    [threads.data],
  );
  const active =
    ordered.find((c) => c.id === pickedThreadId) ?? ordered[0] ?? null;
  const activeId = active?.id ?? null;

  // Reading a thread is what clears its badge — and the badge now sits on the
  // PERSON row in the left column, so the leads list is invalidated alongside
  // the conversations. Keyed on the unread count so a message arriving while
  // the pane is open re-fires, and so nothing is POSTed when there is nothing
  // to mark.
  const activeUnread = active?.unreadCount ?? 0;
  useEffect(() => {
    if (!activeId || activeUnread <= 0) return;
    marketingApi
      .post(`/conversations/${activeId}/read`)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
        queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      })
      .catch(() => undefined);
  }, [activeId, activeUnread, queryClient]);

  const notes = useQuery<NoteRow[]>({
    queryKey: ['marketing', 'conversation', activeId, 'notes'],
    queryFn: () => marketingApi.get(`/conversations/${activeId}/notes`).then((r) => r.data),
    enabled: !!activeId && notesOpen,
  });

  /** Everything a write touches: the thread list, and the person's stream. */
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
    if (leadId) queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', leadId] });
  };

  const reply = useMutation({
    mutationFn: async (text: string) => {
      const id = activeId;
      await marketingApi.post(`/conversations/${id}/reply`, { text });
      return id;
    },
    onSuccess: (id) => {
      // Only clear the box if the reply landed on the thread still in hand — a
      // slow send that resolves after the rep switched channels must not wipe
      // the new thread's draft.
      if (id === activeId) setDraft('');
      invalidate();
    },
    onError: (e) => toast.error(errMsg(e, t('inbox.sendFailed', 'Gönderilemedi'))),
  });

  const toggleAi = useMutation({
    mutationFn: (paused: boolean) =>
      marketingApi.post(`/conversations/${activeId}/ai-pause`, { paused }),
    onSuccess: invalidate,
    // Without feedback a rep who clicked "pause AI" assumes it worked and
    // starts replying while the AI keeps answering — two voices on one live
    // customer channel.
    onError: (e) =>
      toast.error(errMsg(e, t('inbox.aiToggleFailed', 'Yapay zeka durumu değiştirilemedi'))),
  });

  const closeConvo = useMutation({
    mutationFn: () => marketingApi.post(`/conversations/${activeId}/close`),
    onSuccess: invalidate,
    onError: (e) => toast.error(errMsg(e, t('inbox.closeFailed', 'Konuşma kapatılamadı'))),
  });

  const reopenConvo = useMutation({
    mutationFn: () => marketingApi.post(`/conversations/${activeId}/reopen`),
    onSuccess: invalidate,
    onError: (e) => toast.error(errMsg(e, t('inbox.reopenFailed', 'Konuşma açılamadı'))),
  });

  const addNote = useMutation({
    mutationFn: (body: string) => marketingApi.post(`/conversations/${activeId}/notes`, { body }),
    onSuccess: () => {
      setNoteDraft('');
      queryClient.invalidateQueries({
        queryKey: ['marketing', 'conversation', activeId, 'notes'],
      });
    },
    onError: (e) => toast.error(errMsg(e, t('inbox.noteFailed', 'Not kaydedilemedi'))),
  });

  if (!person) {
    return (
      <Card
        data-testid="person-pane-idle"
        className={`flex items-center justify-center ${className ?? ''}`}
      >
        <p className="p-6 text-sm text-muted-foreground">
          {t('surface.pane.pickSomeone', 'Soldan bir kişi seç.')}
        </p>
      </Card>
    );
  }

  const channelOf = (c: ConversationSummary) => c.channel?.type ?? '—';
  const send = () => {
    const text = draft.trim();
    if (text && !reply.isPending) reply.mutate(text);
  };

  return (
    <Card className={`flex min-w-0 flex-col overflow-hidden ${className ?? ''}`}>
      {/* Header — who, on what, and the two controls that belong to the thread
          rather than to the person. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {person.contactPerson || person.businessName}
          </span>
          {person.contactPerson && person.businessName && (
            <span className="block truncate text-xs text-muted-foreground">
              {person.businessName}
            </span>
          )}
        </div>

        {active && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={
                active.aiPaused
                  ? t('inbox.resumeAi', 'Yapay zekayı sürdür')
                  : t('inbox.pauseAi', 'Yapay zekayı durdur')
              }
              onClick={() => toggleAi.mutate(!active.aiPaused)}
              disabled={toggleAi.isPending}
            >
              {active.aiPaused ? (
                <PlayCircle className="h-5 w-5" />
              ) : (
                <PauseCircle className="h-5 w-5" />
              )}
            </IconButton>
            {active.status === 'CLOSED' ? (
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={t('inbox.reopen', 'Yeniden aç')}
                onClick={() => reopenConvo.mutate()}
                disabled={reopenConvo.isPending}
              >
                <RotateCcw className="h-5 w-5" />
              </IconButton>
            ) : (
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={t('inbox.close', 'Kapat')}
                onClick={() => closeConvo.mutate()}
                disabled={closeConvo.isPending}
              >
                <CheckCircle className="h-5 w-5" />
              </IconButton>
            )}
          </div>
        )}
      </div>

      {/* Which conversation the footer is about. Only when there is a choice to
          make: one thread needs no picker, and the composer names its channel
          anyway. */}
      {ordered.length > 1 && (
        <div
          role="group"
          aria-label={t('surface.pane.thread', 'Konuşma')}
          className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-1.5"
        >
          {ordered.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant={c.id === activeId ? 'primary' : 'outline'}
              aria-pressed={c.id === activeId}
              onClick={() => setPickedThreadId(c.id)}
            >
              {channelOf(c)}
              {/* The channel alone is not an identity. Two SMS threads with one
                  person render as the same button twice, and the picker exists
                  precisely so a rep does not answer the wrong thread — so the
                  two things that actually differ ride along. `fmtSlot` is the
                  stream's own formatter: compact, and locale from i18next
                  rather than the operator's OS. */}
              {c.lastMessageAt && (
                <span className="text-[10px] opacity-70">{fmtSlot(c.lastMessageAt)}</span>
              )}
              {c.status === 'CLOSED' && (
                <Badge tone="neutral" size="sm">
                  {t('inbox.closed', 'Kapalı')}
                </Badge>
              )}
              {c.unreadCount > 0 && (
                <Badge tone="primary" size="sm">
                  {c.unreadCount}
                </Badge>
              )}
            </Button>
          ))}
        </div>
      )}

      {/* Team-only notes on the thread in hand. Never delivered to the customer;
          the routes and the MCP tool both exist and nothing else in this app
          calls them, so dropping the panel would store notes where no human
          reads them. */}
      {active && (
        <div className="shrink-0 border-b border-border bg-warning/5 px-3 py-2">
          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <StickyNote className="h-4 w-4" />
            {t('inbox.internalNotes', 'İç notlar')}
            {/* ThreadPane's count, restored. The panel is COLLAPSED by default,
                so without it the only way to learn a teammate left a handover
                note is to open a panel that is empty for most threads. */}
            {(notes.data?.length ?? 0) > 0 && (
              <Badge data-testid="person-pane-notes-count" size="sm">
                {notes.data!.length}
              </Badge>
            )}
            <span className="ms-auto">{notesOpen ? '−' : '+'}</span>
          </button>

          {notesOpen && (
            <div className="mt-2 space-y-2">
              {/* FAILED is not EMPTY, and this is the panel where the difference
                  costs the most. react-query v5 gives an errored query
                  `isLoading === false` and `data === undefined`, so the empty
                  branch below would otherwise tell a rep the team wrote nothing
                  down — in front of the customer whose handover note it just
                  failed to fetch. Same shape as `person-pane-threads-failed`
                  below, plus a retry: the notes are one request, and sending
                  someone to reload the whole surface would throw away the
                  draft they are holding. */}
              {notes.isError ? (
                <div data-testid="person-pane-notes-failed" role="status" className="space-y-1">
                  <p className="text-xs text-danger">
                    {t('surface.pane.notesFailed', 'İç notlar yüklenemedi')} —{' '}
                    {t(
                      'surface.pane.notesFailedHint',
                      'bir ekip arkadaşının devir notu burada olabilir; okumadan devam etme',
                    )}
                  </p>
                  <Button size="sm" variant="outline" onClick={() => notes.refetch()}>
                    {t('surface.pane.notesRetry', 'Yeniden dene')}
                  </Button>
                </div>
              ) : (
                (notes.data ?? []).length === 0 &&
                !notes.isLoading && (
                  <p className="text-xs text-muted-foreground">
                    {t('inbox.noNotes', 'Henüz iç not yok. Bunları yalnızca ekibin görür.')}
                  </p>
                )
              )}
              {(notes.data ?? []).map((n) => (
                <div
                  key={n.id}
                  data-testid={`person-pane-note-${n.id}`}
                  className="rounded border border-border bg-surface p-2 text-xs"
                >
                  <p className="whitespace-pre-wrap text-foreground">{n.body}</p>
                  {/* ThreadPane's per-note timestamp, restored — an undated
                      handover note cannot be told from a stale one. `fmtSlot`
                      rather than ThreadPane's raw `toLocaleString`: the same
                      compact form the stream above uses, and the locale comes
                      from i18next instead of the operator's OS. */}
                  <p
                    data-testid={`person-pane-note-at-${n.id}`}
                    className="mt-0.5 text-[10px] text-muted-foreground"
                  >
                    {fmtSlot(n.createdAt)}
                  </p>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  aria-label={t('inbox.notePlaceholder', 'Ekibe not…')}
                  placeholder={t('inbox.notePlaceholder', 'Ekibe not…')}
                  className="flex-1 rounded border border-border bg-surface px-2 py-1 text-xs"
                  onKeyDown={(e) => {
                    // Same guard the composer uses: Enter has to respect the
                    // in-flight state or a fast second press double-posts.
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      noteDraft.trim() &&
                      !addNote.isPending
                    ) {
                      e.preventDefault();
                      addNote.mutate(noteDraft.trim());
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => noteDraft.trim() && addNote.mutate(noteDraft.trim())}
                  disabled={!noteDraft.trim() || addNote.isPending}
                >
                  {t('inbox.addNote', 'Ekle')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The stream. THIS element owns the scroll — LeadStream deliberately sets
          no height and no overflow so the same component can sit in a lead
          detail tab that does not scroll. Owning the overflow is NOT owning the
          auto-scroll: `scrollIntoView` walks up to whichever ancestor scrolls,
          so LeadStream keeps the anchor and the jump-on-open / follow-your-own-
          reply rule, and this column just has to be the thing that scrolls. */}
      <div
        data-testid="person-pane-scroll"
        className="min-h-0 flex-1 overflow-y-auto bg-surface-muted/30 p-3"
      >
        <LeadStream leadId={person.id} />
      </div>

      {/* Footer — the writing half, in four mutually exclusive states. */}
      <div className="shrink-0 space-y-2 border-t border-border p-3">
        {/* Ara + Mesaj, whole. Mesaj is what starts a thread for a person who
            has none; it self-gates on conversationAi and telephony, so this
            renders whatever the workspace is actually allowed to do. */}
        <div className="flex flex-wrap items-center gap-2">
          <LeadHeaderActions
            lead={person}
            onOpenStream={() => {
              // The stream is already open. What a fresh start needs is for it
              // to show the message that was just sent.
              queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', person.id] });
            }}
          />
        </div>

        {!canConverse ? (
          <p data-testid="person-pane-gated" className="text-xs text-info">
            {t('surface.pane.gated', 'Mesajlaşma paketinde yok')} —{' '}
            {t(
              'surface.pane.gatedHint',
              'kişiyi ve hareketlerini görüyorsun; yazışma eklendiğinde burada açılır',
            )}
          </p>
        ) : threads.isError ? (
          <p data-testid="person-pane-threads-failed" role="status" className="text-xs text-danger">
            {t('surface.pane.threadsFailed', 'Konuşmalar yüklenemedi')} —{' '}
            {t(
              'surface.pane.threadsFailedHint',
              'bu kişinin bir konuşması olabilir; yeni bir tane açmadan önce yenile',
            )}
          </p>
        ) : active ? (
          <>
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={t('surface.pane.reply', 'Yanıt yaz')}
                placeholder={t('surface.pane.reply', 'Yanıt yaz')}
                onKeyDown={(e) => {
                  // ThreadPane's guard, kept: without the in-flight check a
                  // second Enter re-sends the not-yet-cleared draft, which is a
                  // duplicate message to a live customer.
                  if (e.key === 'Enter' && !e.shiftKey && draft.trim() && !reply.isPending) {
                    e.preventDefault();
                    send();
                  }
                }}
                className="h-9 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                size="md"
                onClick={send}
                disabled={!draft.trim() || reply.isPending}
                loading={reply.isPending}
                aria-label={t('inbox.send', 'Gönder')}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {/* Which channel this reply leaves on. On the old surface the
                  conversation list answered that; here the person does not. */}
              {channelOf(active)}
              {channelOf(active) === 'SMS' &&
                ` · ${t('inbox.smsCounter', {
                  defaultValue: '{{chars}} karakter · {{segments}} parça',
                  chars: draft.length,
                  segments: smsSegments(draft, {
                    reservedSuffixChars: NETGSM_HEADER_OVERHEAD_CHARS,
                  }),
                })}`}
            </p>
          </>
        ) : threads.isSuccess ? (
          <p
            data-testid="person-pane-start"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {t('surface.pane.noThread', 'Bu kişiyle henüz konuşulmadı')} —{' '}
            {t('surface.pane.noThreadHint', 'Mesaj ile ilk konuşmayı başlat')}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
