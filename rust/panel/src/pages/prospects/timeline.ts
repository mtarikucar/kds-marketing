import type { Actor, InboxActor, InboxJourneyOut, JourneyStatus, LedgerEntryOut, ProspectGetOut } from '@/api/types';
import type { PoolCopy } from './copy';

// A prospect's progress in one list (spec 2026-11-10-prospects-pool-redesign-design.md): the
// pool's ledger entries about it, and once it is in contact its journey's events and notes, newest
// first. Pure: the page supplies the names and labels.

/**
 * How a journey note of a hand-off begins (`↗ WhatsApp: …`, `↗ Instagram: …`): a message the
 * person sent from their own app, which Jeeta only prepared. The mark is the same in every
 * language, so the timeline and the stage steps can count it as contact.
 */
export const HANDOFF_MARK = '↗ ';
const HANDOFF = /^↗ (WhatsApp|Instagram): ([\s\S]*)$/;

/** How loudly an entry is drawn: what a person did stands out, bookkeeping recedes. */
export type TimelineTone = 'human' | 'system' | 'good' | 'bad';

export interface TimelineEntry {
  id: string;
  at: string;
  title: string;
  detail?: string;
  tone: TimelineTone;
  /** Where the entry leads (a conversation), when it leads anywhere. */
  href?: string;
}

export interface TimelineWords {
  copy: PoolCopy;
  member: (userId: string) => string;
  agent: (connectionId: string) => string;
  /** A prospect field's label (`phone`, `sector`, `notes`, …), or `null` for one not worth naming. */
  field: (name: string) => string | null;
  /** The label of a contact field only (`phone`, `email`, …): what a new record is summed up by. */
  contactField: (name: string) => string | null;
  rejectReason: (key: string) => string;
  dncReason: (key: string) => string;
  via: (key: string) => string;
  money: (amountMinor: number, currency: string) => string;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
/** The labels of `names`, each once, in order. */
const labels = (names: string[], label: (name: string) => string | null): string[] => [
  ...new Set(names.map(label).filter((x): x is string => !!x)),
];

function ledgerWho(w: TimelineWords, actor: Actor): string {
  if (actor.kind === 'human') return w.member(actor.user_id);
  if (actor.kind === 'agent') return w.agent(actor.connection_id);
  return w.copy('system');
}

function journeyWho(w: TimelineWords, actor: InboxActor): string {
  if (actor === 'system') return w.copy('system');
  if (actor === 'agent') return w.copy('agent');
  return w.member(actor.human);
}

function fromLedger(w: TimelineWords, data: ProspectGetOut, row: LedgerEntryOut, href: string | undefined): TimelineEntry {
  const { copy } = w;
  const { action, actor, at } = row.entry;
  const payload = record(row.entry.payload);
  const who = ledgerWho(w, actor);
  const base = { id: `ledger-${row.id}`, at };
  const human: TimelineTone = actor.kind === 'system' ? 'system' : 'human';
  switch (action) {
    case 'prospects.created': {
      const fields = labels(list(payload.fields), w.contactField);
      const via = text(payload.via);
      return { ...base, tone: human, title: copy('tlCreated', { who }), detail: [fields.join(', '), via && w.via(via)].filter(Boolean).join(' · ') || undefined };
    }
    case 'prospects.updated': {
      const names = list(payload.fields);
      if (names.length === 1 && names[0] === 'notes') return { ...base, tone: human, title: copy('tlNotes', { who }) };
      const fields = labels(names, w.field);
      return { ...base, tone: human, title: copy('tlUpdated', { who }), detail: fields.join(', ') || undefined };
    }
    case 'prospects.scored': {
      const score = typeof payload.score === 'number' ? payload.score : null;
      const digest = text(payload.digest);
      // The score row this entry wrote: same score and rubric, nearest in time.
      const match = data.scores
        .filter((s) => s.score === score && (!digest || s.rubric_digest === digest))
        .sort((a, b) => Math.abs(Date.parse(a.at) - Date.parse(at)) - Math.abs(Date.parse(b.at) - Date.parse(at)))[0];
      return {
        ...base,
        tone: 'system',
        title: copy('tlScored', { score: score ?? '—' }),
        detail: match?.reasons.map((r) => `${r.criterion} ${r.points}`).join(' · ') || undefined,
      };
    }
    case 'prospects.qualified':
      return payload.auto === true
        ? { ...base, tone: 'good', title: copy('tlQualifiedAuto'), detail: typeof payload.score === 'number' ? copy('tlQualifiedAutoBody', { score: payload.score }) : undefined }
        : { ...base, tone: 'good', title: copy('tlQualified', { who }) };
    case 'prospects.rejected': {
      const reason = text(payload.reason);
      return { ...base, tone: 'bad', title: copy('tlRejected', { who }), detail: reason ? w.rejectReason(reason) : undefined };
    }
    case 'prospects.reopened':
      return { ...base, tone: human, title: copy('tlReopened', { who }) };
    case 'prospects.promoted':
      return { ...base, tone: 'good', title: copy('tlPromoted'), detail: copy('tlPromotedBody'), href };
    case 'prospects.do_not_contact': {
      const reason = text(payload.reason);
      return { ...base, tone: 'bad', title: copy('tlBlocked'), detail: reason ? w.dncReason(reason) : undefined };
    }
    case 'prospects.dnc_lifted':
      return { ...base, tone: human, title: copy('tlUnblocked') };
    case 'prospects.erased':
    case 'prospects.purged':
      return { ...base, tone: 'system', title: copy('tlErased') };
    default:
      return { ...base, tone: 'system', title: copy('tlOther'), detail: action };
  }
}

function fromJourney(w: TimelineWords, journey: InboxJourneyOut, href: string | undefined): TimelineEntry[] {
  const { copy } = w;
  const out: TimelineEntry[] = [];
  for (const event of journey.events) {
    const base = { id: `event-${event.id}`, at: event.at };
    // The server may know kinds this panel does not name yet: read them loosely.
    const kind: unknown = event.kind;
    const name = typeof kind === 'string' ? kind : Object.keys(record(kind))[0];
    const body = typeof kind === 'string' ? {} : record(record(kind)[name ?? '']);
    switch (name) {
      case 'message_received':
        out.push({ ...base, tone: 'good', title: copy('tlMessageIn'), href });
        break;
      case 'replied':
        out.push({ ...base, tone: 'human', title: copy('tlMessageOut'), detail: journeyWho(w, event.source), href });
        break;
      case 'outreach_sent':
        out.push({ ...base, tone: 'system', title: copy('tlOutreach'), detail: typeof body.step === 'number' ? copy('tlOutreachBody', { n: body.step }) : undefined, href });
        break;
      case 'call_made':
        out.push({ ...base, tone: 'human', title: copy(body.connected === true ? 'tlCallOk' : 'tlCallMiss') });
        break;
      case 'appointment_booked':
        out.push({ ...base, tone: 'good', title: copy('tlAppointment') });
        break;
      case 'meeting_held':
        out.push({ ...base, tone: 'good', title: copy('tlMeeting') });
        break;
      case 'quote_sent':
        out.push({ ...base, tone: 'human', title: copy('tlQuote') });
        break;
      case 'quote_accepted':
        out.push({ ...base, tone: 'good', title: copy('tlQuoteOk') });
        break;
      case 'won':
        out.push({
          ...base,
          tone: 'good',
          title: copy('tlWon'),
          detail: [text(body.product), typeof body.amount_minor === 'number' && text(body.currency) ? w.money(body.amount_minor, body.currency as string) : null].filter(Boolean).join(' · ') || undefined,
        });
        break;
      case 'lost':
        out.push({ ...base, tone: 'bad', title: copy('tlLost'), detail: event.reason_label ?? undefined });
        break;
      case 'snoozed':
        out.push({ ...base, tone: 'system', title: copy('tlSnoozed') });
        break;
      case 'reopened':
        out.push({ ...base, tone: 'human', title: copy('tlJourneyReopened') });
        break;
      case 'merged':
        out.push({ ...base, tone: 'system', title: copy('tlMerged') });
        break;
      default:
        break;
    }
  }
  for (const note of journey.notes) {
    const who = journeyWho(w, note.author);
    const handoff = HANDOFF.exec(note.text);
    out.push(
      handoff
        ? { id: `note-${note.id}`, at: note.at, tone: 'human', title: copy('tlHandoff', { who, way: handoff[1] }), detail: handoff[2] }
        : { id: `note-${note.id}`, at: note.at, tone: 'human', title: copy('tlNote', { who }), detail: note.text },
    );
  }
  return out;
}

/** Every entry about the prospect, newest first; entries of one instant keep the order they were written in. */
export function buildTimeline(
  w: TimelineWords,
  data: ProspectGetOut,
  journey: InboxJourneyOut | undefined,
  conversationHref: string | undefined,
): TimelineEntry[] {
  const ledger = data.ledger.map((row) => ({ seq: row.id, entry: fromLedger(w, data, row, conversationHref) }));
  const later = journey ? fromJourney(w, journey, conversationHref).map((entry) => ({ seq: Number.MAX_SAFE_INTEGER, entry })) : [];
  return [...ledger, ...later]
    .sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at) || b.seq - a.seq)
    .map((x) => x.entry);
}

export type StepKey = 'found' | 'scored' | 'qualified' | 'contacted' | 'replied' | 'meeting' | 'won';
export const STEPS: readonly StepKey[] = ['found', 'scored', 'qualified', 'contacted', 'replied', 'meeting', 'won'];
export type StepState = 'done' | 'now' | 'todo';

export interface StageView {
  steps: { key: StepKey; state: StepState }[];
  /** Why the prospect goes no further, when it does not. */
  closed: 'rejected' | 'blocked' | 'lost' | null;
}

const MEETING_OR_LATER: readonly JourneyStatus[] = ['appointment', 'met', 'quoted', 'pending', 'won'];

/** Where the prospect stands: each step it reached, the last of them as "now". */
export function stageOf(data: ProspectGetOut, journey: InboxJourneyOut | undefined): StageView {
  const p = data.prospect;
  const kinds = (journey?.events ?? []).map((e) => {
    const kind: unknown = e.kind;
    return typeof kind === 'string' ? kind : Object.keys(record(kind))[0];
  });
  const status = journey?.journey.status;
  const reached: Record<StepKey, boolean> = {
    found: true,
    scored: p.latest_score !== null || data.scores.length > 0,
    qualified: p.status === 'qualified' || p.status === 'promoted' || p.promoted !== null,
    contacted:
      kinds.some((k) => k === 'replied' || k === 'outreach_sent' || k === 'call_made') ||
      (journey?.notes ?? []).some((n) => HANDOFF.test(n.text)) ||
      (!!status && status !== 'new' && status !== 'lost'),
    replied: kinds.includes('message_received'),
    meeting: kinds.some((k) => k === 'appointment_booked' || k === 'meeting_held') || (!!status && MEETING_OR_LATER.includes(status)),
    won: status === 'won',
  };
  const last = [...STEPS].reverse().find((k) => reached[k]) ?? 'found';
  return {
    steps: STEPS.map((key) => ({ key, state: key === last ? 'now' : reached[key] ? 'done' : 'todo' })),
    closed: p.status === 'rejected' ? 'rejected' : p.status === 'do_not_contact' ? 'blocked' : status === 'lost' ? 'lost' : null,
  };
}
