import { Injectable, Logger } from '@nestjs/common';
import { interpretNetsantralOriginate, NetsantralOriginateOutcome } from './netsantral.util';

export interface OriginateParams {
  username: string;
  password: string;
  customer_num: string;
  internal_num: string;
  trunk: string;
  pbxnum?: string;
}

/**
 * Thin client for NetGSM Netsantral call origination ("dış arama" / tıkla-ara).
 * NetGSM rings `internal_num` (the rep's extension), then dials `customer_num`,
 * bridging over `trunk` (the 0850) so the customer sees the business number.
 *
 * ORIGINATE_URL is the one account/doc-dependent open item — confirm the exact
 * path from the official Netsantral docs before the first live test. Inert until
 * a workspace has an ACTIVE TelephonyConfig, so a wrong URL cannot fire in prod.
 * Credentials go in the POST body (never the query string) like the SMS path.
 */
@Injectable()
export class NetsantralClient {
  private readonly logger = new Logger(NetsantralClient.name);
  static readonly ORIGINATE_URL = 'https://api.netgsm.com.tr/netsantral/originate';
  private static readonly TIMEOUT_MS = 15_000;

  async originate(p: OriginateParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.customer_num || !p?.internal_num || !p?.trunk) {
      return { ok: false, message: 'Netsantral originate called with missing parameters.' };
    }
    try {
      const form = new URLSearchParams({
        username: p.username,
        password: p.password,
        customer_num: p.customer_num.replace(/[^\d]/g, ''),
        internal_num: p.internal_num,
        trunk: p.trunk.replace(/[^\d]/g, ''),
      });
      if (p.pbxnum) form.set('pbxnum', p.pbxnum);
      const res = await fetch(NetsantralClient.ORIGINATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(NetsantralClient.TIMEOUT_MS),
      });
      if (typeof res.status === 'number' && res.status >= 400) {
        this.logger.warn(`netsantral originate HTTP ${res.status}`);
        return { ok: false, message: `Netsantral HTTP ${res.status}` };
      }
      return interpretNetsantralOriginate((await res.text()) ?? '');
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'Netsantral request timed out' : (e?.message ?? String(e));
      const escaped = p.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw.replace(/password=[^&\s]+/gi, 'password=***').replace(new RegExp(escaped, 'g'), '***');
      return { ok: false, message: scrubbed };
    }
  }
}
