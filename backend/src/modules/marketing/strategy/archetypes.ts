import { BusinessArchetype } from './strategy.types';

/**
 * Strategy Engine — the business-archetype registry.
 *
 * Each archetype carries the priors the engine needs BEFORE (and to steer) live
 * synthesis: default channel fit-scores, the extra interview questions that
 * archetype should ask, and the lead approach (B2B prospecting vs B2C audience
 * building). Synthesis starts from these priors and adjusts them with research;
 * the orchestrator reads `leadApproach` to pick the LEAD_HUNT executor flavor.
 *
 * Tripwire-pinned (archetypes.tripwire.spec.ts) like ai-credit-costs — adding an
 * archetype is a config + tripwire change, never a migration. `channelPriors`
 * scores are 0–1 fit estimates over a shared channel-key vocabulary.
 */

export type LeadApproach = 'B2B_PROSPECT' | 'B2C_AUDIENCE';

export interface ArchetypeMeta {
  /** 0–1 default fit score per channel key; synthesis adjusts with research. */
  channelPriors: Record<string, number>;
  /** Extra interview questions this archetype should ask (gaps + intent). */
  interviewDeltas: string[];
  /** Lead strategy: prospect named accounts (B2B) vs build an audience (B2C). */
  leadApproach: LeadApproach;
}

export const ARCHETYPES: Record<BusinessArchetype, ArchetypeMeta> = {
  // Plumbers, dentists, agencies, local B2B services — win on local intent +
  // outbound prospecting; Maps/reviews + LinkedIn/email lead the mix.
  B2B_LOCAL_SERVICE: {
    channelPriors: {
      'google-maps': 0.95,
      'google-ads': 0.8,
      linkedin: 0.6,
      email: 0.7,
      facebook: 0.5,
      instagram: 0.4,
      website: 0.7,
      reddit: 0.2,
      discord: 0.1,
    },
    interviewDeltas: [
      'What is your primary service area (cities / radius)?',
      'What is the average value of one new customer?',
      'Which competitors rank in your local Maps pack today?',
    ],
    leadApproach: 'B2B_PROSPECT',
  },

  // SaaS / software — LinkedIn + content + product-led; long buying cycle.
  B2B_SAAS: {
    channelPriors: {
      linkedin: 0.9,
      'google-ads': 0.75,
      email: 0.8,
      website: 0.85,
      youtube: 0.5,
      x: 0.55,
      reddit: 0.45,
      'google-maps': 0.1,
      discord: 0.35,
    },
    interviewDeltas: [
      'Who is the economic buyer vs the end user of your product?',
      'What is your pricing model and ACV?',
      'What integrations or categories do you compete in?',
    ],
    leadApproach: 'B2B_PROSPECT',
  },

  // DTC / online store — paid social + creators + marketplace SEO drive sales.
  B2C_ECOMMERCE: {
    channelPriors: {
      instagram: 0.85,
      tiktok: 0.85,
      facebook: 0.8,
      'google-ads': 0.7,
      youtube: 0.5,
      email: 0.7,
      pinterest: 0.55,
      reddit: 0.4,
      'google-maps': 0.15,
    },
    interviewDeltas: [
      'What is your hero product and its price point?',
      'What is your target CAC and AOV?',
      'Who are your top 3 competitor brands?',
    ],
    leadApproach: 'B2C_AUDIENCE',
  },

  // The Metin2 case — a passionate niche that gathers in communities; organic
  // community + native content beats paid.
  B2C_COMMUNITY_NICHE: {
    channelPriors: {
      reddit: 0.9,
      discord: 0.85,
      forum: 0.8,
      youtube: 0.6,
      tiktok: 0.55,
      x: 0.5,
      instagram: 0.4,
      'google-ads': 0.2,
      'google-maps': 0.05,
    },
    interviewDeltas: [
      'Where does your community currently gather (subreddits, Discords, forums)?',
      'What in-jokes, memes, or content formats resonate with this audience?',
      'What makes an outsider distrust or dismiss a project like yours?',
    ],
    leadApproach: 'B2C_AUDIENCE',
  },

  // Creators / media / newsletters — audience growth on native platforms + owned list.
  CREATOR_MEDIA: {
    channelPriors: {
      youtube: 0.85,
      tiktok: 0.85,
      instagram: 0.8,
      x: 0.7,
      email: 0.8,
      reddit: 0.5,
      discord: 0.55,
      'google-ads': 0.2,
      'google-maps': 0.05,
    },
    interviewDeltas: [
      'What is your content niche and posting cadence?',
      'How do you currently monetize (ads, sponsorships, products, memberships)?',
      'Which platform is your biggest audience today?',
    ],
    leadApproach: 'B2C_AUDIENCE',
  },

  // Restaurants / cafes / brick-and-mortar retail — local discovery + reviews + walk-in.
  LOCAL_RETAIL_FOOD: {
    channelPriors: {
      'google-maps': 0.95,
      instagram: 0.8,
      tiktok: 0.7,
      facebook: 0.65,
      'google-ads': 0.5,
      email: 0.45,
      website: 0.6,
      reddit: 0.25,
      linkedin: 0.15,
    },
    interviewDeltas: [
      'What is your location and typical customer catchment?',
      'Do you rely on walk-ins, reservations, or delivery platforms?',
      'What are your signature items or offers?',
    ],
    leadApproach: 'B2B_PROSPECT',
  },

  // Fallback when classification is uncertain — a balanced, conservative mix +
  // treat leads as B2B prospecting until synthesis learns otherwise.
  OTHER: {
    channelPriors: {
      website: 0.6,
      email: 0.6,
      'google-ads': 0.5,
      instagram: 0.5,
      linkedin: 0.5,
      facebook: 0.45,
      'google-maps': 0.4,
      reddit: 0.3,
    },
    interviewDeltas: [
      'In one sentence, what does your business sell and to whom?',
      'What single result would make this quarter a success?',
      'What is your monthly marketing budget?',
    ],
    leadApproach: 'B2B_PROSPECT',
  },
};

/** Look up the registry entry for an archetype key. */
export function archetypeMeta(key: BusinessArchetype): ArchetypeMeta {
  return ARCHETYPES[key];
}
