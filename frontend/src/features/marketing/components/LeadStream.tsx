import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, FileText, MessageSquare, Phone, RefreshCw, Sparkles, User } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { getLeadStream, type LeadStreamItem } from '../api/leadStream.service';
import { fmtSlot } from '../utils/format';

/**
 * How loudly a row is drawn. The IA spec's rule: system/automatic things
 * RECEDE, the human's work is prominent. A status move is written by the
 * machine every time a stage changes, and a rep's morning is three of those
 * for every note they actually typed — at equal weight the notes disappear.
 *
 * Deliberately NOT applied to AI-authored MESSAGES. An AI reply is automatic,
 * but it is also half of a real conversation with a real customer; dimming it
 * would grey out the thread itself rather than the bookkeeping around it. The
 * author is LABELLED on the bubble instead, exactly as the Inbox does it.
 */
type RowWeight = 'recessive' | 'normal';

const rowWeight = (i: LeadStreamItem): RowWeight =>
  i.kind === 'status' || i.authorType === 'SYSTEM' ? 'recessive' : 'normal';

/**
 * The weight, rendered. Keyed by RowWeight rather than re-deciding on `kind` at
 * the class site — TimelinePanel's lesson, and the reason it is worth copying:
 * two independent ternaries let the styling be collapsed while the published
 * `data-weight` stays intact, so a row could REPORT recessive and be drawn at
 * full weight with every test still green. One expression feeds both.
 */
const EVENT_CLASS: Record<RowWeight, string> = {
  recessive: 'flex items-start gap-2 py-1 text-xs text-muted-foreground opacity-60',
  normal: 'flex items-start gap-2 py-2 text-sm text-foreground',
};

const EVENT_ICON: Record<string, React.ElementType> = {
  call: Phone,
  note: FileText,
  status: RefreshCw,
  activity: Activity,
};

const AUTHOR_ICON: Record<string, React.ElementType> = {
  AI: Sparkles,
  AGENT: User,
};

export interface LeadStreamProps {
  /** Whose stream. The component owns its own query off this id — it is not
   *  handed items, so the two surfaces that mount it cannot disagree about what
   *  "this person's history" means. */
  leadId: string;
  /**
   * Rendered directly under the stream. The three-column surface owns SENDING
   * (and `LeadHeaderActions` owns starting a thread), so the composer is a slot
   * rather than something this file builds — one stream, and whatever the host
   * wants to hang beneath it.
   */
  composer?: ReactNode;
  /** Forwarded to the wrapper. This component sets no height and owns no
   *  scroll: the middle column of the surface scrolls, and the lead detail's
   *  tab does not. */
  className?: string;
}

/**
 * ONE person's stream: messages and lead activities on a single time axis,
 * oldest at the top, newest at the bottom.
 *
 * Mounted from two places on purpose — the lead detail's Akış tab and the
 * person-primary surface's middle column. Two lists from two endpoints is what
 * made v2.283.0's merge cosmetic, and two COMPONENTS reading one endpoint would
 * be the same mistake one layer up.
 *
 * Three things this file is answerable for:
 *
 * 1. **The kinds do not blur.** A message is a conversation bubble with a side;
 *    a call, a note or a status move is a timeline event. Rendering all five
 *    the same way makes a status change read as something the customer said.
 *
 * 2. **A FAILED message says so, on the message.** This is a live gap, not a
 *    hypothetical: v2.283.0's ConversationsTab printed `lastMessage.body` with
 *    no indicator at all, so a message that never left the building looked
 *    delivered. The treatment is the Inbox's own (ThreadPane.tsx:344) — small
 *    danger text under the body — plus the provider's reason, which ThreadPane
 *    does not have room for and this surface does.
 *
 * 3. **`unread`, `truncated` and `gated` stay three things.** COULD NOT READ IT
 *    / READ IT, THERE WAS MORE / YOUR PLAN DOES NOT INCLUDE IT. Merging any two
 *    of them sends someone to the wrong place: a customer without the
 *    conversation add-on told their messages "could not be read" opens a
 *    support ticket for a billing question.
 *
 * And the rule underneath all three: an empty stream and a broken one are not
 * the same screen. The empty state is withheld whenever a source failed —
 * "nothing has happened yet" is a lie when half the sources never answered.
 */
export default function LeadStream({ leadId, composer, className }: LeadStreamProps) {
  const { t } = useTranslation('marketing');

  // Keyed UNDER ['marketing','lead',id] so the lead detail's own `invalidate()`
  // — which invalidates that prefix after logging an activity, changing status
  // or converting — refreshes this stream too, without either file knowing
  // about the other.
  const q = useQuery({
    queryKey: ['marketing', 'lead', leadId, 'stream'],
    queryFn: () => getLeadStream(leadId),
  });

  const items = q.data?.items ?? [];
  const unread = q.data?.unread ?? [];
  const truncated = q.data?.truncated ?? [];
  const gated = q.data?.gated ?? [];

  // The empty state is a CLAIM — "this person's history is empty" — and it is
  // only true if every source answered. With a source in `unread` the honest
  // screen is the named failure and nothing else. (`gated` is deliberately not
  // in this condition: a workspace without the conversation add-on genuinely
  // has no messages to show, and the banner above says which source that is.)
  const historyIsEmpty = items.length === 0 && unread.length === 0;

  return (
    <QueryStateBoundary
      isLoading={q.isLoading}
      isError={q.isError}
      onRetry={() => q.refetch()}
      errorMessage={t('leadDetail.stream.failed', 'Akış yüklenemedi.')}
    >
      <div className={className} data-testid="lead-stream">
        {unread.length > 0 && (
          <p data-testid="stream-unread" role="status" className="pb-1.5 text-xs text-warning">
            <span className="font-medium">{unread.join(', ')}</span>{' '}
            {t('leadDetail.stream.unread', 'okunamadı')} —{' '}
            {t(
              'leadDetail.stream.unreadHint',
              'bu akışta eksik satırlar var, kaç tane olduğunu bilmiyoruz',
            )}
          </p>
        )}
        {truncated.length > 0 && (
          <p
            data-testid="stream-truncated"
            role="status"
            className="pb-1.5 text-xs text-muted-foreground"
          >
            <span className="font-medium">{truncated.join(', ')}</span>{' '}
            {t('leadDetail.stream.truncated', 'kırpıldı')} —{' '}
            {t(
              'leadDetail.stream.truncatedHint',
              'yalnızca en yeni kayıtlar gösteriliyor, daha eski kayıtlar var',
            )}
          </p>
        )}
        {gated.length > 0 && (
          <p data-testid="stream-gated" role="status" className="pb-1.5 text-xs text-info">
            <span className="font-medium">{gated.join(', ')}</span>{' '}
            {t('leadDetail.stream.gated', 'paketine dahil değil')} —{' '}
            {t(
              'leadDetail.stream.gatedHint',
              'bu kaynak aboneliğinde yok; eklendiğinde geçmişiyle birlikte burada görünür',
            )}
          </p>
        )}

        {historyIsEmpty ? (
          <EmptyState
            data-testid="stream-empty"
            icon={<MessageSquare className="h-5 w-5" />}
            title={t('leadDetail.stream.empty.title', 'Bu kişiyle henüz bir şey yaşanmadı')}
            description={t(
              'leadDetail.stream.empty.desc',
              'Bir mesaj, arama ya da not eklendiğinde bu kişinin akışında burada görürsün.',
            )}
          />
        ) : (
          // Oldest -> newest, the order the endpoint returns and the order a
          // conversation reads. No `overflow` and no height: the host owns the
          // scroll (the surface's middle column scrolls, a tab does not).
          <ul className="flex flex-col gap-1">
            {items.map((i) => (i.kind === 'message' ? messageRow(i, t) : eventRow(i, t)))}
          </ul>
        )}

        {composer}
      </div>
    </QueryStateBoundary>
  );
}

type TFn = (key: string, defaultValue: string) => string;

/** A message: a bubble, on the side its direction puts it. */
function messageRow(i: LeadStreamItem, t: TFn) {
  const outbound = i.direction === 'OUTBOUND';
  const failed = i.deliveryStatus === 'FAILED';
  const AuthorIcon = i.authorType ? AUTHOR_ICON[i.authorType] : undefined;

  return (
    <li
      key={`message-${i.id}`}
      data-testid={`stream-item-${i.id}`}
      data-kind="message"
      data-shape="bubble"
      data-direction={i.direction ?? ''}
      data-delivery={i.deliveryStatus ?? ''}
      data-weight={rowWeight(i)}
      className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
          outbound
            ? 'bg-primary text-primary-foreground'
            : 'bg-surface border border-border text-foreground'
        } ${failed ? 'ring-1 ring-danger' : ''}`}
      >
        <div className="mb-0.5 flex items-center gap-1 text-[10px] opacity-70">
          {AuthorIcon && <AuthorIcon className="h-3 w-3" aria-hidden="true" />}
          <span>{i.authorName || i.authorType}</span>
          {i.channelType && <span>· {i.channelType}</span>}
          <span>· {fmtSlot(i.at)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{i.body}</div>
        {/* The Inbox's own treatment (ThreadPane.tsx:344), one line longer: the
            provider's reason rides along, because this surface is where someone
            comes back HOURS later to find out why a customer never answered,
            and the toast that carried the reason is long gone. */}
        {failed && (
          <div data-testid={`stream-failed-${i.id}`} className="mt-0.5 text-[10px] text-danger">
            {t('leadDetail.stream.messageFailed', 'Gönderilemedi')}
            {i.error ? `: ${i.error}` : ''}
          </div>
        )}
      </div>
    </li>
  );
}

/** A call, a note, a status move, or anything else logged on the lead: a
 *  timeline event, NOT a bubble. Nobody said it to anyone. */
function eventRow(i: LeadStreamItem, t: TFn) {
  const weight = rowWeight(i);
  const Icon = EVENT_ICON[i.kind] ?? Activity;
  const meta = [
    i.authorName,
    i.outcome,
    i.durationMinutes != null ? `${i.durationMinutes} ${t('leadDetail.stream.min', 'dk')}` : null,
    fmtSlot(i.at),
  ].filter(Boolean);

  return (
    <li
      key={`${i.kind}-${i.id}`}
      data-testid={`stream-item-${i.id}`}
      data-kind={i.kind}
      data-shape="event"
      // Both of the next two read the SAME `weight`; the class list stays
      // Tailwind's to retune, but the attribute cannot disagree with the paint.
      data-weight={weight}
      className={EVENT_CLASS[weight]}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{i.title}</p>
        {i.body && <p className="mt-0.5 text-muted-foreground">{i.body}</p>}
        {meta.length > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.join(' · ')}</p>
        )}
      </div>
    </li>
  );
}
