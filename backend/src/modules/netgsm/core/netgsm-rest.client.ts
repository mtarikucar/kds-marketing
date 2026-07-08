import { Injectable, Logger } from '@nestjs/common';

export interface NetgsmRestRequest {
  /** Path under https://api.netgsm.com.tr, e.g. '/sms/rest/v2/send'. */
  path: string;
  method: 'GET' | 'POST';
  creds: { usercode: string; password: string };
  /** JSON body for POST. */
  body?: unknown;
  timeoutMs?: number;
}

export interface NetgsmRestResult<T> {
  httpStatus: number;
  /** Parsed JSON, or null when the body isn't JSON (NetGSM sometimes answers a bare code). */
  body: T | null;
  rawText: string;
}

/**
 * Core HTTP client for NetGSM's REST surface (api.netgsm.com.tr, TLS
 * mandatory). Auth is HTTP Basic (usercode:password) per the v2 docs. The
 * response is parsed tolerantly: JSON when possible, else rawText is kept so
 * callers can interpret legacy bare-code answers. Credentials are scrubbed
 * from any thrown error message — same discipline as NetsantralClient.
 */
@Injectable()
export class NetgsmRestClient {
  private readonly logger = new Logger(NetgsmRestClient.name);
  static readonly BASE = 'https://api.netgsm.com.tr';
  private static readonly TIMEOUT_MS = 15_000;

  async request<T = unknown>(req: NetgsmRestRequest): Promise<NetgsmRestResult<T>> {
    const url = `${NetgsmRestClient.BASE}${req.path}`;
    const auth = Buffer.from(`${req.creds.usercode}:${req.creds.password}`).toString('base64');
    try {
      const res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? NetgsmRestClient.TIMEOUT_MS),
      });
      const rawText = ((await res.text()) ?? '').trim();
      let body: T | null = null;
      try {
        if (rawText) {
          const parsed = JSON.parse(rawText);
          // Only treat objects and arrays as JSON; bare numbers are legacy status codes
          if (typeof parsed === 'object') {
            body = parsed as T;
          }
        }
      } catch {
        body = null;
      }
      return { httpStatus: res.status, body, rawText };
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'NetGSM request timed out' : (e?.message ?? String(e));
      const escaped = req.creds.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw
        .replace(new RegExp(escaped, 'g'), '***')
        .replace(new RegExp(req.creds.usercode, 'g'), '***');
      throw new Error(scrubbed);
    }
  }
}
