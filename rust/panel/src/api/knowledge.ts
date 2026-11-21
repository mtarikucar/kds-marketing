import { request, seg } from './client';
import type { Actor, Rfc3339, Uuid } from './types';

// The knowledge base ("Bilgi bankası", design 2026-11-19 §4): its one read and every write the
// owner's page makes, with their types, in one file so they are easy to hold against the server's
// (`jt_app::usecases::knowledge`, `jt_panel_http::routes::knowledge`). The owner's edits apply
// at once: there is no draft, submit or approval.

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** `jt_strategy::Period` of a cap. */
export type CapPeriod = 'weekly' | 'monthly';
export const CAP_PERIODS: readonly CapPeriod[] = ['monthly', 'weekly'];

/** `jt_knowledge::Cap`: at most `amount_minor` (minor units of `currency`) per `period`. */
export interface Cap {
  amount_minor: number;
  period: CapPeriod;
  currency: string;
}

/** `jt_knowledge::CapInput`: the currency is the budget's own, never written. */
export interface CapInput {
  amount_minor: number;
  period?: CapPeriod;
}

/**
 * `read::AttachmentOut`: a link, or a studio file (an image, an MP4 or a PDF; knowledge, never a
 * library material) with a link usable until `expires_at` when one was signed. A write answers the
 * stored form (`jt_knowledge::Attachment`): the same without `url` and `expires_at`.
 */
export type KnowledgeAttachment =
  | { kind: 'link'; url: string; title?: string | null }
  | { kind: 'file'; file_id: Uuid; name: string; mime: string; url?: string | null; expires_at?: Rfc3339 | null };

/** `jt_knowledge::AttachmentInput`: a link with an optional title, or an uploaded file's id. */
export type AttachmentInput = { kind: 'link'; url: string; title?: string } | { kind: 'file'; file_id: Uuid };

/** What an agent's filing of a note last wrote into a card (`read::Filed`). */
export interface FiledMark {
  at: Rfc3339;
  summary: string | null;
}

/** `KnowledgeOut.cards[]`: a live card, by position. `key` is a seed card's fixed key. */
export interface CardOut {
  id: Uuid;
  key: string | null;
  title: string;
  body: string;
  attachments: KnowledgeAttachment[];
  position?: number;
  revision: number;
  updated_at: Rfc3339;
  filed: FiledMark | null;
}

/**
 * `jt_knowledge::Card`, what a card write answers: the card as stored (attachments without
 * links, no `filed`), with who made and last changed it and, once removed, `archived_at`.
 */
export interface StoredCard {
  id: Uuid;
  key: string | null;
  title: string;
  body: string;
  attachments: KnowledgeAttachment[];
  position: number;
  revision: number;
  created_at: Rfc3339;
  created_by: Actor;
  updated_at: Rfc3339;
  updated_by: Actor;
  archived_at: Rfc3339 | null;
}

/** One account whose posts wait for the owner while the switch is off. */
export interface ApprovalAccount {
  capability_id: Uuid;
  name: string;
  kind: string;
}

/** `KnowledgeOut.rules`: "Kurallar". */
export interface RulesOut {
  /** `knowledge_settings.rules_revision`, the `expected_revision` of a save. */
  revision: number;
  prohibitions: string[];
  /** The ad budget's ceiling; `null`: no ads ("Reklam yok"). */
  ad_cap: Cap | null;
  /** The paid messages' limit; `null`: none of its own. */
  message_cap: Cap | null;
  /** "Her paylaşım onayıma gelsin". */
  post_approval: boolean;
  post_approval_accounts: ApprovalAccount[];
  /** A TikTok account is connected: its posts always need its own screen. */
  tiktok_connected: boolean;
  /** The workspace has a metered capability (SMS and the like): the message field is shown. */
  metered: boolean;
  /** The inbox's automatic replies. */
  auto_reply: AutoReplyView;
}

/** `jt_knowledge::PriceRange`: the automatic quotes' range, in minor units of `currency`. */
export interface PriceRange {
  min_minor: number;
  max_minor: number;
  currency: string;
}

/** `read::AutoReplyView`: the inbox's automatic replies as the rules show them. */
export interface AutoReplyView {
  /** The server has a model configured: the switches can be turned on. */
  available: boolean;
  /** `no_key`: no model on the server; `standard_missing`: on, but the range or the "Standart iş ve fiyat" card is missing. */
  off_reason: 'no_key' | 'standard_missing' | null;
  capability_ids: Uuid[];
  price: PriceRange | null;
  /** The WhatsApp numbers they can be turned on for. */
  accounts: ApprovalAccount[];
  /** The owner's email notices of a hand-over or an order. */
  notify: NotifyView;
  /** The bargaining discount, in percent: the preferred step and the largest (0: none). */
  discount_preferred_pct: number;
  discount_max_pct: number;
}

/** `read::NotifyView`: the owner's email notices. */
export interface NotifyView {
  /** A verified mailbox exists: the notices can go out. */
  available: boolean;
  /** They are on (the default). */
  on: boolean;
  /** The address they go out from. */
  from: string | null;
}

/** `jt_knowledge::AutoReplyInput`: the numbers and the range (left out: the stored one). */
export interface AutoReplyInput {
  capability_ids: Uuid[];
  min_minor?: number;
  max_minor?: number;
  /** The owner's email notices on or off; left out: as stored. */
  notify_email?: boolean;
  /** The bargaining discount in percent (0 to 50, preferred at most largest); left out: as stored. */
  discount_preferred_pct?: number;
  discount_max_pct?: number;
}

/** `KnowledgeOut.goals`: "Hedefler". */
export interface GoalsOut {
  revision: number;
  items: string[];
}

/** `jt_knowledge::NoteStatus`. */
export type NoteStatus = 'open' | 'filed' | 'dismissed' | 'withdrawn';

/** `jt_knowledge::NoteOutcome`: every field reads as empty when missing. */
export interface NoteOutcome {
  cards?: { card_id: Uuid; revision: number }[];
  rules?: string[];
  goals?: string[];
  post_request?: { area_id: Uuid } | null;
  proposals?: Uuid[];
  summary?: string | null;
  dismissed?: string | null;
}

/**
 * `read::NoteOut` (`KnowledgeOut.notes[]`): open notes and the last five closed, newest first;
 * its files named and linked; `claimed_until` while an agent holds it (never the claim itself).
 */
export interface NoteOut {
  id: Uuid;
  text: string;
  links: string[];
  files: KnowledgeAttachment[];
  status: NoteStatus;
  revision: number;
  created_at: Rfc3339;
  created_by: Uuid;
  claimed_until: Rfc3339 | null;
  closed_at: Rfc3339 | null;
  outcome: NoteOutcome | null;
}

/** `jt_knowledge::Note`, what `note_add` and `note_withdraw` answer: the note as stored. */
export interface StoredNote {
  id: Uuid;
  text: string;
  links: string[];
  file_ids: Uuid[];
  status: NoteStatus;
  revision: number;
  created_at: Rfc3339;
  created_by: Uuid;
  closed_at: Rfc3339 | null;
  outcome: NoteOutcome | null;
}

/**
 * `KnowledgeOut.notes_agent`: whether an agent will file a note. `none`: no key with a work
 * permission; `asleep`: keys, none with a usable wake address (it files at its next check-in,
 * `next_at`); `late`: that check-in already passed; `ok`: an agent is called at once.
 */
export interface AgentReach {
  state: 'none' | 'asleep' | 'late' | 'ok';
  next_at: Rfc3339 | null;
}

/** `jt_knowledge::ProposalKind`. */
export type ProposalKind = 'card_new' | 'card_edit' | 'rule_add' | 'goal_add';

/** `jt_knowledge::ProposalStatus`. */
export type ProposalStatus = 'pending' | 'accepted' | 'skipped' | 'expired' | 'superseded';

/**
 * `jt_knowledge::Proposal`: a pending one in `KnowledgeOut.proposals[]` ("Ajanın önerileri"), and
 * what accepting or skipping it answers.
 */
export interface ProposalOut {
  id: Uuid;
  kind: ProposalKind;
  status?: ProposalStatus;
  /** The card a `card_edit` rewrites. */
  card_id: Uuid | null;
  title: string | null;
  /** A card's whole new text, a prohibition or a goal. */
  body: string;
  /** One line in Turkish: why the owner might add it. */
  reason: string;
  base_revision?: number | null;
  proposed_at: Rfc3339;
  expires_at: Rfc3339;
  proposed_by?: { kind: 'agent'; connection_id: Uuid } | { kind: 'system'; component: string };
}

/** A derivation an agent owes the frame. */
export type DerivePart = 'posting' | 'prospecting';

/** `KnowledgeOut.frame` (§4.10.3): the page reads only whether a derivation is due. */
export interface FrameOut {
  id?: Uuid;
  number: number;
  revision?: number;
  posting_derived?: number;
  prospecting_derived?: number;
  derive_due: DerivePart[];
}

/** `GET /api/knowledge` (`strategy.knowledge_get`). */
export interface KnowledgeOut {
  revision: number;
  /** No live card has text (§4.5.1): the one predicate every page reads. */
  empty: boolean;
  cards: CardOut[];
  rules: RulesOut;
  goals: GoalsOut;
  notes: NoteOut[];
  notes_agent: AgentReach;
  proposals: ProposalOut[];
  frame: FrameOut | null;
}

/** `jt_knowledge::Cause`: why a revision was written. */
export type KnowledgeCause = 'seed' | 'backfill' | 'resync' | 'owner' | 'proposal' | 'note' | 'system';

/** `jt_knowledge::Revision` of a card: the card as it was after that change. */
export interface RevisionOut {
  id: Uuid;
  subject: 'card' | 'rules' | 'goals';
  card_id: Uuid | null;
  revision: number;
  kb_revision: number;
  content: {
    key?: string | null;
    title?: string;
    body?: string;
    attachments?: KnowledgeAttachment[];
    position?: number;
    archived?: boolean;
  };
  cause: KnowledgeCause;
  source_id: Uuid | null;
  at: Rfc3339;
  /** Who wrote it; a person is named from the team list (the revision carries only the id). */
  by: Actor;
}

/** `jt_app::usecases::knowledge::cards::HistoryOut`: newest first; `next_before` continues it. */
export interface HistoryOut {
  revisions: RevisionOut[];
  next_before: number | null;
}

/** `strategy.rules_save`'s input: the whole box. */
export interface RulesInput {
  expected_revision: number;
  prohibitions: string[];
  /** `null`: no ads. */
  ad_budget: CapInput | null;
  /** `null`: no limit of its own. */
  message_budget: CapInput | null;
  post_approval: boolean;
  /** Left out: unchanged. */
  post_approval_accounts?: Uuid[];
  /** Left out: unchanged. */
  auto_reply?: AutoReplyInput;
}

/**
 * `rules::RulesOut`, what `rules_save` and `post_approval_set` answer: the rules as stored (the
 * listed accounts by id; the read names them), and how many running ad campaigns a lowered ad
 * budget stopped at once (`rules_save` only; 0 otherwise).
 */
export interface RulesSaveOut {
  revision: number;
  prohibitions: string[];
  ad_cap: Cap | null;
  message_cap: Cap | null;
  post_approval: boolean;
  post_approval_accounts: Uuid[];
  stopped_campaigns: number;
}

// ---------------------------------------------------------------------------------------------
// Limits (`jt_knowledge::limits`, checked again by the server)
// ---------------------------------------------------------------------------------------------

export const LIMITS = {
  cardTitle: 80,
  cardBody: 8000,
  liveCards: 50,
  attachments: 10,
  prohibitions: 100,
  prohibition: 500,
  goals: 20,
  goal: 300,
  noteText: 4000,
  noteLinks: 10,
  noteFiles: 10,
  link: 2048,
} as const;

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** `GET /api/knowledge`: the whole knowledge base, seeded on first read. */
export function getKnowledge(): Promise<KnowledgeOut> {
  return request('GET', '/api/knowledge');
}

/** `POST /api/knowledge/cards`: a card of the owner's own (no key), revision 1. */
export function createCard(input: {
  title: string;
  body?: string;
  attachments?: AttachmentInput[];
  position?: number;
}): Promise<StoredCard> {
  return request('POST', '/api/knowledge/cards', { body: input });
}

/** `PATCH /api/knowledge/cards/{id}`: the fields given replace the card's. */
export function updateCard(
  id: Uuid,
  input: { expected_revision: number; title?: string; body?: string; attachments?: AttachmentInput[]; position?: number },
): Promise<StoredCard> {
  return request('PATCH', `/api/knowledge/cards/${seg(id)}`, { body: input });
}

/** `POST /api/knowledge/cards/{id}/archive`: removes (`archived: true`) or restores a card. */
export function archiveCard(id: Uuid, input: { expected_revision: number; archived: boolean }): Promise<StoredCard> {
  return request('POST', `/api/knowledge/cards/${seg(id)}/archive`, { body: input });
}

/** `GET /api/knowledge/cards/{id}/history`: 50 revisions a page, newest first, before `before`. */
export function cardHistory(id: Uuid, before?: number | null): Promise<HistoryOut> {
  return request('GET', `/api/knowledge/cards/${seg(id)}/history`, { query: { before: before ?? undefined } });
}

/** `PUT /api/knowledge/rules`: the whole Kurallar box at its revision. */
export function saveRules(input: RulesInput): Promise<RulesSaveOut> {
  return request('PUT', '/api/knowledge/rules', { body: input });
}

/** `POST /api/knowledge/post-approval`: one account into (`required`) or out of the list. */
export function setPostApproval(input: { capability_id: Uuid; required: boolean; expected_revision: number }): Promise<RulesSaveOut> {
  return request('POST', '/api/knowledge/post-approval', { body: input });
}

/** `PUT /api/knowledge/goals`: the whole Hedefler list at its revision. */
export function saveGoals(input: { expected_revision: number; items: string[] }): Promise<GoalsOut> {
  return request('PUT', '/api/knowledge/goals', { body: input });
}

/** `POST /api/knowledge/notes`: "Ajanlara bir şey anlat"; a replay of `request_key` answers the same note. */
export function addNote(input: { request_key: string; text: string; links?: string[]; file_ids?: Uuid[] }): Promise<StoredNote> {
  return request('POST', '/api/knowledge/notes', { body: input });
}

/** `POST /api/knowledge/notes/{id}/withdraw`: takes back an open note ("Geri al"). */
export function withdrawNote(id: Uuid, input: { expected_revision: number }): Promise<StoredNote> {
  return request('POST', `/api/knowledge/notes/${seg(id)}/withdraw`, { body: input });
}

/** `POST /api/knowledge/proposals/{id}/accept`: adds a pending proposal ("Ekle"). */
export function acceptProposal(id: Uuid): Promise<ProposalOut> {
  return request('POST', `/api/knowledge/proposals/${seg(id)}/accept`);
}

/** `POST /api/knowledge/proposals/{id}/skip`: skips a pending proposal ("Geç"). */
export function skipProposal(id: Uuid): Promise<ProposalOut> {
  return request('POST', `/api/knowledge/proposals/${seg(id)}/skip`);
}
