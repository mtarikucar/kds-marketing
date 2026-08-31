import marketingApi from './marketingApi';

/**
 * How an item should READ, not what table it came from — the backend's own
 * words (lead-stream.service.ts). `message` is one source; the other four are
 * all LeadActivity rows, split because a logged call, a note, a status move and
 * everything else are four different things to look at.
 */
export type LeadStreamKind = 'message' | 'call' | 'note' | 'status' | 'activity';

/**
 * One row of `GET /marketing/leads/:id/timeline`.
 *
 * EVERY field is always present: the backend sets the ones a given kind does
 * not use to `null` rather than omitting them, so `item.error` is a read, never
 * an optional-chain. Typed here the same way (`| null`, not `?`) so TypeScript
 * carries that guarantee instead of quietly permitting `undefined` and letting
 * a `deliveryStatus === undefined` branch look like a settled question.
 */
export interface LeadStreamItem {
  kind: LeadStreamKind;
  /** Row id. Message ids and activity ids share no space; `kind` separates them. */
  id: string;
  /** ISO 8601. */
  at: string;
  /** The activity's title. Null on a message: a message's content is its body. */
  title: string | null;
  /** Message body, or the activity's description. */
  body: string | null;

  // ── messages only (null on every activity) ───────────────────────────────
  direction: 'INBOUND' | 'OUTBOUND' | null;
  authorType: 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM' | null;
  conversationId: string | null;
  channelId: string | null;
  channelType: string | null;
  /** RECEIVED | SENT | DELIVERED | READ | FAILED. FAILED must never render as
   *  delivered — see LeadStream.tsx. */
  deliveryStatus: string | null;
  /** Provider/adapter reason on a FAILED message. */
  error: string | null;
  /**
   * `Message.meta`, verbatim from the provider. `meta.raw.kind` is the ONLY
   * marker of an inbound voicemail or fax — a Message carries no channel
   * column of its own — and `audioUrl` / `documentUrl` are the only place
   * their media lives. Typed as `unknown` because the shape is the provider's,
   * not ours; the reader narrows it (`providerRaw` in LeadStream.tsx).
   */
  meta: unknown | null;

  // ── activities only (null on every message) ──────────────────────────────
  activityType: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  /**
   * How an assignment happened, when this activity IS one; null on everything
   * else, a plain stage move included.
   *
   * Derived server-side from `LeadActivity.metadata`, which is the only thing
   * separating an auto-distribution on ingest from a manager's bulk assign
   * from a single manual reassignment — the titles cannot, since all three are
   * STATUS_CHANGE rows beginning with the same word.
   */
  assignment: 'auto' | 'bulk' | 'manual' | null;
  /**
   * The `SalesCall` a logged call mirrors, when the row knows one.
   *
   * Without it a call in the stream is a dead end: the recording and the AI
   * analysis both hang off a `SalesCall.id`, so a reader saw "Sales call:
   * CONNECTED · 3 dk" and had to leave for /calls and find the row again by
   * phone number and timestamp to hear it.
   *
   * Null on every other kind, and null on every call MIRRORED BEFORE the id
   * was carried — `LeadActivity.metadata` was empty on those rows and there is
   * no backfill. A null here is not a bug and must not render as a broken
   * player: LeadStream.tsx draws such a row exactly as it always has.
   *
   * Derived server-side from `LeadActivity.metadata`, like `assignment` above
   * it — the blob itself carries user ids and names this endpoint has no
   * reason to ship.
   */
  callId: string | null;

  // ── both, when there is a person behind it ───────────────────────────────
  authorId: string | null;
  authorName: string | null;
}

export interface LeadStream {
  leadId: string;
  /** Oldest → newest, the order a conversation renders in. */
  items: LeadStreamItem[];
  /**
   * Sources that could not be READ, by name: `mesajlar` | `hareketler` |
   * `yazarlar`. Rows are missing and nobody knows how many.
   */
  unread: string[];
  /**
   * Sources with more rows than fit the cap, by name. What came back is the
   * NEWEST of them — the older end is what was cut.
   */
  truncated: string[];
  /**
   * Sources WITHHELD by the workspace's plan, by name. NOT a failure and not to
   * be rendered as one: the conversation add-on is sold separately, so a
   * workspace without `conversationAi` gets its activities plus
   * `gated: ['mesajlar']`. Telling that customer their messages "could not be
   * read" sends them to support instead of to billing.
   */
  gated: string[];
}

/**
 * GET /marketing/leads/:id/timeline — one person's whole stream.
 *
 * `marketingApi` already carries `${API_URL}/marketing` as its baseURL, so the
 * path here is the route's tail only.
 *
 * `/timeline`, not `/stream`, although the design calls it the person's akış:
 * this API already has a `/stream` and it is Server-Sent Events.
 */
export const getLeadStream = (leadId: string) =>
  marketingApi.get<LeadStream>(`/leads/${leadId}/timeline`).then((r) => r.data);
