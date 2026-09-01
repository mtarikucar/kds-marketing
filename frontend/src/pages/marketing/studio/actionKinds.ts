import type { ActionKind, ActionPriority } from '../../../features/marketing/api/strategy.service';

/**
 * actionKinds.ts — the single table that decides, per `StrategyAction.kind`,
 * BOTH what we promise the button will do and which button we are allowed to
 * draw at all.
 *
 * WHY ONE TABLE AND NOT TWO. The copy ("Bu ne yapacak?") and the affordance
 * (Onayla / Onayla-behind-a-confirm / no button at all) are the same decision
 * read twice. Kept apart, they drift the moment an executor changes: a kind
 * whose executor started PUBLISHING keeps a bare Onayla because only the
 * sentence was updated, or — the way this actually goes wrong here —
 * CHANNEL_SETUP keeps its approve button because the sentence lives in a
 * different file from the button. Drift in this particular pair is not a
 * cosmetic bug: the sentence is the consent the operator gives, and the button
 * is what actually spends their money or posts under their name. So the row IS
 * the contract, and the panel reads the affordance from the same object it
 * reads the promise from.
 *
 * EVERY SENTENCE BELOW WAS VERIFIED AGAINST THE EXECUTOR IT DESCRIBES
 * (backend/src/modules/marketing/strategy/executors/*.ts plus the orchestrator's
 * registry). Where an executor degrades — no connected account, no quota, AI
 * unconfigured — the degradation is named too, because "it will draft a post"
 * that silently drafts nothing is the same broken promise as the reverse.
 * If you change an executor, change its row here in the same commit.
 */

/** Badge tones this module hands the panel; mirrors `Badge`'s `tone` variants. */
export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * What the operator is allowed to do with an idea of this kind.
 *
 * - `APPROVE`         — a plain button. Nothing is published and no money moves.
 * - `APPROVE_CONFIRM` — a button behind a ConfirmDialog, because approving
 *                       PUBLISHES to an outside audience or SPENDS money.
 * - `MANUAL`          — no approve button exists, because no executor exists.
 *                       The row routes the operator to the page where the work
 *                       is actually done by hand.
 */
export type Affordance = 'APPROVE' | 'APPROVE_CONFIRM' | 'MANUAL';

export interface ActionKindMeta {
  kind: string;
  /** Short badge label. i18n key + the Turkish default that actually renders. */
  labelKey: string;
  label: string;
  /** The "Bu ne yapacak?" line: what approving this row really does. */
  whatKey: string;
  what: string;
  affordance: Affordance;
  /**
   * `APPROVE_CONFIRM` only — the body of the confirm, naming the irreversible
   * half (it posts publicly / it spends). Never a generic "Emin misin?".
   */
  confirmKey?: string;
  confirm?: string;
  /** `MANUAL` only — where the operator has to go instead, and why. */
  manualRoute?: string;
  manualCtaKey?: string;
  manualCta?: string;
  manualHintKey?: string;
  manualHint?: string;
}

/**
 * The table. Keys are the five kinds the synthesis can emit (`ActionKind` in
 * strategy.service.ts); `actionKindMeta()` below covers the sixth case — a kind
 * this frontend has never heard of.
 */
export const ACTION_KINDS: Record<ActionKind, ActionKindMeta> = {
  /**
   * ContentExecutor: composes copy with the Brand-Brain-grounded Content AI,
   * then `planner.createPost({ content })` — no target account, no schedule.
   * The post lands in the Social Planner queue as a DRAFT. resultRef `post:<id>`.
   * When AI is unconfigured it returns no resultRef and the action still goes
   * DONE, which is why the sentence promises a draft and not a publish.
   */
  CONTENT: {
    kind: 'CONTENT',
    labelKey: 'strategy.ideas.kind.content',
    label: 'İçerik',
    whatKey: 'strategy.ideas.what.content',
    what: 'Metni yazar ve Sosyal Planlayıcı’ya TASLAK bir gönderi bırakır. Hiçbir yere yayınlanmaz — hesabı ve saati seçip ayrıca onaylaman gerekir.',
    affordance: 'APPROVE',
  },

  /**
   * CommunityEngageExecutor: composes community-native copy, then tries a LIVE
   * post to an OWNED, configured channel — a Discord incoming webhook or an
   * authorized subreddit (resultRef `discord:<id>` / `reddit:<id>`). If no
   * channel is connected, the channel is some other kind, or the live post
   * fails, it degrades to a staged DRAFT SocialPost (`community:<postId>`).
   * The live branch is why this kind is confirm-gated: it publishes under the
   * workspace's own name, to an audience, with no second review.
   */
  COMMUNITY_ENGAGE: {
    kind: 'COMMUNITY_ENGAGE',
    labelKey: 'strategy.ideas.kind.community',
    label: 'Topluluk',
    whatKey: 'strategy.ideas.what.community',
    what: 'Topluluğa uygun metni yazar ve bağlı bir Discord/Reddit kanalın varsa oraya CANLI gönderir. Bağlı kanal yoksa ya da gönderim başarısız olursa taslak olarak bekletir.',
    affordance: 'APPROVE_CONFIRM',
    confirmKey: 'strategy.ideas.confirm.community',
    confirm:
      'Bağlı bir Discord/Reddit kanalın varsa bu metin oraya CANLI gönderilir — ikinci bir onay sorulmaz ve geri alınamaz. Bağlı kanal yoksa taslak olarak bekletilir. Onayladıktan sonra çalışması bir dakikayı bulabilir.',
  },

  /**
   * LeadHuntExecutor: creates a real ResearchProfile row, builds the same
   * ResearchJob the nightly cron consumes, and runs the worker INLINE — the
   * hunt happens inside the approve request. That burns the workspace's daily
   * lead quota and real scraping/search money. If the quota is exhausted or the
   * workspace is inactive, `buildJob` returns null: the profile is still
   * created but nothing runs, which is exactly the half-outcome the second
   * sentence exists to warn about.
   */
  LEAD_HUNT: {
    kind: 'LEAD_HUNT',
    labelKey: 'strategy.ideas.kind.leadHunt',
    label: 'Müşteri avı',
    whatKey: 'strategy.ideas.what.leadHunt',
    what: 'Bir araştırma profili oluşturur ve araştırmayı HEMEN çalıştırır: günlük aday kotandan düşer, araştırma kredisi ve tarama parası harcar.',
    affordance: 'APPROVE_CONFIRM',
    confirmKey: 'strategy.ideas.confirm.leadHunt',
    confirm:
      'Bu araştırma şimdi çalışır ve para harcar: günlük aday kotandan düşer, araştırma kredisi ve tarama (scraping) ücreti yazılır. Kotan dolmuşsa profil oluşur ama arama çalışmaz. Çalışması bir dakikayı bulabilir.',
  },

  /**
   * AdCampaignExecutor: creates ONLY a PAUSED campaign shell on Meta
   * (`AdManagementService.create`, which defaults new campaigns to PAUSED) — no
   * ad set, no ad, no budget write, no activation. `payload.dailyBudget` is
   * logged as an INTENT and never applied; a bare campaign node cannot spend.
   * With no connected ACTIVE Meta ad account it does nothing at all. That is
   * why this kind is a plain Onayla despite the word "reklam": approving it
   * moves no money, and dressing it in a scary confirm would train people to
   * click through the confirms that DO matter.
   */
  AD_CAMPAIGN: {
    kind: 'AD_CAMPAIGN',
    labelKey: 'strategy.ideas.kind.adCampaign',
    label: 'Reklam',
    whatKey: 'strategy.ideas.what.adCampaign',
    what: 'Meta’da DURAKLATILMIŞ boş bir kampanya açar. Reklam seti, reklam ve bütçe yok — plandaki günlük bütçe uygulanmaz, tek başına para harcayamaz. Bağlı Meta reklam hesabın yoksa hiçbir şey oluşturmaz.',
    affordance: 'APPROVE',
  },

  /**
   * CHANNEL_SETUP HAS NO EXECUTOR. The orchestrator's registry is built from
   * four executors (lead-hunt, content, community-engage, ad-campaign); a kind
   * that misses it returns `{ skipped: 'executor-not-available' }` and the row
   * is deliberately LEFT at APPROVED — not FAILED, not DONE. So an approve
   * button here produces a row that looks accepted, never runs, never errors
   * and never leaves the queue: the worst possible outcome, because it reads as
   * success. Connecting a channel is a human OAuth flow, so the row routes to
   * the account centre instead of offering a button that lies.
   */
  CHANNEL_SETUP: {
    kind: 'CHANNEL_SETUP',
    labelKey: 'strategy.ideas.kind.channelSetup',
    label: 'Kanal kurulumu',
    whatKey: 'strategy.ideas.what.channelSetup',
    what: 'Bunu çalıştıracak bir işleyici yok: onaylarsan satır sonsuza kadar “onaylandı” olarak kalır ve hiçbir şey olmaz. Kanal bağlantısı elle yapılır.',
    affordance: 'MANUAL',
    manualRoute: '/accounts',
    manualCtaKey: 'strategy.ideas.manual.cta',
    manualCta: 'Kanalları bağla',
    manualHintKey: 'strategy.ideas.manual.hint',
    manualHint:
      'Kanal bağlamak senin hesabınla yapılan bir izin akışı — Jeeta senin yerine yapamaz. Hesaplar sayfasından bağladığında bu fikir kendiliğinden anlam kazanır.',
  },
};

/**
 * The fallback row for a kind this build has never heard of.
 *
 * The backend ships new kinds before the frontend learns them, and a missing
 * `ACTION_KINDS[kind]` would otherwise crash the whole panel on one unknown
 * string. It is deliberately `APPROVE_CONFIRM`: we cannot describe what it
 * does, so the only honest affordance is one that says so and makes the
 * operator opt in anyway, rather than a bare button implying we vouched for it.
 */
export const UNKNOWN_ACTION_KIND: ActionKindMeta = {
  kind: 'UNKNOWN',
  labelKey: 'strategy.ideas.kind.unknown',
  label: 'Diğer',
  whatKey: 'strategy.ideas.what.unknown',
  what: 'Bu fikir tipini bu sürüm tanımıyor; ne yapacağını söyleyemeyiz.',
  affordance: 'APPROVE_CONFIRM',
  confirmKey: 'strategy.ideas.confirm.unknown',
  confirm:
    'Bu fikrin ne yapacağını bu sürüm bilmiyor; yayın yapabilir ya da para harcayabilir. Emin değilsen önce strateji konsolundan incele. Çalışması bir dakikayı bulabilir.',
};

/** Index the table defensively — the backend knows kinds this map does not. */
export function actionKindMeta(kind: string | undefined | null): ActionKindMeta {
  return ACTION_KINDS[kind as ActionKind] ?? UNKNOWN_ACTION_KIND;
}

/**
 * Kind → short Turkish badge label, DERIVED from the table above rather than
 * typed out a second time, so the badge can never name one thing while the
 * sentence under it describes another.
 */
export const KIND_LABEL: Record<ActionKind, string> = Object.fromEntries(
  (Object.keys(ACTION_KINDS) as ActionKind[]).map((k) => [k, ACTION_KINDS[k].label]),
) as Record<ActionKind, string>;

// ── Priority ────────────────────────────────────────────────────────────────

export interface PriorityMeta {
  /** Mirrors the backend's PRIORITY_RANK (strategy.service.ts). */
  rank: number;
  tone: BadgeTone;
  /**
   * The catalogue key, or `undefined` when the label is not translatable —
   * see `priorityMeta`. A caller must render `label` directly in that case
   * rather than passing an absent key to `t()`.
   */
  labelKey?: string;
  label: string;
}

/**
 * `StrategyAction.priority` is a STRING ('HIGH' | 'MEDIUM' | 'LOW'), not a
 * number — the frontend type claimed `number` for a long time and anything that
 * believed it rendered an empty badge.
 *
 * The tones are deliberately not a red/amber/grey severity ramp: HIGH is not a
 * FAILURE, it is the strategist's ordering. `warning` reads as "look here
 * first" without borrowing `danger`, which this panel reserves for the one
 * thing that genuinely is one — an action that ran and failed.
 */
const PRIORITY_META: Record<ActionPriority, PriorityMeta> = {
  HIGH: { rank: 0, tone: 'warning', labelKey: 'strategy.ideas.priority.high', label: 'Yüksek' },
  MEDIUM: { rank: 1, tone: 'info', labelKey: 'strategy.ideas.priority.medium', label: 'Orta' },
  LOW: { rank: 2, tone: 'neutral', labelKey: 'strategy.ideas.priority.low', label: 'Düşük' },
};

/**
 * Defensive lookup; an unrecognised priority renders neutrally and sorts last.
 *
 * It deliberately carries NO `labelKey`. The label for a priority we do not
 * recognise is the backend's own word for it, verbatim — that string is the
 * only information the badge has, and it is what tells whoever reads a
 * screenshot which new enum member the API started sending. It used to name
 * `strategy.ideas.priority.unknown`, a key that exists in no catalogue and was
 * only ever harmless because it never resolved: the day somebody "completed"
 * the catalogues, every unrecognised priority would have collapsed into one
 * generic word and taken the evidence with it. An i18n scan now reports such a
 * key as missing, so the absence has to be stated rather than implied.
 */
export function priorityMeta(priority: string | undefined | null): PriorityMeta {
  return (
    PRIORITY_META[priority as ActionPriority] ?? {
      rank: 99,
      tone: 'neutral',
      label: String(priority ?? '—'),
    }
  );
}

export const PRIORITY_TONE: Record<ActionPriority, BadgeTone> = {
  HIGH: PRIORITY_META.HIGH.tone,
  MEDIUM: PRIORITY_META.MEDIUM.tone,
  LOW: PRIORITY_META.LOW.tone,
};

/**
 * The backend's ordering contract, mirrored.
 *
 * `StrategyService.listActions` already sorts HIGH→MEDIUM→LOW and then oldest
 * first, and the panel MUST NOT re-sort what it is handed — a second sort with
 * a different tiebreak is how two surfaces showing "the same queue" end up
 * disagreeing about which idea is next. This is exported for the callers that
 * legitimately need the rank (merging two separately-fetched status lists into
 * one strip, grouping into bands), and for exactly that reason it has to keep
 * matching the server's map rather than being retuned here.
 */
export const PRIORITY_RANK: Record<ActionPriority, number> = {
  HIGH: PRIORITY_META.HIGH.rank,
  MEDIUM: PRIORITY_META.MEDIUM.rank,
  LOW: PRIORITY_META.LOW.rank,
};

// ── resultRef ───────────────────────────────────────────────────────────────

/**
 * A parsed `StrategyAction.resultRef`.
 *
 * The `failed` branch carries the backend's raw message and NO i18n key on
 * purpose: it is a diagnostic string produced by whatever threw, and giving it
 * a translation key would invite a locale file to overwrite the one piece of
 * text nobody may paraphrase.
 */
export type ParsedResultRef =
  | { failed: true; message: string }
  | { failed: false; labelKey: string; label: string; id: string };

const REF_NOUNS: Record<string, { labelKey: string; label: string }> = {
  post: { labelKey: 'strategy.ideas.result.post', label: 'taslak gönderi' },
  community: { labelKey: 'strategy.ideas.result.community', label: 'topluluk taslağı' },
  discord: { labelKey: 'strategy.ideas.result.discord', label: 'Discord gönderisi' },
  reddit: { labelKey: 'strategy.ideas.result.reddit', label: 'Reddit gönderisi' },
  research: { labelKey: 'strategy.ideas.result.research', label: 'araştırma çalışması' },
  campaign: { labelKey: 'strategy.ideas.result.campaign', label: 'kampanya kabuğu' },
};

/**
 * Turn a `resultRef` into something renderable.
 *
 * THE `error:` PREFIX IS THE WHOLE REASON THIS FUNCTION EXISTS. `StrategyAction`
 * has no error column, so when an executor throws, the orchestrator stuffs the
 * message into the SAME field it otherwise uses for "here is what I made",
 * truncated to 500 chars: `resultRef = 'error:<message>'`. Anything that treats
 * resultRef as a pointer without checking that prefix will happily render a
 * stack-trace fragment as a link to a post that does not exist — a failure
 * displayed as a success. Check `failed` first, always.
 *
 * Returns null for an absent/empty ref (an action that ran but produced
 * nothing — an unconfigured executor degrading, which is not a failure and must
 * not be dressed up as one).
 */
export function resultRefLabel(resultRef?: string | null): ParsedResultRef | null {
  const ref = (resultRef ?? '').trim();
  if (!ref) return null;

  if (ref.startsWith('error:')) {
    const message = ref.slice('error:'.length).trim();
    // An `error:` with nothing after it still means FAILED — fall back to the
    // raw ref rather than returning an empty, reassuring-looking string.
    return { failed: true, message: message || ref };
  }

  const sep = ref.indexOf(':');
  const prefix = sep > 0 ? ref.slice(0, sep) : '';
  const id = sep > 0 ? ref.slice(sep + 1) : ref;
  const noun = REF_NOUNS[prefix];
  if (!noun) {
    // An unknown prefix is not an error — a newer backend may write refs this
    // build has no noun for. Show the raw ref rather than inventing a name.
    return { failed: false, labelKey: 'strategy.ideas.result.unknown', label: 'sonuç', id: ref };
  }
  return { failed: false, labelKey: noun.labelKey, label: noun.label, id };
}
