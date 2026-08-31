import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  FileText,
  MessageSquare,
  Mic,
  Phone,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { getLeadStream, type LeadStreamItem } from '../api/leadStream.service';
import StreamCallDetail from './StreamCallDetail';
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

/**
 * Which assignments earn a badge, and what it says.
 *
 * 'manual' is deliberately absent: a person reassigning a lead is the ordinary
 * case, and badging the ordinary case badges every row. What a reader needs to
 * spot is the two they did NOT do by hand.
 */
const ASSIGNMENT_LABEL: Record<string, [key: string, fallback: string] | undefined> = {
  auto: ['leadDetail.stream.assignment.auto', 'Otomatik'],
  bulk: ['leadDetail.stream.assignment.bulk', 'Toplu'],
};

const AUTHOR_ICON: Record<string, React.ElementType> = {
  AI: Sparkles,
  AGENT: User,
};

type TFn = (key: string, defaultValue: string) => string;

/**
 * The provider payload on a message, narrowed to the two fields anything here
 * reads. `unknown` in, a shape or nothing out — a message with no `meta`, a
 * `meta` that is a string, and a `meta.raw` that is an array all answer the
 * same way rather than throwing halfway down an optional chain.
 */
function providerRaw(meta: unknown): { kind?: string; audioUrl?: unknown; documentUrl?: unknown } {
  if (!meta || typeof meta !== 'object') return {};
  const raw = (meta as { raw?: unknown }).raw;
  if (!raw || typeof raw !== 'object') return {};
  return raw as { kind?: string; audioUrl?: unknown; documentUrl?: unknown };
}

/**
 * The backend names a failed / cut / withheld source in its own words —
 * `mesajlar`, `hareketler`, `yazarlar`. Those tokens are a WIRE format, not a
 * sentence: printed verbatim they drop a Turkish word into the middle of an
 * Arabic, Russian or Uzbek line, and it is the one word that says WHAT is
 * missing.
 *
 * A token with no key falls back to itself. A source added to the backend
 * tomorrow reads oddly in four locales; rendering nothing would turn "X could
 * not be read" into " could not be read", which reads like a bug in the app
 * rather than a gap in the catalogue.
 */
const sourceNames = (sources: string[], t: TFn) =>
  sources.map((s) => t(`leadDetail.stream.source.${s}`, s)).join(', ');

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
 *
 * ## Why the auto-scroll is in here and not in the two hosts
 *
 * The stream reads oldest -> newest, so without one, opening a person lands the
 * rep on the FIRST thing that ever happened to them and sending a reply does
 * not move the view. ThreadPane had the answer already and it is carried over
 * verbatim in behaviour: jump on a new person, follow your OWN outbound reply
 * down, and never move for an inbound one — this is an AI-agent inbox where
 * messages stream in continuously, and yanking a rep who scrolled up to read
 * history is how they lose the sentence they were on.
 *
 * The docstring above says the HOST owns the scroll, and it still does — but
 * `scrollIntoView` acts on the nearest scrollable ancestor, so owning the
 * anchor never required owning the overflow. That is the whole reason this is
 * not a prop: an optional `autoScroll` would be behaviour a consumer has to
 * remember, and the third consumer is the one that forgets. Mounting the
 * component is the opt-in.
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

  /**
   * Which call rows are open, BY ROW ID.
   *
   * Keyed rather than a single `expandedId`, and keyed rather than held inside
   * the row: a person can have several calls worth comparing (the one that got
   * a promise and the one that did not), and this lineage has twice shipped
   * per-record state that was really per-component and leaked one record's
   * answer onto another's.
   *
   * Reset when the person changes, and NEITHER host passes a `key` — this
   * component survives a person switch, so without the reset the map does too.
   *
   * The ids are unique across leads, so a stale entry cannot open a wrong row,
   * and arriving at a person for the FIRST time is safe whatever is left in the
   * map. The case the reset is for is the REVISIT: A -> B -> A re-mounts a
   * panel for a row the rep opened minutes ago and puts a recording request on
   * the wire before they have asked for one — exactly the request-on-load this
   * expansion exists to avoid. Held by `LeadStream.test.tsx`
   * ("forgets which calls were open when the person changes").
   */
  const [openCalls, setOpenCalls] = useState<Record<string, boolean>>({});
  useEffect(() => setOpenCalls({}), [leadId]);
  const toggleCall = (id: string) => setOpenCalls((o) => ({ ...o, [id]: !o[id] }));

  // See the docstring. Three-way, and the third way is doing nothing.
  const endRef = useRef<HTMLDivElement | null>(null);
  // Which person we have already jumped for. Not "did the id change": the
  // stream arrives ASYNCHRONOUSLY, so a plain previous-id check fires its jump
  // against an empty list on mount and then never fires again once the rows
  // land. This flips only once rows exist.
  const jumpedFor = useRef<string | null>(null);
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  const lastId = last?.id;
  const lastIsOurReply = last?.kind === 'message' && last.direction === 'OUTBOUND';

  useEffect(() => {
    if (items.length === 0) return;
    if (jumpedFor.current !== leadId) {
      jumpedFor.current = leadId;
      endRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (lastIsOurReply) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    // `lastId` rather than the array: a refetch that returns the same rows must
    // not re-scroll, and an inbound arrival must change the deps so the
    // outbound branch is re-evaluated and DECLINES rather than never running.
  }, [leadId, items.length, lastId, lastIsOurReply]);

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
            <span className="font-medium">{sourceNames(unread, t)}</span>{' '}
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
            <span className="font-medium">{sourceNames(truncated, t)}</span>{' '}
            {t('leadDetail.stream.truncated', 'kırpıldı')} —{' '}
            {t(
              'leadDetail.stream.truncatedHint',
              'yalnızca en yeni kayıtlar gösteriliyor, daha eski kayıtlar var',
            )}
          </p>
        )}
        {gated.length > 0 && (
          <p data-testid="stream-gated" role="status" className="pb-1.5 text-xs text-info">
            <span className="font-medium">{sourceNames(gated, t)}</span>{' '}
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
            {items.map((i) =>
              i.kind === 'message'
                ? messageRow(i, t)
                : eventRow(i, t, !!openCalls[i.id], toggleCall),
            )}
          </ul>
        )}

        {/* The bottom of the history. Inside whatever the host scrolls. */}
        <div ref={endRef} data-testid="stream-end" aria-hidden="true" />

        {composer}
      </div>
    </QueryStateBoundary>
  );
}

/** A message: a bubble, on the side its direction puts it. */
function messageRow(i: LeadStreamItem, t: TFn) {
  const outbound = i.direction === 'OUTBOUND';
  const failed = i.deliveryStatus === 'FAILED';
  const AuthorIcon = i.authorType ? AUTHOR_ICON[i.authorType] : undefined;
  // A voicemail and a fax arrive as ordinary inbound messages; `meta.raw.kind`
  // is the only thing that says otherwise, and the media link is the only
  // thing that makes them useful. ThreadPane read both, and this stream stands
  // where ThreadPane stood.
  const raw = providerRaw(i.meta);
  const isVoicemail = raw.kind === 'VOICEMAIL';
  const isFax = raw.kind === 'FAX';
  const audioUrl = typeof raw.audioUrl === 'string' ? raw.audioUrl : null;
  // ThreadPane's guard, kept: the URL is the provider's, so anything that is
  // not https is refused rather than rendered as something to click.
  const documentUrl =
    typeof raw.documentUrl === 'string' && raw.documentUrl.startsWith('https://')
      ? raw.documentUrl
      : null;

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
        {isVoicemail && (
          <Badge tone="neutral" size="sm" className="mb-1 gap-1">
            <Mic className="h-3 w-3" aria-hidden="true" />
            {t('leadDetail.stream.voicemail', 'Sesli mesaj')}
          </Badge>
        )}
        {isFax && (
          <Badge tone="neutral" size="sm" className="mb-1 gap-1">
            <FileText className="h-3 w-3" aria-hidden="true" />
            {t('leadDetail.stream.fax', 'Faks')}
          </Badge>
        )}
        <div className="whitespace-pre-wrap break-words">{i.body}</div>
        {isVoicemail && audioUrl && (
          <audio
            data-testid={`stream-voicemail-${i.id}`}
            controls
            preload="none"
            src={audioUrl}
            className="mt-1.5 h-8 max-w-full"
          />
        )}
        {isFax && documentUrl && (
          <a
            data-testid={`stream-fax-${i.id}`}
            href={documentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-xs underline underline-offset-2"
          >
            <FileText className="h-3 w-3" aria-hidden="true" />
            {t('leadDetail.stream.faxOpen', 'Belgeyi aç')}
          </a>
        )}
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

/**
 * A call, a note, a status move, or anything else logged on the lead: a
 * timeline event, NOT a bubble. Nobody said it to anyone.
 *
 * A CALL row that knows which call it was opens: the recording and the AI
 * analysis mount underneath it (StreamCallDetail). `open`/`onToggleCall` are
 * passed down rather than held here because this is a function, not a
 * component — and because the state has to be keyed by row for a person with
 * several calls (see `openCalls` above).
 */
function eventRow(
  i: LeadStreamItem,
  t: TFn,
  open: boolean,
  onToggleCall: (id: string) => void,
) {
  const weight = rowWeight(i);
  /**
   * A CALL row with no `callId` is the ORDINARY case, not a leftover.
   *
   * A rep who dialled from their own handset and then wrote down what happened
   * logs the call by hand (the Arama button in LogActivityDialog), and a
   * hand-logged call has no `SalesCall` behind it — nothing to play, nothing to
   * analyse, today or ever. Calls mirrored before the id was carried land here
   * too, and no backfill can change either group. Both render exactly as this
   * row always has: a line of history with nothing to open, rather than a
   * player that would never load.
   */
  const openable = i.kind === 'call' && !!i.callId;
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
        <p className="truncate font-medium">
          {i.title}
          {/* Restores what died with ActivityTimeline. Only 'auto' and 'bulk'
              are badged: a manual assignment is a person doing their job, and
              a badge on the ordinary case is a badge on every row. */}
          {ASSIGNMENT_LABEL[i.assignment ?? ''] && (
            <Badge
              data-testid={`stream-assignment-${i.id}`}
              tone={i.assignment === 'auto' ? 'primary' : 'warning'}
              size="sm"
              className="ms-1.5 align-middle"
            >
              {t(...ASSIGNMENT_LABEL[i.assignment ?? '']!)}
            </Badge>
          )}
        </p>
        {i.body && <p className="mt-0.5 text-muted-foreground">{i.body}</p>}
        {meta.length > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.join(' · ')}</p>
        )}
        {openable && (
          <button
            type="button"
            data-testid={`stream-call-toggle-${i.id}`}
            aria-expanded={open}
            onClick={() => onToggleCall(i.id)}
            className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t('leadDetail.stream.callDetail', 'Kayıt ve analiz')}
          </button>
        )}
        {/* Mounted on EXPAND, never on load: a person with fifty calls would
            otherwise put fifty recording requests on the wire before the rep
            has decided which call they care about. */}
        {openable && open && <StreamCallDetail callId={i.callId!} itemId={i.id} />}
      </div>
    </li>
  );
}
