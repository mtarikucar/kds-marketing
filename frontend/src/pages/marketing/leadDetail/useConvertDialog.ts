import { useState } from 'react';
import type { DetailLead } from './types';
import type { LeadOffer } from '../../../features/marketing/types';

export interface ConvertDialogState {
  isOpen: boolean;
  lead: DetailLead | null;
  sentOffers: LeadOffer[];
  open: (lead: DetailLead, sentOffers: LeadOffer[]) => void;
  close: () => void;
}

/**
 * Small state holder for the lead→customer convert dialog. Keeps the
 * lead + its SENT offers around so the form can prefill defaults
 * (tenant name, admin email, contact name → first/last) and offer the
 * sent-offer link select.
 */
export function useConvertDialog(): ConvertDialogState {
  const [isOpen, setIsOpen] = useState(false);
  const [lead, setLead] = useState<DetailLead | null>(null);
  const [sentOffers, setSentOffers] = useState<LeadOffer[]>([]);

  return {
    isOpen,
    lead,
    sentOffers,
    open: (l, offers) => {
      setLead(l);
      setSentOffers(offers);
      setIsOpen(true);
    },
    close: () => setIsOpen(false),
  };
}
