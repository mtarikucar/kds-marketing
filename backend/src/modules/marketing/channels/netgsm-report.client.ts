import { Injectable, Logger } from '@nestjs/common';
import { parseNetgsmReport, NetgsmReportRow } from './netgsm-report.util';

/**
 * Thin client for NetGSM's polled delivery-report API (`/sms/report`). NetGSM
 * does NOT push DLRs; NetgsmDlrPollService calls this once per still-pending
 * outbound message (bounded by a per-tick rate cap).
 *
 * The endpoint's exact method/params and response wire format are an
 * account-dependent open item (lock them from a captured live response —
 * see the integration design doc). We POST credentials in the body (never the
 * query string, mirroring the send path's hygiene) and delegate to the tolerant
 * parser, which returns null for any shape it can't read — a safe no-op that
 * leaves the message SENT for a later poll.
 */
@Injectable()
export class NetgsmReportClient {
  private readonly logger = new Logger(NetgsmReportClient.name);
  private static readonly REPORT_URL = 'https://api.netgsm.com.tr/sms/report';
  private static readonly TIMEOUT_MS = 15_000;

  async fetchStatus(
    creds: { usercode: string; password: string },
    bulkid: string,
  ): Promise<NetgsmReportRow | null> {
    if (!creds?.usercode || !creds?.password || !bulkid) return null;
    const form = new URLSearchParams({
      usercode: creds.usercode,
      password: creds.password,
      bulkid,
      type: '0',
      version: '2',
    });
    const res = await fetch(NetgsmReportClient.REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(NetgsmReportClient.TIMEOUT_MS),
    });
    if (typeof res.status === 'number' && res.status >= 400) {
      this.logger.warn(`netgsm report HTTP ${res.status} for bulkid=${bulkid}`);
      return null;
    }
    return parseNetgsmReport((await res.text()) ?? '');
  }
}
