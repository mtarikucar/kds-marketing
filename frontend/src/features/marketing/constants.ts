/**
 * Centralized color tokens for marketing badges. Previously these
 * lived as scattered inline maps in LeadDetailPage / OffersPage /
 * TasksPage — leaving them mismatched between pages and hard to
 * theme. Now every status/priority badge across the marketing area
 * draws from the same source.
 *
 * Pairs map to Tailwind utility strings. They're kept loose
 * (not `bg-primary/15`) so each status keeps its semantic hue —
 * primary tokens are reserved for the wizard's progressive action.
 */

import type { LeadStatus, OfferStatus, TaskStatus } from './types';

export const LEAD_STATUS_BADGE: Record<LeadStatus, string> = {
  NEW: 'bg-blue-100 text-blue-800',
  CONTACTED: 'bg-indigo-100 text-indigo-800',
  NOT_REACHABLE: 'bg-orange-100 text-orange-800',
  MEETING_DONE: 'bg-purple-100 text-purple-800',
  DEMO_SCHEDULED: 'bg-cyan-100 text-cyan-800',
  OFFER_SENT: 'bg-yellow-100 text-yellow-800',
  WAITING: 'bg-slate-100 text-slate-800',
  WON: 'bg-emerald-100 text-emerald-800',
  LOST: 'bg-red-100 text-red-800',
};

export const OFFER_STATUS_BADGE: Record<OfferStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-800',
  SENT: 'bg-blue-100 text-blue-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-amber-100 text-amber-800',
};

export const TASK_STATUS_BADGE: Record<TaskStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-100 text-slate-800',
};

export type PriorityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export const PRIORITY_BADGE: Record<PriorityLevel, string> = {
  LOW: 'bg-slate-100 text-slate-700',
  MEDIUM: 'bg-blue-100 text-blue-800',
  HIGH: 'bg-amber-100 text-amber-900',
  URGENT: 'bg-red-100 text-red-800',
};

export type CommissionStatus = 'PENDING' | 'APPROVED' | 'PAID';

export const COMMISSION_STATUS_BADGE: Record<CommissionStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  PAID: 'bg-slate-100 text-slate-800',
};

// Keyed by string (not the enum) so callers can pass a raw API status
// without importing the enum — matches how pages render badges.
export const INSTALLATION_STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-slate-100 text-slate-800',
  SCHEDULED: 'bg-blue-100 text-blue-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  DONE: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-red-100 text-red-800',
  NO_SHOW: 'bg-orange-100 text-orange-800',
};

export const CALL_STATUS_BADGE: Record<string, string> = {
  INITIATED: 'bg-blue-100 text-blue-800',
  CONNECTED: 'bg-emerald-100 text-emerald-800',
  NO_ANSWER: 'bg-amber-100 text-amber-800',
  BUSY: 'bg-orange-100 text-orange-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-slate-100 text-slate-800',
};
