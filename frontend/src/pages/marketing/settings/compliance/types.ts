/** Types for the Compliance console (GDPR/KVKK) — mirror compliance.service. */

export type DataRequestKind = 'EXPORT' | 'ERASURE';
export type DataRequestStatus = 'PENDING' | 'COMPLETED' | 'REJECTED';

export interface DataRequest {
  id: string;
  leadId: string | null;
  kind: DataRequestKind;
  status: DataRequestStatus;
  requestedAt: string;
  completedAt: string | null;
  requestedById: string | null;
}

/** Latest consent per type for a lead (getConsents collapses history to latest). */
export interface ConsentRecord {
  type: string;
  granted: boolean;
  at: string;
  /** Where this consent came from — a form and its wording, an unsubscribe, a
   *  rep. Dating an opt-out answers half of what a compliance officer is asked;
   *  this is the other half. Null on a record written before sources were
   *  captured. */
  source?: string | null;
}

/** Lightweight lead row from GET /leads (paginated). */
export interface ComplianceLead {
  id: string;
  businessName: string;
  contactPerson?: string | null;
  email?: string | null;
}

export const CONSENT_TYPES = [
  'MARKETING_EMAIL',
  'MARKETING_SMS',
  'MARKETING_WHATSAPP',
  'DATA_PROCESSING',
] as const;
