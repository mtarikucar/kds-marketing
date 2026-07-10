/**
 * fax.service.ts — NetGSM Phase 6 Task 1: the send-fax action.
 * One multipart endpoint; paths relative to /marketing.
 */
import marketingApi from './marketingApi';

export interface SendFaxPayload {
  to: string;
  file: File;
  header?: string;
}

export interface SendFaxResult {
  jobId: string;
}

export const sendFax = (payload: SendFaxPayload): Promise<SendFaxResult> => {
  const fd = new FormData();
  fd.append('to', payload.to);
  fd.append('file', payload.file);
  if (payload.header) fd.append('header', payload.header);
  return marketingApi
    .post('/fax/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    .then((r) => r.data);
};
