/**
 * email-templates.service.ts — reusable HTML email templates (GoHighLevel
 * parity). A template is a block list compiled server-side to table-based HTML
 * (compiledHtml), reused by email campaigns.
 */

import marketingApi from './marketingApi';

export interface EmailBlock { type: string; [k: string]: unknown }

export interface EmailTemplateRow { id: string; name: string; updatedAt: string }

export interface EmailTemplate extends EmailTemplateRow {
  blocks: EmailBlock[];
  theme?: { accent?: string; bg?: string };
  compiledHtml?: string;
}

export interface EmailTemplatePayload {
  name?: string;
  blocks?: EmailBlock[];
  theme?: { accent?: string; bg?: string };
}

export const listEmailTemplates = (): Promise<EmailTemplateRow[]> =>
  marketingApi.get('/email-templates').then((r) => r.data);

export const getEmailTemplate = (id: string): Promise<EmailTemplate> =>
  marketingApi.get(`/email-templates/${id}`).then((r) => r.data);

export const createEmailTemplate = (payload: EmailTemplatePayload): Promise<EmailTemplate> =>
  marketingApi.post('/email-templates', payload).then((r) => r.data);

export const updateEmailTemplate = (id: string, payload: EmailTemplatePayload): Promise<EmailTemplate> =>
  marketingApi.patch(`/email-templates/${id}`, payload).then((r) => r.data);

export const deleteEmailTemplate = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/email-templates/${id}`).then((r) => r.data);
