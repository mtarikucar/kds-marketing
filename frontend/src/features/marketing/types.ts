export enum MarketingRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  REP = 'REP',
}

/** Mirror of the backend's hierarchical roles guard: a requirement is
 * satisfied by the required role or anything above it. */
export const MARKETING_ROLE_RANK: Record<string, number> = {
  OWNER: 3,
  MANAGER: 2,
  REP: 1,
};

export function hasMarketingRole(
  userRole: string | undefined,
  required: MarketingRole,
): boolean {
  if (!userRole) return false;
  return (MARKETING_ROLE_RANK[userRole] ?? 0) >= (MARKETING_ROLE_RANK[required] ?? Infinity);
}

export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  NOT_REACHABLE = 'NOT_REACHABLE',
  MEETING_DONE = 'MEETING_DONE',
  DEMO_SCHEDULED = 'DEMO_SCHEDULED',
  OFFER_SENT = 'OFFER_SENT',
  WAITING = 'WAITING',
  WON = 'WON',
  LOST = 'LOST',
}

export enum BusinessType {
  CAFE = 'CAFE',
  RESTAURANT = 'RESTAURANT',
  BAR = 'BAR',
  PATISSERIE = 'PATISSERIE',
  FAST_FOOD = 'FAST_FOOD',
  OTHER = 'OTHER',
}

export enum LeadSource {
  INSTAGRAM = 'INSTAGRAM',
  REFERRAL = 'REFERRAL',
  FIELD_VISIT = 'FIELD_VISIT',
  ADS = 'ADS',
  WEBSITE = 'WEBSITE',
  PHONE = 'PHONE',
  OTHER = 'OTHER',
  AI_RESEARCH = 'AI_RESEARCH',
  HARDWARE_QUOTE = 'HARDWARE_QUOTE',
  // System-set on CSV-import rows with no source column (backend import.service).
  IMPORT = 'IMPORT',
}

export enum ActivityType {
  CALL = 'CALL',
  VISIT = 'VISIT',
  NOTE = 'NOTE',
  EMAIL = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
  STATUS_CHANGE = 'STATUS_CHANGE',
  DEMO = 'DEMO',
  MEETING = 'MEETING',
}

export enum TaskType {
  CALL = 'CALL',
  VISIT = 'VISIT',
  DEMO = 'DEMO',
  FOLLOW_UP = 'FOLLOW_UP',
  MEETING = 'MEETING',
  OTHER = 'OTHER',
}

export enum TaskStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum OfferStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export interface MarketingUserInfo {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

export interface Lead {
  id: string;
  businessName: string;
  companyId?: string | null;
  contactPerson: string;
  phone?: string;
  /** NetGSM SMS v2 Task 12 — stamped when a rep confirms a live SMS OTP sent
   *  to `phone`; null/undefined = unverified. Cleared when `phone` is edited. */
  phoneVerifiedAt?: string | null;
  whatsapp?: string;
  email?: string;
  address?: string;
  city?: string;
  region?: string;
  businessType: string;
  tableCount?: number;
  branchCount?: number;
  currentSystem?: string;
  source: string;
  status: LeadStatus;
  lostReason?: string;
  notes?: string;
  nextFollowUp?: string;
  priority: string;
  assignedToId?: string;
  assignedTo?: MarketingUserInfo;
  convertedTenantId?: string;
  convertedAt?: string;
  createdAt: string;
  updatedAt: string;
  _count?: { activities: number; offers: number; tasks: number };
}

export interface LeadActivityAssignmentMetadata {
  kind: 'assignment';
  fromUserId: string | null;
  fromUserName?: string | null;
  toUserId: string | null;
  toUserName?: string | null;
  auto?: boolean;
  bulk?: boolean;
}

export interface LeadActivity {
  id: string;
  type: string;
  title: string;
  description?: string;
  outcome?: string;
  duration?: number;
  metadata?: LeadActivityAssignmentMetadata | Record<string, unknown> | null;
  leadId: string;
  createdById: string;
  createdBy: MarketingUserInfo;
  createdAt: string;
}

export interface MarketingTask {
  id: string;
  title: string;
  description?: string;
  type: string;
  status: string;
  priority: string;
  dueDate: string;
  completedAt?: string;
  leadId?: string;
  lead?: { id: string; businessName: string };
  assignedToId: string;
  assignedTo: MarketingUserInfo;
  createdAt: string;
}

export interface LeadOffer {
  id: string;
  planId?: string;
  /** Currency of the plan snapshot (customPrice/planMonthlyPrice are in it); the
   *  app bills TRY or USD (dual-currency packages). Null for a plan-less offer. */
  planCurrency?: string | null;
  customPrice?: number;
  discount?: number;
  trialDays?: number;
  notes?: string;
  status: string;
  validUntil?: string;
  sentAt?: string;
  respondedAt?: string;
  leadId: string;
  lead?: { id: string; businessName: string; contactPerson: string };
  createdById: string;
  createdBy: MarketingUserInfo;
  createdAt: string;
}

export interface Commission {
  id: string;
  amount: number;
  type: string;
  status: string;
  period: string;
  tenantId?: string;
  leadId?: string;
  notes?: string;
  marketingUserId: string;
  marketingUser: MarketingUserInfo;
  approvedAt?: string;
  paidAt?: string;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  [LeadStatus.NEW]: 'New',
  [LeadStatus.CONTACTED]: 'Contacted',
  [LeadStatus.NOT_REACHABLE]: 'Not Reachable',
  [LeadStatus.MEETING_DONE]: 'Meeting Done',
  [LeadStatus.DEMO_SCHEDULED]: 'Demo Scheduled',
  [LeadStatus.OFFER_SENT]: 'Offer Sent',
  [LeadStatus.WAITING]: 'Waiting',
  [LeadStatus.WON]: 'Won',
  [LeadStatus.LOST]: 'Lost',
};

export const LEAD_STATUS_COLORS: Record<LeadStatus, string> = {
  [LeadStatus.NEW]: 'bg-blue-100 text-blue-800',
  [LeadStatus.CONTACTED]: 'bg-indigo-100 text-indigo-800',
  [LeadStatus.NOT_REACHABLE]: 'bg-orange-100 text-orange-800',
  [LeadStatus.MEETING_DONE]: 'bg-purple-100 text-purple-800',
  [LeadStatus.DEMO_SCHEDULED]: 'bg-cyan-100 text-cyan-800',
  [LeadStatus.OFFER_SENT]: 'bg-yellow-100 text-yellow-800',
  [LeadStatus.WAITING]: 'bg-gray-100 text-gray-800',
  [LeadStatus.WON]: 'bg-green-100 text-green-800',
  [LeadStatus.LOST]: 'bg-red-100 text-red-800',
};

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  [BusinessType.CAFE]: 'Cafe',
  [BusinessType.RESTAURANT]: 'Restaurant',
  [BusinessType.BAR]: 'Bar',
  [BusinessType.PATISSERIE]: 'Patisserie',
  [BusinessType.FAST_FOOD]: 'Fast Food',
  [BusinessType.OTHER]: 'Other',
};

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  [LeadSource.INSTAGRAM]: 'Instagram',
  [LeadSource.REFERRAL]: 'Referral',
  [LeadSource.FIELD_VISIT]: 'Field Visit',
  [LeadSource.ADS]: 'Ads',
  [LeadSource.WEBSITE]: 'Website',
  [LeadSource.PHONE]: 'Phone',
  [LeadSource.OTHER]: 'Other',
  [LeadSource.AI_RESEARCH]: 'AI Research',
  [LeadSource.HARDWARE_QUOTE]: 'Hardware quote',
  [LeadSource.IMPORT]: 'Imported',
};

// ── Installation ops (Faz 3 backend; UI Faz 6) ────────────────────
export enum InstallationStatus {
  REQUESTED = 'REQUESTED',
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

export enum InstallationWindow {
  MORNING = 'MORNING',
  AFTERNOON = 'AFTERNOON',
  FULL_DAY = 'FULL_DAY',
}

export interface InstallationCrew {
  id: string;
  name: string;
  active: boolean;
  dailyCapacity: number;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationTask {
  id: string;
  jobId: string;
  title: string;
  done: boolean;
  position: number;
  createdAt: string;
}

export interface InstallationJob {
  id: string;
  tenantId: string;
  leadId?: string | null;
  crewId?: string | null;
  status: InstallationStatus;
  scheduledDate?: string | null;
  scheduledWindow?: string | null;
  siteAddress?: string | null;
  siteCity?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  requestedAt: string;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: InstallationTask[];
}

export interface CrewAvailability {
  crew: InstallationCrew;
  booked: number;
  available: boolean;
}

export interface InstallationDashboard {
  byStatus: Record<string, number>;
  unscheduled: number;
  overdueSla: number;
  upcoming: InstallationJob[];
}

// Allowed status moves — mirrors the backend INSTALL_TRANSITIONS state machine.
export const INSTALLATION_TRANSITIONS: Record<InstallationStatus, InstallationStatus[]> = {
  [InstallationStatus.REQUESTED]: [InstallationStatus.CANCELLED],
  [InstallationStatus.SCHEDULED]: [
    InstallationStatus.IN_PROGRESS,
    InstallationStatus.CANCELLED,
    InstallationStatus.NO_SHOW,
  ],
  [InstallationStatus.IN_PROGRESS]: [InstallationStatus.DONE, InstallationStatus.CANCELLED],
  [InstallationStatus.DONE]: [],
  [InstallationStatus.CANCELLED]: [],
  [InstallationStatus.NO_SHOW]: [InstallationStatus.CANCELLED],
};

export const INSTALLATION_STATUS_LABELS: Record<InstallationStatus, string> = {
  REQUESTED: 'Requested',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

export const INSTALLATION_WINDOW_LABELS: Record<InstallationWindow, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  FULL_DAY: 'Full Day',
};

// ── Telephony / sales calls (Faz 2 backend; UI Faz 6) ─────────────
export enum CallStatus {
  INITIATED = 'INITIATED',
  CONNECTED = 'CONNECTED',
  NO_ANSWER = 'NO_ANSWER',
  BUSY = 'BUSY',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface SalesCall {
  id: string;
  // Phase 3 Task 2 — nullable: an INBOUND call to an extension that doesn't
  // match any MarketingUser.dahili has no rep to attribute it to (OUTBOUND
  // calls always set this from the acting rep).
  marketingUserId: string | null;
  marketingUser?: MarketingUserInfo;
  leadId?: string | null;
  direction: string;
  toPhone: string;
  providerId: string;
  status: CallStatus;
  externalCallId?: string | null;
  durationSec?: number | null;
  recordingUrl?: string | null;
  notes?: string | null;
  startedAt: string;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartCallResult {
  call: SalesCall;
  dialUri: string;
  mode?: 'click-to-dial' | 'api';
}

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  INITIATED: 'In progress',
  CONNECTED: 'Connected',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

// Outcomes a rep can log (INITIATED is the start state only).
export const CALL_OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'] as const;

// ── Sales targets / performance (Faz 4 backend; UI Faz 6) ─────────
export enum TargetMetric {
  WON_LEADS = 'WON_LEADS',
  COMMISSION_AMOUNT = 'COMMISSION_AMOUNT',
  CONNECTED_CALLS = 'CONNECTED_CALLS',
}

export interface SalesTarget {
  id: string;
  marketingUserId: string;
  marketingUser?: MarketingUserInfo;
  period: string;
  metric: string;
  targetValue: number | string;
  setById: string;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricPerformance {
  metric: string;
  target: number | null;
  actual: number;
  attainmentPct: number | null;
}

export interface TeamPerformanceRow {
  marketingUser: { id: string; firstName: string; lastName: string; role: string };
  metrics: MetricPerformance[];
}

export const TARGET_METRIC_LABELS: Record<TargetMetric, string> = {
  WON_LEADS: 'Won Leads',
  COMMISSION_AMOUNT: 'Commission ($)',
  CONNECTED_CALLS: 'Connected Calls',
};

export const TARGET_METRICS = ['WON_LEADS', 'COMMISSION_AMOUNT', 'CONNECTED_CALLS'] as const;
