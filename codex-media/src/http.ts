import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ASPECT_RATIOS, type AspectRatio } from './config.js';
import { HttpError } from './errors.js';
import type { Job, JobRequest } from './jobs.js';

export const MAX_BODY_BYTES = 64 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface Detail { field: string; message: string }

export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

export function isAuthorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  return !!m && sameSecret(m[1]!, secret);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body is larger than ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Body is not valid JSON.', { details: [{ field: 'body', message: 'invalid JSON' }] });
  }
}

/** §1.2 body rules. Reference hosts are matched against the allow-list (R2 public host + CODEX_MEDIA_REF_HOSTS). */
export function validateGenerate(body: unknown, refHosts: string[]): JobRequest {
  const details: Detail[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Body must be a JSON object.', { details: [{ field: 'body', message: 'must be an object' }] });
  }
  const b = body as Record<string, unknown>;
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (typeof b.prompt !== 'string' || !prompt) details.push({ field: 'prompt', message: 'required, 1..4000 characters' });
  else if (b.prompt.length > 4000) details.push({ field: 'prompt', message: 'at most 4000 characters' });

  let aspectRatio: AspectRatio = '1:1';
  if (b.aspectRatio !== undefined && b.aspectRatio !== null) {
    if (typeof b.aspectRatio === 'string' && (ASPECT_RATIOS as readonly string[]).includes(b.aspectRatio)) aspectRatio = b.aspectRatio as AspectRatio;
    else details.push({ field: 'aspectRatio', message: `one of ${ASPECT_RATIOS.join(', ')}` });
  }

  const referenceImages: string[] = [];
  if (b.referenceImages !== undefined && b.referenceImages !== null) {
    if (!Array.isArray(b.referenceImages)) details.push({ field: 'referenceImages', message: 'must be an array of URLs' });
    else if (b.referenceImages.length > 4) details.push({ field: 'referenceImages', message: 'at most 4 references' });
    else {
      b.referenceImages.forEach((v, i) => {
        const field = `referenceImages[${i}]`;
        let url: URL | null = null;
        try { url = typeof v === 'string' ? new URL(v) : null; } catch { url = null; }
        if (!url) details.push({ field, message: 'must be a URL' });
        else if (url.protocol !== 'https:') details.push({ field, message: 'only https is allowed' });
        else if (!refHosts.includes(url.host.toLowerCase())) details.push({ field, message: `host ${url.host} is not allowed` });
        else referenceImages.push(url.href);
      });
    }
  }

  let workspaceId: string | undefined;
  if (b.workspaceId !== undefined && b.workspaceId !== null) {
    if (typeof b.workspaceId === 'string' && WORKSPACE_ID.test(b.workspaceId)) workspaceId = b.workspaceId;
    else details.push({ field: 'workspaceId', message: 'letters, digits, "_" and "-", at most 100' });
  }

  let clientRef: string | undefined;
  if (b.clientRef !== undefined && b.clientRef !== null) {
    if (typeof b.clientRef === 'string' && b.clientRef.length >= 1 && b.clientRef.length <= 100) clientRef = b.clientRef;
    else details.push({ field: 'clientRef', message: '1..100 characters' });
  }

  if (details.length) throw new HttpError(400, 'VALIDATION_FAILED', 'Request body is invalid.', { details });
  return { prompt, aspectRatio, referenceImages, workspaceId, clientRef };
}

export function jobView(job: Job): Record<string, unknown> {
  const base = { jobId: job.id, status: job.status };
  switch (job.status) {
    case 'QUEUED': return base;
    case 'RUNNING': return { ...base, startedAt: new Date(job.startedAt!).toISOString() };
    case 'COMPLETED': return {
      ...base, ...job.output,
      durationMs: (job.finishedAt ?? 0) - (job.startedAt ?? 0),
    };
    case 'FAILED': return { ...base, code: job.error?.code, message: job.error?.message, ...(job.error?.resetsAt ? { resetsAt: job.error.resetsAt } : {}) };
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { code: err.code, message: err.message, ...err.extra });
}
