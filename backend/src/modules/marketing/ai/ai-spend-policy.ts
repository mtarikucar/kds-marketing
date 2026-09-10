import { AI_CREDIT_COSTS } from './ai-credit-costs';

/**
 * WHAT the workspace is willing to spend AI money on.
 *
 * ── WHY CATEGORIES AND NOT ACTIONS ──────────────────────────────────────────
 *
 * There are ~30 metered actions and nobody wants thirty switches. An owner
 * thinks in jobs — "keep answering customers, stop hunting for leads" — so the
 * switch is the job, and the actions underneath are listed so the choice is
 * informed rather than a leap.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * Measured on this deployment over 90 days: $15.97 of vendor spend, of which
 * RESEARCH is $15.84 — 99%. Answering customers cost $0.00, because it never
 * ran. So "the AI is expensive" was never about conversations; it was one
 * category, running unattended from a nightly cron, feeding crawled page text
 * to a model at an input:output ratio of 30:1.
 *
 * A credit cap could not express that. It stops everything at once, after the
 * money is gone, and it cannot say WHICH job the money went to. This can: the
 * owner turns off the one job they do not want today and keeps the rest.
 *
 * ── DEFAULT IS ON ───────────────────────────────────────────────────────────
 *
 * An absent policy means every category is enabled, so no existing workspace
 * changes behaviour by upgrading. A category is off only because somebody
 * switched it off.
 */
export const AI_SPEND_CATEGORIES = {
  conversation: {
    label: 'Müşteriye cevap',
    description:
      'Gelen mesajlara cevap yazmak ve sessiz kalan müşteriyi kibarca hatırlatmak. Kapatırsan gelen mail ve mesajlar cevapsız kalır.',
    actions: ['conversation.reply', 'conversation.followup', 'voice.copilot'],
  },
  research: {
    label: 'Yeni müşteri araştırması',
    description:
      'Gece çalışan araştırma ajanı: aday işletme bulur, sayfalarını okur, eler. Bu deployment\'ta ölçülen AI faturasının %99\'u burada.',
    actions: [
      'research.turn',
      'research.qualify',
      'research.native_search',
      'research.native_scrape',
    ],
  },
  content: {
    label: 'İçerik üretimi',
    description:
      'Sosyal medya metni, video konsepti ve görsel/video üretimi. Görsel ve video ayrıca fal.ai kredisi harcar.',
    actions: [
      'content.compose',
      'content.concepts',
      'media.image.generate',
      'media.video.generate',
    ],
  },
  strategy: {
    label: 'Strateji ve marka analizi',
    description:
      'Onboarding görüşmesi, marka beyni sentezi ve pazarlama stratejisinin üretilmesi. Seyrek çalışır ama tek seferde pahalıdır.',
    actions: ['strategy.interview', 'strategy.synthesize', 'strategy.turn', 'brand.analyze'],
  },
  assistant: {
    label: 'Senin sorduğun sorular',
    description:
      'Panelde "Sor" kutusu ve komut çubuğu — yani senin kendi kullanımın. Kapatmak müşteriyi etkilemez, yalnızca seni.',
    actions: ['ask_ai.question', 'ask_ai.turn', 'command.request', 'command.turn'],
  },
  workflow: {
    label: 'Otomasyonlar',
    description:
      'Akışların içindeki AI adımları: metin üretme, sınıflandırma, marka güvenliği kontrolü ve akış taslağı.',
    actions: ['workflow.ai_generate', 'workflow.ai_classify', 'workflow.draft'],
  },
  voice: {
    label: 'Telefon ve sesli AI',
    description:
      'Sesli asistan turları, çağrı analizi ve konuşma metne çevirme (dakika başına ücretlenir).',
    actions: ['voice.turn', 'voice.analysis', 'stt.minute'],
  },
  reviews: {
    label: 'Yorum yanıtları',
    description: 'Google/TripAdvisor yorumlarına taslak cevap yazmak.',
    actions: ['review.reply_draft'],
  },
  funnel: {
    label: 'Açılış sayfası taslağı',
    description: 'Satış hunisi ve açılış sayfası metninin sıfırdan üretilmesi.',
    actions: ['funnel.draft'],
  },
  social: {
    label: 'X (Twitter) paylaşımı',
    description:
      'X paylaşım başına gerçek API ücreti alır — tek network bu. Diğer ağlarda paylaşım ücretsizdir ve bu anahtardan etkilenmez.',
    actions: ['social.publish.x', 'social.publish.x_link'],
  },
} as const;

export type AiSpendCategory = keyof typeof AI_SPEND_CATEGORIES;

/**
 * action → category, built once from the table above.
 *
 * Derived rather than hand-written so the two cannot drift: an action listed
 * in no category is a hole the tripwire below names out loud, and a hole means
 * spend nobody can switch off.
 */
export const ACTION_CATEGORY: Record<string, AiSpendCategory> = Object.entries(
  AI_SPEND_CATEGORIES,
).reduce((acc, [key, def]) => {
  for (const action of def.actions) acc[action] = key as AiSpendCategory;
  return acc;
}, {} as Record<string, AiSpendCategory>);

/** Every metered action that no category claims. Must be empty. */
export function uncategorisedActions(): string[] {
  return Object.keys(AI_CREDIT_COSTS).filter((a) => !ACTION_CATEGORY[a]);
}

/**
 * May this workspace spend on this action?
 *
 * Unknown action → allowed. A new action that nobody has categorised yet must
 * not be silently blocked in production; the tripwire catches it in CI, which
 * is where that mistake belongs.
 */
export function spendAllowed(
  policy: Record<string, unknown> | null | undefined,
  action: string | undefined,
): boolean {
  if (!action || !policy) return true;
  const category = ACTION_CATEGORY[action];
  if (!category) return true;
  // Absent means ON. Only an explicit false switches a category off.
  return policy[category] !== false;
}
