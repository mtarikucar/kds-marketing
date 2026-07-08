import type {
  Lead,
  LeadActivity,
  LeadOffer,
  MarketingTask,
} from '../../../features/marketing/types';

/**
 * First-touch ad/UTM attribution captured at lead birth. Detail-only (the list
 * endpoint does not return it), nullable (leads with no click/UTM signal have
 * none). Scalar mirror of the backend LeadAttribution select.
 */
export interface LeadAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  clickId: string | null;
  clickIdType: string | null;
  ctwaClid: string | null;
  landingUrl: string | null;
  referrerUrl: string | null;
  sourceSocialPostId: string | null;
  sourceSocialCampaignId: string | null;
  sourceAdCampaignId: string | null;
  sourceAdCreativeId: string | null;
  createdAt: string;
}

/** Lead detail payload — the lead plus its eagerly-loaded relations. */
export type DetailLead = Lead & {
  activities: LeadActivity[];
  offers: LeadOffer[];
  tasks: MarketingTask[];
  attribution?: LeadAttribution | null;
};
