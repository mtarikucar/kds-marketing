import { request, seg } from './client';
import type {
  Audience,
  CampaignListOut,
  CampaignOut,
  CampaignSaveInput,
  CampaignStatus,
  ControlAction,
  EnrollInput,
  EnrollOut,
  EnrollmentListOut,
  EnrollmentStatus,
  OutreachReportGroup,
  OutreachReportOut,
  OutreachSettingsInput,
  OutreachSettingsOut,
  PersonalizeInput,
  PreviewOut,
  TemplateListOut,
  TemplateOut,
  TemplateSaveInput,
} from './types';

// Outreach (`/api/outreach`, spec §3.10–§3.14, §7.1): plain-text templates, campaigns of one to six
// steps through the customer's own mailbox, approval bound to a revision, and the settings. Cold
// email stays locked by the platform switch (`JEETA_OUTREACH_ENABLED`); the server refuses every
// launch while it is off, whatever the panel shows.

const root = '/api/outreach';
const campaign = (id: string) => `${root}/campaigns/${seg(id)}`;

/** `GET /api/outreach/templates`: most recently edited first. */
export const listTemplates = (query: { include_archived?: boolean; limit?: number; before_at?: string; before_id?: string } = {}) =>
  request<TemplateListOut>('GET', `${root}/templates`, { query: { ...query } });

/** `POST /api/outreach/templates`: a new template, or a new revision of one. */
export const saveTemplate = (input: TemplateSaveInput) =>
  request<TemplateOut>('POST', `${root}/templates`, { body: input });

/** `POST /api/outreach/templates/{template_id}/archive`. */
export const archiveTemplate = (id: string) =>
  request<TemplateOut>('POST', `${root}/templates/${seg(id)}/archive`);

/** `GET /api/outreach/campaigns`: newest first. */
export const listCampaigns = (query: { status?: CampaignStatus; limit?: number; before_at?: string; before_id?: string } = {}) =>
  request<CampaignListOut>('GET', `${root}/campaigns`, { query: { ...query } });

/** `GET /api/outreach/campaigns/{campaign_id}`. */
export const getCampaign = (id: string) => request<CampaignOut>('GET', campaign(id));

/** `POST /api/outreach/campaigns`: a new draft, or a new revision (voids the approval). */
export const saveCampaign = (input: CampaignSaveInput) =>
  request<CampaignOut>('POST', `${root}/campaigns`, { body: input });

/** `POST /api/outreach/audience-preview`: counts as enrollment would, writing nothing. */
export const previewAudience = (input: { audience: Audience; mailbox_id: string }) =>
  request<PreviewOut>('POST', `${root}/audience-preview`, { body: input });

/** `POST /api/outreach/campaigns/{campaign_id}/launch`: at the revision shown. */
export const launchCampaign = (id: string, expectedRevision: number) =>
  request<CampaignOut>('POST', `${campaign(id)}/launch`, { body: { expected_revision: expectedRevision } });

/** `POST /api/outreach/campaigns/{campaign_id}/approve`: a person with `outreach.manage`. */
export const approveCampaign = (id: string, expectedRevision: number) =>
  request<CampaignOut>('POST', `${campaign(id)}/approve`, { body: { expected_revision: expectedRevision } });

/** `POST /api/outreach/campaigns/{campaign_id}/control`: pause, resume, cancel (`outreach.manage`). */
export const controlCampaign = (id: string, action: ControlAction) =>
  request<CampaignOut>('POST', `${campaign(id)}/control`, { body: { action } });

/** `POST /api/outreach/campaigns/{campaign_id}/enrollments`. */
export const enroll = (id: string, input: EnrollInput) =>
  request<EnrollOut>('POST', `${campaign(id)}/enrollments`, { body: input });

/**
 * `GET /api/outreach/campaigns/{campaign_id}/enrollments`: follows spec §7.1 (and the
 * repository's `EnrollmentQuery`: `status`, `limit`, `after`) until its use case lands (L4-T7).
 */
export const listEnrollments = (id: string, query: { status?: EnrollmentStatus; limit?: number; after?: string } = {}) =>
  request<EnrollmentListOut>('GET', `${campaign(id)}/enrollments`, { query: { ...query } });

/**
 * `POST /api/outreach/enrollments/{enrollment_id}/stop` (stop reason `manual`): follows spec §7.1
 * until its use case lands (L4-T7); the panel reads the list again rather than the answer.
 */
export const stopEnrollment = (enrollmentId: string) =>
  request<unknown>('POST', `${root}/enrollments/${seg(enrollmentId)}/stop`, { body: {} });

/** `POST /api/outreach/enrollments/personalization`: `custom.*` values, ≤ 100 a call. */
export const personalize = (input: PersonalizeInput) =>
  request<{ updated: number }>('POST', `${root}/enrollments/personalization`, { body: input });

/**
 * `POST /api/outreach/campaigns/{campaign_id}/test`: sends to the caller's own login address only.
 * Follows spec §7.1 until its use case lands (L4-T7).
 */
export const testSend = (id: string) => request<unknown>('POST', `${campaign(id)}/test`, { body: {} });

/**
 * `GET /api/outreach/report`: `[from, to)` instants. Follows spec §3.16 and §7.1 until its use case
 * lands (L4-T6).
 */
export const outreachReport = (query: { campaign_id?: string; from: string; to: string; group_by: OutreachReportGroup }) =>
  request<OutreachReportOut>('GET', `${root}/report`, { query: { ...query } });

/** `GET /api/outreach/settings`. */
export const getOutreachSettings = () => request<OutreachSettingsOut>('GET', `${root}/settings`);

/** `PUT /api/outreach/settings`: only the keys given change; the B2B basis is a human owner's. */
export const setOutreachSettings = (input: OutreachSettingsInput) =>
  request<OutreachSettingsOut>('PUT', `${root}/settings`, { body: input });
