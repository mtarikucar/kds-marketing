import type {
  Lead,
  LeadActivity,
  LeadOffer,
  MarketingTask,
} from '../../../features/marketing/types';

/** Lead detail payload — the lead plus its eagerly-loaded relations. */
export type DetailLead = Lead & {
  activities: LeadActivity[];
  offers: LeadOffer[];
  tasks: MarketingTask[];
};
